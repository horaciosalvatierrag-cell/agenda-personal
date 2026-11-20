(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const DB_KEY = 'agenda-sqlite-v1';
  const STORAGE = 'AgendaPersonalSQLite';
  let db, SQL, current = new Date(), selected = iso(new Date()), view = 'month', saveTimer, diaryTimer;
  let syncInProgress = false, syncQueue = Promise.resolve(), localMutationVersion = 0;
  let fmt,monthFmt,longDay;
  function setDateFormatters(){const locale=window.AgendaI18n?.locale||'es-MX';fmt=new Intl.DateTimeFormat(locale,{day:'numeric',month:'long',year:'numeric'});monthFmt=new Intl.DateTimeFormat(locale,{month:'long',year:'numeric'});longDay=new Intl.DateTimeFormat(locale,{weekday:'long',day:'numeric',month:'long'});}
  setDateFormatters();
  function iso(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  function parse(s) { const [y,m,d] = s.split('-').map(Number); return new Date(y,m-1,d); }
  function safe(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function sql(sql, args=[]) { return db.exec(sql, args); }
  function rows(query,args=[]) { const r=sql(query,args); if(!r.length)return []; const {columns,values}=r[0]; return values.map(v=>Object.fromEntries(columns.map((c,i)=>[c,v[i]]))); }
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
    db.run(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS activities(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,date TEXT NOT NULL,time TEXT NOT NULL DEFAULT '09:00',category TEXT NOT NULL DEFAULT 'Personal',repeat_rule TEXT NOT NULL DEFAULT 'none',notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS completions(activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,occurrence_date TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(activity_id,occurrence_date));
      CREATE TABLE IF NOT EXISTS daily_notes(date TEXT PRIMARY KEY,content TEXT NOT NULL DEFAULT '',important INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(date);`);
    window.AgendaDiaryLocal={getNotes:()=>rows('SELECT date,content,important,updated_at FROM daily_notes ORDER BY date'),mergeNotes:notes=>new Promise(resolve=>{for(const note of notes||[]){if(!/^\d{4}-\d{2}-\d{2}$/.test(note.date||'')||typeof note.content!=='string')continue;sql('INSERT OR IGNORE INTO daily_notes(date,content,important,updated_at) VALUES(?,?,?,?)',[note.date,note.content,Number(!!note.important),note.updated_at||new Date().toISOString()]);}persist(resolve,{skipSync:true});renderDiary();})};
    $('#dbStatus').textContent='Base de datos local SQLite';
    $('#todayLabel').textContent=new Intl.DateTimeFormat(window.AgendaI18n?.locale||'es-MX',{weekday:'long',day:'numeric',month:'long'}).format(new Date());
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
    const localDiaryNotes=rows('SELECT date,content,important,updated_at FROM daily_notes');
    const fresh=new SQL.Database(bytes);
    const unsafe=rowsFrom(fresh,"SELECT name FROM sqlite_master WHERE type IN ('trigger','view') OR (type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%') LIMIT 1");
    const columns=rowsFrom(fresh,'PRAGMA table_info(activities)')||[];
    if(unsafe?.length||!columns.some(c=>c[1]==='id')||!columns.some(c=>c[1]==='title')||!columns.some(c=>c[1]==='date')){fresh.close();throw new Error('La copia en la nube no tiene el esquema esperado.');}
    fresh.run("PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS completions(activity_id INTEGER NOT NULL,occurrence_date TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(activity_id,occurrence_date)); CREATE TABLE IF NOT EXISTS daily_notes(date TEXT PRIMARY KEY,content TEXT NOT NULL DEFAULT '',important INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(date);");
    for(const note of localDiaryNotes){const st=fresh.prepare('INSERT OR IGNORE INTO daily_notes(date,content,important,updated_at) VALUES(?,?,?,?)');st.run([note.date,note.content,note.important,note.updated_at]);st.free();}
    db.close();db=fresh;persist(null,{skipSync:true});render();
  }
  function exportSyncSnapshot(){const copy=new SQL.Database(db.export());try{copy.run('DELETE FROM daily_notes');return copy.export();}finally{copy.close();}}
  async function uploadCurrentSnapshot(userId,baseRevision=null){
    if(!window.AgendaAuth?.account||window.AgendaAuth.account.userId!==userId)return;
    const versionAtStart=localMutationVersion;
    const revision=baseRevision??Number(localStorage.getItem(revisionKey(userId))||0);
    const response=await window.AgendaAuth.api('/api/sync',{method:'PUT',body:JSON.stringify({baseRevision:revision,snapshot:binaryBase64(exportSyncSnapshot())})});
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
      const events=onDay(key),contactEvents=window.AgendaContacts?.getRemindersOn(key)||[],combined=[...events.map(a=>({kind:'activity',record:a})),...contactEvents.map(a=>({kind:'contact',record:a}))];html+=`<div class="day-cell ${other?'dim':''} ${key===today?'today':''} ${key===selected?'selected':''}" data-date="${key}"><div class="day-number">${d.getDate()}</div>${combined.slice(0,2).map(({kind,record:a})=>kind==='contact'?`<button type="button" class="event-pill contact-event-pill" data-contact-id="${safe(a.contactId)}" title="${safe(a.title)}">${safe(a.title)}</button>`:`<div class="event-pill ${klass(a.category)} ${done.has(`${a.id}|${key}`)?'done':''}" title="${safe(a.title)}">${safe(a.title)}</div>`).join('')}${combined.length>2?`<div class="more-events">+${combined.length-2} más</div>`:''}</div>`;
    }
    $('#calendarGrid').innerHTML=html;$('#calendarGrid').querySelectorAll('.day-cell').forEach(el=>el.onclick=()=>{selected=el.dataset.date;render();});$('#calendarGrid').querySelectorAll('[data-contact-id]').forEach(el=>el.onclick=e=>{e.stopPropagation();window.AgendaContacts?.openContact(el.dataset.contactId);});
  }
  function entry(a,day){const done=completions().has(`${a.id}|${day}`);return `<div class="day-entry"><span class="day-time">${a.time||'Todo el día'}</span><i class="day-bar ${klass(a.category)}"></i><div><div class="entry-title ${done?'is-done':''}">${safe(a.title)}</div><div class="entry-meta">${safe(a.category)}${a.repeat_rule!=='none'?' · Se repite':''}</div></div><button class="done-toggle ${done?'done':''}" data-id="${a.id}" data-day="${day}" title="${done?'Marcar pendiente':'Marcar completada'}">${done?'✓':''}</button></div>`;}
  function renderDay(){const d=parse(selected);$('#selectedDayTitle').textContent=longDay.format(d);const list=onDay(selected),contactEvents=window.AgendaContacts?.getRemindersOn(selected)||[];$('#dayList').innerHTML=list.length||contactEvents.length?[...list.map(a=>entry(a,selected)),...contactEvents.map(a=>`<button type="button" class="day-entry contact-day-entry" data-contact-id="${safe(a.contactId)}"><span class="day-time">${safe(a.time||'')}</span><i class="day-bar contact-day-bar"></i><span><span class="entry-title">${safe(a.title)}</span><span class="entry-meta">Recordatorio de contacto</span></span><span>›</span></button>`)].join(''):'<div class="empty">Sin actividades para este día.<br>Un buen momento para planear algo.</div>';$('#dayList').querySelectorAll('.done-toggle').forEach(b=>b.onclick=()=>toggleDone(+b.dataset.id,b.dataset.day));$('#dayList').querySelectorAll('[data-contact-id]').forEach(b=>b.onclick=()=>window.AgendaContacts?.openContact(b.dataset.contactId));}
  function renderList(){let items=allActivities();if(view==='upcoming')items=items.filter(a=>a.date>=iso(new Date())||a.repeat_rule!=='none');const term=$('#searchInput').value.trim().toLocaleLowerCase('es');const cat=$('#categoryFilter').value;if(term)items=items.filter(a=>`${a.title} ${a.notes}`.toLocaleLowerCase('es').includes(term));if(cat)items=items.filter(a=>a.category===cat);const allContactItems=view==='upcoming'?(window.AgendaContacts?.getUpcoming()||[]):[],contactItems=allContactItems.filter(r=>!term||r.title.toLocaleLowerCase('es').includes(term));$('#listHeading').textContent=view==='upcoming'?'Próximas actividades':'Todas las actividades';const activityHtml=items.map(a=>`<div class="list-row"><span class="list-date">${safe(fmt.format(parse(a.date)))}</span><div><strong>${safe(a.title)}</strong><small>${safe(a.time)} · ${safe(a.category)}${a.repeat_rule!=='none'?' · Recurrente':''}</small></div><span class="category-tag">${safe(a.category)}</span><button class="list-edit" data-id="${a.id}" title="Editar">···</button></div>`).join('');const contactHtml=contactItems.map(r=>`<button type="button" class="list-row contact-upcoming" data-contact-id="${safe(r.contactId)}"><span class="list-date">${safe(fmt.format(parse(r.date)))}</span><span><strong>${safe(r.title)}</strong><small>${safe(r.time||'')} · Recordatorio local</small></span><span class="category-tag">Contacto</span><span>›</span></button>`).join('');$('#activityList').innerHTML=activityHtml+contactHtml||(view==='upcoming'?'':'<div class="empty">No hay actividades todavía. Agrega la primera cuando quieras.</div>');$('#activityList').querySelectorAll('.list-edit').forEach(b=>b.onclick=()=>openForm(+b.dataset.id));$('#activityList').querySelectorAll('[data-contact-id]').forEach(b=>b.onclick=()=>window.AgendaContacts?.openContact(b.dataset.contactId));$('#upcomingCount').textContent=(allActivities().filter(a=>a.date>=iso(new Date())||a.repeat_rule!=='none').length+allContactItems.length)||'';}
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
  let libraryRows=[], photoPage=1, photoPageCount=0, photoTotal=0, photoSelectedIndex=-1, photoViewerUrl='', photoThumbUrls=new Map(), photoLibraryLoaded=false, photoGalleryPromise=null, photoImportMessage='', photoViewerReturnScroll=0, photoPageRequest=0;
  const photoPageSize=60;
  const photoExtensions=new Set(['jpg','jpeg','png','webp','gif','heic','heif','avif','bmp','tif','tiff','apng','jfif']);
  function isPhoto(file){const ext=file.name.split('.').pop().toLowerCase();return file.type.toLowerCase().startsWith('image/')&&!file.type.toLowerCase().includes('svg')||photoExtensions.has(ext);}
  function bytesLabel(bytes){if(bytes==null)return '—';const units=['B','KB','MB','GB'];let value=bytes,index=0;while(value>=1024&&index<units.length-1){value/=1024;index++;}return `${value.toFixed(index?1:0)} ${units[index]}`;}
  async function updatePhotoStatus(extra=''){
    try{const d=await window.AgendaPhotoLibrary.diagnostics();photoTotal=d.total;photoPageCount=Math.ceil(photoTotal/photoPageSize);const storage=d.usage==null?'':` · Almacenamiento ${bytesLabel(d.usage)}${d.quota?` de ${bytesLabel(d.quota)}`:''}`;const persistence=d.persistent===true?' · almacenamiento persistente concedido':d.persistent===false?' · el navegador puede administrar este almacenamiento':'';const pageLabel=photoTotal?` · Página ${photoPage} de ${photoPageCount}`:'';$('#mediaStatus').textContent=`${photoTotal.toLocaleString()} fotografías · ${d.thumbnails.toLocaleString()} miniaturas · ${d.originals.toLocaleString()} originales · ${d.pending.toLocaleString()} pendientes${pageLabel}${storage}${persistence}${extra?` · ${extra}`:''}`;}
    catch(error){console.warn('No se pudieron consultar los datos de la galería:',error);$('#mediaStatus').textContent=extra||'No se pudo consultar la galería local.';}
  }
  function revokePhotoThumbnailUrls(){for(const url of photoThumbUrls.values())URL.revokeObjectURL(url);photoThumbUrls.clear();}
  function renderPhotoPagination(){const nav=$('#mediaPagination');if(photoPageCount<=1){nav.classList.add('hidden');nav.replaceChildren();return;}nav.classList.remove('hidden');const start=Math.max(1,photoPage-2),end=Math.min(photoPageCount,photoPage+2),pages=new Set([1,photoPageCount]);for(let n=start;n<=end;n++)pages.add(n);const ordered=[...pages].sort((a,b)=>a-b),parts=[];const add=(label,page,disabled=false,current=false)=>parts.push(`<button type="button" class="media-page-button${current?' current':''}" data-page="${page}" ${disabled?'disabled':''} ${current?'aria-current="page"':''}>${label}</button>`);add('«',1,photoPage===1);add('‹',Math.max(1,photoPage-1),photoPage===1);let last=0;for(const page of ordered){if(last&&page-last>1)parts.push('<span class="media-page-ellipsis" aria-hidden="true">…</span>');add(String(page),page,false,page===photoPage);last=page;}add('›',Math.min(photoPageCount,photoPage+1),photoPage===photoPageCount);add('»',photoPageCount,photoPage===photoPageCount);nav.innerHTML=parts.join('');}
  async function loadPhotoThumbnails(rows){const generation=photoPage;for(let offset=0;offset<rows.length;offset+=8){const batch=rows.slice(offset,offset+8);await Promise.all(batch.map(async row=>{const image=$(`#mediaGrid img[data-photo-id="${row.id}"]`);if(!image)return;try{const blob=await window.AgendaPhotoLibrary.getThumbnail(row.id);if(!blob||blob.size===0)throw new Error('Miniatura ausente');const url=URL.createObjectURL(blob);if(generation!==photoPage){URL.revokeObjectURL(url);return;}photoThumbUrls.set(row.id,url);image.src=url;image.dataset.ready='true';image.onerror=()=>{URL.revokeObjectURL(url);photoThumbUrls.delete(row.id);image.removeAttribute('src');delete image.dataset.ready;image.closest('.library-photo-card')?.classList.add('thumbnail-error');};}catch{image.closest('.library-photo-card')?.classList.add('thumbnail-error');image.alt='Miniatura no disponible';}}));}}
  async function loadPhotoPage(page=1,{keepViewer=false,focusId=''}={}){
    try{
      const requestToken=++photoPageRequest,result=await window.AgendaPhotoLibrary.getPage(page,photoPageSize);if(requestToken!==photoPageRequest)return;photoPage=result.page;photoPageCount=result.pageCount;photoTotal=result.total;libraryRows=result.rows;
      revokePhotoThumbnailUrls();
      $('#mediaGrid').innerHTML=libraryRows.length?libraryRows.map((row,index)=>`<button type="button" class="library-photo-card${row.id===focusId?' selected':''}" data-photo-index="${index}" aria-label="Ver ${safe(row.name)}"><span class="library-photo-image"><img data-photo-id="${row.id}" loading="lazy" decoding="async" alt="${safe(row.name)}"><span class="library-photo-placeholder">Cargando miniatura…</span></span><span class="library-photo-caption" title="${safe(row.name)}">${safe(row.name)}</span></button>`).join(''):'<p class="media-empty">Todavía no hay fotos. Pulsa «Elegir fotos» para crear tu galería.</p>';
      renderPhotoPagination();photoLibraryLoaded=true;await loadPhotoThumbnails(libraryRows);await updatePhotoStatus(photoImportMessage);
      if(keepViewer&&photoSelectedIndex>=0)await showSelectedPhoto(photoSelectedIndex);
      return result;
    }catch(error){console.error('No se pudo recuperar la galería:',error);$('#mediaStatus').textContent='No se pudo abrir la galería local. Tus fotografías guardadas no se han eliminado.';}
  }
  async function addSelectedPhotos(fileList){
    const files=[...fileList].filter(isPhoto);if(!files.length){$('#mediaStatus').textContent='Selecciona uno o varios archivos de imagen compatibles.';return;}
    photoImportMessage=`Preparando ${files.length.toLocaleString()} archivos…`;try{await window.AgendaPhotoLibrary.open();await window.AgendaPhotoLibrary.requestPersistence();}catch(error){photoImportMessage='';$('#mediaStatus').textContent=`No se pudo abrir el almacenamiento local: ${error.message||error}`;return;}
    let added=0,duplicates=0,failed=0,processed=0;const errors=[];const refreshStatus=()=>{photoImportMessage=`Incorporando ${processed.toLocaleString()} de ${files.length.toLocaleString()} · ${added} agregadas · ${duplicates} duplicadas · ${failed} con error`;updatePhotoStatus(photoImportMessage);};
    for(const file of files){processed++;try{
      const id=await window.AgendaPhotoLibrary.fingerprint(file);if(await window.AgendaPhotoLibrary.get(id)){duplicates++;}
      else{
        const estimate=await navigator.storage?.estimate?.().catch(()=>null);if(estimate?.quota&&estimate?.usage!=null&&estimate.quota-estimate.usage<file.size+65536)throw new DOMException('Espacio local insuficiente para guardar el original y su miniatura.','QuotaExceededError');
        const staged=await window.AgendaPhotoLibrary.stagePhoto({id,name:file.name,mime:file.type||'application/octet-stream',size:file.size,lastModified:file.lastModified,original:file});
        if(staged.duplicate)duplicates++;else{const pending=await window.AgendaPhotoLibrary.getPending(id);if(pending){if(await finishPendingPhoto(pending,file))added++;else failed++;}else if(staged.alreadyPending)duplicates++;}
      }
    }catch(error){failed++;errors.push(`${file.name}: ${error.message||error}`);if(error.name==='QuotaExceededError'||/quota|espacio local/i.test(error.message||'')){photoImportMessage='Almacenamiento insuficiente. Se detuvo la incorporación; las fotos ya guardadas permanecen intactas.';refreshStatus();break;}}
      if(processed%100===0||processed===files.length){photoImportMessage=`Incorporando ${processed.toLocaleString()} de ${files.length.toLocaleString()} · ${added} agregadas · ${duplicates} duplicadas · ${failed} con error`;await updatePhotoStatus(photoImportMessage);if(added&&added%1000<100)await loadPhotoPage(1);}
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    photoImportMessage=`Proceso terminado: ${added} agregadas · ${duplicates} duplicadas omitidas · ${failed} con error${errors.length?` · ${errors[0]}`:''}`;await loadPhotoPage(1);$('#mediaGrid').scrollIntoView({block:'start',behavior:'smooth'});
  }
  async function finishPendingPhoto(pending,original=null){const source=original||await window.AgendaPhotoLibrary.getOriginal(pending.id);if(!source)throw new Error('Falta el original guardado de una incorporación pendiente.');const estimate=await navigator.storage?.estimate?.().catch(()=>null);if(estimate?.quota&&estimate?.usage!=null&&estimate.quota-estimate.usage<65536)throw new DOMException('Espacio insuficiente para guardar la miniatura pendiente.','QuotaExceededError');const thumb=await window.AgendaPhotoLibrary.makeThumbnail(source);await window.AgendaPhotoLibrary.completePending(pending.id,thumb.blob);if(!await window.AgendaPhotoLibrary.verify(pending.id))throw new Error('No se pudo verificar el original y la miniatura guardados.');return true;}
  async function resumePendingPhotos(){let pending=await window.AgendaPhotoLibrary.getFirstPending(),resumed=0;while(pending){photoImportMessage=`Recuperando una incorporación interrumpida: ${pending.name}`;try{await finishPendingPhoto(pending);resumed++;}catch(error){photoImportMessage=`Queda una foto pendiente (${pending.name}): ${error.message||error}`;await updatePhotoStatus(photoImportMessage);break;}pending=await window.AgendaPhotoLibrary.getFirstPending();if(resumed%25===0){await loadPhotoPage(1);await new Promise(resolve=>setTimeout(resolve,0));}}if(resumed){await loadPhotoPage(1);photoImportMessage=`Se recuperaron ${resumed} fotografías pendientes.`;await updatePhotoStatus(photoImportMessage);}}
  function openPhotoViewer(index){photoSelectedIndex=(photoPage-1)*photoPageSize+index;photoViewerReturnScroll=window.scrollY;showSelectedPhoto(photoSelectedIndex);}
  async function showSelectedPhoto(globalIndex){
    if(globalIndex<0||globalIndex>=photoTotal)return;const targetPage=Math.floor(globalIndex/photoPageSize)+1;if(targetPage!==photoPage){photoSelectedIndex=globalIndex;await loadPhotoPage(targetPage,{focusId:''});}
    const localIndex=globalIndex-(photoPage-1)*photoPageSize,row=libraryRows[localIndex];if(!row)return;photoSelectedIndex=globalIndex;$('#mediaGrid .library-photo-card.selected')?.classList.remove('selected');$(`#mediaGrid [data-photo-index="${localIndex}"]`)?.classList.add('selected');const viewer=$('#mediaViewer'),preview=$('#mediaPreview');if(photoViewerUrl)URL.revokeObjectURL(photoViewerUrl);photoViewerUrl='';preview.removeAttribute('src');viewer.classList.remove('hidden');$('#mediaPreviewCaption').textContent=`${row.name} · ${bytesLabel(row.size)}`;$('#mediaPrevious').disabled=globalIndex<=0;$('#mediaNext').disabled=globalIndex>=photoTotal-1;
    try{const blob=await window.AgendaPhotoLibrary.getOriginal(row.id)||await window.AgendaPhotoLibrary.getThumbnail(row.id);if(!blob)throw new Error('No se encontró una imagen almacenada.');photoViewerUrl=URL.createObjectURL(blob);preview.src=photoViewerUrl;preview.alt=row.name;}catch(error){console.error('No se pudo abrir la imagen:',error);$('#mediaPreviewCaption').textContent=`${row.name} · No se pudo recuperar el archivo local`;}
  }
  function closePhotoViewer(){const viewer=$('#mediaViewer');if(viewer.classList.contains('hidden'))return;viewer.classList.add('hidden');const preview=$('#mediaPreview');preview.removeAttribute('src');if(photoViewerUrl)URL.revokeObjectURL(photoViewerUrl);photoViewerUrl='';window.scrollTo({top:photoViewerReturnScroll,behavior:'auto'});const localIndex=photoSelectedIndex-(photoPage-1)*photoPageSize;$('#mediaGrid [data-photo-index="'+localIndex+'"]')?.focus({preventScroll:true});}
  function ensurePhotoGallery(){if(photoLibraryLoaded||photoGalleryPromise)return;photoGalleryPromise=loadPhotoPage(1).then(()=>resumePendingPhotos()).finally(()=>{photoGalleryPromise=null;});}
  function installationHelp(){const ua=navigator.userAgent,ios=/iPad|iPhone|iPod/.test(ua),android=/Android/i.test(ua);$('#installInstructions').textContent=ios?'En Safari, toca Compartir (el cuadro con la flecha hacia arriba), elige “Añadir a pantalla de inicio” y confirma con “Añadir”.':android?'En Chrome, abre el menú ⋮ y toca “Instalar aplicación” o “Añadir a pantalla principal”. Confirma para poner Agenda en el inicio.': 'Abre el menú de instalación de tu navegador (normalmente el icono junto a la barra de dirección o el menú) y selecciona “Instalar Agenda”.';if(!$('#installDialog').open)$('#installDialog').showModal();}
  function updateInstallButton(){const installed=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;$('#installBtnLabel').textContent=installed?'Instalada':'Instalar app';$('#installBtn').disabled=installed;}
  function renderWeek(){const today=new Date(),monday=new Date(today);monday.setDate(today.getDate()-((today.getDay()+6)%7));let count=0,bits='';for(let i=0;i<7;i++){const d=new Date(monday);d.setDate(monday.getDate()+i);const has=onDay(iso(d)).length>0;if(has)count++;bits+=`<i class="${has?'has':''}"></i>`;}$('#weekSummary').textContent=`${count} ${count===1?'día con actividad':'días con actividad'}`;$('#weekDots').innerHTML=bits;}
  function render(){if(view!=='diary')flushDiary();const month=view==='month',diary=view==='diary',media=view==='media',finance=view==='finance',vault=view==='vault',contacts=view==='contacts';if(!vault)window.AgendaVault?.lock();$('#calendarView').classList.toggle('hidden',!month);$('#listView').classList.toggle('hidden',month||diary||media||finance||vault||contacts);$('#diaryView').classList.toggle('hidden',!diary);$('#mediaView').classList.toggle('hidden',!media);$('#financeView').classList.toggle('hidden',!finance);$('#vaultView').classList.toggle('hidden',!vault);$('#contactsView').classList.toggle('hidden',!contacts);$('#dashboardExtras').classList.toggle('hidden',diary||media||finance||vault||contacts);$('#pageTitle').textContent=month?'Tu calendario':diary?'Tu diario':media?'Imágenes':finance?'Finanzas personales':vault?'Bóveda de contraseñas':contacts?'Contactos':view==='upcoming'?'Próximas':'Tus actividades';document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===view));if(month)renderCalendar();else if(diary)renderDiary();else if(finance)window.AgendaFinance?.render();else if(vault)window.AgendaVault?.render();else if(contacts)window.AgendaContacts?.render?.();else if(!media)renderList();if(media)ensurePhotoGallery();if(!finance&&!vault&&!contacts){renderDay();renderWeek();}}
  function openForm(id){const a=id?rows('SELECT * FROM activities WHERE id=?',[id])[0]:null;$('#eventForm').reset();$('#eventId').value=a?.id||'';$('#eventTitle').value=a?.title||'';$('#eventDate').value=a?.date||selected;$('#eventTime').value=a?.time||'09:00';$('#eventCategory').value=a?.category||'Personal';$('#eventRepeat').value=a?.repeat_rule||'none';$('#eventNotes').value=a?.notes||'';$('#formHeading').textContent=a?'Editar actividad':'Nueva actividad';$('#deleteBtn').classList.toggle('hidden',!a);$('#eventDialog').showModal();setTimeout(()=>$('#eventTitle').focus(),50);}
  function saveEvent(e){e.preventDefault();const id=$('#eventId').value,title=$('#eventTitle').value.trim(),date=$('#eventDate').value,time=$('#eventTime').value||'09:00',category=$('#eventCategory').value,repeat=$('#eventRepeat').value,notes=$('#eventNotes').value.trim();if(!title||!date)return;const st=db.prepare(id?'UPDATE activities SET title=?,date=?,time=?,category=?,repeat_rule=?,notes=? WHERE id=?':'INSERT INTO activities(title,date,time,category,repeat_rule,notes) VALUES(?,?,?,?,?,?)');id?st.run([title,date,time,category,repeat,notes,+id]):st.run([title,date,time,category,repeat,notes]);st.free();selected=date;current=parse(date);persist();$('#eventDialog').close();render();}
  function toggleDone(id,day){const found=rows('SELECT completed FROM completions WHERE activity_id=? AND occurrence_date=?',[id,day])[0];if(found)sql('DELETE FROM completions WHERE activity_id=? AND occurrence_date=?',[id,day]);else sql('INSERT OR REPLACE INTO completions(activity_id,occurrence_date,completed) VALUES(?,?,1)',[id,day]);persist();render();}
  function deleteEvent(){const id=+$('#eventId').value;if(!id)return;if(!confirm('¿Eliminar esta actividad y su historial de completado?'))return;sql('DELETE FROM completions WHERE activity_id=?',[id]);sql('DELETE FROM activities WHERE id=?',[id]);persist();$('#eventDialog').close();render();}
  let notifiedMinute='';function checkReminders(){if(!('Notification'in window)||Notification.permission!=='granted')return;const now=new Date(),key=iso(now),minute=`${key} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;if(minute===notifiedMinute)return;notifiedMinute=minute;onDay(key).filter(a=>a.time===`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`&&!completions().has(`${a.id}|${key}`)).forEach(a=>new Notification(`${window.AgendaI18n?.t('Agenda')||'Agenda'} · ${a.title}`,{body:`${window.AgendaI18n?.t('Ahora')||'Ahora'} · ${window.AgendaI18n?.t(a.category)||a.category}`,icon:'./icon.svg',tag:`${a.id}-${key}`}));}
  $('#newBtn').onclick=()=>openForm();$('#addDayBtn').onclick=()=>openForm();$('#eventForm').onsubmit=saveEvent;$('#closeDialog').onclick=$('#cancelBtn').onclick=()=>$('#eventDialog').close();$('#deleteBtn').onclick=deleteEvent;$('#prevMonth').onclick=()=>{current.setDate(1);current.setMonth(current.getMonth()-1);view='month';render();};$('#nextMonth').onclick=()=>{current.setDate(1);current.setMonth(current.getMonth()+1);view='month';render();};$('#todayBtn').onclick=()=>{current=new Date();selected=iso(current);view='month';render();};document.querySelectorAll('.nav-item').forEach(b=>b.onclick=()=>{view=b.dataset.view;render();});$('#searchInput').oninput=()=>renderList();$('#categoryFilter').onchange=()=>renderList();window.addEventListener('agenda-contacts-updated',()=>{if(!db)return;if(view==='month')renderCalendar();if(view==='upcoming')renderList();if(view!=='contacts')renderDay();});
  window.addEventListener('agenda-language-changed',()=>{setDateFormatters();$('#todayLabel').textContent=new Intl.DateTimeFormat(window.AgendaI18n.locale,{weekday:'long',day:'numeric',month:'long'}).format(new Date());$('#monthTitle').textContent=monthFmt.format(current);$('#diaryDateLabel').textContent=longDay.format(parse(selected));$('#selectedDayTitle').textContent=longDay.format(parse(selected));if(view==='month')renderCalendar();if(view==='list'||view==='upcoming')renderList();renderDay();window.AgendaFinance?.localizeDates?.();window.AgendaContacts?.localizeDates?.();});
  $('#diarySaveBtn').onclick=()=>{if(diaryTimer)flushDiary();else saveDiary();};$('#diaryContent').oninput=scheduleDiarySave;$('#diaryImportant').onchange=scheduleDiarySave;$('#diaryDate').onchange=e=>{if(e.target.value)switchDiaryDate(e.target.value);};$('#prevDiaryDay').onclick=()=>{const d=parse(selected);d.setDate(d.getDate()-1);switchDiaryDate(iso(d));};$('#nextDiaryDay').onclick=()=>{const d=parse(selected);d.setDate(d.getDate()+1);switchDiaryDate(iso(d));};$('#todayDiaryBtn').onclick=()=>switchDiaryDate(iso(new Date()));
  $('#installBtn').onclick=async()=>{if(deferredInstallPrompt){const prompt=deferredInstallPrompt;deferredInstallPrompt=null;await prompt.prompt();await prompt.userChoice;updateInstallButton();}else installationHelp();};$('#closeInstallDialog').onclick=()=>$('#installDialog').close();updateInstallButton();window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();deferredInstallPrompt=event;});window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;updateInstallButton();});
  $('#pickMediaBtn').onclick=()=>$('#mediaFiles').click();$('#mediaFiles').onchange=async event=>{const files=[...event.target.files];event.target.value='';if(files.length)await addSelectedPhotos(files);};
  $('#mediaGrid').addEventListener('click',event=>{const button=event.target.closest('[data-photo-index]');if(button)openPhotoViewer(Number(button.dataset.photoIndex));});
  $('#mediaPagination').addEventListener('click',event=>{const button=event.target.closest('[data-page]');if(button&&!button.disabled)loadPhotoPage(Number(button.dataset.page));});
  $('#closeMediaViewer').onclick=closePhotoViewer;$('#mediaViewer').addEventListener('click',event=>{if(event.target===$('#mediaViewer'))closePhotoViewer();});
  $('#mediaPrevious').onclick=()=>{if(photoSelectedIndex>0)showSelectedPhoto(photoSelectedIndex-1);};$('#mediaNext').onclick=()=>{if(photoSelectedIndex<photoTotal-1)showSelectedPhoto(photoSelectedIndex+1);};
  window.addEventListener('keydown',event=>{if($('#mediaViewer').classList.contains('hidden'))return;if(event.key==='Escape'){event.preventDefault();closePhotoViewer();}else if(event.key==='ArrowLeft'&&photoSelectedIndex>0){event.preventDefault();showSelectedPhoto(photoSelectedIndex-1);}else if(event.key==='ArrowRight'&&photoSelectedIndex<photoTotal-1){event.preventDefault();showSelectedPhoto(photoSelectedIndex+1);}});
  let photoViewerSwipeX=null;$('#mediaViewerStage').addEventListener('pointerdown',event=>{photoViewerSwipeX=event.pointerType==='touch'?event.clientX:null;});$('#mediaViewerStage').addEventListener('pointerup',event=>{if(photoViewerSwipeX==null)return;const delta=event.clientX-photoViewerSwipeX;photoViewerSwipeX=null;if(Math.abs(delta)<55)return;if(delta<0&&photoSelectedIndex<photoTotal-1)showSelectedPhoto(photoSelectedIndex+1);else if(delta>0&&photoSelectedIndex>0)showSelectedPhoto(photoSelectedIndex-1);});$('#mediaViewerStage').addEventListener('pointercancel',()=>{photoViewerSwipeX=null;});
  window.addEventListener('pagehide',()=>{revokePhotoThumbnailUrls();if(photoViewerUrl)URL.revokeObjectURL(photoViewerUrl);});
  $('#notifyBtn').onclick=async()=>{if(!('Notification'in window)){alert('Este navegador no admite notificaciones.');return;}const p=await Notification.requestPermission();$('.notify-dot').classList.toggle('granted',p==='granted');if(p==='granted')new Notification(window.AgendaI18n?.t('Notificaciones activadas')||'Notificaciones activadas',{body:window.AgendaI18n?.t('La agenda avisará mientras esté abierta en este dispositivo.')||'La agenda avisará mientras esté abierta en este dispositivo.',icon:'./icon.svg'});};
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
