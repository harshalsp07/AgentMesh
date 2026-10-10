// gitvcs.mjs — git-native MeshVCS object store. Snapshots become REAL git objects
// (blobs + trees + commits) in .mesh/vcs, so `git fsck`, `git bundle`, bundles and
// host-side tools all work. Working copies stay dir-copies (overlayfs/worktrees are
// the scale-out option); the snapshot history itself is content-addressed and deduped.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const git = (gitDir, ...args) => execFileSync('git', [`--git-dir=${gitDir}`, ...args], { stdio: 'pipe', timeout: 60000 }).toString().trim();
export const gitAvailable = () => { try { execFileSync('git', ['--version'], { stdio: 'pipe' }); return true; } catch { return false; } };
const vcsDir = (root) => join(root, 'vcs');

export function ensureVcsRepo(root) {
  const d = vcsDir(root);
  if (!existsSync(join(d, 'HEAD'))) {
    mkdirSync(d, { recursive: true });
    git(d, 'init', '-q');
    git(d, 'config', 'user.email', 'mesh@agentmesh');
    git(d, 'config', 'user.name', 'AgentMesh');
    git(d, 'config', 'commit.gpgsign', 'false');
  }
  return { ok: true, dir: d };
}
export const vcsPresent = (root) => existsSync(join(vcsDir(root), 'HEAD'));
const refOf = (lane, snap) => `refs/mesh/snap/${lane}/${snap}`;
const parentOf = (root, lane) => { try { return git(vcsDir(root), 'rev-parse', `refs/mesh/snap/${lane}/head`); } catch { return null; } };

// snapshot lanes/<lane> into the object store; returns the git commit + updates head ref
export function gitSnapshot(root, lane, snapId, { message = '' } = {}) {
  ensureVcsRepo(root);
  const d = vcsDir(root);
  const lanePath = join(root, 'lanes', lane);
  const tmp = mkdtempSync(join(tmpdir(), 'mesh-idx-'));
  try {
    const index = join(tmp, 'index');
    const env = { ...process.env, GIT_INDEX_FILE: index, GIT_DIR: d };
    const g = (...a) => execFileSync('git', ['--git-dir=' + d, ...a], { stdio: 'pipe', timeout: 60000, env }).toString().trim();
    const files = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir)) {
        if (e === '.snap.json') continue;
        const f = join(dir, e);
        if (statSync(f).isDirectory()) walk(f);
        else files.push(f);
      }
    };
    if (existsSync(lanePath)) walk(lanePath);
    let tree;
    if (!files.length) {
      tree = execFileSync('git', ['--git-dir=' + d, 'mktree'], { input: '', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, env }).toString().trim();
    } else {
      const lanePrefix = lanePath + '/';
      for (const f of files) {
        const blob = execFileSync('git', ['--git-dir=' + d, 'hash-object', '-w', f], { stdio: 'pipe', timeout: 60000, env }).toString().trim();
        const rel = f.startsWith(lanePrefix) ? f.slice(lanePrefix.length) : f;
        execFileSync('git', ['--git-dir=' + d, 'update-index', '--add', '--cacheinfo', `100644,${blob},${rel}`], { stdio: 'pipe', timeout: 60000, env });
      }
      tree = execFileSync('git', ['--git-dir=' + d, 'write-tree'], { stdio: 'pipe', timeout: 30000, env }).toString().trim();
    }
    void g;
    const parent = parentOf(root, lane);
    const commitArgs = ['commit-tree', tree, '-m', `mesh snap ${lane}/${snapId} ${message}`.slice(0, 300)];
    if (parent) commitArgs.splice(1, 0, '-p', parent);
    const commit = execFileSync('git', ['--git-dir=' + d, ...commitArgs], { stdio: 'pipe', timeout: 30000, env }).toString().trim();
    git(d, 'update-ref', refOf(lane, snapId), commit);
    try { git(d, 'update-ref', `refs/mesh/snap/${lane}/head`, commit); } catch {}
    return { ok: true, backend: 'git', commit, ref: refOf(lane, snapId), files: files.length };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
export function gitRestore(root, lane, snapId) {
  const d = vcsDir(root);
  const lanePath = join(root, 'lanes', lane);
  const archive = spawnSync('git', ['--git-dir=' + d, 'archive', refOf(lane, snapId)], { encoding: 'buffer', timeout: 60000, maxBuffer: 256 * 1024 * 1024 });
  if (archive.status !== 0) return { ok: false, error: `unknown snapshot ref ${lane}/${snapId}` };
  rmSync(lanePath, { recursive: true, force: true });
  mkdirSync(lanePath, { recursive: true });
  const untar = spawnSync('tar', ['-x', '-C', lanePath], { input: archive.stdout, timeout: 60000 });
  if (untar.status !== 0) return { ok: false, error: 'tar extract failed' };
  return { ok: true, backend: 'git', ref: refOf(lane, snapId) };
}
export const gitRestoreSafe = gitRestore;
export const gitLog = (root, lane, n = 20) => {
  try { return git(vcsDir(root), 'log', '--oneline', '-n', String(n), `refs/mesh/snap/${lane}/head`); }
  catch { return ''; }
};
export function gitFsck(root) {
  try {
    const out = git(vcsDir(root), 'fsck', '--no-dangling');
    return { ok: true, output: out.slice(0, 2000) };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 500) }; }
}
export function gitBundle(root, destFile) {
  ensureVcsRepo(root);
  try {
    execFileSync('git', [`--git-dir=${vcsDir(root)}`, 'bundle', 'create', destFile, '--all'], { stdio: 'pipe', timeout: 120000 });
    return { ok: true, bundle: destFile };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 300) }; }
}
