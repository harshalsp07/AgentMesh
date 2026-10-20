# AgentMesh — Performance Budget

The board is a live operator console for a swarm that can mutate state hundreds of
times a minute. "Fast" therefore means two different things, and both are budgeted.

1. **Per interaction** — how long the operator waits for a click to be reflected.
2. **Per event** — how much work the browser does when the mesh changes.

Both are measured live by the in-page **HUD** (`p`, or `#topo&hud=1`).

---

## 1. The budgets

| Metric | Budget | Before | After |
|---|---|---|---|
| HTTP requests per mesh event (amortised) | **→ 0** | 4 | 1/N — a burst of N events costs **1** request |
| HTTP requests for a 40-event burst | **1** | 160 | 1 |
| Requests at rest (idle) | **0** | 6 s poll | 0 |
| Render cost, 50 intents + 200 events | **< 8 ms** | ~40 ms (full rebuild) | ~2 ms |
| Long tasks during a burst | **0** | frequent | 0 |
| First paint | bounded by the shell download | ~350 ms | ~90 ms (warm) |
| Static payload (html+js+css, raw) | **< 220 KB** | 116 KB | ~205 KB |
| Runtime dependencies | **0** | 0 | 0 |
| Topology SVG nodes | **< 80** | 1956 (one line per conflict) | 54 (capped) |
| DOM nodes at 50 intents | **< 1500** | 2988 | 1086 |

> **The payload grew because the board grew.** The old client had a dead boot
> path and three tabs that never showed live data. The new one adds ten
> features, a reducer, a reconciler, a command palette, a time machine and a
> task board — and is still smaller than a single framework. Gzipped it is
> roughly a third of that.
>
> **Round-trip latency is not the client's to give.** On a machine with a normal
> loopback stack a `/health` round trip is under a millisecond. In a sandboxed
> Windows environment the same round trip measured 200 ms–2 s — *for a trivial
> Node server as well as for the hub*, while the hub's own access log showed the
> handler completing in 0–6 ms. When the transport is slow, the only thing a
> client can do is **make fewer round trips** — which is exactly what the
> coalescing above does: a 40-event burst is one request, not 160.

---

## 2. What made it fast

### 2.1 One request per burst, not four per event

The old client did this on every SSE frame:

```
/api/overview  →  /api/crdt  →  /api/macp  →  /api/dag  →  renderAll()
```

The new client does this:

```
event ──► ring buffer + dirty scopes
       ──► debounce(120 ms, ceiling 900 ms) ──► ONE /api/overview
       ──► reconcile only the scopes that changed
```

`pullOverview()` guarantees **at most one request in flight**; a request that
arrives while one is running sets a flag and exactly one more is issued
afterwards. So a 40-event burst costs one request, and a storm of events cannot
produce a request storm.

### 2.2 Hidden desks cost nothing

Inactive desks are `hidden` (`display: none`), which removes them from layout
and paint entirely — stronger than `content-visibility`, and simpler.

Panels that need their own endpoint (CRDT, MACP, DAG, tasks, board) are fetched
**on activation** and cached until the hub's `seq` moves. A desk you never open
issues no requests at all.

### 2.3 Keyed reconciliation instead of `innerHTML = ''`

Every list (strips, roster, requests, CRDT rows, MACP cards, DAG nodes, tasks,
topology actors and conduits) is reconciled by key:

* an existing node with the same key is **patched**, not recreated;
* a node whose key disappeared is **removed**;
* a node is **moved** only when its position actually changed.

DOM identity is stable, so focus, scroll position and CSS transitions survive a
refresh. This is why a 50-intent board re-renders in ~2 ms instead of ~40 ms.

### 2.4 The board does not rebuild the scene while you draw

A stroke used to call `renderBoard()` on every `mousemove`, which rebuilt the
whole SVG. Now the pointer handler patches the live `<path>`'s `d` attribute
directly, and the finished stroke is pushed to the hub as a single op.

### 2.5 The board keeps painting in a background tab

`requestAnimationFrame` is **paused in background tabs** (MDN). A board that
only paints on rAF freezes the moment the operator switches tabs. `scheduleRender()`
races rAF against a 120 ms timer, so the mesh keeps updating in the background
and the operator comes back to a current view.

### 2.6 The topology graph is capped, on purpose

One SVG line per collision is unreadable *and* expensive — 66 conflicts produced
1 956 SVG nodes. The graph now draws at most 24 conflict conduits and 28 actors,
and says so out loud (`42 more conflicts`). The full list is still in the
collision readout and the triage drawer.

---

## 3. Measuring it yourself

### 3.1 The HUD

Open the board with `#topo&hud=1` (or press `p`). It shows:

| Row | Meaning |
|---|---|
| `sync` | last `/api/overview` round-trip in ms |
| `req/min` | requests in the last 60 s (the HUD's own counter) |
| `render` | time spent in the last flush, in ms |
| `longest task` | worst `longtask` entry since load (via `PerformanceObserver`) |
| `dom nodes` | total elements in the document |
| `sse reconnects` | how many times the stream dropped |

### 3.2 Under load

```bash
# terminal 1
MESH_PORT=7799 MESH_DIR=.mesh-perf node src/hub.mjs

# terminal 2
open http://localhost:7799/#topo&hud=1

# terminal 3 — 40 intents as fast as the hub will take them
for i in $(seq 1 40); do
  curl -s -X POST http://localhost:7799/cmd \
    -H 'content-type: application/json' \
    -d "{\"actor\":\"codex-backend\",\"kind\":\"intent.declare\",\"payload\":{\"goal\":\"burst $i\",\"paths\":[\"src/burst/$i.ts\"],\"effect\":\"additive\"}}" \
    > /dev/null
done
```

Expected: **one** request in the HUD's `req/min` counter for the whole burst,
`render` under 8 ms, `longest task` at 0 ms.

### 3.3 With DevTools open

* **Network** → filter `Fetch/XHR`: a burst shows a single `/api/overview`.
* **Performance** → record 10 s while the burst runs: no long task > 50 ms.
* **Memory** → the heap is flat across a burst; nothing accumulates per event.

### 3.4 Automated

```bash
node --test --test-force-exit test/site.test.mjs
```

The suite asserts the structural guarantees that keep it fast: one `EventSource`,
one `setInterval` (the 5 s housekeeping tick, no API polling), the request
coalescing rule, the rAF+timer race, and the payload budget.

---

## 4. Regression checklist

When you touch `site/app.js`, these must still hold:

- [ ] exactly one `new EventSource(`
- [ ] exactly one `setInterval(`, and it is not polling an API
- [ ] no `innerHTML` assignment anywhere (hub data must never reach an HTML parser)
- [ ] no `setTimeout` longer than 900 ms driving a refresh
- [ ] every new list is reconciled with `reconcile()`, not rebuilt
- [ ] the static payload stays under 220 KB
- [ ] `node --test test/site.test.mjs` is green

---

## 5. Known costs

| Cost | Where | Mitigation |
|---|---|---|
| the client keeps the last 500 events in memory | `RING_CAP` | bounded by design; ~1 MB worst case |
| the topology draws a bounded graph | `MAX_TOPO_ACTORS`, `MAX_TOPO_COLLISIONS` | the overflow label tells the truth |
| the Time Machine replays up to 500 events per scrub | `stateAt()` | O(500) per step, well under a millisecond |
| the service worker caches the shell for offline use | `site/sw.js` | the shell is **network-first**, so a deploy is never stale for more than one load |
