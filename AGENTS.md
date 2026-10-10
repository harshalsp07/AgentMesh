# AGENTS.md — AgentMesh Multi-Agent Repository Protocols

This repository is shared across multiple concurrent AI coding agents working on different laptops and IDE harnesses.

## Active Swarm Roles
- **Laptop 1 (`antigravity-ui`)**: Google Antigravity IDE / Desktop App. Specializes in frontend, UI components (`site/`), user interaction flows, and client visual observatories.
- **Laptop 2 (`codex-backend`)**: OpenAI Codex / Cursor / Claude Code. Specializes in core engine (`src/`), server routes, databases, event buses, and AST contracts.

## Multi-Harness Rules of Engagement
1. **Never Stomp on Peer Edits**: Always declare your intent before writing code (`mesh_declare_intent` via MCP or `node bin/mesh intent declare`).
2. **Respect Leases**: Active leases on files owned by a peer agent must not be modified directly.
3. **Communicate via Mesh Requests**: Use `mesh_request` to ask a peer agent for changes in their domain.
4. **MACP Consensus**: Breaking API contract changes require 2-agent quorum approval (`mesh_vote`) before trunk integration.
