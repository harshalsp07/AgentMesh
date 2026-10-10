// test/collab.test.mjs — collaboration layer: requests, pins, digest, wip, toasts, health.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join, setAvailability, createRequest, respondRequest, completeRequest, inboxFor, addPin, routePin, recordDecision, digest, exportCapsule, importCapsule, negotiate, checkWip, shouldToast, health, deliveryFor } from '../src/collab.mjs';

const ROOT = '.mesh-test-collab';
before(() => rmSync(ROOT, { recursive: true, force: true }));
after(() => rmSync(ROOT, { recursive: true, force: true }));

describe('collab', () => {
  it('owner approval gates strangers; accept mints child intent; chips track', () => {
    join(ROOT, { actor: 'o', role: 'human' });
    join(ROOT, { actor: 'a', role: 'agent', owner: 'o' });
    const r = createRequest(ROOT, { from: 'stranger', to: 'a', text: 'do X' });
    assert.equal(r.status, 'queued');
    assert.equal(inboxFor(ROOT, 'a').length, 1);
    const acc = respondRequest(ROOT, { id: r.id, by: 'o', accept: true });
    assert.equal(acc.status, 'working');
    assert.ok(acc.childIntent);
    assert.equal(completeRequest(ROOT, r.id).statusChip, 'done');
    assert.equal(respondRequest(ROOT, { id: r.id, by: 'intruder', accept: false }).ok, false);
  });
  it('pins route by scope; digest caps at 5; capsules round-trip read-only', () => {
    const pin = addPin(ROOT, { actor: 'o', node: 'src/api/x.ts', text: 'note' });
    const got = routePin(pin, [{ actor: 'a', paths: ['src/api/**'] }, { actor: 'z', paths: ['src/ui/**'] }]);
    assert.deepEqual(got, ['a']);
    recordDecision(ROOT, { actor: 'ref', topic: 't', decision: 'd' });
    assert.ok(digest(ROOT, { landed: ['1'], proposed: ['2'], blocked: ['3'], collisions: ['4'] }).length <= 5);
    const cap = exportCapsule(ROOT, { actor: 'o', intent: 'i', files: ['f'] });
    assert.match(importCapsule(ROOT, cap.id).brief, /read-only/);
  });
  it('wip, availability, toast caps, negotiation, health', () => {
    assert.equal(checkWip(ROOT, 'a', 2).ok, false);
    setAvailability(ROOT, 'o', 'dnd');
    assert.equal(deliveryFor('dnd'), 'digest');
    setAvailability(ROOT, 'o', 'available');
    join(ROOT, { actor: 'q', role: 'human' });
    shouldToast(ROOT, 'q'); shouldToast(ROOT, 'q'); shouldToast(ROOT, 'q');
    assert.equal(shouldToast(ROOT, 'q').toast, false);
    negotiate(ROOT, { a: 'x', b: 'y', topic: 't' });
    negotiate(ROOT, { a: 'x', b: 'y', topic: 't' });
    assert.equal(negotiate(ROOT, { a: 'x', b: 'y', topic: 't' }).escalate, true);
    assert.equal(health({ tp: 9, fp: 1 }).trusted, true);
    assert.equal(health({ tp: 1, fp: 1 }).trusted, false);
  });
});
