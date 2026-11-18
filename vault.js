(() => {
  'use strict';

  const root = document.querySelector('#vaultView');
  if (!root) return;
  const DB_NAME = 'AgendaPasswordVault';
  const DB_VERSION = 1;
  const META_STORE = 'meta';
  const RECORD_STORE = 'records';
  const META_KEY = 'vault';
  const ITERATIONS = 600000;
  const IDLE_MS = 5 * 60 * 1000;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let database = null;
  let cryptoKey = null;
  let decryptedRecords = [];
  let idleTimer = 0;
  let lockoutTimer = 0;
  let generation = 0;
  let editingId = null;
  let screenMessage = '';

  const $ = (selector, base = root) => base.querySelector(selector);
  const bytes = size => crypto.getRandomValues(new Uint8Array(size));
  const toBase64 = value => {
    const data = value instanceof Uint8Array ? value : new Uint8Array(value);
    let binary = '';
    for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  const fromBase64 = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
  const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const text = value => String(value ?? '');

  function openDatabase() {
    if (database) return Promise.resolve(database);
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
        if (!db.objectStoreNames.contains(RECORD_STORE)) db.createObjectStore(RECORD_STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => {
        database = request.result;
        database.onversionchange = () => { database.close(); database = null; lock(); };
        resolve(database);
      };
      request.onerror = () => reject(request.error);
    });
  }

  function readMeta() {
    return openDatabase().then(db => new Promise((resolve, reject) => {
      const request = db.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(META_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    }));
  }

  function readRecords() {
    return openDatabase().then(db => new Promise((resolve, reject) => {
      const request = db.transaction(RECORD_STORE, 'readonly').objectStore(RECORD_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    }));
  }

  function countRecords() {
    return openDatabase().then(db => new Promise((resolve, reject) => {
      const request = db.transaction(RECORD_STORE, 'readonly').objectStore(RECORD_STORE).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
  }

  function writeMeta(meta) {
    return openDatabase().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readwrite');
      tx.objectStore(META_STORE).put(meta, META_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('No se pudo guardar la configuración de la bóveda.'));
    }));
  }

  function writeRecord(record) {
    return openDatabase().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(RECORD_STORE, 'readwrite');
      tx.objectStore(RECORD_STORE).put(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('No se pudo guardar la contraseña cifrada.'));
    }));
  }

  function deleteRecord(id) {
    return openDatabase().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(RECORD_STORE, 'readwrite');
      tx.objectStore(RECORD_STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('No se pudo eliminar el registro.'));
    }));
  }

  async function deriveKey(pin, salt) {
    const material = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptBytes(key, clearBytes, additionalData) {
    const iv = bytes(12);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, clearBytes);
    return { iv, ciphertext };
  }

  async function decryptBytes(key, ciphertext, iv, additionalData) {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData }, key, ciphertext));
  }

  const checkAad = encoder.encode('agenda-password-vault-check-v1');
  const recordAad = id => encoder.encode(`agenda-password-vault-record-v1:${id}`);

  function pinInput(id, label, autocomplete = 'new-password') {
    return `<label class="vault-label" for="${id}">${label}<span class="vault-pin-field"><input id="${id}" name="${id}" type="password" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="${autocomplete}" autocapitalize="off" spellcheck="false" required aria-describedby="${id}-hint"><button class="vault-eye" type="button" data-toggle-pin="${id}" aria-label="Mostrar PIN">◉</button></span><small id="${id}-hint">Escribe exactamente seis dígitos.</small></label>`;
  }

  function shell(title, eyebrow, inner) {
    return `<article class="panel vault-panel"><div class="vault-heading"><div><div class="eyebrow">${eyebrow}</div><h2>${title}</h2></div></div>${inner}</article>`;
  }

  function setMessage(message, kind = 'info') {
    const status = $('#vaultStatus');
    if (!status) return;
    status.textContent = message;
    status.className = `vault-status ${kind === 'error' ? 'error' : ''}`;
  }

  function bindPinField(input) {
    input.addEventListener('input', () => {
      const digits = input.value.replace(/[^0-9]/g, '').slice(0, 6);
      if (input.value !== digits) input.value = digits;
    });
    input.addEventListener('paste', event => {
      event.preventDefault();
      const pasted = (event.clipboardData?.getData('text') || '').replace(/[^0-9]/g, '').slice(0, 6);
      const start = input.selectionStart ?? input.value.length;
      input.value = `${input.value.slice(0, start)}${pasted}${input.value.slice(start)}`.slice(0, 6);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function bindPinToggles() {
    root.querySelectorAll('[data-toggle-pin]').forEach(button => {
      button.onclick = () => {
        const input = $(`#${button.dataset.togglePin}`);
        if (!input) return;
        input.type = input.type === 'password' ? 'text' : 'password';
        button.setAttribute('aria-label', input.type === 'password' ? 'Mostrar PIN' : 'Ocultar PIN');
      };
    });
  }

  async function render() {
    const screen = ++generation;
    root.innerHTML = shell('Bóveda de contraseñas', 'ACCESO PRIVADO', '<p class="vault-muted">Cargando almacenamiento cifrado local…</p>');
    try {
      await openDatabase();
      const [meta, recordsCount] = await Promise.all([readMeta(), countRecords()]);
      if (screen !== generation) return;
      if (cryptoKey) {
        await renderUnlocked(screen);
      } else if (meta) {
        renderUnlock(meta);
      } else if (recordsCount > 0) {
        renderRecoveryBlocked();
      } else {
        renderSetup();
      }
    } catch (error) {
      console.error('No se pudo abrir la bóveda local:', error);
      if (screen === generation) root.innerHTML = shell('Bóveda no disponible', 'ALMACENAMIENTO LOCAL', '<p class="vault-status error">Este navegador no pudo abrir el almacenamiento local cifrado.</p>');
    }
  }

  function renderSetup(message = '') {
    root.innerHTML = shell('Crear mi PIN', 'CONFIGURACIÓN INICIAL', `
      <p class="vault-muted">Elige un PIN de seis dígitos y confírmalo. Solo tú lo escribes aquí; la Agenda no genera ni guarda el PIN.</p>
      <form id="vaultSetupForm" class="vault-form" novalidate>
        ${pinInput('vaultPinCreate', 'Crear mi PIN')}
        ${pinInput('vaultPinConfirm', 'Confirmar mi PIN')}
        <button class="save-btn" type="submit">Guardar PIN <span>✓</span></button>
        <div id="vaultStatus" class="vault-status ${message ? 'error' : ''}" role="status">${safe(message)}</div>
      </form>
      <p class="vault-security-note">Las contraseñas se cifran en este dispositivo con AES-256-GCM. Si olvidas el PIN, no existe una opción para recuperarlo.</p>
    `);
    const create = $('#vaultPinCreate'), confirmPin = $('#vaultPinConfirm');
    bindPinField(create); bindPinField(confirmPin); bindPinToggles();
    $('#vaultSetupForm').onsubmit = async event => {
      event.preventDefault();
      const pin = create.value, repeated = confirmPin.value;
      if (!/^\d{6}$/.test(pin) || !/^\d{6}$/.test(repeated)) return setMessage('El PIN debe tener exactamente seis dígitos.', 'error');
      if (pin !== repeated) return setMessage('Los PIN no coinciden.', 'error');
      if (!globalThis.crypto?.subtle || !globalThis.isSecureContext) return setMessage('La bóveda requiere un contexto seguro compatible con Web Crypto (HTTPS o localhost).', 'error');
      const submit = $('button[type="submit"]'); submit.disabled = true; setMessage('Creando el cifrado de la bóveda…');
      const operation = generation;
      try {
        const salt = bytes(16), key = await deriveKey(pin, salt);
        if (operation !== generation) return;
        const check = await encryptBytes(key, encoder.encode('agenda-vault-check-v1'), checkAad);
        const meta = { version: 1, kdf: 'PBKDF2-SHA-256', iterations: ITERATIONS, salt: toBase64(salt), checkIv: toBase64(check.iv), checkCiphertext: toBase64(check.ciphertext), failedAttempts: 0, blockedUntil: 0 };
        await writeMeta(meta);
        if (operation !== generation) return;
        cryptoKey = key; decryptedRecords = []; screenMessage = '';
        await renderUnlocked(generation, 'PIN creado. La bóveda está desbloqueada.');
      } catch (error) {
        console.error('No se pudo crear la bóveda:', error);
        if (operation === generation) { submit.disabled = false; setMessage('No se pudo crear la bóveda en este dispositivo.', 'error'); }
      }
    };
  }

  function renderRecoveryBlocked() {
    root.innerHTML = shell('Bóveda bloqueada', 'ALMACENAMIENTO INCONSISTENTE', `
      <p class="vault-status error" role="status">Hay registros cifrados, pero falta la configuración que permite desbloquearlos. No es posible crear otro PIN sin borrar esos datos.</p>
      <p class="vault-muted">Los registros permanecen cifrados. No borres el almacenamiento del navegador si necesitas conservarlos.</p>
    `);
  }

  function renderUnlock(meta, message = '') {
    if (!meta) { renderRecoveryBlocked(); return; }
    clearTimeout(lockoutTimer);
    const wait = Math.max(0, Number(meta.blockedUntil || 0) - Date.now());
    root.innerHTML = shell('Bóveda de contraseñas', 'ESCRIBE TU PIN DE ACCESO', `
      <form id="vaultUnlockForm" class="vault-form" novalidate>
        ${pinInput('vaultPinUnlock', 'Escribe tu PIN de acceso', 'new-password')}
        <button class="save-btn" type="submit" ${wait ? 'disabled' : ''}>Desbloquear <span>→</span></button>
        <div id="vaultStatus" class="vault-status ${message ? 'error' : ''}" role="status">${safe(wait ? `Demasiados intentos. Inténtalo de nuevo en ${Math.ceil(wait / 1000)} segundos.` : message)}</div>
      </form>
      <p class="vault-security-note">El PIN no se guarda. La bóveda permanece bloqueada hasta que lo escribas.</p>
    `);
    if (wait) lockoutTimer = setTimeout(async () => {
      const current = await readMeta().catch(() => null);
      if (!cryptoKey && !root.classList.contains('hidden')) renderUnlock(current, '');
    }, wait + 20);
    const input = $('#vaultPinUnlock'); bindPinField(input); bindPinToggles();
    $('#vaultUnlockForm').onsubmit = async event => {
      event.preventDefault();
      const pin = input.value;
      if (!/^\d{6}$/.test(pin)) return setMessage('El PIN debe tener exactamente seis dígitos.', 'error');
      const submit = $('button[type="submit"]'); submit.disabled = true; setMessage('Verificando PIN…');
      const operation = generation;
      try {
        const current = await readMeta();
        if (!current || current.version !== 1) throw new Error('Configuración de bóveda no válida.');
        const remaining = Math.max(0, Number(current.blockedUntil || 0) - Date.now());
        if (remaining) { renderUnlock(current); return; }
        const key = await deriveKey(pin, fromBase64(current.salt));
        let check;
        try { check = await decryptBytes(key, fromBase64(current.checkCiphertext), fromBase64(current.checkIv), checkAad); }
        catch { return await registerFailedAttempt(current, operation); }
        if (decoder.decode(check) !== 'agenda-vault-check-v1') return await registerFailedAttempt(current, operation);
        current.failedAttempts = 0; current.blockedUntil = 0; await writeMeta(current);
        if (operation !== generation) return;
        cryptoKey = key;
        await renderUnlocked(generation);
      } catch (error) {
        console.error('No se pudo desbloquear la bóveda:', error);
        if (operation === generation) renderUnlock(await readMeta().catch(() => null), 'No se pudo leer la bóveda cifrada.');
      }
    };
  }

  async function registerFailedAttempt(meta, operation) {
    meta.failedAttempts = Number(meta.failedAttempts || 0) + 1;
    if (meta.failedAttempts >= 5) {
      const blocks = Math.floor((meta.failedAttempts - 1) / 5);
      meta.blockedUntil = Date.now() + Math.min(60 * 60 * 1000, 30 * 1000 * (2 ** blocks));
    }
    await writeMeta(meta);
    if (operation !== generation) return;
    renderUnlock(meta, meta.blockedUntil > Date.now() ? '' : 'PIN incorrecto');
  }

  async function renderUnlocked(screen, message = '') {
    if (!cryptoKey || screen !== generation) return;
    try {
      const encrypted = await readRecords();
      if (!cryptoKey || screen !== generation) return;
      const clear = [];
      for (const record of encrypted) {
        const bytesValue = await decryptBytes(cryptoKey, record.ciphertext, record.iv, recordAad(record.id));
        clear.push({ ...JSON.parse(decoder.decode(bytesValue)), id: record.id });
      }
      if (!cryptoKey || screen !== generation) return;
      decryptedRecords = clear;
      root.innerHTML = `
        <div class="vault-toolbar"><div><div class="eyebrow">ACCESO PRIVADO</div><h2>Bóveda de contraseñas</h2></div><button id="vaultLockBtn" class="media-folder-btn" type="button">Bloquear bóveda</button></div>
        ${message ? `<div id="vaultStatus" class="vault-status" role="status">${safe(message)}</div>` : '<div id="vaultStatus" class="vault-status" role="status"></div>'}
        <p class="vault-muted">La bóveda está desbloqueada solo en esta sesión de la página. Se bloqueará al salir de esta vista, ocultar la página o tras cinco minutos de inactividad.</p>
        <form id="vaultRecordForm" class="panel vault-panel vault-record-form" autocomplete="off">
          <h3>${editingId ? 'Editar contraseña' : 'Agregar contraseña'}</h3>
          <div class="vault-record-grid">
            <label class="vault-label">Nombre o servicio<input name="title" maxlength="100" autocomplete="off" required></label>
            <label class="vault-label">Sitio web<input name="website" type="url" maxlength="300" autocomplete="off" placeholder="https://ejemplo.com"></label>
            <label class="vault-label">Usuario o correo<input name="username" maxlength="200" autocomplete="off"></label>
            <label class="vault-label">Contraseña<span class="vault-pin-field"><input name="password" type="password" maxlength="500" autocomplete="new-password" required><button class="vault-eye" type="button" data-toggle-record-password aria-label="Mostrar contraseña">◉</button></span></label>
            <label class="vault-label vault-wide">Notas<textarea name="notes" rows="2" maxlength="1000" autocomplete="off"></textarea></label>
          </div>
          <div class="vault-form-actions"><button class="save-btn" type="submit">${editingId ? 'Guardar cambios' : 'Guardar contraseña'} <span>✓</span></button>${editingId ? '<button id="vaultCancelEdit" class="cancel-btn" type="button">Cancelar</button>' : ''}</div>
        </form>
        <article class="panel vault-panel"><div class="vault-records-heading"><div><div class="eyebrow">ALMACENAMIENTO CIFRADO</div><h3>Mis contraseñas</h3></div><label class="vault-search-label">Buscar<input id="vaultSearch" type="search" autocomplete="off" placeholder="Filtrar por servicio"></label></div><div id="vaultRecords" class="vault-record-list"></div></article>
      `;
      bindUnlocked();
      fillRecordFormIfEditing();
      drawRecords();
      resetIdleTimer();
    } catch (error) {
      console.error('No se pudieron descifrar los registros:', error);
      lock();
      renderUnlock(await readMeta().catch(() => null), 'No se pudieron descifrar los registros. Comprueba el PIN y el almacenamiento local.');
    }
  }

  function fillRecordFormIfEditing() {
    if (!editingId) return;
    const record = decryptedRecords.find(item => item.id === editingId);
    const form = $('#vaultRecordForm');
    if (!record || !form) { editingId = null; return; }
    for (const field of ['title', 'website', 'username', 'password', 'notes']) form.elements[field].value = text(record[field]);
  }

  function bindUnlocked() {
    $('#vaultLockBtn').onclick = () => { lock(); render(); };
    $('#vaultRecordForm').onsubmit = saveRecord;
    $('#vaultSearch').oninput = drawRecords;
    $('#vaultCancelEdit')?.addEventListener('click', () => { editingId = null; renderUnlocked(generation); });
    $('[data-toggle-record-password]').onclick = event => {
      const input = $('[name="password"]');
      input.type = input.type === 'password' ? 'text' : 'password';
      event.currentTarget.setAttribute('aria-label', input.type === 'password' ? 'Mostrar contraseña' : 'Ocultar contraseña');
    };
    root.onpointerdown = root.onkeydown = resetIdleTimer;
  }

  async function saveRecord(event) {
    event.preventDefault();
    if (!cryptoKey) return lock();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const record = { title: text(values.title).trim(), website: text(values.website).trim(), username: text(values.username).trim(), password: text(values.password), notes: text(values.notes).trim() };
    if (!record.title || !record.password) return setMessage('Escribe un nombre y una contraseña.', 'error');
    const id = editingId || crypto.randomUUID();
    const key = cryptoKey;
    const submit = $('button[type="submit"]', form); submit.disabled = true; setMessage('Cifrando y guardando…');
    try {
      const encrypted = await encryptBytes(key, encoder.encode(JSON.stringify(record)), recordAad(id));
      if (cryptoKey !== key) return;
      await writeRecord({ id, iv: encrypted.iv, ciphertext: encrypted.ciphertext });
      if (cryptoKey !== key) return;
      const existing = decryptedRecords.findIndex(item => item.id === id);
      if (existing >= 0) decryptedRecords[existing] = { ...record, id };
      else decryptedRecords.push({ ...record, id });
      editingId = null;
      await renderUnlocked(generation, 'Contraseña guardada cifrada.');
    } catch (error) {
      console.error('No se pudo guardar el registro cifrado:', error);
      if (cryptoKey === key) { submit.disabled = false; setMessage('No se pudo guardar en IndexedDB.', 'error'); }
    }
  }

  function drawRecords() {
    const list = $('#vaultRecords');
    if (!list || !cryptoKey) return;
    const query = ($('#vaultSearch')?.value || '').trim().toLocaleLowerCase('es');
    const matches = decryptedRecords.filter(record => !query || `${record.title} ${record.website} ${record.username}`.toLocaleLowerCase('es').includes(query));
    list.innerHTML = matches.length ? matches.map(record => `
      <article class="vault-record" data-record-id="${safe(record.id)}">
        <div class="vault-record-head"><div><strong>${safe(record.title)}</strong><small>${safe(record.website || record.username || 'Sin sitio ni usuario')}</small></div><div class="vault-record-actions"><button type="button" class="text-btn" data-edit="${safe(record.id)}">Editar</button><button type="button" class="text-btn vault-delete" data-delete="${safe(record.id)}">Eliminar</button></div></div>
        ${record.username ? `<div class="vault-secret-line"><span>Usuario</span><code>${safe(record.username)}</code></div>` : ''}
        <div class="vault-secret-line"><span>Contraseña</span><div class="vault-password-value"><input type="password" value="${safe(record.password)}" readonly autocomplete="new-password" aria-label="Contraseña de ${safe(record.title)}"><button type="button" class="vault-eye" data-reveal="${safe(record.id)}" aria-label="Mostrar contraseña">◉</button></div></div>
        ${record.notes ? `<p class="vault-record-notes">${safe(record.notes)}</p>` : ''}
      </article>
    `).join('') : '<div class="vault-empty">No hay contraseñas que coincidan. Agrega la primera desde el formulario.</div>';
    list.querySelectorAll('[data-reveal]').forEach(button => button.onclick = () => {
      const input = button.closest('.vault-record').querySelector('.vault-password-value input');
      input.type = input.type === 'password' ? 'text' : 'password';
      button.setAttribute('aria-label', input.type === 'password' ? 'Mostrar contraseña' : 'Ocultar contraseña');
    });
    list.querySelectorAll('[data-edit]').forEach(button => button.onclick = () => { editingId = button.dataset.edit; renderUnlocked(generation); });
    list.querySelectorAll('[data-delete]').forEach(button => button.onclick = async () => {
      const id = button.dataset.delete;
      if (!confirm('¿Eliminar permanentemente esta contraseña cifrada?')) return;
      try {
        await deleteRecord(id);
        decryptedRecords = decryptedRecords.filter(record => record.id !== id);
        if (editingId === id) editingId = null;
        await renderUnlocked(generation, 'Registro eliminado.');
      } catch (error) { console.error(error); setMessage('No se pudo eliminar el registro.', 'error'); }
    });
  }

  function resetIdleTimer() {
    clearTimeout(idleTimer);
    if (!cryptoKey) return;
    idleTimer = setTimeout(() => { lock(); render(); }, IDLE_MS);
  }

  function lock() {
    clearTimeout(idleTimer); clearTimeout(lockoutTimer); idleTimer = 0; lockoutTimer = 0; generation++;
    cryptoKey = null; decryptedRecords = []; editingId = null;
    root.onpointerdown = root.onkeydown = null;
    root.replaceChildren();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && cryptoKey) { lock(); }
    else if (document.visibilityState === 'visible' && !root.classList.contains('hidden') && !cryptoKey) { render(); }
  });
  window.addEventListener('pagehide', lock);
  window.AgendaVault = { render, lock };
})();
