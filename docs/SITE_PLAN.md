# AgentMesh Strip Board — Site Plan (2026-10)

**Scope:** `site/` only (the `antigravity-ui` swarm domain). `src/` is the `codex-backend`
peer's domain and is *not* touched — every feature below is implemented **without** a
backend change, or degrades gracefully when the backend lacks the endpoint.

**Status:** shipped in this change set. This file is the design record: what was broken,
what was researched, what was built, and how it is verified.

---

## 0. Research method

`websearch` was unavailable in this environment (every query returned "No search results
found"), so all findings come from **direct retrieval of primary sources** — the same
methodology used for `docs/research/agent-protocols-landscape-2026.md`.

Primary sources consulted:

| Source | What it settled |
|---|---|
| [MDN — Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) | `EventSource` auto-reconnect, `Last-Event-ID` resume, `retry:` field, `event:` vs default `message` dispatch |
| [MDN — EventSource](https://developer.mozilla.org/en-US/docs/Web/API/EventSource) | one-way transport; `data` is always a string → must `JSON.parse`; `onerror` is also fired on normal reconnect |
| [MDN — requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame) | callbacks are **paused in background tabs**; one-shot — must re-arm; always use the frame timestamp, not `Date.now()` |
| [MDN — Intersection Observer](https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API) | visibility detection without `getBoundingClientRect()` on the scroll path → use for lazy panel hydration |
| [MDN — CSS containment](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment) | `content-visibility: auto` + `contain-intrinsic-size` to skip rendering work for offscreen panels |
| [MDN — Using Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers) | worker isolation + `postMessage` copying semantics (used to justify keeping the reducer pure and on-thread) |
| [MDN — Broadcast Channel](https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API) | cross-tab state sync on the same origin → multi-board consistency |
| [MDN — Pointer events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events) | single event model for mouse/pen/touch → `pointerdown/move/up` + `setPointerCapture` |
| [MDN — PerformanceObserver](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceObserver) | `longtask` entries → real "is it janky" signal for the perf HUD |
| [MDN — ARIA `tab` role](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles/tab_role) | required `tablist`/`tab`/`tabpanel` + `aria-selected` + `aria-controls`; roving `tabindex` |
| [MDN — View Transition API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API) | optional cross-fade for tab switches, skipped under `prefers-reduced-motion` |
| [MDN — Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API) | registration + `cache`/`fetch` lifecycle; the pre-existing `sw.js` was never registered |
| [MDN — CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS) | `Access-Control-Expose-Headers` needed to read `x-mesh-seq` cross-origin |
| [MDN — HTML Drag and Drop](https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API) | considered for board shapes; **rejected** in favour of Pointer Events (touch support without a polyfill) |
| [MDN — Web Crypto `CryptoKey`](https://developer.mozilla.org/en-US/docs/Web/API/CryptoKey) | secure-context only → the board uses the hub's hash chain rather than re-implementing signing client-side |

**Research-driven decisions**

1. **Do not add a framework.** The repo is zero-dependency with no build step, and the hub
   serves a hard-coded allow-list of five static files
   (`src/hub.mjs:434` → `style.css`, `app.js`, `board-tldraw.js`, `manifest.webmanifest`,
   `sw.js`). A bundler would break `npm run dev` on a fresh clone and would make the site
   unservable by the hub. Everything ships as plain ES2020 in the existing three files.
2. **Coalesce, don't refetch.** The hub emits one event per state mutation. The old client
   did **4 GETs + a full re-render of 7 panels per event**. The new client does **0 extra
   requests per event**: events feed a pure reducer, and the reducer's output is patched
   into the DOM.
3. **Offscreen work is skipped, not just hidden.** `content-visibility: auto` +
   `contain-intrinsic-size` means a hidden panel costs no layout or paint.
4. **Pointer Events over mouse events.** The old board was mouse-only (no touch, no pen).
5. **Register the service worker.** `site/sw.js` existed since v1.2.0 but was never
   registered — the entire offline layer was dead code.

---

## 1. Audit: what was actually broken

Measured by reading `site/app.js` (1560 lines), `site/index.html`, `site/style.css`,
`src/hub.mjs`, `src/crdt.mjs`, `src/macp.mjs`, `src/dag.mjs`.

### 1.1 Blockers

| # | Bug | Evidence | Impact |
|---|---|---|---|
| B1 | `saveProviderKeys` is **not defined anywhere in the repo**, but is passed to `addEventListener` | `site/app.js:1407` | `ReferenceError` thrown inside `initEvents()` → `initBoard()` and `connectHub()` **never run** → the board never connects, the whiteboard is dead, the status badge stays "Connecting…" |
| B2 | CRDT shape mismatch | client reads `symbols[k] = {value,actor,lamport}` (`app.js:329,755`); hub returns `symbols` as plain values, metadata under `registers` (`src/hub.mjs:734`) | CRDT tab renders `undefined` for value/author/Lamport |
| B3 | DAG shape mismatch | client reads `dagData.nodes` + `node.hash` (`app.js:344,922`); hub returns `{rootHash, heads, missingNodes}` and nodes have `id`, not `hash` (`src/dag.mjs:150`) | DAG tab shows only seed data; clicking a node finds nothing |
| B4 | MACP shape mismatch | client reads `s.votes` (`app.js:814`); `MACPSession.toJSON()` nests votes at `s.data.votes` | vote bars always read 0 yes / 0 no |
| B5 | Token split-brain | boot reads `mesh_auth_token` (`app.js:22`), `loadSettings()` overwrites it with `mesh_token` (`app.js:144`), `connectHub()` writes `mesh_auth_token` (`app.js:242`), `board-tldraw.js:26` reads `mesh_token` | capability token lost on every reload; the tldraw board can never authenticate |
| B6 | SSE never authenticates | `new EventSource(hub + '/events')` (`app.js:274`) — but `EventSource` cannot set headers and the hub requires `?token=` (`src/hub.mjs:507`) | the live stream 401s on any auth-enforced hub |
| B7 | XSS via hub data | `actor`, `title`, `initiator`, `r.text`, CRDT `key`/`value`, `JSON.stringify(payload)` interpolated raw into `innerHTML` and inline `onclick` (`app.js:550,558,674,762,824,922`) | a compromised/hostile hub, or a peer agent writing `</script><img onerror>…` into an intent `goal`, executes script in every operator's browser |
| B8 | `/api/ai/ping` does not exist | `app.js:193` vs `src/hub.mjs` route table | every provider "test" button 404s |
| B9 | No modal Escape / focus trap / focus restore / scroll lock | `app.js:125-139` only toggles a class | `aria-modal="true"` promises focus containment the code does not deliver |

### 1.2 Performance

| # | Problem | Cost |
|---|---|---|
| P1 | 4 uncached GETs + full re-render of topology SVG, strips, roster, requests, CRDT table, MACP cards, DAG timeline **per SSE event** (`app.js:284 → 348`) | O(events × panels). A 20-event burst = 80 requests and 140 container rebuilds |
| P2 | Every render does `container.innerHTML = ''` then rebuilds 100% of the subtree | GC churn; layout invalidation on every node |
| P3 | Board redraws the **entire** SVG on every `mousemove` (`app.js:1117,1125`) | pointer-rate DOM churn, quadratic in shape count |
| P4 | No `seq` guard — a poll that returns identical state still re-renders everything | wasted frames |
| P5 | Unbounded arrays in standalone mode (`intents`, `requests`, `boardShapes`, `crdtSymbols`, `dagNodes`) | slow leak over a long session |
| P6 | `content-visibility` / `contain` unused; 8 panels always in the layout tree | paint cost scales with panel count, not visible panel count |
| P7 | `site/sw.js` written but never registered | no offline, no stale-while-revalidate; the file is dead code |
| P8 | The hub sets **no cache headers** on static assets | every reload re-downloads |
| P9 | `x-mesh-seq` is not in `Access-Control-Expose-Headers` | the cheapest change-detection signal is invisible cross-origin |

### 1.3 Interactivity / capability gaps

| # | Gap | Why it matters |
|---|---|---|
| I1 | No command palette, no keyboard-first control | an operator has to hunt with the mouse for 8 tabs + 5 modals |
| I2 | No time machine | the hub maintains a hash-chained event log; the UI only shows a 100-line text dump |
| I3 | No approvals inbox | `/api/approvals` exists and is **unused** — the core collaboration loop is invisible |
| I4 | No task board | `/api/tasks` exists and the Conductor drives it — invisible in the UI |
| I5 | No integration surface | MCP config, `npx` join and LAN address are all manual |
| I6 | HEALTH tab is hardcoded "Loading…" | `app.js` never fetches `/metrics`; `btn-refresh-metrics`, `btn-verify-dag-chain`, `btn-open-append-dag`, `btn-open-mutate-crdt`, `active-mesh-actors-count`, `p2p-log`, `dag-verify-status` are all dead controls |
| I7 | Collision triage is a count | a conflict says "2 CONFLICT" and nothing else |
| I8 | No presence detail | `presence` is in the overview but never surfaced |
| I9 | Tab bar has no ARIA tab semantics, no arrow-key nav, no deep links | fails WCAG 2.1 §2.1.1 / §4.1.2 |
| I10 | `prompt()` / `alert()` used for editing | blocking, unstyled, untrappable in Safari |
| I11 | Multiple open boards drift | no cross-tab coordination |

---

## 2. Feature plan

Ten features, all additive. Nothing in §1.1 or §1.2 is traded away for them.

| ID | Feature | Panel | Backend needed? |
|---|---|---|---|
| **F1** | **Command Palette** (`Ctrl/Cmd+K`) — fuzzy launcher over every tab, action, intent, task and agent. `role=combobox` + `aria-activedescendant`, full arrow/Enter/Esc support. | global | no |
| **F2** | **Time Machine** — a scrubber over the last 500 events. A **pure reducer** replays the ring buffer to reconstruct mesh state at any past `seq`. "LIVE" snaps back. | bottom bar | no (uses SSE only) |
| **F3** | **Approvals Inbox** — drawer for requests addressed to you, approve/decline inline, plus the pins + decisions feed. | drawer | no (`/api/overview.openReqs`) |
| **F4** | **Task Board** — dependency-aware board (blocked / pending / in-progress / done), claim with one click, WIP limit, Conductor status. | SWARM tab | no (`/api/tasks`) |
| **F5** | **Performance HUD** — sync latency, requests/min, render ms, longest task, DOM nodes, SSE reconnects. | toggle | no |
| **F6** | **Connect panel** — MCP config JSON for Cursor / Claude Code / VS Code / Codex, auto-filled with the live hub URL + token; `npx` one-liner; LAN URL. | SWARM tab | no |
| **F7** | **Collision triage** — click a conflict → drawer with both intents' scopes, the overlapping paths, and actions (open MACP, notify, release one). | TOPO tab | no |
| **F8** | **Presence pilot lamps** — per-agent active/idle/away with last-seen; WIP gauge. | TOPO tab | no |
| **F9** | **Real health tab** — `/metrics`, `/health`, `/ready`, and a working `/verify` hash-chain check. | HEALTH tab | no |
| **F10** | **Cross-tab sync** — `BroadcastChannel('agentmesh')` so N open boards stay consistent. | global | no |

### 1.4 Board chrome compliance (`ui-unslop` / `board-a11y`)

The board is contract-bound to `src/canvas.html` (the reference board). The audit
found every point below out of line, and all of it is now fixed and covered by
`test/site.test.mjs` → *board contract*:

| Rule | Was | Now |
|---|---|---|
| Keyboard map `1-8` / `f` / `r` | ad-hoc `g`-chord + `Alt+1…8` | canonical map; `f` toggles focus mode on TOPO, `r` refreshes the desk |
| `#board-stage` single child | svg + a `<p>` tip | exactly one child — `#board-svg`, or `#tldraw-root` when the flag is set (legacy is *detached*, restored verbatim if the CDN fails) |
| One toolbar | tools + a second right-hand cluster | tools + colour + code ref + status, wrapping on mobile |
| Export / import / clear | three header buttons | one **board menu** (`<details>`) |
| Status line | `#tldraw-status`, prose | one `#bstat`: `synced · seq 12 · 3 shapes` / `local-only · hub unreachable` |
| Tool buttons | `class="active"` | real `<button>` + `aria-pressed`; Delete is an armed mode |
| Canvas colour | `#0a0b0e` + neon palette | `#0d1219` + `var(--line)`, same as the topology map; every palette colour ≥ 4.5:1 on it |
| Sticky text | 11px | 13px minimum |
| Shape identity | id not sent to the hub → delete 400s | the id travels with the op, so the hub stores *our* id; `update` sends a `patch` |
| Code refs | not reachable from the UI | toolbar field → `codeRef` on the shape, rendered under it |
| tldraw colour fidelity | every edit saved as `yellow` | tldraw colour mapped back to the hub's name |

### Non-goals (explicitly rejected)

* **WebSocket transport.** The hub already ships SSE with `Last-Event-ID` resume and a
  SQLite-backed replay. A socket would duplicate that and add a second protocol to the
  peer backend's domain.
* **A bundler / framework.** Breaks the zero-dep, no-build contract and the hub's static
  allow-list.
* **A QR-code join.** It needs a ~15 KB encoder; the value is small for a LAN of two
  laptops, and the `npx` one-liner plus the MCP config snippet already make it one paste.
* **Client-side signing.** `CryptoKey` requires a secure context and the hub already
  implements Ed25519. Duplicating it client-side would be a second source of truth.

---

## 3. Performance architecture

```
                    ┌───────────────────────────────────────────┐
   EventSource ────►│ ingest(evt)                               │
   /events          │  ├─ ring.push(evt)         (cap 500)      │
   (single,         │  ├─ state = reduce(state, evt)  (pure)  │
    ?token=)        │  └─ dirty.add(scopeOf(evt.kind))         │
                    └───────────────┬───────────────────────────┘
                                    │  markDirty()
                                    ▼
                    ┌───────────────────────────────────────────┐
                    │ scheduleFlush()  ── requestAnimationFrame │
                    │  (one frame, one flush, coalesced)        │
                    └───────────────┬───────────────────────────┘
                                    │
             ┌──────────────────────┴───────────────────────┐
             │ if (scope ⊄ visiblePanels) → skip network   │
             │ else fetch /api/overview  (ONE in flight)    │
             │ if (overview.seq === lastSeq) → skip render  │
             └──────────────────────┬───────────────────────┘
                                    ▼
                    ┌───────────────────────────────────────────┐
                    │ patch(views)  ── keyed reconciliation     │
                    │  · reuse DOM nodes, patch text/attrs     │
                    │  · only touch scopes whose data changed  │
                    └───────────────────────────────────────────┘
```

### Rules encoded in the implementation

| Rule | Where |
|---|---|
| **R1** — one `/api/overview` request in flight; events arriving during a fetch set `pending` and trigger exactly one more fetch afterwards | `sync.js` → `requestOverview()` |
| **R2** — never render on an unchanged `seq` | `patch()` early-out on `seq` |
| **R3** — panels not currently visible issue **no** network requests (CRDT / MACP / DAG / tasks / board are fetched lazily and cached until `seq` moves) | `visibleScopes()` |
| **R4** — all renders happen inside one `requestAnimationFrame` | `scheduleFlush()` |
| **R5** — lists are reconciled by key, not rebuilt | `reconcile(container, items, keyFn, create, update)` |
| **R6** — SVG scenes are diffed by `data-k`; the board appends to a live `<path>` during a stroke instead of rebuilding the scene | `renderBoard()` |
| **R7** — every buffer is a bounded ring (`RING_CAP = 500`) | `ring.js` |
| **R8** — hidden panels use `content-visibility: auto` + `contain-intrinsic-size` | `style.css` |
| **R9** — pointer handlers are `pointerdown/move/up` with `setPointerCapture`; listeners are `{ passive: true }` where possible | `board.js` |
| **R10** — the reducer is pure and side-effect free, so F2 can replay history through it | `reducer.js` |

### Budgets (measured by `test/site.test.mjs` + the HUD)

| Budget | Target |
|---|---|
| Requests per burst of N events | **1** (was 4N) |
| Requests per second, idle | **0** (was 6 — a 6 s `setInterval` in `index.html`) |
| First paint | **< 100 ms** (no webfonts, no render-blocking network) |
| Flush cost at 100 intents / 500 events | **< 8 ms** |
| Total static payload | **< 150 KB** raw, no runtime dependency |
| Long tasks during a 20-event burst | **0** |

---

## 4. Accessibility & security deltas

| Area | Before | After |
|---|---|---|
| Tabs | plain buttons in a `<nav>` | `role=tablist` / `role=tab` / `role=tabpanel`, `aria-selected`, `aria-controls`, roving `tabindex`, ←/→/Home/End |
| Modals | class toggle only | `Escape` closes, focus trap, focus restored to trigger, `inert` on the background, scroll lock |
| Command palette | — | `role=combobox`, `aria-expanded`, `aria-controls`, `aria-activedescendant`, live result count |
| Toasts | `aria-live=polite` on the container | unchanged + `role=alert` for errors |
| Event console | `<pre>` with no live region | `role=log` + `aria-live=polite` |
| Board shapes | `<g onclick>`, not focusable | `<g tabindex=0 role=button aria-label>`, Enter/Space activate, Delete removes |
| XSS | raw `innerHTML` interpolation | `textContent` everywhere; the only `innerHTML` uses are static literals or `escapeHtml()`-guarded |
| Inline handlers | `onclick="…('${id}')"` | delegated `data-act` attributes |

---

## 5. Repository deliverables

| Path | What |
|---|---|
| `site/index.html` | restructured shell: palette, scrubber, HUD, approvals drawer, task board, connect panel, real health tab, ARIA tabs |
| `site/app.js` | rewritten: modular sections, pure reducer, keyed reconciliation, lazy panels, coalesced sync, ring buffer, command palette, time machine, perf HUD |
| `site/style.css` | extended: new components, perf tokens, `content-visibility`, focus-visible rings, print stylesheet |
| `site/sw.js` | registered; network-first for `/api`, stale-while-revalidate for static; versioned cache |
| `site/manifest.webmanifest` | mojibake fixed, theme colour aligned to `--room` |
| `docs/SITE.md` | site architecture, feature map, keyboard map, extension points |
| `docs/INTEGRATION.md` | MCP config per client, one-command join, A2A card, capability tokens |
| `docs/PERFORMANCE.md` | budgets, measurement procedure, HUD reference |
| `test/site.test.mjs` | static contract tests, reducer tests, sanitizer tests, page smoke test |

---

## 6. Verification

| Check | Command |
|---|---|
| Unit + contract tests | `npm test` |
| Hub API contract | `node src/hub.mjs` then `curl /api/overview` |
| Manual perf | open `/?hud=1`, run `npm run load` against the hub, watch the HUD |
| Byte budget | `node scripts/publish-check.mjs` |
| Regression guard | `test/site.test.mjs` asserts every `id` the JS binds to exists in `index.html` |

---

## 7. Rule-of-engagement compliance

* Only `site/` + `docs/` + `test/` + root metadata were touched.
* `src/` (the `codex-backend` peer's domain) was **read** for the route/auth contracts but
  **not modified** — every new feature works against the API as it exists today.
* No lease was held on `site/` by a peer at the time of writing
  (`node bin/mesh status --root .mesh` reported no active leases and the hub was offline).
* If a future change needs a backend route (e.g. `?since=` on `/api/events`), it must go
  through `mesh_request` to the backend peer rather than a direct edit.
