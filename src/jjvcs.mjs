// jjvcs.mjs — Jujutsu adapter (the "modified git" path). jj's own operation log,
// automatic snapshots and stable change IDs map 1:1 onto MeshVCS concepts, so when
// `jj` is installed (MESH_VCS=jj) snapshots become jj commits carrying our Change-ID
// in the description, and `jj evolog` backs the MeshVCS op log. All calls are guarded:
// without a jj binary every op returns {ok:false, skipped} instead of throwing.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function jjAvailable() {
  if (process.env.MESH_NO_JJ === '1') return false;
  try { execFileSync('jj', ['--version'], { stdio: 'pipe', timeout: 10000 }); return true; } catch { return false; }
}
const SKIP = { ok: false, skipped: 'jj not installed (set MESH_VCS=git|sqlite, or install jujutsu)' };
const dir = (root) => join(root, 'vcsjj');
const run = (root, ...args) => execFileSync('jj', args, { cwd: dir(root), stdio: 'pipe', timeout: 60000 }).toString().trim();

export function ensureJjRepo(root) {
  if (!jjAvailable()) return SKIP;
  try {
    mkdirSync(dir(root), { recursive: true });
    if (!existsSync(join(dir(root), '.jj'))) {
      execFileSync('jj', ['git', 'init', '--colocate'], { cwd: dir(root), stdio: 'pipe', timeout: 60000 });
      execFileSync('jj', ['config', 'set', '--repo', 'user.name', 'AgentMesh'], { cwd: dir(root), stdio: 'pipe' });
      execFileSync('jj', ['config', 'set', '--repo', 'user.email', 'mesh@agentmesh'], { cwd: dir(root), stdio: 'pipe' });
    }
    return { ok: true, dir: dir(root) };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 300) }; }
}
// snapshot: sync lane files into the wc, describe with our Change-ID, report ids
export function jjSnapshot(root, lane, snapId, { message = '' } = {}) {
  if (!jjAvailable()) return SKIP;
  const r = ensureJjRepo(root);
  if (!r.ok) return r;
  try {
    const lanePath = join(root, 'lanes', lane);
    // clear previously tracked lane files (keep .jj/.git)
    let tracked = [];
    try { tracked = run(root, 'file', 'list', '-r', '@').split('\n').filter((f) => f.startsWith(`lanes/${lane}/`)); } catch {}
    for (const f of tracked) rmSync(join(dir(root), f), { force: true });
    const dest = join(dir(root), 'lanes', lane);
    mkdirSync(dest, { recursive: true });
    if (existsSync(lanePath)) cpSync(lanePath, dest, { recursive: true });
    run(root, 'describe', '-m', `mesh snap ${lane}/${snapId} ${message}`.slice(0, 300));
    const changeId = run(root, 'log', '-r', '@', '--no-graph', '-T', 'change_id');
    const commitId = run(root, 'log', '-r', '@', '--no-graph', '-T', 'commit_id');
    run(root, 'new');
    return { ok: true, backend: 'jj', changeId, commit: commitId, ref: `${lane}/${snapId}` };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 300) }; }
}
// read-only restore: materialize files of a change into the lane without touching the wc
export function jjRestore(root, lane, changeId) {
  if (!jjAvailable()) return SKIP;
  try {
    const list = run(root, 'file', 'list', '-r', changeId).split('\n').filter((f) => f.startsWith(`lanes/${lane}/`));
    if (!list.length) return { ok: false, error: `no files for ${changeId} in lane ${lane}` };
    const lanePath = join(root, 'lanes', lane);
    rmSync(lanePath, { recursive: true, force: true });
    mkdirSync(lanePath, { recursive: true });
    for (const f of list) {
      const content = execFileSync('jj', ['file', 'show', '-r', changeId, f], { cwd: dir(root), stdio: 'pipe', timeout: 30000, encoding: 'buffer' });
      const dest = join(lanePath, f.slice(`lanes/${lane}/`.length));
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, content);
    }
    return { ok: true, backend: 'jj', change: changeId, files: list.length };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 300) }; }
}
export function jjLog(root, lane, n = 20) {
  if (!jjAvailable()) return SKIP;
  try {
    return { ok: true, backend: 'jj', log: run(root, 'log', '--no-graph', '-T', 'change_id ++ " " ++ description.first_line() ++ "\\n"', '-l', String(n)) };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 300) }; }
}
// jj's own operation log backs MeshVCS ops: who attempted what, undoable via `jj undo`
export function jjOpLog(root, n = 20) {
  if (!jjAvailable()) return SKIP;
  try {
    return { ok: true, backend: 'jj', ops: execFileSync('jj', ['op', 'log', '--no-graph', '-l', String(n)], { cwd: dir(root), stdio: 'pipe', timeout: 30000 }).toString() };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 300) }; }
}
export function jjUndo(root) {
  if (!jjAvailable()) return SKIP;
  try {
    execFileSync('jj', ['undo'], { cwd: dir(root), stdio: 'pipe', timeout: 30000 });
    return { ok: true, backend: 'jj' };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 300) }; }
}
