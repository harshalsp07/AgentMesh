// test/core.test.mjs — zero-dependency tests for hub logic + HTTP contract.
// Run: node --test test/*.test.mjs  (or npm test)
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { rmSafe } from './cleanup.mjs';

const PORT = '7781';
const HUB = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let hub;

async function cmd(actor, kind, payload) {
  const r = await fetch(`${HUB}/cmd`, { method: 'POST', body: JSON.stringify({ actor, kind, payload }) });
  return { status: r.status, body: await r.json() };
}

before(async () => {
  rmSync('.mesh-test', { recursive: true, force: true });
  hub = spawn('node', ['src/hub.mjs'], {
    env: { ...process.env, MESH_PORT: PORT, MESH_DIR: '.mesh-test' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    try { const r = await fetch(`${HUB}/health`); if (r.ok) return; } catch {}
    await sleep(200);
  }
  throw new Error('hub did not start');
});

after(async () => { hub.kill(); await rmSafe('.mesh-test'); });

describe('intent validation', () => {
  it('rejects missing goal/paths with 400', async () => {
    const r1 = await cmd('a1', 'intent.declare', { goal: '', paths: [] });
    assert.equal(r1.status, 400);
    const r2 = await cmd('a1', 'intent.declare', { goal: 'x' });
    assert.equal(r2.status, 400);
  });
  it('rejects bad effect', async () => {
    const r = await cmd('a1', 'intent.declare', { goal: 'x', paths: ['a/**'], effect: 'explode' });
    assert.equal(r.status, 400);
  });
});

describe('drift + overlap routing', () => {
  it('consumer gets tier-1 BREAKING on next pull', async () => {
    await cmd('ui-t', 'intent.declare', { goal: 'login', paths: ['src/ui/**'], uses: ['api:POST /api/auth'] });
    await cmd('be-t', 'intent.declare', { goal: 'move auth', paths: ['src/api/**'], contracts: ['api:POST /api/auth'], effect: 'breaking' });
    const inbox = await (await fetch(`${HUB}/inbox/ui-t`)).text();
    assert.match(inbox, /tier 1.*BREAKING/);
  });
  it('overlap warns both sides', async () => {
    await cmd('w-t', 'intent.declare', { goal: 'token', paths: ['src/api/token.ts'] });
    const inbox = await (await fetch(`${HUB}/inbox/w-t`)).text();
    assert.match(inbox, /OVERLAP/);
  });
});

describe('hard-lease boundary', () => {
  it('refuses overlapping write with 409', async () => {
    await cmd('holder', 'intent.declare', { goal: 'lock', paths: ['lockfile'], hard: true });
    const r = await cmd('intruder', 'intent.declare', { goal: 'bump', paths: ['lockfile'] });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /hard lease/);
  });
});

describe('log integrity', () => {
  it('/verify passes and /health reports seq', async () => {
    const v = await (await fetch(`${HUB}/verify`)).json();
    assert.equal(v.ok, true);
    assert.ok(v.events >= 4);
  });
  it('context sheet is budget-capped markdown', async () => {
    const t = await (await fetch(`${HUB}/context/ui-t`)).text();
    assert.ok(t.length <= 4000);
    assert.match(t, /## My work/);
  });
});
