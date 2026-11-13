(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const controls = ['#authRegisterBtn', '#authLoginBtn', '#authAddPasskeyBtn', '#authSyncBtn', '#authLogoutBtn'];
  let ready = false;
  let account = null;
  const b64decode = (value) => {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  };
  const b64encode = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  };
  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Error del servidor (${response.status})`);
    return result;
  }
  function say(message) { $('#authStatus').textContent = message; }
  function visible(selector, yes) { $(selector).classList.toggle('hidden', !yes); }
  function render() {
    visible('#authRegisterBtn', ready && !account);
    visible('#authLoginBtn', ready && !account);
    visible('#authAddPasskeyBtn', ready && Boolean(account));
    visible('#authSyncBtn', ready && Boolean(account));
    visible('#authLogoutBtn', ready && Boolean(account));
    if (account) {
      say(`Sesión protegida · ${account.passkeyCount} passkey${account.passkeyCount === 1 ? '' : 's'}`);
      $('#storageMessage').textContent = 'La sincronización usa HTTPS y se controla con passkey. Puedes añadir passkeys en otros dispositivos.';
    }
    window.dispatchEvent(new CustomEvent('agenda-auth-state', { detail: { account } }));
  }
  async function readSession() {
    const result = await api('/api/me');
    account = result.authenticated ? result : null;
    render();
    return account;
  }
  async function ensureService() {
    try {
      const config = await api('/api/config');
      if (!config.configured) throw new Error('El servidor de acceso aún se está configurando.');
      ready = true;
      await readSession();
    } catch (error) {
      ready = false;
      account = null;
      say(location.hostname.endsWith('github.io') ? 'Para passkeys y sincronización, abre la app alojada en Railway.' : 'El servicio de sincronización no está disponible. Tus datos locales siguen funcionando.');
      render();
    }
  }
  async function registerPasskey() {
    if (!window.PublicKeyCredential || !navigator.credentials?.create) throw new Error('Este navegador no admite passkeys. Actualízalo o prueba otro navegador.');
    const options = await api('/api/auth/register/options', { method: 'POST', body: '{}' });
    options.challenge = b64decode(options.challenge);
    options.user.id = b64decode(options.user.id);
    for (const entry of options.excludeCredentials || []) entry.id = b64decode(entry.id);
    const credential = await navigator.credentials.create({ publicKey: options });
    if (!credential) throw new Error('No se creó la passkey.');
    const result = await api('/api/auth/register/verify', { method: 'POST', body: JSON.stringify({ credential: {
      id: credential.id, rawId: b64encode(credential.rawId), type: credential.type,
      response: { clientDataJSON: b64encode(credential.response.clientDataJSON), attestationObject: b64encode(credential.response.attestationObject), transports: credential.response.getTransports?.() || [] },
      clientExtensionResults: credential.getClientExtensionResults(),
    } }) });
    if (!result.verified) throw new Error('No se pudo verificar la passkey.');
    await readSession();
    await window.AgendaSync?.reconcile?.();
  }
  async function loginPasskey() {
    if (!window.PublicKeyCredential || !navigator.credentials?.get) throw new Error('Este navegador no admite passkeys. Actualízalo o prueba otro navegador.');
    const options = await api('/api/auth/login/options', { method: 'POST', body: '{}' });
    options.challenge = b64decode(options.challenge);
    for (const entry of options.allowCredentials || []) entry.id = b64decode(entry.id);
    const credential = await navigator.credentials.get({ publicKey: options });
    if (!credential) throw new Error('No se inició sesión.');
    const result = await api('/api/auth/login/verify', { method: 'POST', body: JSON.stringify({ credential: {
      id: credential.id, rawId: b64encode(credential.rawId), type: credential.type,
      response: { authenticatorData: b64encode(credential.response.authenticatorData), clientDataJSON: b64encode(credential.response.clientDataJSON), signature: b64encode(credential.response.signature), userHandle: credential.response.userHandle ? b64encode(credential.response.userHandle) : null },
      clientExtensionResults: credential.getClientExtensionResults(),
    } }) });
    if (!result.verified) throw new Error('No se pudo verificar la passkey.');
    await readSession();
    await window.AgendaSync?.reconcile?.();
  }
  async function run(button, action, message) {
    button.disabled = true;
    say(message);
    try { await action(); }
    catch (error) { say(error.message || 'No se pudo completar la operación.'); }
    finally { button.disabled = false; }
  }
  $('#authRegisterBtn').onclick = (event) => run(event.currentTarget, registerPasskey, 'Sigue las instrucciones para crear una passkey…');
  $('#authLoginBtn').onclick = (event) => run(event.currentTarget, loginPasskey, 'Confirma tu passkey en el dispositivo…');
  $('#authAddPasskeyBtn').onclick = (event) => run(event.currentTarget, registerPasskey, 'Sigue las instrucciones para registrar este dispositivo…');
  $('#authSyncBtn').onclick = (event) => run(event.currentTarget, async () => { await window.AgendaSync?.reconcile?.(); }, 'Sincronizando…');
  $('#authLogoutBtn').onclick = (event) => run(event.currentTarget, async () => { await api('/api/auth/logout', { method: 'POST', body: '{}' }); account = null; render(); say('Sesión cerrada en este dispositivo.'); }, 'Cerrando sesión…');
  window.AgendaAuth = { refresh: ensureService, sync: () => account ? window.AgendaSync?.reconcile?.() : Promise.resolve(), api, get account() { return account; } };
  ensureService();
})();
