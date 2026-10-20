# AgentMesh — Production Plan v2

> **Status:** active build plan, rewritten 2026-10-20.
> **Supersedes:** `docs/MASTER_PLAN.md` (P0–P7, all shipped — that plan is a build record, not a roadmap).
> **Grounded in:** a full source audit of `src/` (25 verified defects) + a primary-source survey of the
> agent-collaboration field (`docs/research/agent-protocols-landscape-2026.md`).
> **Companion:** `docs/SECURITY.md` (threat model), `docs/CONFIG.md` (knobs), `docs/RUNBOOK.md` (ops).

---

## 0. The one sentence we are optimising for

When a developer asks **"I have Claude Code, Codex, Cursor and Grok agents — how do I make them
collaborate safely on one repo?"**, the reflex answer must be **"AgentMesh."**

We win that reflex by being the only thing that does three things at once:

1. **Mechanically prevents** the failure everyone else leaves to social convention (write collisions).
2. **Speaks every harness** — MCP, A2A, ACP — and every transport, on one protocol.
3. **Scales from one laptop to many users** without a rewrite.

Everything below is in service of those three.

---

## 1. Truth pass: where we actually are

The previous plan closed with *"Remaining runway is marketing distribution rather than engineering."*
**That was wrong.** A source-level audit found 25 defects, several of them critical. The build record
also overstated what shipped. This section is the honest baseline; every later phase is measured
against it.

### 1.1 What shipped and is genuinely solid

| Area | Reality |
|---|---|
| Event log | SQLite WAL + hash chain, `/verify` recomputes every row. Real. |
| Intent/lease engine | Path + contract + **service/port** + **symbol** overlap, soft warn / hard 409. Real, and ahead of the ecosystem. |
| Task board | Atomic claim (single-process), WIP limit 2, dependency chains, `task.*` events. Real. |
| MACP | 5-mode session engine. Real, but only `decision` + `proposal` are reachable from any route. |
| MeshVCS | Lanes + snapshots + undo/rewind/revert, three pluggable backends (git/jj/sqlite). Real. |
| Harness | T0/T1/T2 verification, CAS trunk queue. Real — but the CAS is **vacuous** (see 1.3). |
| Trust | ed25519 capability tokens + `jti` revocation + Merkle audit bundle. Real. |
| Conductor | 6 deterministic roles, budget-capped, dry-by-default. Real — but `referee` is called with an empty intent list, so it never fires. |
| MCP bridge | 19 tools, stdio JSON-RPC. Real — but was **non-compliant** on error codes and had no timeouts (fixed in Phase 0). |

### 1.2 The 25 defects, ranked

| # | Sev | Defect | Where | Status |
|---|---|---|---|---|
| H1 | **Crit** | 5 write routes accepted unauthenticated writes: `/api/crdt`, `/api/macp`, `/api/dag`, `/api/p2p` POST, `/a2a/rpc` | `hub.mjs` | ✅ fixed |
| H2 | **Crit** | Auth off by default; shipped Docker image bound `0.0.0.0` with no keys → world-writable hub | `auth.mjs`, `Dockerfile` | ✅ fixed (fail-closed bind) |
| H3 | **Crit** | `payload.id` overrode the server-assigned intent id → **cross-actor lease hijack** | `hub.mjs:331` | ✅ fixed |
| H4 | **Crit** | `atomicWrite` used a fixed `path + '.tmp'` → concurrent writers corrupted each other; no fsync; no Windows retry → **real data loss**, and a *flaky test suite* on Windows | `store.mjs` | ✅ fixed |
| H5 | High | `build` scope missing from the default token scope → `mesh build` and `mesh_build_status` returned 403 for every default token | `auth.mjs` | ✅ fixed |
| H6 | High | Hard lease was **client-self-asserted** → any agent could lock every peer out of a path | `hub.mjs:331` | ✅ fixed (needs `lease.hard` scope) |
| H7 | High | `/events` SSE carried intent paths and task text, unauthenticated, with no `id:`/`Last-Event-ID` resume, no keep-alive, no backpressure | `hub.mjs` | ✅ fixed |
| H8 | High | `dbEvents` capped replay at 100 000 rows; past that the seq counter restarted → **silent event loss** on INSERT conflict | `db.mjs` | ✅ fixed |
| H9 | High | `MESH_EPOCH` ignored on a non-empty DB → standby never actually fenced the primary | `hub.mjs:64` | 🔴 open |
| H10 | High | JSON state (`tasks.json`, `collab.json`, `board.json`) written by **both** the hub and the CLI with no file lock → cross-process lost updates | `tasks.mjs` | 🔴 open |
| H11 | Med | `queue.drain` CAS was **vacuous** — the condition could never be true, so trunk movement was undetectable | `queue.mjs:76` | 🔴 open |
| H12 | Med | `policy.yaml` inline arrays were silently ignored → the **shipped** `templates/policy.yaml` was ~80% inert; `checkBlastRadius`/`checkEgress`/`isGenerated`/`budgets.per_lane` never enforced | `policy.mjs` | 🔴 open |
| H13 | Med | `macp.castVote` threw for any mode but `decision` → `mesh_vote` on a **quorum** session (the documented use-case) 500'd; the quorum ballot path was unreachable | `macp.mjs:51` | 🔴 open |
| H14 | Med | `build-gate` returned `ok:true` when **zero** agents were connected → a false pass | `hub.mjs:605` | 🔴 open |
| H15 | Med | `share.applyBoardOp` update ignored the version → a stale client overwrote a newer shape | `share.mjs:45` | 🔴 open |
| H16 | Med | `crdt` Lamport clock was **per-actor**, so true concurrency was undetectable; tie-break was an arbitrary string compare | `crdt.mjs` | 🔴 open |
| H17 | Med | No `busy_timeout` → a second process on the same DB hit `SQLITE_BUSY`; WAL never checkpointed while running; `synchronous=NORMAL` on an audit log | `db.mjs` | ✅ fixed |
| H18 | Med | `renderContexts()` did O(actors) **synchronous** file writes per event → event-loop stall under load | `hub.mjs:119` | 🔴 open |
| H19 | Med | Unbounded in-memory `log[]`; `/verify` was an unauthenticated O(n) SHA-256 scan (CPU amplification) | `hub.mjs` | 🟡 partial |
| H20 | Med | `p2pSwarm.sweep()` never called → the documented 60 s mailbox TTL did not apply | `hub.mjs` | 🔴 open |
| H21 | Med | `merge.mjs`, `bus.mjs` were **dead code**; `dag.replay`, `jjOpLog`/`jjUndo`, `verifyAudit`, `promoteStandby`, `epochFence` were never called; `bot.reviewer`/`shepherd` never ran | various | 🔴 open |
| H22 | Med | Bridge was **JSON-RPC non-compliant** (unknown method → `result:{}`, parse errors swallowed), no fetch timeouts, tool failures returned as *successes* | `bridge.mjs` | ✅ fixed |
| H23 | Med | `init.mjs` / `mesh-join` wrote MCP configs **without `MESH_TOKEN`** → every tool call 401'd the moment `mesh up` created keys | `init.mjs` | ✅ fixed |
| H24 | Low | `crdt` was LWW registers only — no AST semantics despite the "Semantic CRDT" name; `contracts` extraction is regex-only | `crdt.mjs`, `contracts.mjs` | 🔴 open |
| H25 | Low | CORS `*` on every response; no CSP/`X-Frame-Options`; `/verify`, `/api/*` reads fully open | `hub.mjs` | 🔴 open |

### 1.3 Two claims in the old build record that were not true

- *"SQLite WAL event source of truth."* — true **for the event log only**. Tasks, collab, board, MACP,
  DAG, queue, contracts, lanes and memory are all JSON files. A crash between the event append and the
  JSON write leaves them divergent, and nothing reconciles them. **Phase 2 makes SQLite the source of
  truth for everything.**
- *"MESH_EPOCH fencing."* — the epoch was *stamped* on events, never *checked*. A standby could write
  alongside a live primary. **Phase 4 makes it a real fence.**

### 1.4 The honesty rule for this repo going forward

Every capability in `README.md` must be marked with one of:

- **shipped** — wired end-to-end *and* covered by a test that fails if it breaks;
- **partial** — wired, with a named limitation in the same sentence;
- **planned** — in this document, not in the README's feature table.

`scripts/publish-check.mjs` asserts this. A claim without a test is not shipped.

---

## 2. What the field learned (research synthesis)

Full survey: `docs/research/agent-protocols-landscape-2026.md`. The findings that change what we build:

### 2.1 The gap we occupy is real and uncontested

> *"No production tool arbitrates file-level write collisions automatically."*

Claude Code's agent teams (the only shipped dependency-aware shared board, and **experimental and off
by default** behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) solve it **socially**: *"Two teammates
editing the same file leads to overwrites. **Break the work so each teammate owns a different set of
files.**"* There is no file-level lock. Emdash lists its own weakness as *"No agent-to-agent
coordination — each runs independently."* Vibe Kanban's weakness list says *"no hard task
dependencies."*

**Every other tool in the category ships worktree isolation and leaves coordination to the human.**
Worktree isolation does not cover ports, databases, `.env`, or API contracts. AgentMesh's
intent→lease→contract→quorum chain is the mechanical answer to the exact problem the whole category is
leaving open. **That is the wedge, and it is a durable one.**

### 2.2 Protocol churn is now a schedule risk, not a footnote

MCP's current revision (`2026-07-28`) **removed protocol-level sessions, the `initialize` handshake,
and SSE resumability**. MCP is now stateless with per-request version negotiation; `server/discover`
became mandatory; Tasks moved to an extension. A2A hit `v1.0.0` under the Linux Foundation (Aug 2026)
with a `tenant` field, signed Agent Cards (JWS over RFC 8785 JCS), mTLS, and three bindings with
normative equivalence requirements.

**Consequence:** the bridge must speak several MCP revisions, and we must not build on SSE resumability
(MCP just deleted it from the most-deployed LLM protocol — our own resumability has to be ours).
**Phase 1 delivers a versioned adapter + conformance matrix.**

### 2.3 Durable task handles are the backpressure primitive

MCP Tasks (`tasks/get` · `tasks/update` · `tasks/cancel`, with TTL and a suggested polling interval),
A2A Task + push notifications, and AG-UI run outcomes are three independent answers to the same
question: *how does a caller wait for slow work without holding a connection open?* Our task board is
currently a JSON file. **Phase 2 gives it a durable handle, a TTL, and cancellation.**

### 2.4 Cost is the binding constraint, and it is measurable

Token usage alone explains **80 %** of BrowseComp variance; agents burn ~4× chat tokens and
multi-agent systems ~15×. Anthropic's own guidance: *"multi-agent systems require tasks where the
value of the task is high enough to pay for the increased performance."*

**Consequence:** every coordination feature must be priced in **tokens per decision**, and the cheap
wins are parallelism and *artifact-to-filesystem* (only references travel back; the artefact persists
independently). This is a design constraint, not a nice-to-have.

### 2.5 A green test suite is not a merged PR

METR had four active maintainers review 296 AI-generated SWE-bench Verified PRs: **roughly half of the
test-passing PRs would not have been merged**, and maintainer decisions ran **~24 percentage points
below** the automated grader.

**Consequence:** "92/92 green" is not a quality claim. Phase 5 builds outcome-based evals that measure
the *end state* (no two agents wrote the same path without a held lease; no dependent task was claimable
before its dependency closed) and adds a maintainer-judgement pass for changes AgentMesh itself lands.

### 2.6 The failure taxonomy we must not reproduce

MAST (Cemri et al., v3 Oct 2025) annotates 1 600+ multi-agent traces and names **14 failure modes in
3 categories**: system design, inter-agent misalignment, task verification. Its verdict on current
systems: *"their performance gains on popular benchmarks are often minimal."* We adopt the taxonomy
verbatim as our regression checklist.

Also load-bearing: Anthropic's *"Agents are stateful and errors compound"*; their lead agent executing
subagents **synchronously** blocks the whole system on one slow child; and their architectural rule that
**the harness must never be able to reach a credential** — *"a prompt injection only had to convince
Claude to read its own environment."*

### 2.7 Design rules we adopt

| Rule | Source | What it means for us |
|---|---|---|
| **"Don't adopt a pet."** Decouple session / harness / sandbox. | Anthropic, Managed Agents | The hub is a protocol kernel; models and harnesses are pluggable behind stable interfaces. |
| **"Harness assumptions go stale."** | Anthropic | Model-specific workarounds live in a plugin layer and are deleted when the model changes. |
| **"The session is not the context window."** | Anthropic | The event log is the durable object; a context view is derived, never authoritative. |
| **"Attribution is not advisory."** | AG-UI 1.0 | Every attributed event must agree with the owner; a disagreeing continuation is rejected. |
| **"Tokens are unreachable from the sandbox."** | Anthropic | Agent credentials never enter a lane or a tool payload. |
| **"Publish your metadata disclosure."** | Kangentic relay | If we relay, say exactly what the operator can see (IPs, timing, sizes, pairing graph). |
| **Outcome, not transcript.** | Anthropic evals | Grade end state and checkpoints, never golden step traces. |
| **"Rainbow deployments."** | Anthropic | Version the hub and the wire protocol independently; support N versions at once. |

---

## 3. Target architecture

### 3.1 The shape

```
                     ┌──────────────────── hub (single writer) ────────────────────┐
 MCP stdio bridge ──▶│  intent/lease · contract graph · MACP · task board · CRDT    │
 A2A /ACP gateway  ──▶│  board+voice · policy · harness · audit(DAG) · conductor    │
 REST / WebSocket  ──▶│  ── event store (SQLite WAL, all state) ── SSE /events     │
                     └───────────────┬──────────────────────────┬──────────────────┘
                                     │                          │
                          lanes (COW)  │                          │  observability
              ┌──────────────────────┴────┐            ┌────────┴────────┐
              │ Antigravity │ Codex │Cursor│            │ OTel gen-ai     │
              │   lane      │ lane  │ lane│            │ traces + metrics│
              └───────────────────────┘            └─────────────────┘
```

### 3.2 The five structural changes

**C1 — One writer, one store.** All mutable state moves into the SQLite event store. The hub is the
only writer; the CLI becomes a client. This kills H10 (lost updates), H21 (divergent state) and the
whole class of "two processes, one JSON file" bugs. *Why now:* it is the single highest-leverage
change and everything else (leases, tasks, boards) is easier to make correct on top of it.

**C2 — Leases get TTL, renewal and fencing tokens.** Today a lease is a timestamp. A lease without a
fence lets a paused, GC'd or partitioned holder commit after expiry. Every lease gets
`{holder, scope, grantedAt, expiresAt, fence}`; a commit carries the fence; the hub rejects a commit
whose fence is stale. *Why now:* this is the "last writer wins vs. first writer wins" question that
distributed systems have answered for 30 years, and we are currently guessing.

**C3 — The protocol is versioned independently of the hub.** `MESH_PROTOCOL_VERSION` on the wire;
the bridge advertises which MCP revisions it speaks; the hub serves N protocol versions
simultaneously. *Why now:* MCP `2026-07-28` already broke session semantics.

**C4 — Multi-tenancy is native, not a retrofit.** A **room** is the tenant boundary: its own event
store, its own boards, its own task board, its own contracts. A hub serves many rooms. Actor identity
is scoped to a room. This is what "handle many other users" actually means.

**C5 — Verification is a first-class output.** Every state transition the hub accepts is a
*checkpoint*; every landed changeset produces an *outcome* assertion set; the Conductor's claims are
DAG nodes referencing the events that prove them. That is what turns "92/92 green" into "this PR
would have been merged."

### 3.3 Scale targets

| Dimension | Today | Target | Notes |
|---|---|---|---|
| Actors per hub | ~10 | **500** | No per-actor in-memory structure in the hot path. |
| Concurrent rooms | 1 | **50** | Room-scoped stores; one writer per room. |
| Events/sec sustained | ~50 (sync FS per event) | **2 000** | Async batching, WAL group commit. |
| Event log size | unbounded in RAM | **bounded** | Log is on disk; only a window in memory. |
| P99 declare→collision | <50 ms | **<20 ms** | Measured, not asserted. |
| Recovery from crash | replay whole log | **resume from last checkpoint** | Session-log pattern (Anthropic). |

**The SQLite WAL boundary, stated honestly:** *"All processes using a database must be on the same host
computer; WAL does not work over a network filesystem."* SQLite WAL is **exactly right** for a
single-node self-hosted hub and **wrong** for multi-host. The migration trigger is explicit: *a second
writer, HA, or more than one hub instance* → Postgres with LISTEN/NOTIFY or an outbox table. Until
then, SQLite is a feature, not a limitation.

---

## 4. Feature roadmap — what "best-in-class collaboration" means

### 4.1 Collaboration features (the product)

| # | Feature | Why it wins | Phase |
|---|---|---|---|
| F1 | **Dependency-aware task board with durable handles** | The one thing every competitor lacks. Claude Code has deps but experimental + off by default; Vibe Kanban lists "no hard task dependencies" as its weakness. Durable handle = MCP Tasks shape. | 2 |
| F2 | **Lease TTL + renewal + fencing tokens** | The difference between a lock and a *correct* lock. | 2 |
| F3 | **Port / DB / `.env` / symbol leases** | The part worktrees never solved. Already partly shipped — make it first-class and visible. | 2 |
| F4 | **Contract graph with real AST extraction** | Regex "AST" is not AST. Ship tree-sitter WASM (TS/JS, then Python/Go) and OpenAPI/Proto importers. Breaking-change detection becomes a fact, not a heuristic. | 3 |
| F5 | **Outcome-based verification + maintainer-style review** | Closes METR's 24 pp gap. The Conductor's claims become checkable. | 5 |
| F6 | **Trunk gate that actually gates** | Fix the vacuous CAS; the trunk head moves only on a verified, quorum-approved, fence-checked change. | 3 |
| F7 | **Cross-harness handoff capsules** | Anthropic's "initializer agent + progress file" pattern, generalised. A fresh agent resumes without re-deriving state. | 3 |
| F8 | **Human-in-the-loop approvals that are attributable** | Approvals travel out-of-band, signed, scoped per task, revocable. An agent's claim that "the user approved X" is never authority. | 4 |
| F9 | **Conductor as a real orchestrator** | Fix the empty-`referee` bug; wire `reviewer`/`shepherd`; make it async, durable, and budget-accounted. | 4 |
| F10 | **Rooms / multi-tenancy** | Many users, many repos, one hub. | 4 |
| F11 | **Full protocol surface: MCP + A2A + ACP + AG-UI** | Every harness, every client. Signed Agent Card, `tenant` field, A2A bindings. | 1 |
| F12 | **OTel gen-ai observability** | `gen-ai-mcp` spans, `traceparent` in MCP `_meta` (SEP-414). Decision patterns, not conversation content. | 5 |
| F13 | **Blind-relay transport for untrusted networks** | Kangentic's shape: opaque ciphertext forwarding, per-session Noise handshake, published metadata disclosure. | 6 |
| F14 | **Leaderboards / "mesh benchmark"** | A public, reproducible multi-agent benchmark on top of `pass^k`. | 6 |

### 4.2 What we will explicitly *not* build

- **Our own model.** We are a protocol layer. Anthropic's own numbers (multi-agent = 15× tokens) make
  model routing a cost problem, not a capability problem.
- **A worktree manager.** Everyone has one; it is not the gap.
- **A chat UI.** The hub, the CLI, the MCP tools and the canvas are enough.
- **A hosted SaaS.** Self-hosted is the differentiator (our answer to dots/Grok Bot is *"your machines,
  your code, our protocol"*).

---

## 5. Phased execution plan

Every phase is a shippable PR with a machine-checkable exit criterion. Owners follow `AGENTS.md`:
Laptop 1 (`antigravity-ui`) owns `site/`, Laptop 2 (`codex-backend`) owns `src/`.

### Phase 0 — Production hardening ✅ **SHIPPED (this change)**

*Owner: Laptop 2. Files: `src/{store,auth,db,hub,bridge,init}.mjs`, `bin/mesh-join`, `site/app.js`, `test/hardening.test.mjs`.*

- Durable, concurrency-safe, Windows-safe `atomicWrite` (unique scratch + fsync + rename retry).
- `build`, `lease.hard`, `crdt`, `macp`, `dag`, `p2p` scopes added; prefix-wildcard scopes; `build`
  403 bug fixed.
- **Server-assigned intent ids** — cross-actor lease hijack closed.
- Hard leases require the `lease.hard` scope.
- All previously-open write routes now guarded; SSE authenticated with `id:`/`Last-Event-ID` resume,
  keep-alive and backpressure.
- **Fail-closed bind**: a non-loopback bind without auth refuses to start (exit 78). `MESH_INSECURE=1`
  is the explicit opt-out.
- Event store: `busy_timeout`, `synchronous=FULL`, `user_version` migrations, **unbounded replay**,
  `dbMaxSeq`, periodic WAL checkpoint.
- Bridge: JSON-RPC compliant (`-32700`/`-32601`/`-32602`/`-32603`), `server/discover`, deterministic
  `tools/list`, `isError` on tool failure, per-call timeouts, ordered responses.
- `init` / `mesh-join` now propagate `MESH_TOKEN`; the canvas sends `Authorization` on every write.

**Exit criteria (verified by `test/hardening.test.mjs`, 17 gates):**
`atomicWrite` concurrency · no scratch-file leaks · scope semantics · `build` in default scope ·
`user_version` present · full-log replay · 401 on all five open write routes · actor binding ·
server-assigned intent id · `lease.hard` gating · SSE auth · `-32601` · `-32700` · `-32602` ·
deterministic `tools/list` · `server/discover` · non-loopback refusal.

### Phase 1 — Protocol adapter & versioned surface

*Owner: Laptop 2 (`src/bridge.mjs`, `src/a2a.mjs`). Laptop 1 (`site/docs.html` API tables).*

1. `MESH_PROTOCOL_VERSION` on every response; hub serves N versions.
2. **MCP adapter with a conformance matrix** — speak `2025-06-18`, `2025-11-25`, `2026-07-28`.
   Implement `server/discover`, stateless `_meta` negotiation, `resultType` on results, and the
   **MCP Tasks extension** (`tasks/get` · `tasks/update` · `tasks/cancel`) over our task board.
3. **A2A v1.0.0**: `tenant` field, `supportedInterfaces` with URL sub-path routing, **signed Agent
   Card** (JWS over RFC 8785 JCS), `A2A-Version` header, cursor pagination, `SendMessage`/`SubscribeToTask`
   naming, gRPC/REST binding parity (or an explicit "JSON-RPC only" capability declaration).
4. **ACP** bridge flag so AgentMesh tools appear ACP-compatible (Zed/JetBrains/Kiro/OpenHands).
5. **AG-UI 1.0** event export — runs, subagent attribution, `RUN_Finished` outcomes. *"Attribution is
   not advisory"*: a disagreeing continuation is rejected.
6. `mesh a2a card --sign`, `mesh a2a verify --card`.

**Exit criteria:** `test/protocol-conformance.test.mjs` — the bridge answers correctly under each
supported MCP revision; a signed Agent Card verifies with a published key; the Tasks extension round-trips
create → poll → update → cancel against a live hub; A2A `tenant` isolation holds (a room-A agent cannot
read room B).

### Phase 2 — Durable state, leases with fences, dependency-first task board

*Owner: Laptop 2 (`src/db.mjs`, `src/tasks.mjs`, `src/leases.mjs`).*

1. **All mutable state into SQLite.** `collab`, `board`, `queue`, `contracts`, `lanes`, `macp`, `dag`,
   `memory` become tables. JSON files become *export* artefacts. The CLI becomes a thin HTTP client
   (kills H10, H21).
2. **Lease lifecycle**: `grantedAt` / `expiresAt` / `renew` / `release` / **fence token**. A commit
   carries the fence; a stale fence is rejected. Leases are visible in `/api/overview` and the canvas.
3. **Task board v2**: durable `taskId` handle + TTL + cooperative cancel (MCP Tasks shape); hard
   dependency chains (a task is unclaimable until every dependency is closed); a **deadlock detector**
   (cycle detection over the dep graph) and a `readyToClaim` index; claim becomes a DB transaction, not
   an in-memory swap.
4. **Port/DB/`.env`/symbol lease registry** as first-class entities with their own table, own TTLs and
   own visualisation — the part worktrees never solved.
5. **Performance**: async event persistence with WAL group commit; `renderContexts` becomes a debounced
   background job; the event log leaves RAM (windowed reads + `dbEventsSince` catch-up).

**Exit criteria:** a two-process race on the same task yields **exactly one** winner (test spawns two
Node processes); a stale-fence commit is rejected with 409; a dependency cycle is detected and reported;
`scripts/load.mjs` sustains **2 000 events/s** with p99 declare→collision **< 20 ms**; the event log
exceeds 100 000 events with **zero** loss (regression test for H8).

### Phase 3 — Contract graph, real AST, trunk gate that gates

*Owner: Laptop 2 (`src/contracts.mjs`, `src/queue.mjs`, `src/merge.mjs`).*

1. **tree-sitter WASM adapters** (TS/JS first, then Python/Go) for symbol- and route-level extraction.
   Importers for OpenAPI and protobuf. A **breaking-change classifier** with a real diff, replacing the
   current JSON-length heuristic.
2. **Cross-lane verification** that actually blocks: if actor B consumes a contract actor A is changing,
   A's change cannot land until B re-verifies — enforced, not advisory.
3. **Fix the vacuous CAS** (H11): the trunk head advances only on an expected-hash match. Landed
   changesets are immutable and re-verified.
4. **Three-way merge, real**: `git merge-file` → Mergiraf-style AST merge at integration. `merge.mjs`
   is currently dead code; wire it.
5. **Policy engine v2**: real YAML (or JSON policy) so `templates/policy.yaml` is not inert; **enforce**
   `blast_radius`, `egress_allow`, `generated`, `budgets.per_lane`, `landing.auto`. Add a policy
   linter that fails CI on an unparseable policy.
6. **Deletion gate + ghost clients**: a consumer that vanishes is detected; a symbol deleted while
   referenced is blocked.

**Exit criteria:** a tree-sitter fixture proves symbol-level lease precision (not glob); a stale-hash
land is rejected with 409 and the trunk head does not move; `checkBlastRadius` blocks an oversized
changeset; a policy file with inline arrays is honoured and asserted; `mesh policy lint` fails on a
malformed policy.

### Phase 4 — Multi-tenancy, failover, approvals, the Conductor done properly

*Owner: Laptop 2 (`src/rooms.mjs`, `src/failover.mjs`, `src/bot.mjs`). Laptop 1 (canvas multi-room UI).*

1. **Rooms**: a room is a tenant boundary with its own store, boards, tasks, contracts and roster.
   `POST /api/rooms`, room-scoped tokens, room-scoped SSE, `X-Mesh-Room`.
2. **Real epoch fencing** (H9): every write carries the epoch; a writer whose epoch is behind the
   store's is refused. `promoteStandby`/`epochFence` are wired into the hub and the recovery path —
   they are currently dead code. `fsck` verifies **hashes**, not just linkage.
3. **Attributable approvals**: an approval is a signed, scoped, revocable artefact created through a
   human-facing surface — never an agent's assertion. Per-task scoping (A2A's in-task authorisation
   pattern). The approval UI is Laptop 1's.
4. **Conductor v2**: fix the empty-`referee` call; wire `reviewer` and `shepherd`; make it **async and
   durable** (Anthropic's *"lead agents execute subagents synchronously… the entire system can be
   blocked"* is the bottleneck to remove); every claim is a DAG node referencing the event that proves
   it; budget accounting in tokens, not abstract coins.
5. **Crash-safe resume**: the session log is the durable object; `wake(sessionId)` / `getSession(id)` /
   `emitEvent(id, event)`; a hub restart resumes in-flight runs.

**Exit criteria:** two rooms on one hub cannot see each other's events, tasks or boards; a standby
promoted under epoch+1 **fences** the old primary (the old primary's writes are refused, tested);
an approval signed for task A cannot approve task B; the Conductor's referee fires on a real overlap
and the run resumes after a hub restart.

### Phase 5 — Evals, observability, trust posture

*Owner: both (Laptop 1: harness CI + dashboards; Laptop 2: eval harness).*

1. **Outcome-based eval suite.** Not "did the test pass" but "did the end state reach the goal":
   - *No two agents wrote the same path without a held lease.*
   - *No dependent task was claimable before its dependency closed.*
   - *No breaking contract landed without a quorum.*
   - *The trunk head only moved on a verified, fenced change.*
   Graded on **end state + checkpoints**, never on transcript diffs.
2. **`pass^k` on the coordination protocol**: the probability an N-agent task completes **without
   deadlock** over k trials. τ-bench's `pass^k` idea applied to the mesh itself. This is our
   benchmark's headline number.
3. **MAST's 14 failure modes / 3 categories** as an automated regression checklist.
4. **Maintainer-judgement pass** on changes AgentMesh itself lands (METR's method) — the 24 pp gap is
   the thing to close, and it only closes with human calibration.
5. **LLM-as-judge**: one call, one rubric prompt, 0.0–1.0 + pass/fail, human-calibrated periodically.
   Start with ~20 queries, per Anthropic's guidance.
6. **OTel gen-ai** spans (`gen-ai-mcp`, `gen-ai-agent-spans`), `traceparent`/`tracestate`/`baggage` in
   MCP `_meta` (SEP-414). Monitor decision patterns and interaction structure — **not** conversation
   content.
7. **Security posture**: signed Agent Cards as the interop trust anchor; dual-pubkey rotation with a
   grace window; the `jti` revocation list moved into SQLite with an index; `docs/SECURITY.md` claims
   reconciled against the code by a test.

**Exit criteria:** `mesh eval` runs the outcome suite and prints a pass rate; a deliberately broken
invariant fails the suite; `pass^8` is reported for a 4-agent scenario; a 401 on an unauthenticated
write is asserted in CI; every row in `docs/SECURITY.md` has a test id beside it.

### Phase 6 — Scale, transport, ecosystem

*Owner: both.*

1. **Load & soak**: 500 actors, 50 rooms, 24 h soak, no memory growth, no event loss, lease and task
   correctness under churn.
2. **Blind relay** for untrusted networks: opaque-ciphertext forwarding, per-session Noise handshake,
   crypto layer outside the server's runtime dependencies, **published metadata disclosure**.
3. **Multi-host migration path**: Postgres backend behind the same interface, triggered by
   "second writer / HA / >1 hub instance".
4. **Registry + ecosystem**: MCP server registry, `awesome-mcp` lists, A2A directory, npm polish.
5. **Public benchmark** ("MeshBench") + a leaderboard.

**Exit criteria:** the 24 h soak shows flat RSS and zero event loss; a relay packet cannot be decrypted
by the server (a test asserts the crypto module is not in the server's dependency graph); the Postgres
backend passes the same outcome suite as SQLite.

---

## 6. Measurement

| Metric | Definition | Target | Source |
|---|---|---|---|
| **TTFC** | first `mesh_request` between two distinct actors after `up` | **< 5 min** | `ttfc_ms` in kv → `/metrics` |
| **North star** | % of installs with ≥2 distinct actors collaborating on one repo | **> 40 %** | `/api/overview` presence |
| **Collision prevention** | % of would-be overlapping writes blocked before the edit | **100 %** | `policy.denied` / `intent.declared` ratio |
| **Deadlock freedom** | `pass^k` of an N-agent task | **≥ 0.95 at k=8** | `mesh eval` |
| **Landability** | % of AgentMesh-produced changes a maintainer would merge | **≥ 80 %** | maintainer-judgement pass |
| **Coordination cost** | tokens per decision | **< 15 % of task value** | conductor accounting |
| **p99 declare→collision** | latency | **< 20 ms** | `scripts/load.mjs` |
| **Crash recovery** | resume in-flight run | **< 5 s** | failover drill |
| **Onboarding** | fresh machine → first collaboration | **≤ 90 s** | `mesh init` e2e |

Telemetry is **opt-in, local-first, and never carries conversation content** — the Anthropic rule:
monitor decision patterns and interaction structure, not what the agents said.

---

## 7. Security model (summary — full model in `docs/SECURITY.md`)

| Threat | Control | Status |
|---|---|---|
| Network stranger | Fail-closed bind; ed25519 capability tokens on every write; scoped per capability | ✅ Phase 0 |
| Impersonation | Token actor must equal body actor (403) | ✅ |
| Lease hijack | Server-assigned intent ids; `lease.hard` scope; fence tokens | ✅ / Phase 2 |
| Prompt injection between agents | Agent messages are **data**, not authority; approvals are out-of-band and attributable | 🟡 Phase 4 |
| Credential reach | Tokens never enter lanes or tool payloads; proxies fetch on the agent's behalf | 🟡 Phase 4 |
| Destructive shell | Deny-list + approval shims on PATH; the real binary never execs on deny | ✅ |
| Log tampering | Hash chain + Merkle bundle + `user_version` migrations | ✅ |
| Policy inertness | Real YAML + enforced blast radius / egress / budgets | 🔴 Phase 3 |
| Secret leakage | T0 scan + redaction; secrets excluded from snapshot manifests | ✅ |
| Runaway agent | Per-actor rate limit, body limits, budgets, retry caps | ✅ |

**Open, and stated openly:** there is no standard "agent identity" primitive. Ed25519 + revocation is a
reasonable homegrown choice but is **not interoperable**. The interop anchors are A2A's signed Agent
Card and mTLS as an A2A security scheme — both scheduled for Phase 1.

---

## 8. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| An incumbent ships real file-level locking (Claude Code teams graduates) | Medium | High | We already ride MCP/A2A/ACP; our differentiator becomes the *contract + quorum + verification* layer, not the lock. Keep Phase 3 and 5 ahead. |
| The category consolidates around "worktree + BYO CLI agent" (Vibe Kanban sunsetting) | Medium | Medium | The category's published weaknesses are *exactly* ours: no coordination, no hard dependencies. Lead with the dependency-aware board + contract graph. |
| MCP churn breaks integrations | **High** | Medium | Versioned adapter + conformance matrix (Phase 1). Never build on a feature the spec has deprecated. |
| Multi-tenancy retrofit is expensive | Medium | High | Do it in Phase 4 **before** the user base grows, not after. |
| Coordination cost eats the benefit (15× tokens) | Medium | High | Price every feature in tokens/decision; prefer parallelism + artefact-to-filesystem over conversational round-trips. |
| We over-claim again | Medium | High | The §1.4 honesty rule plus the doc-claims test. |
| SQLite WAL single-host limit blocks scale | Low (now) | Medium | Explicit trigger → Postgres in Phase 6, behind the same interface. |

---

## 9. The next ten moves

1. `test/hardening.test.mjs` into CI as a required gate (Linux **and** Windows). ✅ *done here*
2. Wire `MESH_TOKEN` through `mesh init --token` and `mesh-join --token` end to end. ✅ *done here*
3. Fix the vacuous trunk CAS (H11) — a 20-line change, unblocks the whole "trunk cannot go red" claim.
4. Fix `macp.castVote` for `quorum` mode (H13) — the documented use-case currently 500s.
5. Fix the `build-gate` zero-agent false pass (H14).
6. Replace the hand-rolled YAML parser; make `templates/policy.yaml` live; enforce blast radius (H12).
7. Move tasks + collab + board into SQLite with a single writer (Phase 2.1).
8. Add lease TTL + renewal + fence tokens (Phase 2.2).
9. MCP `server/discover` + stateless `_meta` + conformance matrix (Phase 1.2).
10. `mesh eval` with the four outcome assertions (§5 Phase 5.1) — the metric that replaces "92/92 green".

---

## 10. What "done" looks like

AgentMesh is done when:

- A developer on a fresh laptop can run `npx @harshalsp/agentmesh init` in **their own** repo, have
  three harnesses join one room, and have two of them write overlapping files — and the mesh **stops
  the collision before it happens**, with a reason, and a decision recorded.
- A team can run AgentMesh for **many rooms and many users** on one host with per-room isolation, and
  the answer to "did the agents actually collaborate well?" is a **measured pass^k**, not a vibe.
- Every claim AgentMesh makes about itself is backed by a test that fails when the claim stops being
  true — and the docs are generated from that same source of truth.

> *The only widely-shipped dependency-aware shared task board is experimental and off by default.*
> *No production tool arbitrates file-level write collisions automatically.*
> *Every other tool in the category ships worktree isolation and leaves coordination to the human.*
>
> That is the gap. This plan is how we take it.

---

*Machine note: verify every phase with `node --test --test-force-exit test/*.test.mjs` and
`node demo.mjs && node demo-phase1.mjs && node demo-phase2.mjs && node demo-phase3.mjs &&
node demo-collab.mjs && node demo-share.mjs && node demo-bot.mjs`. Node ≥ 22.*
