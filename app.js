(function(){
  'use strict';
  // Helpers
  const $ = (sel, el=document) => el.querySelector(sel);
  const $$ = (sel, el=document) => Array.from(el.querySelectorAll(sel));
  const fmt = (d) => d ? new Date(d).toISOString().slice(0,10) : '';
  const pad = (n) => String(n).padStart(2,'0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const today = () => ymd(new Date());

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
  let state = { year: new Date().getFullYear(), autoCarryDone: false, selectedEmployee: null };

  // Database API helpers
  async function apiGetAll(){
    const r = await fetch('/api/data');
    if(!r.ok) throw new Error('Load failed');
    return r.json();
  }
  async function apiSaveEmployee(emp, ent){
    const r = await fetch('/api/employee', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ id:emp.id, name:emp.name, email:emp.email, role:emp.role, jobTitle:emp.jobTitle, department:emp.department, dateJoined:emp.dateJoined, entitlement: ent ? {year: state.year, ...ent} : undefined }) });
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
  async function apiSetHolidays(dates){ const r = await fetch('/api/holidays-set', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ dates }) }); if(!r.ok) throw new Error('Holidays set failed'); }
  
  // User management API helpers
  async function apiGetUsers(){ const r = await fetch('/api/users-list'); if(!r.ok) throw new Error('Load users failed'); const j = await r.json(); return j.users || []; }
  async function apiCreateUser(email, name, role){ const r = await fetch('/api/users-create', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ email, name, role }) }); if(!r.ok){ const j = await r.json(); throw new Error(j.error || 'Create user failed'); } return (await r.json()).user; }
  async function apiDeleteUser(id){ const r = await fetch(`/api/users-delete?id=${encodeURIComponent(id)}`, { method:'DELETE' }); if(!r.ok){ const j = await r.json(); throw new Error(j.error || 'Delete user failed'); } }
  async function apiUpdateUserRole(id, role){ const r = await fetch('/api/users-update', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ id, role }) }); if(!r.ok){ const j = await r.json(); throw new Error(j.error || 'Update user failed'); } return (await r.json()).user; }

  async function refreshFromServer(){
    const data = await apiGetAll();
    DB = { meta:{updatedAt:Date.now()}, ...data };
    saveDB(DB);
    renderAll();
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
      channel.bind('changed', async () => { await refreshFromServer(); });
    }catch(e){ /* ignore */ }
  }
  function setStatus(msg){ const el = document.getElementById('cloudStatus'); if(el) el.textContent = msg||''; }

  // Business days calculation (Mon-Fri excluding holidays)
  function isWeekend(date){ const day = date.getDay(); return day===0 || day===6; }
  function isHoliday(date, holidays){ const s = ymd(date); return holidays.includes(s); }
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
      .reduce((sum,l)=> sum + workingDaysInYear(l.from,l.to,year), 0);
    const ent = getEntitlement(getEmployee(empId), year);
    const entitlement = (ent.carry||0)+(ent.current||0);
    const balance = entitlement - totalDays;
    return { entitlement, taken: totalDays, balance };
  }
  function totalsByType(empId, year, type){
    return DB.leaves
      .filter(l => l.employeeId===empId && l.type===type && (l.status==='APPROVED' || l.status===undefined))
      .reduce((sum,l)=> sum + workingDaysInYear(l.from,l.to,year), 0);
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
          const ent = getEntitlement(emp, toYear);
          const currentCarry = ent.carry||0;
          
          // Check if carry from this specific year has already been applied
          // by comparing if current carry matches what it should be (just the balance from this year)
          const expectedCarry = balance; // Only the carry from this year pair, not accumulated
          
          console.log(`${emp.name}: Year ${toYear} - Before: carry=${currentCarry}, current=${ent.current||0}. Expected carry from ${fromYear}: ${expectedCarry}`);
          
          // Only set if it's not already correctly set (avoid duplicates)
          if(currentCarry !== expectedCarry){
            // If current carry is 0 or less than expected, set it to expected
            // This handles the case where it hasn't been carried yet
            if(currentCarry < expectedCarry){
              setEntitlement(emp, toYear, expectedCarry, ent.current||0);
              changes = true;
              console.log(`${emp.name}: ✓ Set carry to ${expectedCarry}`);
            }else{
              console.log(`${emp.name}: ⊘ Carry already applied (${currentCarry} >= ${expectedCarry})`);
            }
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
    const html = DB.employees
      .map(e => `<button class="employee-tab-nav ${state.selectedEmployee === e.id ? 'active' : ''}" data-emp-id="${e.id}">${e.name}</button>`)
      .join('');
    nav.innerHTML = html;
    
    // Bind click handlers
    $$('.employee-tab-nav').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        state.selectedEmployee = btn.dataset.empId;
        renderEmployeeTabs(); // Update active state
        renderEmployees(); // Show this employee's data
        renderLeaves(); // Show this employee's leaves
        buildReportCard(); // Update report
      });
    });
    
    // Auto-select first employee if none selected
    if(!state.selectedEmployee && DB.employees.length > 0){
      state.selectedEmployee = DB.employees[0].id;
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

  // Year tabs
  function bindYearTabs(){
    $$('.year-tab-nav').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const year = Number(btn.dataset.year);
        state.year = year;
        $('#yearInput').value = year;
        
        // Update year tab active state
        $$('.year-tab-nav').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        
        // Update year selector buttons
        updateYearTabs();
        
        // Re-render all content with new year
        $('#reportYear').value = year;
        $('#empEntYear').value = year;
        renderEmployees();
        renderLeaves();
        buildReportCard();
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
    
    // If an employee is selected, show only that employee
    const employees = state.selectedEmployee 
      ? DB.employees.filter(e => e.id === state.selectedEmployee)
      : DB.employees;
    const rows = employees
      .filter(e => `${e.name} ${e.jobTitle||''} ${e.department||''} ${e.email||''}`.toLowerCase().includes(q))
      .map(emp =>{
        const totals = annualTotalsFor(emp.id, state.year);
        const tr = document.createElement('tr');
        const carryFwdBtn = getCarryForwardBalance(emp.id, state.year) > 0 ? `<button class="ghost" data-act="carry" data-id="${emp.id}" title="Carry forward ${getCarryForwardBalance(emp.id, state.year)} days to ${state.year+1}">Carry Fwd</button>` : '';
        tr.innerHTML = `
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
        
        // Save employee
        await apiSaveEmployee(emp, { carry, current });
        
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
    const opts = DB.employees.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
    ['leaveEmployee','filterEmployee','reportEmployee'].forEach(id=>{
      const el = $('#'+id); if(!el) return;
      const previous = el.value; // remember current selection
      const keep = id==='filterEmployee';
      el.innerHTML = keep ? `<option value="">All Employees</option>${opts}` : opts;
      // Restore previous selection if still available; otherwise use sensible default
      const hasPrev = previous==='' || DB.employees.some(e=>e.id===previous);
      if(hasPrev) {
        el.value = previous;
      } else if(keep) {
        el.value = '';
      } else if(DB.employees.length){
        el.value = DB.employees[0].id;
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
    $('#leaveFrom').addEventListener('change', recomputeLeaveDays);
    $('#leaveTo').addEventListener('change', recomputeLeaveDays);
    $('#leaveType').addEventListener('change', recomputeLeaveDays);

    $('#leaveForm').addEventListener('submit', async (e)=>{
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
        $('#leaveForm').reset(); $('#leaveId').value='';
        alert('Leave submitted.');
      }catch(err){
        console.error('Leave submit error:', err);
        alert('Error submitting leave: ' + (err?.message || 'Unknown error'));
      }finally{
        if(submitBtn){ submitBtn.disabled = false; submitBtn.textContent = origText || 'Submit Leave'; }
      }
    });

    $('#leaveCancelBtn').addEventListener('click', ()=>{
      $('#leaveForm').reset(); $('#leaveId').value='';
    });
  }
  function renderLeaves(){
    const tbody = $('#leavesTable tbody');
    const empFilter = $('#filterEmployee').value || '';
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
        tr.innerHTML = `
          <td>${emp.name}</td>
          <td>${l.type}</td>
          <td>${l.status||'PENDING'}</td>
          <td>${l.applied||''}</td>
          <td>${l.from}</td>
          <td>${l.to}</td>
          <td>${l.days ?? workingDays(l.from,l.to)}</td>
          <td>${l.reason||''}</td>
          <td class="actions">
            <button class="ghost" data-act="edit" data-id="${l.id}">Edit</button>
            <button class="danger" data-act="del" data-id="${l.id}">Delete</button>
            <button class="ghost" data-act="approve" data-id="${l.id}">Approve</button>
            <button class="ghost" data-act="reject" data-id="${l.id}">Reject</button>
          </td>`;
        return tr;
      });
    tbody.innerHTML=''; rows.forEach(r=>tbody.appendChild(r));
  }
  function bindLeavesTable(){
    $('#leavesTable').addEventListener('click', async (e)=>{
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
          alert(`Leave ${act}ed successfully.`);
        }catch(err){
          console.error('Approve/Reject error:', err);
          alert(`Error ${act}ing leave: ${err?.message || 'Unknown error'}`);
        }
      }
    });
    $('#filterEmployee').addEventListener('change', renderLeaves);
    $('#filterType').addEventListener('change', renderLeaves);
    $('#filterStatus').addEventListener('change', renderLeaves);
    $('#filterSearch').addEventListener('input', renderLeaves);
  }

  // Report (Card)
  function buildReportCard(){
    const empId = $('#reportEmployee').value; const year = Number($('#reportYear').value)||state.year;
    const container = $('#cardContainer');
    if(!empId){ container.innerHTML = '<p>Select an employee to view the leave card.</p>'; return; }
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
        const daysInYear = workingDaysInYear(l.from,l.to,year);
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

    container.innerHTML = `
    <div class="card">
      <h3>STAFF LEAVE CARD</h3>
      <div class="grid">
        <label>Name<br><strong>${emp.name||''}</strong></label>
        <label>Year<br><strong>${year}</strong></label>
        <label>Job Title / Grade<br><strong>${emp.jobTitle||''}</strong></label>
        <label>Date Joined<br><strong>${emp.dateJoined||''}</strong></label>
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
      $('#reportEmployee').value = $('#leaveEmployee').value || (DB.employees[0]?.id||'');
      $('#reportYear').value = state.year;
      buildReportCard();
      $$('.tab').forEach(b=>b.classList.remove('active')); $('[data-tab="reports"]').classList.add('active');
      $$('.tab-content').forEach(s=>s.classList.remove('active')); $('#tab-reports').classList.add('active');
      setTimeout(()=>window.print(), 100);
    });
  }

  // Year controls
  function bindYear(){
    const y = $('#yearInput');
    y.value = state.year;
    y.addEventListener('change', ()=>{
      state.year = Number(y.value)||new Date().getFullYear();
      updateYearTabs();
      $('#reportYear').value = state.year;
      $('#empEntYear').value = state.year;
      renderEmployees(); renderLeaves(); buildReportCard();
    });
    $('#reportYear').value = state.year;
    $('#reportYear').addEventListener('change', ()=> buildReportCard());
    $('#reportEmployee').addEventListener('change', ()=> buildReportCard());
    $('#refreshReport').addEventListener('click', ()=> buildReportCard());
    
    // Year tabs
    $$('.year-tab').forEach(tab=>{
      tab.addEventListener('click', ()=>{
        state.year = Number(tab.dataset.year);
        y.value = state.year;
        updateYearTabs();
        $('#reportYear').value = state.year;
        $('#empEntYear').value = state.year;
        renderEmployees(); renderLeaves(); buildReportCard();
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
      
      // Setup logout button
      const logoutBtn = document.getElementById('logoutBtn');
      if(logoutBtn){
        logoutBtn.onclick = async ()=>{ 
          await fetch('/api/auth-logout'); 
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
      resetBtn.addEventListener('click', async ()=>{
        if(confirm('This will reset all carry-forward values to correct amounts (max 5 days per year). Continue?')){
          await resetCarryForward();
        }
      });
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
    const items = (DB.holidays||[]).map(d=>({ date:d, name:'' }));
    tbody.innerHTML = items.map(h=>`<tr><td>${h.date}</td><td>${h.name||''}</td><td><button class="danger" data-date="${h.date}" data-act="del-hol">Remove</button></td></tr>`).join('') || '<tr><td colspan="3">No holidays configured.</td></tr>';
  }
  function bindHolidays(){
    $('#holYear').addEventListener('change', ()=>{ state.year = Number($('#holYear').value)||state.year; $('#yearInput').value=state.year; renderHolidays(); renderLeaves(); renderEmployees(); buildReportCard(); });
    $('#holAddBtn').addEventListener('click', ()=>{
      const d = $('#holAddDate').value; if(!d) return;
      if(!DB.holidays.includes(d)) DB.holidays.push(d);
      saveDB(DB); apiSetHolidays(DB.holidays).then(refreshFromServer);
    });
    $('#fetchHolidays').addEventListener('click', async ()=>{
      const year = Number($('#holYear').value)||state.year; const cc = ($('#holCountry').value||'').toUpperCase();
      if(!cc){ alert('Enter 2-letter country code, e.g., SG'); return; }
      try{
        const r = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${cc}`);
        if(!r.ok) throw new Error('Failed');
        const list = await r.json();
        const dates = list.map(x=>x.date); // ISO YYYY-MM-DD
        const set = new Set(DB.holidays||[]);
        dates.forEach(d=>set.add(d));
        DB.holidays = Array.from(set).sort();
        saveDB(DB); await apiSetHolidays(DB.holidays); await refreshFromServer();
      }catch(err){ alert('Could not fetch holidays. Check the country code or try later.'); }
    });
    $('#holidaysTable').addEventListener('click', (e)=>{
      const btn = e.target.closest('button'); if(!btn) return;
      if(btn.dataset.act==='del-hol'){
        const d = btn.dataset.date; DB.holidays = (DB.holidays||[]).filter(x=>x!==d); saveDB(DB); apiSetHolidays(DB.holidays).then(refreshFromServer);
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
    window.addEventListener('storage', (e)=>{ if(e.key===STORE_KEY) { DB = loadDB(); renderAll(); scheduleDebouncedSync('storage'); } });
  }

  function renderAll(){
    renderEmployeeTabs();
    renderEmployeeOptions();
    renderEmployees();
    renderLeaves();
    buildReportCard();
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
    bindMaintenanceButtons();
    bindAuditTrail();
    await bindAuthUI();
    bindUsers();  // Must be after bindAuthUI so user role is loaded
    
    // Sync fresh data from server before calculating carry-forward
    try{
      await refreshFromServer();
    }catch(e){
      console.error('Initial sync failed:', e);
    }
    
    renderAll();
    renderHolidays();
    
    // Now bind cloud sync AFTER data is loaded
    bindCloudSync();
    initRealtime();
    
    // Auto-carry forward on app load if we're viewing 2024 or later
    // This must run AFTER refreshFromServer so we have latest leave data
    if(state.year >= 2024){
      await autoCarryForward();
      renderEmployees(); // Re-render to show updated carry-forward values
    }
  }

  // Kickoff
  document.addEventListener('DOMContentLoaded', init);
})();
