(() => {
  'use strict';

  const FORMAT = 'agenda-complete-backup';
  const VERSION = 1;
  const ITERATIONS = 310000;
  const CHUNK_SIZE = 1024 * 1024;
  const MAX_RESTORE_SIZE = 512 * 1024 * 1024;
  const $ = selector => document.querySelector(selector);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const status = $('#backupStatus');
  const progress = $('#backupProgress');
  const summary = $('#backupSummary');
  const restoreMode = $('#restoreModeWrap');
  let pendingRestore = null;
  let cancelRequested = false;

  function showError(message) {
    status.textContent = message;
    status.classList.add('error');
  }
  function showProgress(message, value = 0, total = 1) {
    status.textContent = message;
    status.classList.remove('error');
    progress.classList.remove('hidden');
    progress.value = total ? Math.min(100, Math.round(value / total * 100)) : 0;
  }
  function finish(message) {
    status.textContent = message;
    status.classList.remove('error');
    progress.value = 100;
    $('#cancelBackupOperation').classList.add('hidden');
    setTimeout(() => progress.classList.add('hidden'), 1800);
  }
  function checkCancelled() { if (cancelRequested) throw new Error('Operación cancelada.'); }
  function toBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }
  function fromBase64(value) { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
  function concat(parts) {
    const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
  }
  function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return new Uint8Array(value);
  }
  async function deriveKey(password, salt) {
    const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function decryptEntry(bytes, key, entryId) {
    if (!bytes || bytes.length < 6 || decoder.decode(bytes.subarray(0, 6)) !== 'AGENC1') throw new Error('El formato cifrado del respaldo no es válido.');
    const clearParts = [];
    let offset = 6, index = 0;
    while (offset < bytes.length) {
      if (offset + 16 > bytes.length) throw new Error('Un bloque cifrado está incompleto.');
      const clearLength = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
      const iv = bytes.subarray(offset + 4, offset + 16);
      const encrypted = bytes.subarray(offset + 16, offset + 16 + clearLength + 16);
      if (encrypted.length !== clearLength + 16) throw new Error('Un bloque cifrado está truncado.');
      const aad = encoder.encode(`${FORMAT}:${entryId}:${index++}`);
      clearParts.push(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, encrypted)));
      offset += 16 + encrypted.length;
    }
    return concat(clearParts);
  }

  async function collectLocalData() {
    const modules = [window.AgendaLocalStore, window.AgendaFinance, window.AgendaContacts, window.AgendaPhotoLibrary, window.AgendaVault];
    if (modules.some(module => !module)) throw new Error('No están listos todos los almacenes locales. Recarga Agenda e inténtalo de nuevo.');
    const [sqlite, finance, contacts, photos, vault, voice] = await Promise.all([
      window.AgendaLocalStore.backupExport(), window.AgendaFinance.backupExport(), window.AgendaContacts.backupExport(),
      window.AgendaPhotoLibrary.backupExport(), window.AgendaVault.backupExport(), exportVoiceDiary()
    ]);
    return {
      sqlite: asBytes(sqlite), finance, contacts, photos, vault, voice,
      settings: { preferences: window.AgendaI18n?.preferences?.() || { theme: 'light', language: 'es' } },
      counts: window.AgendaLocalStore.backupSummary()
    };
  }

  async function exportVoiceDiary() {
    const name = 'AgendaDiaryVoiceLocal';
    if (!indexedDB.databases) return { name, present: false, stores: [] };
    const existing = (await indexedDB.databases()).find(item => item.name === name);
    if (!existing) return { name, present: false, stores: [] };
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Cierra otras pestañas de Agenda antes de respaldar las notas de voz.'));
    });
    try {
      const stores = await Promise.all([...database.objectStoreNames].map(storeName => new Promise((resolve, reject) => {
        const tx = database.transaction(storeName, 'readonly'), store = tx.objectStore(storeName);
        const values = store.getAll(), keys = store.getAllKeys();
        Promise.all([new Promise((yes, no) => { values.onsuccess = () => yes(values.result || []); values.onerror = () => no(values.error); }), new Promise((yes, no) => { keys.onsuccess = () => yes(keys.result || []); keys.onerror = () => no(keys.error); })]).then(([rows, primaryKeys]) => resolve({
          name: storeName, keyPath: store.keyPath, autoIncrement: store.autoIncrement,
          indexes: [...store.indexNames].map(indexName => { const index = store.index(indexName); return { name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry }; }),
          rows: rows.map((value, index) => ({ key: primaryKeys[index], value }))
        }), reject);
      })));
      return { name, version: database.version, present: true, stores };
    } finally { database.close(); }
  }

  function makePackage(data) {
    const files = [];
    const blobs = [];
    const manifest = {
      format: FORMAT, version: VERSION, createdAt: new Date().toISOString(), files: [],
      sections: {
        activities: data.counts.activities, diaryNotes: data.counts.diaryNotes,
        finance: data.finance.length, contacts: data.contacts.contacts.length,
        photos: data.photos.photos.length, originals: data.photos.originals.length,
        thumbnails: data.photos.thumbnails.length, vaultRecords: data.vault.records.length,
        voiceDiaryRecords: data.voice.stores.reduce((total, store) => total + store.rows.length, 0)
      }
    };
    const addJson = (logicalName, value) => {
      const id = String(files.length).padStart(8, '0');
      const bytes = encoder.encode(JSON.stringify(value));
      files.push({ id, name: logicalName, kind: 'json', value: bytes });
      manifest.files.push({ id, name: logicalName, kind: 'json', size: bytes.byteLength });
    };
    const detach = value => {
      if (value instanceof Blob) {
        const id = `blob-${String(blobs.length).padStart(8, '0')}`;
        blobs.push({ id, blob: value });
        return { $agendaBlob: id, mime: value.type || 'application/octet-stream', size: value.size };
      }
      if (value instanceof ArrayBuffer) return { $agendaBytes: toBase64(new Uint8Array(value)) };
      if (ArrayBuffer.isView(value)) return { $agendaBytes: toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
      if (Array.isArray(value)) return value.map(detach);
      if (value && typeof value === 'object') {
        if (typeof CryptoKey !== 'undefined' && value instanceof CryptoKey) throw new Error('Se detectó una clave no exportable. Se detuvo el respaldo para conservar el cifrado local.');
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, detach(item)]));
      }
      return value;
    };
    const addBinary = (name, value) => {
      const id = String(files.length).padStart(8, '0');
      files.push({ id, name, kind: 'binary', value });
      manifest.files.push({ id, name, kind: 'binary', size: value.byteLength });
    };

    addBinary('agenda.sqlite', data.sqlite);
    addJson('finance/records.json', detach(data.finance));
    const contacts = {
      contacts: data.contacts.contacts,
      files: data.contacts.files.map(file => ({ id: file.id, blob: { $agendaBlob: `contact-${file.id}`, mime: 'application/octet-stream', size: file.blob.size } }))
    };
    for (const file of data.contacts.files) blobs.push({ id: `contact-${file.id}`, blob: file.blob });
    addJson('contacts/data.json', detach(contacts));
    addJson('photos/library.json', detach(data.photos));
    addJson('vault/encrypted.json', detach(data.vault));
    addJson('diary/voice.json', detach(data.voice));
    addJson('settings/preferences.json', detach(data.settings));

    // Bundle the image and contact blobs so large libraries do not exceed classic ZIP entry counts.
    const bundleLimit = 64 * 1024 * 1024;
    let group = [], groupSize = 0;
    const flushBundle = () => {
      if (!group.length) return;
      const id = String(files.length).padStart(8, '0'), parts = [], items = [];
      for (const item of group) {
        const name = encoder.encode(item.id), header = new Uint8Array(12 + name.length), view = new DataView(header.buffer);
        view.setUint32(0, name.length, false); view.setBigUint64(4, BigInt(item.blob.size), false); header.set(name, 12);
        parts.push(header, item.blob);
        items.push({ id: item.id, size: item.blob.size, mime: item.blob.type || 'application/octet-stream' });
      }
      const value = new Blob(parts);
      files.push({ id, name: `bundle-${id}`, kind: 'bundle', value });
      manifest.files.push({ id, name: `bundle-${id}`, kind: 'bundle', size: value.size, items });
      group = []; groupSize = 0;
    };
    for (const item of blobs) {
      const size = item.blob.size + item.id.length + 12;
      if (group.length && groupSize + size > bundleLimit) flushBundle();
      group.push(item); groupSize += size;
    }
    flushBundle();
    manifest.sections.binaryFiles = blobs.length;
    return { manifest, files };
  }

  function validatePackageData(data, manifest) {
    const sections = manifest.sections || {};
    const actual = {
      finance: data.finance?.length,
      contacts: data.contacts?.contacts?.length,
      photos: data.photos?.photos?.length,
      originals: data.photos?.originals?.length,
      thumbnails: data.photos?.thumbnails?.length,
      vaultRecords: data.vault?.records?.length,
      voiceDiaryRecords: (data.voice?.stores || []).reduce((total, store) => total + (store.rows?.length || 0), 0)
    };
    for (const [key, count] of Object.entries(actual)) {
      if (!Number.isInteger(sections[key]) || sections[key] !== count) throw new Error(`El recuento de ${key} no coincide con el manifiesto.`);
    }
    if (!Array.isArray(data.contacts?.files) || !Array.isArray(data.photos?.photos) || !Array.isArray(data.photos?.originals) || !Array.isArray(data.photos?.thumbnails) || !Array.isArray(data.vault?.records) || !data.voice?.name) throw new Error('El respaldo está incompleto.');
    return actual;
  }

  async function checkRestoreSpace(data, mode) {
    if (!navigator.storage?.estimate) return;
    const estimate = await navigator.storage.estimate().catch(() => null);
    if (!estimate?.quota || !Number.isFinite(estimate.usage)) return;
    const incomingBytes = (data.sqlite?.byteLength || 0)
      + (data.contacts?.files || []).reduce((sum, item) => sum + (item.blob?.size || 0), 0)
      + ['originals', 'thumbnails', 'pending'].reduce((sum, name) => sum + (data.photos?.[name] || []).reduce((part, row) => part + (row.blob?.size || 0), 0), 0);
    const available = Math.max(0, estimate.quota - estimate.usage);
    if (incomingBytes > available) {
      const action = mode === 'merge' ? 'incorporar' : 'restaurar de forma segura';
      throw new Error(`El navegador estima ${(incomingBytes / 1024 / 1024).toFixed(0)} MB de archivos para ${action}, pero solo informa ${(available / 1024 / 1024).toFixed(0)} MB disponibles. Libera espacio o usa otro dispositivo. Los datos actuales no se modificaron.`);
    }
  }

  async function savePicker() {
    if (typeof window.showSaveFilePicker !== 'function') return null;
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: `agenda-respaldo-${new Date().toISOString().slice(0, 10)}.zip`,
        types: [{ description: 'Respaldo cifrado de Agenda', accept: { 'application/zip': ['.zip'] } }]
      });
      return await handle.createWritable();
    } catch (error) { if (error.name === 'AbortError') return false; return null; }
  }

  async function buildZip(pkg, password, onProgress, writable = null) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(password, salt);
    const output = [];
    let outputSize = 0;
    let zipError = null;
    const zip = new fflate.Zip((error, chunk) => { if (error) { zipError = error; return; } if (chunk?.length) { output.push(chunk); outputSize += chunk.length; } });
    let writtenOutput = 0;
    const flushOutput = async () => {
      if (zipError) throw zipError;
      if (!writable) return;
      for (; writtenOutput < output.length; writtenOutput++) await writable.write(output[writtenOutput]);
      output.length = 0; writtenOutput = 0;
    };
    const header = new fflate.ZipPassThrough('agenda/header.json');
    zip.add(header);
    header.push(encoder.encode(JSON.stringify({ format: FORMAT, version: VERSION, encrypted: true, kdf: 'PBKDF2-SHA-256', iterations: ITERATIONS, salt: toBase64(salt) })), true);
    await flushOutput();

    const manifest = new fflate.ZipPassThrough('agenda/data/manifest.bin');
    zip.add(manifest);
    await encryptToZip(manifest, encoder.encode(JSON.stringify(pkg.manifest)), key, 'manifest', () => {});
    await flushOutput();
    const total = pkg.files.reduce((sum, file) => sum + (file.value.size ?? file.value.byteLength), 0);
    let completed = 0;
    for (const item of pkg.files) {
      const target = new fflate.ZipPassThrough(`agenda/data/${item.id}.bin`);
      zip.add(target);
      await encryptToZip(target, item.value, key, item.id, size => { completed += size; onProgress(completed, total); });
      await flushOutput();
    }
    zip.end();
    await flushOutput();
    if (zipError) throw zipError;
    if (writable) { await writable.close(); return { blob: null, size: outputSize }; }
    return { blob: new Blob(output, { type: 'application/zip' }), size: outputSize };

    async function encryptToZip(target, source, cryptoKey, fileId, update) {
      target.push(encoder.encode('AGENC1'), false);
      const blob = source instanceof Blob ? source : null;
      const length = blob ? blob.size : source.length;
      let offset = 0, index = 0;
      while (offset < length) {
        checkCancelled();
        const clear = blob
          ? new Uint8Array(await blob.slice(offset, Math.min(length, offset + CHUNK_SIZE)).arrayBuffer())
          : source.subarray(offset, Math.min(length, offset + CHUNK_SIZE));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const aad = encoder.encode(`${FORMAT}:${fileId}:${index++}`);
        const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, cryptoKey, clear));
        const frame = new Uint8Array(16 + encrypted.length), view = new DataView(frame.buffer);
        view.setUint32(0, clear.length, false); frame.set(iv, 4); frame.set(encrypted, 16);
        target.push(frame, false); offset += clear.length; update(clear.length);
        if (blob) await new Promise(requestAnimationFrame);
      }
      target.push(new Uint8Array(0), true);
    }
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  async function createBackup() {
    const password = $('#backupPassword').value;
    if (password.length < 12) return showError('Define una contraseña de al menos 12 caracteres. Agenda no la guardará.');
    $('#createFullBackup').disabled = $('#restoreFullBackup').disabled = true;
    cancelRequested = false; $('#cancelBackupOperation').classList.remove('hidden');
    summary.classList.add('hidden');
    let writable = null;
    try {
      showProgress('Preparando el archivo de respaldo…');
      writable = await savePicker();
      if (writable === false) return finish('Creación cancelada.');
      showProgress('Leyendo almacenes locales…');
      await window.AgendaPhotoLibrary.open();
      const data = await collectLocalData(), pkg = makePackage(data);
      validatePackageData(data, pkg.manifest);
      const estimatedBytes = pkg.files.reduce((sum, item) => sum + (item.value.size ?? item.value.byteLength), 0);
      if (estimatedBytes > MAX_RESTORE_SIZE * 0.8) throw new Error('El paquete completo excede el tamaño que Agenda puede verificar y restaurar de forma segura en Chrome. Los datos locales no se modificaron.');
      if (!writable && estimatedBytes > 512 * 1024 * 1024) throw new Error('Este navegador no ofrece guardado por flujo y el respaldo supera 512 MB. Usa Chrome de escritorio con guardado local o divide la biblioteca antes.');
      if (!writable && navigator.deviceMemory && navigator.deviceMemory <= 4 && estimatedBytes > 256 * 1024 * 1024) throw new Error('La memoria disponible del teléfono es limitada para este respaldo. Usa Chrome de escritorio para guardar el ZIP por flujo.');
      showProgress('Cifrando y creando el archivo ZIP…', 0, estimatedBytes || 1);
      const output = await buildZip(pkg, password, (done, total) => showProgress(`Creando respaldo: ${Math.round(done / 1024 / 1024)} MB procesados`, done, total), writable);
      if (output.blob && navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        if (output.blob.size > (estimate.quota - estimate.usage) * 0.8) throw new Error('El espacio local parece insuficiente. Los datos de Agenda no se modificaron.');
      }
      if (output.blob) download(output.blob, `agenda-respaldo-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
      const counts = data.counts;
      summary.textContent = `Respaldo cifrado ${writable ? 'guardado' : 'descargado'} · ${counts.activities} actividades · ${counts.diaryNotes} días de diario · ${data.finance.length} movimientos financieros · ${data.contacts.contacts.length} contactos · ${pkg.manifest.sections.photos} fotos · ${pkg.manifest.sections.originals} originales · ${pkg.manifest.sections.thumbnails} miniaturas · ${(output.size / 1024 / 1024).toFixed(1)} MB`;
      summary.classList.remove('hidden');
      finish('Respaldo ZIP creado. Guarda la contraseña: no se puede recuperar.');
    } catch (error) {
      try { await writable?.abort?.(); } catch {}
      console.error('Error al crear respaldo completo:', error);
      if (cancelRequested) finish('Creación cancelada; los datos locales se conservaron.');
      else showError(error.message || 'No se pudo crear el respaldo completo. Los datos locales no se modificaron.');
    } finally { $('#cancelBackupOperation').classList.add('hidden'); $('#createFullBackup').disabled = $('#restoreFullBackup').disabled = false; }
  }

  function validateZip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('El archivo no contiene un índice ZIP válido.');
    const entries = view.getUint16(eocd + 10, true), directoryOffset = view.getUint32(eocd + 16, true);
    if (entries < 2 || entries > 65530 || directoryOffset >= bytes.length) throw new Error('El ZIP tiene un número de elementos no admitido.');
    const names = new Set();
    let offset = directoryOffset;
    for (let i = 0; i < entries; i++) {
      if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error('El directorio ZIP está dañado.');
      const method = view.getUint16(offset + 10, true), compressed = view.getUint32(offset + 20, true), clear = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true), extraLength = view.getUint16(offset + 30, true), commentLength = view.getUint16(offset + 32, true);
      const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      if (method !== 0 || compressed !== clear) throw new Error('El respaldo contiene una compresión ZIP no admitida.');
      if (name !== 'agenda/header.json' && !/^agenda\/data\/(?:manifest|\d{8})\.bin$/.test(name)) throw new Error('El ZIP contiene una ruta inesperada.');
      if (names.has(name)) throw new Error('El ZIP contiene rutas duplicadas.');
      names.add(name); offset += 46 + nameLength + extraLength + commentLength;
    }
    if (!names.has('agenda/header.json') || !names.has('agenda/data/manifest.bin')) throw new Error('Falta información obligatoria del respaldo.');
  }

  async function decodeArchive(file, password) {
    if (file.size > MAX_RESTORE_SIZE) throw new Error('Este navegador no puede procesar respaldos mayores a 512 MB de forma segura. No se modificaron datos.');
    const memoryGiB = Number(navigator.deviceMemory) || 0;
    const safeSize = memoryGiB && memoryGiB <= 4 ? 128 * 1024 * 1024 : memoryGiB && memoryGiB <= 8 ? 256 * 1024 * 1024 : 512 * 1024 * 1024;
    if (file.size > safeSize) throw new Error(`Para proteger el navegador${memoryGiB ? ` (memoria estimada: ${memoryGiB} GB)` : ''}, esta sesión limita la restauración a ${(safeSize / 1024 / 1024).toFixed(0)} MB. Usa Chrome de escritorio o divide la biblioteca en varios respaldos.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    validateZip(bytes);
    const archive = fflate.unzipSync(bytes);
    const header = JSON.parse(decoder.decode(archive['agenda/header.json']));
    if (header.format !== FORMAT || header.version !== VERSION || header.encrypted !== true || header.iterations !== ITERATIONS) throw new Error('Formato de respaldo incompatible o inválido.');
    const key = await deriveKey(password, fromBase64(header.salt));
    const manifest = JSON.parse(decoder.decode(await decryptEntry(archive['agenda/data/manifest.bin'], key, 'manifest')));
    if (manifest.format !== FORMAT || manifest.version !== VERSION || !Array.isArray(manifest.files) || manifest.files.length + 2 !== Object.keys(archive).length) throw new Error('El manifiesto está incompleto o no corresponde a este archivo.');
    const ids = new Set(), blobs = new Map(), dataFiles = new Map();
    let verified = 0;
    for (const spec of manifest.files) {
      checkCancelled();
      if (!/^\d{8}$/.test(spec.id) || ids.has(spec.id) || !['json', 'binary', 'bundle'].includes(spec.kind)) throw new Error('El manifiesto incluye un elemento inválido.');
      ids.add(spec.id);
      const encrypted = archive[`agenda/data/${spec.id}.bin`];
      if (!encrypted) throw new Error(`Falta un elemento (${spec.name}).`);
      const clear = await decryptEntry(encrypted, key, spec.id);
      if (!Number.isSafeInteger(spec.size) || spec.size < 0 || spec.size !== clear.byteLength) throw new Error(`El tamaño autenticado de ${spec.name} no coincide con el manifiesto.`);
      if (spec.kind === 'bundle') {
        let offset = 0;
        while (offset < clear.length) {
          if (offset + 12 > clear.length) throw new Error('Un paquete multimedia está dañado.');
          const view = new DataView(clear.buffer, clear.byteOffset + offset, 12), idLength = view.getUint32(0, false), size = Number(view.getBigUint64(4, false));
          offset += 12;
          if (!Number.isSafeInteger(size) || offset + idLength + size > clear.length) throw new Error('Un archivo multimedia está truncado.');
          const id = decoder.decode(clear.subarray(offset, offset + idLength)); offset += idLength;
          const item = spec.items?.find(entry => entry.id === id);
          if (!item || item.size !== size || blobs.has(id)) throw new Error('Un archivo multimedia no coincide con el manifiesto.');
          blobs.set(id, new Blob([clear.subarray(offset, offset + size)], { type: item.mime })); offset += size;
        }
        if (!Array.isArray(spec.items) || spec.items.some(item => !blobs.has(item.id))) throw new Error('Faltan archivos multimedia en el paquete.');
      } else if (spec.kind === 'binary') blobs.set(spec.name, new Blob([clear]));
      else dataFiles.set(spec.name, JSON.parse(decoder.decode(clear)));
      verified++;
      if (verified % 20 === 0) showProgress(`Verificando ${verified} elementos…`, verified, manifest.files.length);
    }
    const attach = value => {
      if (Array.isArray(value)) return value.map(attach);
      if (value && typeof value === 'object') {
        if (value.$agendaBlob) {
          const blob = blobs.get(value.$agendaBlob);
          if (!blob || blob.size !== value.size) throw new Error('Falta un archivo multimedia o su tamaño no coincide.');
          return blob;
        }
        if (value.$agendaBytes) return fromBase64(value.$agendaBytes);
        return Object.fromEntries(Object.entries(value).map(([keyName, item]) => [keyName, attach(item)]));
      }
      return value;
    };
    const sqlite = blobs.get('agenda.sqlite');
    if (!sqlite) throw new Error('El respaldo no contiene la base SQLite principal.');
    return {
      manifest, verified, sqlite: new Uint8Array(await sqlite.arrayBuffer()),
      finance: attach(dataFiles.get('finance/records.json')),
      contacts: attach(dataFiles.get('contacts/data.json')),
      photos: attach(dataFiles.get('photos/library.json')),
      vault: attach(dataFiles.get('vault/encrypted.json')),
      voice: attach(dataFiles.get('diary/voice.json')),
      settings: attach(dataFiles.get('settings/preferences.json'))
    };
  }

  async function restoreFile(event) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    try {
      if (!$('#backupPassword').value) throw new Error('Escribe la contraseña del respaldo para verificarlo.');
      showProgress('Verificando archivo ZIP…');
      const decoded = await decodeArchive(file, $('#backupPassword').value);
      validatePackageData(decoded, decoded.manifest);
      pendingRestore = decoded;
      const sections = decoded.manifest.sections;
      summary.textContent = `Fecha: ${new Date(decoded.manifest.createdAt).toLocaleString()}\nActividades: ${sections.activities} · Días de diario: ${sections.diaryNotes} · Notas de voz: ${sections.voiceDiaryRecords||0}\nMovimientos financieros: ${sections.finance} · Contactos: ${sections.contacts}\nFotos: ${sections.photos} · Originales: ${sections.originals} · Miniaturas: ${sections.thumbnails}\nRegistros cifrados de Bóveda: ${sections.vaultRecords}\nElementos autenticados: ${decoded.verified}`;
      summary.classList.remove('hidden'); restoreMode.classList.remove('hidden'); $('#restoreConfirm').checked = false;
      $('#restoreFullBackup').dataset.ready = '1'; $('#restoreFullBackup').textContent = 'Confirmar restauración';
      finish('Archivo verificado. Revisa el resumen y selecciona cómo restaurar.');
    } catch (error) {
      console.error('Error al verificar respaldo:', error); pendingRestore = null; restoreMode.classList.add('hidden');
      $('#restoreFullBackup').dataset.ready = ''; $('#restoreFullBackup').textContent = 'Restaurar respaldo';
      showError(error.message || 'No se pudo verificar el archivo. No se modificaron datos.');
    }
  }

  async function restoreAllData(data, mode) {
    checkCancelled();
    const sqliteResult = await window.AgendaLocalStore.backupRestore(data.sqlite, mode);
    checkCancelled();
    const financeResult = await window.AgendaFinance.backupRestore(data.finance, mode);
    checkCancelled();
    const contactsResult = await window.AgendaContacts.backupRestore(data.contacts, mode);
    checkCancelled();
    const photosResult = await window.AgendaPhotoLibrary.backupRestore(data.photos, mode);
    checkCancelled();
    const vaultResult = await window.AgendaVault.backupRestore(data.vault, mode);
    checkCancelled();
    await restoreVoiceDiary(data.voice, mode);
    if (mode === 'replace') window.AgendaI18n?.setPreferences?.(data.settings?.preferences);
    if (mode === 'replace' && data.manifest?.sections) {
      const localCounts = window.AgendaLocalStore.backupSummary();
      const expected = data.manifest.sections;
      if (sqliteResult.activities !== expected.activities || localCounts.diaryNotes !== expected.diaryNotes
        || financeResult.count !== expected.finance || contactsResult.count !== expected.contacts
        || photosResult.photos !== expected.photos || vaultResult.count !== expected.vaultRecords) {
        throw new Error('La verificación posterior detectó un recuento distinto al respaldo. Se iniciará la recuperación del estado anterior.');
      }
      const photoRows = await window.AgendaPhotoLibrary.backupExport();
      if (photoRows.originals.length !== expected.originals || photoRows.thumbnails.length !== expected.thumbnails) throw new Error('La verificación de originales o miniaturas no coincide. Se iniciará la recuperación del estado anterior.');
    }
  }
  async function restoreVoiceDiary(data, mode) {
    const name = 'AgendaDiaryVoiceLocal';
    if (!data || data.name !== name) throw new Error('La sección de notas de voz no es válida.');
    if (!indexedDB.databases && data.present) throw new Error('Este navegador no permite restaurar la base local de notas de voz.');
    const existing = indexedDB.databases ? (await indexedDB.databases()).find(item => item.name === name) : null;
    if (!data.present && !existing) return;
    const targetVersion = Math.max(existing?.version || 0, data.version || 1) + (existing ? 1 : 0);
    const database = await new Promise((resolve, reject) => {
      const request = existing ? indexedDB.open(name, targetVersion) : indexedDB.open(name, targetVersion);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const schema of data.stores || []) {
          let store;
          if (!db.objectStoreNames.contains(schema.name)) {
            const options = { autoIncrement: !!schema.autoIncrement };
            if (schema.keyPath !== null) options.keyPath = schema.keyPath;
            store = db.createObjectStore(schema.name, options);
          }
          else store = request.transaction.objectStore(schema.name);
          for (const index of schema.indexes || []) if (!store.indexNames.contains(index.name)) store.createIndex(index.name, index.keyPath, { unique: !!index.unique, multiEntry: !!index.multiEntry });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Cierra otras pestañas de Agenda antes de restaurar las notas de voz.'));
    });
    try {
      for (const schema of data.stores || []) {
        if (!database.objectStoreNames.contains(schema.name)) throw new Error(`Falta el almacén local de notas de voz: ${schema.name}.`);
        const store = database.transaction(schema.name, 'readonly').objectStore(schema.name);
        if (JSON.stringify(store.keyPath) !== JSON.stringify(schema.keyPath)) throw new Error(`El esquema de notas de voz no coincide en ${schema.name}.`);
      }
      if (mode === 'replace') await new Promise((resolve, reject) => {
        const tx = database.transaction([...database.objectStoreNames], 'readwrite');
        for (const storeName of [...database.objectStoreNames]) tx.objectStore(storeName).clear();
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
      for (const schema of data.stores || []) {
        const rows = schema.rows || [];
        for (let offset = 0; offset < rows.length; offset += 500) await new Promise((resolve, reject) => {
          const tx = database.transaction(schema.name, 'readwrite'), store = tx.objectStore(schema.name);
          for (const row of rows.slice(offset, offset + 500)) {
            if (mode === 'replace') { if (store.keyPath === null) store.put(row.value, row.key); else store.put(row.value); }
            else { const request = store.get(row.key); request.onsuccess = () => { if (request.result === undefined) { if (store.keyPath === null) store.put(row.value, row.key); else store.put(row.value); } }; }
          }
          tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('No se pudo restaurar un lote de notas de voz.'));
        });
      }
    } finally { database.close(); }
  }
  async function applyRestore() {
    if (!pendingRestore) return;
    const data = pendingRestore, mode = document.querySelector('[name="backupMode"]:checked')?.value || 'replace';
    if (!$('#restoreConfirm').checked) return showError('Marca la confirmación para continuar.');
    if (mode === 'replace' && !confirm('Se creará y descargará primero una copia cifrada de los datos actuales. Conserva ese archivo. Después se reemplazarán los almacenes locales. ¿Continuar?')) return;
    $('#createFullBackup').disabled = $('#restoreFullBackup').disabled = true;
    cancelRequested = false; $('#cancelBackupOperation').classList.remove('hidden');
    let rollback = null, safetyWritable = null;
    try {
      await checkRestoreSpace(data, mode);
      showProgress('Creando copia de seguridad del estado actual…');
      rollback = await collectLocalData();
      const safety = makePackage(rollback);
      safetyWritable = await savePicker();
      if (safetyWritable === false) { rollback = null; return finish('Restauración cancelada.'); }
      const estimatedSafety = safety.files.reduce((sum, item) => sum + (item.value.size ?? item.value.byteLength), 0);
      if (!safetyWritable && estimatedSafety > 512 * 1024 * 1024) throw new Error('No hay guardado por flujo y la copia actual supera 512 MB. No se inició la restauración.');
      const safetyOutput = await buildZip(safety, $('#backupPassword').value, () => {}, safetyWritable);
      if (safetyOutput.blob) download(safetyOutput.blob, `agenda-antes-de-restaurar-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
      if (mode === 'replace' && !confirm('Se solicitó la descarga de seguridad. ¿Confirmas que deseas reemplazar los datos actuales con el respaldo seleccionado?')) return;
      showProgress('Restaurando datos locales…', 0, 5);
      await restoreAllData(data, mode);
      showProgress('Revisando datos restaurados…', 4, 5);
      if (mode === 'replace') await window.AgendaContacts.backupExport();
      pendingRestore = null; $('#restoreFullBackup').dataset.ready = ''; $('#restoreFullBackup').textContent = 'Restaurar respaldo';
      restoreMode.classList.add('hidden'); $('#restoreConfirm').checked = false;
      finish('Restauración completada. Agenda se recargará para abrir todos los módulos.');
      setTimeout(() => location.reload(), 900);
    } catch (error) {
      console.error('Error en restauración:', error);
      if (cancelRequested && !rollback) { finish('Verificación cancelada. No se modificaron datos.'); return; }
      if (rollback) {
        try { cancelRequested = false; showProgress('Hubo un error; recuperando la copia local…'); await restoreAllData(rollback, 'replace'); finish('Se recuperó el estado local anterior. Recarga Agenda.'); }
        catch (rollbackError) { console.error('No se pudo completar la recuperación automática:', rollbackError); showError(`La restauración falló y la recuperación automática también: ${rollbackError.message}. Conserva el respaldo de seguridad descargado.`); }
      } else showError(`La restauración se detuvo: ${error.message}. Conserva el respaldo de seguridad descargado.`);
    } finally { $('#cancelBackupOperation').classList.add('hidden'); $('#createFullBackup').disabled = $('#restoreFullBackup').disabled = false; }
  }

  function init() {
    if (!window.fflate) { showError('No se pudo cargar el componente ZIP local.'); return; }
    $('#createFullBackup').onclick = createBackup;
    $('#restoreFullBackup').onclick = () => {
      const input = $('#backupPassword');
      if (input.value.length < 12) { input.setCustomValidity('La contraseña debe tener al menos 12 caracteres.'); input.reportValidity(); return; }
      input.setCustomValidity('');
      if ($('#restoreFullBackup').dataset.ready === '1') applyRestore(); else $('#fullBackupFile').click();
    };
    $('#fullBackupFile').onchange = restoreFile;
    $('#cancelBackupOperation').onclick = () => { cancelRequested = true; status.textContent = 'Cancelando de forma segura…'; };
    document.querySelectorAll('[data-view="settings"]').forEach(button => button.addEventListener('click', () => {
      restoreMode.classList.add('hidden'); $('#restoreFullBackup').dataset.ready = ''; $('#restoreFullBackup').textContent = 'Restaurar respaldo'; summary.classList.add('hidden'); pendingRestore = null;
    }));
    $('#footerBackupLink').onclick = () => { document.querySelector('[data-view="settings"]')?.click(); };
  }
  init();
})();
