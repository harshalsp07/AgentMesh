// sqlitevcs.mjs — self-contained content-addressed snapshot store (node:sqlite, no binaries).
// Same duties as the git backend: blobs deduped by hash, trees, per-lane commit chains,
// refs, fsck (rehash everything), bundle (VACUUM INTO a single file to replicate).
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readdirSync, statSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const MAX_BLOB = 100 * 1024 * 1024;

export function openVcsDb(root) {
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(join(root, 'vcs-store.db'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;`);
  db.exec(`CREATE TABLE IF NOT EXISTS blobs(h TEXT PRIMARY KEY, size INTEGER NOT NULL, data BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS trees(h TEXT PRIMARY KEY, entries TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS commits(id TEXT PRIMARY KEY, lane TEXT NOT NULL, parent TEXT, tree TEXT NOT NULL, msg TEXT NOT NULL, t INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_commits_lane ON commits(lane);
    CREATE TABLE IF NOT EXISTS refs(lane TEXT PRIMARY KEY, head TEXT NOT NULL);`);
  return db;
}
function walkFiles(lanePath, out = []) {
  if (!existsSync(lanePath)) return out;
  for (const e of readdirSync(lanePath)) {
    if (e === '.snap.json') continue;
    const f = join(lanePath, e);
    if (statSync(f).isDirectory()) walkFiles(f, out);
    else out.push(f);
  }
  return out;
}

export function sqliteSnapshot(root, lane, snapId, { message = '' } = {}) {
  const db = openVcsDb(root);
  try {
    const lanePath = join(root, 'lanes', lane);
    const entries = [];
    for (const f of walkFiles(lanePath)) {
      const data = readFileSync(f);
      if (data.length > MAX_BLOB) return { ok: false, error: `file too large: ${relative(lanePath, f)}` };
      const h = sha(data);
      db.prepare(`INSERT OR IGNORE INTO blobs(h,size,data) VALUES(?,?,?)`).run(h, data.length, data);
      entries.push({ path: relative(lanePath, f), hash: h, size: data.length });
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : 1));
    const treeJson = JSON.stringify(entries);
    const treeH = sha(treeJson);
    db.prepare(`INSERT OR IGNORE INTO trees(h,entries) VALUES(?,?)`).run(treeH, treeJson);
    const id = `${lane}/${snapId}`;
    const parent = db.prepare(`SELECT head FROM refs WHERE lane=?`).get(lane)?.head || null;
    db.prepare(`INSERT OR IGNORE INTO commits(id,lane,parent,tree,msg,t) VALUES(?,?,?,?,?,?)`)
      .run(id, lane, parent, treeH, message.slice(0, 300), Date.now());
    db.prepare(`INSERT INTO refs(lane,head) VALUES(?,?) ON CONFLICT(lane) DO UPDATE SET head=excluded.head`).run(lane, id);
    return { ok: true, backend: 'sqlite', commit: id, files: entries.length, deduped: true };
  } finally { db.close(); }
}
export function sqliteRestore(root, lane, snapId) {
  const db = openVcsDb(root);
  try {
    const id = snapId.includes('/') ? snapId : `${lane}/${snapId}`;
    const c = db.prepare(`SELECT * FROM commits WHERE id=?`).get(id);
    if (!c) return { ok: false, error: `unknown snapshot ${id}` };
    const entries = JSON.parse(db.prepare(`SELECT entries FROM trees WHERE h=?`).get(c.tree)?.entries || '[]');
    const lanePath = join(root, 'lanes', lane);
    rmSync(lanePath, { recursive: true, force: true });
    mkdirSync(lanePath, { recursive: true });
    for (const e of entries) {
      const blob = db.prepare(`SELECT data FROM blobs WHERE h=?`).get(e.hash)?.data;
      if (!blob) return { ok: false, error: `missing blob ${e.hash} for ${e.path}` };
      const dest = join(lanePath, e.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, blob);
    }
    db.prepare(`INSERT INTO refs(lane,head) VALUES(?,?) ON CONFLICT(lane) DO UPDATE SET head=excluded.head`).run(lane, id);
    return { ok: true, backend: 'sqlite', commit: id, files: entries.length };
  } finally { db.close(); }
}
export function sqliteLog(root, lane, n = 20) {
  const db = openVcsDb(root);
  try {
    let cur = db.prepare(`SELECT head FROM refs WHERE lane=?`).get(lane)?.head;
    const out = [];
    while (cur && out.length < n) {
      const c = db.prepare(`SELECT * FROM commits WHERE id=?`).get(cur);
      if (!c) break;
      out.push({ id: c.id, msg: c.msg, t: c.t });
      cur = c.parent;
    }
    return out;
  } finally { db.close(); }
}
export function sqliteFsck(root) {
  const db = openVcsDb(root);
  try {
    let checked = 0;
    for (const b of db.prepare(`SELECT h,size,data FROM blobs`).all()) {
      if (sha(b.data) !== b.h) return { ok: false, error: `blob hash mismatch: ${b.h}` };
      if (b.data.length !== b.size) return { ok: false, error: `blob size mismatch: ${b.h}` };
      checked++;
    }
    for (const t of db.prepare(`SELECT h,entries FROM trees`).all()) {
      if (sha(t.entries) !== t.h) return { ok: false, error: `tree hash mismatch: ${t.h}` };
      for (const e of JSON.parse(t.entries)) {
        if (!db.prepare(`SELECT 1 FROM blobs WHERE h=?`).get(e.hash)) return { ok: false, error: `dangling blob ref ${e.hash}` };
      }
    }
    return { ok: true, blobs: checked };
  } finally { db.close(); }
}
export function sqliteBundle(root, destFile) {
  const db = openVcsDb(root);
  try {
    mkdirSync(dirname(destFile), { recursive: true });
    db.exec(`VACUUM INTO '${String(destFile).replace(/'/g, "''")}'`);
    return { ok: true, backend: 'sqlite', bundle: destFile };
  } catch (e) { return { ok: false, error: String(e.message).slice(0, 300) }; }
  finally { db.close(); }
}
