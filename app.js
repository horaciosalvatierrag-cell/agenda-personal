(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const DB_KEY = 'agenda-sqlite-v1';
  const STORAGE = 'AgendaPersonalSQLite';
  let db, SQL, current = new Date(), selected = iso(new Date()), view = 'month', saveTimer, diaryTimer;
  const fmt = new Intl.DateTimeFormat('es-MX', { day:'numeric', month:'long', year:'numeric' });
  const monthFmt = new Intl.DateTimeFormat('es-MX', { month:'long', year:'numeric' });
  const longDay = new Intl.DateTimeFormat('es-MX', { weekday:'long', day:'numeric', month:'long' });
  function iso(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  function parse(s) { const [y,m,d] = s.split('-').map(Number); return new Date(y,m-1,d); }
  function safe(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function sql(sql, args=[]) { return db.exec(sql, args); }
  function rows(query,args=[]) { const r=sql(query,args); if(!r.length)return []; const {columns,values}=r[0]; return values.map(v=>Object.fromEntries(columns.map((c,i)=>[c,v[i]]))); }
  function persist(onSaved=null) {
    clearTimeout(saveTimer);
    saveTimer=setTimeout(async()=>{
      let settled=false;
      const report=ok=>{if(settled)return;settled=true;if(ok){$('#dbStatus').textContent='Base SQLite guardada en este dispositivo';if(onSaved)onSaved(true);}else{$('#dbStatus').textContent='No se pudo guardar el respaldo local';if(onSaved)onSaved(false);}};
      try{
        const data=db.export(),tx=await idb('readwrite');
        tx.addEventListener('complete',()=>report(true),{once:true});
        tx.addEventListener('abort',()=>report(false),{once:true});
        tx.addEventListener('error',()=>report(false),{once:true});
        tx.objectStore('files').put(data,DB_KEY);
      }catch(e){report(false);console.error(e);}
    },100);
  }
  function idb(mode) { return new Promise((resolve,reject)=>{const req=indexedDB.open(STORAGE,1);req.onupgradeneeded=()=>req.result.createObjectStore('files');req.onerror=()=>reject(req.error);req.onsuccess=()=>{const dbi=req.result;const tx=dbi.transaction('files',mode);tx.addEventListener('complete',()=>dbi.close(),{once:true});tx.addEventListener('abort',()=>dbi.close(),{once:true});resolve(tx);};}); }
  async function loadDb() { const tx=await idb('readonly');const req=tx.objectStore('files').get(DB_KEY);return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error);}); }
  async function init() {
    SQL=await initSqlJs({locateFile:file=>`./vendor/${file}`});
    const saved=await loadDb();
    db=saved?new SQL.Database(new Uint8Array(saved)):new SQL.Database();
    db.run(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS activities(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,date TEXT NOT NULL,time TEXT NOT NULL DEFAULT '09:00',category TEXT NOT NULL DEFAULT 'Personal',repeat_rule TEXT NOT NULL DEFAULT 'none',notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS completions(activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,occurrence_date TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(activity_id,occurrence_date));
      CREATE TABLE IF NOT EXISTS daily_notes(date TEXT PRIMARY KEY,content TEXT NOT NULL DEFAULT '',important INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(date);`);
    $('#dbStatus').textContent='Base de datos local SQLite';
    $('#todayLabel').textContent=new Intl.DateTimeFormat('es-MX',{weekday:'long',day:'numeric',month:'long'}).format(new Date());
    render(); setInterval(checkReminders,30000); checkReminders();
    if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }
  function allActivities() { return rows('SELECT * FROM activities ORDER BY date,time,title'); }
  function occurs(a, day) {
    if(day<a.date) return false;
    if(a.repeat_rule==='none') return day===a.date;
    const start=parse(a.date), test=parse(day), days=Math.round((test-start)/86400000);
    if(a.repeat_rule==='daily') return true;
    if(a.repeat_rule==='weekly') return days%7===0;
    if(a.repeat_rule==='monthly') return start.getDate()===test.getDate();
    if(a.repeat_rule==='yearly') return start.getDate()===test.getDate()&&start.getMonth()===test.getMonth();
    return false;
  }
  function completions(){return new Set(rows('SELECT activity_id,occurrence_date FROM completions WHERE completed=1').map(x=>`${x.activity_id}|${x.occurrence_date}`));}
  function onDay(day) { return allActivities().filter(a=>occurs(a,day)).sort((a,b)=>a.time.localeCompare(b.time)); }
  function klass(c){return ({Trabajo:'work',Salud:'health',Hogar:'home'})[c]||'';}
  function renderCalendar(){
    $('#monthTitle').textContent=monthFmt.format(current); const first=new Date(current.getFullYear(),current.getMonth(),1);const start=new Date(first);start.setDate(first.getDate()-((first.getDay()+6)%7));
    const done=completions(), today=iso(new Date());let html='';
    for(let i=0;i<42;i++){const d=new Date(start);d.setDate(start.getDate()+i);const key=iso(d), other=d.getMonth()!==current.getMonth();
      const events=onDay(key);html+=`<div class="day-cell ${other?'dim':''} ${key===today?'today':''} ${key===selected?'selected':''}" data-date="${key}"><div class="day-number">${d.getDate()}</div>${events.slice(0,2).map(a=>`<div class="event-pill ${klass(a.category)} ${done.has(`${a.id}|${key}`)?'done':''}" title="${safe(a.title)}">${safe(a.title)}</div>`).join('')}${events.length>2?`<div class="more-events">+${events.length-2} más</div>`:''}</div>`;
    }
    $('#calendarGrid').innerHTML=html;$('#calendarGrid').querySelectorAll('.day-cell').forEach(el=>el.onclick=()=>{selected=el.dataset.date;render();});
  }
  function entry(a,day){const done=completions().has(`${a.id}|${day}`);return `<div class="day-entry"><span class="day-time">${a.time||'Todo el día'}</span><i class="day-bar ${klass(a.category)}"></i><div><div class="entry-title ${done?'is-done':''}">${safe(a.title)}</div><div class="entry-meta">${safe(a.category)}${a.repeat_rule!=='none'?' · Se repite':''}</div></div><button class="done-toggle ${done?'done':''}" data-id="${a.id}" data-day="${day}" title="${done?'Marcar pendiente':'Marcar completada'}">${done?'✓':''}</button></div>`;}
  function renderDay(){const d=parse(selected);$('#selectedDayTitle').textContent=longDay.format(d);const list=onDay(selected);$('#dayList').innerHTML=list.length?list.map(a=>entry(a,selected)).join(''):'<div class="empty">Sin actividades para este día.<br>Un buen momento para planear algo.</div>';$('#dayList').querySelectorAll('.done-toggle').forEach(b=>b.onclick=()=>toggleDone(+b.dataset.id,b.dataset.day));}
  function renderList(){let items=allActivities();if(view==='upcoming')items=items.filter(a=>a.date>=iso(new Date())||a.repeat_rule!=='none');const term=$('#searchInput').value.trim().toLocaleLowerCase('es');const cat=$('#categoryFilter').value;if(term)items=items.filter(a=>`${a.title} ${a.notes}`.toLocaleLowerCase('es').includes(term));if(cat)items=items.filter(a=>a.category===cat);$('#listHeading').textContent=view==='upcoming'?'Próximas actividades':'Todas las actividades';$('#activityList').innerHTML=items.length?items.map(a=>`<div class="list-row"><span class="list-date">${safe(fmt.format(parse(a.date)))}</span><div><strong>${safe(a.title)}</strong><small>${safe(a.time)} · ${safe(a.category)}${a.repeat_rule!=='none'?' · Recurrente':''}</small></div><span class="category-tag">${safe(a.category)}</span><button class="list-edit" data-id="${a.id}" title="Editar">···</button></div>`).join(''):'<div class="empty">No hay actividades todavía. Agrega la primera cuando quieras.</div>';$('#activityList').querySelectorAll('.list-edit').forEach(b=>b.onclick=()=>openForm(+b.dataset.id));$('#upcomingCount').textContent=allActivities().filter(a=>a.date>=iso(new Date())||a.repeat_rule!=='none').length||'';}
  function renderDiary(){
    $('#diaryDate').value=selected;
    $('#diaryDateLabel').textContent=longDay.format(parse(selected));
    const note=rows('SELECT content,important FROM daily_notes WHERE date=?',[selected])[0];
    $('#diaryContent').value=note?.content||'';
    $('#diaryImportant').checked=!!note?.important;
    $('#diarySaveStatus').textContent=note?'Nota guardada en este dispositivo':'Tus anotaciones se guardan en este dispositivo';
    renderRecentDiary();
  }
  function renderRecentDiary(){
    const recent=rows('SELECT date,content,important FROM daily_notes WHERE content<>\'\' OR important=1 ORDER BY date DESC LIMIT 12');
    $('#diaryRecentList').innerHTML=recent.length?recent.map(n=>`<button class="diary-recent-item ${n.date===selected?'current':''}" data-date="${n.date}"><span class="diary-recent-date">${n.important?'★ ':''}${safe(fmt.format(parse(n.date)))}</span><span class="diary-recent-text">${safe(n.content||'Día marcado como importante')}</span></button>`).join(''):'<div class="diary-empty">Tus notas importantes aparecerán aquí.</div>';
    $('#diaryRecentList').querySelectorAll('.diary-recent-item').forEach(b=>b.onclick=()=>switchDiaryDate(b.dataset.date));
  }
  function saveDiary(){
    const content=$('#diaryContent').value.trim(),important=$('#diaryImportant').checked?1:0,day=selected;
    $('#diarySaveStatus').textContent='Guardando…';
    if(!content&&!important)sql('DELETE FROM daily_notes WHERE date=?',[day]);
    else sql(`INSERT INTO daily_notes(date,content,important,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(date) DO UPDATE SET content=excluded.content,important=excluded.important,updated_at=CURRENT_TIMESTAMP`,[day,content,important]);
    $('#diarySaveStatus').textContent='Guardando en este dispositivo…';persist(ok=>{if(view==='diary'&&selected===day)$('#diarySaveStatus').textContent=ok?(content||important?'Guardado en este dispositivo':'Sin anotaciones para este día'):'No se pudo guardar';});renderRecentDiary();
  }
  function scheduleDiarySave(){clearTimeout(diaryTimer);$('#diarySaveStatus').textContent='Cambios pendientes…';diaryTimer=setTimeout(()=>{diaryTimer=null;saveDiary();},450);}
  function flushDiary(){if(diaryTimer){clearTimeout(diaryTimer);diaryTimer=null;saveDiary();}}
  function switchDiaryDate(day){flushDiary();selected=day;renderDiary();}
  function clearMedia(){for(const url of mediaUrls)URL.revokeObjectURL(url);mediaUrls=[];$('#mediaGrid').innerHTML='';$('#mediaFiles').value='';$('#mediaFolder').value='';$('#mediaStatus').textContent='Selecciona fotos, videos o una carpeta para visualizarlos.';$('#clearMediaBtn').classList.add('hidden');}
  function showMedia(files){clearMedia();const media=[...files].filter(file=>{const type=file.type.toLowerCase();return (type.startsWith('image/')&&!type.includes('svg'))||type.startsWith('video/')||/\.(png|jpe?g|gif|webp|bmp|avif|heic|heif|mp4|m4v|mov|webm|3gp|mkv)$/i.test(file.name)}).sort((a,b)=>a.name.localeCompare(b.name,'es',{numeric:true}));if(!media.length){$('#mediaStatus').textContent='No se encontraron imágenes o videos en la selección.';return;}$('#mediaStatus').textContent=`${media.length} ${media.length===1?'archivo seleccionado':'archivos seleccionados'} · Solo se visualizan en este dispositivo.`;$('#clearMediaBtn').classList.remove('hidden');$('#mediaGrid').innerHTML=media.map(file=>{const url=URL.createObjectURL(file);mediaUrls.push(url);const isVideo=file.type.startsWith('video/')||/\.(mp4|m4v|mov|webm|3gp|mkv)$/i.test(file.name);return `<figure class="media-card">${isVideo?`<video src="${url}" controls playsinline preload="metadata" aria-label="${safe(file.name)}"></video>`:`<img src="${url}" alt="${safe(file.name)}" loading="lazy">`}<figcaption><span>${safe(file.name)}</span><small>${(file.size/1048576).toFixed(1)} MB${file.webkitRelativePath?` · ${safe(file.webkitRelativePath.split('/').slice(0,-1).join('/'))}`:''}</small></figcaption></figure>`;}).join('');}
  function installationHelp(){const ua=navigator.userAgent,ios=/iPad|iPhone|iPod/.test(ua),android=/Android/i.test(ua);$('#installInstructions').textContent=ios?'En Safari, toca Compartir (el cuadro con la flecha hacia arriba), elige “Añadir a pantalla de inicio” y confirma con “Añadir”.':android?'En Chrome, abre el menú ⋮ y toca “Instalar aplicación” o “Añadir a pantalla principal”. Confirma para poner Agenda en el inicio.': 'Abre el menú de instalación de tu navegador (normalmente el icono junto a la barra de dirección o el menú) y selecciona “Instalar Agenda”.';if(!$('#installDialog').open)$('#installDialog').showModal();}
  function updateInstallButton(){const installed=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;$('#installBtnLabel').textContent=installed?'Instalada':'Instalar app';$('#installBtn').disabled=installed;}
  function renderWeek(){const today=new Date(),monday=new Date(today);monday.setDate(today.getDate()-((today.getDay()+6)%7));let count=0,bits='';for(let i=0;i<7;i++){const d=new Date(monday);d.setDate(monday.getDate()+i);const has=onDay(iso(d)).length>0;if(has)count++;bits+=`<i class="${has?'has':''}"></i>`;}$('#weekSummary').textContent=`${count} ${count===1?'día con actividad':'días con actividad'}`;$('#weekDots').innerHTML=bits;}
  function render(){if(view!=='diary')flushDiary();const month=view==='month',diary=view==='diary',media=view==='media';$('#calendarView').classList.toggle('hidden',!month);$('#listView').classList.toggle('hidden',month||diary||media);$('#diaryView').classList.toggle('hidden',!diary);$('#mediaView').classList.toggle('hidden',!media);$('#dashboardExtras').classList.toggle('hidden',diary||media);$('#pageTitle').textContent=month?'Tu calendario':diary?'Tu diario':media?'Fotos y videos':view==='upcoming'?'Próximas':'Tus actividades';document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===view));if(month)renderCalendar();else if(diary)renderDiary();else if(!media)renderList();renderDay();renderWeek();}
  function openForm(id){const a=id?rows('SELECT * FROM activities WHERE id=?',[id])[0]:null;$('#eventForm').reset();$('#eventId').value=a?.id||'';$('#eventTitle').value=a?.title||'';$('#eventDate').value=a?.date||selected;$('#eventTime').value=a?.time||'09:00';$('#eventCategory').value=a?.category||'Personal';$('#eventRepeat').value=a?.repeat_rule||'none';$('#eventNotes').value=a?.notes||'';$('#formHeading').textContent=a?'Editar actividad':'Nueva actividad';$('#deleteBtn').classList.toggle('hidden',!a);$('#eventDialog').showModal();setTimeout(()=>$('#eventTitle').focus(),50);}
  function saveEvent(e){e.preventDefault();const id=$('#eventId').value,title=$('#eventTitle').value.trim(),date=$('#eventDate').value,time=$('#eventTime').value||'09:00',category=$('#eventCategory').value,repeat=$('#eventRepeat').value,notes=$('#eventNotes').value.trim();if(!title||!date)return;const st=db.prepare(id?'UPDATE activities SET title=?,date=?,time=?,category=?,repeat_rule=?,notes=? WHERE id=?':'INSERT INTO activities(title,date,time,category,repeat_rule,notes) VALUES(?,?,?,?,?,?)');id?st.run([title,date,time,category,repeat,notes,+id]):st.run([title,date,time,category,repeat,notes]);st.free();selected=date;current=parse(date);persist();$('#eventDialog').close();render();}
  function toggleDone(id,day){const found=rows('SELECT completed FROM completions WHERE activity_id=? AND occurrence_date=?',[id,day])[0];if(found)sql('DELETE FROM completions WHERE activity_id=? AND occurrence_date=?',[id,day]);else sql('INSERT OR REPLACE INTO completions(activity_id,occurrence_date,completed) VALUES(?,?,1)',[id,day]);persist();render();}
  function deleteEvent(){const id=+$('#eventId').value;if(!id)return;if(!confirm('¿Eliminar esta actividad y su historial de completado?'))return;sql('DELETE FROM completions WHERE activity_id=?',[id]);sql('DELETE FROM activities WHERE id=?',[id]);persist();$('#eventDialog').close();render();}
  let notifiedMinute='';function checkReminders(){if(!('Notification'in window)||Notification.permission!=='granted')return;const now=new Date(),key=iso(now),minute=`${key} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;if(minute===notifiedMinute)return;notifiedMinute=minute;onDay(key).filter(a=>a.time===`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`&&!completions().has(`${a.id}|${key}`)).forEach(a=>new Notification('Agenda · '+a.title,{body:`Ahora · ${a.category}`,icon:'./icon.svg',tag:`${a.id}-${key}`}));}
  $('#newBtn').onclick=()=>openForm();$('#addDayBtn').onclick=()=>openForm();$('#eventForm').onsubmit=saveEvent;$('#closeDialog').onclick=$('#cancelBtn').onclick=()=>$('#eventDialog').close();$('#deleteBtn').onclick=deleteEvent;$('#prevMonth').onclick=()=>{current.setDate(1);current.setMonth(current.getMonth()-1);view='month';render();};$('#nextMonth').onclick=()=>{current.setDate(1);current.setMonth(current.getMonth()+1);view='month';render();};$('#todayBtn').onclick=()=>{current=new Date();selected=iso(current);view='month';render();};document.querySelectorAll('.nav-item').forEach(b=>b.onclick=()=>{view=b.dataset.view;render();});$('#searchInput').oninput=()=>renderList();$('#categoryFilter').onchange=()=>renderList();
  $('#diarySaveBtn').onclick=()=>{if(diaryTimer)flushDiary();else saveDiary();};$('#diaryContent').oninput=scheduleDiarySave;$('#diaryImportant').onchange=scheduleDiarySave;$('#diaryDate').onchange=e=>{if(e.target.value)switchDiaryDate(e.target.value);};$('#prevDiaryDay').onclick=()=>{const d=parse(selected);d.setDate(d.getDate()-1);switchDiaryDate(iso(d));};$('#nextDiaryDay').onclick=()=>{const d=parse(selected);d.setDate(d.getDate()+1);switchDiaryDate(iso(d));};$('#todayDiaryBtn').onclick=()=>switchDiaryDate(iso(new Date()));
  $('#installBtn').onclick=async()=>{if(deferredInstallPrompt){const prompt=deferredInstallPrompt;deferredInstallPrompt=null;await prompt.prompt();await prompt.userChoice;updateInstallButton();}else installationHelp();};$('#closeInstallDialog').onclick=()=>$('#installDialog').close();updateInstallButton();window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();deferredInstallPrompt=event;});window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;updateInstallButton();});
  $('#pickMediaBtn').onclick=()=>$('#mediaFiles').click();$('#pickFolderBtn').onclick=()=>{if('webkitdirectory'in HTMLInputElement.prototype)$('#mediaFolder').click();else $('#mediaFiles').click();};$('#mediaFiles').onchange=e=>showMedia([...e.target.files]);$('#mediaFolder').onchange=e=>showMedia([...e.target.files]);$('#clearMediaBtn').onclick=clearMedia;window.addEventListener('pagehide',()=>{for(const url of mediaUrls)URL.revokeObjectURL(url);mediaUrls=[];});
  $('#notifyBtn').onclick=async()=>{if(!('Notification'in window)){alert('Este navegador no admite notificaciones.');return;}const p=await Notification.requestPermission();$('.notify-dot').classList.toggle('granted',p==='granted');if(p==='granted')new Notification('Notificaciones activadas',{body:'La agenda avisará mientras esté abierta en este dispositivo.',icon:'./icon.svg'});};
  $('#exportBtn').onclick=()=>{const blob=new Blob([db.export()],{type:'application/vnd.sqlite3'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`agenda-respaldo-${iso(new Date())}.sqlite`;a.click();URL.revokeObjectURL(a.href);};
  $('#importBtn').onclick=()=>$('#importFile').click();
  $('#importFile').onchange=async(e)=>{
    const file=e.target.files[0];if(!file)return;
    try{
      if(file.size>50*1024*1024)throw new Error('El respaldo supera el límite de 50 MB.');
      const bytes=new Uint8Array(await file.arrayBuffer());
      if(new TextDecoder().decode(bytes.subarray(0,16))!=='SQLite format 3\u0000')throw new Error('El archivo no tiene una cabecera SQLite válida.');
      const fresh=new SQL.Database(bytes);
      const unsafe=rowsFrom(fresh,"SELECT name FROM sqlite_master WHERE type IN ('trigger','view') OR (type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%') LIMIT 1");
      const columns=rowsFrom(fresh,'PRAGMA table_info(activities)')||[];
      if(unsafe?.length||!columns.some(c=>c[1]==='id')||!columns.some(c=>c[1]==='title')||!columns.some(c=>c[1]==='date')){fresh.close();throw new Error('El respaldo no tiene el esquema esperado de Agenda.');}
      fresh.run("PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS completions(activity_id INTEGER NOT NULL,occurrence_date TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(activity_id,occurrence_date)); CREATE TABLE IF NOT EXISTS daily_notes(date TEXT PRIMARY KEY,content TEXT NOT NULL DEFAULT '',important INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(date);");
      db.close();db=fresh;persist();render();alert('Respaldo importado.');
    }catch(err){alert(err.message||'No se pudo importar este archivo de agenda.');console.error(err);}
    e.target.value='';
  };
  function rowsFrom(database,q){const r=database.exec(q);return r.length?r[0].values:null;}
  window.addEventListener('online',()=>{const e=$('#connectionLabel').parentElement;e.classList.remove('offline-state');$('#connectionLabel').textContent='Conectado';});window.addEventListener('offline',()=>{const e=$('#connectionLabel').parentElement;e.classList.add('offline-state');$('#connectionLabel').textContent='Sin conexión';});if(!navigator.onLine){$('#connectionLabel').parentElement.classList.add('offline-state');$('#connectionLabel').textContent='Sin conexión';}
  init().catch(e=>{console.error(e);$('#dbStatus').textContent='Error al abrir SQLite local';});
})();
