# Multi-Laptop Coordination Guide: Antigravity (UI) + Codex (Backend)

This guide walks through connecting two separate machines running different AI agent harnesses on the **same repository**:
- **Laptop 1**: Running **Google Antigravity IDE / Desktop App**, agent assigned to **Frontend/UI** (`antigravity-ui`).
- **Laptop 2**: Running **OpenAI Codex / Cursor / Claude Code**, agent assigned to **Backend** (`codex-backend`).

---

## 1. Prerequisites
- Both laptops are on the same local network (Wi-Fi/LAN), or connected via **Tailscale** / WireGuard / VPN.
- Both laptops have a clone of the repository (or share a local git remote).
- Node.js 20+ installed on both machines.

---

## 2. On Laptop 1 (Host & Antigravity)

### Step 2.1: Start AgentMesh Hub on all network interfaces
On Laptop 1, run the Hub listening on `0.0.0.0` so other laptops can reach it:
```bash
MESH_HOST=0.0.0.0 MESH_PORT=7777 node src/hub.mjs
```
*(Tip: Find Laptop 1's local IP address using `ip a` on Linux or `ipconfig` on Windows, e.g. `192.168.1.50`)*

### Step 2.2: Antigravity MCP Configuration
Antigravity automatically discovers [`.agents/mcp_config.json`](../.agents/mcp_config.json) which is pre-configured in this repository:
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
The Antigravity agent will read [`.agents/rules/agentmesh.md`](../.agents/rules/agentmesh.md) and [`AGENTS.md`](../AGENTS.md) and begin acting as `antigravity-ui`.

---

## 3. On Laptop 2 (Codex / Cursor / Claude Code)

### Option A: Instant Join via CLI Helper (Recommended)
From the repo root on Laptop 2, run:
```bash
./bin/mesh-join http://<LAPTOP_1_IP>:7777
# Example: ./bin/mesh-join http://192.168.1.50:7777
```
This tests network connectivity, registers presence, and writes `.cursor/mcp.json` automatically!

### Option B: Manual IDE Configuration

#### For Cursor:
Add to `.cursor/mcp.json` on Laptop 2:
```json
{
  "mcpServers": {
    "agentmesh": {
      "command": "node",
      "args": ["src/bridge.mjs"],
      "env": {
        "MESH_ACTOR": "codex-backend",
        "MESH_HUB": "http://<LAPTOP_1_IP>:7777"
      }
    }
  }
}
```

#### For Claude Code:
Add via CLI:
```bash
claude mcp add agentmesh node src/bridge.mjs -e MESH_ACTOR=codex-backend -e MESH_HUB=http://<LAPTOP_1_IP>:7777
```

---

## 4. How the Two Agents Coordinate in Real Time

1. **Passive Scope Protection (Intent-Before-Edit)**:
   - When Antigravity starts editing UI files (`site/**`), it declares its intent.
   - When Codex on Laptop 2 edits backend files (`src/**`), it declares its intent.
   - If Codex attempts to edit `site/` files while Antigravity holds the lease, AgentMesh returns an `OVERLAP` warning in Codex's next tool call `<mesh-delta>` header.

2. **Inter-Agent Task Delegation (`mesh_request`)**:
   - In Antigravity, the UI agent can say:
     *"I need a new endpoint for user profile badges."*
     Antigravity calls `mesh_request(to: "codex-backend", text: "Please create GET /api/badges")`.
   - On Laptop 2, Codex receives this in its inbox, implements the endpoint, and acknowledges the request.

3. **MACP Quorum Consensus (`mesh_vote`)**:
   - For breaking schema changes or landing to trunk, either agent can initiate an MACP session.
   - Both `antigravity-ui` and `codex-backend` must vote to approve before changes are integrated.

4. **Live Visual Observatory**:
   - Open **`http://<LAPTOP_1_IP>:7777`** in any browser to see the real-time topology canvas, active lanes, declared intents, and peer activity!
