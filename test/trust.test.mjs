// test/trust.test.mjs — P6: capability tokens carry jti; revocation is instant;
// the hub key rotates with an archived copy; audit export self-verifies.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { keygen, mintToken, verifyToken, revokeToken, readPub, fingerprint } from '../src/auth.mjs';
import { exportAudit, verifyAudit } from '../src/audit.mjs';

const DIR = '.mesh-test-trust';
const chainHash = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);
before(() => rmSync(DIR, { recursive: true, force: true }));
after(() => rmSync(DIR, { recursive: true, force: true }));

// simulate hub events: prev-hash chain over 6 events (same contract hub.mjs emits)
const mkEvents = () => {
  const rows = [];
  let prev = '0';
  for (let i = 1; i <= 6; i++) {
    const t = Date.now() - 6000 + i * 1000;
    const body = { seq: i, t, hlc: i, epoch: 1, actor: i % 2 ? 'antigravity-ui' : 'codex-backend', kind: i === 4 ? 'task.created' : 'intent.declared', payload: { id: i } };
    const hash = chainHash({ ...body, prev });
    rows.push({ ...body, prev, hash });
    prev = hash;
  }
  return rows;
};

describe('trust layer', () => {
  it('tokens verify by default and fail after revocation (operator kill switch)', () => {
    keygen(DIR);
    const tok = mintToken(DIR, { actor: 'op', ttlH: 2 });
    const pub = readPub(DIR);
    const v = verifyToken(pub, tok, Date.now(), { dir: DIR });
    assert.equal(v.ok, true);
    assert.ok(v.jti, 'token carries jti');
    assert.equal(revokeToken(DIR, { jti: v.jti, by: 'human', reason: 'laptop stolen' }).ok, true);
    const v2 = verifyToken(pub, tok, Date.now(), { dir: DIR });
    assert.equal(v2.ok, false);
    assert.match(v2.error, /revoked/);
    // legacy signature-only call path still verifies (revocation is opt-in per store dir)
    assert.equal(verifyToken(pub, tok).ok, true);
  });

  it('expired tokens say expired; malformed say malformed; signature is enforced', () => {
    const pub = readPub(DIR);
    assert.match(verifyToken(pub, mintToken(DIR, { actor: 'op', ttlH: -1 })).error, /expired/);
    assert.match(verifyToken(pub, 'garbage').error, /malformed/);
    // a token minted by a DIFFERENT hub key cannot pass our signature check
    keygen('.mesh-test-trust-forgery');
    const forgery = mintToken('.mesh-test-trust-forgery', { actor: 'op' });
    assert.match(verifyToken(pub, forgery).error, /signature/);
    try { rmSync('.mesh-test-trust-forgery', { recursive: true, force: true }); } catch {}
  });

  it('key rotation archives the old key and produces a new fingerprint', () => {
    const fp1 = fingerprint(DIR);
    const g = keygen(DIR, { rotate: true });
    assert.equal(g.ok, true);
    assert.equal(g.rotated, true);
    assert.notEqual(fingerprint(DIR), fp1);
    const archived = readdirSync(`${DIR}/keys`).filter((f) => f.startsWith('hub-rotated-'));
    assert.ok(archived.length >= 2, `archived pair present (${archived.join(', ')})`);
    // fresh tokens verify against the rotated key
    assert.equal(verifyToken(readPub(DIR), mintToken(DIR, { actor: 'op2' })).ok, true);
  });

  it('audit export: hash chain + linked + merkle root; tamper is detected', () => {
    const rows = mkEvents();
    const bundle = exportAudit(rows, {});
    assert.equal(bundle.ok, true);
    assert.ok(bundle.merkleRoot);
    assert.ok(Object.keys(bundle.summary).includes('intent.declared'));
    assert.equal(verifyAudit(bundle).ok, true);
    // tamper with one payload -> chain verification fails
    const evil = structuredClone(bundle);
    evil.events[2].payload = { id: 999 };
    const verdict = verifyAudit(evil);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.broken.length >= 1);
  });

  it('audit range filter: from/to boundaries honored', () => {
    const rows = mkEvents();
    const b = exportAudit(rows, { from: rows[2].t, to: rows[4].t });
    assert.equal(b.events.length, 3);
    assert.equal(b.range.from, rows[2].t);
  });
});
