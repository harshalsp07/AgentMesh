// test/cleanup.mjs — Windows-aware child kill + locked-dir cleanup for hub tests.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function killChild(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'pipe', timeout: 8000 });
    } else {
      child.kill('SIGTERM');
    }
  } catch {}
}

// rmSync can hit EPERM/EBUSY on Windows while a just-killed server still holds the
// SQLite WAL file open; a few short awaited retries are reliably enough.
export async function rmSafe(dir, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return true; }
    catch (e) { if (i === attempts - 1) return false; await sleep(120 * (i + 1)); }
  }
  return false;
}

// node --test runs test files in parallel, so two suites that pick the same
// port silently talk to each other's hub — which is how a 401 from a keyed hub
// looked like a product bug. Every suite that binds a port should claim it
// first so the collision is reported as a collision.
export async function claimPort(port, host = '127.0.0.1') {
  const url = `http://${host}:${port}/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(500) });
    if (res.ok) throw new Error(`port ${port} is already in use by another test suite`);
  } catch (e) {
    if (String(e?.message || '').includes('already in use')) throw e;
  }
  return true;
}
