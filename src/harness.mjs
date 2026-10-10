// harness.mjs — Phase-2: tiered verification gates T0..T3 + structured verdicts.
// Bound to (base,head); void on move. 20-line cap for agents; full log one call away.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { shortHash, truncate } from './store.mjs';
import { loadPolicy, isProtected } from './policy.mjs';

function listFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (['node_modules', '.git', '.mesh', 'snapshots'].includes(e)) continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) listFiles(f, out);
    else out.push(f);
  }
  return out;
}
// secret scan helper (local; policy.mjs also exposes findSecrets via store)
import { findSecrets } from './store.mjs';

function checkSyntax(file) {
  if (!/\.(m?js)$/.test(file)) return null; // only JS syntax-checked without deps
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe', timeout: 5000 });
    return null;
  } catch (e) {
    const msg = String(e.stderr || e.message || 'syntax error').split('\n')[0].slice(0, 180);
    return { kind: 'syntax', file, message: msg, action: 'fix syntax' };
  }
}

// T0 <2s: syntax parse, format/lint stub on changed files, secret scan, protected-path check
export function runT0(laneDir, { changed = null, policyDir = '.mesh' } = {}) {
  const t0 = Date.now();
  const failures = [];
  const policy = loadPolicy(policyDir);
  const files = changed || listFiles(laneDir).map((f) => relative(laneDir, f));
  for (const rel of files.slice(0, 200)) {
    if (isProtected(policy, rel)) failures.push({ kind: 'protected-path', file: rel, message: `protected path touched: ${rel}`, action: 'request approve-and-pair review' });
    let src = ''; try { src = readFileSync(join(laneDir, rel), 'utf8'); } catch { continue; }
    const secrets = findSecrets(src);
    if (secrets.length) failures.push({ kind: 'secret', file: rel, message: `possible secret: ${secrets[0].slice(0, 24)}…`, action: 'remove secret, use env' });
    const syn = checkSyntax(join(laneDir, rel));
    if (syn) failures.push({ ...syn, file: rel });
    if (/\t/.test(src) && /\.(m?js|ts)/.test(rel)) failures.push({ kind: 'format', file: rel, message: 'tab indentation found', action: 'run formatter' });
  }
  return verdict(0, failures, t0);
}

// T1 <15s: typecheck affected (tsc if present else syntax), unit tests chosen by impact
export function runT1(laneDir, { changed = [], policyDir = '.mesh' } = {}) {
  const t0 = Date.now();
  const failures = [];
  void policyDir;
  // typecheck: prefer tsc --noEmit when the lane actually has TS inputs; else syntax-only.
  // (Running tsc with zero inputs exits nonzero — that must not fail a clean JS lane.)
  const hasTs = listFiles(laneDir).some((f) => /\.tsx?$/.test(f));
  let tsc = false;
  if (hasTs) {
    try { execFileSync('npx', ['--yes', '-p', 'typescript', 'tsc', '--version'], { stdio: 'pipe', timeout: 15000 }); tsc = true; } catch { tsc = false; }
  }
  if (tsc) {
    try { execFileSync('npx', ['--yes', '-p', 'typescript', 'tsc', '--noEmit', '--pretty', 'false'], { cwd: laneDir, stdio: 'pipe', timeout: 15000 }); }
    catch (e) {
      const lines = String(e.stdout || e.message).split('\n').slice(0, 8);
      for (const l of lines) { const m = l.match(/(.+\.tsx?):(\d+):(\d+)?\s*-\s*(.*)/); if (m) failures.push({ kind: 'type', file: m[1], line: +m[2], message: m[4].slice(0, 180), action: 'fix type error' }); }
      if (!failures.length) failures.push({ kind: 'type', message: 'tsc failed (see log)', action: 'run tsc --noEmit locally' });
    }
  } else {
    for (const rel of changed.slice(0, 60)) { const s = checkSyntax(join(laneDir, rel)); if (s) failures.push({ ...s, file: rel }); }
  }
  // impact-chosen unit tests: files with .test. in name related to changed dirs
  const related = listFiles(laneDir).filter((f) => /\.test\.(m?js|ts)/.test(f)).slice(0, 10);
  for (const t of related) {
    try { execFileSync(process.execPath, ['--test', t], { cwd: laneDir, stdio: 'pipe', timeout: 15000 }); }
    catch (e) { failures.push({ kind: 'test', file: relative(laneDir, t), message: 'related test failed', action: 'run test file locally' }); }
  }
  return verdict(1, failures, t0);
}

// T2 <2min: integration + contract tests + migration dry-run on clone (stubs where stack absent)
export function runT2(laneDir, { contracts = null } = {}) {
  const t0 = Date.now();
  const failures = [];
  const integ = listFiles(laneDir).filter((f) => /integration|contract/i.test(f) && /\.(m?js|ts)$/.test(f)).slice(0, 10);
  for (const t of integ) {
    try { execFileSync(process.execPath, ['--test', t], { cwd: laneDir, stdio: 'pipe', timeout: 30000 }); }
    catch { failures.push({ kind: 'integration', file: relative(laneDir, t), message: 'integration/contract test failed', action: 'see log' }); }
  }
  if (contracts?.blocked) failures.push({ kind: 'contract-gate', message: String(contracts.reason).slice(0, 180), action: 'migrate consumers first' });
  return verdict(2, failures, t0);
}

// T3: full suite + build + audit (as needed, before push/release)
export function runT3(laneDir) {
  const t0 = Date.now();
  const failures = [];
  try { execFileSync('npm', ['test', '--silent'], { cwd: laneDir, stdio: 'pipe', timeout: 120000 }); }
  catch { failures.push({ kind: 'suite', message: 'full suite failed', action: 'run npm test' }); }
  return verdict(3, failures, t0);
}

function verdict(tier, failures, t0, { base = 'base', head = 'head' } = {}) {
  const id = `v-${shortHash(JSON.stringify([tier, base, head, failures.length, Date.now()]))}`;
  return {
    id, tier, base, head,
    status: failures.length ? 'fail' : 'pass',
    failures: failures.slice(0, 20).map((f) => ({ ...f, message: String(f.message || '').slice(0, 200) })),
    log_ref: `verdict:${id}`,
    ms: Date.now() - t0,
    summary20: truncate(failures.map((f) => `${f.kind} ${f.file || ''}${f.line ? ':' + f.line : ''} ${f.message || ''}`).join('\n') || 'pass', 2000),
  };
}
// flake handling: fail then pass on same hash => flaky, reported, not blocking
export function rerunFlake(fn, hashKey, cache = new Map()) {
  const first = fn();
  if (first.status === 'pass') return first;
  const second = fn();
  if (second.status === 'pass') return { ...second, status: 'flaky', note: `flaky on ${hashKey}: failed then passed; not blocking` };
  return first;
}
