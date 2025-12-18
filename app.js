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
  let state = { year: new Date().getFullYear() };

  // Cloud sync helpers (Vercel Blob via API routes)
  async function cloudSave(docId, data){
    const res = await fetch(`/api/save?id=${encodeURIComponent(docId)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data)
    });
    if(!res.ok) throw new Error('Cloud save failed');
    return res.json();
  }
  async function cloudLoad(docId){
    const res = await fetch(`/api/load?id=${encodeURIComponent(docId)}`);
    if(!res.ok) throw new Error('Cloud load failed');
    return res.json();
  }
  async function cloudSync(docId){
    // If remote exists and is newer, replace local; else upload local
    try{
      const remote = await cloudLoad(docId);
      const rAt = remote?.meta?.updatedAt || 0;
      const lAt = DB?.meta?.updatedAt || 0;
      if(rAt > lAt){ DB = remote; saveDB(DB); renderAll(); return { action:'pulled' }; }
      await cloudSave(docId, DB); return { action:'pushed' };
    }catch(err){
      // If not found, push local
      await cloudSave(docId, DB); return { action:'created' };
    }
  }

  // Auto sync helpers
  const getDocId = () => (localStorage.getItem(DOC_ID_KEY) || document.getElementById('cloudDocId')?.value || 'default').trim() || 'default';
  const setDocId = (id) => { localStorage.setItem(DOC_ID_KEY, id); const el = document.getElementById('cloudDocId'); if(el) el.value = id; };
  let autoTimer = null, debounceTimer = null;
  function scheduleDebouncedSync(){
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async ()=>{
      try{ setStatus('Syncing...'); const res = await cloudSync(getDocId()); setStatus(`Synced (${res.action}).`); }
      catch(e){ console.error(e); setStatus('Sync error'); }
    }, 1200);
  }
  function startAutoSync(){
    clearInterval(autoTimer);
    // immediate sync on start
    scheduleDebouncedSync('start');
    autoTimer = setInterval(()=> scheduleDebouncedSync('interval'), 60_000);
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
      .filter(l => l.employeeId===empId && l.type==='ANNUAL')
      .reduce((sum,l)=> sum + workingDaysInYear(l.from,l.to,year), 0);
    const ent = getEntitlement(getEmployee(empId), year);
    const entitlement = (ent.carry||0)+(ent.current||0);
    const balance = entitlement - totalDays;
    return { entitlement, taken: totalDays, balance };
  }
  function totalsByType(empId, year, type){
    return DB.leaves
      .filter(l => l.employeeId===empId && l.type===type)
      .reduce((sum,l)=> sum + workingDaysInYear(l.from,l.to,year), 0);
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

  // Employees UI
  function renderEmployees(){
    const tbody = $('#employeesTable tbody');
    const q = ($('#employeeSearch').value||'').toLowerCase();
    const rows = DB.employees
      .filter(e => `${e.name} ${e.jobTitle||''} ${e.department||''}`.toLowerCase().includes(q))
      .map(emp =>{
        const totals = annualTotalsFor(emp.id, state.year);
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${emp.name||''}</td>
          <td>${emp.jobTitle||''}</td>
          <td>${emp.department||''}</td>
          <td>${emp.dateJoined||''}</td>
          <td>${totals.entitlement}</td>
          <td>${totals.taken}</td>
          <td>${totals.balance}</td>
          <td class="actions">
            <button class="ghost" data-act="edit" data-id="${emp.id}">Edit</button>
            <button class="danger" data-act="del" data-id="${emp.id}">Delete</button>
          </td>`;
        return tr;
      });
    tbody.innerHTML = '';
    rows.forEach(r=>tbody.appendChild(r));
  }
  function fillEmployeeForm(emp){
    $('#employeeId').value = emp?.id || '';
    $('#empName').value = emp?.name || '';
    $('#empTitle').value = emp?.jobTitle || '';
    $('#empDept').value = emp?.department || '';
    $('#empJoined').value = emp?.dateJoined || '';
    $('#empEntYear').value = state.year;
    const ent = emp ? getEntitlement(emp, state.year) : {carry:0,current:0};
    $('#empCarry').value = ent.carry || 0;
    $('#empCurrent').value = ent.current || 0;
  }
  function bindEmployeeForm(){
    $('#employeeForm').addEventListener('submit', (e)=>{
      e.preventDefault();
      const id = $('#employeeId').value || nid();
      const isNew = !DB.employees.some(x=>x.id===id);
      const emp = isNew ? { id } : getEmployee(id);
      emp.name = $('#empName').value.trim();
      emp.jobTitle = $('#empTitle').value.trim();
      emp.department = $('#empDept').value.trim();
      emp.dateJoined = $('#empJoined').value || '';
      const entYear = Number($('#empEntYear').value)||state.year;
      const carry = Number($('#empCarry').value)||0;
      const current = Number($('#empCurrent').value)||0;
      setEntitlement(emp, entYear, carry, current);
      if(isNew) DB.employees.push(emp);
      saveDB(DB);
      fillEmployeeForm(null);
      renderEmployees();
      renderEmployeeOptions();
      alert('Employee saved.');
    });
    $('#employeeCancelBtn').addEventListener('click', ()=> fillEmployeeForm(null));

    // Table actions
    $('#employeesTable').addEventListener('click', (e)=>{
      const btn = e.target.closest('button'); if(!btn) return;
      const id = btn.dataset.id; const act = btn.dataset.act;
      if(act==='edit'){ fillEmployeeForm(getEmployee(id)); }
      if(act==='del'){
        if(confirm('Delete employee and related leaves?')){
          DB.leaves = DB.leaves.filter(l=>l.employeeId!==id);
          DB.employees = DB.employees.filter(e=>e.id!==id);
          saveDB(DB); renderEmployees(); renderLeaves(); renderEmployeeOptions();
        }
      }
    });
    $('#employeeSearch').addEventListener('input', renderEmployees);
  }
  function renderEmployeeOptions(){
    const opts = DB.employees.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
    ['leaveEmployee','filterEmployee','reportEmployee'].forEach(id=>{
      const el = $('#'+id);
      const keep = id==='filterEmployee';
      el.innerHTML = keep ? `<option value="">All Employees</option>${opts}` : opts;
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

    $('#leaveForm').addEventListener('submit', (e)=>{
      e.preventDefault();
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
      $('#leaveForm').reset(); $('#leaveId').value='';
      renderLeaves(); renderEmployees(); buildReportCard();
      alert('Leave saved.');
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
    $('#leavesTable').addEventListener('click', (e)=>{
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
          renderLeaves(); renderEmployees(); buildReportCard();
        }
      }
      if(act==='approve' || act==='reject'){
        const l = DB.leaves.find(x=>x.id===id); if(!l) return;
        const user = getCurrentUser();
        if(!['MANAGER','HR'].includes(user.role)) { alert('Only Manager/HR can approve or reject.'); return; }
        l.status = (act==='approve') ? 'APPROVED' : 'REJECTED';
        l.approvedBy = user.name||'Manager';
        l.approvedAt = today();
        saveDB(DB); renderLeaves(); buildReportCard();
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
    const annualRows = annual.map(l =>{
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
      $('#reportYear').value = state.year;
      $('#empEntYear').value = state.year;
      renderEmployees(); renderLeaves(); buildReportCard();
    });
    $('#reportYear').value = state.year;
    $('#reportYear').addEventListener('change', ()=> buildReportCard());
  }

  // User & holidays
  function getCurrentUser(){
    try{ return JSON.parse(localStorage.getItem('leaveManager.user')||'{}'); }catch{ return {}; }
  }
  function setCurrentUser(user){ localStorage.setItem('leaveManager.user', JSON.stringify(user)); }
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
      saveDB(DB); renderHolidays(); renderLeaves(); buildReportCard();
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
        saveDB(DB); renderHolidays(); renderLeaves(); buildReportCard();
      }catch(err){ alert('Could not fetch holidays. Check the country code or try later.'); }
    });
    $('#holidaysTable').addEventListener('click', (e)=>{
      const btn = e.target.closest('button'); if(!btn) return;
      if(btn.dataset.act==='del-hol'){
        const d = btn.dataset.date; DB.holidays = (DB.holidays||[]).filter(x=>x!==d); saveDB(DB); renderHolidays(); renderLeaves(); buildReportCard();
      }
    });
  }

  // Cloud SYNC UI
  function bindCloudSync(){
    const syncBtn = document.getElementById('cloudSaveBtn'); // repurpose as Sync
    const loadBtn = document.getElementById('cloudLoadBtn'); // hide
    if(loadBtn) loadBtn.style.display = 'none';
    if(syncBtn){
      syncBtn.textContent = 'Sync';
      syncBtn.addEventListener('click', ()=> scheduleDebouncedSync('manual'));
    }
    // Persist doc id and trigger sync on change
    const idInput = document.getElementById('cloudDocId');
    const savedId = localStorage.getItem(DOC_ID_KEY) || 'default';
    if(idInput) idInput.value = savedId;
    idInput?.addEventListener('change', ()=>{ setDocId(idInput.value.trim()||'default'); scheduleDebouncedSync('docid-change'); });

    // auto sync cycle + online/visibility awareness
    startAutoSync();
    window.addEventListener('online', ()=> scheduleDebouncedSync('online'));
    document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) scheduleDebouncedSync('tab-focus'); });
    // cross-tab localStorage updates
    window.addEventListener('storage', (e)=>{ if(e.key===STORE_KEY) { DB = loadDB(); renderAll(); scheduleDebouncedSync('storage'); } });
  }
  // Cloud controls
  function bindCloudSync(){
    const status = (msg) => { const el = document.getElementById('cloudStatus'); if(el) el.textContent = msg||''; };
    const getId = () => (document.getElementById('cloudDocId')?.value||'default').trim() || 'default';

    const loadBtn = document.getElementById('cloudLoadBtn');
    const saveBtn = document.getElementById('cloudSaveBtn');
    if(loadBtn){
      loadBtn.addEventListener('click', async ()=>{
        try{ status('Loading...'); const data = await cloudLoad(getId()); DB = data; saveDB(DB); renderAll(); status('Loaded from cloud'); }
        catch(e){ console.error(e); status('Load failed'); alert('Cloud load failed. Configure Vercel functions and try again.'); }
      });
    }
    if(saveBtn){
      saveBtn.addEventListener('click', async ()=>{
        try{ status('Saving...'); await cloudSave(getId(), DB); status('Saved to cloud'); }
        catch(e){ console.error(e); status('Save failed'); alert('Cloud save failed. Configure Vercel functions and try again.'); }
      });
    }
  }

  function renderAll(){
    renderEmployeeOptions();
    renderEmployees();
    renderLeaves();
    buildReportCard();
  }

  function init(){
    bindTabs();
    bindYear();
    bindEmployeeForm();
    bindLeaveForm();
    bindLeavesTable();
    bindImportExport();
    bindPrint();
    bindCloudSync();
    bindUser();
    bindHolidays();
    renderAll();
    renderHolidays();
  }

  // Kickoff
  document.addEventListener('DOMContentLoaded', init);
})();
