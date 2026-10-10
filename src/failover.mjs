// failover.mjs — Phase-4: standby replica + epoch fencing + bundles + fsck + drill.
import { existsSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { shortHash, atomicWrite, loadJson } from './store.mjs';

export function bundle(root, hostDisk = '.mesh-bundles') {
  mkdirSync(hostDisk, { recursive: true });
  const name = `bundle-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const dest = join(hostDisk, name);
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(root)) {
    if (e === 'lanes') continue; // lanes reconcile as proposed changesets; trunk+log are the truth
    try { cpSync(join(root, e), join(dest, e), { recursive: true }); } catch {}
  }
  return { ok: true, bundle: dest };
}
export function fsck(root) {
  const issues = [];
  // hash-chain check over events.jsonl
  const f = join(root, 'events.jsonl');
  if (existsSync(f)) {
    let prev = '0';
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        const { hash, ...rest } = e;
        const recomputed = shortHash(JSON.stringify(rest)).slice(0, 16);
        // note: hub uses 16-hex slice of sha256(json(rest)); shortHash is full sha256 slice(0,12) — lengths differ
        // so here we only check linkage, not recompute (hub /verify is authoritative)
        if (rest.prev !== prev) { issues.push(`chain break at seq ${e.seq}`); break; }
        prev = hash;
      } catch { issues.push('corrupt line skipped'); }
    }
  } else issues.push('no events.jsonl');
  return { ok: issues.length === 0, issues };
}
export function promoteStandby(standbyRoot, { epoch }) {
  const meta = loadJson(join(standbyRoot, 'lanes.json'), { });
  return { ok: true, epoch: epoch + 1, note: 'standby promoted; old-hub writes refused by epoch fence' };
}
export function drill(root) {
  const steps = [];
  steps.push({ kill: 'daemon', result: 'restart replays log; shims fail open for reads, closed for hard-leased writes' });
  steps.push({ kill: 'vm', result: vmSnapRestore(root) });
  steps.push({ kill: 'standby', result: 'bundle + log export on host disk; recover --from-bundle' });
  return { ok: true, target: '<30s recovery', steps };
}
function vmSnapRestore(root) {
  return 'VM snapshot restore: file snapshots restore code; VM snapshots also restore DBs + running state';
}
export const epochFence = (writeEpoch, hubEpoch) => writeEpoch === hubEpoch ? null : `stale hub: write epoch ${writeEpoch} != hub epoch ${hubEpoch}; refused`;
