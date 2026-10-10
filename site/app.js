// site/app.js — Production Client & Swarm Engine for AgentMesh
// Dual-Mode: Live Hub SSE Stream + Client-Side Autonomous Swarm Simulator

(function () {
  'use strict';

  // --- Audio Synthesis (Tactile Micro-Interactions) ---
  class SoundFX {
    constructor() {
      this.enabled = true;
      this.ctx = null;
    }
    init() {
      if (!this.ctx && typeof AudioContext !== 'undefined') {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      }
    }
    play(type) {
      if (!this.enabled) return;
      try {
        this.init();
        if (!this.ctx) return;
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.connect(gain);
        gain.connect(this.ctx.destination);

        if (type === 'click') {
          osc.frequency.setValueAtTime(600, now);
          osc.frequency.exponentialRampToValueAtTime(300, now + 0.04);
          gain.gain.setValueAtTime(0.08, now);
          gain.gain.linearRampToValueAtTime(0.001, now + 0.04);
          osc.start(now);
          osc.stop(now + 0.04);
        } else if (type === 'merge') {
          osc.frequency.setValueAtTime(440, now);
          osc.frequency.setValueAtTime(554.37, now + 0.06); // C#
          osc.frequency.setValueAtTime(659.25, now + 0.12); // E
          gain.gain.setValueAtTime(0.12, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
          osc.start(now);
          osc.stop(now + 0.3);
        } else if (type === 'collision') {
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(220, now);
          osc.frequency.linearRampToValueAtTime(140, now + 0.15);
          gain.gain.setValueAtTime(0.15, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
          osc.start(now);
          osc.stop(now + 0.18);
        } else if (type === 'vote') {
          osc.frequency.setValueAtTime(523.25, now);
          osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.08);
          gain.gain.setValueAtTime(0.1, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
          osc.start(now);
          osc.stop(now + 0.15);
        }
      } catch {}
    }
  }

  const sfx = new SoundFX();

  // --- State & Config ---
  const state = {
    mode: 'sim', // 'live' | 'sim'
    hubUrl: localStorage.getItem('mesh_hub_url') || (location.port === '7777' ? location.origin : 'http://localhost:7777'),
    token: localStorage.getItem('mesh_auth_token') || '',
    activeTab: 'topo',
    simRunning: true,
    simSpeed: 2400, // ms per tick
    simTickCount: 0,
    seq: 42,
    trunk: 'v1.2.0-main',
    frozen: false,
    
    // Live & Sim Data
    agents: [
      { id: 'frontend-agent', role: 'UI / Client', status: 'active', currentTask: 'Revising Topo SVG conduits', lane: 'lane-fe-01', color: '#38bdf8' },
      { id: 'backend-agent', role: 'Core API', status: 'active', currentTask: 'Verifying auth capability tokens', lane: 'lane-be-02', color: '#34d399' },
      { id: 'schema-steward', role: 'Contracts', status: 'idle', currentTask: 'Monitoring OpenAPI v2 contracts', lane: 'lane-schema-03', color: '#a855f7' },
      { id: 'security-auditor', role: 'Audit / Guard', status: 'active', currentTask: 'Sweeping 429 write rates', lane: 'lane-sec-04', color: '#fbbf24' },
    ],
    intents: [],
    collisions: [],
    crdtSymbols: {
      'src/auth/token.ts:verify()': { value: 'ed25519_verify_v2', actor: 'backend-agent', lamport: 12 },
      'src/ui/theme.css:palette': { value: 'glassmorphic_obsidian', actor: 'frontend-agent', lamport: 9 },
      'contracts/api.json:version': { value: '2.4.0', actor: 'schema-steward', lamport: 7 },
    },
    vectorClock: { 'frontend-agent': 9, 'backend-agent': 12, 'schema-steward': 7, 'security-auditor': 4 },
    macpSessions: [],
    dagNodes: [],
    boardOps: [],
    voicePeers: { 'user-local': { talking: false, muted: false } },
  };

  const $ = (id) => document.getElementById(id);

  // --- Toast Manager ---
  function toast(msg, type = 'info') {
    const c = $('toast-container');
    if (!c) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(20px)';
      el.style.transition = 'all 0.3s ease';
      setTimeout(() => el.remove(), 300);
    }, 4000);
  }

  // --- SVG Topology Visualizer ---
  function renderTopology() {
    const svg = $('topology-svg');
    if (!svg) return;
    svg.innerHTML = '';

    const width = svg.clientWidth || 900;
    const height = svg.clientHeight || 520;
    const cx = width / 2;
    const cy = height / 2;

    const ns = 'http://www.w3.org/2000/svg';
    const defs = document.createElementNS(ns, 'defs');
    defs.innerHTML = `
      <filter id="glow-cyan" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="6" result="blur" />
        <feComposite in="SourceGraphic" in2="blur" operator="over" />
      </filter>
      <linearGradient id="trunkGrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#38bdf8"/>
        <stop offset="100%" stop-color="#a855f7"/>
      </linearGradient>
    `;
    svg.appendChild(defs);

    // Draw Central Trunk Node
    const trunkG = document.createElementNS(ns, 'g');
    trunkG.setAttribute('transform', `translate(${cx}, ${cy})`);
    trunkG.style.cursor = 'pointer';
    trunkG.innerHTML = `
      <circle r="42" fill="#0f172a" stroke="url(#trunkGrad)" stroke-width="3" filter="url(#glow-cyan)"/>
      <circle r="34" fill="none" stroke="rgba(56, 189, 248, 0.3)" stroke-dasharray="4,4"/>
      <text y="-6" text-anchor="middle" fill="#fff" font-size="11" font-weight="bold">TRUNK</text>
      <text y="12" text-anchor="middle" fill="#94a3b8" font-size="9" font-family="monospace">${state.trunk.slice(0, 10)}</text>
    `;
    trunkG.onclick = () => {
      sfx.play('click');
      toast(`Trunk Head: ${state.trunk} (CAS Sequence: #${state.seq})`);
    };

    // Agent Nodes in Circle
    const count = state.agents.length;
    const radius = Math.min(width, height) * 0.34;

    state.agents.forEach((agent, i) => {
      const angle = (i / count) * 2 * Math.PI - Math.PI / 2;
      const ax = cx + radius * Math.cos(angle);
      const ay = cy + radius * Math.sin(angle);

      // Conduit line to Trunk
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', `M ${cx} ${cy} Q ${(cx + ax) / 2 + (i % 2 ? 20 : -20)} ${(cy + ay) / 2} ${ax} ${ay}`);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', agent.color);
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-dasharray', '6,6');
      path.setAttribute('opacity', '0.65');
      svg.appendChild(path);

      // Agent Node Group
      const agG = document.createElementNS(ns, 'g');
      agG.setAttribute('transform', `translate(${ax}, ${ay})`);
      agG.style.cursor = 'pointer';
      agG.innerHTML = `
        <circle r="28" fill="#0b0e14" stroke="${agent.color}" stroke-width="2.5" />
        <circle r="34" fill="none" stroke="${agent.color}" stroke-width="1" opacity="0.3" class="pulse-ring"/>
        <text y="-4" text-anchor="middle" fill="#fff" font-size="9.5" font-weight="bold">${agent.id.replace('-agent', '')}</text>
        <text y="10" text-anchor="middle" fill="${agent.color}" font-size="8">${agent.lane.slice(-5)}</text>
      `;
      agG.onclick = () => {
        sfx.play('click');
        toast(`${agent.id}: ${agent.currentTask} on ${agent.lane}`);
      };
      svg.appendChild(agG);
    });

    svg.appendChild(trunkG);
  }

  // --- Swarm Simulator Engine ---
  const SIM_TASKS = [
    { actor: 'frontend-agent', file: 'src/ui/dashboard.tsx', change: 'Refined CRDT symbol matrix view' },
    { actor: 'backend-agent', file: 'src/api/auth.ts', change: 'Implemented ed25519 capability check' },
    { actor: 'schema-steward', file: 'contracts/api.json', change: 'Bumped API schema to v2.4.0' },
    { actor: 'security-auditor', file: 'src/policy.yaml', change: 'Validated denial list rules' },
  ];

  function runSimTick() {
    if (!state.simRunning || state.mode !== 'sim') return;
    state.simTickCount++;
    state.seq++;

    const task = SIM_TASKS[Math.floor(Math.random() * SIM_TASKS.length)];
    const agent = state.agents.find((a) => a.id === task.actor);
    if (agent) {
      agent.currentTask = task.change;
      state.vectorClock[agent.id] = (state.vectorClock[agent.id] || 0) + 1;
      
      // Update CRDT Symbol
      const symKey = `${task.file}:export`;
      state.crdtSymbols[symKey] = {
        value: `hash_${Math.random().toString(36).slice(2, 8)}`,
        actor: agent.id,
        lamport: state.vectorClock[agent.id],
      };

      // Append Merkle DAG node
      const dagNode = {
        id: `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        parents: state.dagNodes.length ? [state.dagNodes[state.dagNodes.length - 1].id] : [],
        actor: agent.id,
        kind: 'intent_commit',
        payload: { file: task.file, change: task.change },
        timestamp: Date.now(),
      };
      state.dagNodes.push(dagNode);
      if (state.dagNodes.length > 50) state.dagNodes.shift();

      // Trigger 1-in-6 collision scenario to showcase MACP negotiation ladder
      if (state.simTickCount % 6 === 0) {
        triggerSimCollision();
      } else {
        sfx.play('merge');
      }

      updateUI();
    }
  }

  function triggerSimCollision() {
    sfx.play('collision');
    const a1 = 'frontend-agent';
    const a2 = 'backend-agent';
    const collision = {
      id: `col-${Date.now()}`,
      a: a1,
      b: a2,
      file: 'src/api/auth.ts',
      grade: 'overlap_soft',
      stage: 'Round 1: Scope Partitioning',
    };
    state.collisions.unshift(collision);
    if (state.collisions.length > 5) state.collisions.pop();

    toast(`Collision detected on ${collision.file} between ${a1} and ${a2}! Advancing MACP Negotiation Ladder.`, 'warn');

    // Create MACP Session
    const sess = {
      id: `macp-${Date.now().toString(36)}`,
      mode: 'proposal',
      title: `Collision Resolution: ${collision.file}`,
      status: 'active',
      rounds: [
        { round: 1, strategy: 'scope_partitioning', proposal: 'Split auth token generation and validation' },
      ],
      createdAt: Date.now(),
    };
    state.macpSessions.unshift(sess);
  }

  // --- UI Update & Rendering ---
  function updateUI() {
    $('metric-seq').textContent = `#${state.seq}`;
    $('metric-trunk').textContent = state.trunk.slice(0, 12);
    $('metric-agents').textContent = state.agents.length;
    $('metric-intents').textContent = state.collisions.length ? `${state.collisions.length} collision` : '0 nominal';

    const statusBadge = $('hub-status-badge');
    if (statusBadge) {
      if (state.mode === 'live') {
        statusBadge.className = 'status-pill live';
        statusBadge.innerHTML = '<span class="status-dot"></span> LIVE HUB CONNECTED';
      } else {
        statusBadge.className = 'status-pill sim';
        statusBadge.innerHTML = '<span class="status-dot"></span> ⚡ AUTONOMOUS SWARM SIMULATOR';
      }
    }

    renderTopology();
    renderAgentCards();
    renderCRDT();
    renderMACP();
    renderDAG();
  }

  function renderAgentCards() {
    const c = $('agent-cards-container');
    if (!c) return;
    c.innerHTML = state.agents.map((a) => `
      <div class="agent-card active-work">
        <div class="agent-header">
          <span class="agent-name">
            <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${a.color};"></span>
            ${a.id}
          </span>
          <span class="agent-role-pill">${a.role}</span>
        </div>
        <div class="agent-bubble">${a.currentTask}</div>
        <div style="font-size:0.72rem;color:var(--text-dim);display:flex;justify-content:space-between;">
          <span>Lane: <code>${a.lane}</code></span>
          <span>Clock: <code>${state.vectorClock[a.id] || 0}</code></span>
        </div>
      </div>
    `).join('');
  }

  function renderCRDT() {
    const tbody = $('crdt-tbody');
    if (!tbody) return;
    tbody.innerHTML = Object.entries(state.crdtSymbols).map(([k, reg]) => `
      <tr>
        <td><code>${k}</code></td>
        <td style="color:var(--cyan-core);">${reg.value}</td>
        <td><code>${reg.actor}</code></td>
        <td><span style="background:rgba(56,189,248,0.15);padding:2px 6px;border-radius:4px;">${reg.lamport}</span></td>
      </tr>
    `).join('');

    const clockBox = $('vector-clock-view');
    if (clockBox) {
      clockBox.textContent = JSON.stringify(state.vectorClock, null, 2);
    }
  }

  function renderMACP() {
    const c = $('macp-sessions-container');
    if (!c) return;
    if (state.macpSessions.length === 0) {
      c.innerHTML = '<div style="color:var(--text-dim);font-size:0.82rem;padding:8px;">No active coordination sessions. Trigger an intent collision to observe MACP.</div>';
      return;
    }
    c.innerHTML = state.macpSessions.map((s) => `
      <div class="ladder-step">
        <div class="ladder-badge round${(s.rounds?.length || 1)}">Mode: ${s.mode}</div>
        <div style="flex:1;">
          <div style="font-weight:600;font-size:0.85rem;">${s.title}</div>
          <div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px;">
            Strategy: <code>${s.rounds?.[0]?.strategy || 'evaluation'}</code> — ${s.rounds?.[0]?.proposal || 'Active proposal deliberation'}
          </div>
        </div>
        <button class="btn-ghost" style="padding:4px 8px;font-size:0.72rem;" onclick="resolveMACP('${s.id}')">Vote Approve</button>
      </div>
    `).join('');
  }

  function renderDAG() {
    const c = $('dag-timeline-container');
    if (!c) return;
    c.innerHTML = state.dagNodes.slice().reverse().map((n) => `
      <div class="dag-node">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="dag-hash">${n.id.slice(0, 16)}…</span>
          <span style="font-size:0.7rem;color:var(--text-dim);">${new Date(n.timestamp).toLocaleTimeString()}</span>
        </div>
        <div style="font-size:0.78rem;"><strong>${n.actor}</strong>: ${n.payload?.change || 'Commit state'}</div>
        <div style="font-size:0.68rem;color:var(--text-dim);">Parents: ${n.parents.join(', ') || 'root'}</div>
      </div>
    `).join('');
  }

  window.resolveMACP = (id) => {
    sfx.play('vote');
    const idx = state.macpSessions.findIndex((s) => s.id === id);
    if (idx !== -1) {
      state.macpSessions.splice(idx, 1);
      state.collisions.shift();
      toast('MACP Session concluded via unanimous consensus! Committed to trunk.', 'ok');
      updateUI();
    }
  };

  // --- Tab Navigation ---
  function initTabs() {
    document.querySelectorAll('nav.nav-tabs button').forEach((btn) => {
      btn.onclick = () => {
        sfx.play('click');
        document.querySelectorAll('nav.nav-tabs button').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.view-panel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        const viewId = `view-${btn.dataset.tab}`;
        const viewEl = $(viewId);
        if (viewEl) viewEl.classList.add('active');
        state.activeTab = btn.dataset.tab;
        if (btn.dataset.tab === 'topo') renderTopology();
      };
    });

    document.addEventListener('keydown', (e) => {
      if (/input|textarea/i.test(e.target.tagName)) return;
      const tabs = ['topo', 'sim', 'crdt', 'macp', 'dag', 'board', 'voice', 'health'];
      if (e.key >= '1' && e.key <= '8') {
        const t = tabs[+e.key - 1];
        const btn = document.querySelector(`nav.nav-tabs button[data-tab="${t}"]`);
        if (btn) btn.click();
      }
    });
  }

  // --- Whiteboard Engine ---
  let boardTool = 'draw';
  let boardDrawing = false;
  let currentStroke = [];

  function initBoard() {
    const svg = $('board-svg');
    if (!svg) return;

    document.querySelectorAll('.board-toolbar button[data-tool]').forEach((b) => {
      b.onclick = () => {
        document.querySelectorAll('.board-toolbar button[data-tool]').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        boardTool = b.dataset.tool;
      };
    });

    svg.addEventListener('pointerdown', (e) => {
      boardDrawing = true;
      const rect = svg.getBoundingClientRect();
      const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      currentStroke = [pt];
    });

    svg.addEventListener('pointermove', (e) => {
      if (!boardDrawing) return;
      const rect = svg.getBoundingClientRect();
      const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      currentStroke.push(pt);
      renderLiveStroke(svg);
    });

    svg.addEventListener('pointerup', () => {
      if (boardDrawing && currentStroke.length > 1) {
        state.boardOps.push({ tool: boardTool, pts: currentStroke, color: $('board-color')?.value || '#38bdf8' });
        sfx.play('click');
      }
      boardDrawing = false;
      currentStroke = [];
    });
  }

  function renderLiveStroke(svg) {
    if (currentStroke.length < 2) return;
    const ns = 'http://www.w3.org/2000/svg';
    const path = document.createElementNS(ns, 'path');
    const d = currentStroke.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', $('board-color')?.value || '#38bdf8');
    path.setAttribute('stroke-width', '2.5');
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);
  }

  // --- Live Hub SSE Connector ---
  function connectLiveHub() {
    try {
      const evtSource = new EventSource(`${state.hubUrl}/events`);
      evtSource.onopen = () => {
        state.mode = 'live';
        toast('Connected to live AgentMesh Hub!', 'ok');
        updateUI();
      };
      evtSource.onmessage = (e) => {
        try {
          const payload = JSON.parse(e.data);
          state.seq = payload.seq || state.seq;
          toast(`Hub Event: ${payload.kind} by ${payload.actor}`);
          updateUI();
        } catch {}
      };
      evtSource.onerror = () => {
        evtSource.close();
        if (state.mode === 'live') {
          toast('Live hub connection lost. Falling back to autonomous simulation mode.', 'warn');
          state.mode = 'sim';
          updateUI();
        }
      };
    } catch {
      state.mode = 'sim';
    }
  }

  // --- Modal & Global Wiring ---
  function initModals() {
    const modal = $('connect-modal');
    $('btn-connect-hub').onclick = () => {
      sfx.play('click');
      modal.classList.add('open');
      $('input-hub-url').value = state.hubUrl;
      $('input-hub-token').value = state.token;
    };
    $('btn-modal-cancel').onclick = () => modal.classList.remove('open');
    $('btn-modal-save').onclick = () => {
      state.hubUrl = $('input-hub-url').value.trim();
      state.token = $('input-hub-token').value.trim();
      localStorage.setItem('mesh_hub_url', state.hubUrl);
      localStorage.setItem('mesh_auth_token', state.token);
      modal.classList.remove('open');
      connectLiveHub();
    };

    $('btn-toggle-sim').onclick = () => {
      state.simRunning = !state.simRunning;
      $('btn-toggle-sim').textContent = state.simRunning ? 'Pause Simulator' : 'Resume Simulator';
      toast(state.simRunning ? 'Simulator resumed.' : 'Simulator paused.');
    };

    $('btn-trigger-collision').onclick = () => {
      triggerSimCollision();
    };

    $('btn-sound-toggle').onclick = () => {
      sfx.enabled = !sfx.enabled;
      $('btn-sound-toggle').textContent = sfx.enabled ? '🔊 Audio: On' : '🔇 Audio: Off';
      toast(sfx.enabled ? 'Audio feedback enabled.' : 'Audio feedback muted.');
    };
  }

  // --- Progressive Web App Service Worker ---
  function registerServiceWorker() {
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }

  // --- Boot ---
  window.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initModals();
    initBoard();
    updateUI();
    registerServiceWorker();

    // Start simulation loop
    setInterval(runSimTick, state.simSpeed);

    // Attempt live hub connection if on port 7777
    if (location.port === '7777') {
      connectLiveHub();
    }
  });

  window.addEventListener('resize', () => {
    if (state.activeTab === 'topo') renderTopology();
  });

})();
