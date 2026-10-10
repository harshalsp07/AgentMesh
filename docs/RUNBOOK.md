# Runbook — operating AgentMesh in production

## Deploy (pick one)
- **Bare metal / VM:** `bash install.sh` (needs node ≥ 22, git recommended), then run the hub under systemd/supervisor: `MESH_DIR=/var/lib/mesh MESH_HOST=127.0.0.1 node src/hub.mjs`. Put Caddy/nginx in front for TLS; never expose an unauthenticated hub.
- **Docker:** `docker compose up -d hub` (data in `mesh-data`). Standby: `docker compose --profile standby up -d standby`.

## First boot
1. `node src/mesh.mjs up --root $MESH_DIR` — writes policy, inits vcs repo, generates ed25519 keys (auth auto-enforces from here on).
2. `node src/mesh.mjs token <owner> --root $MESH_DIR` — mint per-actor tokens (8 h default, `--ttl`).
3. Open `/canvas`, set the token box once (stored in browser localStorage only).
4. `node src/mesh.mjs doctor`, `node src/mesh.mjs overview`.

## Daily
- Watch `/metrics` (event rate, quarantine count) and the canvas Queue tab.
- Quarantined changesets: `mesh trunk` shows reasons; fix in-lane, re-propose.
- Digests every 10 min; toast cap means silence is normal — check Inbox, not pings.

## Backup (3 copies, per design)
1. Hub volume (`mesh.db` + `events.jsonl` + snapshots).
2. Standby replica (streaming; promote with `MESH_EPOCH=<n+1>` and point traffic over).
3. `mesh bundle` → host disk every 5 min via cron (includes the vcs bundle). Verify with `mesh fsck` + `mesh vcs fsck`.

## Restore
- Hub lost: `mesh recover --from-standby` or `--from-bundle`, then `mesh fsck`.
- Lane trashed: `mesh undo <lane>` / `mesh rewind <lane> --minutes 10` / `mesh revert-intent <me> <intent>`.
- Everything frozen: `mesh freeze`, `mesh restore --checkpoint <name>`.

## Chaos (run in CI + before every demo)
`mesh drill` kills daemon/VM/standby in turn; recovery target < 30 s. Load: `node scripts/load.mjs 8 5` (40 concurrent intents, 0 lost writes expected).

## Upgrade
Pull, `npm test`, restart hub (SQLite WAL replays; JSONL-only dirs migrate automatically). Roll back by checking out the previous tag — on-disk formats are append-only and backward readable.
