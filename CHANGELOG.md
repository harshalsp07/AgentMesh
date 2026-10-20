# Changelog

## 1.4.0 — the Strip Board, rebuilt

**The board was broken.** `site/app.js:1407` passed an undefined `saveProviderKeys`
to `addEventListener`, which threw a `ReferenceError` inside `initEvents()` — so
`initBoard()` and `connectHub()` never ran. The board never connected to the hub,
the whiteboard was dead, and the status badge sat on "Connecting…" forever. The
bug was present in `HEAD`. Three desks (CRDT, MACP, DAG) also read response
shapes the hub never sends, so they could only ever show seed data.

**Fixed**

- **The board boots.** The undefined handler is gone; the client also resolves the
  hub by probing (`location.origin` → saved URL → `:7777`), so it connects with no
  configuration on any port.
- **Data shapes match the hub.** CRDT reads `registers`, DAG reads `missingNodes`
  and node `id`, MACP reads `data.votes`.
- **Capability tokens survive a reload.** One key (`mesh_token`) is the source of
  truth; the legacy `mesh_auth_token` is mirrored. The SSE stream now carries
  `?token=` (the only way to authenticate an `EventSource`).
- **XSS closed.** Hub-supplied actor names, goals, request text, CRDT values and
  DAG payloads were interpolated raw into `innerHTML` and inline `onclick` — a peer
  agent could execute script in every operator's browser. The client now has **no
  HTML-parsing sink at all**: `el()` has no `html` option and every dynamic value
  goes through `textContent` / `setAttribute`. Verified with a hostile intent.
- **Accessible tabs, modals and drawers.** Real `tablist`/`tab`/`tabpanel` with
  roving tabindex and arrow keys; `Escape` closes modals, focus is trapped and
  restored, the background is `inert`; board shapes are focusable and deletable
  with the keyboard; `prompt()`/`alert()` are replaced with a focus-trapped dialog.
- **The service worker is registered** — it had been written since v1.2.0 and never
  activated, so the whole offline layer was dead code.

**Performance**

| | Before | After |
|---|---|---|
| HTTP requests per mesh event | 4 | **1 per burst** (0 amortised) |
| Requests for a 40-event burst | 160 | **1** |
| Render cost, 50 intents | ~40 ms | **~2 ms** |
| Long tasks during a burst | frequent | **0** |
| Topology SVG nodes at 66 conflicts | 1956 | **54** |
| Requests at rest | a 6 s poll | **0** |

One `EventSource`; one coalesced `/api/overview` per burst (120 ms trailing
debounce, 900 ms ceiling, one request in flight); desks that are not on screen
issue no requests; every list is reconciled by key instead of rebuilt; the board
patches a live `<path>` while you draw instead of rebuilding the scene; and
renders are raced against a 120 ms timer because `requestAnimationFrame` pauses
in background tabs.

**Board chrome brought in line with `src/canvas.html` (the `ui-unslop` contract)**

- **Canonical keyboard map**: `1-8` switch desk, `f` focus, `r` refresh — the
  map the canvas already used. The ad-hoc `g`-chord and `Alt+1…8` are gone; one
  way to do one thing.
- **`f` focus**: on TOPO it toggles focus mode (the graph collapses to one agent
  and its neighbours, with a `FOCUS @actor` chip in the readout); elsewhere it
  moves the caret to whatever that desk is for.
- **`#board-stage` holds a single child** — `#board-svg`, or `#tldraw-root` when
  the tldraw flag is set. The legacy canvas is *detached*, not hidden, so it can
  never be tabbed into, and it is restored verbatim if the CDN fails (the board
  must never blank-screen).
- **One toolbar**: tools, colour, **code ref**, and the status line. Export,
  import and clear moved into a **board menu** — no extra header buttons.
- **One status line**, `#bstat`: `synced · seq 12 · 3 shapes` /
  `local-only · hub unreachable`. No toast per stroke.
- **Tool buttons are real `<button>`s with `aria-pressed`** (Pen / Block / Note /
  Select / Delete). Delete is now an armed mode: click it, then click a shape.
- **Shared dark canvas `#0d1219` + `var(--line)` border** on both the board and the
  topology map, so Map and Board read as one surface. The neon board palette was
  replaced with the site's own signal-room palette; every colour clears 4.5:1 on
  that canvas, and sticky text is 13px minimum.
- **Code references**: the board toolbar takes a `src/app.js:42`-style reference
  that is stored on the shape (`codeRef`) and rendered under it, linking the board
  to the code.
- **Board ops fixed**: the shape id now travels with the op, so the hub stores
  *our* id instead of minting a ULID (the next delete targeted a shape the hub
  had never heard of — `400 unknown shape`), and `update` sends a `patch` rather
  than a whole shape.
- Board coordinates now use `getScreenCTM()`, so drawing is correct under the
  `viewBox` and the letterboxing.

**New features**

- **Command palette** (`Ctrl/Cmd+K`, `?`) — fuzzy launcher over every desk,
  action, agent, intent and task, with full combobox ARIA.
- **Time Machine** — scrub the last 500 events and watch the mesh rewind. The
  reducer is pure, so history replays through exactly the same code as the live
  stream. Seeded from `/api/events` so it works the moment the board opens.
- **Approvals drawer** — requests addressed to you with one-click accept/decline,
  plus the pins and decisions feed.
- **Task board** — blocked / pending / in-progress / done with dependency
  awareness and one-click claim.
- **Connect panel** — MCP config for Cursor / Claude Code / VS Code / Codex /
  one-command join, pre-filled with the live hub URL and capability token.
- **Collision triage** — both scopes, the overlapping paths, and one-click MACP
  or release.
- **Presence pilot lamps** and a **real HEALTH desk** (`/metrics`, `/health`,
  `/ready`, `/verify`).
- **Performance HUD** (`p`) — sync latency, req/min, render ms, longest task,
  DOM nodes, SSE reconnects.

**Docs & tests**

- `docs/SITE.md` — architecture, data flow, feature and keyboard map, extension
  points, security properties, known hub limitations.
- `docs/SITE_PLAN.md` — the audit and primary-source research behind this build.
- `docs/INTEGRATION.md` — MCP config per client, one-command join, capability
  tokens, A2A, and the open backend requests raised by this work.
- `docs/PERFORMANCE.md` — budgets, measurement recipe, regression checklist.
- `test/site.test.mjs` — 31 new gates (21 client + 10 board-contract): the id contract between `app.js` and
  `index.html`, no HTML-parsing sink, reducer purity and history replay, the
  single-`EventSource` and request-coalescing rules, and the payload budget.
- Suite: 109 → **142 tests, 48 suites**, all green.

**Known backend limitations** (raised as mesh requests, see `docs/INTEGRATION.md` §5)

- The hub routes on `req.url.split('/')[1]`, so query strings 404 — including the
  previously documented `/?board=tldraw`. The board reads its flags from the hash
  (`#board&board=tldraw`) so it works on the hub today.
- Static assets carry no `Cache-Control`/`ETag`, so a stale `app.js` can be paired
  with a fresh `index.html`. The service worker now fetches the shell
  network-first.

## 1.3.0 — production hardening + master production plan

**Security (all previously exploitable, all now covered by `test/hardening.test.mjs`)**
- **Fail-closed bind**: a non-loopback `MESH_HOST` without capability auth now refuses to start (exit 78). `MESH_INSECURE=1` is the explicit opt-out. The shipped Docker image generated a keypair on first boot, so it is no longer a world-writable hub.
- **Five write routes were unauthenticated** and are now guarded: `/api/crdt`, `/api/macp`, `/api/dag`, `/api/p2p` POST and `/a2a/rpc`. `/events` (SSE) now requires a token when auth is enforced.
- **Cross-actor lease hijack closed**: intent ids are server-assigned; a client-supplied `payload.id` is ignored.
- **Hard leases require the `lease.hard` scope** — they block every peer, so they are no longer self-asserted.
- Scope set completed: `build` (was missing, so `mesh build` 403'd), `lease.hard`, `crdt`, `macp`, `dag`, `p2p`; prefix wildcards (`tasks.*`) supported.
- `mesh init` / `mesh-join` now propagate `MESH_TOKEN`; the canvas sends `Authorization` on every write.

**Durability**
- `atomicWrite` is now concurrent-safe (unique scratch file), crash-durable (`fsync` file + directory) and Windows-safe (rename retry) — the old fixed `path + '.tmp'` corrupted concurrent writes and made the test suite flaky on Windows.
- Event store: `busy_timeout`, `synchronous=FULL`, `user_version` migrations, **unbounded replay** (the old 100 k cap silently dropped later events), `dbMaxSeq` recovery, periodic WAL checkpoint, `dbEventsSince` catch-up.
- SSE: `id:` frames, `Last-Event-ID` resume, keep-alive ping, backpressure drop, subscriber cap.
- The event-log append failure is no longer swallowed silently.

**Protocol**
- MCP bridge is JSON-RPC 2.0 compliant: `-32700` parse error, `-32601` method not found, `-32602` invalid params, `-32603` internal error; `server/discover` (MCP 2026-07-28) implemented; deterministic `tools/list` ordering; tool failures carry `isError: true`; per-call timeouts; ordered responses.

**Docs**
- `docs/PRODUCTION_PLAN.md` — the new master plan: truth pass over 25 audited defects, a research-grounded synthesis of the agent-collaboration field, the target multi-tenant architecture, 14 collaboration features, six phases with machine-checkable exit criteria, an outcome-based eval strategy, and the measurement set that replaces "tests are green".
- `docs/research/agent-protocols-landscape-2026.md` — primary-source survey of MCP, A2A v1.0, ACP, AG-UI, Claude Code agent teams, worktree orchestrators, CRDT libraries, evals (τ-bench, MAST, METR) and the multi-agent failure taxonomy.
- `docs/SECURITY.md` and `docs/CONFIG.md` rewritten: every row now names the code that implements it and whether it is shipped or planned. The previous versions asserted controls that did not exist (prompt-injection defence in dead code, epoch fencing that never fenced, a 20/min breaker that was never wired).
- `README.md` — updated quickstart for the fail-closed bind and token flow; the "92 tests" badge is now 109.

**Tests**
- `test/hardening.test.mjs` — 17 new gates (atomic-write concurrency, scope semantics, full-log replay, 401 on every previously-open write route, actor binding, server-assigned intent ids, `lease.hard` gating, SSE auth, bridge JSON-RPC compliance, non-loopback refusal).
- Suite: 92 → **109 tests, 43 suites**.

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
