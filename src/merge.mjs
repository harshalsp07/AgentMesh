// merge.mjs — three-way merge with real tooling. `git merge-file` first (line-precise,
// zero new deps); naive fallback only when git is absent. Unmergeable results become
// conflict OBJECTS (data, never a broken tree) for the negotiation ladder.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gitAvailable } from './gitvcs.mjs';

export function threeWayMerge({ base = '', ours = '', theirs = '', label = 'file' } = {}) {
  if (gitAvailable()) {
    const tmp = mkdtempSync(join(tmpdir(), 'mesh-merge-'));
    try {
      const fb = join(tmp, 'base'), fo = join(tmp, 'ours'), ft = join(tmp, 'theirs');
      writeFileSync(fb, base); writeFileSync(fo, ours); writeFileSync(ft, theirs);
      const r = spawnSync('git', ['merge-file', '-p', '-L', `ours(${label})`, '-L', 'base', '-L', `theirs(${label})`, fo, fb, ft], { encoding: 'utf8', timeout: 30000 });
      if (r.status === 0) return { ok: true, merged: r.stdout, method: 'git merge-file' };
      return { ok: false, conflict: { file: label, markers: r.stdout, method: 'git merge-file', note: 'resolve in scratch lane or escalate' } };
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  // naive fallback: identical-to-one-side wins; else conflict object
  if (ours === base) return { ok: true, merged: theirs, method: 'naive-theirs' };
  if (theirs === base) return { ok: true, merged: ours, method: 'naive-ours' };
  if (ours === theirs) return { ok: true, merged: ours, method: 'naive-same' };
  return { ok: false, conflict: { file: label, method: 'naive', ours: ours.slice(0, 500), theirs: theirs.slice(0, 500) } };
}
export const hasConflictMarkers = (s) => /^(<{7}|={7}|>{7}|\|{7})/m.test(String(s));
