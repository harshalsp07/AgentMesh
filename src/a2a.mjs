// src/a2a.mjs — Google Agent2Agent (A2A) Protocol Standard Integration
// Exposes standardized Agent Cards and JSON-RPC 2.0 inter-agent endpoints.

export function generateAgentCard(hubUrl = 'http://localhost:7777', actor = 'mesh-hub') {
  return {
    $schema: 'https://a2a-protocol.org/schemas/agent-card-v1.json',
    id: `agentmesh:${actor}`,
    name: 'AgentMesh Swarm Coordinator',
    version: '1.2.0',
    description: 'Shared multi-agent coordination kernel with copy-on-write lanes, semantic CRDT, MACP bounded sessions, and epistemic Merkle DAG.',
    provider: {
      name: 'AgentMesh Project',
      url: hubUrl,
    },
    protocols: {
      a2a: '1.0.0',
      macp: '0.9.2',
      mcp: '2024-11-05',
    },
    capabilities: [
      'multi_agent_coordination',
      'semantic_crdt_sync',
      'ast_contract_verification',
      'merkle_dag_provenance',
      'webrtc_swarm_mesh',
      'lane_copy_on_write',
      'integration_queue_cas',
    ],
    endpoints: {
      jsonRpc: `${hubUrl}/a2a/rpc`,
      events: `${hubUrl}/events`,
      state: `${hubUrl}/state`,
      crdt: `${hubUrl}/api/crdt`,
      macp: `${hubUrl}/api/macp`,
      dag: `${hubUrl}/api/dag`,
      board: `${hubUrl}/api/board`,
      voiceSignal: `${hubUrl}/api/voice-signal`,
      overview: `${hubUrl}/api/overview`,
    },
    macpModes: ['decision', 'proposal', 'task', 'handoff', 'quorum'],
    auth: {
      type: 'ed25519-capability-token',
      header: 'Authorization: Bearer <token>',
      scopeDelegation: true,
    },
  };
}

export function handleA2ARpc(body, { macpKernel, crdtDoc, merkelDag, hubState }) {
  if (!body || body.jsonrpc !== '2.0' || !body.method) {
    return { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32600, message: 'Invalid Request: expected JSON-RPC 2.0' } };
  }

  const { id, method, params = {} } = body;

  switch (method) {
    case 'agent.discover':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          card: generateAgentCard(),
          roster: hubState?.roster || [],
          intents: hubState?.intents || [],
          merkleRoot: merkelDag ? merkelDag.getRootHash() : null,
        },
      };

    case 'agent.sync': {
      if (!crdtDoc) return { jsonrpc: '2.0', id, error: { code: -32603, message: 'CRDT not initialized' } };
      const delta = crdtDoc.getDelta(params.sinceClock || {});
      return {
        jsonrpc: '2.0',
        id,
        result: {
          delta,
          clock: crdtDoc.clock.toJSON(),
        },
      };
    }

    case 'agent.macp.propose': {
      if (!macpKernel) return { jsonrpc: '2.0', id, error: { code: -32603, message: 'MACP not initialized' } };
      const sess = macpKernel.createSession({
        mode: params.mode || 'proposal',
        initiator: params.actor || 'a2a-peer',
        title: params.title || 'A2A Coordination Session',
        participants: params.participants || [],
        data: params.data || {},
      });
      return {
        jsonrpc: '2.0',
        id,
        result: { session: sess.toJSON() },
      };
    }

    case 'agent.status':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          ok: true,
          status: 'online',
          seq: hubState?.seq || 0,
          activeIntents: hubState?.intents?.length || 0,
        },
      };

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}
