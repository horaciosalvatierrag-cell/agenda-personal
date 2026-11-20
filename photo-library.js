(() => {
  'use strict';
  const DB_NAME = 'AgendaSelectedPhotoLibrary';
  const DB_VERSION = 1;
  const PAGE_SIZE = 60;
  let dbPromise;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('photos')) {
          const photos = database.createObjectStore('photos', { keyPath: 'id' });
          photos.createIndex('by-modified', ['lastModified', 'id'], { unique: false });
        }
        if (!database.objectStoreNames.contains('originals')) database.createObjectStore('originals', { keyPath: 'id' });
        if (!database.objectStoreNames.contains('thumbnails')) database.createObjectStore('thumbnails', { keyPath: 'id' });
        if (!database.objectStoreNames.contains('pending')) database.createObjectStore('pending', { keyPath: 'id' });
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => { dbPromise = null; reject(request.error); };
      request.onblocked = () => reject(new Error('Cierra otras pestañas de Agenda para abrir la galería.'));
    });
    return dbPromise;
  }

  function requestValue(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function count() {
    const database = await open();
    return requestValue(database.transaction('photos', 'readonly').objectStore('photos').count());
  }

  async function getPage(page = 1, pageSize = PAGE_SIZE) {
    const database = await open();
    const total = await requestValue(database.transaction('photos', 'readonly').objectStore('photos').count());
    const pageCount = Math.ceil(total / pageSize);
    const safePage = Math.min(Math.max(1, Number(page) || 1), Math.max(1, pageCount));
    const rows = [];
    const transaction = database.transaction('photos', 'readonly');
    const index = transaction.objectStore('photos').index('by-modified');
    return new Promise((resolve, reject) => {
      const request = index.openCursor(null, 'prev');
      let skipped = 0;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || rows.length >= pageSize) return resolve({ rows, total, page: safePage, pageCount });
        if (skipped < (safePage - 1) * pageSize) {
          skipped++;
          cursor.continue();
          return;
        }
        rows.push(cursor.value);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async function get(id) {
    const database = await open();
    return requestValue(database.transaction('photos', 'readonly').objectStore('photos').get(id));
  }

  async function getBlob(storeName, id) {
    const database = await open();
    const row = await requestValue(database.transaction(storeName, 'readonly').objectStore(storeName).get(id));
    return row?.blob || null;
  }

  async function stagePhoto(photo) {
    const database = await open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(['photos', 'originals', 'pending'], 'readwrite');
      const photos = transaction.objectStore('photos'), pending = transaction.objectStore('pending');
      const check = photos.get(photo.id), queued = pending.get(photo.id);
      let duplicate = false, alreadyPending = false;
      check.onsuccess = () => {
        if (check.result) duplicate = true;
      };
      queued.onsuccess = () => {
        if (queued.result) { alreadyPending = true; return; }
        if (duplicate) return;
        transaction.objectStore('originals').put({ id: photo.id, blob: photo.original, mime: photo.mime, size: photo.size });
        pending.add({
          id: photo.id,
          name: photo.name,
          mime: photo.mime,
          size: photo.size,
          lastModified: Math.max(0, Number(photo.lastModified) || 0),
          width: photo.width || 0,
          height: photo.height || 0,
          stagedAt: Date.now()
        });
      };
      check.onerror = queued.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve({ staged: !duplicate && !alreadyPending, duplicate, alreadyPending });
      transaction.onerror = () => reject(transaction.error || new Error('No se pudo guardar la fotografía.'));
      transaction.onabort = () => reject(transaction.error || new Error('No se pudo guardar la fotografía.'));
    });
  }

  async function getFirstPending() {
    const database = await open();
    return new Promise((resolve, reject) => {
      const request = database.transaction('pending', 'readonly').objectStore('pending').openCursor();
      request.onsuccess = () => resolve(request.result?.value || null);
      request.onerror = () => reject(request.error);
    });
  }

  async function getPending(id) {
    const database = await open();
    return requestValue(database.transaction('pending', 'readonly').objectStore('pending').get(id));
  }

  async function completePending(id, thumbnail) {
    const database = await open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(['photos', 'originals', 'thumbnails', 'pending'], 'readwrite');
      const photos = transaction.objectStore('photos'), originals = transaction.objectStore('originals'), pending = transaction.objectStore('pending');
      const photoRequest = photos.get(id), originalRequest = originals.get(id), pendingRequest = pending.get(id);
      let metadata, original, queued, duplicate = false;
      photoRequest.onsuccess = () => { metadata = photoRequest.result; };
      originalRequest.onsuccess = () => { original = originalRequest.result; };
      pendingRequest.onsuccess = () => {
        queued = pendingRequest.result;
        if (!queued || !original?.blob) { transaction.abort(); return; }
        if (metadata) { duplicate = true; pending.delete(id); return; }
        photos.add({ ...queued, thumbnailMime: thumbnail.type || 'application/octet-stream', thumbnailSize: thumbnail.size, addedAt: Date.now() });
        transaction.objectStore('thumbnails').put({ id, blob: thumbnail });
        pending.delete(id);
      };
      photoRequest.onerror = originalRequest.onerror = pendingRequest.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve({ completed: !duplicate, duplicate });
      transaction.onerror = () => reject(transaction.error || new Error('No se pudo completar el registro de la fotografía.'));
      transaction.onabort = () => reject(transaction.error || new Error('No se pudo completar el registro de la fotografía.'));
    });
  }

  async function addPhoto(photo) {
    const staged = await stagePhoto(photo);
    if (staged.duplicate || staged.alreadyPending) return { added: false, duplicate: staged.duplicate, pending: staged.alreadyPending };
    const result = await completePending(photo.id, photo.thumbnail);
    return { added: result.completed, duplicate: result.duplicate };
  }

  async function verify(id) {
    const database = await open();
    const transaction = database.transaction(['photos', 'originals', 'thumbnails'], 'readonly');
    const [photo, original, thumbnail] = await Promise.all([
      requestValue(transaction.objectStore('photos').get(id)),
      requestValue(transaction.objectStore('originals').get(id)),
      requestValue(transaction.objectStore('thumbnails').get(id))
    ]);
    return Boolean(photo && original?.blob instanceof Blob && thumbnail?.blob instanceof Blob && original.blob.size > 0 && thumbnail.blob.size > 0);
  }

  async function diagnostics() {
    const database = await open();
    const [total, originals, thumbnails, pending, estimate] = await Promise.all([
      requestValue(database.transaction('photos', 'readonly').objectStore('photos').count()),
      requestValue(database.transaction('originals', 'readonly').objectStore('originals').count()),
      requestValue(database.transaction('thumbnails', 'readonly').objectStore('thumbnails').count()),
      requestValue(database.transaction('pending', 'readonly').objectStore('pending').count()),
      navigator.storage?.estimate?.().catch(() => null) || Promise.resolve(null)
    ]);
    let persistent = null;
    try { persistent = await navigator.storage?.persisted?.(); } catch {}
    return { total, originals, thumbnails, pending, usage: estimate?.usage ?? null, quota: estimate?.quota ?? null, persistent };
  }

  async function requestPersistence() {
    try { return await navigator.storage?.persist?.() ?? false; } catch { return false; }
  }

  async function makeThumbnail(file, maxDimension = 420) {
    let bitmap;
    try {
      if ('createImageBitmap' in window) bitmap = await createImageBitmap(file);
      else bitmap = await new Promise((resolve, reject) => {
        const image = new Image();
        const url = URL.createObjectURL(file);
        image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
        image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('El navegador no pudo decodificar esta imagen.')); };
        image.src = url;
      });
      const width = bitmap.width, height = bitmap.height, scale = Math.min(1, maxDimension / Math.max(width, height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('No se pudo preparar la miniatura.');
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('No se pudo generar la miniatura.')), 'image/webp', 0.82));
      return { blob, width, height };
    } finally { bitmap?.close?.(); }
  }

  async function fingerprint(file) {
    if (!crypto?.subtle) throw new Error('SHA-256 requiere HTTPS o localhost en este navegador.');
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  window.AgendaPhotoLibrary = { open, count, getPage, get, getOriginal: id => getBlob('originals', id), getThumbnail: id => getBlob('thumbnails', id), stagePhoto, getPending, getFirstPending, completePending, addPhoto, verify, diagnostics, requestPersistence, makeThumbnail, fingerprint, pageSize: PAGE_SIZE };
})();
