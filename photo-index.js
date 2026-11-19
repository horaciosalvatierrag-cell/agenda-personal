(() => {
  'use strict';

  const DB_NAME = 'AgendaPhotoFolder';
  const DB_VERSION = 3;
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
        if (!photos.indexNames.contains('by-modified')) photos.createIndex('by-modified', ['lastModified', 'folderId', 'path'], { unique: false });
        const cursorRequest = photos.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          if (typeof cursor.value.lastModified !== 'number' || !Number.isFinite(cursor.value.lastModified)) cursor.update({ ...cursor.value, lastModified: 0 });
          cursor.continue();
        };
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

  async function getPhotoCount(folderId = '') {
    const db = await open();
    const store = db.transaction(PHOTO_STORE, 'readonly').objectStore(PHOTO_STORE);
    return requestValue(folderId ? store.index('by-folder').count(folderId) : store.count());
  }

  async function getPhotosPage(afterKey = null, limit = 1000) {
    const db = await open();
    const store = db.transaction(PHOTO_STORE, 'readonly').objectStore(PHOTO_STORE);
    return new Promise((resolve, reject) => {
      const rows = [];
      const range = afterKey ? IDBKeyRange.upperBound(afterKey, true) : undefined;
      const request = store.index('by-modified').openCursor(range, 'prev');
      let nextKey = null;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || rows.length >= limit) {
          resolve({ rows, nextKey, done: !cursor });
          return;
        }
        rows.push(cursor.value);
        nextKey = cursor.key;
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

  async function getPhotosByFolderPage(folderId, afterPath = null, limit = 1000) {
    const db = await open();
    const store = db.transaction(PHOTO_STORE, 'readonly').objectStore(PHOTO_STORE);
    return new Promise((resolve, reject) => {
      const rows = [];
      const lowerKey = afterPath ? [folderId, afterPath] : [folderId, ''];
      const request = store.openCursor(IDBKeyRange.lowerBound(lowerKey, Boolean(afterPath)));
      let nextPath = null;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || cursor.primaryKey[0] !== folderId || rows.length >= limit) {
          resolve({ rows, nextPath, done: !cursor || cursor.primaryKey[0] !== folderId });
          return;
        }
        rows.push(cursor.value);
        nextPath = cursor.primaryKey[1];
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

  async function getThumbnail(folderId, path, signature, { allowStale = false } = {}) {
    const db = await open();
    const row = await requestValue(db.transaction(THUMB_STORE, 'readonly').objectStore(THUMB_STORE).get([folderId, path]));
    return row && (allowStale || row.signature === signature) ? row : null;
  }

  async function getThumbnailKeys() {
    const db = await open();
    const store = db.transaction(THUMB_STORE, 'readonly').objectStore(THUMB_STORE);
    return new Promise((resolve, reject) => {
      const keys = [];
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(keys); return; }
        const row = cursor.value;
        if (row?.folderId && typeof row.path === 'string') keys.push({ folderId: row.folderId, path: row.path });
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

  function saveBatch(folderId, rows) {
    if (!rows.length) return Promise.resolve();
    return transaction([PHOTO_STORE], 'readwrite', tx => {
      const store = tx.objectStore(PHOTO_STORE);
      rows.forEach(row => {
        const request = store.get([folderId, row.path]);
        request.onsuccess = () => {
          const previous = request.result || {};
          store.put({
            ...previous,
            ...row,
            id: row.id || `${folderId}:${row.path}`,
            folderId,
            indexedAt: row.indexedAt || previous.indexedAt || Date.now(),
            checkedAt: Date.now(),
            available: row.available !== false,
            availabilityStatus: row.available === false ? 'missing' : 'available'
          });
        };
      });
    });
  }

  function saveThumbnail(row) {
    return transaction([THUMB_STORE], 'readwrite', tx => tx.objectStore(THUMB_STORE).put(row));
  }

  async function markUnavailable(folderId, seenPaths) {
    const db = await open();
    const photos = db.transaction(PHOTO_STORE, 'readonly').objectStore(PHOTO_STORE);
    const missing = await new Promise((resolve, reject) => {
      const request = photos.index('by-folder').openCursor(folderId);
      const rows = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(rows); return; }
        const row = cursor.value;
        if (!seenPaths.has(row.path) && row.available !== false) rows.push(row);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
    if (!missing.length) return 0;
    await transaction([PHOTO_STORE], 'readwrite', tx => {
      const photos = tx.objectStore(PHOTO_STORE);
      missing.forEach(row => photos.put({ ...row, available: false, availabilityStatus: 'missing', checkedAt: Date.now() }));
    });
    return missing.length;
  }

  async function reconcile(folderId, seenPaths) { return markUnavailable(folderId, seenPaths); }

  async function requestPersistence() {
    const storage = navigator.storage;
    let persisted = false;
    if (storage?.persisted) persisted = await storage.persisted();
    if (!persisted && storage?.persist) persisted = await storage.persist();
    const estimate = storage?.estimate ? await storage.estimate() : null;
    return { persisted, usage: estimate?.usage ?? null, quota: estimate?.quota ?? null };
  }

  async function diagnostics(folderId = '') {
    const db = await open();
    const photosStore = db.transaction(PHOTO_STORE, 'readonly').objectStore(PHOTO_STORE);
    const photos = await new Promise((resolve, reject) => {
      const request = folderId ? photosStore.index('by-folder').openCursor(folderId) : photosStore.openCursor();
      const result = { count: 0, unavailable: 0 };
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(result); return; }
        result.count++;
        if (cursor.value.available === false) result.unavailable++;
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
    const thumbnailStore = db.transaction(THUMB_STORE, 'readonly').objectStore(THUMB_STORE);
    const thumbs = await new Promise((resolve, reject) => {
      const request = thumbnailStore.openCursor();
      const result = { count: 0, bytes: 0, invalid: 0 };
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(result); return; }
        if (!folderId || cursor.value.folderId === folderId) {
          const blob = cursor.value.blob;
          if (blob instanceof Blob && blob.size > 0 && (!blob.type || blob.type.startsWith('image/'))) {
            result.count++;
            result.bytes += blob.size;
          } else result.invalid++;
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
    return {
      indexedPhotos: photos.count,
      cachedThumbnails: thumbs.count,
      invalidThumbnailRecords: thumbs.invalid,
      unavailableOriginals: photos.unavailable,
      thumbnailBytes: thumbs.bytes,
      storage: await requestPersistence()
    };
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

  window.AgendaPhotoIndex = Object.freeze({ open, getPhotoCount, getPhotosPage, getPhotosByFolderPage, getThumbnail, getThumbnailKeys, saveBatch, saveThumbnail, reconcile, markUnavailable, requestPersistence, diagnostics, makeThumbnail });
})();
