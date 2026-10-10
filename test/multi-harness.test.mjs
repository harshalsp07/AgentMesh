import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createServer, closeHub } from '../src/hub.mjs';

const PORT = 7789;
const HOST = '127.0.0.1';
const HUB = `http://${HOST}:${PORT}`;
const DIR = '.mesh-test-multiharness';

describe('Multi-Harness Coordination: Laptop 1 (Antigravity) <-> Laptop 2 (Codex)', () => {
  let server;

  before(async () => {
    rmSync(DIR, { recursive: true, force: true });
    server = createServer().listen(PORT, HOST);
    await new Promise((r) => setTimeout(r, 150));
  });

  after(async () => {
    if (server) await closeHub(server);
    rmSync(DIR, { recursive: true, force: true });
  });

  it('connects both Antigravity (UI) and Codex (Backend) as independent actors', async () => {
    // Laptop 1: Antigravity reports presence
    const r1 = await fetch(`${HUB}/cmd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'antigravity-ui', kind: 'presence', payload: { verb: 'editing', focus: 'site/app.js' } }),
    }).then((r) => r.json());
    assert.equal(r1.ok, true);

    // Laptop 2: Codex reports presence
    const r2 = await fetch(`${HUB}/cmd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'codex-backend', kind: 'presence', payload: { verb: 'editing', focus: 'src/hub.mjs' } }),
    }).then((r) => r.json());
    assert.equal(r2.ok, true);

    // Overview reflects both actors in presence roster
    const overview = await fetch(`${HUB}/api/overview`).then((r) => r.json());
    assert.equal(overview.ok, true);
    assert.ok(overview.presence['antigravity-ui']);
    assert.ok(overview.presence['codex-backend']);
  });

  it('isolates intents on disjoint scopes and warns on scope collisions', async () => {
    // Antigravity declares intent on site UI
    const i1 = await fetch(`${HUB}/cmd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'antigravity-ui',
        kind: 'intent.declare',
        payload: { goal: 'Revamp visual observatory', paths: ['site/**'], effect: 'additive' },
      }),
    }).then((r) => r.json());
    assert.equal(i1.ok, true);

    // Codex declares intent on backend routes
    const i2 = await fetch(`${HUB}/cmd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex-backend',
        kind: 'intent.declare',
        payload: { goal: 'Optimize event bus latency', paths: ['src/bus.mjs', 'src/hub.mjs'], effect: 'additive' },
      }),
    }).then((r) => r.json());
    assert.equal(i2.ok, true);

    // Codex attempts to modify site/app.js while Antigravity holds active lease
    await fetch(`${HUB}/cmd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex-backend',
        kind: 'intent.declare',
        payload: { goal: 'Touch UI script directly', paths: ['site/app.js'], effect: 'additive' },
      }),
    });

    // Overview detects the collision
    const ov = await fetch(`${HUB}/api/overview`).then((r) => r.json());
    assert.ok(ov.collisions.length > 0);

    // Codex's inbox receives the overlap warning
    const inbox = await fetch(`${HUB}/inbox/codex-backend`).then((r) => r.text());
    assert.match(inbox, /OVERLAP/);
  });

  it('routes inter-agent tasks and approvals from Antigravity to Codex', async () => {
    // Antigravity requests backend contract work from Codex
    const req = await fetch(`${HUB}/api/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'antigravity-ui',
        to: 'codex-backend',
        text: 'Need new REST endpoint GET /api/mesh/nodes returning topology graph',
        ref: 'UI-Issue-42',
      }),
    }).then((r) => r.json());
    assert.equal(req.status, 'queued');
    assert.ok(req.id);

    // Codex checks approvals inbox
    const approvals = await fetch(`${HUB}/api/approvals?owner=codex-backend`).then((r) => r.json());
    assert.ok(approvals.inbox.some((x) => x.id === req.id));

    // Codex accepts the task, creating a tracked child intent
    const acc = await fetch(`${HUB}/api/request-respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actor: 'codex-backend',
        id: req.id,
        accept: true,
      }),
    }).then((r) => r.json());
    assert.equal(acc.status, 'working');
    assert.ok(acc.childIntent);
  });

  it('reaches 2-agent MACP quorum consensus before landing shared schema change', async () => {
    // Codex creates a decision session for upgrading the shared contract
    const sessRes = await fetch(`${HUB}/api/macp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'create',
        mode: 'decision',
        initiator: 'codex-backend',
        title: 'Adopt API Contract v3 Schema',
        participants: ['codex-backend', 'antigravity-ui'],
        data: { minQuorum: 2 },
      }),
    }).then((r) => r.json());
    assert.equal(sessRes.ok, true);
    const sessId = sessRes.session.id;

    // Codex votes yes
    const vote1 = await fetch(`${HUB}/api/macp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'vote',
        id: sessId,
        actor: 'codex-backend',
        vote: 'yes',
        weight: 1,
        rationale: 'Passed local unit tests',
      }),
    }).then((r) => r.json());
    assert.equal(vote1.ok, true);
    assert.equal(vote1.session.status, 'active'); // Quorum of 2 not yet met

    // Antigravity reviews and votes yes
    const vote2 = await fetch(`${HUB}/api/macp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'vote',
        id: sessId,
        actor: 'antigravity-ui',
        vote: 'yes',
        weight: 1,
        rationale: 'Compatible with UI bindings',
      }),
    }).then((r) => r.json());
    assert.equal(vote2.ok, true);
    // Quorum is met!
    assert.equal(vote2.session.status, 'concluded');
    assert.equal(vote2.session.outcome.result, 'approved');
  });
});
