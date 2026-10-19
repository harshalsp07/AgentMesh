# AgentMesh — Production Multi-Harness AI Agent Coordination Mesh

[![Tests](https://img.shields.io/badge/tests-92%20passed-success?style=flat-square&logo=node.js)](https://github.com/harshalsp07/AgentMesh/actions)
[![Docker Image](https://img.shields.io/badge/docker-harshalsp07%2Fagentmesh-blue?style=flat-square&logo=docker)](https://hub.docker.com/r/harshalsp07/agentmesh)
[![Live Demo](https://img.shields.io/badge/live_observatory-github_pages-brightgreen?style=flat-square&logo=github)](https://harshalsp07.github.io/AgentMesh/)
[![MCP Ready](https://img.shields.io/badge/MCP-JSON--RPC%202.0-8a2be2?style=flat-square)](https://modelcontextprotocol.io/)
[![Google A2A](https://img.shields.io/badge/Google%20A2A-1.0.0-blue?style=flat-square)](https://a2a-protocol.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)

> 🗺️ **Where we're going:** [docs/MASTER_PLAN.md](docs/MASTER_PLAN.md) — the plan to make AgentMesh the default answer for AI-agent collaboration (landing site, the Conductor agent, task board, TTFC onboarding, comparison market map).

**AgentMesh** enables multiple independent AI coding harnesses—such as **Google Antigravity** on Laptop 1 and **OpenAI Codex / Cursor / Claude Code** on Laptop 2—to safely collaborate on the **exact same repository in real time** without overwriting each other's work or breaking API contracts.

---

## ✅ What's shipped (v1.2)

| Phase | Feature | Entry points |
|---|---|---|
| P0 · TTFC | `mesh init <any-repo>` — agent config + rules in seconds, idempotent, never clobbers existing client configs | `bin/mesh init`, `mesh doctor --fix` |
| P1 · Conductor | Budgeted coordination agent with 6 roles (scout/dispatcher/referee/reviewer/shepherd/keeper); dry by default, live CLI ops-gated | `bin/mesh bot run --goal "…"`, `mesh_bot` MCP tool, `demo-bot.mjs` |
| P3 · Task board | Atomic claims, WIP limits (default 2), dependency chains; `task.*` events stream everywhere | `bin/mesh tasks …`, `/api/tasks`, `mesh_task_*` tools |
| P4 · Services & symbols | Port/service + shared-symbol leases in the intent engine: same-service re-declares block or warn with a real plan | `mesh_declare_intent(services, symbols)` |
| P5 · Fleet ops | Multi-repo tagging (`MESH_REPOS`), reliability CI incl. Windows matrix | `.github/workflows/ci.yml` |
| P6 · Trust & audit | Ed25519 tokens with instant revocation + rotation; Merkle-verified audit bundle export | `bin/mesh audit export`, `/api/audit` |
| Site | `landing.html`, `docs.html`, `playground.html` (real kernels in-browser), `blog.html`, `sitemap.xml`, `robots.txt`, `llms.txt`, PWA cache | `site/*` |

---

## 🌟 The Problem: Why Multi-Agent Coding Breaks Down

When developers run independent AI agents on the same codebase across multiple machines:
1. **Silent Overwrites & Race Conditions**: Agent A refactors frontend code while Agent B modifies backend endpoints, unknowingly breaking assumptions.
2. **Context Blindness**: Neither agent knows what the other is doing until `git push` fails with merge conflicts.
3. **No Consensus Protocol**: Breaking changes land on trunk without automated quorum or peer agent verification.

**AgentMesh solves this at the protocol layer.** Instead of acting as an artificial chatbot harness, AgentMesh is an **event-sourced coordination daemon** providing:
- **Intent-Before-Edit**: Agents declare target file scopes before modifying code, receiving sub-50ms collision alerts.
- **Copy-on-Write Lanes (MeshVCS)**: Agents work in isolated virtual lanes above Git; instant undo and rewind without rewriting history.
- **MACP 5-Mode Consensus Kernel**: RFC-grade decision, proposal negotiation, and quorum voting before landing shared schema updates.
- **Delta-State Semantic CRDT**: Strong Eventual Consistency (SEC) across AST symbols and contracts via Lamport vector clocks.
- **Universal Model Context Protocol (MCP)**: Native stdio JSON-RPC 2.0 bridge supported out-of-the-box by Antigravity, Cursor, Claude Code, and Windsurf.

---

## 🏗 System Architecture

```mermaid
flowchart TB
    subgraph Machine1 ["Laptop 1 (Frontend / UI Agent)"]
        AGY["Google Antigravity IDE / Desktop App\n(Native Agent with File/Terminal/Browser Tools)"]
        AGY_MCP["AgentMesh MCP Bridge\nMESH_ACTOR=antigravity-ui"]
        AGY_Lane["MeshVCS Lane:\nlane/antigravity-ui"]
        AGY --> AGY_MCP
        AGY --> AGY_Lane
    end

    subgraph HubNetwork ["AgentMesh Coordination Layer (:7777)"]
        Hub["AgentMesh Core Daemon (src/hub.mjs)\n- Intent & Soft/Hard Leases Engine\n- Inter-Agent Mailbox & Approvals\n- MACP 5-Mode Quorum Kernel\n- Delta-State Semantic CRDT\n- AST Contract Graph & Drift Detector\n- Integration Queue & CAS Trunk Gating"]
        P2P["P2P WebRTC Signaling Mailbox"]
        Hub <--> P2P
    end

    subgraph Machine2 ["Laptop 2 (Backend Agent)"]
        Codex["OpenAI Codex / Cursor / Claude Code\n(Native Agent with File/Terminal Tools)"]
        Codex_MCP["AgentMesh MCP Bridge\nMESH_ACTOR=codex-backend"]
        Codex_Lane["MeshVCS Lane:\nlane/codex-backend"]
        Codex --> Codex_MCP
        Codex --> Codex_Lane
    end

    subgraph Storage ["Shared Codebase & State"]
        GitRemote[("Shared Git Repository\n(GitHub / LAN Remote)")]
        SQLite[("SQLite WAL Event Store\n(Durable Event Log)")]
    end

    AGY_MCP <-->|JSON-RPC via HTTP/SSE| Hub
    Codex_MCP <-->|JSON-RPC via LAN / Tailscale| Hub
    Hub --> SQLite
    AGY_Lane <--> GitRemote
    Codex_Lane <--> GitRemote
```

---

## ⚡ Quickstart: Connect 2 Laptops in Under 2 Minutes

### Step 0: Install the mesh into ANY existing repo (TTFC)
Any repo, any laptop, one command — writes `.agents/mcp_config.json` + rules, detects the
IDEs you already use, and never clobbers their configs:
```bash
npx @harshalsp/agentmesh init          # or: node bin/mesh init <repo-path>
# → actor derived from package name, connectivity via `mesh doctor`, join via `mesh-join`
```

### Step 1: Start Hub on Laptop 1 (Host)
On Laptop 1, clone the repository and start the Hub daemon on all network interfaces:
```bash
git clone https://github.com/harshalsp07/AgentMesh.git
cd AgentMesh
npm test               # Verify 92 tests pass

# Start Hub listening for LAN connections
MESH_HOST=0.0.0.0 node src/hub.mjs
```
*Note your Laptop 1 LAN IP address (e.g. `192.168.1.50`).*

### Step 2: Configure Google Antigravity on Laptop 1
Google Antigravity automatically detects [`.agents/mcp_config.json`](.agents/mcp_config.json) located in this workspace:
```json
{
  "mcpServers": {
    "agentmesh": {
      "command": "node",
      "args": ["src/bridge.mjs"],
      "env": {
        "MESH_ACTOR": "antigravity-ui",
        "MESH_HUB": "http://localhost:7777"
      }
    }
  }
}
```
Antigravity automatically reads [`.agents/rules/agentmesh.md`](.agents/rules/agentmesh.md) and [`AGENTS.md`](AGENTS.md) and begins coordinating as `antigravity-ui`.

### Step 3: Connect Laptop 2 (Codex / Cursor / Claude Code)
On Laptop 2, clone the repository and execute the zero-config join script:
```bash
git clone https://github.com/harshalsp07/AgentMesh.git
cd AgentMesh

# Automatically test connection and configure .cursor/mcp.json
./bin/mesh-join http://<LAPTOP_1_IP>:7777
# Example: ./bin/mesh-join http://192.168.1.50:7777
```

**That's it!** Both agents are now linked into the mesh. Open **`http://<LAPTOP_1_IP>:7777`** in any browser to observe the live topology canvas.

---

## 🔄 Multi-Agent Lifecycle & Cross-Harness Workflow

```mermaid
sequenceDiagram
    autonumber
    actor Dev1 as Laptop 1 (Antigravity UI)
    participant Hub as AgentMesh Hub (:7777)
    actor Dev2 as Laptop 2 (Codex Backend)

    Note over Dev1,Hub: Intent Declaration & Lease Acquisition
    Dev1->>Hub: mesh_declare_intent(goal: "Redesign navbar", paths: ["site/**"])
    Hub-->>Dev1: Lease Granted (Active Lock)

    Note over Dev2,Hub: Collision Interception
    Dev2->>Hub: mesh_declare_intent(goal: "Patch UI bug", paths: ["site/app.js"])
    Hub-->>Dev2: OVERLAP Alert! Lease held by @antigravity-ui

    Note over Dev1,Dev2: Cross-Agent Delegation (mesh_request)
    Dev1->>Hub: mesh_request(to: "codex-backend", text: "Expose GET /api/nodes")
    Hub-->>Dev2: Delivered to Codex MCP inbox via <mesh-delta>
    Dev2->>Hub: request-respond(id: "...", accept: true) -> Mint Child Intent

    Note over Dev1,Dev2: 2-Agent MACP Quorum Voting
    Dev2->>Hub: macp_propose(title: "Adopt Contract v3 Schema", minQuorum: 2)
    Dev2->>Hub: mesh_vote(sessionId: "...", vote: "yes")
    Dev1->>Hub: mesh_vote(sessionId: "...", vote: "yes")
    Hub->>Hub: Quorum Concluded -> CAS Merge to Trunk
```

---

## 🛠 Model Context Protocol (MCP) Tools

Every connected agent receives these tools natively inside their IDE chat context:

| Tool Name | Parameters | Description |
|---|---|---|
| `mesh_declare_intent` | `goal`, `paths`, `effect`, `contracts`, `services`, `symbols` | Declare intended file mutations **before** writing code. Returns collision and breaking-change warnings; `services` (e.g. `port:3000`) create real soft/hard leases, `symbols` flag shared function ids. |
| `mesh_release` | `id` | Free a declared intent and release file locks once changes are committed or abandoned. |
| `mesh_status` | *(none)* | Inspect your current factsheet: active scopes, contracts used, and active neighbors. |
| `mesh_inbox` | *(none)* | Drain unread peer notifications, contract updates, and inter-agent requests. |
| `mesh_request` | `to`, `text`, `ref` | Delegate a task or schema requirement to a peer agent across laptops (e.g., `@codex-backend`). First request between two actors seeds the TTFC metric. |
| `mesh_task_create` | `title`, `paths`, `deps`, `note` | Create a task on the shared board — event-sourced, canvas-visible. |
| `mesh_task_list` | `status?`, `owner?` | Read the board (supports `pending`, `in-progress`, `blocked`, `done` filters). |
| `mesh_task_claim` | `id` | **Atomic** claim: first actor wins, the loser gets a 409-style blocker (never a double-assign). |
| `mesh_task_set` | `id`, `status`, `note?` | Move a task you own (`done` requires deps done; `pending` releases the claim). |
| `mesh_bot` | `goal`, `dry?`, `tasks?` | Run the **Conductor** (dry default): scout → dispatcher → referee → report under a coin budget. |
| `mesh_memory_get` / `mesh_memory_set` | `key?` / `text` | Repo memory kept by the Conductor's keeper role — plain markdown at `<mesh>/memory.md`. |
| `mesh_vote` | `id`, `vote`, `weight`, `rationale` | Cast a binding vote in an active MACP decision or quorum session before trunk integration. |
| `mesh_propose_contract` | `title`, `mode`, `participants`, `spec` | Open an RFC-grade bounded coordination session for architectural updates. |
| `mesh_crdt_set` | `key`, `value` | Mutate a shared AST symbol, config key, or contract node in the Delta-State CRDT. |
| `mesh_roster` | *(none)* | View all active agents, their assigned lanes, and current heartbeats. |
| `mesh_pin` | `node`, `text` | Drop an AST spatial pin on a file or contract to alert only the relevant scope owners. |
| `mesh_board_post` | `text`, `color`, `codeRef` | Post a sticky note to the shared visual whiteboard linked to specific code references. |

---

## 🧱 The Five Architectural Pillars

### 1. Intent Before Edit & AST Leases
Agents declare what they are about to touch before touching it. AgentMesh analyzes path globs and AST contracts to compute overlaps in real time. If another agent holds an active lease, a non-blocking `OVERLAP` warning or hard-lease `409` barrier prevents write collisions.

### 2. Copy-on-Write Virtual Lanes (MeshVCS)
Agents operate in isolated virtual lanes (`lane/antigravity-ui`, `lane/codex-backend`) layered above Git. Changes are snapshotted immutably:
```bash
node bin/mesh undo <actor>           # Instant undo without losing uncommitted writes
node bin/mesh rewind <actor> 10m     # Scoped time-travel rollback for a single actor
node bin/mesh revert-intent <actor> <id> # Revert a specific task's changes
```

### 3. MACP 5-Mode Kernel
Multi-Agent Coordination Protocol provides bounded, stateful coordination sessions:
- **Decision Mode**: Weighted voting with binding resolution and quorum thresholds.
- **Proposal Mode**: 3-round negotiation ladder (Scope Partitioning → Temporal Sequencing → Human Arbitration).
- **Quorum Mode**: Strict consensus gate for trunk integration and database schema migrations.
- **Task & Handoff Modes**: Formal work delegation and state transfer between agents.

### 4. Delta-State Semantic CRDT & AST Contracts
Guarantees **Strong Eventual Consistency (SEC)** across causal vector clocks:
- Commutative Last-Write-Wins (LWW) with Lamport timestamps and actor tie-breaking.
- Delta synchronization: only the minimal changed state vector is transmitted over the wire.
- AST symbol tracking: changes to function signatures or route declarations propagate across lanes instantly.

### 5. Harness-Gated Trunk Integration
Nothing merges to `main` until the verification harness verifies the exact `base_hash + change_hash`:
- **T0**: Fast syntax, security secret scanning, and boundary policy check (<150ms).
- **T1**: Unit test suite verification (`npm test`).
- **T2**: Integration and cross-lane contract verification.

---

## 💻 CLI Reference

AgentMesh provides a unified CLI entrypoint via `bin/mesh`:

```bash
# One-command onboarding (any repo, any laptop)
node bin/mesh init [target-repo]        # Writes .agents config + rules; actor auto-derived
node bin/mesh doctor [--fix]            # Diagnose; --fix re-writes agent config + rules

# Inspection & Health
node bin/mesh status                   # Inspect Hub health, driver, and trunk head
node bin/mesh overview                 # Print full ASCII topology, roster, and active collisions

# Virtual Lanes (MeshVCS)
node bin/mesh lane <actor>             # Create an isolated copy-on-write actor lane
node bin/mesh snapshot <actor> [tag]   # Record an immutable snapshot of an actor lane
node bin/mesh diff <actor>             # Diff lane working tree against trunk head
node bin/mesh undo <actor>             # Undo actor's latest turn
node bin/mesh rewind <actor> --minutes 15 # Rewind actor lane by N minutes

# Task board + Conductor + memory (P1/P3)
node bin/mesh tasks create "Ship checkout" --paths site/**,src/** --deps task-1
node bin/mesh tasks claim task-1 --actor codex-backend      # atomic; WIP limit 2
node bin/mesh tasks set task-1 done
node bin/mesh bot run --goal "Ship the fee API" --dry       # Conductor dry run
node bin/mesh bot status                                    # runs + budget + board stats
node bin/mesh memory set "fees are integers, never floats"
node bin/mesh memory get fees

# Ops & trust
node bin/mesh audit export --out audit-day-41.json          # hash-chained, Merkle-rooted
node bin/mesh-join <hub-url>           # Join a remote Hub and configure local MCP in 1 command
```

---

## 🌐 Multi-Platform Deployment & Observatory

AgentMesh can be operated in production across any hosting environment:

| Platform | Configuration | Command / Purpose |
|---|---|---|
| **Docker Hub** | `Dockerfile` & `compose.yml` | `docker run -d -p 7777:7777 harshalsp07/agentmesh:latest` |
| **GitHub Pages** | `.github/workflows/pages.yml` | Static observatory & simulator deployment |
| **Vercel** | `vercel.json` | Serverless edge deployment of web canvas |
| **Netlify** | `netlify.toml` | Multi-region static asset distribution |
| **Cloudflare Pages** | `wrangler.toml` & `_worker.js` | Cloudflare edge worker deployment |
| **Railway / Render** | `railway.json` & `render.yaml` | 1-click cloud daemon deployment |

---

## 📜 Testing & Quality Assurance

AgentMesh maintains an extensive automated test suite covering all subsystems:
```bash
npm test
```
```
✓ collab = owner approval gates strangers; child intents track
✓ contracts = extracts routes, ghosts breaking changes, gates deletion
✓ policy = deny/approval/egress/landing/protected rules
✓ bus+graph = breaking contract change interrupts consumers
✓ intent validation = rejects missing goals/paths with 400
✓ drift + overlap routing = consumer gets tier-1 BREAKING on next pull
✓ hard-lease boundary = refuses overlapping write with 409
✓ log integrity = /verify passes with SQLite WAL backing
✓ VectorClock + Causal Ordering = monotonic Lamport causal relations
✓ SemanticDocument SEC = mathematically converges across concurrent deltas
✓ harness = T0 blocks secrets and syntax, binds base+head
✓ queue = CAS advances trunk head once checks pass
✓ MeshVCS = immutable snapshots, scoped undo, rewind, eject
✓ MACP 5-Mode Kernel = decision, proposal ladder, quorum threshold
✓ Epistemic Merkle DAG = content-addressed nodes, Merkle root sync
✓ A2A Standard Protocol Gateway = agent-card.json and agent.sync RPC
✓ Multi-Harness Coordination = Laptop 1 (Antigravity) <-> Laptop 2 (Codex)
✓ TTFC onboarding = mesh init into foreign repos, idempotent, client-preserving
✓ Conductor bot = scout/dispatch/referee/keeper under coin budget, dry by default
✓ Task board = atomic claims, WIP limits, dependency chains over HTTP + MCP
✓ Trust layer = token revocation (jti), key rotation, Merkle audit export
   tests 92 | suites 37 | pass 92 | fail 0

---

## 📄 License

MIT © [Harshal](https://github.com/harshalsp07)
