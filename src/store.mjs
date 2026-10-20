// store.mjs — shared zero-dep helpers for all AgentMesh modules.
import { createHash, randomBytes } from 'node:crypto';
import {
  writeFileSync, renameSync, readFileSync, existsSync, appendFileSync, mkdirSync,
  openSync, closeSync, fsyncSync, unlinkSync, copyFileSync,
} from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';

export const hash = (s) => createHash('sha256').update(String(s)).digest('hex');
export const shortHash = (s) => hash(s).slice(0, 12);
// ULID-lite: sortable, unique enough for lanes/snaps/changes (not cryptographically ordered like real ULID)
export const ulid = (prefix = '') => {
  const t = Date.now().toString(36).padStart(9, '0');
  const r = randomBytes(6).toString('hex');
  return `${prefix}${t}${r}`;
};
export const now = () => Date.now();
// --- durable atomic write -------------------------------------------------
// Production requirements this satisfies:
//   1. CONCURRENCY: the temp name is unique per writer, so two processes writing
//      the same target never share a scratch file (the old fixed `path + '.tmp'`
//      let them interleave bytes and one rename lost the other's data).
//   2. DURABILITY: the file is fsync'd before the rename and the parent
//      directory is fsync'd after it, so a power loss cannot leave a truncated
//      or unlinked file where a valid one used to be.
//   3. WINDOWS: `rename` on Windows transiently fails with EPERM/EBUSY when an
//      AV scanner or indexer holds the target. Node throws; the old code lost
//      the write. We retry with backoff and fall back to copy+unlink.
const RENAME_ATTEMPTS = 8;
const sleepSync = (ms) => {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
};
function renameDurable(from, to) {
  let last = null;
  for (let i = 0; i < RENAME_ATTEMPTS; i++) {
    try { renameSync(from, to); return true; }
    catch (e) {
      last = e;
      // EPERM/EBUSY/EACCY on Windows = transient handle; anything else is fatal.
      if (!['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(e.code)) break;
      sleepSync(10 * (i + 1));
    }
  }
  // Last resort: non-atomic but still lands the bytes.
  try { copyFileSync(from, to); try { unlinkSync(from); } catch {} return true; } catch {}
  throw last || new Error(`atomicWrite: rename failed for ${to}`);
}
function fsyncDir(dir) {
  // POSIX only: Windows cannot fsync a directory handle.
  if (process.platform === 'win32') return;
  try {
    const fd = openSync(dir, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* not fsyncable (e.g. some mounts) — best effort */ }
}
export function atomicWrite(path, content) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = pathJoin(dir, `.${path.slice(dir.length + 1).replace(/[\\/]/g, '_')}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } catch (e) {
    // Never leave a half-written scratch file behind.
    try { closeSync(fd); } catch {}
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
  closeSync(fd);
  renameDurable(tmp, path);
  fsyncDir(dir);
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
