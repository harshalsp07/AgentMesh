// drivers.mjs — Phase-4: runtime drivers + dependency steward + services.
// Lite (worktrees, no VM) / Container (docker|podman) / Lima-WSL2 / Firecracker.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const has = (cmd) => { try { execFileSync('which', [cmd], { stdio: 'pipe' }); return true; } catch { return false; } };
export function detectDriver() {
  if (has('docker') || has('podman')) return { driver: 'container', boot: '~10s warm', isolation: 'namespaces+cgroups', use: 'default' };
  if (process.platform === 'darwin') return { driver: 'lima', boot: '~15-25s', isolation: 'real Linux kernel', use: 'macOS without containers' };
  if (process.platform === 'win32') return { driver: 'wsl2', boot: '~15-25s', isolation: 'real Linux kernel', use: 'windows' };
  try { execFileSync('ls', ['/dev/kvm'], { stdio: 'pipe' }); return { driver: 'firecracker', boot: '<1s from snapshot', isolation: 'hardware virt', use: 'hardened/untrusted' }; } catch {}
  return { driver: 'lite', boot: '~2s', isolation: 'git worktrees + daemon', use: 'demos, trusted team, small repos' };
}
export function bootHub({ driver = null } = {}) {
  const d = driver || detectDriver().driver;
  return { ok: true, driver: d, note: d === 'lite' ? 'no VM: worktrees + daemon' : `${d}: namespaces/cgroups, trunk preview on stable port, lane previews on hub-allocated ports` };
}
// dependency steward: agents never mutate L1; shimmed managers -> mesh dep add (hard lease + atomic swap)
export function depAdd({ manifest = 'package.json', dep }) {
  return { ok: true, cmd: `mesh dep add ${dep}`, lease: `hard lease on ${manifest}+lockfile`, steps: ['resolve in scratch dir', 'new L1 layer keyed by lockfile hash', 'fast checks', 'broadcast dep.added', 'swap at next safe point'] };
}
export function allocPort(used = []) {
  let p = 4100;
  while (used.includes(p)) p++;
  return p;
}
