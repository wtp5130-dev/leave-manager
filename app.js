(function(){
  'use strict';
  // Helpers
  const $ = (sel, el=document) => el.querySelector(sel);
  const $$ = (sel, el=document) => Array.from(el.querySelectorAll(sel));
  const fmt = (d) => d ? new Date(d).toISOString().slice(0,10) : '';
  const pad = (n) => String(n).padStart(2,'0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const today = () => ymd(new Date());
  // Years of service helper (full years from join date to today)
  function yearsOfService(joinedStr){
    if(!joinedStr) return '';
    const start = new Date(joinedStr);
    if(isNaN(start)) return '';
    const now = new Date();
    let years = now.getFullYear() - start.getFullYear();
    const m = now.getMonth() - start.getMonth();
    if(m < 0 || (m === 0 && now.getDate() < start.getDate())) years--;
    if(years < 0) years = 0;
    return `${years} year${years===1?'':'s'}`;
  }

  // Storage
  const STORE_KEY = 'leaveManagerDB.v2';
  const DOC_ID_KEY = 'leaveManager.docId';
  const loadDB = () => {
    try{
      const raw = localStorage.getItem(STORE_KEY);
      if(!raw) return { meta:{updatedAt:Date.now()}, employees: [], leaves: [], holidays: [] };
      const db = JSON.parse(raw);
      db.meta ||= {updatedAt: Date.now()};
      db.employees ||= []; db.leaves ||= []; db.holidays ||= [];
      return db;
    }catch(e){ console.error('loadDB', e); return { meta:{updatedAt:Date.now()}, employees: [], leaves: [], holidays: [] }; }
  };
  const saveDB = (db) => {
    db.meta = db.meta||{}; db.meta.updatedAt = Date.now();
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
    // mark dirty and schedule a quick sync
    scheduleDebouncedSync('local-change');
  };

  let DB = loadDB();
  
  // Load state from localStorage (year, selectedEmployee)
  const STATE_KEY = 'leaveManager.state';
  const loadState = () => {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (!raw) return { year: new Date().getFullYear(), autoCarryDone: false, selectedEmployee: null };
      return JSON.parse(raw);
    } catch(e) {
      return { year: new Date().getFullYear(), autoCarryDone: false, selectedEmployee: null };
    }
  };
  const saveState = () => {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch(e) {
      console.error('saveState error:', e);
    }
  };
  
  let state = loadState();

  // Ensure the selected employee matches the logged-in user (especially on shared devices)
  function ensureSelectedEmployeeForCurrentUser(){
    try{
      const user = getCurrentUser();
      if(!user || !user.email) return;
      const current = DB && state?.selectedEmployee ? getEmployee(state.selectedEmployee) : null;
      const match = (DB?.employees||[]).find(e => (e.email||'').toLowerCase() === (user.email||'').toLowerCase());

      // If the user is an EMPLOYEE, always default to their own record if not already selected
      if(user.role === 'EMPLOYEE'){
        const currentEmail = (current?.email||'').toLowerCase();
        if(!current || currentEmail !== (user.email||'').toLowerCase()){
          if(match){
            state.selectedEmployee = match.id;
            saveState();
          }
        }
        return;
      }

      // For MANAGER/HR: if nothing selected (or previous selection belongs to a different user or no longer exists), default to self when available
      const currentBelongsToAnotherUser = current && (current.email||'').toLowerCase() !== (user.email||'').toLowerCase();
      if(!current || !getEmployee(state.selectedEmployee) || currentBelongsToAnotherUser){
        if(match){
          state.selectedEmployee = match.id;
          saveState();
        }
      }
    }catch(e){ /* non-critical */ }
  }

  // Database API helpers
  async function apiGetAll(){
    const r = await fetch('/api/data');
    if(!r.ok) throw new Error('Load failed');
    return r.json();
  }
  async function apiSaveEmployee(emp, ent){
    // Respect the year provided by the caller when saving entitlements
    const entPayload = ent ? { year: (ent.year ?? state.year), carry: ent.carry, current: ent.current } : undefined;
    const r = await fetch('/api/employee', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ id:emp.id, name:emp.name, email:emp.email, role:emp.role, jobTitle:emp.jobTitle, department:emp.department, dateJoined:emp.dateJoined, entitlement: entPayload }) });
    if(!r.ok) throw new Error('Employee save failed');
  }
  async function apiDeleteEmployee(id){ const r = await fetch(`/api/employee-delete?id=${encodeURIComponent(id)}`); if(!r.ok) throw new Error('Employee delete failed'); }
  async function apiSaveLeave(l){
    const r = await fetch('/api/leave', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(l) });
    if(!r.ok){
      let errMsg = 'Leave save failed';
      try{ 
        const j = await r.json();
        if(j?.error) errMsg = j.error;
      }catch(e){ console.error('error parsing response:', e); }
      throw new Error(errMsg);
    }
    return r.json().catch(()=>({ ok:true }));
  }
  async function apiDeleteLeave(id){ const r = await fetch(`/api/leave-delete?id=${encodeURIComponent(id)}`); if(!r.ok) throw new Error('Leave delete failed'); }
  async function apiSetHolidays(holidays){
    // Convert to format with date and name
    const holidayObjects = (holidays||[]).map(h => {
      if (typeof h === 'string') {
        return { date: h, name: '' };
      }
      return { date: h.date, name: h.name || '' };
    }).filter(h => h.date);
    
    const r = await fetch('/api/holidays-set', {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ holidays: holidayObjects })
    });
    if(!r.ok){
      let msg = 'Holidays set failed';
      try{ const j = await r.json(); if(j?.error) msg = j.error; }catch{}
      throw new Error(msg);
    }
    return r.json().catch(()=>({ ok:true }));
  }
  
  // User management API helpers
  async function apiGetUsers(){ const r = await fetch('/api/users-list'); if(!r.ok) throw new Error('Load users failed'); const j = await r.json(); return j.users || []; }
  async function apiCreateUser(email, name, role){ const r = await fetch('/api/users-create', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ email, name, role }) }); if(!r.ok){ const j = await r.json(); throw new Error(j.error || 'Create user failed'); } return (await r.json()).user; }
  async function apiDeleteUser(id){ const r = await fetch(`/api/users-delete?id=${encodeURIComponent(id)}`, { method:'DELETE' }); if(!r.ok){ const j = await r.json(); throw new Error(j.error || 'Delete user failed'); } }
  async function apiUpdateUserRole(id, role){ const r = await fetch('/api/users-update', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ id, role }) }); if(!r.ok){ const j = await r.json(); throw new Error(j.error || 'Update user failed'); } return (await r.json()).user; }

  // Users cache to resolve who applied a leave (created_by)
  let USERS_BY_ID = {};
  async function ensureUsersCache(){
    try{
      const me = getCurrentUser();
      if(!me || !['MANAGER','HR'].includes(me.role)) return; // employees don't need user list
      // If already loaded, skip
      if(Object.keys(USERS_BY_ID).length) return;
      const list = await apiGetUsers();
      USERS_BY_ID = Object.fromEntries((list||[]).map(u=>[u.id, u]));
    }catch(e){ /* non-critical */ }
  }
  function userDisplayById(id){
    const u = id && USERS_BY_ID[id];
    if(!u) return id || '';
    return u.name || u.email || id;
  }

  async function refreshFromServer(){
    // Save scroll positions (window and calendar container) before re-rendering
    const prevCal = document.getElementById('calendarContainer');
    const calScrollLeft = prevCal ? prevCal.scrollLeft : 0;
    const calScrollTop  = prevCal ? prevCal.scrollTop  : 0;
    const winX = window.scrollX || 0;
    const winY = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;

    const data = await apiGetAll();
    DB = { meta:{updatedAt:Date.now()}, ...data };
    saveDB(DB);
    renderAll();

    // Restore scroll positions after re-rendering
    requestAnimationFrame(() => {
      const newCal = document.getElementById('calendarContainer');
      if (newCal) {
        newCal.scrollLeft = calScrollLeft;
        newCal.scrollTop  = calScrollTop;
      }
      window.scrollTo(winX, winY);
    });
  }

  // Report: inline leave management helpers and bindings
  function recomputeReportLeaveDays(){
    const fromEl = document.getElementById('reportLeaveFrom');
    const toEl = document.getElementById('reportLeaveTo');
    const daysEl = document.getElementById('reportLeaveDays');
    const halfDayEl = document.getElementById('reportLeaveHalfDay');
    if(!fromEl || !toEl || !daysEl) return;
    const from = fromEl.value, to = toEl.value;
    if(!from || !to){ daysEl.value = ''; return; }
    
    // Check if it's a half day
    const isHalfDay = halfDayEl && halfDayEl.checked;
    const isSameDay = from === to;
    
    if (isHalfDay && isSameDay) {
      daysEl.value = '0.5';
    } else if (isHalfDay && !isSameDay) {
      // If half day is checked but dates are different, uncheck it
      if(halfDayEl) halfDayEl.checked = false;
      daysEl.value = String(workingDays(from,to));
    } else {
      daysEl.value = String(workingDays(from,to));
    }
  }

  function renderReportLeaves(){
    const tbody = document.querySelector('#reportLeavesTable tbody');
    if(!tbody) return;
    const user = getCurrentUser();
    // Try to ensure we have a users cache for resolving created_by
    // Fire and forget; rows fallback to raw id if not yet loaded
    ensureUsersCache();
    let empId = state.selectedEmployee || '';
    if(!empId){
      if(user?.role === 'EMPLOYEE'){
        const match = (DB.employees||[]).find(e => (e.email||'').toLowerCase() === (user.email||'').toLowerCase());
        empId = match ? match.id : '';
      }else{
        empId = (DB.employees[0]?.id||'');
      }
    }
    const year = state.year;
    if(!empId){ tbody.innerHTML = '<tr><td colspan="10">No employee record mapped to your account.</td></tr>'; return; }
    const emp = getEmployee(empId);
    const rows = (DB.leaves||[])
      .filter(l => l.employeeId===empId)
      // Always show PENDING items even if they are from another year,
      // so managers/HR don't miss cross-year applications
      .filter(l => (l.status === 'PENDING') || workingDaysInYear(l.from,l.to,year) > 0)
      .sort((a,b)=> (a.from||'').localeCompare(b.from||''))
      .map(l=>{
        const tr = document.createElement('tr');
        const actionsAllowed = (user?.role==='MANAGER' || user?.role==='HR');
        const daysDisplay = l.isHalfDay ? `${l.days} (${l.session || 'N/A'})` : (l.days ?? workingDays(l.from,l.to));
        const appliedUser = l.createdBy ? USERS_BY_ID[l.createdBy] : null;
        const appliedBy = appliedUser ? ( (emp && appliedUser.email && emp.email && appliedUser.email.toLowerCase()===emp.email.toLowerCase()) ? 'Self' : (appliedUser.name || appliedUser.email || '') ) : userDisplayById(l.createdBy || '');
        const approvedBy = l.approvedBy || '';
        const statusHtml = `<span class="status-badge status-${(l.status||'PENDING').toUpperCase()}">${l.status||'PENDING'}</span>`;
        tr.innerHTML = actionsAllowed ? `
          <td>${l.type}</td>
          <td>${statusHtml}</td>
          <td>${approvedBy||''}</td>
          <td>${appliedBy||''}</td>
          <td>${l.applied||''}</td>
          <td>${l.from||''}</td>
          <td>${l.to||''}</td>
          <td class="num">${daysDisplay}</td>
          <td class="wrap ellipsis" title="${(l.reason||'').replaceAll('"','&quot;')}">${l.reason||''}</td>
          <td class="actions">
            <button class="ghost" data-act="report-edit" data-id="${l.id}">Edit</button>
            <button class="danger" data-act="report-del" data-id="${l.id}">Delete</button>
            <button class="ghost" data-act="report-approve" data-id="${l.id}">Approve</button>
            <button class="ghost" data-act="report-reject" data-id="${l.id}">Reject</button>
          </td>` : `
          <td>${l.type}</td>
          <td>${statusHtml}</td>
          <td>${approvedBy||''}</td>
          <td>${appliedBy||''}</td>
          <td>${l.applied||''}</td>
          <td>${l.from||''}</td>
          <td>${l.to||''}</td>
          <td class="num">${daysDisplay}</td>
          <td class="wrap ellipsis" title="${(l.reason||'').replaceAll('"','&quot;')}">${l.reason||''}</td>
          <td></td>`;
        return tr;
      });
    tbody.innerHTML = '';
    rows.forEach(r=>tbody.appendChild(r));
    // Compact mode for better density
    const table = document.getElementById('reportLeavesTable');
    if(table) table.classList.add('compact');
  }

  function bindReportLeaves(){
    const from = document.getElementById('reportLeaveFrom');
    const to = document.getElementById('reportLeaveTo');
    const type = document.getElementById('reportLeaveType');
    const halfDayEl = document.getElementById('reportLeaveHalfDay');
    const sessionLabel = document.getElementById('reportLeaveSessionLabel');
    const sessionEl = document.getElementById('reportLeaveSession');
    
    if(from) from.addEventListener('change', recomputeReportLeaveDays);
    if(to) to.addEventListener('change', recomputeReportLeaveDays);
    if(type) type.addEventListener('change', recomputeReportLeaveDays);
    
    // Half-day checkbox logic
    if(halfDayEl && sessionLabel) {
      halfDayEl.addEventListener('change', function(){
        const fromVal = from?.value;
        const toVal = to?.value;
        
        if(this.checked) {
          // Ensure from and to dates are the same
          if(fromVal && toVal && fromVal !== toVal) {
            alert('Half day leave requires the same From and To date.');
            this.checked = false;
            return;
          }
          if(fromVal && !toVal) {
            to.value = fromVal;
          }
          if(!fromVal && toVal) {
            from.value = toVal;
          }
          sessionLabel.style.display = '';
          if(sessionEl) sessionEl.required = true;
        } else {
          sessionLabel.style.display = 'none';
          if(sessionEl) {
            sessionEl.required = false;
            sessionEl.value = '';
          }
        }
        recomputeReportLeaveDays();
      });
    }

    const form = document.getElementById('reportLeaveForm');
    if(form){
      form.addEventListener('submit', async (e)=>{
        e.preventDefault();
        try{
          const idEl = document.getElementById('reportLeaveId');
          const id = (idEl?.value) || nid();
          const isNew = !DB.leaves.some(x=>x.id===id);
          const entry = isNew ? { id } : DB.leaves.find(l=>l.id===id);
          entry.employeeId = state.selectedEmployee || (DB.employees[0]?.id||'');
          if(!entry.employeeId){ alert('Please select an employee'); return; }
          // Double confirmation if applying for someone else (EMPLOYEE or MANAGER)
          try{
            const me = getCurrentUser();
            const myEmp = (DB.employees||[]).find(e => (e.email||'').toLowerCase() === (me.email||'').toLowerCase());
            if((me?.role==='EMPLOYEE' || me?.role==='MANAGER') && myEmp && myEmp.id !== entry.employeeId){
              const target = getEmployee(entry.employeeId);
              const msg1 = `You are applying leave for ${target?.name||'another employee'}, but you are logged in as ${me?.name||me?.email||'Unknown'}. Are you sure you're on the correct employee tab?`;
              if(!confirm(msg1)) return;
              if(!confirm('Please confirm again to proceed.')) return;
            }
          }catch{}
          entry.type = document.getElementById('reportLeaveType').value;
          entry.status = entry.status || 'PENDING';
          entry.applied = document.getElementById('reportLeaveApplied').value || today();
          entry.from = document.getElementById('reportLeaveFrom').value;
          entry.to = document.getElementById('reportLeaveTo').value;
          
          // Handle half-day leave
          const halfDayEl = document.getElementById('reportLeaveHalfDay');
          const sessionEl = document.getElementById('reportLeaveSession');
          entry.isHalfDay = halfDayEl ? halfDayEl.checked : false;
          entry.session = (entry.isHalfDay && sessionEl) ? sessionEl.value : null;
          
          // Validate half-day requirements
          if(entry.isHalfDay) {
            if(entry.from !== entry.to) {
              alert('Half day leave requires the same From and To date.');
              return;
            }
            if(!entry.session) {
              alert('Please select AM or PM for half-day leave.');
              sessionEl?.focus();
              return;
            }
          }
          
          entry.days = Number(document.getElementById('reportLeaveDays').value) || workingDays(entry.from, entry.to);
          entry.reason = (document.getElementById('reportLeaveReason').value||'').trim();
          if(!entry.reason){
            alert('Please enter a reason for the leave.');
            document.getElementById('reportLeaveReason').focus();
            return;
          }
          if(isNew) DB.leaves.push(entry);
          saveDB(DB);
          // Optimistic UI update – show immediately
          renderReportLeaves(); buildReportCard(); updateInbox();
          await apiSaveLeave(entry);
          await refreshFromServer();
          form.reset(); if(idEl) idEl.value='';
          buildReportCard(); renderReportLeaves();
          activateTab('reports');
          alert('Leave submitted.');
        }catch(err){ console.error('Report leave submit error:', err); alert('Error: ' + (err?.message||'Unknown')); }
      });
      const cancel = document.getElementById('reportLeaveCancelBtn');
      if(cancel){ cancel.addEventListener('click', ()=>{ form.reset(); const idEl = document.getElementById('reportLeaveId'); if(idEl) idEl.value=''; }); }
    }

    const table = document.getElementById('reportLeavesTable');
    if(table){
      table.addEventListener('click', async (e)=>{
        const btn = e.target.closest('button'); if(!btn) return;
        const id = btn.dataset.id; const act = btn.dataset.act;
        if(act==='report-edit'){
          const l = DB.leaves.find(x=>x.id===id); if(!l) return; const user = getCurrentUser(); if(user?.role==='EMPLOYEE') return;
          document.getElementById('reportLeaveId').value = l.id;
          document.getElementById('reportLeaveType').value = l.type;
          document.getElementById('reportLeaveApplied').value = l.applied||'';
          document.getElementById('reportLeaveFrom').value = l.from||'';
          document.getElementById('reportLeaveTo').value = l.to||'';
          document.getElementById('reportLeaveDays').value = l.days ?? workingDays(l.from,l.to);
          document.getElementById('reportLeaveReason').value = l.reason||'';
          
          // Populate half-day fields
          const halfDayEl = document.getElementById('reportLeaveHalfDay');
          const sessionEl = document.getElementById('reportLeaveSession');
          const sessionLabel = document.getElementById('reportLeaveSessionLabel');
          if(halfDayEl) {
            halfDayEl.checked = l.isHalfDay || false;
            if(l.isHalfDay && sessionLabel) {
              sessionLabel.style.display = '';
              if(sessionEl) {
                sessionEl.value = l.session || '';
                sessionEl.required = true;
              }
            } else if(sessionLabel) {
              sessionLabel.style.display = 'none';
              if(sessionEl) {
                sessionEl.value = '';
                sessionEl.required = false;
              }
            }
          }
        }
        if(act==='report-del'){
          const user = getCurrentUser(); if(user?.role==='EMPLOYEE') return; if(confirm('Delete this leave entry?')){
            DB.leaves = DB.leaves.filter(x=>x.id!==id); saveDB(DB);
            await apiDeleteLeave(id);
            await refreshFromServer();
            buildReportCard(); renderReportLeaves();
            activateTab('reports');
          }
        }
        if(act==='report-approve' || act==='report-reject'){
          try{
            const l = DB.leaves.find(x=>x.id===id); if(!l) return;
            const user = getCurrentUser(); if(!['MANAGER','HR'].includes(user.role)) { alert('Only Manager/HR can approve or reject.'); return; }
            l.status = (act==='report-approve') ? 'APPROVED' : 'REJECTED';
            l.approvedBy = user.name||'Manager';
            l.approvedAt = today();
            saveDB(DB); await apiSaveLeave(l); await refreshFromServer();
            buildReportCard(); renderReportLeaves();
            activateTab('reports');
            const okMsg = act==='report-approve' ? 'Leave approved.' : 'Leave rejected.';
            if(typeof showToast === 'function') showToast(okMsg, act==='report-approve' ? 'success' : 'error');
          }catch(err){ console.error('Approve/Reject error:', err); alert('Error: ' + (err?.message||'Unknown')); }
        }
      });
    }
  }

  // Auto sync helpers
  let autoTimer = null, debounceTimer = null, heartbeatTimer = null;
  function scheduleDebouncedSync(){
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async ()=>{
      try{ setStatus('Syncing...'); await refreshFromServer(); setStatus('Synced.'); }
      catch(e){ console.error(e); setStatus('Sync error'); }
    }, 1200);
  }
  function startAutoSync(){
    clearInterval(autoTimer);
    clearInterval(heartbeatTimer);
    // immediate sync on start
    scheduleDebouncedSync('start');
    autoTimer = setInterval(()=> scheduleDebouncedSync('interval'), 15_000);
    // heartbeat: check for changes every 5s with light query
    let lastSeen = DB?.meta?.updatedAt || 0;
    heartbeatTimer = setInterval(async ()=>{
      try{
        const r = await fetch('/api/heartbeat');
        if(!r.ok) return;
        const { lastChange } = await r.json();
        const ts = new Date(lastChange).getTime();
        if(ts > lastSeen){ lastSeen = ts; await refreshFromServer(); }
      }catch{}
    }, 5000);
  }

  // Realtime via Pusher Channels
  async function initRealtime(){
    try{
      if(!(window).Pusher) return; // SDK not loaded
      const cfgRes = await fetch('/api/realtime-config');
      if(!cfgRes.ok) return;
      const { key, cluster } = await cfgRes.json();
      if(!key || !cluster) return;
      const p = new window.Pusher(key, { cluster, authTransport: 'ajax' });
      const channel = p.subscribe('leave-manager');
      channel.bind('changed', async (data) => {
        const prev = (DB.leaves||[]).filter(l => (l.status||'PENDING')==='PENDING').length;
        await refreshFromServer();
        updateInbox();
        const next = (DB.leaves||[]).filter(l => (l.status||'PENDING')==='PENDING').length;
        const user = getCurrentUser();
        if(user && (user.role==='MANAGER' || user.role==='HR') && next > prev){
          const panel = document.getElementById('inboxDropdown');
          if(panel){ panel.style.display='block'; }
        }
        // Notify employee on their leave updates
        try{
          if(data && data.type === 'leave-updated' && data.leave){
            const me = getCurrentUser();
            if(me && me.email){
              const myEmp = (DB.employees||[]).find(e => (e.email||'').toLowerCase() === (me.email||'').toLowerCase());
              if(myEmp && myEmp.id === data.leave.employeeId && me.role === 'EMPLOYEE'){
                const status = data.leave.status || 'UPDATED';
                const lt = data.leave.leaveType || 'Leave';
                const from = data.leave.from || '';
                const to = data.leave.to || '';
                const msg = status === 'APPROVED'
                  ? `Your ${lt} (${from} → ${to}) was approved.`
                  : status === 'REJECTED'
                    ? `Your ${lt} (${from} → ${to}) was rejected.`
                    : `Your ${lt} (${from} → ${to}) was updated.`;
                if(typeof showToast === 'function') showToast(msg, status === 'REJECTED' ? 'error' : 'success');
              }
            }
          }
        }catch(e){ /* ignore */ }
      });
    }catch(e){ /* ignore */ }
  }
  function setStatus(msg){ const el = document.getElementById('cloudStatus'); if(el) el.textContent = msg||''; }

  // Toast notifications
  function getToastContainer(){
    let c = document.getElementById('toastContainer');
    if(!c){
      c = document.createElement('div');
      c.id = 'toastContainer';
      document.body.appendChild(c);
    }
    return c;
  }
  function showToast(message, type='info', opts={}){
    try{
      const container = getToastContainer();
      const t = document.createElement('div');
      t.className = `toast ${type}`;
      t.textContent = message;
      container.appendChild(t);
      requestAnimationFrame(()=> t.classList.add('show'));
      const ttl = Math.max(2000, opts.duration||3000);
      setTimeout(()=>{
        t.classList.remove('show');
        t.classList.add('hide');
        setTimeout(()=> t.remove(), 250);
      }, ttl);
    }catch(e){ console.log('Toast:', message); }
  }

  // Inbox (pending leaves for Manager/HR) and status updates for Employees
  function getEmpInboxKey(){
    try{ const me = getCurrentUser(); const email = (me?.email||'anon').toLowerCase(); return `leaveManager.inbox.seen.${email}`; }catch{ return 'leaveManager.inbox.seen.anon'; }
  }
  function loadEmpInboxSeen(){ try{ return JSON.parse(localStorage.getItem(getEmpInboxKey())||'{}'); }catch{ return {}; } }
  function saveEmpInboxSeen(data){ try{ localStorage.setItem(getEmpInboxKey(), JSON.stringify(data||{})); }catch{} }
  function leaveVersion(l){ return `${l.status||'PENDING'}|${l.approvedAt||''}|${l.applied||''}`; }

  function updateInbox(){
    try{
      const user = getCurrentUser();
      const btn = document.getElementById('inboxBtn');
      const countEl = document.getElementById('inboxCount');
      const panel = document.getElementById('inboxDropdown');
      if(!btn || !countEl || !panel) return;
      const isManager = user && (user.role==='MANAGER' || user.role==='HR');
      const isEmployee = user && user.role==='EMPLOYEE';

      // Show inbox for both managers and employees
      btn.style.display = (isManager || isEmployee) ? '' : 'none';
      if(!(isManager || isEmployee)){ panel.style.display='none'; return; }

      if(isManager){
        const pending = (DB.leaves||[]).filter(l => (l.status||'PENDING')==='PENDING');
        countEl.textContent = String(pending.length);
        if(pending.length===0){ panel.innerHTML = '<div class="panel"><p>No pending applications.</p></div>'; return; }
        const items = pending
          .sort((a,b)=> (a.applied||'').localeCompare(b.applied||''))
          .slice(0,100)
          .map(l=>{
            const emp = getEmployee(l.employeeId)||{name:'[deleted]'};
            return `<div class="panel" style="margin-bottom:8px">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
                <div>
                  <strong>${emp.name}</strong> • ${l.type}
                  <div style="color:var(--muted);font-size:12px">${l.from||''} → ${l.to||''} • Applied ${l.applied||''}</div>
                </div>
                <div class="actions">
                  <button class="ghost" data-inbox-act="approve" data-id="${l.id}">Approve</button>
                  <button class="ghost" data-inbox-act="reject" data-id="${l.id}">Reject</button>
                </div>
              </div>
            </div>`;
          }).join('');
        panel.innerHTML = items;
        return;
      }

      // Employee inbox: show status updates for own leaves
      const meEmail = (user?.email||'').toLowerCase();
      const myEmp = (DB.employees||[]).find(e => (e.email||'').toLowerCase() === meEmail);
      if(!myEmp){ countEl.textContent = '0'; panel.innerHTML = '<div class="panel"><p>No profile found.</p></div>'; return; }
      const seen = loadEmpInboxSeen();
      const myLeaves = (DB.leaves||[])
        .filter(l => l.employeeId === myEmp.id)
        .sort((a,b)=> (b.approvedAt||b.applied||'').localeCompare(a.approvedAt||a.applied||''))
        .slice(0,100);
      const notifLeaves = myLeaves.filter(l => (l.status==='APPROVED' || l.status==='REJECTED'));
      const unread = notifLeaves.filter(l => (seen[l.id]||'') !== leaveVersion(l));
      countEl.textContent = String(unread.length);
      if(myLeaves.length===0){ panel.innerHTML = '<div class="panel"><p>No leave applications yet.</p></div>'; return; }
      const header = `<div class="panel" style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:8px">
        <strong>My Inbox</strong>
        <div class="actions"><button class="ghost" data-emp-act="mark-all-read">Mark all as read</button></div>
      </div>`;
      const items = myLeaves.map(l =>{
        const v = leaveVersion(l);
        const isUnread = (l.status==='APPROVED' || l.status==='REJECTED') && (seen[l.id]||'') !== v;
        const status = l.status||'PENDING';
        const when = l.approvedAt || l.applied || '';
        const sub = status==='PENDING' ? `Applied ${l.applied||''}` : `${status==='APPROVED'?'Approved':'Rejected'} ${when}`;
        return `<div class="panel" style="margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <div>
              <strong>${l.type}</strong> • ${l.from||''} → ${l.to||''}
              <div style="color:var(--muted);font-size:12px">${sub}</div>
            </div>
            <div class="actions">
              ${isUnread ? '<span class="inb-dot" title="Unread"></span>' : ''}
              ${isUnread ? `<button class="ghost" data-emp-act="mark-read" data-id="${l.id}">Mark read</button>` : ''}
            </div>
          </div>
        </div>`;
      }).join('');
      panel.innerHTML = header + items;
    }catch(e){ console.warn('updateInbox error:', e); }
  }

  // Business days calculation (Mon-Fri excluding holidays)
  function isWeekend(date){ const day = date.getDay(); return day===0 || day===6; }
  function isHoliday(date, holidays){
    const s = ymd(date);
    if(!Array.isArray(holidays)) return false;
    return holidays.some(h => (typeof h === 'string' ? h : h?.date) === s);
  }
  function workingDays(fromStr, toStr, holidays=DB.holidays){
    if(!fromStr || !toStr) return 0;
    let from = new Date(fromStr), to = new Date(toStr);
    if(to < from){ const t = from; from = to; to = t; }
    let days = 0, cur = new Date(from);
    while(cur <= to){ if(!isWeekend(cur) && !isHoliday(cur, holidays)) days++; cur.setDate(cur.getDate()+1); }
    return days;
  }
  function workingDaysInRange(fromStr, toStr, rangeStartStr, rangeEndStr){
    const start = new Date(rangeStartStr), end = new Date(rangeEndStr);
    let from = new Date(fromStr), to = new Date(toStr);
    if(to < from){ const t = from; from = to; to = t; }
    const a = from < start ? start : from;
    const b = to > end ? end : to;
    if(b < a) return 0;
    return workingDays(ymd(a), ymd(b));
  }
  function workingDaysInYear(fromStr, toStr, year){
    const rs = `${year}-01-01`, re = `${year}-12-31`;
    return workingDaysInRange(fromStr, toStr, rs, re);
  }

  // Compute effective leave days that fall within a specific year.
  // - Honors half-day entries (isHalfDay with same-day from/to) as 0.5
  // - If a custom l.days is provided and the leave is fully within the year, use it
  // - Falls back to business-day calculation for cross-year or unspecified cases
  function daysForLeaveInYear(l, year){
    if(!l) return 0;
    const from = l.from || '', to = l.to || '';
    const fy = Number(from.slice(0,4)||0), ty = Number(to.slice(0,4)||0), y = Number(year);
    // Half day on a single date within the requested year
    if(l.isHalfDay && from && to && from === to && fy === y){
      return 0.5;
    }
    // If explicitly stored days and the range is contained within the same year
    if(typeof l.days === 'number' && !isNaN(l.days) && from && to && fy === ty && fy === y){
      return Number(l.days);
    }
    // Fallback to business days within the year
    return workingDaysInYear(from, to, year);
  }

  // Data helpers
  const nid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  function getEmployee(id){ return DB.employees.find(e => e.id===id); }
  function setEntitlement(emp, year, carry=0, current=0){
    emp.entitlements ||= {};
    emp.entitlements[year] = { carry:Number(carry)||0, current:Number(current)||0 };
  }
  function getEntitlement(emp, year){
    if(!emp?.entitlements) return { carry:0, current:0 };
    const e = emp.entitlements[year];
    return e ? { carry:e.carry||0, current:e.current||0 } : { carry:0, current:0 };
  }
  function annualTotalsFor(empId, year){
    const totalDays = DB.leaves
      .filter(l => l.employeeId===empId && l.type==='ANNUAL' && (l.status==='APPROVED' || l.status===undefined))
      .reduce((sum,l)=> sum + daysForLeaveInYear(l, year), 0);
    const ent = getEntitlement(getEmployee(empId), year);
    const entitlement = (ent.carry||0)+(ent.current||0);
    const balance = entitlement - totalDays;
    return { entitlement, taken: totalDays, balance };
  }
  function totalsByType(empId, year, type){
    return DB.leaves
      .filter(l => l.employeeId===empId && l.type===type && (l.status==='APPROVED' || l.status===undefined))
      .reduce((sum,l)=> sum + daysForLeaveInYear(l, year), 0);
  }
  function getCarryForwardBalance(empId, year){
    // Calculate unused balance from given year that should carry to next year
    const totals = annualTotalsFor(empId, year);
    return Math.min(5, Math.max(0, totals.balance)); // Cap at 5 days maximum
  }
  async function resetCarryForward(){
    // Reset all carry-forward values to correct amounts (max 5 per year pair)
    // This fixes any incorrect manual entries
    console.log('=== RESETTING CARRY-FORWARD TO CORRECT VALUES ===');
    const yearsToProcess = [2024, 2025, 2026];
    let changes = false;
    
    for(const fromYear of yearsToProcess){
      const toYear = fromYear + 1;
      console.log(`\n--- Resetting ${fromYear}→${toYear} ---`);
      
      for(const emp of DB.employees){
        const balance = getCarryForwardBalance(emp.id, fromYear); // This gives us the max 5 days
        const ent = getEntitlement(emp, toYear);
        const currentCarry = ent.carry||0;
        
        console.log(`${emp.name}: Year ${toYear} - Current carry: ${currentCarry}, Should be: ${balance}`);
        
        if(currentCarry !== balance){
          console.log(`${emp.name}: ✓ Correcting carry from ${currentCarry} to ${balance}`);
          setEntitlement(emp, toYear, balance, ent.current||0);
          changes = true;
        }
      }
    }
    
    if(changes){
      saveDB(DB);
      await apiSaveAllEmployees();
      console.log('\n=== RESET COMPLETE ===');
      alert('Carry-forward values reset to correct amounts. Refreshing...');
      location.reload();
    }else{
      console.log('\n=== ALL CARRY VALUES ALREADY CORRECT ===');
    }
  }
  async function autoCarryForward(){
    // Only run once per app session to avoid duplicate carries
    if(state.autoCarryDone) return;
    state.autoCarryDone = true;
    
    // Automatically carry forward unused annual leave for all years
    // Process: 2024→2025, 2025→2026, etc.
    const yearsToProcess = [2024, 2025, 2026]; // Years to process carries FROM
    
    console.log(`=== AUTO CARRY-FORWARD: Processing years ${yearsToProcess.join(', ')} ===`);
    let changes = false;
    
    for(const fromYear of yearsToProcess){
      const toYear = fromYear + 1;
      console.log(`\n--- Carrying from ${fromYear} to ${toYear} ---`);
      
      for(const emp of DB.employees){
        const balance = getCarryForwardBalance(emp.id, fromYear);
        const totals = annualTotalsFor(emp.id, fromYear);
        console.log(`${emp.name}: Year ${fromYear} - Entitlement: ${totals.entitlement}, Taken: ${totals.taken}, Balance: ${totals.balance}, Carry Amount: ${balance}`);
        
        if(balance > 0){
          // Only auto-apply carry if the next year's carry has not been manually set yet.
          // We detect this by checking the raw entitlements object for the presence of 'carry'.
          const entObj = (emp.entitlements||{})[toYear];
          const hasManualCarry = entObj && Object.prototype.hasOwnProperty.call(entObj, 'carry');
          const ent = getEntitlement(emp, toYear);
          if(!hasManualCarry){
            const expectedCarry = balance; // capped inside getCarryForwardBalance
            console.log(`${emp.name}: Year ${toYear} - Auto-setting carry to ${expectedCarry} (no manual value present)`);
            setEntitlement(emp, toYear, expectedCarry, ent.current||0);
            changes = true;
          }else{
            console.log(`${emp.name}: Year ${toYear} - Skipping auto-carry (manual carry present: ${ent.carry||0})`);
          }
        }
      }
    }
    
    if(changes){
      saveDB(DB);
      await apiSaveAllEmployees();
      console.log('\n=== CARRY-FORWARD COMPLETE ===');
    }else{
      console.log('\n=== NO CHANGES NEEDED (Already applied) ===');
    }
  }
  async function apiSaveAllEmployees(){
    // Save all employees in bulk to backend
    for(const emp of DB.employees){
      for(const year in emp.entitlements||{}){
        const ent = emp.entitlements[year];
        try{
          await apiSaveEmployee(emp, { year:Number(year), carry:ent.carry||0, current:ent.current||0 });
        }catch(e){
          console.error(`Error saving entitlements for ${emp.name} year ${year}:`, e);
        }
      }
    }
  }

  // Employee tabs
  function renderEmployeeTabs(){
    const nav = $('#employeeTabsNav');
    const user = getCurrentUser();
    let list = DB.employees;
    // If employee role, restrict to their own record (by email)
    if(user?.role === 'EMPLOYEE'){
      list = DB.employees.filter(e => (e.email||'').toLowerCase() === (user.email||'').toLowerCase());
      // If no mapping, clear selection to avoid showing someone else
      if(list.length === 0){
        state.selectedEmployee = null;
        saveState();
      }
    }
    const html = list
      .map(e => `<button class="employee-tab-nav ${state.selectedEmployee === e.id ? 'active' : ''}" data-emp-id="${e.id}">${e.name}</button>`)
      .join('');
    nav.innerHTML = html;
    
    // Bind click handlers
    $$('.employee-tab-nav').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        state.selectedEmployee = btn.dataset.empId;
        saveState();
        renderEmployeeTabs(); // Update active state
        renderEmployees(); // Show this employee's data
        renderLeaves(); // Show this employee's leaves
        buildReportCard(); // Update report
        // Also update inline report leave list
        if (document.getElementById('reportLeavesTable')) {
          renderReportLeaves();
        }
      });
    });
    
    // Auto-select first employee if none selected
    if(!state.selectedEmployee && list.length > 0){
      state.selectedEmployee = list[0].id;
      saveState();
      renderEmployeeTabs();
    }
  }

  // Tabs
  function bindTabs(){
    $$('.tab').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        $$('.tab').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        const t = btn.dataset.tab;
        $$('.tab-content').forEach(s=>s.classList.remove('active'));
        $(`#tab-${t}`).classList.add('active');
      })
    })
  }

  // Helper: force a specific top-level tab to remain active
  function activateTab(name){
    try{
      $$('.tab').forEach(b=>b.classList.remove('active'));
      const btn = document.querySelector(`.tab[data-tab="${name}"]`);
      if(btn) btn.classList.add('active');
      $$('.tab-content').forEach(s=>s.classList.remove('active'));
      const sec = document.getElementById(`tab-${name}`);
      if(sec) sec.classList.add('active');
    }catch{}
  }

  // Year tabs
  function bindYearTabs(){
    $$('.year-tab-nav').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const year = Number(btn.dataset.year);
        state.year = year;
        saveState();
        const yi = $('#yearInput'); if(yi) yi.value = year;
        
        // Update year tab active state
        $$('.year-tab-nav').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        
        // Update year selector buttons
        updateYearTabs();
        
        // Re-render all content with new year
        const r = $('#reportYear'); if(r) r.value = year;
        const eey = $('#empEntYear'); if(eey) eey.value = year;
        renderEmployees();
        renderLeaves();
        buildReportCard();
        renderReportLeaves();
      });
    });
    updateYearTabsNav();
  }
  function updateYearTabsNav(){
    $$('.year-tab-nav').forEach(btn=>{
      if(Number(btn.dataset.year)===state.year){
        btn.classList.add('active');
      }else{
        btn.classList.remove('active');
      }
    });
  }

  // Employees UI
  function renderEmployees(){
    const tbody = $('#employeesTable tbody');
    const q = ($('#employeeSearch').value||'').toLowerCase();
    const user = getCurrentUser();
    // If an employee is selected, show only that employee
    let employees = state.selectedEmployee 
      ? DB.employees.filter(e => e.id === state.selectedEmployee)
      : DB.employees;
    // Further restrict for EMPLOYEE role
    if(user?.role === 'EMPLOYEE'){
      employees = DB.employees.filter(e => (e.email||'').toLowerCase() === (user.email||'').toLowerCase());
    }
    const rows = employees
      .filter(e => `${e.name} ${e.jobTitle||''} ${e.department||''} ${e.email||''}`.toLowerCase().includes(q))
      .map(emp =>{
        const totals = annualTotalsFor(emp.id, state.year);
        const tr = document.createElement('tr');
        const carryFwdBtn = getCarryForwardBalance(emp.id, state.year) > 0 ? `<button class="ghost" data-act="carry" data-id="${emp.id}" title="Carry forward ${getCarryForwardBalance(emp.id, state.year)} days to ${state.year+1}">Carry Fwd</button>` : '';
        const actions = (user?.role === 'EMPLOYEE') ? '' : `
          <td>${emp.name||''}</td>
          <td>${emp.email||''}</td>
          <td>${emp.role||'EMPLOYEE'}</td>
          <td>${emp.jobTitle||''}</td>
          <td>${emp.department||''}</td>
          <td>${emp.dateJoined||''}</td>
          <td>${totals.entitlement}</td>
          <td>${totals.taken}</td>
          <td>${totals.balance}</td>
          <td class="actions">
            <button class="ghost" data-act="edit" data-id="${emp.id}">Edit</button>
            <button class="danger" data-act="del" data-id="${emp.id}">Delete</button>
            ${carryFwdBtn}
          </td>`;
        tr.innerHTML = actions || `
          <td>${emp.name||''}</td>
          <td>${emp.email||''}</td>
          <td>${emp.role||'EMPLOYEE'}</td>
          <td>${emp.jobTitle||''}</td>
          <td>${emp.department||''}</td>
          <td>${emp.dateJoined||''}</td>
          <td>${totals.entitlement}</td>
          <td>${totals.taken}</td>
          <td>${totals.balance}</td>
          <td></td>`;
        return tr;
      });
    tbody.innerHTML = '';
    rows.forEach(r=>tbody.appendChild(r));
  }
  function fillEmployeeForm(emp){
    $('#employeeId').value = emp?.id || '';
    $('#empName').value = emp?.name || '';
    $('#empEmail').value = emp?.email || '';
    $('#empRole').value = emp?.role || 'EMPLOYEE';
    $('#empTitle').value = emp?.jobTitle || '';
    $('#empDept').value = emp?.department || '';
    $('#empJoined').value = emp?.dateJoined || '';
    $('#empEntYear').value = state.year;
    const ent = emp ? getEntitlement(emp, state.year) : {carry:0,current:0};
    $('#empCarry').value = ent.carry || 0;
    $('#empCurrent').value = ent.current || 0;
  }
  function bindEmployeeForm(){
    $('#employeeForm').addEventListener('submit', async (e)=>{
      e.preventDefault();
      try{
        const id = $('#employeeId').value || nid();
        const isNew = !DB.employees.some(x=>x.id===id);
        const emp = isNew ? { id } : getEmployee(id);
        emp.name = $('#empName').value.trim();
        emp.email = $('#empEmail').value.trim();
        emp.role = $('#empRole').value;
        emp.jobTitle = $('#empTitle').value.trim();
        emp.department = $('#empDept').value.trim();
        emp.dateJoined = $('#empJoined').value || '';
        
        const entYear = Number($('#empEntYear').value)||state.year;
        const carry = Number($('#empCarry').value)||0;
        const current = Number($('#empCurrent').value)||0;
        setEntitlement(emp, entYear, carry, current);
        if(isNew) DB.employees.push(emp);
        saveDB(DB);
        
        // Save employee with the selected entitlement year
        await apiSaveEmployee(emp, { year: entYear, carry, current });
        
        // Save or update user if email is provided
        if(emp.email){
          try{
            await apiCreateUser(emp.email, emp.name, emp.role);
          }catch(e){
            // User might already exist, try updating instead
            if(e.message.includes('already exists')){
              // Find user by email and update
              console.log('User already exists, skipping user creation');
            }else{
              console.error('User save error:', e);
              alert('Warning: Employee saved but user creation failed: ' + e.message);
            }
          }
        }
        
        await refreshFromServer();
        fillEmployeeForm(null);
        alert('Employee & User saved.');
      }catch(err){
        console.error('Form submission error:', err);
        alert('Error saving: ' + err.message);
      }
    });
    $('#employeeCancelBtn').addEventListener('click', ()=> fillEmployeeForm(null));

    // Table actions
    $('#employeesTable').addEventListener('click', async (e)=>{
      const btn = e.target.closest('button'); if(!btn) return;
      const id = btn.dataset.id; const act = btn.dataset.act;
      if(act==='edit'){ fillEmployeeForm(getEmployee(id)); }
      if(act==='del'){
        if(confirm('Delete employee and related leaves?')){
          DB.leaves = DB.leaves.filter(l=>l.employeeId!==id);
          DB.employees = DB.employees.filter(e=>e.id!==id);
          saveDB(DB);
          await apiDeleteEmployee(id);
          await refreshFromServer();
        }
      }
      if(act==='carry'){
        try{
          const emp = getEmployee(id);
          const carryAmount = getCarryForwardBalance(id, state.year);
          if(carryAmount<=0){ alert('No balance to carry forward.'); return; }
          if(confirm(`Carry forward ${carryAmount} days from ${state.year} to ${state.year+1}?`)){
            const nextYear = state.year + 1;
            const ent = getEntitlement(emp, nextYear);
            setEntitlement(emp, nextYear, (ent.carry||0)+carryAmount, ent.current||0);
            saveDB(DB);
            await apiSaveEmployee(emp, { carry:(ent.carry||0)+carryAmount, current:ent.current||0, year:nextYear });
            alert(`Carried forward ${carryAmount} days to ${nextYear}.`);
            renderEmployees();
          }
        }catch(err){
          console.error('Carry forward error:', err);
          alert('Error: ' + err?.message);
        }
      }
    });
    $('#employeeSearch').addEventListener('input', renderEmployees);
  }
  function renderEmployeeOptions(){
    const user = getCurrentUser();
    const list = (user?.role==='EMPLOYEE')
      ? DB.employees.filter(e => (e.email||'').toLowerCase() === (user.email||'').toLowerCase())
      : DB.employees;
    const opts = list.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
    ['leaveEmployee','filterEmployee','reportEmployee'].forEach(id=>{
      const el = $('#'+id); if(!el) return;
      const previous = el.value; // remember current selection
      const keep = id==='filterEmployee' && user?.role!=='EMPLOYEE';
      el.innerHTML = keep ? `<option value="">All Employees</option>${opts}` : opts;
      // Restore previous selection if still available; otherwise use sensible default
      const hasPrev = previous===' ' || list.some(e=>e.id===previous);
      if(hasPrev) {
        el.value = previous;
      } else if(keep) {
        el.value = '';
      } else if(list.length){
        el.value = list[0].id;
      } else {
        el.value = '';
      }
    });
  }

  // Leaves UI
  function recomputeLeaveDays(){
    const from = $('#leaveFrom').value, to = $('#leaveTo').value;
    const type = $('#leaveType').value;
    if(!from || !to){ $('#leaveDays').value = ''; return; }
    // For all leave types we count working days (Mon-Fri), can be adjusted later
    $('#leaveDays').value = String(workingDays(from,to));
  }
  function bindLeaveForm(){
    const form = document.getElementById('leaveForm');
    if(!form) return; // Leaves tab not present
    $('#leaveFrom').addEventListener('change', recomputeLeaveDays);
    $('#leaveTo').addEventListener('change', recomputeLeaveDays);
    $('#leaveType').addEventListener('change', recomputeLeaveDays);

    form.addEventListener('submit', async (e)=>{
      e.preventDefault();
      const submitBtn = $('#leaveForm button[type="submit"]');
      const origText = submitBtn ? submitBtn.textContent : '';
      try{
        if(submitBtn){ submitBtn.disabled = true; submitBtn.textContent = 'Submitting...'; }
        const id = $('#leaveId').value || nid();
        const isNew = !DB.leaves.some(x=>x.id===id);
        const entry = isNew ? { id } : DB.leaves.find(l=>l.id===id);
        entry.employeeId = $('#leaveEmployee').value;
        if(!entry.employeeId){ alert('Please select an employee'); return; }
        // Double confirmation if applying for someone else (EMPLOYEE or MANAGER)
        try{
          const me = getCurrentUser();
          const myEmp = (DB.employees||[]).find(e => (e.email||'').toLowerCase() === (me.email||'').toLowerCase());
          if((me?.role==='EMPLOYEE' || me?.role==='MANAGER') && myEmp && myEmp.id !== entry.employeeId){
            const target = getEmployee(entry.employeeId);
            const msg1 = `You are applying leave for ${target?.name||'another employee'}, but you are logged in as ${me?.name||me?.email||'Unknown'}. Are you sure you're on the correct employee tab?`;
            if(!confirm(msg1)) return;
            if(!confirm('Please confirm again to proceed.')) return;
          }
        }catch{}
        entry.type = $('#leaveType').value;
        entry.status = entry.status || 'PENDING';
        entry.applied = $('#leaveApplied').value || today();
        entry.from = $('#leaveFrom').value;
        entry.to = $('#leaveTo').value;
        entry.days = Number($('#leaveDays').value) || workingDays(entry.from, entry.to);
        entry.reason = $('#leaveReason').value.trim();
        if(isNew) DB.leaves.push(entry);
        saveDB(DB);
        await apiSaveLeave(entry);
        await refreshFromServer();
        form.reset(); $('#leaveId').value='';
        alert('Leave submitted.');
      }catch(err){
        console.error('Leave submit error:', err);
        alert('Error submitting leave: ' + (err?.message || 'Unknown error'));
      }finally{
        if(submitBtn){ submitBtn.disabled = false; submitBtn.textContent = origText || 'Submit Leave'; }
      }
    });

    const cancel = document.getElementById('leaveCancelBtn');
    if(cancel){ cancel.addEventListener('click', ()=>{ form.reset(); $('#leaveId').value=''; }); }
  }
  function renderLeaves(){
    const table = document.querySelector('#leavesTable tbody');
    if(!table) return; // Leaves tab not present
    const tbody = table;
    const user = getCurrentUser();
    // Preload users cache for potential lookups (safe if absent)
    ensureUsersCache();
    let empFilter = $('#filterEmployee').value || '';
    // Enforce employee scoping: never show other employees' leaves
    if(user?.role === 'EMPLOYEE'){
      const match = (DB.employees||[]).find(e => (e.email||'').toLowerCase() === (user.email||'').toLowerCase());
      empFilter = match ? match.id : '__none__';
    }
    const typeFilter = $('#filterType').value || '';
    const statusFilter = $('#filterStatus').value || '';
    const search = ($('#filterSearch').value||'').toLowerCase();
    const rows = DB.leaves
      .filter(l => !empFilter || l.employeeId===empFilter)
      .filter(l => !typeFilter || l.type===typeFilter)
      .filter(l => !statusFilter || (l.status||'PENDING')===statusFilter)
      .filter(l => (l.reason||'').toLowerCase().includes(search))
      .sort((a,b)=> a.from.localeCompare(b.from))
      .map(l =>{
        const emp = getEmployee(l.employeeId)||{name:'[deleted]'};
        const tr = document.createElement('tr');
        const statusHtml = `<span class="status-badge status-${(l.status||'PENDING').toUpperCase()}">${l.status||'PENDING'}</span>`;
        tr.innerHTML = `
          <td>${emp.name}</td>
          <td>${l.type}</td>
          <td>${statusHtml}</td>
          <td>${l.applied||''}</td>
          <td>${l.from}</td>
          <td>${l.to}</td>
          <td class="num">${l.days ?? workingDays(l.from,l.to)}</td>
          <td class="wrap ellipsis" title="${(l.reason||'').replaceAll('"','&quot;')}">${l.reason||''}</td>
          <td class="actions">
            <button class="ghost" data-act="edit" data-id="${l.id}">Edit</button>
            <button class="danger" data-act="del" data-id="${l.id}">Delete</button>
            <button class="ghost" data-act="approve" data-id="${l.id}">Approve</button>
            <button class="ghost" data-act="reject" data-id="${l.id}">Reject</button>
          </td>`;
        return tr;
      });
    tbody.innerHTML=''; rows.forEach(r=>tbody.appendChild(r));
    const leavesTableEl = document.getElementById('leavesTable');
    if(leavesTableEl) leavesTableEl.classList.add('compact');
  }
  function bindLeavesTable(){
    const leavesTable = document.getElementById('leavesTable');
    if(!leavesTable) return; // Leaves tab not present
    leavesTable.addEventListener('click', async (e)=>{
      const btn = e.target.closest('button'); if(!btn) return;
      const id = btn.dataset.id; const act = btn.dataset.act;
      if(act==='edit'){
        const l = DB.leaves.find(x=>x.id===id); if(!l) return;
        $('#leaveId').value = l.id;
        $('#leaveEmployee').value = l.employeeId;
        $('#leaveType').value = l.type;
        $('#leaveApplied').value = l.applied||'';
        $('#leaveFrom').value = l.from; $('#leaveTo').value = l.to;
        $('#leaveDays').value = l.days ?? workingDays(l.from,l.to);
        $('#leaveReason').value = l.reason||'';
        // Jump to tab
        $$('.tab').forEach(b=>b.classList.remove('active'));
        $('[data-tab="leaves"]').classList.add('active');
        $$('.tab-content').forEach(s=>s.classList.remove('active'));
        $('#tab-leaves').classList.add('active');
      }
      if(act==='del'){
        if(confirm('Delete this leave entry?')){
          DB.leaves = DB.leaves.filter(x=>x.id!==id); saveDB(DB);
          await apiDeleteLeave(id);
          await refreshFromServer();
        }
      }
      if(act==='approve' || act==='reject'){
        try{
          console.log('Approve/Reject action triggered:', act);
          const l = DB.leaves.find(x=>x.id===id); if(!l) { console.error('Leave not found:', id); return; }
          const user = getCurrentUser();
          console.log('Current user:', user);
          if(!['MANAGER','HR'].includes(user.role)) { alert('Only Manager/HR can approve or reject.'); return; }
          l.status = (act==='approve') ? 'APPROVED' : 'REJECTED';
          l.approvedBy = user.name||'Manager';
          l.approvedAt = today();
          console.log('Updating leave status to:', l.status);
          saveDB(DB); await apiSaveLeave(l); await refreshFromServer();
          const okMsg = act==='approve' ? 'Leave approved.' : 'Leave rejected.';
          if(typeof showToast === 'function') showToast(okMsg, act==='approve' ? 'success' : 'error');
        }catch(err){
          console.error('Approve/Reject error:', err);
          alert(`Error ${act}ing leave: ${err?.message || 'Unknown error'}`);
        }
      }
    });
    const fe = document.getElementById('filterEmployee'); if(fe) fe.addEventListener('change', renderLeaves);
    const ft = document.getElementById('filterType'); if(ft) ft.addEventListener('change', renderLeaves);
    const fs = document.getElementById('filterStatus'); if(fs) fs.addEventListener('change', renderLeaves);
    const fsearch = document.getElementById('filterSearch'); if(fsearch) fsearch.addEventListener('input', renderLeaves);
  }

  // Report (Card)
  function buildReportCard(){
    // Use global selections by default; fall back to local controls if they exist
    const empSelect = $('#reportEmployee');
    const yearSelect = $('#reportYear');
    const user = getCurrentUser();
    let empId = (empSelect && empSelect.value) || state.selectedEmployee;
    if(!empId){
      if(user?.role === 'EMPLOYEE'){
        const match = (DB.employees||[]).find(e => (e.email||'').toLowerCase() === (user.email||'').toLowerCase());
        empId = match ? match.id : '';
      }else{
        empId = (DB.employees[0]?.id || '');
      }
    }
    const year = (yearSelect && Number(yearSelect.value)) || state.year;
    const container = $('#cardContainer');
    if(!empId){ container.innerHTML = '<p>No employee record mapped to your account. Please contact HR to set up your profile.</p>'; return; }
    const emp = getEmployee(empId); if(!emp){ container.innerHTML = '<p>Employee not found.</p>'; return; }
    const ent = getEntitlement(emp, year);
    const totals = annualTotalsFor(empId, year);

    // Annual leaves list for the year
    const annual = DB.leaves
      .filter(l => l.employeeId===empId && l.type==='ANNUAL')
      .filter(l => workingDaysInYear(l.from,l.to,year) > 0)
      .sort((a,b)=> a.from.localeCompare(b.from));

    let runningBalance = (ent.carry||0)+(ent.current||0);
    const annualRows = annual
      .filter(l => l.status==='APPROVED' || l.status===undefined)
      .map(l =>{
        const daysInYear = daysForLeaveInYear(l, year);
        runningBalance -= daysInYear;
        return `<tr>
          <td>${l.applied||''}</td>
          <td>${l.from}</td>
          <td>${l.to}</td>
          <td>${daysInYear}</td>
          <td>${Math.max(runningBalance,0)}</td>
          <td>${l.reason||''}</td>
        </tr>`;
      }).join('');

    const sl = totalsByType(empId, year, 'SL');
    const hl = totalsByType(empId, year, 'HL');
    const tc = totalsByType(empId, year, 'TC');

    const yos = yearsOfService(emp.dateJoined);
    container.innerHTML = `
    <div class="card">
      <h3>STAFF LEAVE CARD</h3>
      <div class="grid">
        <label>Name<br><strong>${emp.name||''}</strong></label>
        <label>Year<br><strong>${year}</strong></label>
        <label>Job Title / Grade<br><strong>${emp.jobTitle||''}</strong></label>
        <label>Date Joined<br><strong>${emp.dateJoined||''}</strong></label>
        <label>Years of Service<br><strong>${yos}</strong></label>
        <label class="grid-span-2">Department<br><strong>${emp.department||''}</strong></label>
      </div>

      <div class="section-title">Entitlement (01/01/${year} - 31/12/${year})</div>
      <table>
        <tr><th>Approved Accumulated</th><td>${ent.carry||0} working day(s)</td>
            <th>Current Year's Leave</th><td>${ent.current||0} working day(s)</td>
            <th>Total Leave Due</th><td>${(ent.carry||0)+(ent.current||0)} working day(s)</td></tr>
      </table>

      <div class="section-title">Annual Leave</div>
      <table>
        <thead>
          <tr>
            <th>Date of Application</th>
            <th>From</th>
            <th>To</th>
            <th>No. of Days</th>
            <th>Current Balance</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>${annualRows || '<tr><td colspan="6">No annual leave recorded.</td></tr>'}</tbody>
      </table>

      <div class="section-title">Medical Leave</div>
      <table>
        <tr><th>SL - Sick Leave</th><td>${sl} days</td><th>HL - Hospitalisation</th><td>${hl} days</td><th>TC - Time Chit</th><td>${tc} days</td></tr>
      </table>
      <small>Total Annual Entitlement: ${totals.entitlement} • Taken: ${totals.taken} • Balance: ${totals.balance}</small>
    </div>`;
  }

  // Export / Import
  function bindImportExport(){
    $('#exportBtn').addEventListener('click', ()=>{
      const blob = new Blob([JSON.stringify(DB, null, 2)], {type:'application/json'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `leave-data-${state.year}.json`;
      a.click(); URL.revokeObjectURL(a.href);
    });
    $('#importBtn').addEventListener('click', ()=> $('#importInput').click());
    $('#importInput').addEventListener('change', async (e)=>{
      const file = e.target.files?.[0]; if(!file) return;
      const text = await file.text();
      try{ DB = JSON.parse(text); saveDB(DB); renderAll(); alert('Import successful.'); }
      catch(err){ alert('Invalid JSON file.'); }
      e.target.value = '';
    });
  }

  // Print
  function bindPrint(){
    $('#printBtn').addEventListener('click', ()=>{ window.print(); });
    $('#printCardBtn').addEventListener('click', ()=>{
      // Jump to report tab then print
      const repEmp = $('#reportEmployee');
      const repYear = $('#reportYear');
      if(repEmp){ repEmp.value = state.selectedEmployee || $('#leaveEmployee').value || (DB.employees[0]?.id||''); }
      if(repYear){ repYear.value = state.year; }
      buildReportCard();
      $$('.tab').forEach(b=>b.classList.remove('active')); $('[data-tab="reports"]').classList.add('active');
      $$('.tab-content').forEach(s=>s.classList.remove('active')); $('#tab-reports').classList.add('active');
      setTimeout(()=>window.print(), 100);
    });
    const gotoEmp = document.getElementById('gotoEmployeesBtn');
    if(gotoEmp){
      gotoEmp.addEventListener('click', ()=> activateTab('employees'));
    }
    // Inbox interactions
    const inboxBtn = document.getElementById('inboxBtn');
    const panel = document.getElementById('inboxDropdown');
    if(inboxBtn && panel){
      inboxBtn.addEventListener('click', (e)=>{
        e.stopPropagation();
        panel.style.display = (panel.style.display==='none' || panel.style.display==='') ? 'block' : 'none';
      });
      document.addEventListener('click', (e)=>{ if(!panel.contains(e.target) && e.target!==inboxBtn){ panel.style.display='none'; } });
      panel.addEventListener('click', async (e)=>{
        const btn = e.target.closest('button'); if(!btn) return;
        const act = btn.dataset.inboxAct; const id = btn.dataset.id;
        const empAct = btn.dataset.empAct;
        const user = getCurrentUser();
        // Manager actions
        if(act){
          if(!id) return;
          try{
            const l = DB.leaves.find(x=>x.id===id); if(!l) return;
            if(!['MANAGER','HR'].includes(user.role)) return;
            l.status = (act==='approve') ? 'APPROVED' : 'REJECTED';
            l.approvedBy = user.name||'Manager';
            l.approvedAt = today();
            console.log('Inbox: updating leave', id, 'to status', l.status);
            saveDB(DB); await apiSaveLeave(l); await refreshFromServer();
            console.log('Inbox: refresh complete, rendering all views');
            renderAll();
            const okMsg = act==='approve' ? 'Leave approved.' : 'Leave rejected.';
            if(typeof showToast === 'function') showToast(okMsg, act==='approve' ? 'success' : 'error');
          }catch(err){ console.error('Inbox action error:', err); alert('Action failed: ' + (err?.message||'Unknown')); }
          return;
        }
        // Employee actions
        if(empAct){
          const seen = loadEmpInboxSeen();
          if(empAct==='mark-read' && id){
            const l = DB.leaves.find(x=>x.id===id); if(l){ seen[id] = leaveVersion(l); saveEmpInboxSeen(seen); }
            updateInbox();
            return;
          }
          if(empAct==='mark-all-read'){
            (DB.leaves||[]).forEach(l=>{ if(l.status==='APPROVED' || l.status==='REJECTED') seen[l.id] = leaveVersion(l); });
            saveEmpInboxSeen(seen);
            updateInbox();
            return;
          }
        }
      });
    }
  }

  // Calendar
  let calendarState = { year: new Date().getFullYear(), month: new Date().getMonth() };

  function renderCalendar() {
    const calContainer = $('#calendarContainer');
    if (!calContainer) return; // Element doesn't exist yet
    
    const year = calendarState.year;
    const month = calendarState.month;
    const today = new Date();
    const isToday = (d) => d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    
    // Get first day of month and number of days
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();
    const startingDayOfWeek = firstDay.getDay();
    
    // Update header
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const headerEl = $('#calCurrentMonth');
    if (headerEl) headerEl.textContent = `${monthNames[month]} ${year}`;
    
    // Filter by selected employee
    const selectedEmpId = $('#calEmployeeFilter')?.value;
    let filteredLeaves = DB.leaves || [];
    if (selectedEmpId) {
      filteredLeaves = filteredLeaves.filter(l => l.employeeId === selectedEmpId);
    }
    
    // Build calendar table
    let html = '<table class="calendar"><thead><tr>';
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    dayNames.forEach(d => html += `<th>${d}</th>`);
    html += '</tr></thead><tbody><tr>';
    
    // Empty cells for days before month starts
    for (let i = 0; i < startingDayOfWeek; i++) {
      html += '<td class="other-month"></td>';
    }
    
    // Days of the month
    for (let day = 1; day <= daysInMonth; day++) {
      const cellDate = new Date(year, month, day);
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`; // YYYY-MM-DD without timezone conversion
      const isTodayCell = isToday(cellDate);
      
      // Check if this day is a holiday
      const holidayOnDay = (DB.holidays || []).find(h => (typeof h === 'string' ? h : h.date) === dateStr);
      const holidayName = holidayOnDay ? (typeof holidayOnDay === 'string' ? '' : holidayOnDay.name) : '';
      
      // Get leaves for this day
      const leavesOnDay = filteredLeaves.filter(l => {
        if (!l.from || !l.to) return false;
        if (l.status !== 'APPROVED' && l.status !== undefined) return false; // Only show approved
        return dateStr >= l.from && dateStr <= l.to;
      });
      
      // Group leaves by employee
      const leavesByEmp = {};
      leavesOnDay.forEach(l => {
        if (!leavesByEmp[l.employeeId]) leavesByEmp[l.employeeId] = [];
        leavesByEmp[l.employeeId].push(l);
      });
      
      const dayClass = isTodayCell ? 'today' : (holidayOnDay ? 'holiday' : '');
      html += `<td class="${dayClass}">
        <div class="cal-day-number">${day}</div>
        <div class="cal-leaves">`;
      
      // Display holiday if exists
      if (holidayOnDay) {
        const displayName = holidayName && holidayName.trim() ? holidayName : 'Holiday';
        html += `<div class="cal-holiday" title="${displayName}">🏖 ${displayName}</div>`;
      }
      
      Object.entries(leavesByEmp).forEach(([empId, leaves]) => {
        const emp = DB.employees?.find(e => e.id === empId);
        leaves.forEach(l => {
          const status = l.status || 'PENDING';
          html += `<div class="cal-leave-item ${l.type} ${status}" title="${emp?.name} - ${l.type} (${status})">${emp?.name}</div>`;
        });
      });
      
      html += '</div></td>';
      
      // New row every 7 days
      if ((day + startingDayOfWeek) % 7 === 0 && day < daysInMonth) {
        html += '</tr><tr>';
      }
    }
    
    // Fill remaining cells
    const totalCells = startingDayOfWeek + daysInMonth;
    const remainingCells = (7 - (totalCells % 7)) % 7;
    for (let i = 0; i < remainingCells; i++) {
      html += '<td class="other-month"></td>';
    }
    
    html += '</tr></tbody></table>';
    calContainer.innerHTML = html;

    // Equalize all day cell heights to the tallest cell for this month
    requestAnimationFrame(() => equalizeCalendarHeights());
  }

  // Make all calendar day cells the same height based on the tallest cell
  function equalizeCalendarHeights(){
    try{
      const cells = $$('#calendarContainer .calendar tbody td');
      if(!cells.length) return;
      // Reset to natural height to re-measure
      cells.forEach(c => c.style.height = 'auto');
      let maxH = 0;
      cells.forEach(c => { const h = c.offsetHeight; if(h > maxH) maxH = h; });
      cells.forEach(c => c.style.height = maxH + 'px');
    }catch(e){ /* non-critical */ }
  }

  function updateCalendarEmployeeFilter() {
    try {
      const select = $('#calEmployeeFilter');
      if (!select) return;
      const currentVal = select.value;
      select.innerHTML = '<option value="">All Employees</option>';
      if (Array.isArray(DB.employees)) {
        DB.employees.forEach(e => {
          select.innerHTML += `<option value="${e.id}">${e.name}</option>`;
        });
      }
      select.value = currentVal;
    } catch (e) {
      console.warn('updateCalendarEmployeeFilter error:', e);
    }
  }

  function bindCalendar() {
    try {
      if (!$('#calendarContainer')) return; // Calendar section doesn't exist
      
      updateCalendarEmployeeFilter();
      renderCalendar();
      // Re-equalize heights on resize as wrapping may change cell heights
      window.addEventListener('resize', () => requestAnimationFrame(() => equalizeCalendarHeights()));
      
      const prevBtn = $('#calPrevMonth');
      const nextBtn = $('#calNextMonth');
      const filterSelect = $('#calEmployeeFilter');
      
      if (prevBtn) {
        prevBtn.addEventListener('click', () => {
          calendarState.month--;
          if (calendarState.month < 0) {
            calendarState.month = 11;
            calendarState.year--;
          }
          renderCalendar();
        });
      }
      
      if (nextBtn) {
        nextBtn.addEventListener('click', () => {
          calendarState.month++;
          if (calendarState.month > 11) {
            calendarState.month = 0;
            calendarState.year++;
          }
          renderCalendar();
        });
      }
      
      if (filterSelect) {
        filterSelect.addEventListener('change', renderCalendar);
      }
    } catch (e) {
      console.warn('bindCalendar error:', e);
    }
  }

  // Year controls
  function bindYear(){
    const y = $('#yearInput');
    if(y){
      y.value = state.year;
      y.addEventListener('change', ()=>{
        state.year = Number(y.value)||new Date().getFullYear();
        updateYearTabs();
        const r = $('#reportYear'); if(r) r.value = state.year;
        const eey = $('#empEntYear'); if(eey) eey.value = state.year;
        renderEmployees(); renderLeaves(); buildReportCard(); renderReportLeaves();
      });
    }
    const r = $('#reportYear'); if(r){ r.value = state.year; r.addEventListener('change', ()=> { buildReportCard(); renderReportLeaves(); }); }
    const re = $('#reportEmployee'); if(re){ re.addEventListener('change', ()=> { buildReportCard(); renderReportLeaves(); }); }
    const rr = $('#refreshReport'); if(rr){ rr.addEventListener('click', ()=> { buildReportCard(); renderReportLeaves(); }); }
    
    // Year tabs
    $$('.year-tab').forEach(tab=>{
      tab.addEventListener('click', ()=>{
        state.year = Number(tab.dataset.year);
        y.value = state.year;
        updateYearTabs();
        const r = $('#reportYear'); if(r) r.value = state.year;
        const eey = $('#empEntYear'); if(eey) eey.value = state.year;
        renderEmployees(); renderLeaves(); buildReportCard(); renderReportLeaves();
      });
    });
    updateYearTabs();
  }
  function updateYearTabs(){
    $$('.year-tab').forEach(tab=>{
      if(Number(tab.dataset.year)===state.year){
        tab.classList.add('active');
      }else{
        tab.classList.remove('active');
      }
    });
  }

  // User & holidays
  function getCurrentUser(){
    try{ return JSON.parse(localStorage.getItem('leaveManager.user')||'{}'); }catch{ return {}; }
  }
  function setCurrentUser(user){ localStorage.setItem('leaveManager.user', JSON.stringify(user)); }
  async function fetchServerUser(){
    try{
      const r = await fetch('/api/auth-me');
      if(!r.ok) return null; const j = await r.json(); if(!j.ok) return null; return j.user;
    }catch{return null}
  }
  async function bindAuthUI(){
    try{
      const serverUser = await fetchServerUser();
      if(!serverUser || !serverUser.email){ 
        // Not authenticated, redirect to login page
        window.location.href = '/login.html';
        return;
      }
      
      // User is authenticated, display user info
      setCurrentUser(serverUser);
      const userInfo = document.getElementById('userInfo');
      if(userInfo){
        userInfo.innerHTML = `<span class="user">${serverUser.name||serverUser.email} • ${serverUser.role}</span>`;
      }
      // Restrict UI for EMPLOYEE role
      if(serverUser.role === 'EMPLOYEE'){
        // Hide Settings tab entirely
        const tabBtn = document.querySelector('.tab[data-tab="settings"]');
        const tabSection = document.getElementById('tab-settings');
        if(tabBtn) tabBtn.style.display = 'none';
        if(tabSection) tabSection.style.display = 'none';
        // Hide Employees tab/button and section
        const empTabBtn = document.querySelector('.tab[data-tab="employees"]');
        const empSection = document.getElementById('tab-employees');
        if(empTabBtn) empTabBtn.style.display = 'none';
        if(empSection) empSection.style.display = 'none';
        // Hide Employees quick link in header
        const gotoEmp = document.getElementById('gotoEmployeesBtn'); if(gotoEmp) gotoEmp.style.display='none';
        // Hide employee tabs nav bar
        const empTabsNav = document.getElementById('employeeTabsNav'); if(empTabsNav) empTabsNav.style.display='none';
      }
      
      // Setup logout button
      const logoutBtn = document.getElementById('logoutBtn');
      if(logoutBtn){
        logoutBtn.onclick = async ()=>{ 
          await fetch('/api/auth-logout'); 
          // Clear per-user UI state so the next login doesn't inherit selected employee
          try{ localStorage.removeItem(STATE_KEY); }catch{}
          setCurrentUser({}); 
          window.location.href = '/login.html'; 
        };
      }
    }catch(e){
      console.error('bindAuthUI error:', e);
      // Redirect to login on error
      window.location.href = '/login.html';
    }
  }
  function bindUser(){
    const user = getCurrentUser();
    $('#currentUserName').value = user.name||'';
    $('#currentUserRole').value = user.role||'EMPLOYEE';
    $('#userForm').addEventListener('submit', (e)=>{
      e.preventDefault();
      setCurrentUser({ name: $('#currentUserName').value.trim(), role: $('#currentUserRole').value });
      alert('User saved.');
    });
  }
  
  function bindMaintenanceButtons(){
    const resetBtn = $('#resetCarryForwardBtn');
    if(resetBtn){
      // Disabled: carry-forward changes should only occur via manual entitlement edits
      resetBtn.disabled = true;
      resetBtn.title = 'Disabled: carry-forward changes only via entitlement edits';
      resetBtn.style.display = 'none';
      return;
    }
  }

  // Audit trail functions
  async function getAuditLogs(limit = 100, offset = 0) {
    try {
      const res = await fetch(`/api/audit-log?limit=${limit}&offset=${offset}`);
      if (!res.ok) throw new Error('Failed to load audit logs');
      const data = await res.json();
      return data.logs || [];
    } catch (e) {
      console.error('getAuditLogs error:', e);
      return [];
    }
  }

  async function renderAuditLogs() {
    try {
      const logs = await getAuditLogs(200, 0);
      const actionFilter = $('#auditActionFilter')?.value || '';
      const entityFilter = $('#auditEntityFilter')?.value || '';
      
      let filtered = logs;
      if (actionFilter) {
        filtered = filtered.filter(l => l.action === actionFilter);
      }
      if (entityFilter) {
        filtered = filtered.filter(l => l.entityType === entityFilter);
      }
      
      const tbody = $('#auditLogsTable tbody');
      if (!tbody) return;
      
      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5">No audit logs found.</td></tr>';
        return;
      }
      
      tbody.innerHTML = filtered.map(log => {
        const timestamp = new Date(log.timestamp).toLocaleString();
        const userDisplay = log.userEmail || log.userId || 'System';
        const details = log.details || '';
        const entityDisplay = `${log.entityType}: ${log.entityName || log.entityId}`;
        return `<tr>
          <td style="font-size: 0.9em;">${timestamp}</td>
          <td>${userDisplay}</td>
          <td><strong>${log.action}</strong></td>
          <td>${entityDisplay}</td>
          <td>${details}</td>
        </tr>`;
      }).join('');
    } catch (e) {
      console.error('renderAuditLogs error:', e);
      alert('Failed to load audit trail');
    }
  }

  function bindAuditTrail() {
    const loadBtn = $('#loadAuditLogsBtn');
    const actionFilter = $('#auditActionFilter');
    const entityFilter = $('#auditEntityFilter');
    
    if (loadBtn) {
      loadBtn.addEventListener('click', renderAuditLogs);
    }
    if (actionFilter) {
      actionFilter.addEventListener('change', renderAuditLogs);
    }
    if (entityFilter) {
      entityFilter.addEventListener('change', renderAuditLogs);
    }
  }

  // User management
  async function renderUsers(){
    try{
      const users = await apiGetUsers();
      const tbody = $('#usersTable tbody');
      tbody.innerHTML = users.map(u=>`<tr>
        <td>${u.email}</td>
        <td>${u.name||''}</td>
        <td>
          <select class="user-role" data-id="${u.id}" data-email="${u.email}">
            <option value="EMPLOYEE" ${u.role==='EMPLOYEE'?'selected':''}>Employee</option>
            <option value="MANAGER" ${u.role==='MANAGER'?'selected':''}>Manager</option>
            <option value="HR" ${u.role==='HR'?'selected':''}>HR</option>
          </select>
        </td>
        <td><button class="danger" data-id="${u.id}" data-act="del-user">Remove</button></td>
      </tr>`).join('') || '<tr><td colspan="4">No users. Add one to get started.</td></tr>';
    }catch(e){ console.error('renderUsers error:', e); alert('Failed to load users'); }
  }
  
  function bindUsers(){
    // Users are now managed with employees - this function is kept empty for compatibility
    // User management is integrated into bindEmployeeForm
  }
  
  function renderHolidays(){
    $('#holYear').value = state.year;
    const tbody = $('#holidaysTable tbody');
    const items = (DB.holidays||[]).map(h => (typeof h === 'string' ? { date: h, name: '' } : { date: h.date, name: h.name||'' }));
    items.sort((a,b)=> (a.date||'').localeCompare(b.date||''));
    tbody.innerHTML = items.map(h=>`<tr><td>${h.date}</td><td>${h.name||''}</td><td><button class="danger" data-date="${h.date}" data-act="del-hol">Remove</button></td></tr>`).join('') || '<tr><td colspan="3">No holidays configured.</td></tr>';
  }
  function bindHolidays(){
    $('#holYear').addEventListener('change', ()=>{ state.year = Number($('#holYear').value)||state.year; const yi=$('#yearInput'); if(yi) yi.value=state.year; renderHolidays(); renderLeaves(); renderEmployees(); buildReportCard(); renderCalendar(); });
    $('#holAddBtn').addEventListener('click', ()=>{
      const d = $('#holAddDate').value; if(!d) return;
      const name = ($('#holAddName').value || '').trim();
      const exists = (DB.holidays||[]).some(x => (typeof x==='string'? x : x.date) === d);
      if(!exists) DB.holidays.push({ date:d, name });
      saveDB(DB); 
      $('#holAddDate').value = ''; 
      $('#holAddName').value = ''; 
      renderHolidays();
      renderCalendar();
      apiSetHolidays(DB.holidays).then(refreshFromServer);
    });
    const holClear = document.getElementById('holClearBtn');
    if(holClear){
      holClear.addEventListener('click', async ()=>{
        if(!confirm('Remove ALL public holidays from the system? This affects all years.')) return;
        try{
          DB.holidays = [];
          saveDB(DB);
          await apiSetHolidays([]);
          await refreshFromServer();
          renderHolidays();
          renderCalendar();
          buildReportCard();
          alert('All holidays cleared.');
        }catch(e){
          console.error('Clear holidays error:', e);
          alert('Failed to clear on server: ' + (e?.message||'unknown'));
        }
      });
    }
    $('#holidaysTable').addEventListener('click', (e)=>{
      const btn = e.target.closest('button'); if(!btn) return;
      if(btn.dataset.act==='del-hol'){
        const d = btn.dataset.date;
        DB.holidays = (DB.holidays||[]).filter(x=> (typeof x==='string'? x : x.date) !== d);
        saveDB(DB);
        renderHolidays();
        renderCalendar();
        apiSetHolidays(DB.holidays).then(refreshFromServer);
      }
    });
  }

  // Sync UI (uses DB now)
  function bindCloudSync(){
    const loadBtn = document.getElementById('cloudLoadBtn'); if(loadBtn) loadBtn.style.display = 'none';
    const idInput = document.getElementById('cloudDocId'); if(idInput) idInput.style.display = 'none';
    const syncBtn = document.getElementById('cloudSaveBtn');
    if(syncBtn){ syncBtn.textContent = 'Sync'; syncBtn.addEventListener('click', ()=> scheduleDebouncedSync('manual')); }

    // auto sync cycle + online/visibility awareness
    startAutoSync();
    window.addEventListener('online', ()=> scheduleDebouncedSync('online'));
    document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) scheduleDebouncedSync('tab-focus'); });
    window.addEventListener('storage', (e)=>{
      if(e.key===STORE_KEY) {
        // Preserve scroll positions during re-render triggered by storage event
        const prevCal = document.getElementById('calendarContainer');
        const calScrollLeft = prevCal ? prevCal.scrollLeft : 0;
        const calScrollTop  = prevCal ? prevCal.scrollTop  : 0;
        const winX = window.scrollX || 0;
        const winY = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;

        DB = loadDB();
        renderAll();

        requestAnimationFrame(()=>{
          const newCal = document.getElementById('calendarContainer');
          if (newCal) {
            newCal.scrollLeft = calScrollLeft;
            newCal.scrollTop  = calScrollTop;
          }
          window.scrollTo(winX, winY);
        });

        scheduleDebouncedSync('storage');
      }
    });
  }

  function renderAll(){
    renderEmployeeTabs();
    renderEmployeeOptions();
    renderEmployees();
    renderLeaves();
    buildReportCard();
    renderReportLeaves();
    updateInbox();
    try{
      updateCalendarEmployeeFilter();
      renderCalendar();
    }catch(e){
      console.warn('Calendar render failed (non-critical):', e);
    }
  }

  async function init(){
    bindTabs();
    bindYearTabs();
    bindYear();
    bindEmployeeForm();
    bindLeaveForm();
    bindLeavesTable();
    bindImportExport();
    bindPrint();
    bindUser();
    bindHolidays();
    bindReportLeaves();
    bindMaintenanceButtons();
    bindAuditTrail();
    try{
      bindCalendar();
    }catch(e){
      console.warn('Calendar binding failed (non-critical):', e);
    }
    await bindAuthUI();
    bindUsers();  // Must be after bindAuthUI so user role is loaded
    // Preload users cache (for MANAGER/HR) to resolve who applied leaves
    await ensureUsersCache();
    
    // Sync fresh data from server before calculating carry-forward
    try{
      await refreshFromServer();
      // After loading fresh data, align selection to the current user
      ensureSelectedEmployeeForCurrentUser();
      // Refresh users cache after data load as well
      await ensureUsersCache();
    }catch(e){
      console.error('Initial sync failed:', e);
    }
    
    renderAll();
    renderHolidays();
    
    // Update UI to reflect saved state (year and employee selection)
    updateYearTabsNav();
    const yi = $('#yearInput'); if(yi) yi.value = state.year;
    const reportYear = $('#reportYear'); if(reportYear) reportYear.value = state.year;
    
    // Now bind cloud sync AFTER data is loaded
    bindCloudSync();
    initRealtime();
    
    // Removed automatic carry-forward on app load.
    // Carry-forward should only change when explicitly edited by a user.
  }

  // Kickoff
  document.addEventListener('DOMContentLoaded', init);
})();
