(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const DB_KEY = 'agenda-sqlite-v1';
  const STORAGE = 'AgendaPersonalSQLite';
  let db, SQL, current = new Date(), selected = iso(new Date()), view = 'month', saveTimer, diaryTimer, deleteTargetDate='';
  let syncInProgress = false, syncQueue = Promise.resolve(), localMutationVersion = 0;
  let mediaUrls = [], mediaDrag = null, mediaClickGuard = false, mediaResizeFrame = 0;
  const fmt = new Intl.DateTimeFormat('es-MX', { day:'numeric', month:'long', year:'numeric' });
  const monthFmt = new Intl.DateTimeFormat('es-MX', { month:'long', year:'numeric' });
  const longDay = new Intl.DateTimeFormat('es-MX', { weekday:'long', day:'numeric', month:'long' });
  function iso(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  function parse(s) { const [y,m,d] = s.split('-').map(Number); return new Date(y,m-1,d); }
  function safe(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function sql(sql, args=[]) { return db.exec(sql, args); }
  function rows(query,args=[]) { const r=sql(query,args); if(!r.length)return []; const {columns,values}=r[0]; return values.map(v=>Object.fromEntries(columns.map((c,i)=>[c,v[i]]))); }
  function ensureSchema(database){
    database.run(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS activities(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,date TEXT NOT NULL,time TEXT NOT NULL DEFAULT '09:00',end_time TEXT NOT NULL DEFAULT '',end_next_day INTEGER NOT NULL DEFAULT 0,category TEXT NOT NULL DEFAULT 'Personal',repeat_rule TEXT NOT NULL DEFAULT 'none',repeat_until TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS completions(activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,occurrence_date TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(activity_id,occurrence_date));
      CREATE TABLE IF NOT EXISTS occurrence_exceptions(activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,occurrence_date TEXT NOT NULL,PRIMARY KEY(activity_id,occurrence_date));
      CREATE TABLE IF NOT EXISTS daily_notes(date TEXT PRIMARY KEY,content TEXT NOT NULL DEFAULT '',important INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(date);`);
    const columns=rowsFrom(database,'PRAGMA table_info(activities)')||[];
    const names=new Set(columns.map(column=>column[1]));
    if(!names.has('end_time'))database.run("ALTER TABLE activities ADD COLUMN end_time TEXT NOT NULL DEFAULT ''");
    if(!names.has('end_next_day'))database.run('ALTER TABLE activities ADD COLUMN end_next_day INTEGER NOT NULL DEFAULT 0');
    if(!names.has('repeat_until'))database.run("ALTER TABLE activities ADD COLUMN repeat_until TEXT NOT NULL DEFAULT ''");
  }
  function persist(onSaved=null, {skipSync=false}={}) {
    clearTimeout(saveTimer);
    saveTimer=setTimeout(async()=>{
      let settled=false;
      const report=ok=>{if(settled)return;settled=true;if(ok){$('#dbStatus').textContent='Base SQLite guardada en este dispositivo';if(onSaved)onSaved(true);if(!skipSync){localMutationVersion++;if(window.AgendaAuth?.account){const userId=window.AgendaAuth.account.userId;localStorage.setItem(`agenda-sync-dirty:${userId}`,'1');syncQueue=syncQueue.then(()=>uploadCurrentSnapshot(userId)).catch(error=>{console.warn('Agenda sync deferred:',error);});}}}else{$('#dbStatus').textContent='No se pudo guardar el respaldo local';if(onSaved)onSaved(false);}};
      try{await saveDb(db.export());report(true);}catch(e){report(false);console.error(e);}
    },100);
  }
  function saveDb(data) { return new Promise((resolve,reject)=>{const req=indexedDB.open(STORAGE,1);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('files'))req.result.createObjectStore('files');};req.onerror=()=>reject(req.error);req.onsuccess=()=>{const database=req.result;let tx;try{tx=database.transaction('files','readwrite');tx.addEventListener('complete',()=>{database.close();resolve();},{once:true});tx.addEventListener('abort',()=>{const error=tx.error||new Error('No se pudo escribir en el almacenamiento local.');database.close();reject(error);},{once:true});tx.addEventListener('error',()=>{const error=tx.error||new Error('No se pudo escribir en el almacenamiento local.');database.close();reject(error);},{once:true});tx.objectStore('files').put(data,DB_KEY);}catch(error){database.close();reject(error);}};}); }
  function idb(mode) { return new Promise((resolve,reject)=>{const req=indexedDB.open(STORAGE,1);req.onupgradeneeded=()=>req.result.createObjectStore('files');req.onerror=()=>reject(req.error);req.onsuccess=()=>{const dbi=req.result;const tx=dbi.transaction('files',mode);tx.addEventListener('complete',()=>dbi.close(),{once:true});tx.addEventListener('abort',()=>dbi.close(),{once:true});resolve(tx);};}); }
  async function loadDb() { const tx=await idb('readonly');const req=tx.objectStore('files').get(DB_KEY);return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error);}); }
  async function init() {
    SQL=await initSqlJs({locateFile:file=>`./vendor/${file}`});
    const saved=await loadDb();
    db=saved?new SQL.Database(new Uint8Array(saved)):new SQL.Database();
    ensureSchema(db);
    $('#dbStatus').textContent='Base de datos local SQLite';
    $('#todayLabel').textContent=new Intl.DateTimeFormat('es-MX',{weekday:'long',day:'numeric',month:'long'}).format(new Date());
    render(); setInterval(checkReminders,30000); checkReminders();
    window.AgendaSync={reconcile:reconcileCloud,pull:applyCloudSnapshot};
    window.addEventListener('agenda-auth-state',event=>{if(event.detail?.account)reconcileCloud();});
    window.AgendaAuth?.sync();
    if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }
  const revisionKey=userId=>`agenda-sync-revision:${userId}`;
  const dirtyKey=userId=>`agenda-sync-dirty:${userId}`;
  const binaryBase64=bytes=>{let value='';for(let i=0;i<bytes.length;i+=0x8000)value+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(value);};
  function localHasData(){return (rows('SELECT COUNT(*) AS count FROM activities')[0]?.count||0)>0||(rows('SELECT COUNT(*) AS count FROM daily_notes')[0]?.count||0)>0;}
  function downloadSnapshot(bytes,suffix){const url=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.sqlite3'}));const a=document.createElement('a');a.href=url;a.download=`agenda-respaldo-${suffix}-${iso(new Date())}.sqlite`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function applyCloudSnapshot(base64){
    if(typeof base64!=='string'||base64.length>Math.ceil(8*1024*1024*4/3))throw new Error('La copia en la nube excede el límite de 8 MB.');
    const raw=atob(base64),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
    if(new TextDecoder().decode(bytes.subarray(0,16))!=='SQLite format 3\u0000')throw new Error('La copia en la nube no es un archivo SQLite válido.');
    const fresh=new SQL.Database(bytes);
    const unsafe=rowsFrom(fresh,"SELECT name FROM sqlite_master WHERE type IN ('trigger','view') OR (type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%') LIMIT 1");
    const columns=rowsFrom(fresh,'PRAGMA table_info(activities)')||[];
    if(unsafe?.length||!columns.some(c=>c[1]==='id')||!columns.some(c=>c[1]==='title')||!columns.some(c=>c[1]==='date')){fresh.close();throw new Error('La copia en la nube no tiene el esquema esperado.');}
    ensureSchema(fresh);
    db.close();db=fresh;persist(null,{skipSync:true});render();
  }
  async function uploadCurrentSnapshot(userId,baseRevision=null){
    if(!window.AgendaAuth?.account||window.AgendaAuth.account.userId!==userId)return;
    const versionAtStart=localMutationVersion;
    const revision=baseRevision??Number(localStorage.getItem(revisionKey(userId))||0);
    const response=await window.AgendaAuth.api('/api/sync',{method:'PUT',body:JSON.stringify({baseRevision:revision,snapshot:binaryBase64(db.export())})});
    localStorage.setItem(revisionKey(userId),String(response.revision));if(versionAtStart===localMutationVersion)localStorage.removeItem(dirtyKey(userId));
    $('#dbStatus').textContent='Agenda sincronizada';
  }
  async function reconcileCloud(){
    const user=window.AgendaAuth?.account;if(!user||syncInProgress||!navigator.onLine)return;
    syncInProgress=true;
    try{
      const cloud=await window.AgendaAuth.api('/api/sync');
      const saved=localStorage.getItem(revisionKey(user.userId));
      const known=saved===null?null:Number(saved);
      const dirty=localStorage.getItem(dirtyKey(user.userId))==='1';
      if(!cloud.snapshot){await uploadCurrentSnapshot(user.userId,cloud.revision);return;}
      if(known===null){
        if(!localHasData()){await applyCloudSnapshot(cloud.snapshot);localStorage.setItem(revisionKey(user.userId),String(cloud.revision));localStorage.removeItem(dirtyKey(user.userId));}
        else if(confirm('Ya hay una copia en la nube y datos locales. Aceptar: descargar la copia de la nube y guardar tus datos locales como respaldo. Cancelar: conservar los datos locales y reemplazar la copia en la nube.')){downloadSnapshot(db.export(),'antes-de-recibir-nube');await applyCloudSnapshot(cloud.snapshot);localStorage.setItem(revisionKey(user.userId),String(cloud.revision));localStorage.removeItem(dirtyKey(user.userId));}
        else{downloadSnapshot(Uint8Array.from(atob(cloud.snapshot),c=>c.charCodeAt(0)),'copia-nube');await uploadCurrentSnapshot(user.userId,cloud.revision);}
        return;
      }
      if(cloud.revision!==known){
        if(dirty&&confirm('La copia en la nube cambió desde este dispositivo. Aceptar: recibir la copia de la nube y respaldar la copia local. Cancelar: mantener la copia local, respaldar la copia de la nube y reemplazarla.')){downloadSnapshot(db.export(),'antes-de-recibir-nube');await applyCloudSnapshot(cloud.snapshot);localStorage.setItem(revisionKey(user.userId),String(cloud.revision));localStorage.removeItem(dirtyKey(user.userId));}
        else if(dirty){downloadSnapshot(Uint8Array.from(atob(cloud.snapshot),c=>c.charCodeAt(0)),'copia-nube');await uploadCurrentSnapshot(user.userId,cloud.revision);}
        else{await applyCloudSnapshot(cloud.snapshot);localStorage.setItem(revisionKey(user.userId),String(cloud.revision));}
        return;
      }
      if(dirty)await uploadCurrentSnapshot(user.userId,cloud.revision);
      else $('#dbStatus').textContent='Agenda sincronizada';
    }catch(error){$('#dbStatus').textContent='Sincronización pendiente · '+(error.message||'sin conexión');}
    finally{syncInProgress=false;}
  }
  function allActivities() { return rows('SELECT * FROM activities ORDER BY date,time,title'); }
  function occurrenceExceptions(){return new Set(rows('SELECT activity_id,occurrence_date FROM occurrence_exceptions').map(x=>`${x.activity_id}|${x.occurrence_date}`));}
  function occurs(a, day, skipped=occurrenceExceptions()) {
    if(day<a.date||(a.repeat_until&&day>a.repeat_until)||skipped.has(`${a.id}|${day}`)) return false;
    if(a.repeat_rule==='none') return day===a.date;
    const start=parse(a.date), test=parse(day), days=Math.round((test-start)/86400000);
    if(a.repeat_rule==='daily') return true;
    if(a.repeat_rule==='weekly') return days%7===0;
    if(a.repeat_rule==='monthly') return start.getDate()===test.getDate();
    if(a.repeat_rule==='yearly') return start.getDate()===test.getDate()&&start.getMonth()===test.getMonth();
    return false;
  }
  function completions(){return new Set(rows('SELECT activity_id,occurrence_date FROM completions WHERE completed=1').map(x=>`${x.activity_id}|${x.occurrence_date}`));}
  function occurrenceEnd(a,day){const end=parse(day);const [hours,minutes]=(a.end_time||'00:00').split(':').map(Number);end.setHours(hours,minutes,0,0);if(a.end_next_day)end.setDate(end.getDate()+1);return end;}
  function occurrenceDone(a,day,done=completions(),now=new Date()){return done.has(`${a.id}|${day}`)||(a.repeat_rule!=='none'&&!!a.end_time&&occurrenceEnd(a,day)<=now);}
  function onDay(day,skipped=occurrenceExceptions()) { return allActivities().filter(a=>occurs(a,day,skipped)).sort((a,b)=>a.time.localeCompare(b.time)); }
  function timeRange(a){const start=a.time||'09:00';return a.end_time?`${start}–${a.end_time}${a.end_next_day?' (+1 día)':''}`:start+' · falta hora final';}
  function calendarTimeRange(a){const compact=time=>time?(time.endsWith(':00')?time.slice(0,2):time):'?';return `${compact(a.time)}–${compact(a.end_time)}${a.end_next_day?' +1':''}`;}
  function nextPendingOccurrenceDate(a,from=iso(new Date()),done=completions(),skipped=occurrenceExceptions()){
    let day=from<a.date?a.date:from;const cursor=parse(day);
    for(let i=0;i<=366;i++,cursor.setDate(cursor.getDate()+1)){
      day=iso(cursor);if(a.repeat_until&&day>a.repeat_until)return '';
      if(occurs(a,day,skipped)&&!occurrenceDone(a,day,done))return day;
    }
    return '';
  }
  function klass(c){return ({Trabajo:'work',Salud:'health',Hogar:'home'})[c]||'';}
  function renderCalendar(){
    $('#monthTitle').textContent=monthFmt.format(current); const first=new Date(current.getFullYear(),current.getMonth(),1);const start=new Date(first);start.setDate(first.getDate()-((first.getDay()+6)%7));
    const done=completions(), skipped=occurrenceExceptions(), today=iso(new Date());let html='';
    for(let i=0;i<42;i++){const d=new Date(start);d.setDate(start.getDate()+i);const key=iso(d), other=d.getMonth()!==current.getMonth();
      const events=onDay(key,skipped);html+=`<div class="day-cell ${other?'dim':''} ${key===today?'today':''} ${key===selected?'selected':''}" data-date="${key}"><div class="day-number">${d.getDate()}</div>${events.slice(0,2).map(a=>`<div class="event-pill ${klass(a.category)} ${occurrenceDone(a,key,done)?'done':''}" title="${safe(`${timeRange(a)} ${a.title}`)}"><span class="event-time">${safe(calendarTimeRange(a))}</span> ${safe(a.title)}</div>`).join('')}${events.length>2?`<div class="more-events">+${events.length-2} más</div>`:''}</div>`;
    }
    $('#calendarGrid').innerHTML=html;$('#calendarGrid').querySelectorAll('.day-cell').forEach(el=>el.onclick=()=>{selected=el.dataset.date;render();});
  }
  function entry(a,day,doneSet){const done=occurrenceDone(a,day,doneSet),autoDone=a.repeat_rule!=='none'&&!!a.end_time&&occurrenceEnd(a,day)<=new Date();return `<div class="day-entry"><span class="day-time">${safe(timeRange(a))}</span><i class="day-bar ${klass(a.category)}"></i><div><div class="entry-title ${done?'is-done':''}">${safe(a.title)}</div><div class="entry-meta">${safe(a.category)}${a.repeat_rule!=='none'?' · Se repite':''}${autoDone?' · Concluida automáticamente':''}</div></div><button class="done-toggle ${done?'done':''}" data-id="${a.id}" data-day="${day}" title="${autoDone?'Concluida automáticamente':done?'Marcar pendiente':'Marcar completada'}" ${autoDone?'disabled':''}>${done?'✓':''}</button></div>`;}
  function renderDay(){const d=parse(selected);$('#selectedDayTitle').textContent=longDay.format(d);const list=onDay(selected),done=completions();$('#dayList').innerHTML=list.length?list.map(a=>entry(a,selected,done)).join(''):'<div class="empty">Sin actividades para este día.<br>Un buen momento para planear algo.</div>';$('#dayList').querySelectorAll('.done-toggle:not(:disabled)').forEach(b=>b.onclick=()=>toggleDone(+b.dataset.id,b.dataset.day));}
  function renderList(){let items=allActivities();const done=completions(),skipped=occurrenceExceptions(),today=iso(new Date());if(view==='upcoming')items=items.map(a=>({...a,nextDate:nextPendingOccurrenceDate(a,today,done,skipped)})).filter(a=>a.nextDate).sort((a,b)=>a.nextDate.localeCompare(b.nextDate)||a.time.localeCompare(b.time));const term=$('#searchInput').value.trim().toLocaleLowerCase('es');const cat=$('#categoryFilter').value;if(term)items=items.filter(a=>`${a.title} ${a.notes}`.toLocaleLowerCase('es').includes(term));if(cat)items=items.filter(a=>a.category===cat);$('#listHeading').textContent=view==='upcoming'?'Próximas actividades':'Todas las actividades';const emptyMessage=view==='upcoming'?'No hay actividades próximas.':'No hay actividades todavía. Agrega la primera cuando quieras.';$('#activityList').innerHTML=items.length?items.map(a=>`<div class="list-row"><span class="list-date">${safe(fmt.format(parse(a.nextDate||a.date)))}</span><div><strong>${safe(a.title)}</strong><small>${safe(timeRange(a))} · ${safe(a.category)}${a.repeat_rule!=='none'?' · Recurrente':''}${a.repeat_until?' · Hasta '+safe(fmt.format(parse(a.repeat_until))):''}</small></div><span class="category-tag">${safe(a.category)}</span><button class="list-edit" data-id="${a.id}" data-occurrence="${safe(a.nextDate||a.date)}" title="Editar">···</button></div>`).join(''):`<div class="empty">${emptyMessage}</div>`;$('#activityList').querySelectorAll('.list-edit').forEach(b=>b.onclick=()=>openForm(+b.dataset.id,b.dataset.occurrence));const upcomingCount=allActivities().filter(a=>nextPendingOccurrenceDate(a,today,done,skipped)).length;$('#upcomingCount').textContent=upcomingCount||'';}
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
  function clearMedia(){for(const url of mediaUrls)URL.revokeObjectURL(url);mediaUrls=[];$('#mediaGrid').innerHTML='';$('#mediaGrid').scrollLeft=0;$('#mediaFiles').value='';$('#mediaFolder').value='';$('#mediaStatus').textContent='Selecciona fotos, videos o una carpeta para visualizarlos.';$('#clearMediaBtn').classList.add('hidden');}
  function updateMediaCardSizes(){
    const grid=$('#mediaGrid'),width=grid.clientWidth;if(!width)return;
    const gap=parseFloat(getComputedStyle(grid).columnGap)||0,narrow=window.matchMedia('(max-width: 980px)').matches;
    const columns=narrow?2:Math.max(1,Math.floor((width+gap)/(175+gap)));
    grid.style.setProperty('--media-card-width',`${Math.max(1,(width-gap*(columns-1))/columns)}px`);
  }
  function scrollMedia(direction,behavior='smooth'){
    const grid=$('#mediaGrid'),card=grid.querySelector('.media-card');
    grid.scrollBy({left:direction*((card?.getBoundingClientRect().width||grid.clientWidth)+parseFloat(getComputedStyle(grid).columnGap||0)),behavior});
  }
  function showMedia(files){
    clearMedia();
    const media=[...files].filter(file=>{const type=file.type.toLowerCase();return (type.startsWith('image/')&&!type.includes('svg'))||type.startsWith('video/')||/\.(png|jpe?g|gif|webp|bmp|avif|heic|heif|mp4|m4v|mov|webm|3gp|mkv)$/i.test(file.name)}).sort((a,b)=>a.name.localeCompare(b.name,'es',{numeric:true}));
    if(!media.length){$('#mediaStatus').textContent='No se encontraron imágenes o videos en la selección.';return;}
    $('#mediaStatus').textContent=`${media.length} ${media.length===1?'archivo seleccionado':'archivos seleccionados'} · Solo se visualizan en este dispositivo.`;
    $('#clearMediaBtn').classList.remove('hidden');
    const grid=$('#mediaGrid');
    grid.setAttribute('role','region');grid.setAttribute('aria-roledescription','carrusel');grid.setAttribute('aria-label','Galería de imágenes y videos');grid.tabIndex=0;
    grid.innerHTML=media.map(file=>{
      const url=URL.createObjectURL(file);mediaUrls.push(url);
      const isVideo=file.type.startsWith('video/')||/\.(mp4|m4v|mov|webm|3gp|mkv)$/i.test(file.name);
      return `<figure class="media-card">${isVideo?`<video src="${url}" controls playsinline preload="none" aria-label="${safe(file.name)}"></video>`:`<img src="${url}" alt="${safe(file.name)}" loading="lazy" decoding="async" draggable="false">`}<figcaption><span>${safe(file.name)}</span><small>${(file.size/1048576).toFixed(1)} MB${file.webkitRelativePath?` · ${safe(file.webkitRelativePath.split('/').slice(0,-1).join('/'))}`:''}</small></figcaption></figure>`;
    }).join('');
    updateMediaCardSizes();
  }
  const mediaGrid=$('#mediaGrid');
  mediaGrid.addEventListener('wheel',event=>{
    if(Math.abs(event.deltaY)>Math.abs(event.deltaX)&&mediaGrid.scrollWidth>mediaGrid.clientWidth){event.preventDefault();mediaGrid.scrollBy({left:event.deltaY,behavior:'auto'});}
  },{passive:false});
  mediaGrid.addEventListener('keydown',event=>{
    if((event.key==='ArrowRight'||event.key==='ArrowLeft')&&!event.target.closest('video,button,input,textarea,select')){event.preventDefault();scrollMedia(event.key==='ArrowRight'?1:-1);}
  });
  mediaGrid.addEventListener('pointerdown',event=>{
    if(event.pointerType!=='mouse'||event.button!==0||event.target.closest('video,button,a,input'))return;
    mediaDrag={pointerId:event.pointerId,startX:event.clientX,startScroll:mediaGrid.scrollLeft,moved:false};event.preventDefault();
  });
  window.addEventListener('pointermove',event=>{
    if(!mediaDrag||event.pointerId!==mediaDrag.pointerId)return;
    const distance=event.clientX-mediaDrag.startX;
    if(Math.abs(distance)>5){mediaDrag.moved=true;mediaGrid.classList.add('is-dragging');}
    if(mediaDrag.moved){mediaGrid.scrollLeft=mediaDrag.startScroll-distance;event.preventDefault();}
  },{passive:false});
  window.addEventListener('pointerup',event=>{
    if(!mediaDrag||event.pointerId!==mediaDrag.pointerId)return;
    mediaClickGuard=mediaDrag.moved;mediaDrag=null;mediaGrid.classList.remove('is-dragging');
    if(mediaClickGuard)setTimeout(()=>{mediaClickGuard=false;},0);
  });
  window.addEventListener('resize',()=>{
    cancelAnimationFrame(mediaResizeFrame);
    mediaResizeFrame=requestAnimationFrame(updateMediaCardSizes);
  });
  mediaGrid.addEventListener('click',event=>{
    if(mediaClickGuard){event.preventDefault();event.stopPropagation();mediaClickGuard=false;}
  },true);
  function installationHelp(){const ua=navigator.userAgent,ios=/iPad|iPhone|iPod/.test(ua),android=/Android/i.test(ua);$('#installInstructions').textContent=ios?'En Safari, toca Compartir (el cuadro con la flecha hacia arriba), elige “Añadir a pantalla de inicio” y confirma con “Añadir”.':android?'En Chrome, abre el menú ⋮ y toca “Instalar aplicación” o “Añadir a pantalla principal”. Confirma para poner Agenda en el inicio.': 'Abre el menú de instalación de tu navegador (normalmente el icono junto a la barra de dirección o el menú) y selecciona “Instalar Agenda”.';if(!$('#installDialog').open)$('#installDialog').showModal();}
  function updateInstallButton(){const installed=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;$('#installBtnLabel').textContent=installed?'Instalada':'Instalar app';$('#installBtn').disabled=installed;}
  function renderWeek(){const today=new Date(),monday=new Date(today);monday.setDate(today.getDate()-((today.getDay()+6)%7));let count=0,bits='';for(let i=0;i<7;i++){const d=new Date(monday);d.setDate(monday.getDate()+i);const has=onDay(iso(d)).length>0;if(has)count++;bits+=`<i class="${has?'has':''}"></i>`;}$('#weekSummary').textContent=`${count} ${count===1?'día con actividad':'días con actividad'}`;$('#weekDots').innerHTML=bits;}
  function render(){if(view!=='diary')flushDiary();const month=view==='month',diary=view==='diary',media=view==='media';$('#calendarView').classList.toggle('hidden',!month);$('#listView').classList.toggle('hidden',month||diary||media);$('#diaryView').classList.toggle('hidden',!diary);$('#mediaView').classList.toggle('hidden',!media);$('#dashboardExtras').classList.toggle('hidden',diary||media);$('#pageTitle').textContent=month?'Tu calendario':diary?'Tu diario':media?'Fotos y videos':view==='upcoming'?'Próximas':'Tus actividades';document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===view));if(month)renderCalendar();else if(diary)renderDiary();else if(!media)renderList();renderDay();renderWeek();}
  function updateRepeatUntilVisibility(){$('#repeatUntilField').classList.toggle('hidden',$('#eventRepeat').value==='none');}
  function openForm(id,targetDate=null){const a=id?rows('SELECT * FROM activities WHERE id=?',[id])[0]:null;$('#eventForm').reset();$('#eventId').value=a?.id||'';$('#eventTitle').value=a?.title||'';$('#eventDate').value=a?.date||selected;$('#eventTime').value=a?.time||'09:00';$('#eventEndTime').value=a?.end_time|| (a?'':'10:00');$('#eventEndNextDay').checked=!!a?.end_next_day;$('#eventCategory').value=a?.category||'Personal';$('#eventRepeat').value=a?.repeat_rule||'none';$('#repeatUntil').value=a?.repeat_until||'';$('#eventNotes').value=a?.notes||'';deleteTargetDate=a&&targetDate&&occurs(a,targetDate)?targetDate:a&&selected>=a.date&&occurs(a,selected)?selected:a?.date||selected;$('#formHeading').textContent=a?'Editar actividad':'Nueva actividad';$('#deleteBtn').classList.toggle('hidden',!a);updateRepeatUntilVisibility();$('#eventDialog').showModal();setTimeout(()=>$('#eventTitle').focus(),50);}
  function minutes(time){const [h,m]=time.split(':').map(Number);return h*60+m;}
  function intervalOverlap(aStart,aEnd,bStart,bEnd){return aStart<bEnd&&bStart<aEnd;}
  function findTimeConflict(date,candidate,id){
    const candidateStart=minutes(candidate.time),candidateEnd=minutes(candidate.end_time)+(candidate.end_next_day?1440:0),same=onDay(date).find(a=>String(a.id)!==String(id)&&intervalOverlap(candidateStart,candidateEnd,minutes(a.time),minutes(a.end_time)+(a.end_next_day?1440:0)));
    if(same)return same;
    const previous=parse(date);previous.setDate(previous.getDate()-1);const overnight=onDay(iso(previous)).find(a=>String(a.id)!==String(id)&&a.end_next_day&&intervalOverlap(candidateStart,candidateEnd,minutes(a.time)-1440,minutes(a.end_time)));
    if(overnight)return overnight;
    if(candidate.end_next_day){const next=parse(date);next.setDate(next.getDate()+1);return onDay(iso(next)).find(a=>String(a.id)!==String(id)&&intervalOverlap(candidateStart,candidateEnd,minutes(a.time)+1440,minutes(a.end_time)+1440+(a.end_next_day?1440:0)));}
    return null;
  }
  function saveEvent(e){e.preventDefault();const id=$('#eventId').value,title=$('#eventTitle').value.trim(),date=$('#eventDate').value,time=$('#eventTime').value,endTime=$('#eventEndTime').value,endNext=$('#eventEndNextDay').checked,category=$('#eventCategory').value,repeat=$('#eventRepeat').value,repeatUntil=repeat==='none'?'':$('#repeatUntil').value,notes=$('#eventNotes').value.trim();if(!title||!date||!time||!endTime){alert('Indica el nombre, la fecha y las horas de inicio y finalización.');return;}if(endNext?minutes(endTime)>=minutes(time):minutes(endTime)<=minutes(time)){alert(endNext?'Para terminar al día siguiente, la hora final debe ser anterior a la hora inicial.':'La hora final debe ser posterior a la hora inicial. Si termina después de medianoche, marca “Termina al día siguiente”.');return;}if(repeatUntil&&repeatUntil<date){alert('La fecha final de repetición no puede ser anterior a la fecha de inicio.');return;}const candidate={id:+id||null,time,end_time:endTime,end_next_day:endNext?1:0},conflict=findTimeConflict(date,candidate,id);if(conflict&&!confirm(`Esta actividad coincide con “${conflict.title}” alrededor del ${fmt.format(parse(date))}. ¿Quieres guardarla de todos modos?`))return;const st=db.prepare(id?'UPDATE activities SET title=?,date=?,time=?,end_time=?,end_next_day=?,category=?,repeat_rule=?,repeat_until=?,notes=? WHERE id=?':'INSERT INTO activities(title,date,time,end_time,end_next_day,category,repeat_rule,repeat_until,notes) VALUES(?,?,?,?,?,?,?,?,?)');id?st.run([title,date,time,endTime,endNext?1:0,category,repeat,repeatUntil,notes,+id]):st.run([title,date,time,endTime,endNext?1:0,category,repeat,repeatUntil,notes]);st.free();selected=date;current=parse(date);persist();$('#eventDialog').close();render();}
  function toggleDone(id,day){const found=rows('SELECT completed FROM completions WHERE activity_id=? AND occurrence_date=?',[id,day])[0];if(found)sql('DELETE FROM completions WHERE activity_id=? AND occurrence_date=?',[id,day]);else sql('INSERT OR REPLACE INTO completions(activity_id,occurrence_date,completed) VALUES(?,?,1)',[id,day]);persist();render();}
  function deleteEvent(){const id=+$('#eventId').value;if(!id)return;const activity=rows('SELECT * FROM activities WHERE id=?',[id])[0];if(!activity)return;if(activity.repeat_rule!=='none'){$('#deleteOccurrenceDate').textContent=fmt.format(parse(deleteTargetDate));$('#eventDialog').close();$('#deleteScopeDialog').showModal();return;}if(!confirm('¿Eliminar esta actividad y su historial de completado?'))return;sql('DELETE FROM completions WHERE activity_id=?',[id]);sql('DELETE FROM activities WHERE id=?',[id]);persist();$('#eventDialog').close();render();}
  function deleteOccurrence(scope){const id=+$('#eventId').value,activity=rows('SELECT * FROM activities WHERE id=?',[id])[0],day=deleteTargetDate;if(!activity)return;const labels={one:'esta ocurrencia',future:'esta ocurrencia y todas las siguientes',series:'la serie completa'};if(!confirm(`¿Eliminar ${labels[scope]} de “${activity.title}”? Esta acción no se puede deshacer.`))return;if(scope==='one'){sql('INSERT OR IGNORE INTO occurrence_exceptions(activity_id,occurrence_date) VALUES(?,?)',[id,day]);sql('DELETE FROM completions WHERE activity_id=? AND occurrence_date=?',[id,day]);}else if(scope==='future'&&day>activity.date){const until=parse(day);until.setDate(until.getDate()-1);sql('UPDATE activities SET repeat_until=? WHERE id=?',[iso(until),id]);sql('DELETE FROM completions WHERE activity_id=? AND occurrence_date>=?',[id,day]);sql('DELETE FROM occurrence_exceptions WHERE activity_id=? AND occurrence_date>=?',[id,day]);}else{sql('DELETE FROM completions WHERE activity_id=?',[id]);sql('DELETE FROM occurrence_exceptions WHERE activity_id=?',[id]);sql('DELETE FROM activities WHERE id=?',[id]);}persist();$('#deleteScopeDialog').close();render();}
  function completeElapsedRecurringOccurrence(){const now=new Date(),today=parse(iso(now)),yesterday=new Date(today);yesterday.setDate(yesterday.getDate()-1);const days=[iso(today),iso(yesterday)],done=completions(),skipped=occurrenceExceptions();let changed=false;for(const a of allActivities()){if(a.repeat_rule==='none'||!a.end_time)continue;for(const day of days){if(day!==days[0]&&!a.end_next_day)continue;if(!occurs(a,day,skipped)||occurrenceEnd(a,day)>now||done.has(`${a.id}|${day}`))continue;sql('INSERT OR REPLACE INTO completions(activity_id,occurrence_date,completed) VALUES(?,?,1)',[a.id,day]);done.add(`${a.id}|${day}`);changed=true;}}if(changed)persist();return changed;}
  let notifiedMinute='';function checkReminders(){const now=new Date(),key=iso(now),minute=`${key} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;if(minute===notifiedMinute)return;notifiedMinute=minute;const changed=completeElapsedRecurringOccurrence();if(changed)render();if(!('Notification'in window)||Notification.permission!=='granted')return;const done=completions();onDay(key).filter(a=>a.time===`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`&&!occurrenceDone(a,key,done,now)).forEach(a=>new Notification('Agenda · '+a.title,{body:`Ahora · ${a.category}`,icon:'./icon.svg',tag:`${a.id}-${key}`}));}
  $('#newBtn').onclick=()=>openForm();$('#addDayBtn').onclick=()=>openForm();$('#eventForm').onsubmit=saveEvent;$('#closeDialog').onclick=$('#cancelBtn').onclick=()=>$('#eventDialog').close();$('#deleteBtn').onclick=deleteEvent;$('#eventRepeat').onchange=updateRepeatUntilVisibility;const returnToEventForm=()=>{$('#deleteScopeDialog').close();$('#eventDialog').showModal();};$('#closeDeleteScope').onclick=$('#cancelDeleteScope').onclick=returnToEventForm;$('#deleteScopeDialog').addEventListener('cancel',event=>{event.preventDefault();returnToEventForm();});$('#deleteOccurrenceBtn').onclick=()=>deleteOccurrence('one');$('#deleteFutureBtn').onclick=()=>deleteOccurrence('future');$('#deleteSeriesBtn').onclick=()=>deleteOccurrence('series');$('#prevMonth').onclick=()=>{current.setDate(1);current.setMonth(current.getMonth()-1);view='month';render();};$('#nextMonth').onclick=()=>{current.setDate(1);current.setMonth(current.getMonth()+1);view='month';render();};$('#todayBtn').onclick=()=>{current=new Date();selected=iso(current);view='month';render();};document.querySelectorAll('.nav-item').forEach(b=>b.onclick=()=>{view=b.dataset.view;render();});$('#searchInput').oninput=()=>renderList();$('#categoryFilter').onchange=()=>renderList();
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
      ensureSchema(fresh);
      db.close();db=fresh;persist();render();alert('Respaldo importado.');
    }catch(err){alert(err.message||'No se pudo importar este archivo de agenda.');console.error(err);}
    e.target.value='';
  };
  function rowsFrom(database,q){const r=database.exec(q);return r.length?r[0].values:null;}
  window.addEventListener('online',()=>{const e=$('#connectionLabel').parentElement;e.classList.remove('offline-state');$('#connectionLabel').textContent='Conectado';});window.addEventListener('offline',()=>{const e=$('#connectionLabel').parentElement;e.classList.add('offline-state');$('#connectionLabel').textContent='Sin conexión';});if(!navigator.onLine){$('#connectionLabel').parentElement.classList.add('offline-state');$('#connectionLabel').textContent='Sin conexión';}
  init().catch(e=>{console.error(e);$('#dbStatus').textContent='Error al abrir SQLite local';});
})();

