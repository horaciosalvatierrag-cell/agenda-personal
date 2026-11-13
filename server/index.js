import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'agenda.sqlite');
const appOrigin = process.env.APP_ORIGIN;
const sessionCookie = 'agenda_session';
const stateCookie = 'agenda_webauthn_state';
const challengeTtl = 5 * 60 * 1000;
const sessionTtl = 30 * 24 * 60 * 60 * 1000;
const maxSnapshotBytes = 8 * 1024 * 1024;
const pendingChallenges = new Map();

if (appOrigin) {
  const parsedOrigin = new URL(appOrigin);
  if (parsedOrigin.protocol !== 'https:' && parsedOrigin.hostname !== 'localhost') {
    throw new Error('APP_ORIGIN must use HTTPS');
  }
}

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS passkeys (
    credential_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL, counter INTEGER NOT NULL, transports TEXT NOT NULL DEFAULT '[]',
    name TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS passkeys_user_id ON passkeys(user_id);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS agenda_snapshots (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, revision INTEGER NOT NULL DEFAULT 0, snapshot TEXT, updated_at INTEGER NOT NULL);
`);

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const cookieOptions = (maxAge) => ({ httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge });
const rpID = () => appOrigin ? new URL(appOrigin).hostname : 'localhost';
const originOK = (req) => !appOrigin || req.get('origin') === appOrigin;
const requireSameOrigin = (req, res, next) => {
  if (!originOK(req) || req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Origen rechazado' });
  next();
};
const requireConfiguredOrigin = (req, res, next) => {
  if (!appOrigin) return res.status(503).json({ error: 'El servicio aún se está configurando' });
  next();
};

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '12mb', strict: true }));
app.use('/api', requireSameOrigin);
app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false });
app.use('/api/auth', authLimiter);

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) {
      try { out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim()); }
      catch { /* Ignore malformed cookie values. */ }
    }
  }
  return out;
}
function beginChallenge(res, payload) {
  const state = randomToken();
  pendingChallenges.set(hash(state), { ...payload, expiresAt: Date.now() + challengeTtl });
  res.cookie(stateCookie, state, cookieOptions(challengeTtl));
}
function readChallenge(req, res, type) {
  const state = cookies(req)[stateCookie];
  res.clearCookie(stateCookie, cookieOptions(0));
  const key = state && hash(state);
  const pending = key && pendingChallenges.get(key);
  if (key) pendingChallenges.delete(key);
  if (!pending || pending.expiresAt < Date.now() || pending.type !== type) return null;
  return pending;
}
function setSession(res, userId) {
  const token = randomToken();
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash(token), userId, Date.now() + sessionTtl);
  res.cookie(sessionCookie, token, cookieOptions(sessionTtl));
}
function currentUser(req) {
  const token = cookies(req)[sessionCookie];
  if (!token) return null;
  const row = db.prepare('SELECT users.id, users.display_name FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>?').get(hash(token), Date.now());
  return row || null;
}
function requireUser(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Inicia sesión con tu passkey' });
  req.user = user;
  next();
}
function apiError(res, error) {
  console.error('API request failed:', error?.message || error);
  return res.status(400).json({ error: 'No se pudo completar la operación. Intenta de nuevo.' });
}

app.get('/api/config', (req, res) => res.json({ configured: Boolean(appOrigin) }));
app.get('/api/me', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.json({ authenticated: false });
  const count = db.prepare('SELECT COUNT(*) AS count FROM passkeys WHERE user_id=?').get(user.id).count;
  res.json({ authenticated: true, userId: user.id, displayName: user.display_name, passkeyCount: count });
});

app.post('/api/auth/register/options', requireConfiguredOrigin, async (req, res) => {
  try {
    const sessionUser = currentUser(req);
    const userId = sessionUser?.id || crypto.randomUUID();
    const displayName = sessionUser?.display_name || 'Mi agenda';
    const existing = sessionUser ? db.prepare('SELECT credential_id, transports FROM passkeys WHERE user_id=?').all(userId) : [];
    const options = await generateRegistrationOptions({
      rpName: 'Agenda Personal', rpID: rpID(), userID: Buffer.from(userId), userName: displayName,
      attestationType: 'none', timeout: 60000, supportedAlgorithmIDs: [-7, -257],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: existing.map((key) => ({ id: key.credential_id, type: 'public-key', transports: JSON.parse(key.transports) })),
    });
    beginChallenge(res, { type: 'register', challenge: options.challenge, userId, displayName, authenticated: Boolean(sessionUser) });
    res.json(options);
  } catch (error) { apiError(res, error); }
});

app.post('/api/auth/register/verify', requireConfiguredOrigin, async (req, res) => {
  try {
    const pending = readChallenge(req, res, 'register');
    if (!pending) return res.status(400).json({ error: 'El reto caducó; vuelve a intentarlo' });
    if (pending.authenticated && currentUser(req)?.id !== pending.userId) return res.status(401).json({ error: 'La sesión expiró' });
    const verification = await verifyRegistrationResponse({ response: req.body?.credential, expectedChallenge: pending.challenge, expectedOrigin: appOrigin, expectedRPID: rpID(), requireUserVerification: true });
    if (!verification.verified || !verification.registrationInfo) return res.status(400).json({ error: 'No se pudo verificar la passkey' });
    const { credential } = verification.registrationInfo;
    const duplicate = db.prepare('SELECT user_id FROM passkeys WHERE credential_id=?').get(credential.id);
    if (duplicate) return res.status(409).json({ error: 'Esta passkey ya está asociada a una cuenta' });
    const now = Date.now();
    const addPasskey = db.transaction(() => {
      if (!pending.authenticated) db.prepare('INSERT INTO users(id,display_name,created_at) VALUES(?,?,?)').run(pending.userId, pending.displayName, now);
      db.prepare('INSERT INTO passkeys(credential_id,user_id,public_key,counter,transports,name,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(credential.id, pending.userId, Buffer.from(credential.publicKey).toString('base64url'), credential.counter, JSON.stringify(credential.transports || []), 'Passkey', now);
      db.prepare('INSERT OR IGNORE INTO agenda_snapshots(user_id,revision,snapshot,updated_at) VALUES(?,0,NULL,?)').run(pending.userId, now);
    });
    addPasskey();
    if (!pending.authenticated) setSession(res, pending.userId);
    res.json({ verified: true });
  } catch (error) { apiError(res, error); }
});

app.post('/api/auth/login/options', requireConfiguredOrigin, async (req, res) => {
  try {
    const options = await generateAuthenticationOptions({ rpID: rpID(), timeout: 60000, userVerification: 'required', allowCredentials: [] });
    beginChallenge(res, { type: 'login', challenge: options.challenge });
    res.json(options);
  } catch (error) { apiError(res, error); }
});

app.post('/api/auth/login/verify', requireConfiguredOrigin, async (req, res) => {
  try {
    const pending = readChallenge(req, res, 'login');
    if (!pending) return res.status(400).json({ error: 'El reto caducó; vuelve a intentarlo' });
    const id = req.body?.credential?.id;
    if (typeof id !== 'string' || id.length > 2048) return res.status(400).json({ error: 'Passkey no válida' });
    const key = db.prepare('SELECT passkeys.*, users.display_name FROM passkeys JOIN users ON users.id=passkeys.user_id WHERE credential_id=?').get(id);
    if (!key) return res.status(401).json({ error: 'Esta passkey no está registrada en Agenda' });
    const verification = await verifyAuthenticationResponse({
      response: req.body.credential, expectedChallenge: pending.challenge, expectedOrigin: appOrigin, expectedRPID: rpID(),
      credential: { id: key.credential_id, publicKey: Buffer.from(key.public_key, 'base64url'), counter: key.counter, transports: JSON.parse(key.transports) },
      requireUserVerification: true,
    });
    if (!verification.verified) return res.status(401).json({ error: 'No se pudo verificar la passkey' });
    db.prepare('UPDATE passkeys SET counter=? WHERE credential_id=?').run(verification.authenticationInfo.newCounter, id);
    setSession(res, key.user_id);
    res.json({ verified: true });
  } catch (error) { apiError(res, error); }
});

app.post('/api/auth/logout', (req, res) => {
  const token = cookies(req)[sessionCookie];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
  res.clearCookie(sessionCookie, cookieOptions(0));
  res.json({ authenticated: false });
});

app.get('/api/sync', requireUser, (req, res) => {
  const record = db.prepare('SELECT revision,snapshot FROM agenda_snapshots WHERE user_id=?').get(req.user.id);
  res.json({ revision: record?.revision || 0, snapshot: record?.snapshot || null });
});
app.put('/api/sync', requireUser, (req, res) => {
  const { baseRevision, snapshot } = req.body || {};
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 || typeof snapshot !== 'string' || snapshot.length > Math.ceil(maxSnapshotBytes * 4 / 3)) {
    return res.status(413).json({ error: 'El respaldo no es válido o supera el límite de 8 MB' });
  }
  let bytes;
  try { bytes = Buffer.from(snapshot, 'base64'); } catch { return res.status(400).json({ error: 'El respaldo no es válido' }); }
  if (bytes.length > maxSnapshotBytes || bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') return res.status(400).json({ error: 'El archivo SQLite no es válido' });
  const update = db.prepare('UPDATE agenda_snapshots SET revision=revision+1,snapshot=?,updated_at=? WHERE user_id=? AND revision=?').run(snapshot, Date.now(), req.user.id, baseRevision);
  if (!update.changes) {
    const latest = db.prepare('SELECT revision,snapshot FROM agenda_snapshots WHERE user_id=?').get(req.user.id);
    return res.status(409).json({ error: 'La copia en la nube cambió en otro dispositivo', revision: latest?.revision || 0, snapshot: latest?.snapshot || null });
  }
  const revision = db.prepare('SELECT revision FROM agenda_snapshots WHERE user_id=?').get(req.user.id).revision;
  res.json({ revision });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', configured: Boolean(appOrigin) }));
app.use((req, res, next) => {
  if (req.path === '/server' || req.path.startsWith('/server/') || req.path === '/node_modules' || req.path.startsWith('/node_modules/') || req.path === '/package.json' || req.path === '/package-lock.json') return res.sendStatus(404);
  next();
});
app.use(express.static(path.resolve(__dirname, '..'), { index: 'index.html', dotfiles: 'deny', fallthrough: true, maxAge: '1h', setHeaders(res, filePath) { if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store'); } }));
app.get('*path', (req, res) => res.sendFile(path.resolve(__dirname, '..', 'index.html')));

app.listen(port, '0.0.0.0', () => console.log(`Agenda Personal server listening on ${port}`));
