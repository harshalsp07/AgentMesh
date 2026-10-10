// test/crdt.test.mjs — Comprehensive tests for Delta-State Semantic CRDT Engine
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VectorClock, SemanticRegister, SemanticDocument } from '../src/crdt.mjs';

describe('VectorClock & Causal Ordering', () => {
  it('increments monotonically and compares causal relations', () => {
    const vc1 = new VectorClock();
    assert.equal(vc1.get('agent-a'), 0);
    assert.equal(vc1.tick('agent-a'), 1);
    assert.equal(vc1.tick('agent-a'), 2);

    const vc2 = new VectorClock({ 'agent-a': 1, 'agent-b': 1 });
    assert.equal(vc1.compare(vc2), 'concurrent'); // vc1 has agent-a=2, vc2 has agent-b=1

    vc1.update(vc2);
    assert.equal(vc1.get('agent-a'), 2);
    assert.equal(vc1.get('agent-b'), 1);
    assert.equal(vc1.compare(vc2), 'after');
  });
});

describe('SemanticRegister & Deterministic LWW', () => {
  it('resolves deterministic overrules with Lamport timestamp and actor tie-breaking', () => {
    const r1 = new SemanticRegister('sym:auth', 'val1', 'agent-a', 5);
    const r2 = new SemanticRegister('sym:auth', 'val2', 'agent-b', 6);
    assert.ok(r1.shouldOverrule(r2)); // higher lamport wins
    assert.ok(!r2.shouldOverrule(r1));

    // Same lamport: tie-break by actor string comparison
    const r3 = new SemanticRegister('sym:auth', 'val3', 'agent-a', 6);
    assert.ok(r3.shouldOverrule(r2)); // 'agent-b' > 'agent-a' -> r2 wins over r3
  });
});

describe('SemanticDocument Strong Eventual Consistency (SEC)', () => {
  it('mathematically converges across concurrent multi-agent delta exchanges', () => {
    const docA = new SemanticDocument('repo-ast');
    const docB = new SemanticDocument('repo-ast');

    // Agent A modifies 'auth.ts'
    docA.setSymbol('src/auth.ts:login', 'function login(u, p) { return true; }', 'agent-a');
    docA.setSymbol('src/auth.ts:version', '1.0.0', 'agent-a');

    // Agent B concurrently modifies 'auth.ts:version' and adds 'api.ts'
    docB.setSymbol('src/auth.ts:version', '1.1.0-beta', 'agent-b');
    docB.setSymbol('src/api.ts:router', 'const r = new Router();', 'agent-b');

    // Exchange deltas in different orders
    const deltaA = docA.getDelta();
    const deltaB = docB.getDelta();

    const resA = docA.applyDelta(deltaB);
    const resB = docB.applyDelta(deltaA);

    assert.ok(resA.applied > 0);
    assert.ok(resB.applied > 0);

    // Both replicas must converge to 100% identical state
    const symbolsA = docA.getAllSymbols();
    const symbolsB = docB.getAllSymbols();

    assert.deepEqual(symbolsA, symbolsB);
    assert.equal(symbolsA['src/auth.ts:login'], 'function login(u, p) { return true; }');
    assert.equal(symbolsA['src/api.ts:router'], 'const r = new Router();');
  });

  it('handles tombstones on symbol deletion', () => {
    const doc = new SemanticDocument('test');
    doc.setSymbol('temp_func', 'console.log(1)', 'agent-x');
    assert.equal(doc.getSymbol('temp_func'), 'console.log(1)');

    doc.deleteSymbol('temp_func', 'agent-x');
    assert.equal(doc.getSymbol('temp_func'), null);
  });
});
