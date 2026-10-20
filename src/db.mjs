// db.mjs — durable SQLite store (node:sqlite, WAL). Source of truth for the event log;
// JSONL export is retained for degrade-to-git / eject / external tailing.
//
// Durability notes (P0 hardening):
//   * busy_timeout so a second writer (e.g. `mesh audit export`) waits instead of
//     failing with SQLITE_BUSY.
//   * synchronous=FULL by default: the JSONL mirror is written after the DB row,
//     so a lost tail would desync the two. MESH_SYNC=NORMAL trades that for speed.
//   * user_version migrations so schema changes are explicit instead of silently
//     mismatching an existing table.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA_VERSION = 1;

export function openDb(dir) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'mesh.db'));
  const sync = (process.env.MESH_SYNC || 'FULL').toUpperCase();
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = ${sync === 'NORMAL' ? 'NORMAL' : 'FULL'}; PRAGMA foreign_keys = ON;`);
  db.exec(`PRAGMA busy_timeout = 5000;`);
  db.exec(`CREATE TABLE IF NOT EXISTS events(
    seq INTEGER PRIMARY KEY, t INTEGER NOT NULL, hlc TEXT NOT NULL, epoch INTEGER NOT NULL,
    actor TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, prev TEXT NOT NULL, hash TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
  CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor);
  CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS metrics(name TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0);`);
  migrate(db);
  return db;
}

// Forward-only migrations keyed on PRAGMA user_version.
function migrate(db) {
  const v = db.prepare(`PRAGMA user_version`).get()?.user_version ?? 0;
  if (v < SCHEMA_VERSION) {
    // v1 = initial schema (created above). Future migrations append here:
    //   if (v < 2) { db.exec(`ALTER TABLE ...`); }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}
export const dbUserVersion = (db) => db.prepare(`PRAGMA user_version`).get()?.user_version ?? 0;
export const dbAppendEvent = (db, e) =>
  db.prepare(`INSERT INTO events(seq,t,hlc,epoch,actor,kind,payload,prev,hash) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(e.seq, e.t, e.hlc, e.epoch, e.actor, e.kind, JSON.stringify(e.payload), e.prev, e.hash);
// limit = 0 means "no limit". The old default (100000) silently truncated the
// replay: past that point the hub's seq counter restarted at 100001 and every
// new event collided with an existing primary key (lost writes, no alarm).
export function dbEvents(db, limit = 0) {
  const sql = `SELECT * FROM events ORDER BY seq${limit > 0 ? ' LIMIT ?' : ''}`;
  const rows = limit > 0 ? db.prepare(sql).all(limit) : db.prepare(sql).all();
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}
// Incremental read — used for catch-up after a reconnect instead of full replay.
export function dbEventsSince(db, sinceSeq, limit = 1000) {
  return db.prepare(`SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?`).all(sinceSeq, limit)
    .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}
export const dbMaxSeq = (db) => db.prepare(`SELECT MAX(seq) AS m FROM events`).get()?.m || 0;
export function dbVerify(db, hashFn) {
  let prev = '0';
  for (const r of db.prepare(`SELECT * FROM events ORDER BY seq`).all()) {
    const { seq, t, hlc, epoch, actor, kind, payload, prev: p, hash } = r;
    if (p !== prev) return { ok: false, at: seq, reason: 'chain break' };
    const recomputed = hashFn({ seq, t, hlc, epoch, actor, kind, payload: JSON.parse(payload), prev: p });
    if (recomputed !== hash) return { ok: false, at: seq, reason: 'hash mismatch' };
    prev = hash;
  }
  return { ok: true, events: db.prepare(`SELECT COUNT(*) AS c FROM events`).get().c };
}
export const kvGet = (db, k, fb = null) => db.prepare(`SELECT v FROM kv WHERE k=?`).get(k)?.v ?? fb;
export const kvSet = (db, k, v) => db.prepare(`INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(k, String(v));
export const metricIncr = (db, name, by = 1) =>
  db.prepare(`INSERT INTO metrics(name,n) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET n=n+excluded.n`).run(name, by);
export const metricAll = (db) => Object.fromEntries(db.prepare(`SELECT name,n FROM metrics`).all().map((r) => [r.name, r.n]));
export const dbCheckpoint = (db) => { try { db.exec(`PRAGMA wal_checkpoint(TRUNCATE);`); } catch {} };
