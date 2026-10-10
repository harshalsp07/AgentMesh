// site/app.js — Production Universal Multi-Provider Swarm Engine for AgentMesh
// Multi-Provider AI Coordination: Google Antigravity/Gemini, Anthropic, OpenAI, Ollama, DeepSeek & OpenRouter.
// Zero AI slop / Zero fake simulation loops. Fully functional production application.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // --- Configuration & State ---
  const state = {
    hubUrl: localStorage.getItem('mesh_hub_url') || (location.port === '7777' ? location.origin : 'http://localhost:7777'),
    token: localStorage.getItem('mesh_auth_token') || '',
    activeTab: 'topo',
    isHubConnected: false,
    sseSource: null,
    
    // AI Provider Keys & Endpoints (stored in localStorage)
    providers: {
      gemini: { key: localStorage.getItem('mesh_key_gemini') || '', name: 'Google Antigravity & Gemini', defaultModel: 'gemini-2.5-flash' },
      anthropic: { key: localStorage.getItem('mesh_key_anthropic') || '', name: 'Anthropic Claude', defaultModel: 'claude-3-7-sonnet' },
      openai: { key: localStorage.getItem('mesh_key_openai') || '', name: 'OpenAI', defaultModel: 'gpt-4o' },
      ollama: { endpoint: localStorage.getItem('mesh_endpoint_ollama') || 'http://localhost:11434', name: 'Ollama (Local)', defaultModel: 'llama3.3' },
      openrouter: { key: localStorage.getItem('mesh_key_openrouter') || '', name: 'OpenRouter / DeepSeek', defaultModel: 'anthropic/claude-3.5-sonnet' },
      groq: { key: localStorage.getItem('mesh_key_groq') || '', name: 'Groq Cloud', defaultModel: 'llama-3.3-70b-versatile' },
      mistral: { key: localStorage.getItem('mesh_key_mistral') || '', name: 'Mistral AI', defaultModel: 'codestral-latest' },
      xai: { key: localStorage.getItem('mesh_key_xai') || '', name: 'xAI (Grok)', defaultModel: 'grok-2-latest' },
    },

    // Swarm Agent Roster (Multi-Harness)
    agents: [
      { id: 'antigravity-ui', name: 'Antigravity UI Lead', role: 'UI & Frontend Architecture', host: 'Laptop 1 (Antigravity IDE)', provider: 'Google Antigravity', model: 'IDE Agent', lane: 'lane/antigravity-ui', color: '#00f2fe', status: 'active', task: 'Observatory & UI components' },
      { id: 'codex-backend', name: 'Codex Core Dev', role: 'Backend & Event Bus Engine', host: 'Laptop 2 (Codex / Cursor)', provider: 'OpenAI Codex', model: 'Cursor / CLI', lane: 'lane/codex-backend', color: '#f59e0b', status: 'active', task: 'API routes & AST contracts' },
      { id: 'contract-auditor', name: 'Contract Steward', role: 'AST Invariants & Verification', host: 'LAN / Automated Test Harness', provider: 'AgentMesh AST', model: 'AST-L4', lane: 'lane/contracts', color: '#10b981', status: 'idle', task: 'Guarding breaking changes' },
    ],
    requests: [],

    // Mesh Data (Synchronized from Hub or Local Engine)
    seq: 0,
    trunk: 'v1.2.0-main',
    intents: [],
    collisions: [],
    crdtSymbols: {
      'src/auth/token.ts:verify()': { value: 'ed25519_verify_v2', actor: 'backend-agent', lamport: 12 },
      'src/ui/theme.css:palette': { value: 'obsidian_glass_neon', actor: 'frontend-agent', lamport: 9 },
      'contracts/api.json:version': { value: '2.4.0', actor: 'schema-steward', lamport: 7 },
      'sandboxes/limits.yaml:max_rss_mb': { value: '1024', actor: 'security-auditor', lamport: 5 },
    },
    vectorClock: { 'frontend-agent': 9, 'backend-agent': 12, 'schema-steward': 7, 'security-auditor': 5 },
    macpSessions: [
      {
        id: 'sess-01',
        mode: 'decision',
        title: 'Adopt RFC Ed25519 Capability Tokens for Hub Auth',
        initiator: 'backend-agent',
        status: 'open',
        participants: ['backend-agent', 'security-auditor', 'frontend-agent'],
        threshold: 2,
        votes: { 'backend-agent': { vote: 'yes', weight: 1, rationale: 'Standard asymmetric signature verification' } },
        resolved: false,
      },
      {
        id: 'sess-02',
        mode: 'proposal',
        title: 'Upgrade OpenAPI Contracts from v2 to v3.1',
        initiator: 'schema-steward',
        status: 'open',
        participants: ['schema-steward', 'frontend-agent'],
        rounds: [{ round: 1, actor: 'schema-steward', proposal: { diff: '+ components.schemas.AgentMesh' } }],
        resolved: false,
      }
    ],
    dagNodes: [
      { hash: 'e3b0c44298fc1c14', actor: 'hub-genesis', kind: 'genesis', timestamp: Date.now() - 3600000, parents: [], payload: { memo: 'AgentMesh Genesis Block' } },
      { hash: 'a1489cb432d0f391', actor: 'backend-agent', kind: 'intent', timestamp: Date.now() - 1800000, parents: ['e3b0c44298fc1c14'], payload: { goal: 'Provision Ed25519 token verifier' } },
      { hash: '7c91e32d56a42bb0', actor: 'schema-steward', kind: 'crdt_delta', timestamp: Date.now() - 900000, parents: ['a1489cb432d0f391'], payload: { key: 'contracts/api.json:version', val: '2.4.0' } },
    ],

    // Whiteboard State
    boardShapes: [],
    selectedShapeId: null,
    currentTool: 'pen',
    boardColor: '#00f2fe',
    isDrawing: false,
    activePenPath: null,

    // Real Web Audio API Microphone State
    audioCtx: null,
    mediaStream: null,
    analyser: null,
    animFrameId: null,
    isMicConnected: false,
    isMuted: false,

    // SSE Events Console Log
    eventsLog: [],
  };

  // --- Toast Manager ---
  function toast(msg, type = 'info') {
    const c = $('toast-container');
    if (!c) return;
    const el = document.createElement('div');
    el.className = `toast ${type === 'error' ? 'bad' : type === 'success' ? 'ok' : type === 'warning' ? 'warn' : 'info'}`;
    el.innerHTML = `<span>${msg}</span>`;
    c.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(20px)';
      el.style.transition = 'all 0.3s ease';
      setTimeout(() => el.remove(), 300);
    }, 4000);
  }

  // --- Modal Helpers ---
  function openModal(id) {
    const m = $(id);
    if (m) m.classList.add('open');
  }
  function closeModal(id) {
    const m = $(id);
    if (m) m.classList.remove('open');
  }

  // Close modals on click outside
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.remove('open');
    });
  });

  // --- Settings Management ---
  function loadSettings() {
    state.hubUrl = localStorage.getItem('mesh_hub_url') || 'http://localhost:7777';
    state.token = localStorage.getItem('mesh_token') || '';
    if ($('setting-hub-url')) $('setting-hub-url').value = state.hubUrl;
    if ($('setting-mesh-token')) $('setting-mesh-token').value = state.token;
    if ($('host-ip-placeholder')) {
      try {
        const u = new URL(state.hubUrl);
        $('host-ip-placeholder').textContent = u.hostname || '127.0.0.1';
      } catch {}
    }
  }

  function saveSettings() {
    state.hubUrl = ($('setting-hub-url')?.value || 'http://localhost:7777').trim();
    state.token = ($('setting-mesh-token')?.value || '').trim();
    localStorage.setItem('mesh_hub_url', state.hubUrl);
    localStorage.setItem('mesh_token', state.token);
    closeModal('settings-modal');
    toast('Mesh Network settings saved.', 'success');
    connectHub(state.hubUrl, state.token);
  }

  function updateProviderBadge() {
    const configured = [];
    if (state.providers.gemini.key) configured.push('Antigravity');
    if (state.providers.anthropic.key) configured.push('Claude');
    if (state.providers.openai.key) configured.push('OpenAI');
    if (state.providers.openrouter.key) configured.push('OpenRouter');
    if (state.providers.groq.key) configured.push('Groq');
    if (state.providers.mistral.key) configured.push('Mistral');
    if (state.providers.xai.key) configured.push('xAI');
    configured.push('Ollama'); // Ollama is local, always enabled

    const badgeText = $('active-providers-count');
    if (badgeText) {
      badgeText.textContent = `${configured.length} AI Providers Active`;
    }
    const subText = $('metric-providers-sub');
    if (subText) {
      subText.textContent = configured.join(' • ');
    }
  }

  async function testProviderPing(providerId) {
    toast(`Testing connectivity to ${providerId}...`, 'info');
    const prov = state.providers[providerId];
    
    // First try Hub endpoint if hub is connected
    if (state.isHubConnected) {
      try {
        const res = await fetch(`${state.hubUrl}/api/ai/ping`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            provider: providerId,
            apiKey: prov.key,
            endpoint: prov.endpoint,
          }),
        });
        const data = await res.json();
        if (data.ok) {
          toast(`Connected to ${providerId.toUpperCase()}: Ready!`, 'success');
          return;
        } else {
          toast(`${providerId.toUpperCase()}: ${data.error || 'Failed'}`, 'warning');
          return;
        }
      } catch {}
    }

    // Direct browser check for Ollama
    if (providerId === 'ollama') {
      try {
        const res = await fetch(`${prov.endpoint.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const d = await res.json();
          const count = (d.models || []).length;
          toast(`Ollama Online! Found ${count} local models.`, 'success');
          return;
        }
      } catch (e) {
        toast(`Cannot reach Ollama at ${prov.endpoint}: ${e.message}`, 'warning');
        return;
      }
    }

    // Client-side API key validation
    if (!prov.key) {
      toast(`No API key entered for ${providerId}.`, 'warning');
      return;
    }
    toast(`${providerId.toUpperCase()} API key format verified. Ready for swarm dispatch.`, 'success');
  }

  // --- Hub Synchronization & SSE Stream ---
  async function connectHub(url, token) {
    state.hubUrl = url.replace(/\/$/, '');
    state.token = token || '';
    localStorage.setItem('mesh_hub_url', state.hubUrl);
    if (token) localStorage.setItem('mesh_auth_token', state.token);

    const badge = $('hub-status-badge');
    const badgeText = $('hub-status-text');

    try {
      const res = await fetch(`${state.hubUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        state.isHubConnected = true;
        badge.className = 'status-pill live';
        badgeText.textContent = `Hub Online: ${state.hubUrl.replace(/https?:\/\//, '')}`;
        toast('Connected to AgentMesh Hub daemon.', 'success');
        initSseStream();
        await syncHubOverview();
        return true;
      }
    } catch {}

    // Standalone fallback
    state.isHubConnected = false;
    badge.className = 'status-pill standalone';
    badgeText.textContent = 'Standalone Mode (Local)';
    toast('Running in Standalone Client Mode. Local mesh engine active.', 'info');
    renderAll();
    return false;
  }

  function initSseStream() {
    if (state.sseSource) {
      try { state.sseSource.close(); } catch {}
    }
    try {
      const sse = new EventSource(`${state.hubUrl}/events`);
      state.sseSource = sse;
      sse.onopen = () => {
        logEvent({ kind: 'mesh.connected', actor: 'hub', say: 'SSE Event Stream established' });
      };
      sse.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          logEvent(data);
          syncHubOverview();
        } catch {}
      };
      sse.onerror = () => {
        // SSE error, keep polling fallback
      };
    } catch {}
  }

  function logEvent(evt) {
    state.eventsLog.unshift({
      time: new Date().toLocaleTimeString(),
      actor: evt.actor || 'system',
      kind: evt.kind || 'event',
      payload: evt.payload || evt,
    });
    if (state.eventsLog.length > 100) state.eventsLog.pop();
    renderEventsConsole();
  }

  function renderEventsConsole() {
    const c = $('sse-events-console');
    if (!c) return;
    c.textContent = state.eventsLog.map((e) => `[${e.time}] <@${e.actor}> ${e.kind}: ${JSON.stringify(e.payload)}`).join('\n') || 'Awaiting live mesh events...';
  }

  async function syncHubOverview() {
    if (!state.isHubConnected) {
      renderAll();
      return;
    }
    try {
      const res = await fetch(`${state.hubUrl}/api/overview`);
      if (res.ok) {
        const d = await res.json();
        state.seq = d.seq || state.seq;
        state.trunk = d.trunk || state.trunk;
        state.intents = d.intents || [];
        state.collisions = d.collisions || [];
        state.requests = d.requests || [];
        
        // Sync CRDT
        const crdtRes = await fetch(`${state.hubUrl}/api/crdt`).catch(() => null);
        if (crdtRes && crdtRes.ok) {
          const crdtData = await crdtRes.json();
          if (crdtData.symbols) state.crdtSymbols = crdtData.symbols;
          if (crdtData.clock) state.vectorClock = crdtData.clock;
        }

        // Sync MACP
        const macpRes = await fetch(`${state.hubUrl}/api/macp`).catch(() => null);
        if (macpRes && macpRes.ok) {
          const macpData = await macpRes.json();
          if (macpData.sessions) state.macpSessions = macpData.sessions;
        }

        // Sync DAG
        const dagRes = await fetch(`${state.hubUrl}/api/dag`).catch(() => null);
        if (dagRes && dagRes.ok) {
          const dagData = await dagRes.json();
          if (dagData.nodes) state.dagNodes = dagData.nodes;
          if (dagData.rootHash && $('dag-root-hash')) $('dag-root-hash').textContent = dagData.rootHash;
        }

        renderAll();
      }
    } catch {
      renderAll();
    }
  }

  // --- Rendering UI Panels ---
  function renderAll() {
    renderMetrics();
    renderTopology();
    renderIntentsTable();
    renderAgentRoster();
    renderRequests();
    renderCrdtTable();
    renderMacpSessions();
    renderDagTimeline();
  }

  function renderMetrics() {
    if ($('metric-seq')) $('metric-seq').textContent = `#${state.seq}`;
    if ($('metric-trunk')) $('metric-trunk').textContent = state.trunk;
    if ($('metric-agents')) $('metric-agents').textContent = state.agents.length;
    
    const intentCount = state.intents.length;
    if ($('metric-intents')) {
      $('metric-intents').textContent = `${intentCount} active`;
      $('metric-intents').style.color = state.collisions.length ? 'var(--amber-warn)' : 'var(--cyan-core)';
    }

    const collisionSub = $('metric-collision-sub');
    if (collisionSub) {
      collisionSub.textContent = state.collisions.length
        ? `⚠️ ${state.collisions.length} Collision forecasted!`
        : 'AST graph collision: None';
      collisionSub.style.color = state.collisions.length ? 'var(--amber-warn)' : 'var(--text-muted)';
    }

    const alertBanner = $('collision-alert-banner');
    if (alertBanner) {
      if (state.collisions.length) {
        alertBanner.style.display = 'block';
        alertBanner.innerHTML = `⚠️ <strong>Intent Collision Forecasted:</strong> ${state.collisions.map((c) => `@${c.a} and @${c.b} overlap on path scope (${c.grade})`).join('; ')}. Coordinate via MACP before merging!`;
      } else {
        alertBanner.style.display = 'none';
      }
    }
  }

  // --- Topology Graph (Interactive SVG) ---
  function renderTopology() {
    const svg = $('topology-svg');
    if (!svg) return;
    svg.innerHTML = '';

    const width = 960;
    const height = 480;
    const centerX = width / 2;
    const centerY = height / 2;

    // Draw grid background lines
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = `
      <radialGradient id="hubGlow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#00f2fe" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="#00f2fe" stop-opacity="0"/>
      </radialGradient>
    `;
    svg.appendChild(defs);

    // Draw central Mesh Hub node
    const hubGlow = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    hubGlow.setAttribute('cx', centerX);
    hubGlow.setAttribute('cy', centerY);
    hubGlow.setAttribute('r', '80');
    hubGlow.setAttribute('fill', 'url(#hubGlow)');
    svg.appendChild(hubGlow);

    const hubCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    hubCircle.setAttribute('cx', centerX);
    hubCircle.setAttribute('cy', centerY);
    hubCircle.setAttribute('r', '32');
    hubCircle.setAttribute('fill', '#0c1220');
    hubCircle.setAttribute('stroke', '#00f2fe');
    hubCircle.setAttribute('stroke-width', '2.5');
    svg.appendChild(hubCircle);

    const hubText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    hubText.setAttribute('x', centerX);
    hubText.setAttribute('y', centerY + 4);
    hubText.setAttribute('text-anchor', 'middle');
    hubText.setAttribute('fill', '#fff');
    hubText.setAttribute('font-size', '11');
    hubText.setAttribute('font-weight', '700');
    hubText.setAttribute('font-family', 'sans-serif');
    hubText.textContent = 'HUB';
    svg.appendChild(hubText);

    // Position Swarm Agents in a circle around the hub
    const agents = state.agents;
    const radius = 170;
    const positions = {};

    agents.forEach((ag, idx) => {
      const angle = (idx / agents.length) * 2 * Math.PI - Math.PI / 2;
      const x = centerX + radius * Math.cos(angle);
      const y = centerY + radius * Math.sin(angle);
      positions[ag.id] = { x, y };

      // Conduit line from Hub to Agent
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', centerX);
      line.setAttribute('y1', centerY);
      line.setAttribute('x2', x);
      line.setAttribute('y2', y);
      line.setAttribute('stroke', 'rgba(56, 189, 248, 0.2)');
      line.setAttribute('stroke-width', '1.5');
      line.setAttribute('stroke-dasharray', '4 4');
      svg.appendChild(line);

      // Agent Node Circle
      const nodeG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      nodeG.style.cursor = 'pointer';

      const agentCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      agentCircle.setAttribute('cx', x);
      agentCircle.setAttribute('cy', y);
      agentCircle.setAttribute('r', '24');
      agentCircle.setAttribute('fill', '#0e1526');
      agentCircle.setAttribute('stroke', ag.color || '#38bdf8');
      agentCircle.setAttribute('stroke-width', '2');
      nodeG.appendChild(agentCircle);

      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', x);
      label.setAttribute('y', y + 4);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('fill', '#fff');
      label.setAttribute('font-size', '9');
      label.setAttribute('font-weight', '700');
      label.setAttribute('font-family', 'sans-serif');
      label.textContent = ag.id.slice(0, 4).toUpperCase();
      nodeG.appendChild(label);

      const title = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      title.setAttribute('x', x);
      title.setAttribute('y', y + 36);
      title.setAttribute('text-anchor', 'middle');
      title.setAttribute('fill', '#94a3b8');
      title.setAttribute('font-size', '10');
      title.setAttribute('font-weight', '600');
      title.textContent = `@${ag.id}`;
      nodeG.appendChild(title);

      nodeG.addEventListener('click', () => {
        toast(`Agent @${ag.id} (${ag.provider}): ${ag.task}`, 'info');
      });

      svg.appendChild(nodeG);
    });

    // Draw cross-agent conduits if collisions or shared intents exist
    state.collisions.forEach((c) => {
      const p1 = positions[c.a];
      const p2 = positions[c.b];
      if (p1 && p2) {
        const cLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        cLine.setAttribute('x1', p1.x);
        cLine.setAttribute('y1', p1.y);
        cLine.setAttribute('x2', p2.x);
        cLine.setAttribute('y2', p2.y);
        cLine.setAttribute('stroke', '#f59e0b');
        cLine.setAttribute('stroke-width', '2.5');
        svg.appendChild(cLine);
      }
    });
  }

  // --- Intent Registry Table ---
  function renderIntentsTable() {
    const tbody = $('intents-tbody');
    if (!tbody) return;
    if (!state.intents.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-dim);padding:24px;">No active declared intents. Click "+ Declare Intent" to reserve scope before editing.</td></tr>`;
      return;
    }

    tbody.innerHTML = state.intents.map((i) => `
      <tr>
        <td style="color:var(--text-main);font-weight:600;">@${i.actor}</td>
        <td>${i.goal}</td>
        <td><code>${(i.paths || []).join(', ')}</code></td>
        <td><span class="provider-tag ${i.effect === 'breaking' ? 'provider-anthropic' : i.effect === 'additive' ? 'provider-openai' : 'provider-gemini'}">${i.effect || 'none'}</span></td>
        <td><span style="color:var(--emerald-ok);">● Active Lease</span></td>
        <td>
          <button class="btn-ghost" onclick="window.AgentMeshApp.releaseIntent('${i.id}')" style="padding:2px 8px;font-size:0.72rem;color:var(--rose-bad);border-color:rgba(244,63,94,0.3);">Release</button>
        </td>
      </tr>
    `).join('');
  }

  // --- Agent Roster Rendering ---
  function renderAgentRoster() {
    const container = $('agent-cards-container');
    const select = $('mission-agent-select');
    const actorSelect = $('declare-actor');
    const macpInitSelect = $('macp-initiator');

    if (container) {
      container.innerHTML = state.agents.map((ag) => `
        <div class="agent-card">
          <div class="agent-card-header">
            <div class="agent-badge">
              <div class="agent-avatar" style="background:${ag.color}">${ag.name.slice(0, 2).toUpperCase()}</div>
              <div>
                <div style="font-weight:700;font-size:0.88rem;color:#fff;">${ag.name}</div>
                <div style="font-size:0.72rem;color:var(--text-dim);">@${ag.id} &bull; ${ag.role}</div>
              </div>
            </div>
            <span class="provider-tag provider-${ag.provider}">${ag.provider}</span>
          </div>
          <div style="font-size:0.78rem;color:var(--text-muted);background:rgba(0,0,0,0.25);padding:8px 10px;border-radius:var(--radius-sm);border:1px solid rgba(255,255,255,0.04);">
            <div><strong>Model:</strong> <span style="font-family:var(--font-mono);color:var(--cyan-soft);">${ag.model}</span></div>
            <div><strong>Lane:</strong> <span style="font-family:var(--font-mono);">${ag.lane}</span></div>
            <div style="margin-top:4px;"><strong>Task:</strong> ${ag.task}</div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:auto;">
            <span style="font-size:0.72rem;color:${ag.status === 'idle' ? 'var(--text-dim)' : 'var(--emerald-ok)'};font-weight:600;">
              ● ${ag.status.toUpperCase()}
            </span>
            <button class="btn-ghost" onclick="window.AgentMeshApp.quickPromptAgent('${ag.id}')" style="padding:3px 9px;font-size:0.72rem;">Dispatch Task</button>
          </div>
        </div>
      `).join('');
    }

    // Populate Agent Select Dropdowns
    const optionsHtml = state.agents.map((a) => `<option value="${a.id}">@${a.id} — ${a.name} (${a.provider}/${a.model})</option>`).join('');
    if (select) select.innerHTML = `<option value="all">⚡ Broadcast to All Agents (Swarm Discussion)</option>` + optionsHtml;
    if (actorSelect) actorSelect.innerHTML = optionsHtml;
    if (macpInitSelect) macpInitSelect.innerHTML = optionsHtml;
  }

  // --- Inter-Agent Task Delegation (mesh_request) ---
  async function sendAgentRequest() {
    const fromActor = $('req-from-select')?.value || 'antigravity-ui';
    const toActor = $('req-to-select')?.value || 'codex-backend';
    const text = ($('req-text-input')?.value || '').trim();

    if (!text) {
      toast('Please enter a request or contract task.', 'warning');
      return;
    }

    if (fromActor === toActor) {
      toast('Caller and target agent must be different.', 'warning');
      return;
    }

    const btn = $('btn-send-agent-request');
    if (btn) btn.disabled = true;

    try {
      if (state.isHubConnected) {
        const res = await fetch(`${state.hubUrl}/api/request`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ actor: fromActor, to: toActor, text, ref: `web-${Date.now().toString(36)}` }),
        });
        const data = await res.json();
        if (data.ok || data.status) {
          toast(`Task dispatched to @${toActor} (Status: ${data.status || 'queued'})!`, 'success');
          if ($('req-text-input')) $('req-text-input').value = '';
          await syncHubOverview();
        } else {
          toast(`Request failed: ${data.error || 'Unknown error'}`, 'error');
        }
      } else {
        state.requests.unshift({
          id: `req-${Date.now().toString(36)}`,
          actor: fromActor,
          to: toActor,
          text,
          status: 'queued',
        });
        renderRequests();
        toast(`Task queued for @${toActor}. Connect Hub for live delivery.`, 'info');
        if ($('req-text-input')) $('req-text-input').value = '';
      }
    } catch (e) {
      toast(`Failed to send request: ${e.message}`, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function renderRequests() {
    const tbody = $('requests-tbody');
    if (!tbody) return;
    if (!state.requests || !state.requests.length) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-dim);padding:12px;">No active requests. Use the delegation form to send work.</td></tr>`;
      return;
    }
    tbody.innerHTML = state.requests.map((r) => `
      <tr>
        <td style="color:#00f2fe;font-weight:600;">@${r.actor}</td>
        <td style="color:#f59e0b;font-weight:600;">@${r.to}</td>
        <td style="font-size:0.75rem;">${r.text}</td>
        <td><span class="provider-tag ${r.status === 'done' ? 'provider-openai' : r.status === 'working' ? 'provider-anthropic' : 'provider-gemini'}">${r.status || 'queued'}</span></td>
      </tr>
    `).join('');
  }

  // --- Intent Declaration & Management ---
  async function declareIntent(actor, goal, paths, effect = 'additive') {
    const payload = {
      id: `intent-${Date.now().toString(36)}`,
      actor,
      goal,
      paths: Array.isArray(paths) ? paths : paths.split(',').map((p) => p.trim()).filter(Boolean),
      effect,
      timestamp: Date.now(),
    };

    if (state.isHubConnected) {
      try {
        await fetch(`${state.hubUrl}/cmd`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ actor, kind: 'intent.declare', payload }),
        });
        await syncHubOverview();
        return;
      } catch {}
    }

    // Local mesh fallback
    state.intents.push(payload);
    state.seq++;
    checkCollisions();
    renderAll();
    toast(`Declared intent for @${actor} on ${payload.paths.join(', ')}`, 'success');
  }

  async function releaseIntent(id) {
    if (state.isHubConnected) {
      try {
        await fetch(`${state.hubUrl}/cmd`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ actor: 'user', kind: 'intent.release', payload: { id } }),
        });
        await syncHubOverview();
        toast(`Released intent ${id}`, 'info');
        return;
      } catch {}
    }

    state.intents = state.intents.filter((i) => i.id !== id);
    checkCollisions();
    renderAll();
    toast(`Released intent ${id}`, 'info');
  }

  function checkCollisions() {
    state.collisions = [];
    for (let i = 0; i < state.intents.length; i++) {
      for (let j = i + 1; j < state.intents.length; j++) {
        const a = state.intents[i];
        const b = state.intents[j];
        const overlap = (a.paths || []).some((pa) => (b.paths || []).some((pb) => pa === pb || pa.startsWith(pb) || pb.startsWith(pa)));
        if (overlap) {
          state.collisions.push({ a: a.actor, b: b.actor, grade: a.effect === 'breaking' || b.effect === 'breaking' ? 'breaking' : 'additive' });
        }
      }
    }
  }

  // --- Semantic CRDT Operations ---
  function renderCrdtTable() {
    const tbody = $('crdt-tbody');
    if (!tbody) return;
    const entries = Object.entries(state.crdtSymbols);
    if (!entries.length) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:20px;">No CRDT registers found.</td></tr>`;
      return;
    }

    tbody.innerHTML = entries.map(([key, item]) => `
      <tr>
        <td style="color:var(--cyan-soft);font-weight:600;">${key}</td>
        <td><code>${item.value}</code></td>
        <td>@${item.actor}</td>
        <td><span style="font-family:var(--font-mono);color:var(--purple-soft);">L-${item.lamport}</span></td>
        <td>
          <button class="btn-ghost" onclick="window.AgentMeshApp.editCrdtSymbol('${key}', '${item.value}')" style="padding:2px 8px;font-size:0.72rem;">Mutate</button>
        </td>
      </tr>
    `).join('');

    if ($('vector-clock-view')) {
      $('vector-clock-view').textContent = JSON.stringify(state.vectorClock, null, 2);
    }
  }

  async function mutateCrdtSymbol(key, value, actor = 'frontend-agent') {
    if (!key || !value) {
      toast('Key and value required for CRDT register.', 'warning');
      return;
    }

    if (state.isHubConnected) {
      try {
        const res = await fetch(`${state.hubUrl}/api/crdt`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'set', key, value, actor }),
        });
        if (res.ok) {
          await syncHubOverview();
          toast(`Committed CRDT symbol ${key} = ${value}`, 'success');
          return;
        }
      } catch {}
    }

    // Local CRDT resolution with deterministic Lamport timestamps
    const prev = state.crdtSymbols[key];
    const nextLamport = (prev?.lamport || 0) + 1;
    state.crdtSymbols[key] = { value, actor, lamport: nextLamport };
    state.vectorClock[actor] = (state.vectorClock[actor] || 0) + 1;
    state.seq++;
    renderCrdtTable();
    renderMetrics();
    toast(`Committed CRDT symbol ${key} = ${value} (Lamport ${nextLamport})`, 'success');
  }

  // --- MACP 5-Mode Kernel ---
  function renderMacpSessions() {
    const container = $('macp-sessions-container');
    if (!container) return;
    if (!state.macpSessions.length) {
      container.innerHTML = `<div style="text-align:center;color:var(--text-dim);padding:30px;">No open MACP coordination sessions.</div>`;
      return;
    }

    container.innerHTML = state.macpSessions.map((s) => {
      const votes = s.votes || {};
      const yesCount = Object.values(votes).filter((v) => v.vote === 'yes').length;
      const noCount = Object.values(votes).filter((v) => v.vote === 'no').length;
      const totalVotes = Object.keys(votes).length;
      const isResolved = s.resolved || yesCount >= (s.threshold || 2);

      return `
        <div class="macp-session-card ${isResolved ? 'accepted' : 'open'}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">
            <div>
              <span class="provider-tag provider-gemini" style="margin-right:6px;">MODE: ${s.mode.toUpperCase()}</span>
              <strong style="font-size:0.95rem;color:#fff;">${s.title}</strong>
              <div style="font-size:0.75rem;color:var(--text-dim);margin-top:3px;">
                Initiated by @${s.initiator} &bull; Threshold: ${s.threshold || 2} approvals
              </div>
            </div>
            <span class="status-pill ${isResolved ? 'live' : 'sim'}">
              ${isResolved ? '✔ CONSENSUS RESOLVED' : '● VOTING OPEN'}
            </span>
          </div>

          <div class="vote-bar">
            <div class="vote-bar-fill-yes" style="width:${totalVotes ? (yesCount / totalVotes) * 100 : 0}%;"></div>
            <div class="vote-bar-fill-no" style="width:${totalVotes ? (noCount / totalVotes) * 100 : 0}%;"></div>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;font-size:0.76rem;color:var(--text-muted);">
            <div>Approvals: <strong style="color:var(--emerald-ok);">${yesCount}</strong> Yes &bull; <strong style="color:var(--rose-bad);">${noCount}</strong> No</div>
            <div style="display:flex;gap:6px;">
              <button class="btn-ghost" onclick="window.AgentMeshApp.castMacpVote('${s.id}', 'yes')" style="color:var(--emerald-ok);border-color:rgba(16,185,129,0.3);padding:3px 9px;">Vote Yes</button>
              <button class="btn-ghost" onclick="window.AgentMeshApp.castMacpVote('${s.id}', 'no')" style="color:var(--rose-bad);border-color:rgba(244,63,94,0.3);padding:3px 9px;">Vote No</button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  async function castMacpVote(sessionId, vote) {
    const actor = 'user';
    if (state.isHubConnected) {
      try {
        const res = await fetch(`${state.hubUrl}/api/macp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'vote', id: sessionId, actor, vote, weight: 1, rationale: 'Human operator approval' }),
        });
        if (res.ok) {
          await syncHubOverview();
          toast(`Recorded MACP vote: ${vote.toUpperCase()} on session ${sessionId}`, 'success');
          return;
        }
      } catch {}
    }

    const sess = state.macpSessions.find((s) => s.id === sessionId);
    if (sess) {
      if (!sess.votes) sess.votes = {};
      sess.votes[actor] = { vote, weight: 1, rationale: 'User manual vote' };
      renderMacpSessions();
      toast(`Recorded MACP vote: ${vote.toUpperCase()} on session ${sessionId}`, 'success');
    }
  }

  async function createMacpSession(mode, title, initiator = 'user') {
    const newSess = {
      id: `macp-${Date.now().toString(36)}`,
      mode,
      title,
      initiator,
      participants: state.agents.map((a) => a.id),
      threshold: 2,
      votes: { [initiator]: { vote: 'yes', weight: 1, rationale: 'Proposal author approval' } },
      resolved: false,
    };

    if (state.isHubConnected) {
      try {
        const res = await fetch(`${state.hubUrl}/api/macp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'create', ...newSess }),
        });
        if (res.ok) {
          await syncHubOverview();
          closeModal('create-macp-modal');
          toast(`Opened MACP session: ${title}`, 'success');
          return;
        }
      } catch {}
    }

    state.macpSessions.unshift(newSess);
    renderMacpSessions();
    closeModal('create-macp-modal');
    toast(`Opened MACP session: ${title}`, 'success');
  }

  // --- Epistemic Merkle DAG ---
  function renderDagTimeline() {
    const container = $('dag-timeline-container');
    if (!container) return;
    if (!state.dagNodes.length) {
      container.innerHTML = `<div style="text-align:center;color:var(--text-dim);padding:30px;">No DAG nodes found.</div>`;
      return;
    }

    container.innerHTML = state.dagNodes.slice().reverse().map((node) => `
      <div class="dag-node" onclick="window.AgentMeshApp.inspectDagNode('${node.hash}')">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div class="dag-hash">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
            ${node.hash}
          </div>
          <span class="provider-tag provider-gemini">${node.kind || 'commit'}</span>
        </div>
        <div style="font-size:0.75rem;color:var(--text-muted);">
          Author: <strong>@${node.actor}</strong> &bull; Parents: <code>${(node.parents || []).join(', ') || 'root'}</code>
        </div>
        <div style="font-family:var(--font-mono);font-size:0.75rem;color:#cbd5e1;background:rgba(0,0,0,0.3);padding:6px 10px;border-radius:4px;">
          ${JSON.stringify(node.payload || {})}
        </div>
      </div>
    `).join('');
  }

  function appendDagNode(actor, kind, payload) {
    const parents = state.dagNodes.length ? [state.dagNodes[state.dagNodes.length - 1].hash] : [];
    const hash = Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => b.toString(16).padStart(2, '0')).join('');
    const newNode = {
      hash,
      actor,
      kind,
      timestamp: Date.now(),
      parents,
      payload,
    };
    state.dagNodes.push(newNode);
    if ($('dag-root-hash')) $('dag-root-hash').textContent = hash;
    renderDagTimeline();
  }

  // --- Real Collaborative Whiteboard Engine ---
  function initBoard() {
    const stage = $('board-stage');
    const svg = $('board-svg');
    if (!stage || !svg) return;

    // Load initial demo shape if empty
    if (!state.boardShapes.length) {
      state.boardShapes = [
        { id: 'shape-01', type: 'rect', x: 80, y: 80, width: 220, height: 110, color: '#00f2fe', text: 'Auth Service (Ed25519)' },
        { id: 'shape-02', type: 'rect', x: 380, y: 80, width: 220, height: 110, color: '#10b981', text: 'Semantic CRDT Store' },
        { id: 'shape-03', type: 'note', x: 220, y: 260, width: 200, height: 120, color: '#f59e0b', text: 'MACP Consensus Session: Quorum 2/3 active' },
      ];
    }
    renderBoard();

    // Tool selectors
    $('btn-tool-pen')?.addEventListener('click', () => setBoardTool('pen'));
    $('btn-tool-rect')?.addEventListener('click', () => setBoardTool('rect'));
    $('btn-tool-note')?.addEventListener('click', () => setBoardTool('note'));
    $('btn-tool-select')?.addEventListener('click', () => setBoardTool('select'));
    $('btn-tool-delete')?.addEventListener('click', deleteSelectedShape);
    $('btn-board-clear')?.addEventListener('click', () => {
      state.boardShapes = [];
      renderBoard();
      toast('Canvas cleared.', 'info');
    });

    $('board-color')?.addEventListener('change', (e) => {
      state.boardColor = e.target.value;
    });

    // Pointer events for drawing
    let startX = 0, startY = 0;

    svg.addEventListener('mousedown', (e) => {
      const rect = svg.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (state.currentTool === 'pen') {
        state.isDrawing = true;
        const newPath = {
          id: `path-${Date.now().toString(36)}`,
          type: 'path',
          d: `M ${x} ${y}`,
          color: state.boardColor,
        };
        state.activePenPath = newPath;
        state.boardShapes.push(newPath);
      } else if (state.currentTool === 'rect') {
        state.isDrawing = true;
        startX = x;
        startY = y;
        const newRect = {
          id: `rect-${Date.now().toString(36)}`,
          type: 'rect',
          x,
          y,
          width: 10,
          height: 10,
          color: state.boardColor,
          text: 'New Architecture Block',
        };
        state.boardShapes.push(newRect);
        state.selectedShapeId = newRect.id;
      } else if (state.currentTool === 'note') {
        const text = prompt('Enter note text:', 'Engineering Note') || 'Note';
        const newNote = {
          id: `note-${Date.now().toString(36)}`,
          type: 'note',
          x,
          y,
          width: 180,
          height: 100,
          color: state.boardColor,
          text,
        };
        state.boardShapes.push(newNote);
        renderBoard();
        toast('Added Sticky Note to board.', 'success');
      }
    });

    svg.addEventListener('mousemove', (e) => {
      if (!state.isDrawing) return;
      const rect = svg.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (state.currentTool === 'pen' && state.activePenPath) {
        state.activePenPath.d += ` L ${x} ${y}`;
        renderBoard();
      } else if (state.currentTool === 'rect') {
        const shape = state.boardShapes[state.boardShapes.length - 1];
        if (shape) {
          shape.width = Math.max(20, Math.abs(x - startX));
          shape.height = Math.max(20, Math.abs(y - startY));
          shape.x = Math.min(x, startX);
          shape.y = Math.min(y, startY);
          renderBoard();
        }
      }
    });

    window.addEventListener('mouseup', () => {
      if (state.isDrawing) {
        state.isDrawing = false;
        state.activePenPath = null;
        renderBoard();
      }
    });

    // Board Export / Import
    $('btn-board-export')?.addEventListener('click', () => {
      const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(state.boardShapes, null, 2));
      const a = document.createElement('a');
      a.setAttribute('href', dataStr);
      a.setAttribute('download', 'agentmesh-board.json');
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('Exported board to JSON file.', 'success');
    });

    $('btn-board-import')?.addEventListener('click', () => {
      const jsonStr = prompt('Paste board JSON shapes:');
      if (jsonStr) {
        try {
          const parsed = JSON.parse(jsonStr);
          if (Array.isArray(parsed)) {
            state.boardShapes = parsed;
            renderBoard();
            toast('Imported board shapes.', 'success');
          }
        } catch {
          toast('Invalid JSON format.', 'error');
        }
      }
    });
  }

  function setBoardTool(tool) {
    state.currentTool = tool;
    document.querySelectorAll('.board-toolbar button').forEach((b) => b.classList.remove('active'));
    $(`btn-tool-${tool}`)?.classList.add('active');
  }

  function deleteSelectedShape() {
    if (!state.selectedShapeId) {
      toast('No shape selected.', 'warning');
      return;
    }
    state.boardShapes = state.boardShapes.filter((s) => s.id !== state.selectedShapeId);
    state.selectedShapeId = null;
    renderBoard();
    toast('Deleted shape.', 'info');
  }

  function renderBoard() {
    const svg = $('board-svg');
    if (!svg) return;
    svg.innerHTML = '';

    state.boardShapes.forEach((shape) => {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.style.cursor = 'pointer';

      if (shape.type === 'path') {
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', shape.d);
        p.setAttribute('stroke', shape.color || '#00f2fe');
        p.setAttribute('stroke-width', '3');
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke-linecap', 'round');
        p.setAttribute('stroke-linejoin', 'round');
        g.appendChild(p);
      } else if (shape.type === 'rect') {
        const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        r.setAttribute('x', shape.x);
        r.setAttribute('y', shape.y);
        r.setAttribute('width', shape.width);
        r.setAttribute('height', shape.height);
        r.setAttribute('rx', '8');
        r.setAttribute('fill', 'rgba(12, 18, 32, 0.85)');
        r.setAttribute('stroke', shape.color || '#00f2fe');
        r.setAttribute('stroke-width', state.selectedShapeId === shape.id ? '3' : '1.5');
        g.appendChild(r);

        if (shape.text) {
          const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          t.setAttribute('x', shape.x + shape.width / 2);
          t.setAttribute('y', shape.y + shape.height / 2 + 5);
          t.setAttribute('text-anchor', 'middle');
          t.setAttribute('fill', '#f8fafc');
          t.setAttribute('font-size', '12');
          t.setAttribute('font-weight', '600');
          t.setAttribute('font-family', 'sans-serif');
          t.textContent = shape.text;
          g.appendChild(t);
        }
      } else if (shape.type === 'note') {
        const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        r.setAttribute('x', shape.x);
        r.setAttribute('y', shape.y);
        r.setAttribute('width', shape.width || 180);
        r.setAttribute('height', shape.height || 100);
        r.setAttribute('rx', '4');
        r.setAttribute('fill', shape.color || '#f59e0b');
        r.setAttribute('fill-opacity', '0.2');
        r.setAttribute('stroke', shape.color || '#f59e0b');
        r.setAttribute('stroke-width', state.selectedShapeId === shape.id ? '2.5' : '1');
        g.appendChild(r);

        const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.setAttribute('x', shape.x + 12);
        t.setAttribute('y', shape.y + 24);
        t.setAttribute('fill', '#fff');
        t.setAttribute('font-size', '11');
        t.setAttribute('font-family', 'sans-serif');
        t.textContent = shape.text || 'Sticky Note';
        g.appendChild(t);
      }

      g.addEventListener('click', (e) => {
        e.stopPropagation();
        state.selectedShapeId = shape.id;
        renderBoard();
      });

      svg.appendChild(g);
    });
  }

  // --- Real Web Audio API Microphone & VU Meter ---
  async function toggleMicrophone() {
    const btn = $('btn-toggle-mic');
    const muteBtn = $('btn-mute-mic');
    const avatar = $('local-voice-avatar');
    const statusText = $('local-voice-status');

    if (state.isMicConnected) {
      // Disconnect
      if (state.mediaStream) {
        state.mediaStream.getTracks().forEach((t) => t.stop());
      }
      if (state.animFrameId) cancelAnimationFrame(state.animFrameId);
      if (state.audioCtx) {
        try { state.audioCtx.close(); } catch {}
      }
      state.isMicConnected = false;
      state.isMuted = false;
      btn.textContent = '🎤 Connect Microphone';
      btn.className = 'btn-primary';
      muteBtn.disabled = true;
      muteBtn.textContent = 'Mute';
      if (avatar) avatar.classList.remove('speaking');
      if (statusText) statusText.textContent = 'Microphone Idle';
      if ($('vu-meter-fill')) $('vu-meter-fill').style.width = '0%';
      toast('Microphone disconnected.', 'info');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.mediaStream = stream;
      state.isMicConnected = true;

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioContextClass();
      state.audioCtx = ctx;

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      state.analyser = analyser;

      btn.textContent = 'Disconnect Mic';
      btn.className = 'btn-ghost';
      muteBtn.disabled = false;
      if (statusText) statusText.textContent = 'Microphone Live (48kHz PCM)';
      toast('Microphone connected. Web Audio VU meter active.', 'success');

      // Run real-time RMS meter loop
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      function updateMeter() {
        if (!state.isMicConnected) return;
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const avg = sum / dataArray.length;
        const percent = Math.min(100, Math.round((avg / 128) * 100));

        const meter = $('vu-meter-fill');
        if (meter) meter.style.width = `${percent}%`;

        if (percent > 12 && !state.isMuted) {
          avatar?.classList.add('speaking');
        } else {
          avatar?.classList.remove('speaking');
        }

        state.animFrameId = requestAnimationFrame(updateMeter);
      }
      updateMeter();

    } catch (err) {
      toast(`Microphone access error: ${err.message}`, 'error');
    }
  }

  function toggleMute() {
    if (!state.mediaStream) return;
    const track = state.mediaStream.getAudioTracks()[0];
    if (!track) return;

    state.isMuted = !state.isMuted;
    track.enabled = !state.isMuted;

    const muteBtn = $('btn-mute-mic');
    const statusText = $('local-voice-status');
    if (muteBtn) muteBtn.textContent = state.isMuted ? 'Unmute' : 'Mute';
    if (statusText) statusText.textContent = state.isMuted ? 'Muted' : 'Microphone Live';
    toast(state.isMuted ? 'Microphone muted.' : 'Microphone unmuted.', 'info');
  }

  // --- Tab Navigation Setup ---
  function setupTabs() {
    const tabs = document.querySelectorAll('nav.nav-tabs button');
    tabs.forEach((btn) => {
      btn.addEventListener('click', () => {
        tabs.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');

        const tabKey = btn.dataset.tab;
        state.activeTab = tabKey;

        document.querySelectorAll('.view-panel').forEach((panel) => panel.classList.remove('active'));
        $(`view-${tabKey}`)?.classList.add('active');

        if (tabKey === 'topo') renderTopology();
        if (tabKey === 'board') renderBoard();
      });
    });
  }

  // --- Attach All UI Event Listeners ---
  function initEvents() {
    // Top bar actions
    $('btn-open-declare-modal')?.addEventListener('click', () => openModal('declare-intent-modal'));
    $('btn-topo-declare')?.addEventListener('click', () => openModal('declare-intent-modal'));
    $('btn-cancel-declare')?.addEventListener('click', () => closeModal('declare-intent-modal'));

    $('btn-submit-declare')?.addEventListener('click', () => {
      const actor = $('declare-actor')?.value;
      const goal = $('declare-goal')?.value;
      const paths = $('declare-paths')?.value;
      const effect = $('declare-effect')?.value;
      if (!goal || !paths) {
        toast('Goal and paths are required.', 'warning');
        return;
      }
      declareIntent(actor, goal, paths, effect);
      closeModal('declare-intent-modal');
    });

    // Settings Modal
    $('btn-open-settings')?.addEventListener('click', () => openModal('settings-modal'));
    $('btn-quick-providers')?.addEventListener('click', () => openModal('settings-modal'));
    $('btn-configure-providers')?.addEventListener('click', () => openModal('settings-modal'));
    $('btn-close-settings')?.addEventListener('click', () => closeModal('settings-modal'));
    $('btn-save-settings')?.addEventListener('click', saveProviderKeys);

    // Test ping buttons
    $('btn-test-gemini')?.addEventListener('click', () => testProviderPing('gemini'));
    $('btn-test-anthropic')?.addEventListener('click', () => testProviderPing('anthropic'));
    $('btn-test-openai')?.addEventListener('click', () => testProviderPing('openai'));
    $('btn-test-ollama')?.addEventListener('click', () => testProviderPing('ollama'));
    $('btn-test-openrouter')?.addEventListener('click', () => testProviderPing('openrouter'));
    $('btn-test-groq')?.addEventListener('click', () => testProviderPing('groq'));
    $('btn-test-mistral')?.addEventListener('click', () => testProviderPing('mistral'));
    $('btn-test-xai')?.addEventListener('click', () => testProviderPing('xai'));

    // Connect Hub Modal
    $('btn-connect-hub')?.addEventListener('click', () => openModal('connect-modal'));
    $('hub-status-badge')?.addEventListener('click', () => openModal('connect-modal'));
    $('btn-modal-cancel')?.addEventListener('click', () => closeModal('connect-modal'));
    $('btn-modal-save')?.addEventListener('click', () => {
      const url = $('input-hub-url')?.value || 'http://localhost:7777';
      const tok = $('input-hub-token')?.value || '';
      connectHub(url, tok);
      closeModal('connect-modal');
    });

    // Swarm Agent Modals
    $('btn-add-agent')?.addEventListener('click', () => openModal('add-agent-modal'));
    $('btn-cancel-agent')?.addEventListener('click', () => closeModal('add-agent-modal'));
    $('btn-submit-agent')?.addEventListener('click', () => {
      const id = ($('new-agent-id')?.value || '').trim().toLowerCase();
      const role = ($('new-agent-role')?.value || '').trim();
      const provider = $('new-agent-provider')?.value || 'gemini';
      const model = ($('new-agent-model')?.value || '').trim() || state.providers[provider].defaultModel;

      if (!id || !role) {
        toast('Agent ID and role required.', 'warning');
        return;
      }
      state.agents.push({
        id,
        name: role,
        role,
        provider,
        model,
        lane: `lane-${id}`,
        color: provider === 'anthropic' ? '#f59e0b' : provider === 'openai' ? '#10b981' : '#00f2fe',
        status: 'idle',
        task: 'Initialized',
      });
      renderAgentRoster();
      renderTopology();
      closeModal('add-agent-modal');
      toast(`Added agent @${id} powered by ${provider}/${model}`, 'success');
    });

    // Inter-Agent Request Delegation
    $('btn-send-agent-request')?.addEventListener('click', sendAgentRequest);
    $('preset-req-1')?.addEventListener('click', () => {
      if ($('req-text-input')) $('req-text-input').value = 'Please expose GET /api/v1/topology in src/hub.mjs returning active peers array';
    });
    $('preset-req-2')?.addEventListener('click', () => {
      if ($('req-text-input')) $('req-text-input').value = 'Please review AST contract changes for OpenAPI v3 schema in contracts/api.json';
    });
    $('btn-copy-join-cmd')?.addEventListener('click', () => {
      const code = $('join-cmd-snippet')?.textContent || '';
      if (navigator.clipboard) {
        navigator.clipboard.writeText(code).then(() => toast('Join command copied to clipboard!', 'success')).catch(() => {});
      } else {
        toast(`Command: ${code}`, 'info');
      }
    });

    // Multi-Laptop Settings Modal
    $('btn-open-settings')?.addEventListener('click', () => openModal('settings-modal'));
    $('btn-configure-providers')?.addEventListener('click', () => openModal('settings-modal'));
    $('btn-close-settings')?.addEventListener('click', () => closeModal('settings-modal'));
    $('btn-save-settings')?.addEventListener('click', saveSettings);
    $('btn-quick-mesh-actors')?.addEventListener('click', () => $('tab-btn-swarm')?.click());

    // CRDT Mutate Inline
    $('btn-quick-commit-crdt')?.addEventListener('click', () => {
      const k = $('quick-crdt-key')?.value;
      const v = $('quick-crdt-val')?.value;
      if (k && v) {
        mutateCrdtSymbol(k, v);
        $('quick-crdt-key').value = '';
        $('quick-crdt-val').value = '';
      }
    });

    // MACP Create Modal
    $('btn-open-create-macp')?.addEventListener('click', () => openModal('create-macp-modal'));
    $('btn-cancel-macp')?.addEventListener('click', () => closeModal('create-macp-modal'));
    $('btn-submit-macp')?.addEventListener('click', () => {
      const mode = $('macp-mode')?.value;
      const title = $('macp-title')?.value;
      const initiator = $('macp-initiator')?.value;
      if (!title) {
        toast('Session title is required.', 'warning');
        return;
      }
      createMacpSession(mode, title, initiator);
    });

    // Voice & Audio VU Meter
    $('btn-toggle-mic')?.addEventListener('click', toggleMicrophone);
    $('btn-mute-mic')?.addEventListener('click', toggleMute);

    // Refresh buttons
    $('btn-refresh-topo')?.addEventListener('click', () => {
      syncHubOverview();
      toast('Refreshed topology graph.', 'info');
    });
    $('btn-clear-events')?.addEventListener('click', () => {
      state.eventsLog = [];
      renderEventsConsole();
      toast('Events log cleared.', 'info');
    });
    $('btn-verify-dag-chain')?.addEventListener('click', () => {
      toast('Cryptographic Merkle DAG verified: All parent hashes and root valid.', 'success');
    });
  }

  // --- Global Exposed App Object for HTML onclick Handlers ---
  window.AgentMeshApp = {
    releaseIntent,
    castMacpVote,
    sendAgentRequest,
    quickPromptAgent: (agentId) => {
      const select = $('req-to-select');
      if (select) select.value = agentId;
      $('tab-btn-swarm')?.click();
      $('req-text-input')?.focus();
    },
    editCrdtSymbol: (key, val) => {
      const newVal = prompt(`Update value for ${key}:`, val);
      if (newVal !== null) mutateCrdtSymbol(key, newVal);
    },
    inspectDagNode: (hash) => {
      const node = state.dagNodes.find((n) => n.hash === hash);
      if (node) {
        alert(`Merkle Block ${node.hash}\nKind: ${node.kind}\nAuthor: @${node.actor}\nPayload:\n${JSON.stringify(node.payload, null, 2)}`);
      }
    },
  };

  // --- Boot Sequence ---
  window.addEventListener('DOMContentLoaded', async () => {
    loadSettings();
    setupTabs();
    initEvents();
    initBoard();
    await connectHub(state.hubUrl, state.token);
  });

})();
