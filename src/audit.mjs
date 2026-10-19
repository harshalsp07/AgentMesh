// audit.mjs — P6: verifiable export of the mesh's history. Every event chain lands in
// SQLite (source of truth) with a sha256 prev-hash chain; this module turns a time
// range into a self-verifying bundle: hash chain + Merkle root + replay summary.
// Usage: POST /api/audit {from,to} (token scope 'audit') or `mesh audit export <file>`.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const hashOf = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

export function auditChain(rows) {
  // rows: ordered [{seq, hash, prev, ...}] — recompute the link integrity
  const chain = rows.map((e) => ({ seq: e.seq, t: e.t, actor: e.actor, kind: e.kind, payload: e.payload, hash: e.hash, prev: e.prev }));
  const recomputed = rows.map((e, i) => {
    const { hash, ...rest } = e;
    return hashOf(i === 0 ? { ...rest, prev: e.prev } : { ...rest, prev: rows[i - 1].hash }) === e.hash ? null : e.seq;
  }).filter(Boolean);
  const linked = rows.every((e, i) => i === 0 ? true : e.prev === rows[i - 1].hash);
  // merkle root over event hashes (deterministic pairing)
  let level = rows.map((e) => e.hash || '0');
  while (level.length > 1) {
    if (level.length % 2) level = [...level, level[level.length - 1]];
    level = level.reduce((acc, h, i, arr) => { if (i % 2) return acc; acc.push(sha256(h + arr[i + 1]).slice(0, 16)); return acc; }, []);
  }
  return { chain, broken: recomputed, linked, merkleRoot: level[0] || null, ok: linked && recomputed.length === 0 };
}

export function exportAudit(rows, { from = 0, to = Date.now(), out = null } = {}) {
  const inRange = rows.filter((e) => e.t >= from && e.t <= to);
  const a = auditChain(inRange);
  const bundle = {
    ok: a.ok, agentmesh: 'audit-bundle', v: 6,
    range: { from, to, events: inRange.length },
    merkleRoot: a.merkleRoot,
    summary: byKind(inRange),
    events: inRange.map((e) => ({ seq: e.seq, t: e.t, hlc: e.hlc, epoch: e.epoch, actor: e.actor, kind: e.kind, payload: e.payload, hash: e.hash, prev: e.prev })),
  };
  if (out) { mkdirSync(dirname(out) || '.', { recursive: true }); writeFileSync(out, JSON.stringify(bundle, null, 2)); }
  return { ...bundle, out: out || null };
}

export function verifyAudit(bundle) {
  return typeof bundle === 'object' ? auditChain(bundle.events || []) : { ok: false, error: 'bad bundle' };
}

function byKind(rows) {
  const c = {};
  for (const e of rows) c[e.kind] = (c[e.kind] || 0) + 1;
  return c;
}
