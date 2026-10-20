# Agent Collaboration Protocols & Multi-Agent Orchestration — State of the Field (as of Oct 2026)

**Research brief:** inputs for the AgentMesh production roadmap.
**Method note:** web search was unavailable in this environment; all findings come from direct
retrieval of primary sources (protocol specs, vendor engineering blogs, official docs, GitHub
repos, arXiv abstracts). Where a claim could not be verified from a primary source it is marked
**UNVERIFIED** rather than asserted. Where a vendor's own docs contradict their marketing, the
docs win.

---

## 0. Executive summary (the 12 things that matter)

1. **MCP broke its own session model.** Spec revision `2026-07-28` removed protocol-level sessions,
   the `initialize` handshake, SSE resumability, Roots/Sampling/Logging (deprecated), and
   HTTP+SSE. MCP is now **stateless with per-request version negotiation**. Any MCP bridge is a
   re-implementation target on every spec revision (2025-06-18 → 2025-11-25 → 2026-07-28).
2. **A2A is now v1.0.0 and is Linux-Foundation/AAIF-governed** (Growth Stage, Aug 27 2026). It
   ships a **multi-tenancy `tenant` field**, **Agent Card signing (JWS + RFC 8785 JCS)**, mutual
   TLS, cursor pagination, and three bindings (JSON-RPC/HTTP+SSE, gRPC, HTTP/REST) with normative
   equivalence requirements. This is the most production-matured interop target.
3. **AG-UI 1.0** now has a *normative behavioural* spec (schema = structure, prose = behaviour) and
   first-class **subagent attribution** (`subagentRunId`, ownership rules, "attribution is not
   advisory", whole-run token accounting).
4. **The only widely-shipped dependency-aware shared task board is Claude Code agent teams**, and it
   is *experimental and off by default* (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). Its primitives
   are: file-locked task claims, dependency chains, JSON-file mailboxes, hook-based quality gates.
5. **No production tool solves file-level write collision automatically.** Claude Code solves it
   *socially* ("break the work so each teammate owns a different set of files") + worktree isolation.
   Emdash states outright it has "no agent-to-agent coordination". This is a real, open gap.
6. **Worktree isolation is the industry's default answer to collisions** — Claude Squad, dmux,
   Emdash, Conductor, Kangentic, Vibe Kanban, Orca, cmux, Superset, Nimbalyst, Parallel Code all
   ship worktree-per-agent.
7. **Cost, not capability, is the binding constraint.** Anthropic: token usage alone explains
   **80%** of BrowseComp performance variance; agents burn ~4× chat tokens, multi-agent ~15×.
8. **Eval methodology has shifted to outcome-based, not transcript-based.** Anthropic's Jan 2026
   guidance; MAST's 14 failure modes; τ-bench's `pass^k`; METR's finding that **~half of
   test-passing SWE-bench Verified PRs would be rejected by maintainers** (−24pp vs the automated
   grader).
9. **SQLite WAL is a single-host constraint** (no network filesystems, shared-memory `-shm`
   requirement). Correct for a self-hosted single-node hub; wrong for multi-host.
10. **Durable task handles are the emerging backpressure primitive**: MCP Tasks extension
    (`tasks/get`/`tasks/update`/`tasks/cancel`, TTL, suggested polling interval), A2A Task +
    push notifications, AG-UI run outcomes + cancellation.
11. **Observability now has a home**: OTel GenAI semantic conventions moved to a dedicated repo
    (`open-telemetry/semantic-conventions-genai`), with a dedicated `gen-ai-mcp` page, and MCP now
    documents `traceparent`/`tracestate`/`baggage` propagation in `_meta` (SEP-414).
12. **Market signal**: **Vibe Kanban is sunsetting** (Bloop shutdown; announcement linked from the
    repo). The board/orchestration category is consolidating fast around worktree+CLI-BYOA, and
    Vibe Kanban's own weakness list (no hard task dependencies) is exactly the gap AgentMesh's
    dependency chains fill.

---

## 1. Protocols & standards

### 1.1 Model Context Protocol (MCP)

**Current spec revision: `2026-07-28`.** Previous: `2025-11-25`; before that `2025-06-18`,
`2025-03-26`.
Source: <https://modelcontextprotocol.io/specification/2026-07-28> ·
<https://modelcontextprotocol.io/specification/2026-07-28/changelog.md> ·
schema of record: `modelcontextprotocol/specification/blob/main/schema/2026-07-28/schema.ts`.

**Major changes in `2026-07-28`** (verbatim from the changelog, with SEP links):

| # | Change | SEP |
|---|---|---|
| 1 | **Remove protocol-level sessions** and the `Mcp-Session-Id` header from Streamable HTTP. List endpoints no longer vary per-connection. Cross-call state uses **explicit, server-minted handles passed as ordinary tool arguments**. | SEP-2567 |
| 2 | **MCP is stateless**: `initialize`/`notifications/initialized` removed. Every request carries protocol version + client capabilities in `_meta` (`io.modelcontextprotocol/protocolVersion`, `io.modelcontextprotocol/clientCapabilities`); clients SHOULD send `io.modelcontextprotocol/clientInfo`; servers SHOULD send `io.modelcontextprotocol/serverInfo` in each result's `_meta`. Version mismatch → `UnsupportedProtocolVersionError`. | SEP-2575 |
| 3 | **New `server/discover` RPC** — servers MUST implement it; clients MAY call it up-front for version selection or as a backward-compat probe on STDIO. | SEP-2575 |
| 4 | HTTP GET endpoint and `resources/subscribe`/`unsubscribe` **replaced by `subscriptions/listen`**: a single long-lived POST-response stream for opted-in server→client notifications. Opt-in types: `toolsListChanged`, `promptsListChanged`, `resourcesListChanged`, `resourceSubscriptions`; server tags notifications with `io.modelcontextprotocol/subscriptionId`. Request-scoped notifications (`notifications/progress`, `notifications/message`) stay on their own request's response stream. | SEP-2575 |
| 5 | **Removed** `ping`, `logging/setLevel`, `notifications/roots/list_changed`. Log level now per-request via `io.modelcontextprotocol/logLevel` in `_meta`. | SEP-2575 |
| 6 | **Tasks moved out of core** into extension `io.modelcontextprotocol/tasks`. `tasks/result` (blocking) replaced by polling `tasks/get` + new `tasks/update`; `tasks/list` removed; servers may return task handles unsolicited without per-request opt-in. | SEP-2663 |
| 7 | **MRTR (Multi Round-Trip Requests)** replaces server-initiated requests (`roots/list`, `sampling/createMessage`, `elicitation/create`). Server returns `InputRequiredResult` (`resultType: "input_required"`) carrying `inputRequests`; client responds with `inputResponses` **on a retry of the original request**. | SEP-2322 |
| 8 | All results now carry a **required `resultType`**: `"complete"` or `"input_required"`. Clients MUST treat results from older servers that omit it as `"complete"`. | SEP-2322 |
| 9 | **SSE stream resumability and message redelivery REMOVED** from Streamable HTTP (`Last-Event-ID` and SSE event IDs gone). A broken response stream loses the in-flight request; clients **MUST re-issue it as a new request with a new request ID.** | SEP-2575 |

**Minor / operational changes** (all cite-able):
- OpenTelemetry trace-context propagation conventions documented for `_meta` keys `traceparent`, `tracestate`, `baggage` (SEP-414).
- Servers SHOULD return `tools/list` in **deterministic order** to enable client-side caching and improve LLM prompt-cache hit rates.
- `Mcp-Method` and `Mcp-Name` headers now **required** on Streamable HTTP POST; `x-mcp-header` allows custom headers from tool parameters (SEP-2243).
- `ttlMs` + `cacheScope` (`"public"`/`"private"`) now **required** on `tools/list`, `prompts/list`, `resources/list`, `resources/read`, `resources/templates/list` results via a new `CacheableResult` interface (SEP-2549).
- Resource-not-found error code `-32002` → `-32602` (Invalid Params) for JSON-RPC alignment.
- OAuth AS SHOULD include `iss` (RFC 9207); clients MUST validate a present `iss` against the recorded issuer before redeeming the code (SEP-2468).
- DCR requires `application_type` (SEP-837).
- Client credentials **bound to the issuing AS**: clients MUST key persisted credentials by issuer, MUST NOT reuse across AS, MUST re-register on AS change (SEP-2352).
- `inputSchema`/`outputSchema` loosened to any JSON Schema 2020-12 keywords; `structuredContent` any JSON value; `$ref` resolution requirements (SEP-2106).
- Removed `notifications/elicitation/complete` and `elicitationId` (added in 2025-11-25); servers correlate across retries via `requestState` instead.
- **Error-code allocation policy**: `-32000`–`-32019` implementation-defined (existing SDK use grandfathered), `-32020`–`-32099` reserved for MCP. `HeaderMismatchError` `-32020`, `MissingRequiredClientCapability` `-32021`, `UnsupportedProtocolVersion` `-32022`.

**Deprecated** (still functional, 12-month minimum deprecation window): Roots, Sampling, Logging
(SEP-2577); HTTP+SSE transport (deprecated since `2025-03-26`); `includeContext` values
`"thisServer"`/`"allServers"`; OAuth 2.0 Dynamic Client Registration (RFC 7591) in favour of
**Client ID Metadata Documents** (PR #2858).

**Governance (new in this revision):** a **feature lifecycle and deprecation policy** with
Active/Deprecated/Removed states, a **registry of deprecated features**, and a formal **SEP
workflow** (markdown files in `seps/`, PR-derived numbering, sponsors, status via PR labels).

**Extensions (opt-in, negotiated at init):** Tasks (durable handles, polling, mid-flight input),
MCP Apps (inline interactive UI), Skills over MCP (working group). Full Tasks spec lives in
`modelcontextprotocol/ext-tasks`.

**MCP Tasks mechanics** (https://modelcontextprotocol.io/extensions/tasks/overview):
- Client opts in per-request via `io.modelcontextprotocol/tasks` in capabilities; server advertises it in `server/discover`.
- Server returns `CreateTaskResult` (`resultType: "task"`) with `taskId`, status, TTL, suggested polling interval; the task is **durably created before the response is sent**.
- Poll with `tasks/get`; status ∈ `working`/`input_required`/`completed`/`failed`/`cancelled`.
- Mid-flight input: when `input_required`, `tasks/get` includes `inputRequests`; client fulfils via `tasks/update`.
- `tasks/cancel` is **cooperative** — server acks intent, client must not assume termination.
- Rationale given: no long-lived connections, crash resilience, progress visibility, mid-flight interaction, server-directed (one opt-in, no per-tool warmup).

**Security posture (from spec + auth tutorial):**
- Tool **annotations are untrusted** unless obtained from a trusted server.
- Hosts MUST obtain explicit user consent before invoking a tool; users must retain control.
- MCP "cannot enforce these security principles at the protocol level" — implementors must build consent/authorization flows.
- Auth flow: `401` + `WWW-Authenticate: Bearer realm="mcp", resource_metadata="https://…/.well-known/oauth-protected-resource"` → **PRM (RFC 9728)** → OIDC Discovery / OAuth AS Metadata (RFC 8414) → OAuth 2.1 with PKCE. STDIO servers may use env/third-party creds instead of OAuth.
- Explicitly recommended use cases for auth: user-specific data, auditing "who performed which actions", per-user consent, **rate limiting or usage tracking per user**.

### 1.2 Agent2Agent (A2A)

**Current: v1.0.0** (spec: <https://a2a-protocol.org/latest/specification/>; normative source:
`a2aproject/A2A` → `specification/a2a.proto`; non-normative JSON Schema generated from it).
Originated by Google, donated to the Linux Foundation; **accepted as a Growth Stage project at the
Agentic AI Foundation (AAIF) on Aug 27 2026** (blog: "A New Chapter for A2A: Joining the Agentic AI
Foundation"). Blog also announced the **A2A CLI** (`a2a`) on Oct 1 2026 as the official
command-line client for discovering/messaging/managing agents.

**v1.0 vs v0.3.0 — the four themes** (from <https://a2a-protocol.org/latest/whats-new-v1/>):
1. *Protocol maturity & standardization* — `a2a.proto` elevated from a gRPC-specific file to the **universal normative source of truth**; formal specs adopted: RFC 8785 (JCS), RFC 7515 (JWS), google.rpc.Status/ErrorInfo, ISO 8601, Google API Design Guidelines.
2. *Type safety* — discriminator `kind` fields removed for JSON member-based polymorphism; enums kebab-case → **SCREAMING_SNAKE_CASE** (ProtoJSON); camelCase JSON; ISO 8601 with ms precision.
3. *DX* — renamed operations (`message/send`→`SendMessage`, `message/stream`→`SendStreamingMessage`, `tasks/get`→`GetTask`, `tasks/list`→`ListTasks`, `tasks/cancel`→`CancelTask`, `tasks/resubscribe`→`SubscribeToTask`); **compound IDs removed** (simple UUIDs); **per-`AgentInterface` protocol version**; explicit `A2A-Version`/`A2A-Extensions` headers; **native multi-tenancy** in gRPC.
4. *Enterprise* — **Agent Card signature verification (JWS + JCS)**; all three bindings formalized with equivalence guarantees; **mutual TLS** security scheme; OAuth 2.0 updates (Device Code RFC 8628 added; implicit/password removed; **`pkce_required`** on Authorization Code flow); **cursor-based pagination**.

**Breaking changes with real impact:** Part type unification (critical); stream-event discriminator
pattern; Agent Card restructure (**`supportedInterfaces[]`** with `url`/`protocolBinding`/
`protocolVersion`/`tenant`); pagination; enum changes; `google.rpc.Status` error handling.

**Multi-tenancy (a first-class topic in the v1.0 docs)** — three complementary routing mechanisms:
1. **URL sub-path**: each agent advertises its own `url` in `supportedInterfaces`; the gateway routes `/billing/*`, `/support/*`.
2. **Auth header-based**: gateway inspects credentials (bearer claims/audience/scope, API key) already declared in the Agent Card's `securitySchemes`/`security`.
3. **Body-based `tenant` field**: every request message carries an **opaque** `tenant` string; the **client MUST always echo** the `tenant` from the selected `AgentInterface` entry, and MUST omit it if not set. Server MAY map it to agent ids, workspace slugs, org ids, etc.

**Security model:** Agent Card `securitySchemes` (APIKey, HTTPAuth, OAuth2 incl. authorization-code /
client-credentials / device-code flows, OpenID Connect, **MutualTls**); in-task authorization with
explicit agent and client responsibilities; server identity verification; **Agent Card signing**
(canonicalization requirements, signature format, verification) + caching rules.

**Bindings:** JSON-RPC 2.0 over HTTP (with SSE), **gRPC**, **HTTP/REST** — with §5
"Functional Equivalence Requirements", a Protocol Selection & Negotiation section, a Method Mapping
Reference, and Error Code Mappings. **This is the strongest precedent in the field for
"define the abstract protocol once, then define bindings with equivalence requirements."**

**SDKs:** Python (`a2a-sdk`), Go, JS/TS, Java, .NET, **Rust** (`a2a-lf`).

**Roadmap (from the repo README, i.e. NOT shipped):** formalize auth schemes/optional credentials
inside the AgentCard; investigate a `QuerySkill()` method for dynamically checking unsupported or
unanticipated skills; dynamic UX negotiation *within* a task (agent adding audio/video mid-conversation);
extending client-initiated methods beyond task management; streaming reliability and push-notification
improvements.

### 1.3 Agent Client Protocol (ACP)

v1 = latest; **v2 is in draft**. JSON-RPC 2.0 with methods (request/response) and notifications.
<https://agentclientprotocol.com/protocol/v1/overview>

- **Agent side (baseline):** `initialize` (negotiate versions + capabilities), `authenticate`,
  `session/new`, `session/prompt`. **Optional:** `session/load` (needs `loadSession`), `logout`
  (needs `agentCapabilities.auth.logout`), `session/set_mode`. **Notification:** `session/cancel`.
- **Client side (baseline):** `session/request_permission`. **Optional:** `fs/read_text_file`,
  `fs/write_text_file`, `terminal/create|output|release|wait_for_exit|kill`, `elicitation/create`.
  **Notification:** `elicitation/complete`.
- Agents are "programs that use generative AI to autonomously modify code. They typically run as
  **subprocesses of the Client**." Clients are typically code editors; the client owns the
  environment, user interaction, and resource access control.
- Origin: **Zed Industries** + **JetBrains** (both in the nav). Adoption is now real: **OpenHands
  "Agent Canvas"** runs "OpenHands, Claude Code, Codex, Gemini, Pi, OpenCode, or any
  **ACP-compatible agent** across local, remote, and cloud backends"; **Kiro** ships "ACP
  integrations".
- **Divergence note:** ACP v1 still specifies `elicitation/complete`, which MCP removed in
  `2026-07-28` — the two protocols have already forked on this point. A mesh that bridges both
  needs an explicit translation layer.

### 1.4 AG-UI (Agent–User Interaction Protocol)

**1.0** behavioural spec: <https://docs.ag-ui.com/spec/1.0/index.md> · changelog
<https://docs.ag-ui.com/spec/1.0/changelog.md>. Division of authority is stated as *deliberate and
absolute*: **the JSON Schema is authoritative for structure; the prose spec is authoritative for
behaviour.** Roles: **producer** (anything emitting the event stream) and **consumer**; each is
bound by both sets of rules in each direction. Conformance is judged **per stream**.

**1.0 vs 0.x (from the changelog):**
1. The spec now exists normatively (0.x defined shapes; behaviour lived in the TypeScript client).
2. **Runs report how they ended**: `RUN_FINISHED` carries an optional `outcome` (absent/success = success; interrupt outcome carries what it's waiting for; **cancelled** = stopped on purpose). Plus `Interrupt`, resume entries on the run input, and the interrupt–resume pattern.
3. **Subagents**: `subagentRunId` attribution, optional `SUBAGENT_STARTED` / `SUBAGENT_FINISHED` / `SUBAGENT_ERROR`, with rules for ownership, nesting, parallelism, termination.
4. **Reasoning replaces thinking**: 0.x `THINKING_*` retired for the reasoning family (spans, streamed reasoning messages matched by `messageId`, `REASONING_ENCRYPTED_VALUE` for provider artefacts the consumer stores and returns without reading). Retired shapes are *translated at the compatibility boundary, not dropped*.
5. **Activity events**: `ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA` (JSON Patch).
6. **Unknown vs malformed, normatively**: unrecognised events/fields/union members survive translation to enforcement (which drops unknown events, strips unknown members, warning); **a malformed known value is fatal**.
7. **Chunked form rules**: first chunks MUST carry what the opener requires (`messageId` + role semantics for text; `toolCallId` + `toolCallName` for tool calls); later chunks MAY omit; a continuation repeating an opener field with a conflicting value is fatal.
8. **Binary wire**: HTTP + Protobuf binding, negotiated by media type, 4-byte length-prefixed frames, cross-implementation parity pinned by a **shared byte corpus**.
9. **Capabilities in the schema** (previously three hand-written SDK copies). Omitted = undeclared; declarations are informative, **the stream is authoritative**; retrieval deliberately left to the implementation. Subagent list key is `subagents` (not `subAgents`).
10. Tool results carry content parts (`TOOL_CALL_RESULT.content`); part definitions renamed from direction-bound names (`InputContent`→`ContentPart`, `TextInputContent`→`TextPart`, `InputContentSource`→`PartSource`) because "a part named by direction is misnamed the moment it travels the other way". Wire unchanged; SDKs keep old names as aliases.

**Subagent rules worth copying verbatim into any coordination protocol** (https://docs.ag-ui.com/spec/1.0/events/subagents.md):
- "An id identifies an **invocation**, not an agent." A producer MUST NOT reuse a `subagentRunId` for a second invocation within a run, even for the same subagent. An id MAY reappear in a later run when a suspended invocation is continued.
- "**Attribution is not advisory.**" Once an entity is opened under an owner, every event continuing it MUST agree about that owner. A consumer MUST reject a continuation that disagrees.
- A producer that announces an invocation MUST do so before any event attributed to it; MUST NOT announce an already-active id; MUST NOT reuse a finished id; and **every announced invocation MUST be closed** (`SUBAGENT_FINISHED` or `SUBAGENT_ERROR`) before the run finishes.
- `SUBAGENT_ERROR` ends the invocation, **not the run** — a parent MAY handle a failed subagent and continue.
- "A subagent's model calls are the run's": **no subagent event carries token usage**; the run's terminal event reports the whole run's usage, subagents included.

**Transports** (<https://docs.ag-ui.com/spec/1.0/basic/transports>):
- A binding MUST provide: **ordered, complete delivery** of a run's events; delivery of the `RunAgentInput` that opens the exchange before any events; a **termination signal distinguishable from truncation**; and an error path for rejected input (structurally invalid `RunAgentInput` refused *before* `RUN_STARTED`, outside the stream).
- **Auth is a property of the binding and the application, not of the protocol** — "AG-UI defines no credential".
- Standard bindings: **HTTP + SSE** (mandatory for HTTP implementations) and **HTTP + Protobuf** (optional). Same request half; response encoding by content negotiation.
- **Truncation semantics**: a stream ending without a terminal event = a *truncated run*; it has no outcome; a consumer MUST NOT synthesize `RUN_FINISHED` or report it as successful; **re-running is a new run with a new `runId`**.
- Custom transports (WebSockets, message buses) allowed if they preserve the event model, patterns, and processing rules and satisfy the binding contract.

**Positioning** (from the AG-UI intro): the three prominent agentic protocols are AG-UI
(agent↔user), MCP (agent↔tools/data), A2A (agent↔agent). 1st-party integrations include LangChain,
CrewAI, **Microsoft Agent Framework**, Google ADK (+JS), **Google Antigravity**, AWS Strands Agents,
AWS Bedrock AgentCore, Mastra, Pydantic AI, Agno, LlamaIndex, AG2.

### 1.5 Orchestration frameworks (what they actually ship)

**OpenAI Swarm** — explicitly "**experimental, educational**"; README says it "is now replaced by the
OpenAI Agents SDK, which is a production-ready evolution of Swarm… We recommend migrating to the
Agents SDK for all production use cases." Primitives: `Agent` (instructions + tools) and
**handoffs**; stateless between calls; Chat Completions based.

**OpenAI Agents SDK** (production) — primitives: agents, **handoffs**, guardrails, sessions,
tracing, voice, realtime, **sandbox agents**, MCP, **context strategies**.
- Two orchestration patterns: **agents as tools** (manager keeps control, calls specialists via
  `Agent.as_tool()`, one agent owns the final answer, shared SDK guardrails in one place) and
  **handoffs** (a triage agent routes; the specialist becomes the active agent for the rest of the turn).
- Sandbox subsystem: `SandboxAgent` with `Manifest`, `Permissions`, `SnapshotSpec`, workspace
  entries; `Capabilities` = Filesystem / Shell / Memory / Skills / Compaction; sandbox clients =
  **Unix local**, **Docker**, **Responses WebSocket session**.
- Sessions backends: SQLAlchemy, advanced SQLite, **Redis**, **MongoDB**, **Dapr**, **Encrypted**.
- `MCP manager` for multiple MCP servers; MCP util; context strategies; run state; `run_in_background`.

**LangGraph / LangChain** (<https://docs.langchain.com/oss/python/langchain/multi-agent>) — explicitly
frames the choice as *"not every complex task requires this approach—a single agent with the right
(sometimes dynamic) tools and prompt can often achieve similar results."* Patterns and their rated
properties:

| Pattern | How it works | Distributed dev | Parallelization | Multi-hop | Direct user interaction |
|---|---|:-:|:-:|:-:|:-:|
| Subagents | main agent coordinates subagents **as tools**; all routing through main | ★★★★★ | ★★★★★ | ★★★★★ | ★ |
| Handoffs | tool calls update a state variable that triggers routing/config changes | – | ★★★★★ | ★★★★★ | ★★★★★ |
| Skills | specialized prompts/knowledge loaded on demand; one agent stays in control | ★★★★★ | ★★★ | ★★★★ | ★★★★★ |
| Router | classify input → one or more specialized agents, results synthesized | ★★★ | ★★★★★ | – | ★★★★ |
| Custom workflow | bespoke flows in LangGraph mixing deterministic logic + agentic behaviour | – | – | – | – |

Subagents are **stateless by default** (all memory in the main agent) → context isolation.
Supervisor ≠ router: the supervisor is a full agent maintaining conversation context across turns.
`Deep Agents` ships built-in subagents + skills + planning + virtual filesystem + context management.
`interrupts` allow human-in-the-loop **inside** a subagent.

**CrewAI** — "Crews" (autonomy, collaborative intelligence) vs "Flows" (precise, event-driven
control); high-level abstractions *and* low-level APIs; MIT.

**Microsoft Agent Framework (MAF)** — the AutoGen successor path. Python + C#/.NET (Go SDK in a
separate repo). "A strong fit if you… want **graph-based patterns such as sequential, concurrent,
handoff, and group collaboration**… care about **durability, restartability, observability,
governance, or human-in-the-loop control**." Supports Microsoft Foundry, Azure OpenAI, OpenAI, the
GitHub Copilot SDK.

**Anthropic — "Building effective agents"** (Dec 19 2024; the page now carries a note: "Much of the
tooling landscape described in this post has changed since December 2024. For our current approach,
see how we built Claude Managed Agents").
- The distinction everyone quotes: **workflows** = "LLMs and tools orchestrated through predefined
  code paths"; **agents** = "LLMs dynamically direct their own processes and tool usage".
- Building block: the **augmented LLM** (retrieval + tools + memory).
- Workflow patterns: **prompt chaining** (with programmatic "gates"), **routing**, **parallelization**
  (sectioning vs voting), **orchestrator-workers**, **evaluator-optimizer**. Agents = the autonomous loop.
- Key claim: "the most successful implementations use **simple, composable patterns rather than
  complex frameworks**"; frameworks "create extra layers of abstraction that can obscure the
  underlying prompts and responses, making them harder to debug"; *"incorrect assumptions about what's
  under the hood are a common source of customer error."*
- ACI (agent-computer interface) engineering rules: give the model tokens to think before it writes
  itself into a corner; keep formats close to natural internet text; avoid overhead; **poka-yoke**
  the tools. Concrete example: for SWE-bench they changed the tool to **always require absolute
  file paths** because relative paths failed after the agent left the root directory — "we found that
  the model used this method flawlessly."

**Anthropic — "How we built our multi-agent research system"** (Jun 13 2025) — the canonical
orchestrator/worker reference:
- **Architecture:** orchestrator-worker. A `LeadResearcher` analyzes, **saves its plan to Memory**
  (because the context window truncates past ~200k tokens), spawns specialized `Subagents` (2 shown,
  any number) that each independently web-search, evaluate tool results with **interleaved thinking**,
  and return findings; the lead synthesizes, decides whether to spawn more; finally a separate
  `CitationAgent` maps claims to source locations.
- **Headline numbers:** multi-agent (Opus 4 lead + Sonnet 4 subagents) **outperformed single-agent
  Opus 4 by 90.2%** on their internal research eval. On **BrowseComp**, three factors explained
  **95%** of performance variance: **token usage alone explains 80%**; number of tool calls and
  model choice are the other two. Upgrading to Sonnet 4 was a larger gain than doubling Sonnet 3.7's
  token budget.
- **Cost:** agents use ~**4×** the tokens of chat; multi-agent systems ~**15×**. Economic viability
  requires high task value.
- **Where it does NOT fit:** "domains that require all agents to share the same context or involve
  many dependencies between agents are not a good fit… most coding tasks involve fewer truly
  parallelizable tasks than research, and LLM agents are not yet great at coordinating and delegating
  to other agents in real time."
- **Eight prompting principles** (all directly reusable): think like your agents (build simulations
  and watch them step by step); teach the orchestrator to delegate (each subtask needs objective,
  output format, tool/source guidance, clear boundaries — otherwise agents duplicate work); scale
  effort to query complexity (embed explicit budgets: simple = 1 agent / 3–10 tool calls; comparison
  = 2–4 subagents / 10–15 calls each; complex = 10+ subagents); tool design is critical (bad tool
  descriptions send agents "down completely wrong paths"); let agents improve themselves (a
  tool-testing agent rewrote a flawed MCP tool description → **40% decrease in task completion time**
  for later agents); start wide then narrow; guide the thinking process; parallel tool calling
  (3–5 parallel subagents + 3+ parallel tools per subagent **cut research time by up to 90%**).
- **Evaluation:** start with ~20 queries; **single LLM judge, single prompt, 0.0–1.0 score plus
  pass/fail** was the most consistent with human judgement; rubric dimensions = factual accuracy,
  citation accuracy, completeness, source quality, tool efficiency; human eval catches what automation
  misses (their early agents "consistently chose SEO-optimized content farms over authoritative but
  less highly-ranked sources").
- **Production engineering:** *"Agents are stateful and errors compound."* They cannot restart from
  the beginning, so they built systems that **resume from where the agent was** when errors occur;
  they let the agent know a tool is failing so it can adapt, combined with deterministic retry logic
  and regular checkpoints. Debugging required **full production tracing**; they monitor "agent decision
  patterns and interaction structures" without monitoring conversation contents (privacy). Deploys use
  **rainbow deployments** because "agents might be anywhere in their process."
- **Known bottleneck:** *"Currently, our lead agents execute subagents **synchronously**… the entire
  system can be blocked while waiting for a single subagent to finish searching. Asynchronous
  execution would enable additional parallelism… But this asynchronicity adds challenges in result
  coordination, state consistency, and error propagation."*
- **Appendix patterns:** **end-state evaluation** over turn-by-turn analysis; long-horizon management
  via summarizing completed phases into external memory and spawning fresh subagents with clean
  contexts; **"subagent output to a filesystem to minimize the 'game of telephone'"** — artifacts persist
  independently and only lightweight references travel back to the coordinator.

**Anthropic — "Effective harnesses for long-running agents"** (Nov 26 2025) — the best concrete
answer to agent handoff across sessions:
- Two-part solution: an **initializer agent** (first run only) that writes `init.sh`, a
  `claude-progress.txt` log, and an initial git commit; and a **coding agent** for every subsequent
  session that makes incremental progress and leaves structured updates, ending in a "clean state"
  appropriate for merging to main.
- Two documented failure modes: (1) the agent tries to do too much at once and runs out of context
  mid-implementation, leaving the next session to guess; (2) a later agent sees progress and
  **declares the job done**.
- Even Opus 4.5 on the Agent SDK, in a loop with only "build a clone of claude.ai", falls short of a
  production-quality app.
- Key insight: a fresh context window needs a *fast* way to learn the state of work — the
  `claude-progress.txt` file plus git history, with inspiration taken from how effective human
  engineers work.

**Anthropic — "Scaling Managed Agents: Decoupling the brain from the hands"** (Apr 8 2026) — the
most relevant architectural precedent for a coordination service:
- *"Harnesses encode assumptions that go stale as models improve."* Example given: Sonnet 4.5
  exhibited "context anxiety" (wrapping up early as it sensed the context limit), so they added
  context resets — but on Opus 4.5 the behaviour was gone and **the resets became dead weight**.
- They virtualized three things, each as a stable interface: **session** (append-only log of
  everything that happened), **harness** (the loop that calls Claude and routes tool calls),
  **sandbox** (where code runs and files are edited). Implementation of each can be swapped without
  disturbing the others.
- **"Don't adopt a pet."** Coupling session+harness+sandbox into one container made the server a
  hand-tended individual: if a container failed the session was lost; if it hung, they had to nurse
  it back. Their only window in was the WebSocket event stream, which couldn't distinguish a harness
  bug from a dropped packet from a container going offline.
- **The decoupled shape:** harness calls the container like any other tool — `execute(name, input) → string`;
  a dead container becomes a tool-call error the model may retry, with `provision({resources})`
  re-initializing a fresh one. The harness is also cattle: it reboots with `wake(sessionId)`, reads
  via `getSession(id)`, resumes from the last event, and appends with `emitEvent(id, event)`.
- **Security boundary (important for a mesh):** in the coupled design, untrusted generated code ran
  in the same container as credentials, so a prompt injection only had to convince Claude to read
  its own environment; with the token, attackers could spawn fresh unrestricted sessions. The
  structural fix: **tokens are never reachable from the sandbox**. Auth is bundled with a resource
  or held in a vault outside the sandbox; for Git, the repo access token clones the repo at sandbox
  init and is wired into the local git remote so `git push`/`pull` work without the agent handling
  the token; for custom tools, MCP OAuth tokens live in a vault and a dedicated proxy fetches them —
  **"the harness is never made aware of any credentials."**
- **"The session is not Claude's context window."** Compaction and the memory tool are *irreversible*
  decisions about what to keep. In Managed Agents the **session log is the context object**:
  `getEvents()` lets the brain interrogate context by **positional slices** — resume where it stopped,
  rewind a few events to see the lead-up, re-read context before a specific action. Recoverable
  context storage lives in the session; arbitrary context management lives in the harness.
- **Many brains, many hands:** decoupling removed the need to peer customer VPCs (previously the
  only path) and removed the per-session container-provisioning cost — the dead time expressed as
  **TTFT** (time-to-first-token), "the latency the user most acutely feels."

### 1.6 Quick reference — protocol status table

| Protocol | Latest version | Date | Status | Normative artifact |
|---|---|---|---|---|
| MCP | `2026-07-28` | 2026 | Living spec, 12-mo deprecation window | `schema/2026-07-28/schema.ts` (TypeScript) |
| A2A | **v1.0.0** | 2026 | Linux Foundation / **AAIF Growth Stage** (Aug 27 2026) | `specification/a2a.proto` |
| AG-UI | **1.0** | 2026 | Normative behavioural spec | `spec/1.0/schema.json` + prose |
| ACP | v1 (latest) / v2 draft | 2026 | Zed + JetBrains | JSON Schema per method |

---

## 2. Conflict avoidance & coordination mechanics

### 2.1 Claude Code agent teams — the only shipped dependency-aware shared board

Source: <https://docs.claude.com/en/docs/claude-code/agent-teams.md>

**Status: experimental, disabled by default.** Enable with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
in `settings.json` or env. "Without that variable, no team is set up at session start, no team
directories are written, and Claude does not spawn or propose teammates."

**Team = 4 components:** Team lead (the main session), Teammates (separate Claude Code instances),
**Task list** (shared work items teammates claim and complete), **Mailbox** (inter-agent messaging).

**The locking primitive — quoted:**
> "Task claiming uses **file locking** to prevent race conditions when multiple teammates try to
> claim the same task simultaneously."

**Task model:** three states (pending / in progress / completed); tasks can **depend on other
tasks**; "a pending task with unresolved dependencies **cannot be claimed** until those
dependencies are completed." Dependencies are managed automatically — completing a task unblocks
dependents with no human action.

**Two coordination modes:** lead assigns explicitly, **or self-claim** — "after finishing a task, a
teammate picks up the next unassigned, unblocked task on its own." Agents **without** the Task tools
coordinate purely through messages.

**Storage layout (this is the concrete, citable design):**
- Mailbox: `~/.claude/teams/{team-name}/inboxes/{agent-name}.json` — one JSON file per agent.
  Claude Code **validates every entry on read**; entries not matching the message format are
  **reported as errors and removed**, and valid messages are still delivered.
  "Claude Code reports a message as sent **only when the write to the recipient's mailbox file
  succeeds**… When the write fails, for example because the disk is full or the mailbox directory
  isn't writable, the sending agent receives an error and **nothing is sent**."
- Team config: `~/.claude/teams/{team-name}/config.json` — **removed when the session ends**;
  holds session IDs, tmux pane IDs, and a `members` array (each member's name + agent ID; the
  lead's entry always carries agent type `team-lead`). "don't edit it by hand or pre-author it:
  your changes are overwritten on the next state update." Teammates can read it to discover members.
- Task list: `~/.claude/tasks/{team-name}/` — **stays on disk** after the session; retention via
  `cleanupPeriodDays`.
- Team name is session-derived: `session-` + first 8 chars of the session ID.
- **There is no project-level team config** — `.claude/teams/teams.json` in a repo is *not*
  recognized; Claude treats it as an ordinary file.

**Quality gates via hooks:** `TeammateIdle` (exit 2 = send feedback, keep working), `TaskCreated`
(exit 2 = prevent creation), `TaskCompleted` (exit 2 = prevent completion).

**File-conflict policy is social, not mechanical — quoted in full:**
> "Two teammates editing the same file leads to overwrites. **Break the work so each teammate owns
> a different set of files.**"

There is **no file-level lock** in agent teams. Collision avoidance = scope discipline + worktrees.

**Display modes:** *in-process* (default; teammates selectable in the agent panel, Enter to message
directly, Escape to interrupt) and *split panes* (each teammate gets a pane; **requires tmux or
iTerm2**; not supported in VS Code's integrated terminal, Windows Terminal, or Ghostty). Idle rows
hide after 30s and collapse to an "N idle agents" row beyond three.

**Enabling teams changes ordinary delegation:** a named subagent launches **as a teammate**, so teams
can form unasked. `-p` / non-interactive / Agent SDK sessions never spawn teammates.

**Documented limitations (verbatim list):**
- No session resumption with in-process teammates: `/resume` and `/rewind` do not restore them; "the
  lead may attempt to message teammates that no longer exists."
- **Task status can lag**: teammates sometimes fail to mark tasks completed, **which blocks dependent
  tasks**; fix manually or nudge the lead.
- Shutdown can be slow (teammate finishes its current request/tool call first).
- **One team per session** — cannot create additional named teams or share a team across sessions.
- **No nested teams** — teammates cannot spawn teammates; only the lead manages the team.
- No background subagents from in-process teammates (a teammate's background work can't outlive the
  lead's process); `background: true` subagent definitions error; `run_in_background: true` fails or
  silently runs in the foreground.
- **Lead is fixed** for the session's lifetime; leadership cannot be transferred.
- Permissions are set at spawn; per-teammate permission modes cannot be set at spawn time.
- Split panes require tmux or iTerm2.

**Troubleshooting headings** (documented failure modes): teammates not appearing; Claude spawns
teammates instead of subagents; too many permission prompts; agents stopping early; **orphaned tmux
sessions**.

**Subagent vs agent team (the official comparison):**

| | Subagents | Agent teams |
|---|---|---|
| Context | Own context window; results return to the caller | Own context window; **fully independent** |
| Communication | Return a result to the caller | **Teammates message each other directly** |
| Coordination | Main agent manages all work | **Self-coordination through messages + shared task list** |
| Best for | Focused tasks where only the result matters | Complex work requiring discussion/collaboration |
| Token cost | Lower: results summarized back to main context | **Higher: each teammate is a separate Claude instance** |

### 2.2 Git worktrees as the ecosystem's default collision answer

- **Claude Code worktrees** (<https://docs.claude.com/en/docs/claude-code/worktrees.md>): `claude
  --worktree <name>` (or `-w`) creates `.claude/worktrees/<name>/` on branch `worktree-<name>`;
  `EnterWorktree` tool lets a session switch between worktrees (the previous one stays on disk
  untouched). Subagents can be spawned with `isolation: worktree`. **`.worktreeinclude`** copies
  gitignored files into new worktrees. **Gotcha:** `${CLAUDE_PROJECT_DIR}` does **not** follow the
  worktree (hooks still run from the original project root) while `cwd` does. Entering a path
  outside `.claude/worktrees/` requires approval — only `bypassPermissions` skips it. Non-git VCS is
  supported via hooks that replace the git logic.
- **Claude Squad** (<https://github.com/smtg-ai/claude-squad>, Go TUI, AGPL-3.0): "**Each task gets
  its own isolated git workspace, so no conflicts**." tmux-based; runs Claude Code, Codex, Gemini,
  Aider, OpenCode, Amp; config at `~/.claude-squad/config.json` with `profiles[] = {name, program}`;
  `--autoyes` for unattended auto-accept (experimental).
- **dmux** (<https://github.com/standardagents/dmux>, ★1.8k): "creates a tmux pane for each task.
  **Every pane gets its own git worktree and branch so agents work in complete isolation.**"
  Agents: Claude Code, Codex, OpenCode, Cline CLI, Gemini CLI, Qwen CLI, Amp CLI, pi CLI, Cursor CLI,
  Copilot CLI, Crush CLI. Also: goal launches, multi-select agent launches, AI naming of
  branches/commits/panes, **durable terminals** (tracks a running agent and resumes that conversation
  when the pane is recreated), smart merging, macOS notifications, built-in file browser, pane
  visibility controls, multi-project, **lifecycle hooks** (worktree create, pre-merge, post-merge).
- **Emdash** (<https://github.com/generalaction/emdash>, ★6.0k, **YC W26**, Apache-2.0): desktop app;
  each task in its own Git worktree; local **and remote over SSH/SFTP**; ticket intake from Linear,
  GitHub, Jira, GitLab, Asana, Monday.com, Trello, Plane, Forgejo, Featurebase, Plain, YouTrack;
  **34 CLI providers auto-detected** (Claude Code, Codex, Cursor, OpenCode, Amp, Devin, Qwen Code,
  Droid, Copilot…); **`$EMDASH_PORT` injection** to solve port collisions; **SQLite local storage,
  local-first — no code/chat sent to Emdash servers**. Its published weakness list includes:
  "**No agent-to-agent coordination — each runs independently**."
- **Conductor** (<https://www.conductor.build/>, closed source, macOS): runs Claude Code, Codex,
  Cursor, OpenCode in parallel; "Each task gets its own workspace, branch, files, terminal, diff, and
  review path." Its docs make the **workspace-sharing decision explicit**: *multiple workspaces* for
  independently-shippable work; *one workspace, multiple agents* when work shares a branch/code
  state/context — with the tradeoff stated plainly: "**agents in the same workspace can edit the same
  files.** Use this when shared context matters more than separation." (latest release 0.91.0)
- **Kangentic** (<https://github.com/Kangentic/kangentic>, AGPL-3.0, npm `kangentic`): "A coding agent
  can carry a task on its own, and git worktrees let several run at once. **The limit then becomes
  you.**" Board with columns (To Do / Planning / Executing / Code Review); each card shows model,
  context-window usage, and the agent's last message, with a marker for cards needing you. Each
  **column carries its own agent, model, effort, and permission mode**; the board config is committed
  to the repo as `kangentic.json` while tasks and sessions stay on each machine. **Automations**
  trigger on column entry / agent turn end / task leave → send a message or slash command, run a
  script, call a webhook, notify, or move the card; "a condition in plain words, checked by an agent,
  decides whether a step runs." **Workflows**: a workflow agent produces a brief, reviews linked
  tasks, and Start begins — "**each task starts when the tasks it waits for reach Done**, and one
  workflow can span several projects." **MCP server** lets a running agent create tasks, move its own
  card, search past conversations, and **message another task's agent**. Mobile companion over an
  E2E-encrypted relay.
- **Kangentic relay** (<https://github.com/Kangentic/relay>) — an unusually honest, citable design
  doc for a coordination transport: "a tiny, **stateless, blind WebSocket rendezvous relay**… forwards
  only **opaque ciphertext frames** between two peers that both dial out to it. **It authenticates
  nothing and reads nothing.**" Routing is purely by a `slot` query parameter; an optional
  `role=desktop|mobile` is a dashboard hint only — "it is unauthenticated, it never reaches a
  pairing, routing, cap, or rate-limit decision." `src/**` has **zero runtime dependency** on the
  crypto layer, so the shipped server provably cannot decrypt. **"Honest metadata disclosure"** —
  the relay operator can still observe source/destination IPs, connection timing, frame sizes and
  frequency, and **the pairing graph** (which slot ids co-occur). The slot id travels in the URL and
  TLS terminates at Cloudflare on the hosted instance, so Cloudflare sees it — but the slot is a
  routing label, not key material; the pairing token (pre-shared key) never leaves the QR code. Each
  session runs its own **end-to-end Noise handshake** inside the tunnel.

### 2.3 The broader "agent-native IDE" landscape

Source: <https://github.com/pinion05/awesome-agent-ide> (CC0, curated ranked comparison; scoring
weights: technical depth 20%, stability 15%, UX 15%, ecosystem 15%, scalability 15%, platform 10%,
OSS health 10%).

| Rank | Tool | Score | License | Stars | Coordination primitive shipped |
|---|---|---|---|---|---|
| 1 | Orca | 8.6 | MIT | 18.3k | SSH worktrees, Computer Use, Design Mode (click a real Chromium element → HTML/CSS/screenshot into the prompt), diff annotation, daily releases |
| 2 | Emdash | 8.3 | Apache-2.0 | 5.1k | Worktrees + 12 ticket integrations + 34 agents + `$EMDASH_PORT`; **no agent-to-agent coordination** |
| 3 | Superset | 7.5 | Other | 12.4k | **Most access surfaces: desktop + CLI + TS SDK + MCP server**; scheduled automations; Slack/Linear → workspace |
| 4 | cmux | 7.0 | GPL-3.0 + commercial | 24.4k | "A primitive, not a solution"; `cmux claude-teams` one-command teammate mode **without tmux**; OSC 9/99/777 notification detection; full CLI + socket API |
| 5 | Parallel Code | 6.7 | MIT | 0.8k | **Docker sandboxing** via project `.parallel-code/Dockerfile`; "AI Arena" races agents head-to-head and merges the winner; coverage radar |
| 6 | Claude Squad | 6.5 | AGPL-3.0 | 8.1k | tmux + worktree; 0.6% issue/star ratio; weak visual diff review |
| 7 | Vibe Kanban | 6.3 | Apache-2.0 | — | Kanban card = worktree = agent; **MCP server for autonomous card decomposition**; **no hard task dependencies**; **now sunsetting** |
| 8 | Nimbalyst | 6.2 | MIT | — | Worktree as first-class session primitive; iOS companion |
| 9 | Intent | 6.1 | Closed | — | **Spec-driven coordination, Coordinator/Verifier agents** |
| 10 | Conductor | 5.7 | Closed | — | Best Mac polish; BYO login |

**Market signal:** the Vibe Kanban README now leads with "**Vibe Kanban is sunsetting**"
(<https://www.vibekanban.com/blog/shutdown>). The category is consolidating around
*worktree isolation + BYO CLI agent*, and the two board tools' own published weaknesses —
"no agent-to-agent coordination" (Emdash) and "no hard task dependencies" (Vibe Kanban) — are
exactly the gaps a dependency-aware coordination protocol should own.

### 2.4 Other agents with coordination surfaces

- **OpenHands → "Agent Canvas"** (<https://github.com/All-Hands-AI/OpenHands>): self-hosted
  developer control center; "Run OpenHands, Claude Code, Codex, Gemini, Pi, OpenCode, or **any
  ACP-compatible agent** across local, remote, and cloud backends"; npm `@openhands/agent-canvas`;
  automations include "automatically decomposing GitHub issues into tasks"; self-hosting guide;
  in-**beta**.
- **Cursor** (cursor.com/docs): cloud agents + worktrees + subagents + `claude agents` agent view +
  projects + cloud-agent **self-hosted** runtimes (pool / my-machines / computer-use) + private
  connectivity + security agents + bugbot + approval agents + rollouts. **Caveat: the `llms.txt`
  index links for `worktrees` and `subagents` both 404** — docs are mid-restructure; treat Cursor's
  coordination details as **UNVERIFIED at the doc level**.
- **Aider**: terminal pair-programming with git-aware edits and a repo map. Not a coordinator; single
  agent.
- **factory.ai**: docs index confirms an OpenAPI spec, plus app settings for "Spec mode", "Autonomy",
  "Worktrees", "Droid Computers", "Subagent sounds". Detailed coordination semantics **UNVERIFIED**.
- **UNVERIFIED in this pass** (no primary source retrieved; do not cite): Codex/Codex Cloud
  multi-agent internals, JetBrains AI agents, Cline, Roo Code, SWE-agent, Devin, Jules, GitHub
  Copilot Workspace, Amazon Q Developer Agent, Warp, GitKraken Kepler, Tessl, Cursor's current
  subagent/worktree docs, AutoGen's post-2025 status relative to MAF.

### 2.5 Synthesised failure-mode catalogue (what actually breaks)

From Claude Code's own troubleshooting + the tool landscape:

1. **Same-file overwrites** — no shipped automatic file-level arbitration (Claude Code: "Two teammates editing the same file leads to overwrites").
2. **Task-status lag → dependency deadlock** — teammates fail to mark tasks complete; dependents stay blocked.
3. **Dangling references after resume** — lead messages teammates that no longer exist.
4. **Slow / non-deterministic shutdown** — teammates finish the current tool call first.
5. **Orphaned tmux sessions** — pane/session leakage on crash.
6. **Permission-prompt storms** — each teammate prompting independently.
7. **Early stopping** — a later agent sees partial progress and declares the job done (Anthropic's documented failure mode #2).
8. **Mailbox write failure** — disk full / unwritable dir ⇒ message silently lost (mitigated: error surfaced, nothing sent).
9. **Worktree disk bloat** — 20 worktrees is already a problem (Vibe Kanban).
10. **Port collisions** between parallel dev servers — solved ad hoc (`$EMDASH_PORT`).
11. **Feature-flag side effects** — enabling teams silently converts named subagents into teammates.
12. **Multi-tenant routing ambiguity** — A2A's `tenant` field and `supportedInterfaces` exist precisely because of this.

---

## 3. Production-scale requirements

### 3.1 Storage

**SQLite WAL** (<https://sqlite.org/wal.html>; since 3.7.0, 2010-07-21):
- **Advantages:** "significantly faster in most scenarios"; **"WAL provides more concurrency as readers do not block writers and a writer does not block readers. Reading and writing can proceed concurrently"**; more sequential disk I/O; many fewer `fsync()` calls (more robust on systems where fsync is broken).
- **Disadvantages (the ones that bite at scale):**
  - **"All processes using a database must be on the same host computer; WAL does not work over a network filesystem."** (the wal-index requires shared memory).
  - Transactions spanning multiple `ATTACH`ed DBs are atomic per-DB, **not** across DBs.
  - `page_size` cannot be changed in WAL mode.
  - **"It is not possible to open read-only WAL databases"** without write access to the `-shm` wal-index (since 3.22.0 a read-only WAL DB can be opened if `-shm`/`-wal` already exist or the DB is immutable).
  - WAL is ~1–2% slower for read-mostly workloads.
  - Adds a quasi-persistent `-wal` and `-shm` file (backup discipline must use the backup API, not `cp`).
  - Checkpointing: automatic (default 1000 pages) and application-initiated (`PRAGMA wal_checkpoint`).
- **Verdict for AgentMesh:** SQLite WAL is exactly right for a **single-node self-hosted hub** and
  wrong for multi-host. Clients being remote over LAN/Tailscale is fine — the constraint is on
  *server-side* processes, not clients. If multi-host is on the roadmap, the escape hatches are
  Postgres (LISTEN/NOTIFY or an outbox table), or a partitioned/sharded hub with a single writer.

**CRDT libraries** (the relevant trio for a "delta-state semantic CRDT" / lane-history design):
- **Yjs** (MIT): CRDT framework exposing internal structures as **shared types** (Map/Array) with
  auto-distribution and conflict-free merging; network-agnostic (p2p), offline editing, version
  snapshots, undo/redo, shared cursors; "scales well with an unlimited number of users."
- **Automerge** (Ink & Switch): Rust core + WASM/JS + C; several CRDTs, a **compact binary format**,
  and a **sync protocol** for efficient change transmission; explicit goal: "**Automerge aims to be
  PostgreSQL for your local-first app**"; **Automerge 3 achieved ~10× memory reduction**.
- **Loro** (<https://github.com/loro-dev/loro>, 1.0 released): Rust + JS(WASM) + Swift; P2P sync,
  automatic merging, local availability, delta updates; **Fugue** text CRDT, rich-text CRDT, movable
  tree/list, LWW map; **fast document loading**, **time travel through history**, **version control
  with real-time collaboration** (imports an entire Git DAG into a Loro doc, preserving history and
  enabling fast version switching), and a **shallow snapshot** that behaves like `git clone --depth`.
- **Design implication:** Loro's "version control with real-time collaboration" and Automerge's
  sync protocol are the *same primitive* as AgentMesh's "MeshVCS lanes" + "delta-state semantic
  CRDT". Choosing an existing CRDT (rather than a bespoke Lamport-vector-clock diff) buys
  battle-tested merge semantics, a wire format, and time-travel.

**Event sourcing** — Anthropic's Managed Agents is the reference implementation: the **session is an
append-only event log**; the harness is replaceable and boots with `wake(sessionId)`, reads with
`getSession(id)`, appends with `emitEvent(id, event)`. This validates AgentMesh's "event-sourced
coordination daemon" framing and supplies the exact recovery API to copy.

### 3.2 Transports: SSE vs WebSocket vs gRPC

- **MCP**: Streamable HTTP. As of `2026-07-28`, **SSE resumability and `Last-Event-ID` are removed**
  — a broken stream loses the in-flight request and the client MUST re-issue with a new request ID.
  The new `subscriptions/listen` is a single long-lived POST-response stream for *opted-in*
  server→client notifications. (The older HTTP+SSE transport is deprecated.)
- **A2A**: JSON-RPC over HTTP with SSE, **plus gRPC**, **plus HTTP/REST**, with normative
  *functional equivalence requirements* and an explicit method-mapping reference.
- **AG-UI**: **HTTP+SSE** (mandatory for HTTP implementations) and **HTTP+Protobuf** (optional,
  4-byte length-prefixed frames), selected by content negotiation, with a **shared byte corpus** to
  pin cross-implementation parity. Custom transports (WebSockets, message buses) allowed if they
  satisfy the binding contract (ordered complete delivery, input-before-events, a termination
  signal distinguishable from truncation, an error path outside the stream).
- **ACP**: JSON-RPC over stdio — agents are subprocesses of the client.
- **Kangentic relay**: WebSocket rendezvous for NAT traversal, blind and stateless.

**Recommendation shape for AgentMesh:** keep the *event model* transport-independent (AG-UI's
"binding" discipline) and implement two bindings: HTTP+SSE (proxy-friendly, trivial for
MCP-bridged clients) and — if wire efficiency or true bidirectional control matters — HTTP+Protobuf
or gRPC. Do **not** rely on SSE resumability if you want crash-resumed streams: MCP just removed it
from the most widely deployed LLM protocol, so a resumable event log must be your own
(last-event-id / sequence-number based) and stored in your event store. Note A2A's
"functional equivalence" framing is the pattern for specifying multiple bindings without forking
semantics.

### 3.3 Auth & identity

- **MCP / OAuth 2.1**: PRM (RFC 9728) → OIDC/RFC 8414 discovery → PKCE; `iss` validation (RFC 9207);
  credentials keyed by issuer (SEP-2352); DCR deprecated in favour of Client ID Metadata Documents.
- **A2A**: Agent Card `securitySchemes` (APIKey, HTTPAuth, OAuth2 with authorization-code /
  client-credentials / device-code, OpenID Connect, **mutual TLS**); **Agent Card signing with JWS
  over RFC 8785 JCS**; in-task authorization with explicit agent and client responsibilities.
  **Multi-tenancy** via URL sub-path, auth-header inspection, or the opaque `tenant` field.
- **Agent identity is an unsolved standard.** No spec found defines an "agent identity" primitive
  with agent-to-agent trust. AgentMesh's ed25519 + revocation + rotation is a reasonable homegrown
  choice, but it is **not** interoperable; the nearest interop anchors are (a) A2A's signed Agent
  Card and (b) mTLS as an A2A security scheme.
- **Untrusted-transport pattern**: Kangentic's blind relay + per-session **end-to-end Noise
  handshake**, with the crypto layer kept out of the server's runtime dependency graph, plus explicit
  metadata disclosure. This is the right shape for a mesh that must traverse untrusted networks.

### 3.4 Rate limiting, backpressure, caching

- MCP explicitly names "**rate limiting or usage tracking per user**" as a reason to implement
  authorization.
- **MCP Tasks** is the cleanest backpressure primitive found: a server returns a durable handle
  instead of blocking; the handle carries **TTL** and a **suggested polling interval**; `tasks/cancel`
  is cooperative. This turns "queue too long" into "here is a ticket" — no long-lived connection
  required, and it survives client restarts.
- **MCP `CacheableResult`** (SEP-2549): `ttlMs` (freshness hint) + `cacheScope` (`public`/`private`,
  controlling whether shared intermediaries may cache) on list/read results; plus `listChanged`
  notifications and the deterministic `tools/list` ordering to improve prompt-cache hit rates.
- **A2A**: cursor-based pagination for scalable task listing; push-notification configs per task.
- **AG-UI**: `RUN_FINISHED` carries an `outcome`; a `cancelled` outcome marks deliberate
  termination; a truncated stream is explicitly *not* a success.

### 3.5 Observability

- **OTel GenAI semantic conventions have moved** to a dedicated repository:
  `https://github.com/open-telemetry/semantic-conventions-genai`. The opentelemetry.io
  `semconv/gen-ai/*` pages are now stubs reading "Moved". Relevant pages:
  `gen-ai-spans`, **`gen-ai-agent-spans`**, `gen-ai-events`, `gen-ai-metrics`, `gen-ai-exceptions`,
  **`gen-ai-mcp`**, and per-provider pages (anthropic, openai, aws-bedrock, azure-ai-inference).
- **MCP documents OTel trace-context propagation in `_meta`** using `traceparent`, `tracestate`,
  `baggage` (SEP-414) — a citable, standard way to stitch MCP calls into an existing trace.
- Anthropic: full production tracing was required to diagnose failures; they monitor "agent
  decision patterns and interaction structures" **without** monitoring conversation contents, for
  privacy. This is a reasonable default for a multi-tenant mesh.
- Tooling: **LangSmith** (Python SDK `langchain-ai/langsmith-python`, JS `langchain-ai/langsmith-javascript`;
  the old `langchain-ai/langsmith-sdk` repo is **archived**), **Arize Phoenix** (OSS),
  **AgentOps**, OpenAI Agents SDK tracing + processors, MCP + OTel.

### 3.6 Multi-tenancy & fleet management

- A2A's `tenant` field + `supportedInterfaces` is the reference pattern for routing many agents
  behind one endpoint.
- Anthropic Managed Agents gives the sandbox-fleet pattern: containers are **cattle** — a dead
  container surfaces as a tool-call error the model can retry, and `provision({resources})`
  re-initializes a fresh one from a standard recipe. No container is hand-tended.
- A2A's *Agent Card caching* rules and `server/discover` (MCP) are both cheap health/liveness probes
  for a mesh that must route to many heterogeneous agents.

---

## 4. Human-agent collaboration

### 4.1 Spec-driven development

- **GitHub spec-kit** (<https://github.com/github/spec-kit>): "an open source toolkit that gives AI
  coding agents structured processes, reusable templates, and documented outcomes." Three
  **independent entry points, not mandatory phases**: **Spec-Driven Development**, **Bug fixing**
  (assessed cause → scoped fix → recorded verification), **Idea assessment** (evidence-backed
  go/clarify/stop). Capability table (verbatim mechanisms): Extensions (add a command, quality
  gate, or complete process), **Extension runtime events** (react to coding-agent lifecycle events),
  Extension hooks (run commands before/after Spec Kit commands), **Presets** (adapt templates,
  terminology, methodology; enforce org/regulatory standards), project-local overrides, **Workflows**
  (automate prompts, commands, gates, shell tasks), **Workflow overlays** (modify an installed
  workflow without forking), **Workflow steps** (add reusable executable behavior), **Bundles**
  (curated setup for a role/team), **Catalogs** (community + org-private curated sources), private
  catalog **Authentication**, **air-gapped / self-hosted sources**, and an **artifact inventory**
  (inspect which layer supplies a command, template, or script). Commands include
  `specify extension search`, `specify preset search`, `specify workflow search`, `specify bundle
  search`. "Catalog listings are not audits or endorsements, so review community source code before
  installing or running it."
- **Kiro** (AWS, <https://kiro.dev/docs/specs/>): **Feature Specs**, **Bugfix Specs**, **Quick Spec**;
  Plan mode; "Analyze Requirements"; **Correctness**; **Steering**; Hooks; MCP; Permissions; Custom
  agents; Workflows; Agent Skills; Powers; Cloud sessions; Memory; Compaction; Checkpoints and
  rewind; a local command sandbox; **ACP integrations**; and a **Crew** product for running 24/7 with
  its own interfaces, apps, system & storage, config sync, sandbox, governance (monitor and track),
  identity, and a mobile preview.
- **Tessl**: **UNVERIFIED** in this pass.

### 4.2 Handoff patterns

The strongest concrete, citable handoff design is Anthropic's **initializer agent + coding agent**
split (Nov 26 2025), summarized in §1.5. The transferable primitives:
1. A **first-run agent** that lays the foundation: `init.sh` (setup), a `claude-progress.txt` log
   (state), and an initial commit (history).
2. A **per-session agent** that makes incremental progress, leaves structured updates, and ends in a
   **clean state** (mergeable to main) — explicitly so the next session doesn't inherit a mess.
3. A **fast, cheap state read** at session start: one log file + git history, rather than
   re-deriving state from the tree.
4. Anti-pattern to design against: the later agent **declaring the job done** because progress
   exists. Progress must be *itemized* (per-feature), not merely present.

### 4.3 Context engineering

- **LangChain's framing** (<https://docs.langchain.com/oss/python/langchain/context-engineering>):
  "LLMs fail for two reasons: (1) the underlying LLM is not capable enough, (2) **the 'right'
  context was not passed to the LLM**. More often than not, it's actually the second reason."
  "**Context engineering** is providing the right information and tools in the right format…
  This is the number one job of AI Engineers… the number one blocker for more reliable agents."
  Three controllable surfaces: **model context** (instructions, message history, tools, response
  format — transient), **tool context** (what tools can read/write, runtime context — persistent),
  **life-cycle context** (summarization, guardrails, logging — persistent). Three data scopes:
  **runtime context** (static config, conversation-scoped), **state** (short-term memory,
  conversation-scoped), **store** (long-term memory, cross-conversation). Implemented via
  **middleware** that can update context or jump to a different step of the agent lifecycle.
- Anthropic's multi-agent post adds the compression framing: "The essence of search is
  **compression**… Subagents facilitate compression by operating in parallel with their own context
  windows… before **condensing the most important tokens** for the lead research agent."
- Anthropic's Managed Agents adds the durability framing: context should be an **object outside the
  context window** that the model can interrogate positionally (`getEvents()`), because compaction
  and memory tools are *irreversible* decisions.

### 4.4 Agent memory systems

- **Mem0** (<https://github.com/mem0ai/mem0>, YC S24): "The Memory Layer for Personalized AI";
  ships a new memory algorithm and markets token-efficiency vs. full-context; offers an OSS tier
  and a hosted tier.
- **Letta** (formerly **MemGPT**) (<https://github.com/letta-ai/letta>): "Build stateful agents with
  memory that can learn and improve over time." **Current source moved to `letta-ai/letta-code`**
  (agent harness, interactive terminal UI, **App Server**, channels, runtime); the V1 API server is
  retired to the `archive` branch. Installable via npm `@letta-ai/letta-code`; `letta server` for
  local/self-hosted agents; `letta` for the terminal UI; channels for Slack/Telegram/Discord;
  **Letta Agent SDK** (TypeScript); **Letta Cloud** for cross-device memory/identity/conversations.
  MemGPT remains the canonical reference for **LLM-managed memory tiering** (the model decides what
  to page in/out of core vs archival memory).
- **Zep** (<https://github.com/getzep/zep>): the repo is *examples and integrations* for **Zep Cloud**,
  a managed agent-memory platform (SDKs: Python `zep-cloud`, TS `@getzep/zep-cloud`, Go
  `getzep/zep-go/v3`). The open-source temporal knowledge graph that powers it is **Graphiti**
  (<https://github.com/getzep/graphiti>). Also `zep-ingest` (bulk ingestion from Slack, documents,
  email, JSON/CSV, fact triples), default **ontologies**, and plugins for Claude Code, Codex, Cursor,
  and Claude Desktop/Cowork. The episodic→entity→relation→community-graph model is the most
  "queryable memory" oriented of the three.

### 4.5 Planning patterns (verified)

- **ReAct** (arXiv 2210.03629, ICLR camera-ready v3): interleaves reasoning traces and actions.
  On HotpotQA/FeVer, "overcomes issues of hallucination and error propagation prevalent in
  chain-of-thought reasoning by interacting with a simple Wikipedia API"; on ALFWorld and WebShop,
  beats imitation/RL by **+34%** and **+10%** absolute success with 1–2 in-context examples.
- **Reflexion** (arXiv 2303.11366, v4): reinforces language agents **without weight updates**, using
  verbal reflection stored in an **episodic memory buffer**; feedback can be scalar or free-form,
  external or self-simulated. **91% pass@1 on HumanEval** vs GPT-4's 80%.
- **Orchestrator-workers** (Anthropic): the defining difference from parallelization is flexibility —
  "subtasks aren't pre-defined, but determined by the orchestrator based on the specific input";
  "well-suited to complex tasks where you can't predict the subtasks needed (in coding, for example,
  the number of files that need to be changed and the nature of the change in each file likely depend
  on the task)."
- **Evaluator-optimizer** (Anthropic): one LLM generates, another critiques in a loop; fit signal =
  (a) responses demonstrably improve when a human articulates feedback, and (b) the LLM can
  provide such feedback.
- **Plan-and-Execute / ReWOO / hierarchical-recursive planning**: I did **not** verify primary
  sources in this pass (**UNVERIFIED**); the closest verified relatives are Anthropic's
  orchestrator-workers, ReAct, Reflexion, and Deep Agents' built-in `planning` + `skills` + virtual
  filesystem.

### 4.6 The "agent team" literature

Beyond MAST (§5.5) and Claude Code agent teams (§2.1), the shipped "agent team" concept in the
IDE-orchestrator class is: **Intent** ("Spec-driven coordination, Coordinator/Verifier agents"),
**Kangentic workflows** (a workflow agent plans tasks with hard dependencies; a task starts when its
dependencies reach Done), and **Vibe Kanban's MCP card decomposition** (autonomous decomposition,
no hard dependencies). The pattern across all three: **a planner/verifier pair separated from
workers, with a board as the shared state**.

---

## 5. Evaluation & benchmarking

### 5.1 Benchmarks

| Benchmark | arXiv / source | Key facts | Date |
|---|---|---|---|
| **AgentBench** | 2308.03688 (ICLR 2024) | 8 distinct interactive environments; main obstacles: poor long-term reasoning, decision-making, instruction following; big gap between top commercial and OSS ≤70B; training on code has *ambivalent* effects across tasks | 2023/2024 |
| **GAIA** | 2311.12983 | 466 questions (answers held for 300 for a leaderboard); at publication humans **92%** vs GPT-4+plugins **15%**; deliberately targets *human-easy, AI-hard* questions requiring reasoning, multimodality, browsing, tool use | 2023 |
| **SWE-bench** | SWE-bench/SWE-bench | 12 popular Python repos, 2,294 problems; **SWE-bench Verified** = 500 problems human-confirmed solvable; **SWE-bench Multilingual**; **SWE-bench v2 fully open-source (announced Jan 13 2025)** with a larger, more recent task set and a new harness for "systematically evaluating real-world software issues" | 2023–2025 |
| **τ-bench** | 2406.12045 | Simulated user + domain-specific APIs + **policy guidelines**; grading = compare final **database state** to annotated goal state; introduces **pass^k** (reliability across k trials). gpt-4o succeeds **<50%** of tasks; **pass^8 <25% in retail** → "the need for methods that can improve the ability of agents to act consistently and follow rules reliably" | 2024 |
| **τ²-bench** | 2506.07982 (Sierra) | Adds an **airline** domain and **dual-control** tasks with a user simulator; **τ-bench 2.0** adds **τ-i18n** (6 languages — EN/ES/PT/HI/ZH/KR — in text and full-duplex voice, each localizing tasks, database, and caller personas for airline/retail/telecom), a new **`intake` domain (τ-entity)**, 200+ tasks, with explicit **elicitation**; `banking_knowledge` in voice; **post-hoc judges** for naturalness, speech fidelity, tool use, and language checks that **do not change the task reward**; **released frozen benchmarks** with pinned data. Runner: `tau2 judges`, `--language`, `--audio-native` | 2025–2026 |
| **TheAgentCompany** | 2412.14161 | Self-contained simulated small software company (internal web sites, chat, GitLab, ownCloud, Plane) mimicking a digital worker; **the most competitive agent completes 30% of tasks autonomously**; "a good portion of simpler tasks could be solved autonomously, but more difficult long-horizon tasks are still beyond the reach of current systems" | 2024 |
| **METR time horizons** | metr.org/time-horizons + 2025-03-19 paper | Task length (measured in **human expert time**) an agent completes with 50% reliability has **doubled ~every 7 months over 6 years**; current models ~**100% success on tasks <4 human-minutes, <10% on tasks >~4 human-hours**; **TH 1.1** uses a larger suite (RE-Bench, HCAST, short novel software tasks); page **last updated Sept 8 2026 and "no longer actively updated"**; "**Measurements above 16 hrs are unreliable with our current task suite**"; methodology = logistic fit of success vs human task duration, with human durations = geometric mean of contracted expert completion times | 2025–2026 |
| **ST-WebAgentBench** | ICLR 2026 | 222 tasks, each paired with **ST policies**; six orthogonal dimensions (user consent, robustness, …); **Completion Under Policy (CuP)** credits only completions respecting all applicable policies; **Risk Ratio** quantifies breaches. Three SOTA agents have **average CuP < 2/3 of nominal completion rate** → "exposing critical safety gaps" | 2025/2026 |
| **AgentDojo** | 2406.13352 | 97 realistic tasks (email client, e-banking, travel booking), **629 security test cases**, extensible environment (not a static suite). "state-of-the-art LLMs fail at many tasks (**even in the absence of attacks**)"; "existing prompt injection attacks break **some** security properties but not all" | 2024 |

### 5.2 Anthropic's current eval guidance — "Demystifying evals for AI agents" (Jan 9 2026)

<https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents>

**Vocabulary (use these terms):** *task* (test case with inputs + success criteria) · *trial* (one attempt;
run multiple per task) · *grader* (logic scoring an aspect; contains multiple assertions/"checks") ·
*transcript* (trace/trajectory — for the Anthropic API, the full messages array) · **outcome** (the
final state of the environment at the end of the trial) · *evaluation harness* (infrastructure that
runs tasks concurrently, records steps, grades, aggregates) · **agent harness / scaffold** (the system
that lets a model act as an agent) · *evaluation suite*.

The key conceptual move: **"when we evaluate 'an agent,' we're evaluating the harness and the model
working together."** And: the **outcome** is not the transcript — "a flight-booking agent might say
'Your flight has been booked' at the end of the transcript, but the outcome is whether a reservation
exists in the environment's SQL database."

**Transcript vs outcome grading:** multi-agent systems take different valid paths, so step-level
golden traces don't work. Anthropic's multi-agent post states the rule: *"We found success focusing
on **end-state evaluation** rather than turn-by-turn analysis… For complex workflows, break evaluation
into **discrete checkpoints** where specific state changes should have occurred, rather than
attempting to validate every intermediate step."*

**LLM-as-judge:** "a single LLM call with a single prompt outputting scores from 0.0–1.0 and a
pass-fail grade was the most consistent and aligned with human judgements." Rubric dimensions
(factual accuracy, citation accuracy, completeness, source quality, tool efficiency) come from the
research post; the evals post generalizes to **static analysis, browser agents to test apps, and LLM
judges for behaviours like instruction following**.

**Start small:** ~20 queries; effect sizes are huge early ("a prompt tweak might boost success rates
from 30% to 80%"), so small evals suffice early; teams that add evals late ("once evals become a
bottleneck") report the breaking point as users saying the agent "feels worse" and the team flying
blind.

**Real deployments cited:** *Descript* (video editing) — three dimensions of success ("don't break
things, do what I asked, do it well"); evolved manual grading → LLM graders with product-defined
criteria + periodic human calibration; now runs **two separate suites** (quality benchmark + regression
test). *Bolt AI* — took **3 months** to build an eval system that runs the agent, grades with static
analysis, uses browser agents to test apps, and employs LLM judges for instruction following.
*Claude Code itself* — first narrow evals (concision, file edits), then complex behaviours
(**over-engineering**), combined with production monitoring, A/B tests, and user research.

**Evals can be over-specified:** "Opus 4.5 solved a τ²-bench problem about booking a flight by
**discovering a loophole in the policy**. It 'failed' the evaluation as written, but actually came up
with a better solution for the user."

### 5.3 The skeptic's benchmark: METR on benchmark scores

<https://metr.org/notes/2026-03-10-many-swe-bench-passing-prs-would-not-be-merged-into-main/>
(Whitfill, Wu, Becker, Rush; **Mar 10 2026**; a *note* — "unpolished research updates… do not
necessarily reflect the views of METR as a whole")

- **Method:** 4 active maintainers from 3 SWE-bench Verified repos reviewed **296 AI-generated PRs**,
  hypothetically accepting or requesting changes, and recording the reason (core functionality
  failure vs. breaks other code / code quality). To handle decision noise, they also recorded merge
  decisions on **47 original human-written PRs** that were actually merged ("golden patches") and
  report all scores as **% of golden baseline** (golden = **68%**).
- **Result:** roughly **half of test-passing SWE-bench Verified PRs would not be merged into main**;
  maintainer merge decisions are on average **~24 percentage points lower** than the automated
  grader's scores; the rate of improvement measured in pp/yr is **9.6 pp/yr slower** by maintainer
  merge decisions (METR flags this as shakier, suggestive evidence).
- **METR's own caveat:** agents were not given a chance to iterate on feedback as a human developer
  would, so this is **not** a fundamental capability limit. Their claim is narrower: "a naive
  interpretation of benchmark scores may lead one to overestimate how useful agents are **without
  more elicitation or human feedback**."

This is the single most useful calibration for any AgentMesh roadmap claim: **a green test suite is
not a merged PR**, and the gap is measurable at ~24pp.

### 5.4 Multi-agent failure taxonomy — MAST

<https://arxiv.org/abs/2503.13657> — Cemri, Pan, Yang, Agrawal, Chopra, Tiwari, Keutzer,
Parameswaran, Klein, Ramchandran, Zaharia, Gonzalez, Stoica. v1 Mar 17 2025; **v3 Oct 26 2025**.

- **MAST-Data**: 1600+ annotated traces across **7 popular MAS frameworks**; "the first multi-agent
  system dataset to outline the failure dynamics in MAS."
- **MAST** (Multi-Agent System Failure Taxonomy): built from **150 traces** with expert human
  annotators, validated at **κ = 0.88** inter-annotator agreement; **14 unique modes** in
  **3 categories: (i) system design issues, (ii) inter-agent misalignment, (iii) task verification.**
- An **LLM-as-a-Judge pipeline** for scalable annotation with high agreement to humans.
- Analysis spans **GPT-4, Claude 3, Qwen2.5, CodeLlama** and coding/math/general-agent tasks,
  demonstrating "improvement headrooms from better MAS design."
- Framing in the abstract: "their performance gains on popular benchmarks are often **minimal**."

The 3-category split is directly usable as an AgentMesh risk taxonomy: **system design** (harness
and coordination architecture), **inter-agent misalignment** (semantic disagreement between agents —
the class AgentMesh's intent/lease engine and contract graph target), **task verification** (how you
know the work is actually done — the class AgentMesh's referee/reviewer roles and MACP quorum target).

### 5.5 Instrumentation

- **LangSmith** — tracing/evaluation/monitoring; SDKs moved to `langchain-ai/langsmith-python` and
  `langchain-ai/langsmith-javascript` (the old `langchain-ai/langsmith-sdk` repo is **archived**);
  packages unchanged on PyPI/npm.
- **Arize Phoenix** — OSS tracing + eval; `phoenix.arize.com`.
- **AgentOps** — agent observability/evals.
- **OpenAI Agents SDK tracing** — spans for every agent step + third-party processors; plus
  `visualization` docs for embedding trace dashboards in notebooks/web apps.
- **OTel `semantic-conventions-genai`** — the vendor-neutral path, including a dedicated `gen-ai-mcp`
  page.

---

## 6. Known problems and open research

**6.1 Write conflicts.** No production tool arbitrates file-level writes automatically. Claude Code's
answer is social scope discipline + worktrees; Emdash has no inter-agent coordination at all;
Conductor's shared-workspace mode explicitly accepts the risk. **This is the clearest open gap in
the field**, and AgentMesh's intent-before-edit + lease engine is ahead of the ecosystem — provided
leases get TTL, renewal, and **fencing tokens** (a stale holder must not be able to commit).

**6.2 Context dilution.** Anthropic: subagents compress, but "domains that require all agents to
share the same context or involve many dependencies between agents are not a good fit for
multi-agent systems today"; "most coding tasks involve fewer truly parallelizable tasks than
research, and LLM agents are not yet great at coordinating and delegating to other agents in real
time." LangChain: the number-one blocker for reliability is context, not model capability.

**6.3 Error compounding.** Anthropic: "Agents are stateful and errors compound… One step failing can
cause agents to explore entirely different trajectories, leading to unpredictable outcomes." The
mitigation stack they report: durable resume-from-failure, deterministic retry + checkpoints, and
telling the agent when a tool is failing so it can adapt. AG-UI's *truncated run* semantics and
MCP Tasks' durable handles are the protocol-level analogues.

**6.4 Coordination overhead tax.** Token usage alone explains **80%** of BrowseComp variance;
multi-agent ≈ **15×** chat tokens; Claude Code agent teams cost "significantly more tokens than a
single session." Any coordination round-trip must be justified in tokens per decision, and the
cheapest wins are parallelism (3–5 parallel subagents, 3+ parallel tools per subagent → up to 90%
less wall-clock) and the "artifact to filesystem" pattern (subagents write artifacts; only
references travel back — avoids the "game of telephone" and cuts token overhead).

**6.5 Trust and verification of agent output.** The measurable evidence: METR's ~24pp
benchmark→maintainer gap; ST-WebAgentBench's CuP < 2/3; Anthropic's agents preferring SEO content
farms over primary sources; Opus 4.5 "failing" τ²-bench by improving on the spec. Verification must
be **outcome-based** (final environment state), checkpointed, and periodically human-calibrated —
never a transcript diff.

**6.6 The "100x claim" critique.** **Be careful here:** I could **not** verify a METR publication
that is literally a critique of a "100x" claim, and I will not invent one. What is verifiable and
directly relevant:
- METR's time-horizon doubling (~7 months over 6 years) is a **task-length** metric, not a
  productivity metric, and METR itself flags: (a) **"Measurements above 16 hrs are unreliable with
  our current task suite"**; (b) a dedicated note, *"Impact of modeling assumptions on time horizon
  results"* (Mar 20 2026), showing the estimates are assumption-sensitive; (c) *"time horizon
  limitations"* (Jan 22 2026); (d) the time-horizons page is **no longer actively updated** (as of
  Sept 8 2026).
- METR's productivity-adjacent work: *"Because 8 ≈ e², Anthropic's researcher uplift is plausibly
  >2x"* (Jul 8 2026) — Anthropic reported contributors merge **8×** as much code per day; METR argues
  standard economic modelling implies **>2×** individual researcher uplift from coding agents
  alone. Also *"Analyzing coding agent transcripts to upper bound productivity gains"* (Feb 17 2026)
  using **5,305 Claude Code transcripts**, and *"A simpler AI timelines model predicts 99% AI R&D
  automation in ~2032"* (Feb 10 2026).
- The defensible skeptical framing for a roadmap: **headroom is bounded by what agents can
  *verify*, not by what they can produce** — which is precisely why coordination/verification
  protocols (AgentMesh's MACP quorum, referee/reviewer roles, contract graph) are the scarce
  resource, and why METR's 24pp gap and τ-bench's pass^k matter more than headline scores.

**6.7 Hallucinated approvals.** Concretely: A2A defines **in-task authorization** with explicit
agent and client responsibilities; ACP makes `session/request_permission` a *client* baseline
method (the client owns the environment and resource access); AG-UI makes interrupts/approvals
first-class events. The risk for a mesh is that an agent's assertion that "the user approved X" is
indistinguishable from an actual approval unless approvals travel on an **out-of-band, attributable
channel** (a human-facing surface, signed, with the requesting agent identified). AgentMesh's
"approvals" concept should be modelled this way, and approvals should be **scoped per task**
(A2A's pattern) and **revocable** (AgentMesh already has ed25519 revocation).

**6.8 Prompt injection between agents.** AgentDojo: 629 security test cases; attacks break *some*
security properties but not all; SOTA models fail many tasks even without attacks. Anthropic's
Managed Agents gives the architectural answer: **tokens must be unreachable from the sandbox where
generated code runs**; auth bundled at provisioning; git tokens wired into the remote so the agent
never handles them; MCP OAuth tokens in a vault accessed only by a dedicated proxy, so "the harness
is never made aware of any credentials." For a mesh, the corollary is: **an agent's messages to
peers are untrusted content, not authority** — and A2A's "Preserve Opacity" (agents collaborate
without exposing internal state, memory, or tools) plus signed Agent Cards are the primitives for
authenticating peers without trusting their payloads. Kangentic's blind relay + Noise E2E is the
transport pattern for networks you don't control.

**6.9 Synchronous orchestration bottlenecks.** Anthropic's lead agent "execute[s] subagents
synchronously… the entire system can be blocked while waiting for a single subagent to finish
searching"; they identify asynchronous execution as the next win but flag "result coordination,
state consistency, and error propagation" as the unsolved parts. This is the clearest opening for a
durable-handle, event-sourced coordination service — and the closest protocol precedents (MCP Tasks,
A2A Task + push notifications, AG-UI run outcomes) are all young.

**6.10 Deployment under statefulness.** Anthropic: "Agent systems are highly stateful webs of
prompts, tools, and execution logic that run almost continuously… whenever we deploy updates,
agents might be anywhere in their process" → **rainbow deployments** (shift traffic gradually, keep
both versions running). A coordination daemon with long-lived sessions needs the same: version the
hub, version the wire protocol, and support N versions simultaneously.

**6.11 Harness assumptions go stale.** Anthropic's explicit warning: Sonnet 4.5 needed context
resets for "context anxiety"; Opus 4.5 didn't, and the resets were "dead weight." Design stable
interfaces (declare intent / claim task / commit / query state) over any particular model behaviour;
put model-specific workarounds in the pluggable layer.

---

## 7. Roadmap implications for AgentMesh (mapped to the current v1.2 codebase)

The local repo (`@harshalsp/agentmesh` v1.2) already ships: a **SQLite WAL event store**; an
**intent engine with soft/hard leases** and port/service + shared-symbol leases; a **task board**
with atomic claims, WIP limits (default 2) and dependency chains, streaming `task.*` events; a
**MACP 5-mode consensus kernel**; a **delta-state semantic CRDT** with Lamport vector clocks;
**MeshVCS lanes** (copy-on-write above Git); an **MCP stdio JSON-RPC 2.0 bridge**; **Ed25519
identity with instant revocation + rotation**; a **Merkle-verified audit bundle**; a **Conductor
coordination agent** with 6 roles (scout/dispatcher/referee/reviewer/shepherd/keeper); and a
landing/docs/playground site.

| # | Delta | Evidence |
|---|---|---|
| 1 | **Treat MCP spec churn as a schedule risk.** Build a versioned adapter + conformance matrix keyed on `io.modelcontextprotocol/protocolVersion` in `_meta` and the new `server/discover` RPC. Expect to support 3 revisions. Drop any use of Roots/Sampling/Logging (deprecated) and any reliance on `initialize` sessions or SSE `Last-Event-ID` resumption. | MCP changelog 2026-07-28 |
| 2 | **Adopt MCP Tasks' durable-handle shape** (`tasks/get` / `tasks/update` / `tasks/cancel`, `resultType: "task"`, TTL + suggested polling interval) as the wire contract for the task board. It buys crash resilience, mid-flight input, and backpressure — all missing from a local-file mailbox. | MCP Tasks ext |
| 3 | **Adopt A2A v1.0's tenant + Agent Card signing** for interop with other agents: expose a `tenant`-scoped `supportedInterfaces` and sign the Agent Card with JWS over RFC 8785 JCS. A2A is AAIF-governed, so interop risk is lower than a year ago. | A2A v1.0 |
| 4 | **Align `task.*` events with AG-UI 1.0's rules.** Specifically: (a) attribution is not advisory — continuation events must agree on owner; (b) every announced invocation must be closed before the run ends; (c) subagent events must not carry their own token usage — the run's terminal event reports the whole run. | AG-UI 1.0 subagents |
| 5 | **Add lease TTL, renewal, and fencing tokens.** A lease without a fence lets a paused/GC'd holder commit after expiry — the classic distributed-systems failure that a lease-only design invites. | general; Anthropic error-compounding |
| 6 | **Make dependency chains the headline differentiator** and say so: Vibe Kanban's own weakness list says "no hard task dependencies"; Emdash's says "no agent-to-agent coordination." Claude Code has dependencies but its board is experimental and off by default. | awesome-agent-ide; Claude Code docs |
| 7 | **Reuse a CRDT library instead of bespoke vector clocks.** Loro 1.0 (Rust/JS/Swift, Fugue text, git-DAG import, shallow snapshot) or Automerge 3 (~10× memory reduction) would give MeshVCS lanes real merge semantics, a wire format, and time-travel. | Loro / Automerge READMEs |
| 8 | **Document the SQLite WAL boundary explicitly** (single host, no network FS, `-shm`/`-wal` backup discipline) and name the Postgres migration trigger (second writer, HA, >1 hub instance). | sqlite.org/wal.html |
| 9 | **Adopt the blind-relay pattern for untrusted networks**: stateless, opaque-ciphertext forwarding; per-session E2E Noise handshake; crypto layer kept out of the server's runtime deps; **publish the metadata disclosure** (IPs, timing, frame sizes, pairing graph). | Kangentic relay README |
| 10 | **Standardize tracing on OTel `semantic-conventions-genai`** (including `gen-ai-mcp`) and propagate `traceparent`/`tracestate`/`baggage` in MCP `_meta` (SEP-414). This is the citable way to stitch hub spans to agent calls. | OTel move notice; SEP-414 |
| 11 | **Rebuild the eval suite outcome-first.** Concretely: (a) end-state assertions on the event log — e.g. "no two agents wrote the same path without a held lease", "no dependent task was claimable before its dependency closed"; (b) MAST's 14 failure modes / 3 categories as a checklist; (c) **pass^k** (from τ-bench) applied to the *coordination protocol* — probability that an N-agent task completes without deadlock over k trials; (d) a METR-style maintainer-judgement pass on AgentMesh-produced changes; (e) LLM-as-judge as a **single call with a single rubric prompt** scoring 0.0–1.0 + pass/fail, human-calibrated periodically. | Anthropic evals; MAST; τ-bench; METR |
| 12 | **Price every coordination feature in tokens per decision.** Token usage explains 80% of multi-agent performance variance; multi-agent is ~15× chat tokens. Prefer parallelism and artifact-to-filesystem over conversational round-trips. | Anthropic multi-agent post |
| 13 | **Design the wire protocol as stable interfaces over pluggable policy** (declare intent / claim / commit / query / approve), and version the hub separately from the protocol. Anthropic's own lesson: model-specific harness workarounds become dead weight within a model generation. | Anthropic Managed Agents |
| 14 | **Make approvals out-of-band, attributable, and revocable** — scoped per task (A2A in-task authorization), never asserted by the requesting agent, revocable via the existing ed25519 revocation path. | A2A; ACP; AgentMesh trust model |

---

## 8. Source index (primary links)

**Specifications**
- MCP latest spec: <https://modelcontextprotocol.io/specification/2026-07-28> ·
  changelog <https://modelcontextprotocol.io/specification/2026-07-28/changelog.md> ·
  auth tutorial <https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/authorization.md> ·
  Tasks ext <https://modelcontextprotocol.io/extensions/tasks/overview> ·
  spec repo <https://github.com/modelcontextprotocol/specification> · ext-tasks
  <https://github.com/modelcontextprotocol/ext-tasks> · llms index
  <https://modelcontextprotocol.io/llms.txt>
- A2A: spec <https://a2a-protocol.org/latest/specification/> · v1.0 changes
  <https://a2a-protocol.org/latest/whats-new-v1/> · multi-tenancy
  <https://a2a-protocol.org/latest/topics/multi-tenancy/> · llms index
  <https://a2a-protocol.org/latest/llms.txt> · repo <https://github.com/a2aproject/A2A> ·
  CLI <https://github.com/a2aproject/a2a-cli>
- AG-UI: spec <https://docs.ag-ui.com/spec/1.0/index.md> · changelog
  <https://docs.ag-ui.com/spec/1.0/changelog.md> · subagents
  <https://docs.ag-ui.com/spec/1.0/events/subagents.md> · transports
  <https://docs.ag-ui.com/spec/1.0/basic/transports.md> · intro
  <https://docs.ag-ui.com/introduction>
- ACP: <https://agentclientprotocol.com/protocol/v1/overview> · llms index
  <https://agentclientprotocol.com/llms.txt>

**Vendor engineering**
- Anthropic multi-agent research system (Jun 13 2025):
  <https://www.anthropic.com/engineering/built-multi-agent-research-system>
- Anthropic building effective agents (Dec 19 2024):
  <https://www.anthropic.com/research/building-effective-agents>
- Anthropic effective harnesses for long-running agents (Nov 26 2025):
  <https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents>
- Anthropic scaling managed agents (Apr 8 2026):
  <https://www.anthropic.com/engineering/managed-agents>
- Anthropic demystifying evals for AI agents (Jan 9 2026):
  <https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents>
- LangChain multi-agent <https://docs.langchain.com/oss/python/langchain/multi-agent> · subagents
  <https://docs.langchain.com/oss/python/langchain/multi-agent/subagents> · context engineering
  <https://docs.langchain.com/oss/python/langchain/context-engineering>
- OpenAI Agents SDK <https://openai.github.io/openai-agents-python/> · orchestration
  <https://openai.github.io/openai-agents-python/multi_agent/> · Swarm
  <https://github.com/openai/swarm>
- Microsoft Agent Framework <https://github.com/microsoft/agent-framework> · CrewAI
  <https://github.com/crewAIInc/crewAI>

**Coordination tooling**
- Claude Code agent teams <https://docs.claude.com/en/docs/claude-code/agent-teams> ·
  worktrees <https://docs.claude.com/en/docs/claude-code/worktrees> ·
  cross-session messaging <https://docs.claude.com/en/docs/claude-code/cross-session-messaging> ·
  agents <https://docs.claude.com/en/docs/claude-code/agents>
- Claude Squad <https://github.com/smtg-ai/claude-squad> · dmux
  <https://github.com/standardagents/dmux> · Emdash <https://github.com/generalaction/emdash> ·
  Conductor <https://www.conductor.build/> · Kangentic
  <https://github.com/Kangentic/kangentic> · Kangentic relay
  <https://github.com/Kangentic/relay> · Vibe Kanban (sunsetting)
  <https://github.com/BloopAI/vibe-kanban> · awesome-agent-ide
  <https://github.com/pinion05/awesome-agent-ide>
- OpenHands Agent Canvas <https://github.com/All-Hands-AI/OpenHands> · Aider
  <https://github.com/Aider-AI/aider>

**Scale & infra**
- SQLite WAL <https://sqlite.org/wal.html> · Yjs <https://github.com/yjs/yjs> · Automerge
  <https://github.com/automerge/automerge> · Loro <https://github.com/loro-dev/loro>
- OTel GenAI semconv (moved) <https://github.com/open-telemetry/semantic-conventions-genai>

**Memory**
- Mem0 <https://github.com/mem0ai/mem0> · Letta <https://github.com/letta-ai/letta> ·
  Letta Code <https://github.com/letta-ai/letta-code> · Zep
  <https://github.com/getzep/zep> · Graphiti <https://github.com/getzep/graphiti>

**Evaluation**
- METR time horizons <https://metr.org/time-horizons/> · original paper post
  <https://metr.org/blog/2025-03-19-measuring-ai-ability-to-complete-long-tasks/> ·
  maintainer-merge note
  <https://metr.org/notes/2026-03-10-many-swe-bench-passing-prs-would-not-be-merged-into-main/> ·
  metrics of agent ability <https://metr.org/notes/2026-07-24-metrics-of-model-ability/> ·
  modelling assumptions <https://metr.org/notes/2026-03-20-impact-of-modelling-assumptions-on-time-horizon-results/>
- MAST <https://arxiv.org/abs/2503.13657> · AgentDojo <https://arxiv.org/abs/2406.13352> ·
  τ-bench <https://arxiv.org/abs/2406.12045> · τ²-bench <https://arxiv.org/abs/2506.07982> ·
  TheAgentCompany <https://arxiv.org/abs/2412.14161> · GAIA
  <https://arxiv.org/abs/2311.12983> · AgentBench <https://arxiv.org/abs/2308.03688> ·
  SWE-bench <https://github.com/SWE-bench/SWE-bench> · ReAct
  <https://arxiv.org/abs/2210.03629> · Reflexion <https://arxiv.org/abs/2303.11366>

**Spec-driven development**
- GitHub spec-kit <https://github.com/github/spec-kit> · Kiro specs
  <https://kiro.dev/docs/specs/>
