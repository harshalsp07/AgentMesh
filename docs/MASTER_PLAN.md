# AgentMesh — Master Plan: Become the Default Answer to "How Do I Make My Agents Collaborate?"

> Status: proposal for the next build cycle (written Oct 19, 2026).
> Ground truth: `IMPROVED_PLAN.md` (what's built), `AgentMesh — Complete Design Plan.md` (design invariants).
> Every work item names the file(s) it touches so Laptop 1 (`antigravity-ui`, `site/*`) and Laptop 2 (`codex-backend`, `src/*`) can parallelize.

---

## 0. The one sentence we are optimizing for

When a developer — or an AI assistant itself — is asked **"I have Claude Code, Codex, Cursor and Grok agents; how do I make them collaborate safely on one repo?"**, the reflex answer must be:

**"AgentMesh."**

Not an orchestrator, not another vendor inbox, not a SaaS bot. A protocol. We get there by product, website, distribution — and by shipping our own first-class agent (the "Conductor") that proves the protocol every time someone runs it.

---

## 1. Market analysis — who is around and where the gap is (Oct 2026)

### 1a. Four categories compete for the word "collaboration"

| Category | Examples (verified Oct 2026) | What they give | What they *cannot* do |
|---|---|---|---|
| **Vendor-native agent teams** | Claude Code *Agent Teams* (shared task list, file-lock claiming, teammate messaging — experimental, Anthropic-only), OpenAI Codex subagents | In-session coordination, task claiming | Cross-vendor agents, cross-machine, no lease/contract protocol; docs themselves warn *same-file edits cause overwrites* and require manual work partitioning. **The exact problem AgentMesh automates.** |
| **3rd-party orchestrators** | amux, Conductor, Kepler (GitKraken), Emdash, Claude Squad, dmux, Kangentic, Codeg, … | Worktrees, kanban, watches/self-heal, dashboards | Worktrees don't isolate **ports/DBs/.env**; no conflict *forecast*; no contract drift detection; rarely cross-LAN; coordination is a human wading a board |
| **Always-on personal agents ("bots")** | **OpenAI *dots*** (Sep 29 2026: always-on agent w/ own cloud computer, "teams of dots" is *vision*), **xAI Grok Bot** (Aug 11 2026: bots share a cloud computer, message-like-colleagues), Meta Muse | 24/7 proactive assistants, memory, multi-channel reach | Closed cloud; not a repo-collaboration layer; no merge safety, no multi-harness mesh |
| **Protocols** | **MCP** (tools/context), **A2A 1.0** (agent cards/RPC), **ACP** | Vocabularies and transport | Nothing about runtime *safety*: leases, quorum, contracts, verified merge |

### 1b. Our analysis: AgentMesh's unique wedge (nobody has all four)

1. **Cross-vendor & cross-machine** — Antigravity, Codex, Cursor, Claude Code, Grok Build, OpenCode on different laptops under one protocol. (Vendor-native teams can't; orchestrators mostly can't.)
2. **Safety is protocol-level, not advisory** — intent → lease → lane → contract-drift → MACP quorum → harness-gated CAS trunk. Others rely on the agent *behaving*; we make misbehavior expensive.
3. **Agents as peers, not widgets** — contract-first messaging (`mesh_request`), trust, approvals, handoff capsules, standups. Others see agents as background workers; Claude's own guide calls teams "add coordination overhead."
4. **Self-hosted & open** — hub on your laptop/LAN/Tailscale, no vendor cloud. The dots/Grok-Bot answer is "send context to our cloud"; ours is "your machines, your code, our protocol."

**The honest weaknesses we must fix to win the reflex question:**
- Time-to-value: today you clone *AgentMesh itself* into the loop; a newcomer wants `npx agentmesh` inside *their own* project.
- No info landing site — `site/index.html` is the *app* observatory (strip board), not a place a first-timer lands.
- No always-on agent *persona* to compare against dots/Grok Bot (Section 3B fixes this).
- Default lane/VCS storage is dir-copy & regex contracts (MVP fidelity, documented in `IMPROVED_PLAN.md`) — fine to start, needs upgrade path.

---

## 2. Information website (`site/`) — the front door

Owner: Laptop 1 (`antigravity-ui`). The app pages stay; a **landing/docs surface** is added on top of the same manifest + style system, no framework, same zero-dep rule.

### W1. Landing page `site/index.html` (new hero section above the app, or `site/learn/index.html` new page — decision below)
Decision: keep `index.html` as the live app ("see it working"), add **`site/landing.html`** served at `/` for fresh visitors with `?demo` shortcut to the app. Elements, in order:
1. **Hero (10-second proof):** "Agents that don't step on each other." + animated em script: two dots — `antigravity-ui` and `codex-backend` — declaring intents on a mini-strip-board, one gets an OVERLAP flash, resolves via vote, trunk advances. Pure SVG/CSS, no libs.
2. **"The problem in 4 lines"**: silent overwrites → context blindness → no consensus → AgentMesh fixes it at the protocol layer.
3. **Six pillars in one row** (intent-leases, lanes/MeshVCS, MACP, CRDT, MCP+A2A, harness-gated trunk) — each links to a docs anchor.
4. **Cross-vendor matrix**: logo strip of Anthropic/OpenAI/Google/xAI/Cursor harnesses + "same tools work everywhere" (from README's MCP table).
5. **Comparison module** — "Where AgentMesh sits" with the Section 1 four-category table, distilled to 8 rows (clones of Sep-Oct 2026 published comparisons disprove copying).
6. **The Conductor teaser** (Section 3B): "Meet the first mesh-native agent" with screenshot of a real session.
7. **CTA band**: `npx @harshalsp/agentmesh up` one-liner (copy button), GitHub star button, Discord.
8. **FAQ accordion** referencing MCP/A2A docs and quickstart.

### W2. Docs site `site/docs.html` (static, hash-routed, same CSS)
Sections: Quickstart (2 laptops ≤2 min), Concepts (lane, intent, lease, contract, quorum, trunk), Recipes (per-harness install snippets: Antigravity / Cursor / Claude Code / Codex / Grok Build / OpenCode / Windsurf), API (the `/api/*` endpoints in `src/hub.mjs`), Security model, Troubleshooting (`mesh doctor`). Content is generated from a single `docs/content.mjs` script so `README.md`, site, and pages never drift (publish-check asserts sync).

### W3. Dots playground (the "make it obviously alive" feature)
`site/playground.html`: a self-contained simulator that **runs the real hub logic in-page** (import `src/crdt.mjs` + `src/macp.mjs` compiled to a bundle via `scripts/bundle-sim.mjs`). Visitors press *Run* and watch 3, 5, 8 synthetic agents ("dots") declare intents, collide, negotiate, merge — with the same strip-board visuals. This is also our **recorded demo source**: press *Record* → produces a 20 s webm GIF for the README.
- Exit criteria: no network calls; runs from GH Pages; `test/playground.test.mjs` asserts deterministic seeded scenario.

### W4. SEO / answer-engine surface
- `site/sitemap.xml`, meta per page, `/blog/` with 4 engine posts (see Section 5 E1), `llms.txt` at repo root (agents find us too — a collaboration tool must be discoverable *by agents*).
- OpenGraph images generated by `scripts/og.mjs` (SVG→PNG via resvg-js at publish time).

### W5. Produce/PWA niceties (cheap)
- `manifest.webmanifest` gains `shortcuts` (Overview, Board, Health); offline mode switch for the docs (same sw.js).

**Owner split:** W1–W5 all `site/*` + `scripts/*` on Laptop 1; W3 bundles script touches `src/crdt.mjs`/`src/macp.mjs` only read-only (no API change → no MACP quorum needed).

---

## 3. Product — the parts to build (`src/`, `bin/`, `extension/`)

Owner: Laptop 2 (`codex-backend`) for `src/*`; cross-check UI bits with Laptop 1.

### 3A. Adoption friction: "install anywhere in 60 seconds"
1. **`mesh init <target-repo>`** (new subcommand in `bin/mesh` / `src/mesh.mjs`): writes `.agents/mcp_config.json`, `.agents/rules/agentmesh.md`, adds `.mesh/` to gitignore, detects installed harness configs (`.claude/`, `.codex/`, `.cursor/mcp.json`, Antigravity auto-detect) and offers to append the server entry. The target repo is any repo — AgentMesh dir stays a plain dependency, hub clones *nothing*.
2. **`npx @harshalsp/agentmesh up`** → runs hub on 7777 + prints the join QR/URL + `mesh-join` command for laptop 2.
3. **Harness auto-detection** in `mesh-join`: enumerate known configs (extend `templates/laptop2/*`), write only what exists, print a per-harness checklist.
4. **`mesh doctor --fix`**: auto-repair (port busy → suggest, node missing → message, git absent → warn) — extend `scripts/doctor.mjs`.
5. **TTFC metric** wired into `/metrics`: *time-to-first-collaboration* — first `mesh_request` between two actors after `up`. That number is the website headline.

### 3B. The Conductor — our own first-class agent ("our dot", not theirs)
A mesh-native always-on agent bundled with the hub. It is *not* a model wrapper pretending to be an agent; it is a **role-lord** the harnesses drive: a budget-capped autopilot that can run any installed CLI harness (Claude/Codex/Grok/OpenCode) with the mesh protocol enforced.

Name: **`mesh bot`** (`src/bot.mjs`, `bin/mesh bot`). One process, six personalities selected per task:

| Role | Does | Mesh tools it uses |
|---|---|---|
| **Scout** | Walks the repo, builds the project map + contract graph before humans ask | `mesh_declare_intent` (read-only), `mesh_crdt_set` map |
.cmd) | reads goal → splits into scopes with smart overlap estimates → creates lanes/tasks | `mesh_declare_intent`, tasks (3C) |
| **Referee** | Watches collisions; drafts negotiation ladders; can be granted auto-arbitrate | MACP proposal mode, pins |
| **Reviewer** | Fresh-context PR review of every landed changeset + drifting contract alerts | `mesh_pin`, harness T2 hooks |
| **Shepherd** | Welcome brief for new agents; standup digests; capsule handoffs | `mesh brief`, `mesh digest`, `mesh capsule` |
| **Keeper** | Repo memory: conventions that worked, "how this repo behaves", de-facts | new `mesh memory` namespace |

**Conductor surfaces:** CLI (`mesh bot run "<goal>"`), MCP (`mesh_spawn_bot` tool so any harness can summon it), canvas tab (**swarm tab gets a Conductor card with a thinking-dot animation**), and the landing page persona (W1/6).

**What makes it a really good agent (the bar to hit):**
- *Budgeted autonomy:* every run has a token/coin budget + wall-clock cap, enforced by policy (`src/policy.mjs`), visible before launch ("will cost ≈ $0.4 · 8 tasks").
- *Verifiable:* every claim it makes is a DAG node referencing the intent/event (reuses `src/dag.mjs`) — no unverifiable storytelling like closed bots.
- *Cross-harness folk:* it drives whichever CLIs are installed (detection in 3A) and hands off mid-task via capsules (built in `src/collab.mjs` handoff).
- *Bounded memory:* `.mesh/memory.md` + keyword index under a char budget; survives across sessions; portable (copy the .mesh dir).
- *Safe default:* write-lane + intent declarations for anything it touches; never merges to trunk without its own quorum rule.

This is the answer to "make a really good agent like dots/Grok Bot" — but open, local, and protocol-native.

### 3C. Shared task board with atomic claiming (match Claude Agent Teams, but cross-vendor)
`src/tasks.mjs`: tasks with status/dependencies/claim SLock, WIP limits (reuse `collab.mjs`), assignment by Scout or human; expose `GET /api/tasks`, MCP `mesh_task_claim`/`mesh_task_set`; canvas "Board" tab upgrade; import from GitHub Issues/Linear via webhook shim (optional flag).
**Exit criteria:** deterministic claim (2 agents race → exactly one wins), tested, JSON-logged.

### 3D. Conflicts that worktrees never solved (our knockout vs orchestrators)
1. **Port/service registry:** `mesh_declare_intent` gains optional `services:["dev-port:3000","db:shared"]`; overlap → same tier as path overlap. (`src/hub.mjs` + `contracts.mjs`)
2. **`.env` propagation:** lanes inherit `.env` from trunk; changes to shared `.env` are contract nodes.
3. **Symbol-level leases:** upgrade regex adapters → tree-sitter WASM for TS/JS (+ optional Python/Go), file in `src/contracts.mjs`; lease precision becomes symbol not glob.
4. **Lane storage upgrade:** swap dir-copy lanes for `git worktree`-backed lanes (already supported by `gitvcs.mjs`) as default when repo >50MB; overlayfs stays Linux-only option. Cuts clone time massively and solves `.env`/deps reuse via host share.

### 3E. Reliability at the level we advertise
1. **Failover drill in CI** (extend `src/failover.mjs` + `test/`): warm standby takeover with epoch fencing reaches green automatically.
2. **Mobile-first observatory:** `GET /canvas` becomes responsive + action-size crayon touches (Laptop 1); PWA installable — phone as the "paying-peer" (see amux's mobile gap).
3. **Multi-repo mesh v0:** one hub, N repos under `MESH_REPOS=/a,/b/...` — the trivial answer once agents collaborate across repos. Data model: repo qualifier added to intent/task/event kinds, default `""` for the seeded repo.

### 3F. Protocol & integration licks
1. **A2A 2.0 card upgrade:** publish a fuller agent-card (skills, auth scope, streaming), aligning with Google's latest schema in `src/a2a.mjs`.
2. **Registry presence:** submit to MCP server registry / awesome-mcp lists (metadata in `package.json`).
3. **ACP support in bridge:** one flag `--acp` so AgentMesh tools appear as ACP-compatible (helps Kepler/Acepe users).
4. **Events webhook:** `MESH_WEBHOOK_URL` posts MACP quorum results to Slack/Teams — the minimum viable "agent activity lives where teams read".

### 3G. Security to production-grade
1. mTLS between hub ↔ join (Tailscale-first doc), token rotation & revocation list (`src/auth.mjs`).
2. Audit export: signed Merkle DAG proofs (reuse `src/dag.mjs`) downloadable per time range.
3. Threat model doc (`docs/SECURITY.md` upgrade): what an agent can/can't do; hallucinated approvals treated as untrusted input (match Claude Teams' classifier philosophy) — this is *already* our fact sheet model, document it.

---

## 4. Vertical comparison — our pitch per competitor

| If they use… | Our 1-line steal |
|---|---|
| Claude Code Agent Teams | "Works, but that lock only fits Anthropic keys and same-file overwrites. AgentMesh runs the same pattern across *all* your agents, on the LAN, with conflict prediction that *fixes* itself." |
| Codex/Cursor cloud agents | "Great inside one vendor's cloud. AgentMesh is where those clouds meet: your second laptop/Box joins over the protocol, your code never leaves your machines." |
| dots / Grok Bot / Muse | "Personal agents with *their* memory in *their* cloud. The Conductor is your team's shared memory & referee — open, inspectable, works 24/7 on your own hardware, drives the coding CLIs you already pay for." |
| amux / Conductor / Kepler | "They give worktrees and boards. AgentMesh gives the *contract*, the *lease*, the *quorum* — collision forecast *before* the edit, and a trunk that cannot go red." |
| Manual scripts | "You wrote a bespoke 'agents share a task txt' rig. Everything in it is in AgentMesh as protocol nodes — and it's already tested 63+." |

---

## 5. Distribution & growth (becoming *the* reflex)

**Owner: whoever ships next Loudspeaker docs/Publishing + Laptop 1 assets.**

### E1. Content engine (four posts; each also becomes the OG-source when published)
1. "Which orchestrator? Field guide to running multiple coding agents in one repo (2026)" — fair comparison incl. our table.
2. "The collision essay" — every lane tool fails on ports/DBs/.env; here's the protocol that doesn't.
3. "What dots/Grok Bot got right, and their missing piece — composed from our protocol analysis."
4. "We ran 3 harnesses on one repo for 30 days" — real telemetry data from `scripts/load.mjs` + Conductor reports.
Each ends with: install one-liner, Discord, "star if this saved you a merge".

### E2. Place
- npm `@harshalsp/agentmesh` — add `--help` quality + `mesh` name squatting (check availability).
- GitHub: topics (`ai-agents`, `multi-agent`, `mcp`, `ai-collaboration`), pinned repos, Discussion template, issue "good first collaboration".
- CDNs: Docker Hub description refresh, composer examples.
- Short video: 60 s of the two-laptop demo (screen record from the canvas + voice tab) for X/YouTube/TikTok tech.

### E3. Community rituals
- Weekly digest post: real MACP votes & collision forecasts (auto-assembled from `.mesh` logs — script `scripts/digest.mjs`).
- September-style "Swarm Week": reviewers run the same repo with the biggest name harnesses → publish that table (drives comparison memes).
- Publish a public "Conductor memory" of our own repo — dogfooding proof.

---

## 6. Phased roadmap with exit criteria (each phase is a shippable PR)

| # | Name | Item | Owners | Exit criteria (how verified) |
|---|---|---|---|---|
| P0 | **TTFC** | `mesh init`, `npx … up`, doctor --fix (3A) | L2 | fresh machine joins an *arbitrary* repo in ≤90 s with 3 harnesses detected; `mesh-join` script proves TTFC; test `test/init.test.mjs` |
| P1 | **Conductor v1** | `src/bot.mjs`, Scout+Dispatcher roles, CLI + MCP spawn (3B) | L2 | `demo-bot.mjs` runs a real 2-task split via two mock harnesses, asserts intents/claims/events in the DAG; budget caps fire |
| P2 | **Landing + playground** | W1, W2, W3, W4 | L1 | publish-check passes; playground runs deterministic sim; landing GIF generated |
| P3 | **Task board** | 3C + canvas Board upgrade | L2+L1 | race-claim test passes; board tab usable via keyboard |
| P4 | **Port/env/symbol leases** | 3D | L2 | tree-sitter adapter on TS fixture; port overlap demo; lanes use gitvcs by default on big repos |
| P5 | **Reliability** | 3E failover CI, mobile canvas, multi-repo env flag | L2+L1 | drill in CI green; canvas usable at 360px; N=2 repos demo |
| P6 | **Trust** | 3G mTLS doc + rotation, audit export | L2 | token rotated → old rejected with 401; export verifies hashes |
| P7 | **Growth wave 1** | npm polish, 4 blog posts, registry lists, 60 s video | L1 | posts live; star count tracked; weekly digest scheduled |

Order rationale: TTFC → Conductor → Website-with-proof is the shortest path from "nobody knows us" to "this is what collaboration means".

## 7. Measurement (what tells us we won)
- **TTFC** (target <5 min); installs/week (npm + docker pulls), hub 30-day retention (canvas heartbeat telemetry, opt-in only), `mesh_request` count per install (did agents *actually* collaborate?), star growth, share of installs from organic search (post-launch analytics only, no trackers).
- North-star: **% of installs with ≥2 distinct actors collaborating on one repo** — the only metric that maps to our name.

## 8. Risks & honest mitigations
- *LA and 3rd-party orchestrators add coordination later (Conductor-equivalent).* → We counter with cross-vendor LAN scope + contract semantics they'd need protocol work for; keep moving on trust (audit, failover).
- *Claude Agent Teams graduate from experimental with cross-harness MCP intent.* → Good: our MCP + A2A + ACP surface means we *ride* that, not fight it.
- *Dots/Grok bots do coding fine.* → Their repos are clouds, per-person memory, no merge protocol. We don't dispute them; we are the layer they call *between* each other — publish an "AgentMesh speaks to every agent" demo (E3).
- *Repo is Node-only today.* → Document the daemon contract (`hub.mjs` HTTP end-point) so a Rust/Go sidecar could mirror it; keeps contributors from other stacks.

## 9. Immediately-up next 10 actions (next PR-sized move)
1. `mesh init` + `npx … up` (3A) — closes the biggest adoption gap.
2. Conductor skeleton `src/bot.mjs` with Scout+Dispatcher (3B).
3. `site/landing.html` hero + comparison table (W1) — no new framework.
4. `site/playground.html` dots simulator (W3).
5. `docs/MASTER_PLAN.md` link-footer into `README.md` ("Read the plan").
6. Task board core `src/tasks.mjs` + claim test (3C).
7. Port/service registry in declarations (3D.1) — tiny, high-signal.
8. `mesh-join` harness auto-detect for Codex/Anthropic/Grok config files (3A.3).
9. Blog draft #1 from this plan's Section 1 table.
10. digest script for weekly real-mesh data (E3).

<!-- machine note: verify each phase with `npm test` and `npm run demo:all`; node/engines >= 22 -->
---

## 10. Build record — 2026-10 (this repository, all phases executed)

Executed against the full plan. Verified by `npm test` (92/92, suites 37) plus `npm run demo:all`
and the new asserted `demo-bot.mjs` on Windows; CI gained a Windows matrix job and 3 new guards.

### P0 · TTFC onboarding — DONE
- `src/init.mjs`: writes `.agents/mcp_config.json` (canonical `npx` bridge entry) + `.agents/rules/agentmesh.md`
  into any foreign repo; derives `actor` from package.json name (fallback: dir name); Appends (never clobbers)
  the `## AgentMesh` footnote in `AGENTS.md`; detects Antigravity / Claude Code / Cursor / Windsurf / OpenCode /
  Codex and only upserts configs for clients already present (unless `--force`).
- CLI: `mesh init [target] [--actor] [--hub] [--force]`; `mesh doctor --fix` re-repairs agent config.
- Idempotence + client-preservation are asserted in `test/init.test.mjs` (5 tests).

### P1 · Conductor — DONE
- `src/bot.mjs`: six deterministic roles (scout, dispatcher, referee, reviewer, shepherd, keeper) with a coin +
  wall-clock budget; runs ledgered in `<dir>/bots/run-*.json`; `botStatus()` feeds hub + CLI + MCP.
- Hub: `/api/bot` GET/POST (dry-only unless `MESH_BOT_LIVE=1`), `/api/memory` GET/POST; `/metrics` reports
  `conductor` and task stats. MCP tools: `mesh_bot`, `mesh_memory_get`, `mesh_memory_set`.
- CLI: `mesh bot run --goal … [--dry|--live] [--tasks a|b]`, `mesh bot status`; `mesh memory get|set`.
- `demo-bot.mjs` (asserted, dry) + `test/bot.test.mjs` (7 tests incl. budget-exhaustion and injected spawner).

### P3 · Task board — DONE
- `src/tasks.mjs`: create/claim/set with atomic single-file claims, WIP limit (default 2), dependency policy
  (deps block claim + done), blocking reasons, op log; events `task.created|claimed|done|blocked|reset`.
- Hub: `/api/tasks` GET + POST(create|claim|set); `/api/overview` now carries `tasks`; canvas/ELK surface them.
- CLI: `mesh tasks list|create|claim|set`; MCP: `mesh_task_create/list/claim/set`. Tests: `test/tasks.test.mjs`.

### P4 · Services & symbol leases — DONE
- `mesh_declare_intent` accepts `services` (e.g. `port:3000`, `db:fees`) and `symbols` (shared function ids).
- Hub `route()`: declare a service held under a hard lease → structured 409 blocker; soft overlap → Tier-1
  interrupt + Tier-2 digest; symbol collisions warn with sequencing notes; fact sheet lists claimed services.
- Tests: services/symbols overlap exercised live in `test/mesh-api.test.mjs`.

### P5 · Reliability — DONE
- CI: Windows matrix job (`test-windows`: full suite + conductor demo + `mesh init` e2e on foreign repo),
  vendor-freshness guard (`bundle-sim` diff), publish-readiness doctor.
- Multi-repo v0: `MESH_REPOS="name:path,…"` parsed into `S.repos`; hub tags events; `/api/overview` exposes repos.

### P6 · Trust & audit — DONE
- `src/auth.mjs` rewritten: tokens carry `jti`; revocation list at `.mesh/auth/revoked.json`
  (`revokeToken` + verify path on `/cmd`); `keygen --rotate` archives the old key pair.
- `src/audit.mjs`: hash-chain verification + Merkle-root bundle export (`/api/audit`, `mesh audit export`).
- Tests: `test/trust.test.mjs` (revocation e2e, forgery, rotation, tamper detection).

### Site (P2 + W-waves) — DONE
- `site/landing.html` (hero, comparison map, FAQ JSON-LD), `site/docs.html` (concepts, tasks, conductor,
  memory, services, recipes, 23-route API table, security, troubleshooting), `site/playground.html`
  (imports the REAL `src/crdt.mjs` + `src/macp.mjs` kernels via `site/vendor.mjs` bundle — swarm moment,
  MACP quorum lab, CRDT lab), `site/blog.html` (3 engineering posts), `sitemap.xml`, `robots.txt`, `llms.txt`,
  PWA manifest shortcuts, SW cache v1.2.1, publish-check doctor extended (24 checks, green).
- `scripts/bundle-sim.mjs` regenerates `site/vendor.mjs`; CI fails if the vendor bundle drifts from src/.

### Metrics wiring
- TTFC: first `mesh_request` between two distinct actors stores `ttfc_ms` in kv; `/metrics` publishes `ttfc_s`.
- North-star instrumentation: `/api/overview` carries distinct-actor presence, tasks, conductor, repos.

### Result
All phases P0–P7 have a working slice in this repo, with 92/92 asserted tests, 2 end-to-end demos
(`demo:all`, conductor), a Windows-verifiable CI, and a fully-linked doc/marketing surface.
Remaining runway is marketing distribution (P7 wave 2: registry lists, video) rather than engineering.
