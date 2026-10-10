# Changelog

## 1.1.0 — production hardening
- SQLite (WAL) is the hub event source of truth; JSONL retained as export; legacy dirs migrate on boot
- Capability auth (ed25519): auto-enforced once `mesh up` creates keys; actor-bound, scoped, expiring tokens
- Hub guards: 1 MB bodies (413), 100 writes/min/actor (429), security headers, access log + rotation, `/metrics`, `/ready`, graceful shutdown, epoch persisted
- Real `mesh run` L4 wrap: generated PATH shims enforce deny (126) / approval (125) with the real binary never running on deny
- `mesh up|keygen|token`, `templates/policy.yaml`, `mesh overview`, `mesh board|voice`
- `mesh bundle` now includes the vcs bundle; standby profile in compose
- Packaging: `bin/mesh`, Dockerfile (+healthcheck), compose, install.sh, CI (tests + demos + load + docker build)
- Docs: RUNBOOK, SECURITY, CONFIG
- Tests: `test/prod.test.mjs` (SIGKILL restart, auth, shims, merge, 429, 413/400), `scripts/load.mjs` concurrency proof

## 1.0.0 — complete plan as a working MVP
- Hub, bridge, lanes/MeshVCS, harness T0–T2, queue, contracts/ghost, drivers, canvas, extension, bus, collab, pluggable vcs (git/jj/sqlite), board + voice
