// auth.mjs — identity + capability tokens. ed25519 (node:crypto), no deps.
// Model: every actor has the hub's pubkey; agents hold short-lived capability tokens
// minted from the hub key with {actor, scope, exp, jti}. Hub verifies on every POST /cmd.
// Enforcement is automatic: if keys/hub.pub exists (created by `mesh up`), writes
// require a token; reads stay open so the canvas works. MESH_AUTH=1 forces it.
// P6: rotating the hub key invalidates nothing else (public pins change per hub),
// and tokens carry jti so operators can REVOKE a leaked capability instantly.
import { generateKeyPairSync, sign, verify, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
const fpOf = (pubPem) => createHash('sha256').update(pubPem).digest('hex').slice(0, 16);

export const authEnforced = (dir) => process.env.MESH_AUTH === '1' || existsSync(join(dir, 'keys', 'hub.pub'));

export function keygen(dir, { rotate = false } = {}) {
  mkdirSync(join(dir, 'keys'), { recursive: true, mode: 0o700 });
  if (!rotate && existsSync(join(dir, 'keys', 'hub.pub'))) {
    return { ok: true, note: 'keys already exist (pass rotate:true to generate a fresh pair)', fingerprint: fpOf(readPub(dir)) };
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
  if (rotate && existsSync(join(dir, 'keys', 'hub.pub'))) {
    try { writeFileSync(join(dir, 'keys', `hub-rotated-${Date.now()}.pub`), readPub(dir), { mode: 0o644 }); } catch {}
    try { writeFileSync(join(dir, 'keys', `hub-rotated-${Date.now()}.key`), readPriv(dir), { mode: 0o600 }); } catch {}
  }
  writeFileSync(join(dir, 'keys', 'hub.pub'), pub, { mode: 0o644 });
  writeFileSync(join(dir, 'keys', 'hub.key'), priv, { mode: 0o600 });
  return { ok: true, fingerprint: fpOf(pub), qr: `MESH-KEY:${fpOf(pub)}`, ...(rotate ? { rotated: true } : {}) };
}
const readPriv = (dir) => readFileSync(join(dir, 'keys', 'hub.key'), 'utf8');
export const readPub = (dir) => readFileSync(join(dir, 'keys', 'hub.pub'), 'utf8');

const DEFAULT_SCOPE = ['intent.declare', 'intent.release', 'presence', 'request', 'pin', 'decision', 'board', 'voice', 'tasks', 'bot', 'memory', 'audit'];

export function mintToken(dir, { actor, scope = DEFAULT_SCOPE, ttlH = 8 } = {}) {
  const jti = randomBytes(6).toString('hex');
  const header = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'mesh-cap' }));
  const payload = b64u(JSON.stringify({ actor, scope, exp: Date.now() + ttlH * 3600_000, jti }));
  const sig = b64u(sign(null, Buffer.from(`${header}.${payload}`), readPriv(dir)));
  return `${header}.${payload}.${sig}`;
}

// revocation list: .mesh/auth/revoked.json { jti: {by, t, reason} }
const REVOKED = (dir) => join(dir, 'auth', 'revoked.json');
export function revokeToken(dir, { jti, by = 'human', reason = '' } = {}) {
  if (!jti) return { ok: false, error: 'jti required' };
  mkdirSync(join(dir, 'auth'), { recursive: true });
  let list = {};
  try { list = JSON.parse(readFileSync(REVOKED(dir), 'utf8')) || {}; } catch {}
  list[jti] = { by, reason: String(reason).slice(0, 200), t: Date.now() };
  writeFileSync(REVOKED(dir), JSON.stringify(list, null, 2));
  return { ok: true, jti, revoked: Object.keys(list).length };
}
function isRevoked(dir, jti) {
  try { return !!JSON.parse(readFileSync(REVOKED(dir), 'utf8'))[jti]; } catch { return false; }
}

export function verifyToken(pubPem, token, nowMs = Date.now(), { dir = null } = {}) {
  try {
    const [h, p, s] = String(token).split('.');
    if (!h || !p || !s) return { ok: false, error: 'malformed token' };
    const ok = verify(null, Buffer.from(`${h}.${p}`), pubPem, unb64u(s));
    if (!ok) return { ok: false, error: 'bad signature' };
    const body = JSON.parse(unb64u(p).toString());
    if (body.exp < nowMs) return { ok: false, error: 'token expired' };
    if (dir && isRevoked(dir, body.jti)) return { ok: false, error: 'token revoked' };
    return { ok: true, actor: body.actor, scope: body.scope || [], jti: body.jti };
  } catch (e) { return { ok: false, error: String(e.message) }; }
}
// scope check: kind 'intent.declare' must be in token.scope (or scope has '*')
export const scopeAllows = (scope = [], kind) => scope.includes('*') || scope.includes(kind);
// agent tokens are derived from the owner's key with limited scope + 8h default (per plan)
export const fingerprint = (dir) => { try { return fpOf(readPub(dir)); } catch { return null; } };
