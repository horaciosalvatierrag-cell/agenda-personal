(() => {
  'use strict';

  const DB_NAME = 'AgendaPhotoFolder';
  const DB_VERSION = 2;
  const HANDLE_STORE = 'handles';
  const PHOTO_STORE = 'photo-index';
  const THUMB_STORE = 'photo-thumbnails';
  let dbPromise;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
        const photos = db.objectStoreNames.contains(PHOTO_STORE)
          ? request.transaction.objectStore(PHOTO_STORE)
          : db.createObjectStore(PHOTO_STORE, { keyPath: ['folderId', 'path'] });
        if (!photos.indexNames.contains('by-folder')) photos.createIndex('by-folder', 'folderId', { unique: false });
        if (!db.objectStoreNames.contains(THUMB_STORE)) db.createObjectStore(THUMB_STORE, { keyPath: ['folderId', 'path'] });
      };
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => { dbPromise = null; reject(request.error); };
      request.onblocked = () => { dbPromise = null; reject(new Error('Cierra otras pestañas de Agenda para actualizar el índice de fotos.')); };
    });
    return dbPromise;
  }

  function transaction(stores, mode, work) {
    return open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result;
      try { result = work(tx); } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('No se pudo actualizar el índice local de fotos.'));
      tx.onabort = () => reject(tx.error || new Error('Se canceló la actualización del índice local de fotos.'));
    }));
  }

  function requestValue(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getPhotos(folderId) {
    const db = await open();
    return requestValue(db.transaction(PHOTO_STORE, 'readonly').objectStore(PHOTO_STORE).index('by-folder').getAll(folderId));
  }

  async function getThumbnail(folderId, path, signature) {
    const db = await open();
    const row = await requestValue(db.transaction(THUMB_STORE, 'readonly').objectStore(THUMB_STORE).get([folderId, path]));
    return row?.signature === signature ? row : null;
  }

  function saveBatch(folderId, rows) {
    if (!rows.length) return Promise.resolve();
    return transaction([PHOTO_STORE], 'readwrite', tx => {
      const store = tx.objectStore(PHOTO_STORE);
      rows.forEach(row => store.put({ ...row, folderId }));
    });
  }

  function saveThumbnail(row) {
    return transaction([THUMB_STORE], 'readwrite', tx => tx.objectStore(THUMB_STORE).put(row));
  }

  async function removeChangedThumbnail(folderId, path) {
    return transaction([THUMB_STORE], 'readwrite', tx => tx.objectStore(THUMB_STORE).delete([folderId, path]));
  }

  async function reconcile(folderId, seenPaths) {
    const db = await open();
    const oldRows = await requestValue(db.transaction(PHOTO_STORE, 'readonly').objectStore(PHOTO_STORE).index('by-folder').getAll(folderId));
    const missing = oldRows.filter(row => !seenPaths.has(row.path));
    if (!missing.length) return 0;
    await transaction([PHOTO_STORE, THUMB_STORE], 'readwrite', tx => {
      const photos = tx.objectStore(PHOTO_STORE), thumbs = tx.objectStore(THUMB_STORE);
      missing.forEach(row => { photos.delete([folderId, row.path]); thumbs.delete([folderId, row.path]); });
    });
    return missing.length;
  }

  async function makeThumbnail(file, maxSize = 360) {
    let bitmap = null, objectUrl = '', source, width, height;
    try {
      if ('createImageBitmap' in window) {
        try { bitmap = await createImageBitmap(file); } catch { bitmap = null; }
      }
      if (bitmap) { source = bitmap; width = bitmap.width; height = bitmap.height; }
      else {
        objectUrl = URL.createObjectURL(file);
        const image = new Image(); image.src = objectUrl; await image.decode();
        source = image; width = image.naturalWidth; height = image.naturalHeight;
      }
      const scale = Math.min(1, maxSize / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
      let blob = null;
      if (bitmap && 'OffscreenCanvas' in window) {
        try {
          const canvas = new OffscreenCanvas(w, h);
          canvas.getContext('2d', { alpha: false }).drawImage(source, 0, 0, w, h);
          blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.78 });
        } catch { blob = null; }
      }
      if (!blob) {
        const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) return null;
        context.drawImage(source, 0, 0, w, h);
        blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.78));
      }
      return blob ? { blob, width, height } : null;
    } catch (error) {
      console.warn('Could not create an optimized photo thumbnail:', error);
      return null;
    } finally { bitmap?.close(); if (objectUrl) URL.revokeObjectURL(objectUrl); }
  }

  window.AgendaPhotoIndex = Object.freeze({ open, getPhotos, getThumbnail, saveBatch, saveThumbnail, removeChangedThumbnail, reconcile, makeThumbnail });
})();
