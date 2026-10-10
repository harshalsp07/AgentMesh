# AgentMesh — Complete Design Plan

Oct 10, 2026 · @Harshal

## Vision and scope

AgentMesh makes one repository behave like one shared system: a single small Linux VM holds the code, the dependencies and the running services, and every human and agent works in an isolated lane of it. Nothing reaches trunk until a verification harness approves the exact change.

**What a developer experiences**

- **Install:** one VS Code-family extension, or one MCP entry, or `mesh run -- codex`. The Hub VM boots, the repo is imported, dependencies are installed once for everyone.
- **Work:** your agent edits in its own lane. Within a second, teammates' agents know its declared intent and code against the proposed contract, not the stale one.
- **See:** a live canvas shows who (human or agent) is touching which module, contract or schema, and warns about predicted collisions before code is written.
- **Recover:** every action is a reversible operation. `mesh undo`, `mesh rewind 10m` or `mesh revert-intent 14` restores a known-good state without rewriting git history.

**Six decisions that shape the whole design**

1. **One Hub, many lanes.** One authoritative workspace in a micro-VM; each actor gets a copy-on-write lane instead of a private clone or a shared live folder.
2. **MeshVCS on top of git.** An append-only operation log, continuous snapshots and stable change IDs sit above git objects. Git stays the export format, so there is no lock-in.
3. **Intent before edit.** Agents declare scope first; leases and a symbol-level graph predict conflicts while there is still nothing to merge.
4. **Contracts are first-class.** APIs, schemas and types are tracked as nodes with owners and consumers; proposed changes propagate immediately, before the code lands.
5. **The harness gates trunk.** Tiered checks run on the exact base-plus-change hash, so trunk stays green.
6. **Enforce at the boundary, not in the prompt.** Shell shims, overlay filesystems and VM limits stop damage even when an agent ignores its instructions.

**Out of scope, deliberately**

- Replacing Git or GitHub. Trunk mirrors to a normal git branch and you push as usual.
- Being an agent framework. AgentMesh coordinates the agents you already use.
- Keystroke-level CRDT for source code. Agents write in bursts, so intents, leases and verified merges fit better than character merging.
- Being a cloud IDE. The Hub can run on a teammate's laptop, a LAN box or a cloud relay.

## Principles and invariants

Nine invariants are never allowed to break, even when the daemon crashes or an agent misbehaves. Every later section is checked against them.

1. **No lost writes.** Anything an actor wrote is snapshotted before it can be overwritten or deleted, so it is always recoverable.
2. **Trunk is green or labelled.** Trunk only advances after the harness passed on the exact base hash plus change hash; otherwise it is marked `unverified` and cannot be pushed.
3. **One writer to trunk.** Only the integration queue lands changes, using a compare-and-swap on the trunk head.
4. **Everything is an operation.** Every mutation is an entry in an append-only, hash-chained log and is reversible. Purging is a separate, explicit, human-only act.
5. **Agents are untrusted by default.** Limits are enforced by the filesystem, shell shims and network policy, never by asking nicely in a prompt.
6. **Humans always win.** A human edit pre-empts an agent lease, and the mesh never blocks the IDE for more than a moment.
7. **State, not history, goes into agent context.** Agents receive a small, current, derived fact sheet under a fixed token budget, not a chat log.
8. **Degrade to plain git.** With the daemon dead, agents keep working, nothing is lost, and the repo is still an ordinary git repo.
9. **No lock-in.** Uninstalling leaves the repo, its history and its branches intact.

**Working principles**

- Deterministic beats probabilistic: use a type check or a lease before asking a model to judge.
- Cheap to undo beats hard to prevent: allow work, snapshot it, and make reversal one command.
- Ambient beats interruptive: most information goes to the canvas, and only blocking or breaking events reach an agent mid-task.
- Contracts beat chat: a machine-readable fact outranks a sentence in a channel.
- Progressive enhancement: the mesh works at every level of agent cooperation (see the compliance ladder under Integrations).

## Mesh Core daemon

The core is a single-writer, event-sourced state machine: every command becomes an event, state is the fold of the event log, and every screen or context file is a projection of that state. This one choice gives replay for debugging, deterministic simulation for testing, and cheap replication for failover.

The daemon runs inside the Hub VM, handles commands one at a time (ample for 3 to 10 actors), stamps each event with a hybrid logical clock so wall-clock skew never matters, and carries an epoch number that fences out a stale Hub after failover.

| Component | Responsibility | Key rule |
| --- | --- | --- |
| Event log | Append-only, hash-chained record of every command and outcome (SQLite WAL) | Never edited; compacted only by snapshotting |
| Presence tracker | Who is online, what they focus on, doing what (reading, editing, testing) | Heartbeat every 2 s; silent for 15 s means away |
| Intent registry | Declared goals with scope, expected contract effect and status | Inferred automatically if an agent never declares one |
| Lease manager | Soft and hard claims on paths, symbols, contract nodes and resources | TTL plus heartbeat; hard leases are rare and ordered |
| Contract registry | Extracted APIs, schemas and types with owner, version hash and known consumers | Proposed changes propagate before code lands |
| Lane manager | Creates, snapshots, rebases and destroys per-actor overlays | One lane per actor; attribution by construction |
| Integration queue | Verifies and lands changesets on trunk, in order, with speculative batching | Compare-and-swap on trunk head |
| Harness runner | Executes tiered checks and returns structured verdicts | Verdict is bound to base hash plus change hash |
| Policy engine | Evaluates `.mesh/policy.yaml` (protected paths, blast radius, commands, egress) | Enforced at the boundary, not in prompts |
| Relevance router | Decides who is told what, and at which urgency tier | Graph distance, lease overlap, subscription, severity |
| Context compiler | Renders each agent's bounded fact sheet (`active_context.md` and the MCP resource) | Current state only, under a token budget |
| Git bridge | Mirrors trunk to a real git branch and imports external pushes | One commit per landed changeset, with trailers |
| Gateways | MCP (stdio and HTTP), WebSocket for the extension and canvas, CLI socket | One protocol underneath, many adapters on top |

**Command path, in order:** authenticate the actor, check policy, append the event, update state, project views, route notifications. If any step fails, the event is rejected and the actor receives a structured reason it can act on.

**Failover:** the log streams to one warm standby (any teammate's machine). On Hub loss the standby increments the epoch and takes over; any write stamped with the old epoch is refused. With at most five peers a leader-plus-standby model is simpler and safer than full consensus.

## Shared micro-VM sandbox

The Hub is one small Linux VM that is the only place code is built, tested and run, so "works on my machine" stops being possible. The design target is an image under 150 MB compressed and about 1 to 2 GB of RAM at idle; these are goals to validate, not measurements.

**How people and agents attach**

- **Attached mode (default for sprints):** editors open the Hub folder remotely and CLI agents (Claude Code, Codex, Aider) run inside the VM through `mesh run`. There is one toolchain, one dependency tree and one running dev server.
- **Mirrored mode (flaky Wi-Fi, heavy local tools):** each machine keeps a local mirror of its own lane, synced both ways by the daemon, while builds and tests still run in the Hub. Edits feel local at the cost of a 1 to 2 second sync delay.
- Remote attachment works differently in VS Code, Cursor and Windsurf, so the extension hides it behind one "Attach to Hub" command, with mirrored mode as the fallback.

**Filesystem layers**

| Layer | Contents | Who can change it | Shared by |
| --- | --- | --- | --- |
| L0 base image | OS, git, language runtimes pinned with mise or Nix | Image rebuild only | Everyone, read-only |
| L1 dependency layer | `node_modules`, venv, cargo and go caches, keyed by lockfile hash | Dependency steward, by atomic swap | Every lane, read-only |
| L2 trunk checkout | Source at the trunk head | Integration queue only | Every lane, read-only |
| L3 lane overlay | One actor's writes (overlayfs upper directory; git worktree plus reflinks as fallback) | That actor, snapshotted every turn | One actor |
| L4 ephemeral | Build output, temp files, logs | That actor | Discarded with the lane |

**Dependencies: the dependency steward.** Agents never mutate L1. Inside the VM, `npm`, `pnpm`, `pip`, `uv`, `cargo` and `go` are shims. `npm install zod` becomes `mesh dep add zod`, which takes a hard lease on the manifest and lockfile, resolves in a scratch directory, builds a new L1 layer keyed by the new lockfile hash, runs the fast checks, broadcasts `dep.added`, and swaps the layer in at each lane's next safe point. The requesting lane gets an additive overlay immediately. The result is one lockfile, no lockfile merge conflicts, and no five parallel installs.

**Services and ports**

- A trunk preview (always green) runs on a stable port; each lane can start a lane preview on a Hub-allocated port.
- Databases: one trunk database plus per-lane clones (SQLite file copy, or a Postgres template database for fast cloning).
- Migrations are hard-leased and numbered by the Hub, so two agents never both create `0007_*`.

**Resource isolation:** cgroups v2 per lane (CPU shares, memory cap, process limit, disk quota) and a fair queue for harness jobs, so one agent running the full suite cannot starve four others.

**Runtime drivers**

| Driver | Runs on | Boot target | Isolation | Use when |
| --- | --- | --- | --- | --- |
| Lite | Any OS | about 2 s | Git worktrees plus daemon, no VM | Demos, trusted team, small repos |
| Container | Docker, Podman, devcontainer | about 10 s warm | Namespaces and cgroups | Default |
| Lima or WSL2 | macOS, Windows | about 15 to 25 s | Real Linux kernel | Containers blocked, or kernel features needed |
| Firecracker or Cloud Hypervisor | Linux with KVM, cloud relay | Under 1 s from snapshot (vendors cite roughly 125 ms boot; approximate) | Hardware virtualization | Hardened mode, untrusted agents, hosted rooms |

**VM-level snapshots:** before risky operations (migration, major dependency bump, mass refactor) the driver takes a whole-VM snapshot. File snapshots restore code; VM snapshots also restore databases and running state, so recovery covers everything.

## MeshVCS: a safer layer above git

MeshVCS records every change as a reversible operation plus continuous snapshots, stored in git's own object database, so any mistake by a human or an agent can be undone in one command without rewriting history. Git is not replaced; it becomes the export and interchange format.

**Why git alone fails with agents.** Git records what was committed, not what was attempted, so an agent's uncommitted work is unprotected. Its recovery tools (`reset --hard`, `rebase`, `clean`) are destructive. A conflict blocks the working tree. And git has no notion of who or what intended a change.

**Prior art worth borrowing** (from memory; verify before depending on any of it): Jujutsu (`jj`) for its operation log, automatic working-copy snapshots, stable change IDs and first-class conflicts; Gerrit's Change-Id; merge queues such as GitHub's and Zuul for speculative testing; Mergiraf-style syntax-tree merging. The MVP builds on git plumbing plus SQLite. Embedding `jj` as the engine is a later option, not a dependency.

**Core objects**

- **Snapshot:** an immutable git tree under a hidden ref (`refs/mesh/snap/<lane>/<n>`). Taken at every turn boundary, before every risky tool call, and after 30 s idle when dirty. Content addressing makes unchanged files free.
- **Operation:** a log entry with actor, kind, before-view, after-view, parent operation, intent and hash. A view is the full set of pointers (trunk head plus every lane head). Undo restores the previous view; since views point at immutable snapshots, undo is instant and cannot lose data.
- **Changeset:** the unit of review and landing. It has a stable Change-ID that survives rebases, and carries intent, actor, base hash, snapshot range, provenance (model, prompt hash, tool calls) and harness verdicts.
- **Lane:** a named, mutable pointer to a snapshot chain plus its overlay.
- **Trunk:** the linear sequence of landed changesets, mirrored as the git branch `mesh/trunk`.
- **Quarantine:** failed or rejected changesets are kept with their reasons, never deleted, and can be revived.

**Recovery: one command per disaster**

| Situation | Command | What happens |
| --- | --- | --- |
| Agent trashed my files | `mesh undo` | Restores the previous view of my lane |
| Go back to before this task | `mesh rewind --before-intent 14` | Lane returns to the snapshot preceding intent 14 |
| Go back 10 minutes | `mesh rewind 10m` | Lane returns to the nearest earlier snapshot |
| Undo one agent's work only | `mesh revert-intent 14` | Builds inverse changesets, previews the cascade onto dependent work, then applies |
| Trunk broke | `mesh trunk revert <change-id>` | Also automatic: the queue bisects and reverts the culprit |
| Everything is on fire | `mesh freeze`, then `mesh restore --checkpoint <name>` | Freeze halts all writes; restore returns trunk and every lane to one consistent view |
| The Hub died | `mesh recover --from-standby` or `--from-bundle` | Standby or the latest bundle becomes the Hub under a new epoch |
| I want out | `mesh eject` | Leaves ordinary git branches with full history |

**Conflicts are data, not roadblocks.** A conflicted merge never blocks a lane; it is stored as a conflict object. The resolution ladder is: (1) trivial three-way merge; (2) syntax-tree-aware merge; (3) contract-aware classification, since a conflict touching an API or schema is treated differently; (4) a negotiation task sent to both owning agents with both intents attached, resolved in a scratch lane; (5) human escalation after two failed rounds or on protected paths.

**Git bridge.** Each landed changeset becomes one commit on `mesh/trunk` with trailers `Mesh-Change-Id`, `Mesh-Intent`, `Mesh-Actor` and `Co-authored-by`. A normal `git pull` from the remote is imported as an external changeset and verified like any other. `mesh push` publishes trunk only when it is green and, by policy, approved by a human.

**Storage safety.** Three copies of the truth exist: the Hub volume, the streaming standby, and a `git bundle` plus log export written to a host disk every 5 minutes. `mesh fsck` verifies hashes. Snapshots are dense for one hour, then thinned. Nothing reachable from the operation log is garbage-collected for 7 days, a reflog with far longer memory.

## Coordination: intents, leases and the integration queue

Agents declare an intent before editing; the mesh converts it into leases and a conflict forecast, and only the integration queue may land work on trunk. Collisions are therefore predicted while there is still nothing to merge.

**Intent.** A short record with a goal sentence, a scope (path globs, symbols, contract nodes), the expected contract effect (none, additive or breaking), an estimated duration and an optional parent intent. Agents declare it with the `mesh_declare_intent` tool; humans type one line in the extension. If an agent never declares, the mesh infers a shadow intent from its first file writes, so non-cooperating agents are still covered.

**Lease types**

| Kind | Granularity | Behaviour | Typical use |
| --- | --- | --- | --- |
| Interest | Any scope | Subscribe only; the holder is notified when the scope changes | UI agent depends on `/posts` |
| Soft write | Path, symbol or contract node | Others are warned and see it on the canvas; nobody is blocked | Default for every edit |
| Hard write | File or resource | Other writes are rejected at the overlay | Lockfile, migrations, generated files, shared schema |
| Exclusive operation | Trunk | One holder at a time | Rebase, release, dependency swap |

**Lease rules**

- A lease lives 5 minutes and is renewed by activity (file writes or tool calls in the lane). A crashed agent's leases expire on their own.
- Leases are released automatically when the changeset is proposed.
- A human edit on a leased scope pre-empts the lease; the agent gets an interrupt and rebases.
- Deadlock is prevented by acquiring hard leases in one canonical order, never holding one while waiting for another, and detecting cycles in the wait-for graph (the youngest request yields).

**Conflict forecast.** When an intent is declared, its scope is intersected with every active scope at three levels: path, symbol (through the symbol graph) and contract (producer and consumer edges). The result is one of four grades.

- **None:** nothing to say.
- **Adjacent:** same module, different symbols. Shown on the canvas only.
- **Overlapping:** both touch the same symbol. A soft warning and a suggested order.
- **Contradictory:** one side deletes or changes what the other calls. An interrupt to both agents plus a negotiation task.

**Safe points.** A lane is rebased onto a new trunk only between agent turns, never mid-tool-call, and only after 2 s of quiet. The agent then gets a one-line delta such as "trunk moved: auth v2 landed, your lane rebased cleanly". A rebase conflict becomes a conflict object, not a broken working tree.

**The integration queue, the only road to trunk**

1. The actor proposes a changeset (an agent calls `mesh_propose`, a human clicks, or policy auto-proposes after idle).
2. The fast checks (T0 and T1) run in the lane.
3. The changeset enters the queue.
4. The queue builds a speculative stack (trunk plus every queued changeset ahead of it) and runs the T2 checks on that stack.
5. The queue does a compare-and-swap on the trunk head.
6. `trunk.moved` is broadcast with the affected contracts, and every lane is rebased at its next safe point.
7. On failure, the batch is bisected, the culprit is quarantined with a structured verdict, and the others continue.

Priority is human before agent, then age, with a hotfix jump that needs a human approval. Batch size adapts, up to four changesets.

**The human dial.** Policy sets, per path class, one of three modes: auto-land (docs, tests), approve-to-land (default for code), or approve-and-pair (auth, payments, migrations).

**Roles.** Every agent has a human owner and never exceeds the owner's rights. Three steward roles exist: dependency steward, contract steward and release captain. Each is a human, an agent or the mesh itself.

## Contracts and drift immunity

The registry turns "who depends on what" into a graph the mesh can check, so contract drift is caught when a change is proposed, not when two branches finally meet.

**What counts as a contract:** REST routes (OpenAPI), tRPC routers, GraphQL schemas, Protobuf, Zod and JSON schemas, exported TypeScript types, database schema and migrations, event payloads, environment variables, CLI flags and design tokens.

**Extraction without writing specs.** Per-stack adapters derive contracts from code: route scanners for Express, Nest and FastAPI; the TypeScript compiler API and tree-sitter for exported types and Zod; SQL and Prisma or Drizzle parsers for the database; `buf` for Protobuf. If no adapter exists, a model proposes an extraction rule once, a human approves it, and it is saved as a deterministic adapter. Each node has an id (`api:POST /v1/auth/login`), an owner, a version hash, a status (stable, proposed or deprecated) and a consumer list.

**Consumer discovery uses two sources.** Static analysis (imports, generated clients, the symbol graph) says who could call. Runtime tracing (a tiny proxy or OpenTelemetry inside the VM) says who does call. The canvas draws both.

**The drift-prevention loop**

1. The backend agent declares an intent with a contract effect.
2. As soon as its code changes, the registry computes a **proposed** version, diffs it against stable, and classifies it as breaking, additive or internal (oasdiff, graphql-inspector, `buf breaking` and TypeScript API Extractor are the kinds of tools to wrap).
3. Every consumer with an interest lease gets a top-urgency line in its fact sheet, for example: `POST /api/auth` becomes `/api/v2/auth`, breaking, proposed by Backend Agent, intent 14, about 20 minutes out.
4. A **ghost contract** is generated into each consumer lane under `.mesh/ghost/`: a typed client and mock handlers for the proposed version, clearly marked. The UI agent can build against the future API today.
5. When the producer lands, the ghost is replaced by the real generated client. Codegen (OpenAPI, tRPC, Zod, Protobuf) runs deterministically at integration; generated files are mesh-owned, hard-leased and excluded from merge conflicts.
6. Consumer-driven contract tests replay recorded consumer calls against the real producer.

**The deletion gate.** A breaking removal is blocked while any consumer lane or trunk file still references the old contract, or while runtime traffic to it was seen in the last N minutes. In the `/api/auth` example the old route survives until the UI lane has migrated, and the consumer agent automatically receives a migration task. This is the deterministic fix for the 30 minutes lost on a deleted endpoint.

**Speculative cross-lane verification**

- For each producer and consumer pair with a live edge, build an ephemeral overlay of trunk plus the producer lane plus the consumer lane. Nothing is written to either lane.
- Run the incremental type check (`tsc --incremental`, pyright, `cargo check`) and the contract tests inside a 30 s budget.
- Trigger only when both lanes have been quiet for 5 s. Cost grows with the number of graph edges, not with the square of the number of actors, and results are cached by hash pair.
- The consumer receives a concrete finding such as "your lane fails typecheck at `Feed.tsx:41` once backend lands; `/api/auth` is missing". The producer is told it will break one consumer lane. The mesh never edits another actor's lane.
- Results are advisory inside lanes and blocking only at integration, which keeps false positives cheap.

**Known limit.** Types cannot see a change in meaning (a field that now holds cents instead of dollars). Those cases rely on contract tests and a mandatory human-readable contract note on every breaking change.

## The Harness

The harness is four things: verification gates that protect trunk, policy guardrails that limit damage, a structured feedback format agents can act on, and a simulation rig that tests AgentMesh itself.

**1. Verification gates**

| Tier | Trigger | Budget | Checks | What it blocks |
| --- | --- | --- | --- | --- |
| T0 | Every snapshot | under 2 s | Syntax parse, format and lint on changed files, secret scan, protected-path check | Nothing in the lane; findings are flagged |
| T1 | End of an agent turn | under 15 s | Typecheck of affected projects, unit tests chosen by impact analysis | Proposing the changeset |
| T2 | In the queue, on the speculative stack | under 2 min | Integration and contract tests, cross-lane verification, migration dry-run on a database clone | Landing on trunk |
| T3 | Before `mesh push` or a release | as needed | Full suite, end-to-end tests, build, dependency audit, license check | Publishing |

Speed comes from four techniques: impact analysis from the symbol graph (`jest --findRelatedTests`, `pytest-testmon`), caching by input hash, the Hub's fair job queue, and flake handling. A test that fails then passes on the same hash is labelled flaky, reported, and does not block.

**2. Verdicts agents can use.** Raw logs waste context, so every verdict is structured and bound to the exact base hash plus change hash; if either moves, the verdict is void and re-run. An agent sees at most 20 lines: status, tier, and for each failure the file, line, symbol, a message under 200 characters and a suggested action. The full log stays one tool call away.

**3. Policy guardrails.** Rules live in `.mesh/policy.yaml` and are enforced by the VM, never by prompt.

```yaml
version: 1
paths:
  protected: ["infra/**", ".github/**", "**/*.pem"]   # approve-and-pair
  generated: ["src/gen/**", "**/*.lock"]              # mesh-owned, hard-leased
blast_radius:
  max_files_per_changeset: 40
  max_deleted_lines: 400
commands:
  deny: ["rm -rf /*", "git push --force*", "git reset --hard*", "DROP TABLE*"]
  require_approval: ["npm publish", "terraform apply*"]
network:
  egress_allow: ["registry.npmjs.org", "pypi.org", "api.anthropic.com"]
budgets:
  per_lane: { tokens: 2000000, wall_minutes: 180 }
landing:
  default: approve-to-land
  auto: ["docs/**", "**/*.test.*"]
```

Enforcement points: protected paths are read-only in the overlay, command shims intercept the shell, an egress proxy applies the network allowlist, and cgroups cap resources. A denial returns a structured, explained message to the agent and is logged.

**4. Simulation, replay and chaos (testing the mesh itself)**

- **Deterministic simulation.** Because the core is event-sourced and single-writer, a seeded simulator can drive scripted fake agents, a fake clock and a fake network with drops, duplicates and partitions. After every step it asserts the invariants: no lost writes, trunk green, log hash chain intact, no deadlock, bounded context size, no message loops. A failing seed is a reproducible bug.
- **Record and replay.** All events and file operations are recorded, so incidents can be replayed and routing or merge changes regression-tested against real sessions.
- **Scenario evals.** Scripted team scenarios run with real agents: the `/api/auth` rename, two agents adding the same helper, a dependency bump mid-refactor, a migration race. Metrics are time to detect drift, wasted agent-minutes, lost writes (must be zero) and human interventions.
- **Chaos drills.** `mesh drill` kills the daemon, the VM and the standby in turn and checks recovery against the 30 s target. Run it in CI and before every demo.

**Closed loop with a stop.** A failed verdict reaches the author agent at its next tool boundary, it fixes and re-verifies, and after three automatic retries the mesh stops and escalates to the human, so a fix loop cannot burn the budget.

## Integrations: extension, MCP and agent adapters

AgentMesh plugs into agents at five levels of cooperation. Each level adds power, and none is mandatory, so an agent that ignores every instruction is still attributed, snapshotted and bounded.

**The compliance ladder**

| Level | Mechanism | What the mesh gets | Works with |
| --- | --- | --- | --- |
| L0 Watch | Filesystem watcher plus per-actor lane overlays | Edits attributed by lane, inferred intents, snapshots | Any agent, even a human in vim |
| L1 Instruct | Rules file pointing at `.mesh/active_context.md` and the protocol | The agent reads current facts and follows the protocol voluntarily | Codex CLI, Claude Code, Cursor, Windsurf |
| L2 Tools | The `agentmesh` MCP server | Intent, claims, inbox, contracts, checkpoint, undo, propose and verify as callable tools | Any MCP-capable client |
| L3 Hooks | Client hooks that run `mesh hook` before and after tool calls and on prompt submit | Deltas injected, risky actions blocked, automatic checkpoints | Claude Code, others where hooks exist |
| L4 Wrap | `mesh run -- <agent command>` | Agent runs in its own lane with shimmed PATH: full policy, leases, budgets | Any CLI agent |

**MCP server**

- **Tools:** `mesh_status`, `mesh_declare_intent`, `mesh_claim`, `mesh_release`, `mesh_inbox`, `mesh_contract_get`, `mesh_contract_diff`, `mesh_post`, `mesh_ask`, `mesh_checkpoint`, `mesh_undo`, `mesh_propose`, `mesh_verify`.
- **Resources:** `mesh://context/active` (the fact sheet), `mesh://contracts/{id}`, `mesh://lane/{id}/diff`.
- **Transport:** a stdio shim forwards to the Hub over a local socket, so each client gets its own identity; Streamable HTTP serves remote clients.

**Faking push in a pull-based world.** Most clients only pull, so updates are delivered through five channels, ordered by reliability.

1. **Piggyback.** Every mesh tool result and every shim output starts with a `mesh-delta` header of at most 300 tokens, present only when there is unseen news. It needs no client support and arrives at the agent's next tool call.
2. **Hooks.** On prompt submit, inject the current fact sheet; before a tool call, warn or block on leased paths; after a tool call, take a checkpoint.
3. **Context file.** `.mesh/active_context.md` is regenerated atomically (write a temp file, then rename), size-capped and version-stamped. Rules tell the agent to re-read it when the banner version changes. Atomic rename prevents half-read files.
4. **MCP notifications.** Send `resources/updated` and `tools/list_changed`. They are harmless where ignored and instant where supported, so never depend on them.
5. **Sampling or elicitation requests,** only where a client supports them.

Honest limit: until clients surface notifications to the model, delivery happens at the next tool boundary, usually seconds into an active agent but later during one long generation. Blocking events do not rely on delivery, because the overlay and shims refuse the write anyway.

**VS Code extension** (also loads in Cursor and Windsurf; publish to the Marketplace and to Open VSX)

- **Status bar:** room, peers, my lane state, trunk state (green or unverified).
- **Sidebar:** Team (actors, intent, focus), Leases, Inbox, Contracts, and a Lanes and Snapshots timeline.
- **Editor:** a gutter mark or CodeLens such as "Backend Agent is editing this function, intent 14"; collision and drift warnings in the Problems panel; hover on an API call to see its contract status.
- **Canvas:** the live map in a webview.
- **Commands:** Attach to Hub, Declare Intent, Checkpoint, Undo, Rewind, Ask @agent, Propose Changeset, Freeze.
- **Setup:** on first run it detects installed agents and shows a diff of the MCP config, rules files and hooks it wants to write; the user approves.
- **Thin client:** all logic lives in the daemon, so a JetBrains plugin or a terminal UI can follow later.

**Adapters**

| Client | Instruction file | MCP | Hooks | Recommended level |
| --- | --- | --- | --- | --- |
| Claude Code | `CLAUDE.md` | Yes | Yes | L3 plus L4 |
| Codex CLI | `AGENTS.md` | Yes | Verify | L2 plus L4 |
| Cursor | `.cursor/rules` | Yes | Verify | L2 plus attached mode |
| Windsurf | `.windsurf/rules` | Yes | Verify | L2 plus attached mode |
| Aider, custom scripts | System prompt | Via SDK | No | L4 wrap |

This table reflects my knowledge to mid-2026. Confirm each client's current hook and MCP support before building, since these features change quickly.

## Semantic bus: messages, routing and loop defenses

Every message carries two channels, a short human sentence and a typed fact payload, and a router sends each message only to the actors whose work it touches, at an urgency that matches its severity.

**Two-channel messages.** A message has `say` (at most 140 characters, for humans), `facts` (typed, for agents) and `refs` (graph node ids). Machines author facts and the mesh renders `say` from a template. Humans write free text and a small scribe model proposes facts; the sender sees "Broadcast as: schema User, added required tenantId, breaking. Send or Edit" and confirms with one click, so no unreviewed guess becomes a machine fact.

```json
{
  "say": "User now has a required tenantId.",
  "facts": {
    "kind": "contract.change",
    "node": "schema:User",
    "effect": "breaking",
    "change": { "added": ["tenantId: string (required)"] },
    "action_for_consumers": "add tenantId to create and update payloads"
  },
  "refs": ["schema:User", "api:POST /v1/users"]
}
```

**Routing.** For each event and each actor, the router computes a relevance score from graph proximity between the event's refs and the actor's scope and interests, lease overlap, explicit mention and severity, minus a penalty for duplicates already seen. The score maps to one of four tiers.

| Tier | Name | Delivery to an agent | Examples | Budget |
| --- | --- | --- | --- | --- |
| 0 | Block | Enforced at the boundary, with an explanation | Write to a hard-leased file, policy violation | Not applicable |
| 1 | Interrupt | Next tool boundary via piggyback or hook | Breaking change to a contract you use, trunk moved under your lane, a request to you | At most 300 tokens per delta |
| 2 | Digest | Folded into the fact sheet, no interruption | Additive changes, peers working in adjacent modules | Fact sheet at most 800 tokens |
| 3 | Ambient | Canvas and inbox only | Everything else, plain chat | None |

Humans see the same tiers as a toast (1), a badge (2) and the canvas (3), with a cap of three toasts per 10 minutes before extra items are batched into a digest. This is the answer to notification fatigue.

**The fact sheet.** A context compiler derives each agent's sheet from current state, not from the log, so the sheet stays small however long the session runs. A superseding fact removes the old one, items expire, and a chain A to B to C collapses to A to C.

```markdown
<!-- mesh v412 · lane ui-agent · trunk green @ 9f3c1a -->
## My work
Intent 15: build login screen. Soft lease on src/ui/auth/**
## Contracts I use
- api:POST /v1/auth/login is STABLE. PROPOSED v2 at /api/v2/auth (breaking)
  by backend-agent, intent 14, ETA ~20m. Ghost client: .mesh/ghost/auth.ts
## Near me
- backend-agent is editing src/api/auth/** (intent 14)
## Requests to me
- none
## Rules
Declare intent before big edits. Call mesh_inbox after a trunk.moved banner.
Never edit src/gen/**.
```

**Talking to other people's agents.** `@backend-agent please expose createdAt on /posts` becomes a typed `request`. By default it lands in the owner's approval inbox ("Let Maya's agent do this?"). A policy list of trusted teammates skips the approval. Once accepted, it becomes a child intent of the sender's, and the sender sees a status chip: queued, working, done or declined with a reason. Agents ask each other with `mesh_ask`, under the same rules and a rate limit.

**Loop and pollution defenses**

- **Messages are data, not commands.** Only an approved, addressed `request` can cause work, so text in a message or file cannot hijack an agent.
- **Hop limit.** Every event carries a cause id and hop count; agent-initiated chains stop at three hops and go to a human.
- **Rate limits and dedupe.** Per-actor posting limits, content-hash dedupe and idempotency keys.
- **Acknowledgements are events, not messages.** "Seen" and "done" never trigger a reply, so there are no thank-you loops.
- **Circuit breaker.** More than 20 events a minute from one actor mutes it and alerts its owner.
- **Reference, don't paste.** Facts point at node ids instead of copying content into every context window.
- **Hard budget.** The compiler truncates the lowest-priority items first when a sheet would exceed its budget.

## Presence and the live canvas

The canvas is an ambient map that is quiet by default: it shows where every human and agent is working, and lights up only what needs attention.

**The map**

- **Nodes** come from the symbol and dependency graph at four semantic zoom levels: system (Frontend, Backend, Database, Shared), module, file, and symbol or contract node. Zooming changes the level of detail, so the view stays under about 500 nodes.
- **Edges** are imports, calls and contract links from producer to consumer. Static edges are solid; runtime edges are dashed and animate with real traffic.
- **Layout** is layered (ELK) and persisted, so nodes never jump between refreshes.

**Presence, the Figma cursor for code**

- Each actor is a colored ring: a circle for a human, a rounded square for an agent in its owner's color.
- A verb badge says what it is doing: reading, editing, testing or waiting. Trails fade after 10 s.
- Focus is derived from four signals: the editor cursor (extension), the agent's tool calls, its lease scope and filesystem activity in its lane.

**Node and edge states:** an outline in an actor's color means a soft lease; a lock icon means a hard lease; a pulse means just changed; a dashed outline means a proposed contract; a red edge means a predicted collision or drift; a green or amber badge shows the harness status of that lane's change.

**Spatial comments.** Drop a pin on a node or an edge. The pin is a typed message with that node in its refs, so any agent whose scope touches the node, or who queries it with `mesh_contract_get`, receives it. These are sticky notes that agents actually read.

**Collision warnings climb a ladder and never use a modal**

1. The node outline turns amber on the canvas.
2. A diagnostic or CodeLens appears in the other person's editor.
3. The agent gets a Tier 1 delta that includes a concrete suggestion.
4. The warning clears itself when the intents separate, and a user can snooze it with "I know".

**Time machine.** A scrub bar replays the operation log: presence, landed changes and conflicts. Clicking an operation shows its diff and the undo options for it.

**Quiet defaults.** Focus mode shows only my neighbors; a digest arrives every 10 minutes; sound is off apart from an opt-in chime for Tier 1; the toast cap from the bus section applies.

**Delivery.** The Hub serves the canvas as a local web page, and the VS Code extension embeds the same page in a webview. A terminal UI built on the same data covers SSH-only setups. The stack is React with a graph library (React Flow or Cytoscape) plus ELK for layout.

## Core schemas

Everything is one hash-chained event envelope wrapping a small set of typed payloads. These definitions are the whole wire contract between the daemon, the extension, the MCP bridge and the canvas; generate them from Zod so every client shares the same types.

```ts
type Id = string;       // ULID, sortable
type Hlc = string;      // hybrid logical clock, e.g. "1760100000000:0007:hub"
type ViewId = string;   // pointer set: trunk head plus every lane head

interface ActorRef { id: Id; type: "human" | "agent" | "system"; owner?: Id; tool?: string; model?: string }

// Every state change is one Event. State = fold(events).
interface Envelope<K extends string, P> {
  id: Id; hlc: Hlc;
  epoch: number;               // fences a stale Hub after failover
  actor: ActorRef;
  kind: K; payload: P;
  cause?: Id; hops: number;    // causation chain for loop defense
  prev: string; hash: string;  // hash chain over the log
}

interface Intent {
  id: Id; actor: Id; goal: string;
  scope: { paths: string[]; symbols: string[]; contracts: string[] };
  effect: "none" | "additive" | "breaking";
  inferred: boolean; eta_min?: number; parent?: Id;
  status: "active" | "proposed" | "landed" | "abandoned";
}

interface Lease {
  id: Id; actor: Id; intent?: Id;
  kind: "interest" | "soft" | "hard" | "exclusive";
  target: { type: "path" | "symbol" | "contract" | "resource"; ref: string };
  expires: Hlc;
  fence: number;               // fencing token for hard leases
}

interface ContractNode {
  id: string;                  // "api:POST /v1/auth/login"
  type: "http" | "trpc" | "graphql" | "proto" | "schema" | "db" | "event" | "env" | "cli";
  owner: Id; version: string;  // content hash
  status: "stable" | "proposed" | "deprecated";
  consumers: { ref: string; source: "static" | "runtime"; last_seen?: Hlc }[];
  proposed_by?: { intent: Id; lane: Id; diff: "breaking" | "additive" | "internal" };
}

interface Changeset {
  change_id: string;           // stable across rebases
  intent: Id; lane: Id; actor: Id;
  base: string; head: string;  // git tree hashes
  status: "drafting" | "proposed" | "verifying" | "queued" | "landed" | "quarantined" | "reverted";
  provenance: { model?: string; prompt_hash?: string; tool_calls?: number };
  verdicts: Id[];
}

interface Verdict {
  id: Id; tier: 0 | 1 | 2 | 3;
  base: string; head: string;  // void if either moves
  status: "pass" | "fail" | "flaky" | "error" | "void";
  failures: { kind: string; file?: string; line?: number; symbol?: string; message: string; action?: string }[];
  log_ref: string;
}

interface Operation {          // MeshVCS operation log entry
  id: Id; actor: Id; intent?: Id;
  kind: "snapshot" | "propose" | "land" | "rebase" | "undo" | "revert" | "restore" | "freeze";
  before: ViewId; after: ViewId;
}
```

**Event kinds:** `intent.declared`, `lease.acquired`, `lease.released`, `lease.expired`, `presence.focus`, `contract.proposed`, `contract.landed`, `changeset.proposed`, `changeset.queued`, `changeset.landed`, `changeset.quarantined`, `verdict.posted`, `message.posted`, `request.created`, `request.accepted`, `request.declined`, `trunk.moved`, `policy.denied`, `op.undone`, `hub.epoch`.

**Two rules keep the schema honest.** First, hashes, not names, identify content, so a verdict about a changeset is meaningless once its base or head moves. Second, any field that crosses the agent boundary has a size cap enforced by the compiler, so a schema change can never silently enlarge an agent's context.

## Failure modes and defenses

Every failure below has a prevention, a detection and a one-step recovery; none relies on an agent behaving well. The pattern is the same throughout: isolate the blast radius, snapshot before the risk, verify against hashes, and make undo cheap.

| Failure | Defense | Recovery |
| --- | --- | --- |
| Agent deletes or rewrites many files | Blast-radius policy, lane overlay, snapshot before every risky call | `mesh undo`; changeset quarantined |
| Two actors edit the same code | Intent forecast, soft leases, lane isolation | Rebase at a safe point; conflict object; negotiation task |
| Contract drift (endpoint renamed) | Registry, ghost contracts, cross-lane verify, deletion gate | Migration task to the consumer; old contract kept until consumers move |
| Context window pollution | State-based fact sheet, token budgets, supersede and TTL | Compiler truncates; `mesh context --rebuild` |
| Agents reply to each other forever | Typed requests only, hop limit, rate limits, circuit breaker | Actor muted, owner alerted, chain traced by cause id |
| Crashed agent holds leases | TTL plus activity heartbeat | Expire in 5 min; `mesh lease break` |
| Lease deadlock | Canonical order, no hold-and-wait, cycle detection | Youngest request yields |
| Daemon crash | WAL event log, idempotent replay; shims fail open for reads and closed for hard-leased writes | Restart replays the log; agents see a banner meanwhile |
| VM disk lost or corrupted | Standby replica, 5-minute bundles on a host disk, hash checks | `mesh recover`, `mesh fsck` |
| Hub host leaves (laptop closed) | Warm standby, epoch fencing | Standby promoted; the old Hub's writes are refused |
| Split brain after a partition | Single lease arbiter per epoch | Losing side's lanes reconcile as proposed changesets |
| Teammate loses Wi-Fi | Mirrored mode with a local operation log | Reconcile on reconnect; leases lapsed, so a rebase check runs |
| Lockfile or dependency collision | Dependency steward, shimmed package managers | Serial lane; roll back to the previous L1 layer |
| Migration number or schema clash | Hub-issued sequence numbers, hard lease, per-lane database clones | Dry-run on a clone in T2; VM snapshot restore |
| Generated-file churn | Mesh-owned, regenerated at integration, excluded from merges | Regenerate |
| Flaky tests block trunk | Rerun on the same hash, flaky label | Reported, not blocking |
| Harness too slow | Tiers, impact analysis, caching, fair queue | Human waives T2 with an audit entry |
| Stale verdict lands the wrong code | Verdict bound to base and head hashes; compare-and-swap on trunk | Automatic re-verification |
| Prompt injection through a file or message | Messages are data; requests need owner approval; provenance tags | Revert the intent; quarantine; audit |
| Secret leakage | T0 secret scan, secrets only in VM tmpfs, egress allowlist, redaction on the bus | Rotate the secret; explicit purge of snapshots |
| Agent ignores the mesh | L0 watcher, overlays and shims enforce at the boundary; compliance score | Inferred intents; human nudge |
| Human and agent edit the same code | One lane per actor; human has priority | Agent lease yields and rebases |
| Clock skew between machines | Hybrid logical clock stamped by the Hub | Not needed |
| Event storm or log growth | Snapshot compaction, per-kind TTL, presence kept out of the durable log | Compaction job |
| Queue starvation | Speculative batching, bisection, aging priority | Hotfix jump with human approval |
| Five agents exhaust the VM | cgroups per lane, fair job queue | Throttle the lowest-priority lane |
| Git history pollution | One commit per changeset, trailers, optional squash | `mesh eject` or republish on a new branch |
| Token or cost runaway | Per-lane budgets, retry cap of 3 | Lane paused, owner notified |
| Huge monorepo | Sparse lanes, lazy symbol index, scoped graphs | Narrow the scope |
| Someone pushes to origin mid-sprint | Git bridge imports it as an external changeset and verifies it | Same as any conflict |
| AgentMesh itself has a bug | Falls back to plain git; simulation suite; `mesh eject` | Uninstall leaves the repo intact |

**Three risks to the vision itself**

- **False alarms erode trust.** If more than about 1 in 10 collision warnings is wrong, people mute them. Track alert precision from day one and keep cross-lane results advisory until it is high.
- **The VM adds friction.** If setup is slow, the team goes back to plain git. Lite mode (no VM) and a pre-pulled image exist for this reason.
- **Cooperation cannot be assumed.** The design works only if enforcement lives at the boundary. Anything that relies on an agent following a rule is treated as a hint, not a guarantee.

## Security and trust

Treat every agent as an untrusted contractor and every message as untrusted data: the VM is the boundary, the policy engine is the guard, and the operation log is the audit trail.

**Threat model**

| Threat | Example | Control |
| --- | --- | --- |
| Malicious dependency | A postinstall script exfiltrates secrets | Steward installs in a scratch directory with lifecycle scripts off by default and an allowlist; egress allowlist |
| Prompt injection | A README tells the agent to run `curl ... \| sh` | Content from files and the web is labelled untrusted; messages are data; command deny list and approval rules |
| Hijacked or rogue agent | An agent sends a request asking another to push secrets | Requests need owner approval; capabilities are scoped per actor |
| Secret exposure | `.env` or a key lands in a snapshot or on the bus | Secrets live in VM tmpfs and process env; ignored secret files are excluded from snapshots and listed in a manifest; T0 scan; redaction before anything reaches the bus |
| Sandbox escape | An agent attacks the host | No host mounts beyond the repo, no Docker socket, non-root daemon, microVM driver for untrusted agents |
| Stranger joins the room | A neighbor on the same hackathon network | Short-lived room token, per-actor ed25519 keys, mutual TLS or a WireGuard overlay such as Tailscale, fingerprint shown as a QR code |
| Log tampering | Someone edits history to hide a change | Hash chain signed by the Hub key, with anchors replicated to the standby |

**Identity and capabilities**

- Every actor has a key pair. An agent's token is derived from its owner's key with a scope (read, propose, land or admin) and a time limit, 8 hours by default.
- Capabilities are checked in the command path, before any event is appended.
- Agents cannot land on trunk by default; the dial in the coordination section decides where a human must approve.

**Privacy and local-first**

- Code stays on the team's machines. A cloud relay, if used, carries end-to-end encrypted traffic and cannot read it.
- No telemetry by default; hosted rooms are opt-in.

**Provenance and audit.** Every changeset records the model, a prompt hash and its tool-call count. `mesh audit <path>` answers who or what changed a file, under which intent and approval, and which verdicts it passed.

## Zero to running in 60 seconds

The target is a host ready in about 40 seconds and each teammate in about 20, using one command each. These are design budgets to verify, and the first image pull on a slow network is the main risk.

```bash
# Host (one person, inside the repo)
npx agentmesh up

# Everyone else
npx agentmesh join KQ7-4MF     # or click the invite link
```

**Host journey**

1. **0 to 3 s, detect.** Find the repo root, the stack (`package.json`, `pyproject.toml`), the agents installed (Claude Code, Codex, Cursor, Windsurf) and the best driver: container if Docker or Podman exists, otherwise Lite.
2. **3 to 25 s, boot the Hub.** Start from a cached image or a pre-baked snapshot, import the repo as trunk by copying git objects (no clone), and install dependencies once into the shared layer.
3. **25 to 30 s, open the room.** Print a room code, an invite link and a QR code, and open the canvas in the browser.
4. **30 to 40 s, wire the agents.** Show a diff of the MCP, rules and hook changes about to be written; one keypress approves.

**Teammate journey**

1. **0 to 8 s.** Run `join` or click the link. The VS Code extension is installed if missing.
2. **8 to 15 s.** Discover and attach to the Hub, create a lane (under 2 s), write the MCP config.
3. **15 to 20 s.** The first `mesh_status` call comes back green. Then work as usual, or start an agent with `mesh run -- claude`.

**How peers find each other.** Methods are tried in parallel and the fastest that works wins.

| Order | Method | Setup | Works when |
| --- | --- | --- | --- |
| 1 | LAN discovery (mDNS) | None | Same network, no client isolation |
| 2 | Tailscale or WireGuard, if detected | None if already installed | Any network, installed on every machine |
| 3 | WebRTC hole punching with a small stateless signaling server | None | Most home and mobile networks |
| 4 | Encrypted relay over a WebSocket tunnel | None | Venue Wi-Fi with client isolation |

**Hackathon traps handled in advance**

- Venue Wi-Fi blocks peer traffic: the relay takes over, or a phone hotspot works.
- Docker is not installed or admin rights are missing: Lite mode or a rootless container.
- A teammate is on Windows: the WSL2 driver is detected automatically.
- The venue network is slow: `agentmesh prefetch` pulls the image the night before.

**Day-two commands:** `mesh status`, `mesh doctor` (checks ports, driver, network and versions), `mesh down` (stops everything and leaves branches and history intact).

## Tech stack

Use TypeScript for everything user-facing, delegate heavy work to proven tools, and keep the core to a handful of dependencies. The rule is to wrap existing tools (git, tree-sitter, oasdiff, buf) rather than rewrite them.

| Layer | Choice | Why, and the alternative |
| --- | --- | --- |
| Daemon and CLI | TypeScript on Node 22 LTS | One language across daemon, MCP bridge, extension and canvas; first-class MCP SDK. Later: a Rust sidecar for overlay and hashing hot paths, or a Go single binary |
| State and event log | SQLite in WAL mode, JSONL export | Zero-ops, transactional, one file to replicate |
| Content store | Git object database through plumbing commands and hidden refs | Compatibility and deduplication for free. Later option: embed Jujutsu |
| Transport | WebSocket plus HTTP and SSE; MCP over stdio and Streamable HTTP | Firewall-friendly and simple. NATS only for larger teams |
| Schemas | Zod, exported to JSON Schema | One source of truth for every client |
| Code intelligence | tree-sitter (WASM), TypeScript compiler API or LSP, SCIP indexers | Language-agnostic parsing plus precise symbol data; ctags as a cheap fallback |
| Merge | `git merge-file`, then syntax-tree-aware merge (Mergiraf style) | Fewer false conflicts at the integration step |
| Lanes | overlayfs (rootless with fuse-overlayfs); fallback git worktree plus reflink copies | Copy-on-write isolation, attribution by construction |
| Runtime | Docker or Podman by default; Lima and WSL2; Firecracker or Cloud Hypervisor when hardened | Matches the driver table in the sandbox section |
| Base image | Alpine or Debian-slim, mise or Nix for pinned toolchains, shared pnpm and uv caches | Small image, reproducible versions |
| Contract tooling | oasdiff, graphql-inspector, `buf`, TypeScript API Extractor | Wrapped, not reinvented |
| Test impact | `jest --findRelatedTests`, pytest-testmon, nx or turbo affected | Keeps T1 under 15 s |
| Canvas | React and Vite, React Flow or Cytoscape, ELK; Ink for the terminal UI | Fast to build, one data model for both |
| Extension | VS Code Extension API, published to the Marketplace and Open VSX | Also loads in Cursor and Windsurf |
| Discovery | mDNS, Tailscale detection, WebRTC (node-datachannel), WebSocket relay | The four-step ladder in the journey section |
| Crypto | ed25519 keys (libsodium), mTLS or WireGuard | Small and audited |
| Packaging | npm package `agentmesh`; a pip shim that launches the same binary | Satisfies both `npx` and `pip install` |
| Testing | Own deterministic simulator, Vitest, Playwright for the canvas | Matches the harness section |

## Proof of concept

A zero-dependency Node prototype of about 180 lines proves the core loop, and the scenario below ran successfully on Node 22. A UI agent and a backend agent talk to the hub through real MCP stdio bridges; when the backend agent declares a breaking change to an endpoint the UI agent uses, the UI agent is told on its very next tool call, and a third agent that wanders into a leased area gets an overlap warning.

**What it demonstrates**

- An event-sourced core: every command is a hash-chained event, state is derived by one reducer, and `/verify` re-checks the chain.
- Intents and leases that renew on heartbeat and expire on their own.
- A relevance router that sends the breaking-change notice to the consumer (tier 1) and a courtesy note to the producer (tier 2).
- Push emulated by piggyback: every tool result starts with a `<mesh-delta>` header.
- A per-agent fact sheet written atomically to `.mesh/context/<actor>.md`, which any rules-file agent can read.
- A hand-written MCP server (initialize, tools/list, tools/call) in about 40 lines.

**Run it**

```bash
mkdir mesh-poc && cd mesh-poc      # save the three files below here (Node 18+)
node demo.mjs                      # starts a hub and three scripted agents on port 7790
```

**hub.mjs**

```js
// hub.mjs: event-sourced mesh core. Log + presence + leases + router + fact sheets. Zero dependencies.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';

const PORT = +process.env.MESH_PORT || 7777, DIR = '.mesh', TTL = 300_000;
mkdirSync(`${DIR}/context`, { recursive: true });
const S = { seq: 0, prev: '0', intents: {}, presence: {}, inbox: {} }; // state = fold(events)
const log = [], subs = new Set();

// Overlap of two path scopes such as "src/api/**" and "src/api/auth/**"
const pre = p => p.replace(/\*+$/, '');
const overlap = (a, b) => a.some(x => b.some(y => pre(x).startsWith(pre(y)) || pre(y).startsWith(pre(x))));
const meet = (a = [], b = []) => a.filter(x => b.includes(x));

// 1. Every command becomes a hash-chained event
function emit(actor, kind, payload) {
  const e = { seq: ++S.seq, t: Date.now(), actor, kind, payload, prev: S.prev };
  e.hash = createHash('sha256').update(JSON.stringify(e)).digest('hex').slice(0, 16);
  S.prev = e.hash; log.push(e);
  appendFileSync(`${DIR}/events.jsonl`, JSON.stringify(e) + '\n');
  reduce(e); renderContexts();
  for (const s of subs) s.write(`data: ${JSON.stringify(e)}\n\n`);
  return e;
}

// 2. Reducer: the only place state changes
function reduce(e) {
  const p = e.payload;
  if (e.kind === 'intent.declared') S.intents[p.id] = { ...p, actor: e.actor, expires: e.t + TTL };
  if (e.kind === 'intent.released') delete S.intents[p.id];
  if (e.kind === 'presence') {
    S.presence[e.actor] = { ...p, seen: e.t };
    for (const i of Object.values(S.intents)) if (i.actor === e.actor) i.expires = e.t + TTL; // heartbeat renews leases
  }
}
const live = () => Object.values(S.intents).filter(i => i.expires > Date.now()); // expired leases vanish

// 3. Router: tier 1 interrupt, tier 2 digest, tier 3 ambient (canvas only)
function route(e) {
  if (e.kind !== 'intent.declared') return;
  const mine = e.payload;
  for (const other of live().filter(i => i.actor !== e.actor)) {
    const drift = mine.effect === 'breaking' && meet(mine.contracts, other.uses).length;
    const clash = overlap(mine.paths, other.paths);
    const tell = (to, tier, say) => (S.inbox[to] ||= []).push({ tier, say });
    if (drift) {
      tell(other.actor, 1, `BREAKING: ${meet(mine.contracts, other.uses).join(', ')} is being changed by ${e.actor} (intent ${mine.id}: ${mine.goal}).`);
      tell(e.actor, 2, `${other.actor} still uses ${meet(mine.contracts, other.uses).join(', ')}; keep the old version until they migrate.`);
    } else if (clash) {
      tell(e.actor, 1, `OVERLAP: ${other.actor} already holds ${other.paths.join(', ')} (intent ${other.id}).`);
      tell(other.actor, 2, `${e.actor} is starting work near ${mine.paths.join(', ')}.`);
    }
  }
}

// 4. Context compiler: a small fact sheet per actor, derived from state, never from history
function sheet(actor) {
  const me = live().filter(i => i.actor === actor), others = live().filter(i => i.actor !== actor);
  const uses = me.flatMap(i => i.uses || []);
  const pending = others.filter(i => i.effect === 'breaking' && meet(i.contracts, uses).length);
  return [`<!-- mesh v${S.seq} · actor ${actor} -->`, '## My work',
    ...(me.map(i => `- Intent ${i.id}: ${i.goal} (lease ${i.paths.join(', ')})`) || []),
    '## Contracts I use', ...(pending.length ? pending.map(i => `- ${meet(i.contracts, uses).join(', ')} PROPOSED CHANGE (breaking) by ${i.actor}, intent ${i.id}`) : ['- no pending changes']),
    '## Near me', ...(others.length ? others.map(i => `- ${i.actor}: ${i.goal} (${i.paths.join(', ')})`) : ['- nobody']), ''].join('\n');
}
function renderContexts() {  // atomic write: temp file, then rename, so readers never see half a file
  const actors = new Set([...Object.keys(S.presence), ...Object.values(S.intents).map(i => i.actor)]);
  for (const a of actors) { const f = `${DIR}/context/${a}.md`; writeFileSync(f + '.tmp', sheet(a)); renameSync(f + '.tmp', f); }
}

// 5. HTTP gateway: commands in, inbox out, SSE stream for the canvas
const body = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b ? JSON.parse(b) : {})); });
http.createServer(async (req, res) => {
  const json = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const [, route0, who] = req.url.split('/');
  if (req.method === 'POST' && route0 === 'cmd') {
    const { actor, kind, payload } = await body(req);
    if (kind === 'intent.declare') {
      const id = String(S.seq + 1), e = emit(actor, 'intent.declared', { id, effect: 'none', contracts: [], uses: [], ...payload });
      route(e); return json({ ok: true, intent: id, seq: e.seq });
    }
    if (kind === 'intent.release') { emit(actor, 'intent.released', payload); return json({ ok: true }); }
    if (kind === 'presence') { emit(actor, 'presence', payload); return json({ ok: true }); }
    return json({ ok: false, error: 'unknown command' }, 400);
  }
  if (route0 === 'inbox') { const q = (S.inbox[who] || []).splice(0); res.end(q.map(m => `[tier ${m.tier}] ${m.say}\n`).join('')); return; }
  if (route0 === 'context') { res.end(sheet(who)); return; }
  if (route0 === 'verify') { let prev = '0', ok = true; for (const e of log) { const { hash, ...rest } = e; ok &&= rest.prev === prev && hash === createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 16); prev = hash; } return json({ ok, events: log.length }); }
  if (route0 === 'events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); subs.add(res); req.on('close', () => subs.delete(res)); return; }
  res.writeHead(404).end();
}).listen(PORT, () => console.error(`hub listening on :${PORT}`));
```

**bridge.mjs**

```js
// bridge.mjs: MCP server over stdio (newline-delimited JSON-RPC 2.0) that forwards to the hub.
// Every tool result carries a <mesh-delta> header: push emulated by piggybacking on pull.
import { createInterface } from 'node:readline';

const ACTOR = process.env.MESH_ACTOR || 'agent', HUB = process.env.MESH_HUB || 'http://localhost:7777';
const post = (kind, payload) => fetch(`${HUB}/cmd`, { method: 'POST', body: JSON.stringify({ actor: ACTOR, kind, payload }) }).then(r => r.json());
const str = { type: 'string' }, strs = { type: 'array', items: str };

const TOOLS = {
  mesh_declare_intent: {
    description: 'Declare what you are about to change BEFORE editing. Returns warnings about overlaps and breaking-change drift.',
    inputSchema: { type: 'object', required: ['goal', 'paths'], properties: {
      goal: str, paths: strs, contracts: strs, uses: strs, effect: { enum: ['none', 'additive', 'breaking'] } } },
    run: a => post('intent.declare', a),
  },
  mesh_release: { description: 'Release an intent when your work is proposed or abandoned.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: str } }, run: a => post('intent.release', a) },
  mesh_status: { description: 'Show your current fact sheet: your work, contracts you use, neighbours.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => { await post('presence', { verb: 'reading', focus: '-' }); return (await fetch(`${HUB}/context/${ACTOR}`)).text(); } },
};

const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');

async function handle({ id, method, params }) {
  if (method === 'initialize')
    return send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agentmesh', version: '0.0.1' } } });
  if (method === 'tools/list')
    return send({ id, result: { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) } });
  if (method === 'tools/call') {
    const tool = TOOLS[params.name];
    if (!tool) return send({ id, error: { code: -32602, message: `unknown tool ${params.name}` } });
    const out = await tool.run(params.arguments ?? {});
    const delta = await (await fetch(`${HUB}/inbox/${ACTOR}`)).text();           // drain unseen news
    const text = (delta ? `<mesh-delta>\n${delta}</mesh-delta>\n` : '') + (typeof out === 'string' ? out : JSON.stringify(out));
    return send({ id, result: { content: [{ type: 'text', text }] } });
  }
  if (id !== undefined) send({ id, result: {} });                                  // ping and unknown requests
}

createInterface({ input: process.stdin }).on('line', l => l.trim() && handle(JSON.parse(l)).catch(e => console.error(e)));
```

**demo.mjs**

```js
// demo.mjs: the /api/auth drift scenario, end to end, through real MCP stdio bridges.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = '7790', env = { ...process.env, MESH_PORT: PORT, MESH_HUB: `http://localhost:${PORT}` };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const hub = spawn('node', [join(here, 'hub.mjs')], { env, stdio: ['ignore', 'ignore', 'inherit'] });
await sleep(500);

function agent(name) {                                    // an MCP client talking to one bridge
  const p = spawn('node', [join(here, 'bridge.mjs')], { env: { ...env, MESH_ACTOR: name }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map(); let n = 0;
  createInterface({ input: p.stdout }).on('line', l => { const m = JSON.parse(l); pending.get(m.id)?.(m); });
  const rpc = (method, params) => new Promise(r => { const id = ++n; pending.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const tool = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result.content[0].text;
  return { rpc, tool, stop: () => p.kill() };
}

const ui = agent('ui-agent'), be = agent('backend-agent'), db = agent('db-agent');
console.log('initialize ->', (await ui.rpc('initialize', { protocolVersion: '2025-06-18' })).result.serverInfo);
console.log('tools      ->', (await ui.rpc('tools/list')).result.tools.map(t => t.name).join(', '));

console.log('\n[1] ui-agent declares intent (uses the old endpoint)');
console.log(await ui.tool('mesh_declare_intent', { goal: 'Build login screen', paths: ['src/ui/auth/**'], uses: ['api:POST /api/auth'] }));

console.log('\n[2] backend-agent declares a BREAKING change to that endpoint');
console.log(await be.tool('mesh_declare_intent', { goal: 'Move auth to /api/v2/auth', paths: ['src/api/auth/**'], contracts: ['api:POST /api/auth'], effect: 'breaking' }));

console.log('\n[3] ui-agent calls its next tool and receives the delta (push emulated by piggyback)');
console.log(await ui.tool('mesh_status'));

console.log('[4] db-agent starts editing inside backend-agent\'s lease');
console.log(await db.tool('mesh_declare_intent', { goal: 'Add token table', paths: ['src/api/auth/token.ts'] }));

console.log('\n[5] integrity check of the hash-chained log');
console.log(await (await fetch(`http://localhost:${PORT}/verify`)).json());

console.log('\n[6] .mesh/context/ui-agent.md on disk (what Cursor or Codex would read via rules file)');
console.log(readFileSync('.mesh/context/ui-agent.md', 'utf8'));

[ui, be, db].forEach(a => a.stop()); hub.kill();
```

**Output of the demo** (trimmed)

```text
[1] ui-agent declares intent (uses the old endpoint)
{"ok":true,"intent":"1","seq":1}

[2] backend-agent declares a BREAKING change to that endpoint
<mesh-delta>
[tier 2] ui-agent still uses api:POST /api/auth; keep the old version until they migrate.
</mesh-delta>
{"ok":true,"intent":"2","seq":2}

[3] ui-agent calls its next tool and receives the delta
<mesh-delta>
[tier 1] BREAKING: api:POST /api/auth is being changed by backend-agent (intent 2: Move auth to /api/v2/auth).
</mesh-delta>
<!-- mesh v3 · actor ui-agent -->
## My work
- Intent 1: Build login screen (lease src/ui/auth/**)
## Contracts I use
- api:POST /api/auth PROPOSED CHANGE (breaking) by backend-agent, intent 2
## Near me
- backend-agent: Move auth to /api/v2/auth (src/api/auth/**)

[4] db-agent starts editing inside backend-agent's lease
<mesh-delta>
[tier 1] OVERLAP: backend-agent already holds src/api/auth/** (intent 2).
</mesh-delta>
{"ok":true,"intent":"4","seq":4}

[5] integrity check of the hash-chained log
{ ok: true, events: 4 }
```

**Wire it to a real agent.** Run `node hub.mjs`, then add the bridge to any MCP client (Claude Code, Cursor, Windsurf, Codex CLI), one entry per actor, and put three lines in the agent's rules file.

```json
{
  "mcpServers": {
    "agentmesh": {
      "command": "node",
      "args": ["/path/to/mesh-poc/bridge.mjs"],
      "env": { "MESH_ACTOR": "ui-agent", "MESH_HUB": "http://localhost:7777" }
    }
  }
}
```

```text
Before any multi-file edit, call mesh_declare_intent with your goal and paths.
Call mesh_status at the start of each task, and read any <mesh-delta> block first.
Treat [tier 1] lines as blocking: stop and adapt before continuing.
```

**What the prototype deliberately leaves out.** Lanes and overlays, snapshots and undo, the harness, authentication, the canvas, the standby Hub and contract extraction. The MCP bridge was tested with a scripted client, not yet with Cursor or Claude Code themselves. The next three build steps are: (1) the `mesh run` wrapper with overlay lanes; (2) snapshot and undo on git plumbing; (3) the T0 and T1 harness tiers with structured verdicts.

## Bold ideas beyond the brief

Six features that feel like science fiction and are buildable with today's tools; ghost contracts and rewind-one-agent carry the most value and should come first.

| Idea | What it feels like | How it is built | Effort |
| --- | --- | --- | --- |
| **Ghost contracts** | The UI agent builds against tomorrow's API while the backend agent is still typing it | Registry diffs the proposed contract, generates a typed client and mock handlers into consumer lanes, then swaps them for the real client on landing and replays recorded consumer calls | Medium |
| **Rewind one agent** | Undo what Backend Agent did in the last hour without touching anyone else's work | Stable change IDs plus intent links give inverse changesets; a dependency-aware cascade preview shows which other lanes built on it | Medium |
| **Live Wire** | The canvas edges pulse with real requests, and a 404 from the frontend to a removed endpoint points at the intent that removed it | A tiny proxy or OpenTelemetry in the VM records calls; observed edges join the static graph; failures are matched to contract changes | Medium |
| **Context capsules** | Hit a rate limit in Cursor and finish the task in Claude Code, or borrow a teammate's agent context read-only | A portable summary of intent, decisions, constraints, file references and last verdicts, generated from state rather than chat history | Small to medium |
| **The Referee** | A neutral agent spots two people building the same helper, or a naming mismatch between client and server, before either lands | A cheap model reads intent embeddings and the contract graph; it posts merge suggestions, writes a one-line decision record for every contract change, and sends a 5-line digest every 10 minutes | Medium |
| **Demo-safe trunk** | In a hackathon there is always a working demo, because trunk is rebuilt and smoke-tested every 10 minutes and tagged `demo-ready` | The queue plus a scripted smoke test in the Hub; the tag is the last green state | Small |

**Why these matter together.** Ghost contracts remove the waiting that drift causes, rewind makes bold parallel work safe, and Live Wire and the Referee catch the kinds of mismatch that types and graphs cannot see. Context capsules turn agents into interchangeable workers, so no single tool's limits can stall the team.
