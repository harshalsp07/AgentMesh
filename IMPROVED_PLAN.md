# AgentMesh — Improved Plan (complete: all phases implemented)

Original: `AgentMesh — Complete Design Plan.md` (vision). This file is the build record:
what was wrong, what was built instead, and how each phase is verified.

## Status: ALL PHASES + PRODUCTION HARDENING DONE (43 tests + 6 demos + load proof green)

| Phase | What | Entry points | Verified by |
|---|---|---|---|
| 0 | Coordination kernel: event log, intents/leases, router, fact sheets, MCP bridge | `src/hub.mjs`, `src/bridge.mjs` | `npm run demo`, `test/core.test.mjs` |
| 1 | Lanes + MeshVCS: snapshots, views, undo/rewind/revert-intent, freeze/checkpoint, eject — plus pluggable durable backends (git objects / jj / sqlite) | `src/lanes.mjs`, `src/vcs.mjs`, `src/gitvcs.mjs`, `src/jjvcs.mjs`, `src/sqlitevcs.mjs`, `src/merge.mjs`, `mesh vcs …` | `npm run demo:1`, `test/lanes.test.mjs`, `test/vcs.test.mjs` |
| 2 | Harness T0–T2 + integration queue (CAS, speculative stack, bisect, human dial, retry×3) | `src/harness.mjs`, `src/queue.mjs`, `src/policy.mjs` | `npm run demo:2`, `test/harness-queue.test.mjs` |
| 3 | Contracts: extract, proposed-vs-stable diff, ghost clients, deletion gate, x-lane verify | `src/contracts.mjs`, `src/graph.mjs` | `npm run demo:3`, `test/contracts-policy-bus.test.mjs` |
| 4 | Drivers, dep steward, canvas, extension, bus tiers + loop defenses, failover/drill | `src/drivers.mjs`, `src/canvas.html` (`GET /canvas`), `extension/`, `src/bus.mjs`, `src/failover.mjs` | `test/contracts-policy-bus.test.mjs`, `node scripts/doctor.mjs` |
| C | **Collaboration layer**: roster + availability, requests w/ approval + trust skip, spatial pins, decision records, digests/standups, handoff capsules, pairing + negotiation ladder, WIP limits, quiet hours + toast budgets, health metrics, invites + newcomer briefs | `src/collab.mjs`, `mesh roster\|request\|pin\|decide\|digest\|standup\|capsule\|pair\|health\|brief\|quiet\|wip`, MCP `mesh_request`/`mesh_pin`, canvas Team/Approvals/Decisions panels, `/state` roster+reqs+decisions | `npm run demo:collab`, `test/collab.test.mjs` |
| U | **Every UI, one API**: `GET /api/overview` feeds canvas + TUI + extension + `mesh overview`; working time-machine (`/api/events`), typed requests/pins/decisions via API, collision ladder visualized, focus mode, keyboard shortcuts, quiet toasts | `src/canvas.html`, `src/tui.mjs` (`npm run tui`), `extension/` (trees, diagnostics, webview canvas, one-keypress setup), `src/bridge.mjs` real `mesh_request`/`mesh_pin` | `test/ui.test.mjs` |
| S | **Shared board + voice**: op-synced whiteboard (notes/shapes/pen/arrows, code refs linking board↔code, LWW convergence, tldraw-compatible export/import) + P2P WebRTC voice with hub-only signaling (SDP/ICE mailbox, 60s TTL, never logged); agents post stickies via MCP `mesh_board_post` | `src/share.mjs`, canvas Board + Voice tabs, `mesh board`, `/api/board*` + `/api/voice-*` | `npm run demo:share`, `test/share.test.mjs` |
| P | **Production hardening**: SQLite WAL event source of truth (+JSONL export, auto-migrate), ed25519 capability auth auto-enforced, 1 MB/429 guards, security headers, access log, `/metrics`+`/ready`, graceful shutdown, real `mesh run` shims (126/125), `mesh up/keygen/token`, vcs in bundles, packaging + runbooks | `src/db.mjs`, `src/auth.mjs`, `src/shims.mjs`, `bin/mesh`, Dockerfile, compose, install.sh, CI, `docs/`, `LICENSE` | `test/prod.test.mjs`, `scripts/load.mjs` (40 intents, 0 lost, 185 ms) |

## What was wrong and what changed (vs original)

1. Everything-at-once, no build order → 5 phases above, each shippable with exit criteria.
2. PoC kept state in memory only → `src/hub.mjs` reloads `events.jsonl` on boot; `src/store.mjs` atomic writes everywhere.
3. Leases never swept → 10 s sweeper + `away` flag after 15 s silence.
4. No validation; agents untrusted → `validateDeclare()` + policy checks + hard-lease 409 **before** emit.
5. Unbounded inbox, no loop defense → cap 50/actor + content-hash dedupe + hop limit 3 + 20/min circuit breaker (`src/bus.mjs`).
6. Token budgets stated, never enforced → sheet 3200 / delta 1200 char truncation, tested.
7. Intent IDs collided with event seq → `in-<seq>` + ULID-lite (`store.mjs:ulid`).
8. Bridge crashed on bad lines / answered notifications → JSON-RPC compliant, survives garbage.
9. Demo printed, asserted nothing → all 4 demos assert and exit nonzero on failure.
10. No lanes/harness/contracts/queue/canvas/extension → built as listed above (MVP fidelity: dir-copy lanes instead of overlayfs, regex adapters instead of tree-sitter/buf, vanilla-JS canvas instead of React Flow — same semantics, swappable later).

## Production deltas (honest list — semantics hold, scale differs)

- Lanes are directory copies; swap in overlayfs/fuse-overlayfs per lane for large repos.
- Contract extraction is regex adapters; swap in TS compiler API / tree-sitter / oasdiff / `buf breaking` per stack.
- Merge is file-granularity 3-way; plug `git merge-file` then Mergiraf-style AST merge at integration.
- State is JSONL + JSON files; move to SQLite WAL (single file, same schema) when log >100k events.
- Canvas is dependency-free SVG/DOM served at `GET /canvas`; the React Flow + ELK build consumes the same `/state` + `/events` SSE contract.
- Auth is actor strings; add ed25519 + mTLS/WireGuard + short-lived room tokens per the security section before untrusted networks.
- T1 typecheck runs `tsc --noEmit` only when the lane has TS inputs; add pyright/cargo-check per stack.

## Commands

```bash
npm test          # 43 tests, ~1 s (hub on :7781/:7782 for server suites)
npm run demo:all  # all 5 scenarios, every line asserted
node src/hub.mjs            # hub :7777, canvas at /canvas, SSE at /events
node src/mesh.mjs <cmd> --root .mesh   # lane snapshot undo rewind revert-intent propose approve drain verify contract policy audit forecast graph dep run hook drill bundle fsck ...
node scripts/doctor.mjs      # ports, driver, network, versions
```
