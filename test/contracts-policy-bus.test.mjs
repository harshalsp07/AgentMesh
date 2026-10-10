// test/contracts-policy-bus.test.mjs — contracts, policy, bus, graph, drivers, failover.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { extractContracts, proposeContract, ghostContract, deletionGate, landContract, classifyDiff } from '../src/contracts.mjs';
import { loadPolicy, checkCommand, checkEgress, landingMode, isProtected } from '../src/policy.mjs';
import { makeMessage, routeMessage, checkRate, resetRates, compileSheet } from '../src/bus.mjs';
import { forecast, buildGraph } from '../src/graph.mjs';
import { detectDriver } from '../src/drivers.mjs';
import { fsck, epochFence } from '../src/failover.mjs';
import { globMatch } from '../src/store.mjs';

const ROOT = '.mesh-test-cpb';
before(() => { rmSync(ROOT, { recursive: true, force: true }); mkdirSync(join(ROOT, 'lane'), { recursive: true }); });
after(() => rmSync(ROOT, { recursive: true, force: true }));

describe('contracts', () => {
  it('extracts routes, ghosts breaking change, gates deletion', () => {
    writeFileSync(join(ROOT, 'lane/s.js'), `app.post('/api/auth',()=>{});\n`);
    const found = extractContracts(join(ROOT, 'lane'));
    assert.ok(found['api:POST /api/auth']);
    proposeContract(ROOT, { id: 'api:POST /api/auth', owner: 'be', lane: 'be', intent: 'in-1', diff: 'breaking', shape: {} });
    const g = ghostContract(ROOT, 'api:POST /api/auth');
    assert.equal(g.ok, true);
    assert.ok(existsSync(g.file));
    assert.equal(deletionGate(ROOT, 'api:POST /api/auth', ['ui']).blocked, true);
    landContract(ROOT, 'api:POST /api/auth');
    assert.equal(classifyDiff({ a: 1 }, { a: 1, b: 2 }), 'additive');
  });
});
describe('policy', () => {
  it('deny/approval/egress/landing/protected', () => {
    const p = loadPolicy('.mesh');
    assert.equal(checkCommand(p, 'rm -rf /*').verdict, 'deny');
    assert.equal(checkCommand(p, 'npm publish foo').verdict, 'approval');
    assert.ok(checkEgress(p, 'evil.com'));
    assert.equal(checkEgress(p, 'registry.npmjs.org'), null);
    assert.equal(landingMode(p, 'docs/x.md'), 'auto-land');
    assert.equal(landingMode(p, 'infra/x.yml'), 'approve-and-pair');
    assert.equal(isProtected(p, 'infra/deploy.yml'), true);
    assert.equal(globMatch('src/**', 'src/a/b.ts'), true);
  });
});
describe('bus+graph', () => {
  it('breaking contract change interrupts consumer; hop limit stops loops', () => {
    resetRates();
    const m = makeMessage({ say: 'User now has a required tenantId.', facts: { kind: 'contract.change', effect: 'breaking' }, refs: ['schema:User'], from: 'be' });
    assert.equal(routeMessage(m, 'ui', { myScope: { paths: ['src/ui'], contracts: ['schema:User'] } }), 1);
    const looped = { ...m, hops: 3 };
    assert.equal(routeMessage(looped, 'ui', { myScope: { paths: [], contracts: ['schema:User'] } }), 3);
    for (let i = 0; i < 21; i++) checkRate('spam');
    assert.equal(checkRate('spam').muted, true);
    const sheet = compileSheet({ actor: 'ui', intents: [], contracts: [], requests: [], rules: ['r1'], version: 1 });
    assert.match(sheet, /## Rules/);
    assert.equal(forecast({ paths: ['src/api/auth/**'] }, { paths: ['src/api/auth/token.ts'] }), 'overlapping');
    const g = buildGraph('src');
    assert.ok(g.nodes.length > 0);
  });
  it('drivers detect + failover utils', () => {
    assert.ok(detectDriver().driver);
    assert.ok(epochFence(1, 2));
    assert.equal(epochFence(2, 2), null);
    assert.ok(typeof fsck('.mesh').ok === 'boolean');
  });
});
