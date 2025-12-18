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
  const STORE_KEY = 'leaveManagerDB.v1';
  const loadDB = () => {
    try{
      const raw = localStorage.getItem(STORE_KEY);
      if(!raw) return { employees: [], leaves: [], holidays: [] };
      const db = JSON.parse(raw);
      db.employees ||= []; db.leaves ||= []; db.holidays ||= [];
      return db;
    }catch(e){ console.error('loadDB', e); return { employees: [], leaves: [], holidays: [] }; }
  };
  const saveDB = (db) => localStorage.setItem(STORE_KEY, JSON.stringify(db));

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
    const search = ($('#filterSearch').value||'').toLowerCase();
    const rows = DB.leaves
      .filter(l => !empFilter || l.employeeId===empFilter)
      .filter(l => !typeFilter || l.type===typeFilter)
      .filter(l => (l.reason||'').toLowerCase().includes(search))
      .sort((a,b)=> a.from.localeCompare(b.from))
      .map(l =>{
        const emp = getEmployee(l.employeeId)||{name:'[deleted]'};
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${emp.name}</td>
          <td>${l.type}</td>
          <td>${l.applied||''}</td>
          <td>${l.from}</td>
          <td>${l.to}</td>
          <td>${l.days ?? workingDays(l.from,l.to)}</td>
          <td>${l.reason||''}</td>
          <td class="actions">
            <button class="ghost" data-act="edit" data-id="${l.id}">Edit</button>
            <button class="danger" data-act="del" data-id="${l.id}">Delete</button>
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
    });
    $('#filterEmployee').addEventListener('change', renderLeaves);
    $('#filterType').addEventListener('change', renderLeaves);
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
    renderAll();
  }

  // Kickoff
  document.addEventListener('DOMContentLoaded', init);
})();
