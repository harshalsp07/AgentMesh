// auth.mjs — identity + capability tokens. ed25519 (node:crypto), no deps.
// Model: every actor has the hub's pubkey; agents hold short-lived capability tokens
// minted from the hub key with {actor, scope, exp}. Hub verifies on every POST /cmd.
// Enforcement is automatic: if keys/hub.pub exists (created by `mesh up`), writes
// require a token; reads stay open so the canvas works. MESH_AUTH=1 forces it.
import { generateKeyPairSync, sign, verify, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
const fpOf = (pubPem) => createHash('sha256').update(pubPem).digest('hex').slice(0, 16);

export const authEnforced = (dir) => process.env.MESH_AUTH === '1' || existsSync(join(dir, 'keys', 'hub.pub'));

export function keygen(dir) {
  mkdirSync(join(dir, 'keys'), { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
  writeFileSync(join(dir, 'keys', 'hub.pub'), pub, { mode: 0o644 });
  writeFileSync(join(dir, 'keys', 'hub.key'), priv, { mode: 0o600 });
  return { ok: true, fingerprint: fpOf(pub), qr: `MESH-KEY:${fpOf(pub)}` };
}
const readPriv = (dir) => readFileSync(join(dir, 'keys', 'hub.key'), 'utf8');
export const readPub = (dir) => readFileSync(join(dir, 'keys', 'hub.pub'), 'utf8');

export function mintToken(dir, { actor, scope = ['intent.declare', 'intent.release', 'presence', 'request', 'pin', 'decision', 'board', 'voice'], ttlH = 8 } = {}) {
  const header = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'mesh-cap' }));
  const payload = b64u(JSON.stringify({ actor, scope, exp: Date.now() + ttlH * 3600_000, jti: randomBytes(6).toString('hex') }));
  const sig = b64u(sign(null, Buffer.from(`${header}.${payload}`), readPriv(dir)));
  return `${header}.${payload}.${sig}`;
}
export function verifyToken(pubPem, token, nowMs = Date.now()) {
  try {
    const [h, p, s] = String(token).split('.');
    if (!h || !p || !s) return { ok: false, error: 'malformed token' };
    const ok = verify(null, Buffer.from(`${h}.${p}`), pubPem, unb64u(s));
    if (!ok) return { ok: false, error: 'bad signature' };
    const body = JSON.parse(unb64u(p).toString());
    if (body.exp < nowMs) return { ok: false, error: 'token expired' };
    return { ok: true, actor: body.actor, scope: body.scope || [] };
  } catch (e) { return { ok: false, error: String(e.message) }; }
}
// scope check: kind 'intent.declare' must be in token.scope (or scope has '*')
export const scopeAllows = (scope = [], kind) => scope.includes('*') || scope.includes(kind);
// agent tokens are derived from the owner's key with limited scope + 8h default (per plan)
export const fingerprint = (dir) => { try { return fpOf(readPub(dir)); } catch { return null; } };
