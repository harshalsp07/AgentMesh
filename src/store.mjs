// store.mjs — shared zero-dep helpers for all AgentMesh modules.
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync, renameSync, readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const hash = (s) => createHash('sha256').update(String(s)).digest('hex');
export const shortHash = (s) => hash(s).slice(0, 12);
// ULID-lite: sortable, unique enough for lanes/snaps/changes (not cryptographically ordered like real ULID)
export const ulid = (prefix = '') => {
  const t = Date.now().toString(36).padStart(9, '0');
  const r = randomBytes(6).toString('hex');
  return `${prefix}${t}${r}`;
};
export const now = () => Date.now();
export function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + '.tmp', content);
  renameSync(path + '.tmp', path);
}
export function appendJsonl(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(obj) + '\n');
}
export function loadJsonl(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt */ }
  }
  return out;
}
export function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
export function saveJson(path, obj) { atomicWrite(path, JSON.stringify(obj, null, 2)); }
// glob: supports **, *, ? over / separated paths. Good enough for policy/intent scopes.
export function globMatch(glob, path) {
  const g = String(glob), p = String(path);
  const rx = '^' + g.split('/').map((seg) => {
    if (seg === '**') return '.*';
    return seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  }).join('/') + '$';
  if (g.endsWith('/**')) return new RegExp(rx).test(p) || new RegExp('^' + rx.slice(1, -4) + '$').test(p) || p.startsWith(g.slice(0, -3));
  return new RegExp(rx).test(p);
}
export const matchAny = (globs = [], path) => globs.some((g) => globMatch(g, path));
export const truncate = (s, max, note = '<!-- truncated -->') =>
  String(s).length > max ? String(s).slice(0, max) + '\n' + note + '\n' : String(s);
const SECRET_RX = /(sk-[A-Za-z0-9-_]{10,}|ghp_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|api[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9-_]{12,})/g;
export const redactSecrets = (s) => String(s).replace(SECRET_RX, '[REDACTED]');
export const findSecrets = (s) => { const m = String(s).match(SECRET_RX); return m ? [...new Set(m)].slice(0, 5) : []; };
