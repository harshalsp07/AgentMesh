# AgentMesh Strip Board — Site Architecture

The board is the operator's window into the mesh: who is working on what, where the
scope overlaps, what the swarm decided, and what it needs from you.

It is a **zero-dependency, zero-build** client. Three files ship the whole app:

| File | Role | Budget |
|---|---|---|
| `site/index.html` | structure + semantics (ARIA tabs, drawers, palette, scrubber) | < 45 KB |
| `site/app.js` | state, reducer, net, views, features | < 130 KB |
| `site/style.css` | the signal-room design system | < 36 KB |

> The hub serves a **fixed allow-list** of static files
> (`src/hub.mjs` → `style.css`, `app.js`, `board-tldraw.js`, `manifest.webmanifest`,
> `sw.js`) plus `site/index.html` for `/`. Anything not on that list is unreachable
> from `npm run dev`. That constraint — not taste — is why there is no bundler.

---

## 1. The data flow

```
                    ┌────────────────────────────────────────────┐
  EventSource ─────►│ ingest(evt)                               │
  /events           │   ├─ ring.push(evt)          (cap 500)    │
  (ONE connection,  │   ├─ state.events.push(evt)               │
   ?token= for      │   └─ markDirty(scopeOf(kind))             │
   auth)            └────────────────┬───────────────────────────┘
                                     │ dirty scopes
                                     ▼
                    ┌────────────────────────────────────────────┐
                    │ scheduleRender()                           │
                    │   requestAnimationFrame(once)  ─┐         │
                    │   setTimeout(once, 120)        ─┴─ race   │
                    └────────────────┬───────────────────────────┘
                                     ▼
                    ┌────────────────────────────────────────────┐
                    │ flushRender()                              │
                    │   · render only the scopes that changed   │
                    │   · reconcile lists BY KEY (reuse nodes)  │
                    │   · hidden desks cost nothing              │
                    └────────────────────────────────────────────┘

  events ──► scheduleSync() ──► debounce(120ms, max 900ms) ──► pullOverview()
                                                            └─ ONE request in flight
```

### The rules

| # | Rule | Why |
|---|---|---|
| R1 | **One** `/api/overview` request in flight; a burst of N events costs **1** request | the old client did 4 GETs + a full re-render per event |
| R2 | A response with an unchanged `seq` is not re-rendered | a poll that returns the same state must be free |
| R3 | A desk that is not on screen issues **no** request | CRDT / MACP / DAG / tasks are fetched on activation and cached until `seq` moves |
| R4 | Every render happens inside one frame (or one 120 ms tick) | no layout thrash mid-gesture |
| R5 | Lists are reconciled by key, never rebuilt | DOM nodes are reused and patched in place |
| R6 | SVG scenes are diffed by key; a board stroke patches a live `<path>` | no per-mousemove rebuild |
| R7 | Every buffer is bounded (`RING_CAP = 500`) | no slow leak over a long session |
| R8 | Inactive desks are `hidden` (`display:none`) | zero layout/paint cost, not even `content-visibility` |
| R9 | Pointer events with `setPointerCapture`; listeners passive where possible | one code path for mouse, pen and touch |
| R10 | The reducer is pure | the Time Machine replays history through the same function |

### Why rAF is raced with a timer

`requestAnimationFrame` is **paused in background tabs and hidden frames** (MDN).
A board that only paints on rAF silently freezes the moment the operator switches
tabs — exactly when they want the mesh to keep up. `scheduleRender()` therefore
races rAF against a 120 ms timer: the frame path gives frame-aligned painting, the
timer guarantees the board still updates while hidden.

---

## 2. Module map (`site/app.js`)

| Section | Lines | Contents |
|---|---|---|
| §0 Utilities | 21–160 | `el()` / `svg()` safe DOM factories, `ring()` bounded buffer, `debounce()`, `reconcile()` keyed DOM reconciler, `copyText()` |
| §1 Store + reducer | 161–360 | `state`, `applyEvent()` (pure), `cloneMirror()`, `stateAt()` (time travel), `scopeOfEvent()` |
| §2 Net | 360–510 | `net.request()`, `openStream()` (SSE), `pullOverview()` (coalesced), `ensurePanel()` (lazy), `probeHub()` / `resolveHubUrl()` |
| §3 Views | 511–1356 | readout, topology, strips, roster, lamps, requests, ops, task board, CRDT, MACP, DAG, board, health, event console |
| §4 Features | 1356–1734 | perf HUD, approvals drawer, collision triage, time machine, command palette, connect panel |
| §5 Board | 1734–1959 | pointer-event drawing, shape conversion, tldraw bootstrap, `promptText()` dialog |
| §6 Voice | 1959–2023 | `getUserMedia` + `AnalyserNode` VU meter |
| §7 Actions + wiring | 2023–end | declare/release, requests, CRDT, MACP, tasks, DAG, tabs, modals, keyboard, boot |

Everything is reachable on `window.AgentMeshApp` for scripting and tests:

```js
AgentMeshApp.state          // live state
AgentMeshApp.stateAt(seq)   // reconstruct the mesh at a past seq
AgentMeshApp.applyEvent(m, evt)  // the pure reducer
AgentMeshApp.reconcile(...)  // the keyed DOM reconciler
AgentMeshApp.pullOverview() / selectTab() / openPalette() / setScrub()
```

---

## 3. Feature map

| Feature | Where | Shortcut |
|---|---|---|
| **Topology & intents** — live AST-scope graph, paper strips, collision conduits | TOPO | `1` |
| **Presence pilot lamps** — one lamp per live agent, active / idle / away | header | — |
| **Collision triage** — both scopes, the overlapping paths, one-click MACP / release | click the conflict readout | — |
| **Swarm roster** — local agents merged with the hub roster | SWARM | `2` |
| **Swarm ops** — task stats, Conductor, repos, live agent count | SWARM | — |
| **Task board** — blocked / pending / in-progress / done, one-click claim | SWARM | — |
| **Connect panel** — MCP config for Cursor / Claude Code / VS Code / Codex / join | SWARM | — |
| **Approvals & messages drawer** — accept/decline requests, pins, decisions | header ✉ | `i` |
| **CRDT registers** — semantic symbols, authors, Lamport clocks | CRDT | `3` |
| **MACP sessions** — 5 modes, weighted votes, quorum bars | MACP | `4` |
| **Merkle DAG** — provenance timeline, live hash-chain verification | DAG | `5` |
| **Whiteboard** — pointer drawing, hub-synced, tldraw deep link | BOARD | `6` |
| **Voice & P2P** — real microphone, Web Audio VU meter | VOICE | `7` |
| **Health & logs** — real `/metrics`, `/health`, `/ready`, `/verify`, live event log | HEALTH | `8` |
| **Command palette** — fuzzy launcher over every action, agent, intent and task | everywhere | `Ctrl/Cmd+K`, `?` |
| **Time Machine** — scrub the last 500 events and watch the mesh rewind | bottom bar | `l` |
| **Performance HUD** — sync latency, req/min, render ms, longest task, DOM nodes | header `HUD` | `p` |

### Keyboard map

The canonical map, shared with the canvas at `src/canvas.html`:
**`1-8` desks · `f` focus · `r` refresh.**

| Key | Action |
|---|---|
| `1` … `8` | go to desk (TOPO, SWARM, CRDT, MACP, DAG, BOARD, VOICE, HEALTH) |
| `f` | focus the desk — on TOPO it toggles focus mode (the graph collapses to one agent and its neighbours); elsewhere it moves the caret to whatever that desk is for |
| `r` | refresh the current desk from the hub |
| `Ctrl/Cmd + K`, `?` | command palette |
| `i` | toggle the approvals drawer |
| `p` | toggle the performance HUD |
| `l` | toggle live / time machine |
| `Esc` | close the palette, then the modal, then the drawers |
| `Enter` / `Space` | activate a focused topology node or board shape |
| `Delete` | remove the focused board shape |

### Board chrome

The board follows the same rules as `src/canvas.html`:

* one toolbar — tools, colour, **code ref**, and the status line — wrapping on mobile;
* every tool is a real `<button>` with `aria-pressed` (Pen / Block / Note / Select / Delete);
* `#board-stage` holds a **single** child: `#board-svg`, or `#tldraw-root` when the
  tldraw flag is set. The legacy canvas is *detached*, not hidden, so it can never be
  tabbed into — and it is restored verbatim if the CDN fails;
* export / import / clear live in the **board menu**, never as extra header buttons;
* one status line, `#bstat`: `synced · seq 12 · 3 shapes` or `local-only · hub unreachable`;
* the canvas is `#0d1219` with a `var(--line)` border, the same as the topology map;
* sticky text is 13px minimum and every palette colour clears 4.5:1 on that canvas.

---

## 4. The reducer and the Time Machine

`applyEvent(mirror, evt)` is the **only** function that knows what an event means.
It mutates a plain object and knows nothing about the DOM, the network or the clock.

That single property buys three things:

1. **The Time Machine.** The client keeps the last 500 events plus a *base* snapshot
   of the state immediately before the oldest retained event. `stateAt(seq)` clones
   the base and folds the events up to `seq` — reconstructing the mesh as it was.
   `GET /api/events?limit=200` seeds the buffer on connect, so the scrubber works
   the moment the board opens.
2. **Optimistic updates.** A user action can be reflected locally before the hub
   round-trips.
3. **Testability.** The reducer is unit-tested in `test/site.test.mjs` without a
   browser.

The **live** view is still authoritative server state (`/api/overview` + the lazy
panel endpoints). The reducer is used for history, for instant feedback, and to
classify which panels an event dirties.

---

## 5. Security properties

| Property | How it is enforced | Test |
|---|---|---|
| No markup injection | `el()` has **no** `html` option; hub data only ever reaches the DOM through `textContent` / `setAttribute` | `test/site.test.mjs` → "never hands hub data to an HTML parser" |
| No inline handlers | every action is a `data-act` attribute handled by one delegated listener | idem |
| No `eval` / `new Function` / `document.write` | — | idem |
| Capability token never in a DOM attribute | it lives in `localStorage` and is sent as `Authorization: Bearer` (or `?token=` for `EventSource`, which cannot set headers) | manual |
| XSS in the *old* client | actor / title / payload / CRDT values were interpolated raw into `innerHTML` — a peer agent could execute script in every operator's browser | fixed |

---

## 6. Hub-facing contract

The client reads exactly these endpoints (all exist today; nothing new was added):

| Endpoint | Used for |
|---|---|
| `GET /health` | liveness + hub discovery |
| `GET /api/overview` | the aggregate: intents, collisions, roster, presence, requests, pins, decisions, tasks, repos, conductor |
| `GET /api/crdt` | semantic registers + vector clock |
| `GET /api/macp` | coordination sessions + votes |
| `GET /api/dag` | Merkle root + nodes |
| `GET /api/tasks` | the task board |
| `GET /api/board` | whiteboard shapes |
| `GET /api/events?limit=N` | Time Machine history |
| `GET /metrics` `/health` `/ready` `/verify` | the HEALTH desk |
| `GET /events` | the live SSE stream |
| `POST /cmd` | `intent.declare`, `intent.release`, `presence` |
| `POST /api/request` `/api/request-respond` `/api/pin` `/api/decision` | collaboration |
| `POST /api/crdt` `/api/macp` `/api/tasks` `/api/board-op` | writes |
| `POST /api/voice-*` | WebRTC signalling |

### Known hub routing limitation (backend-owned)

The hub routes on `req.url.split('/')[1]`, which keeps the query string. So
`/?hud=1` — and the previously documented `/?board=tldraw` — return **404** from
`npm run dev`. The board therefore reads its flags from the **hash**, which is
never sent to the server:

```
#topo&hud=1          →  topo desk, performance HUD on
#board&board=tldraw  →  board desk, open the tldraw canvas
```

The query string is still honoured as a fallback for static hosts (Cloudflare
Pages / Vercel / Netlify), where `/` routing is correct.

A one-line backend fix — strip the query string before routing, and add
`Cache-Control` / `ETag` to static assets — is filed as a mesh request to the
backend peer (`docs/INTEGRATION.md` §5). Until then the hash form works
everywhere.

---

## 7. Extending the board

**A new desk.** Add a `<section class="view-panel" id="view-x" role="tabpanel">` to
`index.html`, a `<button role="tab" data-tab="x">` to the tablist, then in
`app.js`:

```js
// 1. fetch lazily when the desk opens
if (key === 'x') void ensurePanel('x');           // add the path to ensurePanel()
// 2. render when its scope is dirty
if (scopes.has('x')) renderX();
// 3. scope the events that affect it
//    in scopeOfEvent():  if (kind.startsWith('thing.')) return 'x';
```

**A new action.** Add a `data-act="my-action"` attribute to any element and one
case in the delegated handler in `initDelegation()`. No inline handlers, no
re-binding.

**A new palette entry.** Push onto the array returned by `paletteActions()`.
The palette filters it automatically.

**A new event kind.** Add a case to `applyEvent()`. The Time Machine, the scope
mapping and the dirty-routing all follow from that one switch.

---

## 8. Testing

```bash
node --test --test-force-exit test/site.test.mjs
```

The suite has no browser dependency. It:

1. asserts every `id` `app.js` binds to exists in `index.html` (a renamed id fails
   the build, not the browser);
2. asserts no HTML-parsing sink exists in `app.js`;
3. unit-tests the reducer and the history replay;
4. asserts the payload budget, the single-`EventSource` rule and the
   request-coalescing rule;
5. boots the real hub and asserts it serves the board and every endpoint the
   client reads.

For interactive verification, open the board with `?hud=1` (or `#topo&hud=1`) and
watch the HUD while `node scripts/load.mjs` drives the hub.
