(() => {
  'use strict';

  const cfg = window.SHIFTTAKT_CONFIG;
  const APPLE_EPOCH = 978307200;
  const PAGE_TITLES = {
    dashboard:'Übersicht',schedule:'Schichtplan',yearplan:'Jahresplan',team:'Team',absences:'Abwesenheiten',
    oncall:'Bereitschaft',departments:'Abteilungen',users:'Benutzer & Rollen',export:'Export'
  };
  const SHIFT_TYPES = ['Früh','Spät','Nacht'];
  const ABSENCE_TYPES = ['Urlaub','Krank','Schulung / Lehrgang','Sonstige Abwesenheit'];
  const state = {
    accessToken:null, refreshToken:null, expiresAt:0, context:null, members:[], doc:null, revision:null, updatedAt:null,
    page:'dashboard', scheduleMonth:startOfMonth(new Date()), scheduleDepartment:'all', onCallWeekend:null, onCallDepartment:null,
    planProposals:[], busy:false
  };

  const rootNode = root => typeof root==='string' ? document.querySelector(root) : root;
  const $ = (s, root=document) => rootNode(root)?.querySelector(s) || null;
  const $$ = (s, root=document) => [...(rootNode(root)?.querySelectorAll(s) || [])];
  const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const clone = obj => JSON.parse(JSON.stringify(obj));
  const uuid = () => crypto.randomUUID();
  const pad = n => String(n).padStart(2,'0');
  function localISO(d){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
  function parseISODate(s){ const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d,0,0,0,0); }
  function startOfDay(d){ return new Date(d.getFullYear(),d.getMonth(),d.getDate()); }
  function startOfMonth(d){ return new Date(d.getFullYear(),d.getMonth(),1); }
  function addDays(d,n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }
  function addMonths(d,n){ const x=new Date(d.getFullYear(),d.getMonth()+n,1); return x; }
  function sameDay(a,b){ return localISO(a)===localISO(b); }
  function monthDays(d){ const y=d.getFullYear(),m=d.getMonth(),last=new Date(y,m+1,0).getDate(); return Array.from({length:last},(_,i)=>new Date(y,m,i+1)); }
  function isWeekend(d){ const w=d.getDay(); return w===0||w===6; }
  function appleEncode(d){ return d.getTime()/1000 - APPLE_EPOCH; }
  function appleDecode(v){ if(v instanceof Date) return v; if(typeof v==='string'){ const n=Number(v); if(Number.isFinite(n)) v=n; else return new Date(v); } return new Date((Number(v)+APPLE_EPOCH)*1000); }
  function fmtDate(d){ return new Intl.DateTimeFormat('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'}).format(d); }
  function fmtShort(d){ return new Intl.DateTimeFormat('de-DE',{weekday:'short',day:'2-digit',month:'2-digit'}).format(d); }
  function dayKey(d){ return localISO(startOfDay(d)); }
  function lower(v){ return String(v??'').trim().toLowerCase(); }
  function roleLabel(r){ return r==='admin'?'Administrator':r==='manager'?'Führungskraft':'Facharbeiter'; }
  function currentUserId(){ try{const payload=JSON.parse(atob(state.accessToken.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));return payload.sub||null;}catch{return null;} }
  function shiftCode(kind){ return kind==='Früh'?'F':kind==='Spät'?'S':kind==='Nacht'?'N':kind==='Bereitschaft'?'B':''; }
  function absenceCode(type){ return type==='Urlaub'?'U':type==='Krank'?'K':type==='Schulung / Lehrgang'?'L':'A'; }

  function toast(msg, error=false){ const el=$('#toast'); el.textContent=msg; el.className=`toast${error?' error':''}`; clearTimeout(toast._t); toast._t=setTimeout(()=>el.classList.add('hidden'),3200); }
  function setSync(text){ $('#syncBadge').textContent=text; }
  function setBusy(v){ state.busy=v; $('#refreshBtn').disabled=v; }
  function showModal(title, html){ $('#modalTitle').textContent=title; $('#modalBody').innerHTML=html; $('#modal').classList.remove('hidden'); $('#modal').setAttribute('aria-hidden','false'); }
  function closeModal(){ $('#modal').classList.add('hidden'); $('#modal').setAttribute('aria-hidden','true'); $('#modalBody').innerHTML=''; }

  // MARK: Auth / Supabase REST
  function saveSession(){ localStorage.setItem('st_leitstand_session', JSON.stringify({accessToken:state.accessToken,refreshToken:state.refreshToken,expiresAt:state.expiresAt})); }
  function clearSession(){ state.accessToken=state.refreshToken=null;state.expiresAt=0;localStorage.removeItem('st_leitstand_session'); }
  function loadSession(){ try{ const s=JSON.parse(localStorage.getItem('st_leitstand_session')||'null'); if(s){state.accessToken=s.accessToken;state.refreshToken=s.refreshToken;state.expiresAt=s.expiresAt||0;return true;} }catch{} return false; }

  async function authFetch(path, options={}){
    const r=await fetch(cfg.supabaseUrl+path,{...options,headers:{apikey:cfg.publishableKey,'Content-Type':'application/json',...(options.headers||{})}});
    const txt=await r.text(); let data; try{data=txt?JSON.parse(txt):null}catch{data=txt}
    if(!r.ok) throw new Error(data?.msg||data?.message||data?.error_description||data?.error||`HTTP ${r.status}`);
    return data;
  }
  async function refreshToken(){
    if(!state.refreshToken) throw new Error('Sitzung abgelaufen.');
    const d=await authFetch('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:JSON.stringify({refresh_token:state.refreshToken})});
    state.accessToken=d.access_token; state.refreshToken=d.refresh_token||state.refreshToken; state.expiresAt=Date.now()+((d.expires_in||3600)-60)*1000; saveSession();
  }
  async function apiFetch(path, options={}, retry=true){
    if(Date.now()>state.expiresAt && state.refreshToken) await refreshToken();
    const r=await fetch(cfg.supabaseUrl+path,{...options,headers:{apikey:cfg.publishableKey,Authorization:`Bearer ${state.accessToken}`,'Content-Type':'application/json',...(options.headers||{})}});
    const txt=await r.text(); let data; try{data=txt?JSON.parse(txt):null}catch{data=txt}
    if(r.status===401 && retry && state.refreshToken){ await refreshToken(); return apiFetch(path,options,false); }
    if(!r.ok) throw new Error(data?.message||data?.error_description||data?.hint||data?.details||data?.code||`HTTP ${r.status}`);
    return data;
  }
  const rpc=(name,body={})=>apiFetch(`/rest/v1/rpc/${name}`,{method:'POST',body:JSON.stringify(body)});

  async function signIn(user,password){
    const email=cfg.loginAliases[lower(user)] || user.trim();
    const d=await authFetch('/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email,password})});
    state.accessToken=d.access_token;state.refreshToken=d.refresh_token;state.expiresAt=Date.now()+((d.expires_in||3600)-60)*1000;saveSession();
    await loadAll();
  }
  async function loadContext(){ const rows=await rpc('st_my_context',{}); state.context=rows?.[0]||null; if(!state.context) throw new Error('Keine ShiftTakt-Firmenzuordnung gefunden.'); }
  async function loadDocument(){ const rows=await rpc('st_get_document',{}); const e=rows?.[0]; if(!e) throw new Error('Keine gemeinsamen Firmendaten gefunden.'); state.doc=e.document||{departments:[],employees:[],assignments:[],absences:[]}; state.revision=e.revision;state.updatedAt=e.updated_at; normalizeDoc(); }
  async function loadMembers(){ try{ state.members=await rpc('st_list_members',{}); }catch{ state.members=[]; } }
  async function loadAll(){ setBusy(true); try{ await loadContext(); await Promise.all([loadDocument(),loadMembers()]); renderShell(); renderAll(); setSync(`Synchron · Rev. ${state.revision}`); } finally{setBusy(false);} }
  function normalizeDoc(){ state.doc.departments??=[];state.doc.employees??=[];state.doc.assignments??=[];state.doc.absences??=[]; state.doc.employees.forEach(e=>{e.allowedShifts??=[];e.qualifications??=[];e.status??='Verfügbar';e.canTakeWeekendOnCall??=true;}); }

  async function saveMutation(label, mutator){
    if(state.busy) return;
    setBusy(true); setSync('Speichert …');
    try{
      let lastErr;
      for(let attempt=0;attempt<4;attempt++){
        const rows=await rpc('st_get_document',{}); const env=rows?.[0]; if(!env) throw new Error('Cloud-Dokument nicht verfügbar.');
        const next=clone(env.document||{departments:[],employees:[],assignments:[],absences:[]});
        next.departments??=[];next.employees??=[];next.assignments??=[];next.absences??=[];
        await mutator(next);
        try{
          const saved=await rpc('st_save_document',{p_org:state.context.organization_id,p_document:next,p_expected_revision:env.revision});
          state.doc=next;state.revision=saved?.[0]?.revision??(env.revision+1);state.updatedAt=saved?.[0]?.updated_at;normalizeDoc();renderAll();setSync(`Synchron · Rev. ${state.revision}`);toast(label);return;
        }catch(e){ lastErr=e; if(!String(e.message).toLowerCase().includes('revision_conflict')) throw e; }
      }
      throw lastErr||new Error('Konflikt konnte nicht aufgelöst werden.');
    }catch(e){ setSync('Synchronisationsfehler');toast(e.message,true); }
    finally{setBusy(false);}
  }

  // MARK: Data helpers
  const deptById=id=>state.doc.departments.find(x=>x.id===id);
  const employeeById=id=>state.doc.employees.find(x=>x.id===id);
  function assignmentsOn(date,doc=state.doc){ const k=dayKey(date); return doc.assignments.filter(a=>dayKey(appleDecode(a.date))===k); }
  function absenceFor(employeeId,date,doc=state.doc){ const d=startOfDay(date);return doc.absences.find(a=>a.employeeID===employeeId&&d>=startOfDay(appleDecode(a.startDate))&&d<=startOfDay(appleDecode(a.endDate))); }
  function assignmentFor(employeeId,date,doc=state.doc){ return assignmentsOn(date,doc).find(a=>a.employeeID===employeeId); }
  function codeFor(employee,date){ const ab=absenceFor(employee.id,date); if(ab)return absenceCode(ab.type); const a=assignmentFor(employee.id,date); return a?shiftCode(a.kind):''; }
  function presenceAvailable(employee,date){ return !absenceFor(employee.id,date)&&employee.status==='Verfügbar'; }
  function requiredStaff(dept,shift){ return dept.requirements?.find(r=>r.shift===shift)?.requiredStaff||0; }
  function activeStaff(dept,shift,date){ return assignmentsOn(date).filter(a=>a.departmentID===dept.id&&a.kind===shift).filter(a=>{const e=employeeById(a.employeeID);return e&&presenceAvailable(e,date)}).length; }
  function staffingGaps(date){
    const out=[]; const weekend=isWeekend(date);
    for(const d of state.doc.departments){
      if(!weekend){ for(const s of SHIFT_TYPES){ const req=requiredStaff(d,s),act=activeStaff(d,s,date); if(req>act)out.push({dept:d,kind:s,required:req,actual:act,missing:req-act}); } }
      if(weekend&&d.weekendOnCallEnabled){
        const mode=d.weekendOnCallMode||'Je Schicht';
        if(mode==='Ganzes Wochenende'){
          const req=Math.max(1,d.wholeWeekendOnCallRequired||1); const act=assignmentsOn(date).filter(a=>a.departmentID===d.id&&a.kind==='Bereitschaft'&&!a.onCallShift).length; if(req>act)out.push({dept:d,kind:'Bereitschaft',required:req,actual:act,missing:req-act});
        }else if(mode==='2 × 10 Stunden'){
          for(const slot of ['06:00–16:00','16:00–02:00']){ const act=assignmentsOn(date).filter(a=>a.departmentID===d.id&&a.kind==='Bereitschaft'&&a.onCallSlot===slot).length; if(act<1)out.push({dept:d,kind:`Bereitschaft ${slot}`,required:1,actual:act,missing:1-act}); }
        }else{
          for(const r of d.requirements||[]){ const req=r.weekendOnCallRequired||0;if(!req)continue;const act=assignmentsOn(date).filter(a=>a.departmentID===d.id&&a.kind==='Bereitschaft'&&a.onCallShift===r.shift).length;if(req>act)out.push({dept:d,kind:`Bereitschaft ${r.shift}`,required:req,actual:act,missing:req-act}); }
        }
      }
    } return out;
  }
  function dueDate(q){ if(q.renewalMode==='Einmalig') return null; if(q.renewalMode==='Festes Fälligkeitsdatum') return q.manualDueDate==null?null:appleDecode(q.manualDueDate); const d=appleDecode(q.completedOn); const x=new Date(d);x.setMonth(x.getMonth()+Math.max(1,q.renewalMonths||12));return x; }
  function qualificationWarnings(){ const now=startOfDay(new Date()),soon=addDays(now,60),r=[];for(const e of state.doc.employees){for(const q of e.qualifications||[]){const due=dueDate(q);if(due&&due<=soon)r.push({employee:e,q,due,overdue:due<now});}}return r.sort((a,b)=>a.due-b.due); }
  function employeesForDept(id){ return state.doc.employees.filter(e=>e.departmentID===id).sort((a,b)=>a.name.localeCompare(b.name,'de')); }

  // MARK: Rendering shell
  function renderShell(){ $('#loginView').classList.add('hidden');$('#appView').classList.remove('hidden');$('#orgName').textContent=state.context.organization_name;$('#displayName').textContent=state.context.display_name;$('#roleLabel').textContent=roleLabel(state.context.role); }
  function renderAll(){ renderDashboard();renderSchedule();renderYearPlan();renderTeam();renderAbsences();renderOnCall();renderDepartments();renderUsers();renderExport(); }
  function switchPage(page){state.page=page;$$('#nav button').forEach(b=>b.classList.toggle('active',b.dataset.page===page));$$('.page').forEach(p=>p.classList.remove('active'));$(`#page-${page}`).classList.add('active');$('#pageTitle').textContent=PAGE_TITLES[page]; if(page==='schedule')renderSchedule(); if(page==='oncall')renderOnCall();}

  function renderDashboard(){
    const root=$('#page-dashboard'); if(!state.doc)return; const today=startOfDay(new Date()); const gaps=staffingGaps(today); const vac=state.doc.employees.filter(e=>absenceFor(e.id,today)?.type==='Urlaub').length; const sick=state.doc.employees.filter(e=>absenceFor(e.id,today)?.type==='Krank').length; const warns=qualificationWarnings();
    const next=[];for(let i=0;i<7;i++){const d=addDays(today,i);const g=staffingGaps(d);if(g.length)next.push({d,count:g.reduce((s,x)=>s+x.missing,0),g});}
    root.innerHTML=`
      <div class="grid cols-4">
        ${metric(vac,'im Urlaub','')} ${metric(sick,'krank','alert')} ${metric(gaps.reduce((s,x)=>s+x.missing,0),'offene Stellen',gaps.length?'alert':'')} ${metric(warns.length,'Qualifikationen fällig',warns.length?'alert':'')}
      </div>
      <div class="section-head"><h3>Heute</h3><span class="muted">${fmtDate(today)}</span></div>
      ${gaps.length?`<div class="card"><div class="gaps">${gaps.map(g=>`<div class="gap"><strong>${esc(g.dept.name)} · ${esc(g.kind)}</strong><span>${g.actual}/${g.required} besetzt · ${g.missing} offen</span></div>`).join('')}</div></div>`:`<div class="ok-box">Heute sind alle hinterlegten Mindestbesetzungen erfüllt.</div>`}
      <div class="grid cols-2" style="margin-top:16px">
        <div class="card"><h3>Nächste 7 Tage</h3>${next.length?next.map(x=>`<div class="list-row"><div class="main-info"><strong>${fmtShort(x.d)}</strong><span>${x.g.slice(0,2).map(g=>`${g.dept.name} ${shiftCode(g.kind)||g.kind} -${g.missing}`).join(' · ')}</span></div><span class="tag red">${x.count} offen</span></div>`).join(''):'<div class="ok-box">Keine offenen Mindestbesetzungen.</div>'}</div>
        <div class="card"><h3>Qualifikationen im Blick</h3>${warns.length?warns.slice(0,6).map(w=>`<div class="list-row"><div class="main-info"><strong>${esc(w.employee.name)}</strong><span>${esc(w.q.name)}</span></div><span class="tag ${w.overdue?'red':''}">${fmtDate(w.due)}</span></div>`).join(''):'<div class="ok-box">Keine fälligen Qualifikationen in den nächsten 60 Tagen.</div>'}</div>
      </div>`;
  }
  function metric(v,label,cls){return `<div class="card metric ${cls}"><div class="value">${v}</div><div class="label">${label}</div></div>`}

  function renderSchedule(){
    const root=$('#page-schedule');if(!state.doc)return; const m=state.scheduleMonth;const days=monthDays(m);const departments=[...state.doc.departments].sort((a,b)=>a.name.localeCompare(b.name,'de'));const dep=state.scheduleDepartment;
    const emps=state.doc.employees.filter(e=>dep==='all'||e.departmentID===dep).sort((a,b)=>a.name.localeCompare(b.name,'de'));
    root.innerHTML=`<div class="toolbar">
      <button class="secondary" data-sched-prev>‹</button><strong>${new Intl.DateTimeFormat('de-DE',{month:'long',year:'numeric'}).format(m)}</strong><button class="secondary" data-sched-next>›</button>
      <select id="scheduleDept"><option value="all">Alle Abteilungen</option>${departments.map(d=>`<option value="${d.id}" ${dep===d.id?'selected':''}>${esc(d.name)}</option>`).join('')}</select>
      <button class="secondary" data-sched-today>Heute</button><span class="tag"><span class="shift-pill s-F" style="width:24px;height:24px">F</span> Früh</span><span class="tag"><span class="shift-pill s-S" style="width:24px;height:24px">S</span> Spät</span><span class="tag"><span class="shift-pill s-N" style="width:24px;height:24px">N</span> Nacht</span>
    </div>
    <div class="schedule-shell" style="margin-top:12px"><table class="schedule-grid"><thead><tr><th class="name">Mitarbeiter</th>${days.map(d=>`<th class="${isWeekend(d)?'weekend-col ':''}${sameDay(d,new Date())?'today-col':''}">${['So','Mo','Di','Mi','Do','Fr','Sa'][d.getDay()]}<br>${d.getDate()}</th>`).join('')}</tr></thead><tbody>
      ${emps.map(e=>`<tr><td class="name"><strong>${esc(e.name)}</strong><span>${esc(deptById(e.departmentID)?.name||'')} · ${esc(e.roleTitle||'')}</span></td>${days.map(d=>{const c=codeFor(e,d);return `<td class="schedule-cell ${isWeekend(d)?'weekend-col':''}" data-emp="${e.id}" data-date="${localISO(d)}">${c?`<span class="shift-pill s-${c}">${c}</span>`:''}</td>`}).join('')}</tr>`).join('')}
    </tbody></table></div>`;
    $('[data-sched-prev]',root)?.addEventListener('click',()=>{state.scheduleMonth=addMonths(m,-1);renderSchedule()});
    $('[data-sched-next]',root)?.addEventListener('click',()=>{state.scheduleMonth=addMonths(m,1);renderSchedule()});
    $('[data-sched-today]',root)?.addEventListener('click',()=>{state.scheduleMonth=startOfMonth(new Date());renderSchedule()});
    $('#scheduleDept',root)?.addEventListener('change',e=>{state.scheduleDepartment=e.target.value;renderSchedule()});
    $$('.schedule-cell',root).forEach(td=>td.addEventListener('click',()=>openCellEditor(td.dataset.emp,td.dataset.date)));
  }

  function openCellEditor(empId,iso){
    const e=employeeById(empId),d=parseISODate(iso),current=assignmentFor(empId,d),ab=absenceFor(empId,d); if(!e)return;
    showModal(`${e.name} · ${fmtDate(d)}`,`<div class="stack">
      ${ab?`<div class="warn-box">Abwesend: <strong>${esc(ab.type)}</strong>${ab.note?` · ${esc(ab.note)}`:''}</div>`:''}
      <button class="secondary" data-set-kind="Früh">Frühschicht</button><button class="secondary" data-set-kind="Spät">Spätschicht</button><button class="secondary" data-set-kind="Nacht">Nachtschicht</button>
      <button class="danger" data-clear-shift>Schichtzuweisung löschen</button>
      <div class="muted">Abwesenheiten werden im Bereich „Abwesenheiten“ gepflegt.</div>
    </div>`);
    $$('[data-set-kind]','#modalBody').forEach(b=>b.addEventListener('click',async()=>{const kind=b.dataset.setKind;if(!e.allowedShifts?.includes(kind)){toast(`${e.name} ist nicht für ${kind} freigegeben.`,true);return;}if(ab){toast('Für diesen Tag ist eine Abwesenheit eingetragen.',true);return;}await saveMutation('Schicht gespeichert.',doc=>{doc.assignments=doc.assignments.filter(a=>!(a.employeeID===empId&&dayKey(appleDecode(a.date))===iso));doc.assignments.push({id:uuid(),date:appleEncode(d),employeeID:empId,departmentID:e.departmentID,kind,onCallShift:null,onCallSlot:null});});closeModal();}));
    $('[data-clear-shift]','#modalBody').addEventListener('click',async()=>{await saveMutation('Zuweisung entfernt.',doc=>{doc.assignments=doc.assignments.filter(a=>!(a.employeeID===empId&&dayKey(appleDecode(a.date))===iso));});closeModal();});
  }

  function renderTeam(){
    const root=$('#page-team');if(!state.doc)return;const depts=[...state.doc.departments].sort((a,b)=>a.name.localeCompare(b.name,'de'));
    root.innerHTML=`<div class="section-head"><div><h3>Planungsmitarbeiter</h3><div class="muted">Mitarbeiterprofile zählen nicht als Business-Nutzerplätze.</div></div><button class="primary" id="addEmployee">+ Mitarbeiter</button></div>
      ${depts.map(d=>`<div class="dept-group"><div class="dept-title">${esc(d.name)}</div><div class="cards-list">${employeesForDept(d.id).map(e=>employeeRow(e)).join('')||'<div class="muted">Keine Mitarbeiter</div>'}</div></div>`).join('')}`;
    $('#addEmployee',root)?.addEventListener('click',()=>openEmployeeEditor());$$('[data-edit-employee]',root).forEach(b=>b.addEventListener('click',()=>openEmployeeEditor(b.dataset.editEmployee)));$$('[data-del-employee]',root).forEach(b=>b.addEventListener('click',()=>deleteEmployee(b.dataset.delEmployee)));
  }
  function employeeRow(e){const shifts=(e.allowedShifts||[]).join(' · ');const abs=absenceFor(e.id,new Date());return `<div class="list-row"><div class="main-info"><strong>${esc(e.name)}</strong><span>${esc(e.roleTitle||'Facharbeiter')} · ${esc(shifts||'keine Schicht')}</span></div><div class="row-actions">${abs?`<span class="tag red">${esc(abs.type)}</span>`:'<span class="tag green">Verfügbar</span>'}<button class="secondary small" data-edit-employee="${e.id}">Bearbeiten</button><button class="danger small" data-del-employee="${e.id}">Löschen</button></div></div>`}

  function openEmployeeEditor(id=null){
    const e=id?clone(employeeById(id)):null;const depts=state.doc.departments;const quals=e?.qualifications||[];
    showModal(e?'Mitarbeiter bearbeiten':'Mitarbeiter anlegen',`<form id="employeeForm" class="form-grid">
      <label class="field">Name<input name="name" value="${esc(e?.name||'')}" required></label>
      <label class="field">Funktion / Berufsbezeichnung<input name="roleTitle" value="${esc(e?.roleTitle||'Facharbeiter')}" required></label>
      <label class="field">Abteilung<select name="departmentID" required>${depts.map(d=>`<option value="${d.id}" ${e?.departmentID===d.id?'selected':''}>${esc(d.name)}</option>`).join('')}</select></label>
      <label class="field">Qualifikationslevel<select name="qualificationLevel">${[1,2,3,4].map(n=>`<option value="${n}" ${(e?.qualificationLevel||3)===n?'selected':''}>${n}</option>`).join('')}</select></label>
      <div class="field full">Zulässige Schichten<div class="checks">${SHIFT_TYPES.map(s=>`<label class="check"><input type="checkbox" name="shift" value="${s}" ${(e?.allowedShifts||['Früh']).includes(s)?'checked':''}>${s}</label>`).join('')}<label class="check"><input type="checkbox" name="oncall" ${e?.canTakeWeekendOnCall!==false?'checked':''}>Bereitschaft</label></div></div>
      <label class="field full">Hallen / Bereiche (kommagetrennt)<input name="halls" value="${esc((e?.halls||[]).join(', '))}"></label>
      <div class="full subcard"><div class="section-head" style="margin:0 0 10px"><h3>Qualifikationen</h3><button type="button" class="secondary small" id="addQual">+ Qualifikation</button></div><div id="qualList">${quals.map((q,i)=>qualificationEditorRow(q,i)).join('')}</div></div>
      <div class="full row-actions" style="justify-content:flex-end"><button type="button" class="ghost" data-close-modal>Abbrechen</button><button class="primary" type="submit">Speichern</button></div>
    </form>`);
    $('#addQual','#modalBody').addEventListener('click',()=>{const list=$('#qualList','#modalBody');list.insertAdjacentHTML('beforeend',qualificationEditorRow(null,list.children.length));bindQualRemove();});bindQualRemove();
    $('#employeeForm','#modalBody').addEventListener('submit',async ev=>{ev.preventDefault();const f=new FormData(ev.target);const qualEls=$$('.qual-item','#modalBody');const qualifications=qualEls.map(el=>{const name=$('[name=qname]',el).value.trim();if(!name)return null;const completed=$('[name=qcompleted]',el).value||localISO(new Date());const mode=$('[name=qmode]',el).value;const manual=$('[name=qmanual]',el).value;return {id:el.dataset.id||uuid(),name,completedOn:appleEncode(parseISODate(completed)),renewalMode:mode,renewalMonths:Number($('[name=qmonths]',el).value||12),manualDueDate:manual?appleEncode(parseISODate(manual)):null,requiredForPlanning:$('[name=qrequired]',el).checked};}).filter(Boolean);
      const next={id:e?.id||uuid(),name:f.get('name').trim(),roleTitle:f.get('roleTitle').trim(),departmentID:f.get('departmentID'),allowedShifts:f.getAll('shift'),canTakeWeekendOnCall:f.get('oncall')==='on',status:e?.status||'Verfügbar',qualifications,halls:String(f.get('halls')||'').split(',').map(s=>s.trim()).filter(Boolean),qualificationLevel:Number(f.get('qualificationLevel')||3)};
      await saveMutation(e?'Mitarbeiter aktualisiert.':'Mitarbeiter angelegt.',doc=>{const i=doc.employees.findIndex(x=>x.id===next.id);if(i>=0)doc.employees[i]=next;else doc.employees.push(next);});closeModal();
    });
  }
  function qualificationEditorRow(q,i){const comp=q?.completedOn?localISO(appleDecode(q.completedOn)):localISO(new Date());const due=q?.manualDueDate?localISO(appleDecode(q.manualDueDate)):'';return `<div class="qual-item subcard" data-id="${q?.id||''}" style="margin-bottom:8px"><div class="form-grid"><label class="field">Bezeichnung<input name="qname" value="${esc(q?.name||'')}"></label><label class="field">Abgeschlossen am<input name="qcompleted" type="date" value="${comp}"></label><label class="field">Erneuerung<select name="qmode">${['Einmalig','Nach Intervall','Festes Fälligkeitsdatum'].map(x=>`<option ${q?.renewalMode===x?'selected':''}>${x}</option>`).join('')}</select></label><label class="field">Intervall Monate<input name="qmonths" type="number" min="1" value="${q?.renewalMonths||12}"></label><label class="field">Festes Fälligkeitsdatum<input name="qmanual" type="date" value="${due}"></label><label class="check"><input type="checkbox" name="qrequired" ${q?.requiredForPlanning?'checked':''}>Pflicht für Planung</label></div><div style="margin-top:8px"><button type="button" class="danger small" data-remove-qual>Entfernen</button></div></div>`}
  function bindQualRemove(){ $$('[data-remove-qual]','#modalBody').forEach(b=>b.onclick=()=>b.closest('.qual-item').remove()); }
  async function deleteEmployee(id){const e=employeeById(id);if(!e||!confirm(`${e.name} wirklich löschen? Schichten, Abwesenheiten und Qualifikationen werden entfernt.`))return;await saveMutation('Mitarbeiter gelöscht.',doc=>{doc.employees=doc.employees.filter(x=>x.id!==id);doc.assignments=doc.assignments.filter(a=>a.employeeID!==id);doc.absences=doc.absences.filter(a=>a.employeeID!==id);});try{await rpc('st_clear_employee_links',{p_org:state.context.organization_id,p_employee:id});}catch{} }

  function renderAbsences(){
    const root=$('#page-absences');if(!state.doc)return;const items=[...state.doc.absences].sort((a,b)=>Number(a.startDate)-Number(b.startDate));
    root.innerHTML=`<div class="section-head"><div><h3>Urlaub, Krankheit & Lehrgang</h3><div class="muted">Zeiträume werden direkt mit dem gemeinsamen Schichtplan synchronisiert.</div></div><button class="primary" id="addAbsence">+ Abwesenheit</button></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Mitarbeiter</th><th>Art</th><th>Von</th><th>Bis</th><th>Notiz</th><th></th></tr></thead><tbody>${items.map(a=>`<tr><td>${esc(employeeById(a.employeeID)?.name||'—')}</td><td><span class="tag ${a.type==='Krank'?'red':''}">${esc(a.type)}</span></td><td>${fmtDate(appleDecode(a.startDate))}</td><td>${fmtDate(appleDecode(a.endDate))}</td><td>${esc(a.note||'')}</td><td><div class="row-actions"><button class="secondary small" data-edit-absence="${a.id}">Bearbeiten</button><button class="danger small" data-del-absence="${a.id}">Löschen</button></div></td></tr>`).join('')}</tbody></table></div>`;
    $('#addAbsence',root).onclick=()=>openAbsenceEditor();$$('[data-edit-absence]',root).forEach(b=>b.onclick=()=>openAbsenceEditor(b.dataset.editAbsence));$$('[data-del-absence]',root).forEach(b=>b.onclick=()=>deleteAbsence(b.dataset.delAbsence));
  }
  function openAbsenceEditor(id=null){const a=id?state.doc.absences.find(x=>x.id===id):null;showModal(a?'Abwesenheit bearbeiten':'Abwesenheit eintragen',`<form id="absenceForm" class="form-grid"><label class="field full">Mitarbeiter<select name="employeeID" required>${state.doc.employees.sort((x,y)=>x.name.localeCompare(y.name,'de')).map(e=>`<option value="${e.id}" ${a?.employeeID===e.id?'selected':''}>${esc(e.name)} · ${esc(deptById(e.departmentID)?.name||'')}</option>`).join('')}</select></label><label class="field">Art<select name="type">${ABSENCE_TYPES.map(t=>`<option ${a?.type===t?'selected':''}>${t}</option>`).join('')}</select></label><label class="field">Von<input type="date" name="start" value="${a?localISO(appleDecode(a.startDate)):localISO(new Date())}" required></label><label class="field">Bis<input type="date" name="end" value="${a?localISO(appleDecode(a.endDate)):localISO(new Date())}" required></label><label class="field full">Notiz<input name="note" value="${esc(a?.note||'')}"></label><div class="full row-actions" style="justify-content:flex-end"><button type="button" class="ghost" data-close-modal>Abbrechen</button><button class="primary">Speichern</button></div></form>`);$('#absenceForm','#modalBody').onsubmit=async ev=>{ev.preventDefault();const f=new FormData(ev.target),start=parseISODate(f.get('start')),end=parseISODate(f.get('end'));if(end<start){toast('Enddatum liegt vor dem Startdatum.',true);return;}const next={id:a?.id||uuid(),employeeID:f.get('employeeID'),type:f.get('type'),startDate:appleEncode(start),endDate:appleEncode(end),note:String(f.get('note')||'').trim()};await saveMutation(a?'Abwesenheit aktualisiert.':'Abwesenheit eingetragen.',doc=>{const i=doc.absences.findIndex(x=>x.id===next.id);if(i>=0)doc.absences[i]=next;else doc.absences.push(next);});closeModal();};}
  async function deleteAbsence(id){if(!confirm('Abwesenheit wirklich löschen?'))return;await saveMutation('Abwesenheit gelöscht.',doc=>{doc.absences=doc.absences.filter(a=>a.id!==id);});}

  function renderDepartments(){
    const root=$('#page-departments');if(!state.doc)return;root.innerHTML=`<div class="section-head"><div><h3>Abteilungen & Mindestbesetzung</h3><div class="muted">Diese Werte steuern Dashboard, Schichtplan und Jahresplan.</div></div><button class="primary" id="addDept">+ Abteilung</button></div><div class="grid cols-2">${state.doc.departments.map(d=>`<div class="card"><div class="section-head" style="margin:0 0 10px"><h3>${esc(d.name)}</h3><div class="row-actions"><button class="secondary small" data-edit-dept="${d.id}">Bearbeiten</button><button class="danger small" data-del-dept="${d.id}">Löschen</button></div></div>${(d.requirements||[]).map(r=>`<div class="list-row"><div class="main-info"><strong>${r.shift}</strong><span>Mindestbesetzung</span></div><strong>${r.requiredStaff}</strong></div>`).join('')}<div style="margin-top:10px"><span class="tag ${d.weekendOnCallEnabled?'green':''}">Bereitschaft ${d.weekendOnCallEnabled?'aktiv':'aus'}</span></div></div>`).join('')}</div>`;$('#addDept',root).onclick=()=>openDepartmentEditor();$$('[data-edit-dept]',root).forEach(b=>b.onclick=()=>openDepartmentEditor(b.dataset.editDept));$$('[data-del-dept]',root).forEach(b=>b.onclick=()=>deleteDepartment(b.dataset.delDept));
  }
  function openDepartmentEditor(id=null){const d=id?clone(deptById(id)):null;const req=s=>d?.requirements?.find(r=>r.shift===s)||{id:uuid(),shift:s,requiredStaff:s==='Früh'?1:0,weekendOnCallRequired:0};showModal(d?'Abteilung bearbeiten':'Abteilung anlegen',`<form id="deptForm" class="form-grid"><label class="field full">Name<input name="name" value="${esc(d?.name||'')}" required></label>${SHIFT_TYPES.map(s=>{const r=req(s);return `<div class="subcard"><strong>${s}</strong><label class="field">Mindestbesetzung<input type="number" min="0" name="staff_${s}" value="${r.requiredStaff||0}"></label><label class="field">Bereitschaft je Schicht<input type="number" min="0" name="call_${s}" value="${r.weekendOnCallRequired||0}"></label></div>`}).join('')}<div class="field full"><label class="check"><input type="checkbox" name="weekend" ${d?.weekendOnCallEnabled?'checked':''}>Wochenend-Bereitschaft aktiv</label></div><label class="field">Bereitschaftsmodell<select name="mode">${['Ganzes Wochenende','Je Schicht','2 × 10 Stunden'].map(x=>`<option ${((d?.weekendOnCallMode)||'Je Schicht')===x?'selected':''}>${x}</option>`).join('')}</select></label><label class="field">Anzahl ganzes Wochenende<input type="number" min="1" name="whole" value="${d?.wholeWeekendOnCallRequired||1}"></label><label class="field full">Hallen / Bereiche (kommagetrennt)<input name="halls" value="${esc((d?.halls||[]).join(', '))}"></label><div class="full row-actions" style="justify-content:flex-end"><button type="button" class="ghost" data-close-modal>Abbrechen</button><button class="primary">Speichern</button></div></form>`);$('#deptForm','#modalBody').onsubmit=async ev=>{ev.preventDefault();const f=new FormData(ev.target);const requirements=SHIFT_TYPES.map(s=>{const old=req(s);return {id:old.id||uuid(),shift:s,requiredStaff:Number(f.get(`staff_${s}`)||0),weekendOnCallRequired:Number(f.get(`call_${s}`)||0)}});const next={id:d?.id||uuid(),name:f.get('name').trim(),requirements,weekendOnCallEnabled:f.get('weekend')==='on',halls:String(f.get('halls')||'').split(',').map(x=>x.trim()).filter(Boolean),weekendOnCallMode:f.get('mode'),wholeWeekendOnCallRequired:Number(f.get('whole')||1)};await saveMutation(d?'Abteilung aktualisiert.':'Abteilung angelegt.',doc=>{const i=doc.departments.findIndex(x=>x.id===next.id);if(i>=0)doc.departments[i]=next;else doc.departments.push(next);});closeModal();};}
  async function deleteDepartment(id){const d=deptById(id);if(!d||!confirm(`Abteilung „${d.name}“ wirklich löschen? Zugehörige Mitarbeiter, Schichten und Abwesenheiten werden ebenfalls gelöscht.`))return;await saveMutation('Abteilung gelöscht.',doc=>{const empIds=new Set(doc.employees.filter(e=>e.departmentID===id).map(e=>e.id));doc.departments=doc.departments.filter(x=>x.id!==id);doc.employees=doc.employees.filter(e=>e.departmentID!==id);doc.assignments=doc.assignments.filter(a=>a.departmentID!==id&&!empIds.has(a.employeeID));doc.absences=doc.absences.filter(a=>!empIds.has(a.employeeID));});}

  function upcomingSaturdays(count=8){const out=[];let d=startOfDay(new Date());for(let i=-1;out.length<count&&i<90;i++){const x=addDays(d,i);if(x.getDay()===6&&addDays(x,1)>=d)out.push(x);}return out;}
  function renderOnCall(){
    const root=$('#page-oncall');if(!state.doc)return;const weekends=upcomingSaturdays();if(!state.onCallWeekend)state.onCallWeekend=weekends[0];const activeDepts=state.doc.departments.filter(d=>d.weekendOnCallEnabled);if(!state.onCallDepartment||!activeDepts.some(d=>d.id===state.onCallDepartment))state.onCallDepartment=activeDepts[0]?.id||null;const sat=state.onCallWeekend;const sun=addDays(sat,1);
    root.innerHTML=`<div class="oncall-weekends">${weekends.map(w=>`<button class="${sameDay(w,sat)?'active':''}" data-weekend="${localISO(w)}">Sa–So ${fmtDate(w)} – ${fmtDate(addDays(w,1))}</button>`).join('')}</div><div class="toolbar" style="margin-top:14px"><select id="oncallDept">${activeDepts.map(d=>`<option value="${d.id}" ${d.id===state.onCallDepartment?'selected':''}>${esc(d.name)}</option>`).join('')}</select></div>${state.onCallDepartment?onCallDeptHtml(deptById(state.onCallDepartment),sat,sun):'<div class="warn-box" style="margin-top:16px">Keine Abteilung mit aktiver Bereitschaft vorhanden.</div>'}`;
    $$('[data-weekend]',root).forEach(b=>b.onclick=()=>{state.onCallWeekend=parseISODate(b.dataset.weekend);renderOnCall()});$('#oncallDept',root)?.addEventListener('change',e=>{state.onCallDepartment=e.target.value;renderOnCall()});$$('[data-edit-oncall]',root).forEach(b=>b.onclick=()=>openOnCallEditor(b.dataset.editOncall,b.dataset.shift||'',b.dataset.slot||''));
  }
  function onCallDeptHtml(d,sat,sun){const mode=d.weekendOnCallMode||'Je Schicht';let rows=[];if(mode==='Ganzes Wochenende')rows=[{label:'Ganzes Wochenende',shift:'',slot:'',required:Math.max(1,d.wholeWeekendOnCallRequired||1)}];else if(mode==='2 × 10 Stunden')rows=['06:00–16:00','16:00–02:00'].map(slot=>({label:slot,shift:'',slot,required:1}));else rows=(d.requirements||[]).filter(r=>r.weekendOnCallRequired>0).map(r=>({label:r.shift,shift:r.shift,slot:'',required:r.weekendOnCallRequired}));return `<div class="card" style="margin-top:16px"><div class="section-head" style="margin:0 0 10px"><div><h3>${esc(d.name)}</h3><div class="muted">Modell: ${esc(mode)}</div></div></div>${rows.map(r=>{const ass=state.doc.assignments.filter(a=>a.departmentID===d.id&&a.kind==='Bereitschaft'&&dayKey(appleDecode(a.date))===dayKey(sat)&&(a.onCallShift||'')===r.shift&&(a.onCallSlot||'')===r.slot);const names=ass.map(a=>employeeById(a.employeeID)?.name).filter(Boolean);return `<div class="list-row"><div class="main-info"><strong>${esc(r.label)}</strong><span>${names.length?esc(names.join(', ')):'Niemand eingeplant'}</span></div><div class="row-actions"><span class="tag ${names.length>=r.required?'green':'red'}">${names.length}/${r.required}</span><button class="secondary small" data-edit-oncall="${d.id}" data-shift="${esc(r.shift)}" data-slot="${esc(r.slot)}">Bearbeiten</button></div></div>`}).join('')}</div>`}
  function openOnCallEditor(deptId,shift,slot){const d=deptById(deptId),sat=state.onCallWeekend,sun=addDays(sat,1),emps=employeesForDept(deptId).filter(e=>e.canTakeWeekendOnCall!==false);const selected=new Set(state.doc.assignments.filter(a=>a.departmentID===deptId&&a.kind==='Bereitschaft'&&dayKey(appleDecode(a.date))===dayKey(sat)&&(a.onCallShift||'')===shift&&(a.onCallSlot||'')===slot).map(a=>a.employeeID));showModal(`Bereitschaft · ${d.name}`,`<form id="onCallForm" class="stack"><div class="muted">${fmtDate(sat)} – ${fmtDate(sun)}${shift?` · ${shift}`:''}${slot?` · ${slot}`:''}</div><div class="checks" style="display:grid">${emps.map(e=>`<label class="check"><input type="checkbox" name="emp" value="${e.id}" ${selected.has(e.id)?'checked':''}>${esc(e.name)}</label>`).join('')}</div><button class="primary">Übernehmen</button></form>`);$('#onCallForm','#modalBody').onsubmit=async ev=>{ev.preventDefault();const ids=new Set(new FormData(ev.target).getAll('emp'));await saveMutation('Bereitschaft aktualisiert.',doc=>{const keys=new Set([dayKey(sat),dayKey(sun)]);doc.assignments=doc.assignments.filter(a=>!(a.departmentID===deptId&&a.kind==='Bereitschaft'&&keys.has(dayKey(appleDecode(a.date)))&&(a.onCallShift||'')===shift&&(a.onCallSlot||'')===slot));for(const id of ids){for(const day of [sat,sun])doc.assignments.push({id:uuid(),date:appleEncode(day),employeeID:id,departmentID:deptId,kind:'Bereitschaft',onCallShift:shift||null,onCallSlot:slot||null});}});closeModal();};}

  function renderUsers(){
    const root=$('#page-users');const c=state.context;if(!c)return;root.innerHTML=`<div class="grid cols-4">${metric(c.active_members,'aktive App-Nutzer','')}${metric(c.seat_limit,'Nutzerlimit','')}${metric(c.plan_type==='business'?'Business':c.plan_type==='developer'?'Developer':'Free','Lizenz','')}${metric(c.status,'Status',c.status!=='active'?'alert':'')}</div><div class="section-head"><div><h3>Firmenbenutzer</h3><div class="muted">Diese Konten zählen als Business-Seats.</div></div><button class="primary" id="createInvite">+ Einladungscode</button></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Name</th><th>E-Mail</th><th>Rolle</th><th></th></tr></thead><tbody>${state.members.map(m=>`<tr><td>${esc(m.display_name)}</td><td>${esc(m.email)}</td><td><select data-role-user="${m.user_id}"><option value="admin" ${m.role==='admin'?'selected':''}>Administrator</option><option value="manager" ${m.role==='manager'?'selected':''}>Führungskraft</option><option value="worker" ${m.role==='worker'?'selected':''}>Facharbeiter</option></select></td><td>${m.user_id===currentUserId()?'':`<button class="danger small" data-remove-user="${m.user_id}">Entfernen</button>`}</td></tr>`).join('')}</tbody></table></div>`;
    $$('[data-role-user]',root).forEach(s=>s.onchange=async()=>{try{await rpc('st_update_member_role',{p_org:c.organization_id,p_user:s.dataset.roleUser,p_role:s.value});await loadMembers();renderUsers();toast('Rolle aktualisiert.')}catch(e){toast(e.message,true);}});$$('[data-remove-user]',root).forEach(b=>b.onclick=async()=>{const m=state.members.find(x=>x.user_id===b.dataset.removeUser);if(!m||!confirm(`${m.display_name} aus der Firma entfernen?`))return;try{await rpc('st_remove_member',{p_org:c.organization_id,p_user:m.user_id});await loadContext();await loadMembers();renderUsers();toast('Benutzer entfernt.')}catch(e){toast(e.message,true);}});$('#createInvite',root).onclick=()=>openInviteModal();
  }
  function openInviteModal(){showModal('Einladungscode erstellen',`<form id="inviteForm" class="stack"><label class="field">Rolle<select name="role"><option value="worker">Facharbeiter</option><option value="manager">Führungskraft</option><option value="admin">Administrator</option></select></label><button class="primary">Code erstellen</button></form><div id="inviteResult"></div>`);$('#inviteForm','#modalBody').onsubmit=async ev=>{ev.preventDefault();try{const role=new FormData(ev.target).get('role');const rows=await rpc('st_create_invite',{p_org:state.context.organization_id,p_role:role,p_expires_hours:168});const r=rows?.[0];$('#inviteResult','#modalBody').innerHTML=r?`<div class="ok-box" style="margin-top:14px"><strong>Einladungscode: ${esc(r.code)}</strong><br>Gültig bis ${esc(r.expires_at)}</div>`:'<div class="critical-box">Kein Code erhalten.</div>';}catch(e){toast(e.message,true);}};}

  // MARK: Year planner (port of Build 30 principles)
  function renderYearPlan(){
    const root=$('#page-yearplan');if(!state.doc)return;const year=new Date().getFullYear();const depts=state.doc.departments;
    root.innerHTML=`<div class="card"><div class="form-grid"><label class="field">Abteilung<select id="planDept"><option value="">Abteilung wählen</option>${depts.map(d=>`<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></label><label class="field">Planjahr<input id="planYear" type="number" value="${year}" min="2020" max="2100"></label></div><div style="margin-top:14px"><button class="primary" id="makePlans">Drei Jahrespläne berechnen</button></div></div><div id="planResults" class="grid" style="margin-top:16px"></div>`;$('#makePlans',root).onclick=()=>{const deptId=$('#planDept',root).value;const y=Number($('#planYear',root).value);if(!deptId){toast('Bitte zuerst eine Abteilung wählen.',true);return;}const strategies=['balanced','qualificationBalanced','fewChanges'];state.planProposals=strategies.map(s=>generateYearProposal(deptId,y,s));renderPlanResults();};
  }
  function renderPlanResults(){const root=$('#planResults');if(!root)return;const names={balanced:'3-2-1 ausgewogen',qualificationBalanced:'3-2-1 + Qualifikation',fewChanges:'Wenig Wechsel'};root.innerHTML=state.planProposals.map((p,i)=>`<div class="plan-card"><h3>${names[p.strategy]}</h3><div class="plan-stats"><div class="plan-stat"><strong>${p.assignments.length}</strong><span>Einteilungen</span></div><div class="plan-stat ${p.gaps?'bad':''}"><strong>${p.gaps}</strong><span>offen</span></div><div class="plan-stat"><strong>${p.fairnessSpread}</strong><span>Gesamt Δ</span></div><div class="plan-stat"><strong>${p.weekendSpread}</strong><span>WE Δ</span></div><div class="plan-stat"><strong>${p.shiftChanges}</strong><span>Wechsel</span></div></div>${p.blockedByQualification?`<div class="critical-box">${p.blockedByQualification} Besetzungen scheitern an abgelaufenen Pflichtqualifikationen.</div>`:''}<div style="margin-top:12px"><button class="primary" data-apply-plan="${i}">Diesen Jahresplan übernehmen</button></div></div>`).join('');$$('[data-apply-plan]',root).forEach(b=>b.onclick=()=>applyPlan(Number(b.dataset.applyPlan)));
  }
  function effectiveQualLevel(e){return Math.min(4,Math.max(1,e.qualificationLevel||3));}
  function employeeMatchesHalls(e,d){const req=new Set((d.halls||[]).map(lower));if(!req.size)return true;const h=new Set((e.halls||[]).map(lower));return [...req].some(x=>h.has(x));}
  function qualificationValid(e,date){return (e.qualifications||[]).filter(q=>q.requiredForPlanning).every(q=>{const due=dueDate(q);return !due||startOfDay(due)>=startOfDay(date);});}
  function hasAbsenceInDoc(doc,eid,date){return !!absenceForDoc(doc,eid,date);}
  function absenceForDoc(doc,eid,date){const d=startOfDay(date);return (doc.absences||[]).find(a=>a.employeeID===eid&&d>=startOfDay(appleDecode(a.startDate))&&d<=startOfDay(appleDecode(a.endDate)));}
  function weeksInYear(year){const map=new Map();let d=new Date(year,0,1),end=new Date(year+1,0,1);while(d<end){const x=startOfDay(d),weekday=x.getDay(),daysFromMonday=(weekday+6)%7,monday=addDays(x,-daysFromMonday),k=dayKey(monday);if(!map.has(k))map.set(k,[]);map.get(k).push(x);d=addDays(d,1);}return [...map.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([k,days])=>({monday:parseISODate(k),days}));}
  function rotationKind(e,weekIndex,team,activeKinds){const canonical=['Nacht','Spät','Früh'];const sorted=[...team].sort((a,b)=>a.name.localeCompare(b.name,'de'));const offset=Math.max(0,sorted.findIndex(x=>x.id===e.id));const raw=canonical[(weekIndex+offset)%3];if(activeKinds.has(raw))return raw;if(activeKinds.has('Früh'))return 'Früh';if(activeKinds.has('Spät'))return 'Spät';if(activeKinds.has('Nacht'))return 'Nacht';return 'Früh';}
  function spread(vals){return vals.length?Math.max(...vals)-Math.min(...vals):0;}
  function generateYearProposal(deptId,year,strategy){
    const department=clone(deptById(deptId)),team=employeesForDept(deptId).map(clone),weeks=weeksInYear(year),doc=state.doc;const generated=[],total={},shiftCount={},weekendCount={},prev={},gaps=[];let blocked=0,changes=0;team.forEach(e=>{total[e.id]=0;shiftCount[e.id]={};weekendCount[e.id]=0;});
    const hasAbs=(id,d)=>hasAbsenceInDoc(doc,id,d);const activeKinds=new Set((department.requirements||[]).filter(r=>r.requiredStaff>0).map(r=>r.shift));const avg=team.length?team.reduce((s,e)=>s+effectiveQualLevel(e),0)/team.length:3;
    weeks.forEach((week,weekIndex)=>{const weekdays=week.days.filter(d=>d.getDay()>=1&&d.getDay()<=5),weekend=week.days.filter(d=>isWeekend(d));const occupied=new Set(),levelSum={},levelCount={},earlyThisWeek=new Set();
      const eligibleCount=(shift)=>team.filter(e=>e.status==='Verfügbar'&&(e.allowedShifts||[]).includes(shift)&&employeeMatchesHalls(e,department)&&!occupied.has(e.id)&&weekdays.every(d=>qualificationValid(e,d))).length;
      const reqs=(department.requirements||[]).filter(r=>r.requiredStaff>0).sort((a,b)=>eligibleCount(a.shift)-eligibleCount(b.shift));
      for(const r of reqs){for(let n=0;n<r.requiredStaff;n++){
        const base=team.filter(e=>e.status==='Verfügbar'&&(e.allowedShifts||[]).includes(r.shift)&&employeeMatchesHalls(e,department)&&!occupied.has(e.id));const qual=base.filter(e=>weekdays.every(d=>qualificationValid(e,d)));if(!qual.length){const wasBlocked=base.length&&base.some(e=>weekdays.some(d=>!qualificationValid(e,d)));if(wasBlocked)blocked+=weekdays.length;gaps.push(...weekdays.map(d=>({date:d,kind:r.shift,reason:wasBlocked?'qualification':'noeligible'})));continue;}
        const fully=qual.filter(e=>weekdays.every(d=>!hasAbs(e.id,d))),pool=fully.length?fully:qual;
        const score=e=>{const absent=weekdays.filter(d=>hasAbs(e.id,d)).length,same=shiftCount[e.id][r.shift]||0,sw=prev[e.id]&&prev[e.id]!==r.shift?1:0,desired=rotationKind(e,weekIndex,team,activeKinds),rotation=r.shift===desired?0:900,projected=((levelSum[r.shift]||0)+effectiveQualLevel(e))/((levelCount[r.shift]||0)+1),qbal=Math.round(Math.abs(projected-avg)*250),valid=(e.qualifications||[]).filter(q=>{const due=dueDate(q);return !due||due>=weekdays[0]}).length;if(strategy==='balanced')return rotation+total[e.id]*30+same*4+absent*1000+sw*12;if(strategy==='qualificationBalanced')return rotation+qbal+total[e.id]*20+absent*1000+sw*10;return total[e.id]*55+same*3+absent*1000+sw*250-valid*0;};
        pool.sort((a,b)=>score(a)-score(b)||a.name.localeCompare(b.name,'de'));const chosen=pool[0];if(prev[chosen.id]&&prev[chosen.id]!==r.shift)changes++;prev[chosen.id]=r.shift;occupied.add(chosen.id);if(r.shift==='Früh')earlyThisWeek.add(chosen.id);levelSum[r.shift]=(levelSum[r.shift]||0)+effectiveQualLevel(chosen);levelCount[r.shift]=(levelCount[r.shift]||0)+1;
        for(const date of weekdays){if(hasAbs(chosen.id,date)){gaps.push({date,kind:r.shift,reason:'noeligible'});continue;}generated.push({id:uuid(),date:appleEncode(date),employeeID:chosen.id,departmentID:deptId,kind:r.shift,onCallShift:null,onCallSlot:null});total[chosen.id]++;shiftCount[chosen.id][r.shift]=(shiftCount[chosen.id][r.shift]||0)+1;}
      }}
      if(department.weekendOnCallEnabled&&weekend.length){const occ=new Set(),mode=department.weekendOnCallMode||'Je Schicht';const blocks=[];if(mode==='Ganzes Wochenende'){for(let i=0;i<Math.max(1,department.wholeWeekendOnCallRequired||1);i++)blocks.push({shift:null,slot:null,preferred:null});}else if(mode==='2 × 10 Stunden'){for(const slot of ['06:00–16:00','16:00–02:00'])blocks.push({shift:null,slot,preferred:earlyThisWeek});}else{for(const r of department.requirements||[])for(let i=0;i<(r.weekendOnCallRequired||0);i++)blocks.push({shift:r.shift,slot:null,preferred:null});}
        for(const block of blocks){let base=team.filter(e=>e.status==='Verfügbar'&&e.canTakeWeekendOnCall!==false&&employeeMatchesHalls(e,department)&&!occ.has(e.id));if(block.preferred){const p=base.filter(e=>block.preferred.has(e.id));if(p.length)base=p;}const qual=base.filter(e=>weekend.every(d=>qualificationValid(e,d)));if(!qual.length){const wasBlocked=base.length&&base.some(e=>weekend.some(d=>!qualificationValid(e,d)));if(wasBlocked)blocked+=weekend.length;gaps.push(...weekend.map(d=>({date:d,kind:'Bereitschaft',reason:wasBlocked?'qualification':'noeligible'})));continue;}const fully=qual.filter(e=>weekend.every(d=>!hasAbs(e.id,d))),pool=fully.length?fully:qual;const score=e=>weekendCount[e.id]*400+total[e.id]*5;pool.sort((a,b)=>score(a)-score(b)||a.name.localeCompare(b.name,'de'));const chosen=pool[0];occ.add(chosen.id);weekendCount[chosen.id]++;for(const date of weekend){if(hasAbs(chosen.id,date)){gaps.push({date,kind:'Bereitschaft',reason:'noeligible'});continue;}generated.push({id:uuid(),date:appleEncode(date),employeeID:chosen.id,departmentID:deptId,kind:'Bereitschaft',onCallShift:block.shift,onCallSlot:block.slot});total[chosen.id]++;shiftCount[chosen.id]['Bereitschaft']=(shiftCount[chosen.id]['Bereitschaft']||0)+1;}}
      }
    });
    return {strategy,year,departmentID:deptId,assignments:generated,gaps:gaps.length,blockedByQualification:blocked,fairnessSpread:spread(team.map(e=>total[e.id]||0)),weekendSpread:spread(team.map(e=>weekendCount[e.id]||0)),shiftChanges:changes};
  }
  async function applyPlan(index){const p=state.planProposals[index];if(!p||!confirm('Dieser Jahresplan ersetzt alle bestehenden Schicht- und Bereitschaftszuweisungen dieser Abteilung für das gewählte Jahr. Fortfahren?'))return;await saveMutation('Jahresplan übernommen.',doc=>{doc.assignments=doc.assignments.filter(a=>!(a.departmentID===p.departmentID&&appleDecode(a.date).getFullYear()===p.year));doc.assignments.push(...clone(p.assignments));});}

  function renderExport(){const root=$('#page-export');if(!state.doc)return;root.innerHTML=`<div class="grid cols-2"><div class="card"><h3>Schichtplan drucken / PDF</h3><p class="muted">Öffnet die Druckansicht des aktuell gewählten Monats. Im Browser kann anschließend „Als PDF sichern“ gewählt werden.</p><button class="primary" id="printPlan">Druckansicht öffnen</button></div><div class="card"><h3>Monat als CSV</h3><p class="muted">Exportiert den aktuell im Schichtplan gewählten Monat als Tabelle.</p><button class="primary" id="csvPlan">CSV herunterladen</button></div></div>`;$('#printPlan',root).onclick=()=>{switchPage('schedule');setTimeout(()=>window.print(),150)};$('#csvPlan',root).onclick=exportCSV;}
  function exportCSV(){const days=monthDays(state.scheduleMonth),emps=state.doc.employees.filter(e=>state.scheduleDepartment==='all'||e.departmentID===state.scheduleDepartment).sort((a,b)=>a.name.localeCompare(b.name,'de'));const rows=[['Mitarbeiter','Abteilung',...days.map(localISO)]];for(const e of emps)rows.push([e.name,deptById(e.departmentID)?.name||'',...days.map(d=>codeFor(e,d))]);const csv=rows.map(r=>r.map(v=>`"${String(v).replaceAll('"','""')}"`).join(';')).join('\n');const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`ShiftTakt_${state.scheduleMonth.getFullYear()}_${pad(state.scheduleMonth.getMonth()+1)}.csv`;a.click();URL.revokeObjectURL(a.href);}

  // MARK: Events / init
  $('#loginForm').addEventListener('submit',async e=>{e.preventDefault();const msg=$('#loginMessage');msg.classList.add('hidden');try{setBusy(true);await signIn($('#loginUser').value,$('#loginPassword').value);$('#loginPassword').value='';}catch(err){clearSession();msg.textContent=err.message;msg.classList.remove('hidden');}finally{setBusy(false);}});
  $('#logoutBtn').addEventListener('click',()=>{clearSession();location.reload();});
  $('#refreshBtn').addEventListener('click',async()=>{try{await loadAll();toast('Daten aktualisiert.')}catch(e){toast(e.message,true)}});
  $('#nav').addEventListener('click',e=>{const b=e.target.closest('button[data-page]');if(b)switchPage(b.dataset.page);});
  document.addEventListener('click',e=>{if(e.target.closest('[data-close-modal]'))closeModal();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal();});

  async function init(){
    if(loadSession()){
      try{await loadAll();return;}catch{clearSession();}
    }
    $('#loginView').classList.remove('hidden');
  }
  init();
  setInterval(async()=>{if(!state.accessToken||state.busy)return;try{const rows=await rpc('st_get_document_revision',{});const r=rows?.[0];if(r&&r.revision!==state.revision){await loadDocument();renderAll();setSync(`Synchron · Rev. ${state.revision}`);toast('Änderungen aus der App wurden übernommen.');}}catch{}},30000);
})();
