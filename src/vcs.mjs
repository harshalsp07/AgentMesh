// vcs.mjs — pluggable snapshot backends: git | jj | sqlite.
// Auto order: git (interchange standard, bundles, fsck everywhere) then sqlite
// (zero binaries, single file to replicate). jj is opt-in via MESH_VCS=jj: its op log
// and change IDs fit MeshVCS best, but it must be installed. MESH_VCS=off disables
// backend recording (dir-copy snapshots only). Every call is best-effort safe.
import { gitAvailable, ensureVcsRepo, gitSnapshot, gitRestoreSafe, gitLog, gitFsck, gitBundle } from './gitvcs.mjs';
import { jjAvailable, jjSnapshot, jjRestore, jjLog } from './jjvcs.mjs';
import { sqliteSnapshot, sqliteRestore, sqliteLog, sqliteFsck, sqliteBundle } from './sqlitevcs.mjs';

export function availableBackends() {
  return { git: gitAvailable(), jj: jjAvailable(), sqlite: true };
}
export function selectBackend(root, pref = process.env.MESH_VCS || 'auto') {
  const av = availableBackends();
  if (pref === 'off' || pref === 'none') return 'none';
  if (pref === 'jj') return av.jj ? 'jj' : 'none';
  if (pref === 'git') return av.git ? 'git' : 'none';
  if (pref === 'sqlite') return 'sqlite';
  if (av.git) return 'git'; // auto: interchange standard first
  return 'sqlite';
}
export function vcsSnapshot(root, lane, snapId, opts = {}) {
  const b = selectBackend(root, opts.backend);
  try {
    if (b === 'jj') return jjSnapshot(root, lane, snapId, opts);
    if (b === 'git') return gitSnapshot(root, lane, snapId, opts);
    if (b === 'sqlite') return sqliteSnapshot(root, lane, snapId, opts);
    return { ok: false, skipped: 'vcs off / no backend' };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 300), backend: b }; }
}
export function vcsRestore(root, lane, ref, opts = {}) {
  const b = opts.backend || selectBackend(root);
  try {
    if (b === 'jj') return jjRestore(root, lane, ref);
    if (b === 'git') return gitRestoreSafe(root, lane, ref);
    if (b === 'sqlite') return sqliteRestore(root, lane, ref);
    return { ok: false, skipped: 'vcs off / no backend' };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 300), backend: b }; }
}
export function vcsLog(root, lane, n = 20, backend = selectBackend(root)) {
  try {
    if (backend === 'jj') return jjLog(root, lane, n);
    if (backend === 'git') return { ok: true, backend, log: gitLog(root, lane, n) };
    if (backend === 'sqlite') return { ok: true, backend, log: sqliteLog(root, lane, n).map((c) => `${c.id} ${c.msg}`).join('\n') };
    return { ok: false, skipped: 'vcs off / no backend' };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 300) }; }
}
export function vcsFsck(root, backend = selectBackend(root)) {
  try {
    if (backend === 'git') return { ...gitFsck(root), backend };
    if (backend === 'sqlite') return { ...sqliteFsck(root), backend };
    if (backend === 'jj') return { ok: true, backend, note: 'jj guards integrity via its op log; run `jj op log` / `jj debug snapshot`' };
    return { ok: false, skipped: 'vcs off / no backend' };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 300) }; }
}
export function vcsBundle(root, dest, backend = selectBackend(root)) {
  try {
    if (backend === 'git') return { ...gitBundle(root, dest), backend };
    if (backend === 'sqlite') return { ...sqliteBundle(root, dest), backend };
    return { ok: false, skipped: 'jj bundles via `jj git push` / git bundle of the colocated repo' };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 300) }; }
}
