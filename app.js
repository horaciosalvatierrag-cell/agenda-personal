(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const DB_KEY = 'agenda-sqlite-v1';
  const STORAGE = 'AgendaPersonalSQLite';
  let db, SQL, current = new Date(), selected = iso(new Date()), view = 'month', saveTimer, diaryTimer;
  let syncInProgress = false, syncQueue = Promise.resolve(), localMutationVersion = 0;
  let mediaUrls = [], mediaDrag = null, mediaClickGuard = false, mediaResizeFrame = 0;
  let photoFolderDb, photoFolderHandle=null, photoFolderPersisted=false, photoDirectoryAttempted=false, photoDirectoryGeneration=0, photoFiles=[], photoThumbObserver=null, photoThumbQueue=Promise.resolve(), photoThumbUrls=new Map(), photoPreviewUrl='', photoSelectedIndex=-1, photoTrackDrag=null, photoTrackClickGuard=false;
  const fmt = new Intl.DateTimeFormat('es-MX', { day:'numeric', month:'long', year:'numeric' });
  const monthFmt = new Intl.DateTimeFormat('es-MX', { month:'long', year:'numeric' });
  const longDay = new Intl.DateTimeFormat('es-MX', { weekday:'long', day:'numeric', month:'long' });
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
    fresh.run("PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS completions(activity_id INTEGER NOT NULL,occurrence_date TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(activity_id,occurrence_date)); CREATE TABLE IF NOT EXISTS daily_notes(date TEXT PRIMARY KEY,content TEXT NOT NULL DEFAULT '',important INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(date);");
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
  function clearMedia({forgetFolder=false}={}){for(const url of mediaUrls)URL.revokeObjectURL(url);mediaUrls=[];releasePhotoUrls();photoFiles=[];photoFolderHandle=null;photoFolderPersisted=false;photoSelectedIndex=-1;$('#mediaGrid').innerHTML='';$('#mediaGrid').scrollLeft=0;$('#mediaGrid').classList.remove('hidden');$('#mediaView').classList.remove('directory-mode');$('#mediaViewer').classList.add('hidden');$('#mediaPreview').removeAttribute('src');$('#folderGallery').classList.add('hidden');$('#folderGalleryTrack').replaceChildren();$('#folderGalleryCount').textContent='';$('#mediaFiles').value='';$('#mediaFolder').value='';$('#mediaStatus').textContent='Selecciona fotos, videos o una carpeta para visualizarlos.';$('#clearMediaBtn').classList.add('hidden');if(forgetFolder)forgetPhotoFolder().catch(console.error);}
  function releasePhotoUrls(){photoDirectoryGeneration++;photoThumbObserver?.disconnect();photoThumbObserver=null;for(const url of photoThumbUrls.values())URL.revokeObjectURL(url);photoThumbUrls.clear();if(photoPreviewUrl)URL.revokeObjectURL(photoPreviewUrl);photoPreviewUrl='';}
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
  const PHOTO_DB='AgendaPhotoFolder', PHOTO_STORE='handles', PHOTO_KEY='selected-directory';
  const photoExtensions=new Set(['jpg','jpeg','png','webp','gif','heic','heif']);
  function isPhoto(file){const ext=file.name.split('.').pop().toLowerCase();return photoExtensions.has(ext)||(file.type.toLowerCase().startsWith('image/')&&!file.type.toLowerCase().includes('svg'));}
  function openPhotoFolderDb(){if(photoFolderDb)return Promise.resolve(photoFolderDb);return new Promise((resolve,reject)=>{const req=indexedDB.open(PHOTO_DB,1);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(PHOTO_STORE))req.result.createObjectStore(PHOTO_STORE);};req.onsuccess=()=>{photoFolderDb=req.result;resolve(photoFolderDb);};req.onerror=()=>reject(req.error);});}
  async function readPhotoFolderHandle(){const database=await openPhotoFolderDb();return new Promise((resolve,reject)=>{const tx=database.transaction(PHOTO_STORE,'readonly'),req=tx.objectStore(PHOTO_STORE).get(PHOTO_KEY);req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error);});}
  async function savePhotoFolderHandle(handle){const database=await openPhotoFolderDb();return new Promise((resolve,reject)=>{const tx=database.transaction(PHOTO_STORE,'readwrite');tx.objectStore(PHOTO_STORE).put(handle,PHOTO_KEY);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('No se pudo recordar la carpeta.'));});}
  async function forgetPhotoFolder(){photoFolderHandle=null;photoDirectoryAttempted=false;try{const database=await openPhotoFolderDb();await new Promise((resolve,reject)=>{const tx=database.transaction(PHOTO_STORE,'readwrite');tx.objectStore(PHOTO_STORE).delete(PHOTO_KEY);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}catch(error){console.warn('No se pudo olvidar el acceso guardado:',error);}}
  async function collectDirectoryImages(directory,prefix='',result=[],generation=photoDirectoryGeneration){for await(const entry of directory.values()){if(generation!==photoDirectoryGeneration)throw new DOMException('La selección cambió.','AbortError');const path=prefix?`${prefix}/${entry.name}`:entry.name;if(entry.kind==='directory')await collectDirectoryImages(entry,path,result,generation);else if(entry.kind==='file'&&photoExtensions.has(entry.name.split('.').pop().toLowerCase()))result.push({name:entry.name,path,handle:entry});}return result;}
  async function photoItemFile(item){return item.file||item.handle.getFile();}
  function makePhotoThumbnail(file){return new Promise(async resolve=>{if(!('createImageBitmap'in window)||!document.createElement('canvas').toBlob){resolve(file);return;}let bitmap;try{bitmap=await createImageBitmap(file);const scale=Math.min(1,360/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));canvas.getContext('2d',{alpha:false}).drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();canvas.toBlob(blob=>resolve(blob||file),'image/jpeg',0.78);}catch{bitmap?.close();resolve(file);}});}
  function observePhotoThumbnails(generation){const track=$('#folderGalleryTrack'),queue=index=>{if(photoThumbUrls.has(index))return;photoThumbQueue=photoThumbQueue.then(()=>loadPhotoThumbnail(index,generation)).catch(error=>console.warn('No se pudo preparar una miniatura:',error));};if(!('IntersectionObserver'in window)){const visible=()=>track.querySelectorAll('[data-photo-index]').forEach(img=>{const rect=img.getBoundingClientRect(),bounds=track.getBoundingClientRect();if(rect.right>=bounds.left-360&&rect.left<=bounds.right+360)queue(Number(img.dataset.photoIndex));});track.onscroll=visible;visible();return;}track.onscroll=null;photoThumbObserver=new IntersectionObserver(entries=>{for(const entry of entries){const index=Number(entry.target.dataset.photoIndex);if(entry.isIntersecting)queue(index);else if(index!==photoSelectedIndex&&photoThumbUrls.has(index)){URL.revokeObjectURL(photoThumbUrls.get(index));photoThumbUrls.delete(index);entry.target.removeAttribute('src');}}},{root:track,rootMargin:'0px 360px',threshold:0.01});track.querySelectorAll('[data-photo-index]').forEach(img=>photoThumbObserver.observe(img));}
  async function loadPhotoThumbnail(index,generation){if(generation!==photoDirectoryGeneration||photoThumbUrls.has(index))return;const item=photoFiles[index],image=$(`[data-photo-index="${index}"]`),track=$('#folderGalleryTrack');if(!item||!image)return;const visible=()=>{const a=image.getBoundingClientRect(),b=track.getBoundingClientRect();return a.right>=b.left-360&&a.left<=b.right+360;};if(!visible())return;try{const file=await photoItemFile(item);if(generation!==photoDirectoryGeneration||!visible())return;const thumb=await makePhotoThumbnail(file);if(generation!==photoDirectoryGeneration||!visible())return;const url=URL.createObjectURL(thumb);photoThumbUrls.set(index,url);image.src=url;image.onload=()=>{image.onload=null;};image.onerror=()=>{image.onerror=null;URL.revokeObjectURL(url);photoThumbUrls.delete(index);image.closest('.folder-thumb')?.remove();$('#folderGalleryCount').textContent=`${$('#folderGalleryTrack').children.length} imágenes compatibles`;if(photoSelectedIndex===index)$('#mediaStatus').textContent=`Este navegador no puede interpretar ${item.name}. Se omitió la miniatura.`;};}catch(error){if(error.name!=='AbortError')console.warn('No se pudo leer una imagen:',error);}}
  async function selectDirectoryPhoto(index,generation=photoDirectoryGeneration){const item=photoFiles[index];if(!item||generation!==photoDirectoryGeneration)return;try{const file=await photoItemFile(item);if(generation!==photoDirectoryGeneration)return;if(photoPreviewUrl)URL.revokeObjectURL(photoPreviewUrl);photoPreviewUrl=URL.createObjectURL(file);photoSelectedIndex=index;const track=$('#folderGalleryTrack'),trackRect=track.getBoundingClientRect();for(const [thumbIndex,url] of photoThumbUrls){if(thumbIndex===index)continue;const img=track.querySelector(`[data-photo-index="${thumbIndex}"]`),rect=img?.getBoundingClientRect();if(img&&(!rect||rect.right<trackRect.left-360||rect.left>trackRect.right+360)){URL.revokeObjectURL(url);photoThumbUrls.delete(thumbIndex);img.removeAttribute('src');}}const preview=$('#mediaPreview');preview.onerror=()=>{$('#mediaStatus').textContent=`El navegador no puede mostrar ${item.name}. Si es HEIC, prueba abrirla en un navegador con soporte para ese formato.`;};preview.onload=()=>{preview.onerror=null;};preview.src=photoPreviewUrl;preview.alt=item.name;$('#mediaPreviewCaption').textContent=item.path;$('#mediaViewer').classList.remove('hidden');$('#mediaGrid').classList.add('hidden');$('#folderGalleryTrack').querySelectorAll('.folder-thumb').forEach(button=>{const selected=Number(button.dataset.photoButton)===index;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));});$('#mediaStatus').textContent=`${photoFiles.length} imágenes · ${photoFolderPersisted?'Carpeta recordada en este dispositivo':'Acceso temporal; este navegador no puede recordar la carpeta'}.`;$('#clearMediaBtn').classList.remove('hidden');}catch(error){if(error.name==='NotAllowedError'||error.name==='SecurityError')$('#mediaStatus').textContent='El permiso para leer esta carpeta ya no está disponible. Pulsa «Elegir carpeta» para autorizar de nuevo.';else $('#mediaStatus').textContent=`No se pudo leer ${item.name}. Comprueba que el archivo siga disponible.`;}}
  async function showPhotoDirectory(items,{handle=null,persisted=false}={}){clearMedia();photoFolderHandle=handle;photoFolderPersisted=persisted;const generation=photoDirectoryGeneration;const images=items.filter(item=>item.file?isPhoto(item.file):photoExtensions.has(item.name.split('.').pop().toLowerCase())).sort((a,b)=>a.path.localeCompare(b.path,'es',{numeric:true}));if(!images.length){$('#mediaStatus').textContent='No se encontraron imágenes compatibles en esta carpeta.';return;}photoFiles=images;$('#mediaStatus').textContent=`${images.length} imágenes en la carpeta seleccionada.`;$('#mediaView').classList.add('directory-mode');$('#mediaGrid').classList.add('hidden');$('#folderGallery').classList.toggle('hidden',view!=='media');$('#folderGalleryCount').textContent=`${images.length} imágenes`;$('#folderGalleryTrack').innerHTML=images.map((item,index)=>`<button class="folder-thumb" type="button" data-photo-button="${index}" aria-pressed="false" aria-label="Ver ${safe(item.name)}"><img data-photo-index="${index}" alt="" loading="lazy" decoding="async" draggable="false"><span>${safe(item.name)}</span></button>`).join('');observePhotoThumbnails(generation);await selectDirectoryPhoto(0,generation);if(!persisted)$('#mediaStatus').textContent=`${images.length} imágenes · Acceso temporal; no se puede recordar esta carpeta en este navegador.`;}
  async function enterSavedPhotoFolder(handle,{askPermission=false}={}){let permission=await handle.queryPermission({mode:'read'});if(permission!=='granted'&&askPermission&&permission==='prompt')permission=await handle.requestPermission({mode:'read'});if(permission!=='granted'){photoDirectoryAttempted=true;$('#mediaStatus').textContent='La carpeta está recordada, pero el navegador necesita autorización. Pulsa «Elegir carpeta» para conceder acceso.';return false;}photoFolderHandle=handle;const generation=photoDirectoryGeneration+1;photoDirectoryGeneration=generation;const images=await collectDirectoryImages(handle,'',[],generation);if(generation!==photoDirectoryGeneration)return false;await showPhotoDirectory(images,{handle,persisted:true});photoDirectoryAttempted=true;return true;}
  async function restoreSavedPhotoFolder(){if(photoDirectoryAttempted||!('showDirectoryPicker'in window))return;photoDirectoryAttempted=true;try{const handle=await readPhotoFolderHandle();if(!handle)return;photoFolderHandle=handle;const permission=await handle.queryPermission({mode:'read'});if(permission==='granted')await enterSavedPhotoFolder(handle);else $('#mediaStatus').textContent='Hay una carpeta recordada. Pulsa «Elegir carpeta» para renovar el permiso de acceso.';}catch(error){console.warn('No se pudo recuperar la carpeta de fotos:',error);$('#mediaStatus').textContent='No se pudo recuperar el acceso a la carpeta. Pulsa «Elegir carpeta» para seleccionarla de nuevo.';}}
  async function choosePhotoFolder(){if(!('showDirectoryPicker'in window)){$('#mediaFolder').click();return;}try{const saved=await readPhotoFolderHandle();if(saved){photoFolderHandle=saved;const permission=await saved.queryPermission({mode:'read'});if(permission==='granted'){await enterSavedPhotoFolder(saved);return;}if(permission==='prompt'){const requested=await saved.requestPermission({mode:'read'});if(requested==='granted'){await enterSavedPhotoFolder(saved);return;}$('#mediaStatus').textContent='No se concedió el permiso. Pulsa «Elegir carpeta» para seleccionar una carpeta disponible.';return;}}
      const handle=await window.showDirectoryPicker({mode:'read'});photoFolderHandle=handle;let persisted=true;try{await savePhotoFolderHandle(handle);}catch(error){persisted=false;console.warn('El navegador no permite recordar la carpeta:',error);}const generation=photoDirectoryGeneration+1;photoDirectoryGeneration=generation;const images=await collectDirectoryImages(handle,'',[],generation);await showPhotoDirectory(images,{handle,persisted});if(!persisted)$('#mediaStatus').textContent='La carpeta está abierta, pero el navegador no permite recordar el acceso. Tendrás que seleccionarla de nuevo más adelante.';photoDirectoryAttempted=true;
    }catch(error){if(error.name==='AbortError')return;if(error.name==='NotAllowedError'||error.name==='SecurityError')$('#mediaStatus').textContent='El navegador no autorizó el acceso a esa carpeta. Revisa los permisos y vuelve a intentarlo.';else{console.error(error);$('#mediaStatus').textContent='No se pudo leer esa carpeta. Comprueba que siga disponible y vuelve a intentarlo.';}}}
  function showFallbackPhotoFolder(files){clearMedia();const items=[...files].filter(isPhoto).map(file=>({file,name:file.name,path:file.webkitRelativePath||file.name}));if(!items.length){$('#mediaStatus').textContent='No se encontraron imágenes compatibles en la carpeta seleccionada.';return;}photoDirectoryAttempted=true;showPhotoDirectory(items,{persisted:false}).catch(console.error);}
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
  function render(){if(view!=='diary')flushDiary();const month=view==='month',diary=view==='diary',media=view==='media',finance=view==='finance',vault=view==='vault',contacts=view==='contacts';if(!vault)window.AgendaVault?.lock();$('#calendarView').classList.toggle('hidden',!month);$('#listView').classList.toggle('hidden',month||diary||media||finance||vault||contacts);$('#diaryView').classList.toggle('hidden',!diary);$('#mediaView').classList.toggle('hidden',!media);$('#folderGallery').classList.toggle('hidden',!media||!$('#mediaView').classList.contains('directory-mode'));$('#financeView').classList.toggle('hidden',!finance);$('#vaultView').classList.toggle('hidden',!vault);$('#contactsView').classList.toggle('hidden',!contacts);$('#dashboardExtras').classList.toggle('hidden',diary||media||finance||vault||contacts);$('#pageTitle').textContent=month?'Tu calendario':diary?'Tu diario':media?'Fotos y videos':finance?'Finanzas personales':vault?'Bóveda de contraseñas':contacts?'Contactos':view==='upcoming'?'Próximas':'Tus actividades';document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===view));if(month)renderCalendar();else if(diary)renderDiary();else if(finance)window.AgendaFinance?.render();else if(vault)window.AgendaVault?.render();else if(contacts)window.AgendaContacts?.render?.();else if(!media)renderList();if(media)restoreSavedPhotoFolder();if(!finance&&!vault&&!contacts){renderDay();renderWeek();}}
  function openForm(id){const a=id?rows('SELECT * FROM activities WHERE id=?',[id])[0]:null;$('#eventForm').reset();$('#eventId').value=a?.id||'';$('#eventTitle').value=a?.title||'';$('#eventDate').value=a?.date||selected;$('#eventTime').value=a?.time||'09:00';$('#eventCategory').value=a?.category||'Personal';$('#eventRepeat').value=a?.repeat_rule||'none';$('#eventNotes').value=a?.notes||'';$('#formHeading').textContent=a?'Editar actividad':'Nueva actividad';$('#deleteBtn').classList.toggle('hidden',!a);$('#eventDialog').showModal();setTimeout(()=>$('#eventTitle').focus(),50);}
  function saveEvent(e){e.preventDefault();const id=$('#eventId').value,title=$('#eventTitle').value.trim(),date=$('#eventDate').value,time=$('#eventTime').value||'09:00',category=$('#eventCategory').value,repeat=$('#eventRepeat').value,notes=$('#eventNotes').value.trim();if(!title||!date)return;const st=db.prepare(id?'UPDATE activities SET title=?,date=?,time=?,category=?,repeat_rule=?,notes=? WHERE id=?':'INSERT INTO activities(title,date,time,category,repeat_rule,notes) VALUES(?,?,?,?,?,?)');id?st.run([title,date,time,category,repeat,notes,+id]):st.run([title,date,time,category,repeat,notes]);st.free();selected=date;current=parse(date);persist();$('#eventDialog').close();render();}
  function toggleDone(id,day){const found=rows('SELECT completed FROM completions WHERE activity_id=? AND occurrence_date=?',[id,day])[0];if(found)sql('DELETE FROM completions WHERE activity_id=? AND occurrence_date=?',[id,day]);else sql('INSERT OR REPLACE INTO completions(activity_id,occurrence_date,completed) VALUES(?,?,1)',[id,day]);persist();render();}
  function deleteEvent(){const id=+$('#eventId').value;if(!id)return;if(!confirm('¿Eliminar esta actividad y su historial de completado?'))return;sql('DELETE FROM completions WHERE activity_id=?',[id]);sql('DELETE FROM activities WHERE id=?',[id]);persist();$('#eventDialog').close();render();}
  let notifiedMinute='';function checkReminders(){if(!('Notification'in window)||Notification.permission!=='granted')return;const now=new Date(),key=iso(now),minute=`${key} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;if(minute===notifiedMinute)return;notifiedMinute=minute;onDay(key).filter(a=>a.time===`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`&&!completions().has(`${a.id}|${key}`)).forEach(a=>new Notification('Agenda · '+a.title,{body:`Ahora · ${a.category}`,icon:'./icon.svg',tag:`${a.id}-${key}`}));}
  $('#newBtn').onclick=()=>openForm();$('#addDayBtn').onclick=()=>openForm();$('#eventForm').onsubmit=saveEvent;$('#closeDialog').onclick=$('#cancelBtn').onclick=()=>$('#eventDialog').close();$('#deleteBtn').onclick=deleteEvent;$('#prevMonth').onclick=()=>{current.setDate(1);current.setMonth(current.getMonth()-1);view='month';render();};$('#nextMonth').onclick=()=>{current.setDate(1);current.setMonth(current.getMonth()+1);view='month';render();};$('#todayBtn').onclick=()=>{current=new Date();selected=iso(current);view='month';render();};document.querySelectorAll('.nav-item').forEach(b=>b.onclick=()=>{view=b.dataset.view;render();});$('#searchInput').oninput=()=>renderList();$('#categoryFilter').onchange=()=>renderList();window.addEventListener('agenda-contacts-updated',()=>{if(!db)return;if(view==='month')renderCalendar();if(view==='upcoming')renderList();if(view!=='contacts')renderDay();});
  $('#diarySaveBtn').onclick=()=>{if(diaryTimer)flushDiary();else saveDiary();};$('#diaryContent').oninput=scheduleDiarySave;$('#diaryImportant').onchange=scheduleDiarySave;$('#diaryDate').onchange=e=>{if(e.target.value)switchDiaryDate(e.target.value);};$('#prevDiaryDay').onclick=()=>{const d=parse(selected);d.setDate(d.getDate()-1);switchDiaryDate(iso(d));};$('#nextDiaryDay').onclick=()=>{const d=parse(selected);d.setDate(d.getDate()+1);switchDiaryDate(iso(d));};$('#todayDiaryBtn').onclick=()=>switchDiaryDate(iso(new Date()));
  $('#installBtn').onclick=async()=>{if(deferredInstallPrompt){const prompt=deferredInstallPrompt;deferredInstallPrompt=null;await prompt.prompt();await prompt.userChoice;updateInstallButton();}else installationHelp();};$('#closeInstallDialog').onclick=()=>$('#installDialog').close();updateInstallButton();window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();deferredInstallPrompt=event;});window.addEventListener('appinstalled',()=>{deferredInstallPrompt=null;updateInstallButton();});
  $('#pickMediaBtn').onclick=()=>$('#mediaFiles').click();$('#pickFolderBtn').onclick=choosePhotoFolder;$('#mediaFiles').onchange=e=>showMedia([...e.target.files]);$('#mediaFolder').onchange=e=>showFallbackPhotoFolder([...e.target.files]);$('#clearMediaBtn').onclick=()=>clearMedia({forgetFolder:!!photoFolderHandle});
  $('#folderGalleryTrack').addEventListener('click',event=>{if(photoTrackClickGuard){event.preventDefault();event.stopPropagation();photoTrackClickGuard=false;return;}const button=event.target.closest('[data-photo-button]');if(button)selectDirectoryPhoto(Number(button.dataset.photoButton));});
  $('#folderGalleryTrack').addEventListener('wheel',event=>{const track=$('#folderGalleryTrack');if(Math.abs(event.deltaY)>Math.abs(event.deltaX)&&track.scrollWidth>track.clientWidth){event.preventDefault();track.scrollBy({left:event.deltaY,behavior:'auto'});}},{passive:false});
  $('#folderGalleryTrack').addEventListener('keydown',event=>{if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();const track=$('#folderGalleryTrack'),thumb=track.querySelector('.folder-thumb');track.scrollBy({left:(event.key==='ArrowRight'?1:-1)*((thumb?.getBoundingClientRect().width||150)+10),behavior:'smooth'});}});
  $('#folderGalleryTrack').addEventListener('pointerdown',event=>{if(event.pointerType!=='mouse'||event.button!==0)return;photoTrackDrag={pointerId:event.pointerId,startX:event.clientX,startScroll:$('#folderGalleryTrack').scrollLeft,moved:false};});
  window.addEventListener('pointermove',event=>{if(!photoTrackDrag||event.pointerId!==photoTrackDrag.pointerId)return;const track=$('#folderGalleryTrack'),distance=event.clientX-photoTrackDrag.startX;if(Math.abs(distance)>5){photoTrackDrag.moved=true;track.classList.add('is-dragging');}if(photoTrackDrag.moved){track.scrollLeft=photoTrackDrag.startScroll-distance;event.preventDefault();}},{passive:false});
  window.addEventListener('pointerup',event=>{if(!photoTrackDrag||event.pointerId!==photoTrackDrag.pointerId)return;photoTrackClickGuard=photoTrackDrag.moved;photoTrackDrag=null;$('#folderGalleryTrack').classList.remove('is-dragging');if(photoTrackClickGuard)setTimeout(()=>{photoTrackClickGuard=false;},0);});
  window.addEventListener('pagehide',()=>{for(const url of mediaUrls)URL.revokeObjectURL(url);mediaUrls=[];releasePhotoUrls();});
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
