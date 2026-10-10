// test/macp-dag.test.mjs — Comprehensive tests for MACP Kernel, Merkle DAG, and A2A Gateway
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MACPKernel } from '../src/macp.mjs';
import { MerkleDAG } from '../src/dag.mjs';
import { generateAgentCard, handleA2ARpc } from '../src/a2a.mjs';
import { SemanticDocument } from '../src/crdt.mjs';

describe('MACP 5-Mode Kernel', () => {
  it('manages Decision mode with weighted voting and binding outcome', () => {
    const kernel = new MACPKernel('.mesh-test-macp');
    const sess = kernel.createSession({
      mode: 'decision',
      initiator: 'lead-agent',
      title: 'Upgrade PostgreSQL migration to v16',
      data: { minQuorum: 2 },
    });

    assert.equal(sess.status, 'active');
    sess.castVote('agent-alpha', 'approve', 2, 'Migration tested');
    const outcome = sess.castVote('agent-beta', 'approve', 1, 'Looks good');

    assert.ok(outcome);
    assert.equal(outcome.result, 'approved');
    assert.equal(sess.status, 'concluded');
  });

  it('manages Proposal mode with 3-round negotiation ladder', () => {
    const kernel = new MACPKernel('.mesh-test-macp');
    const sess = kernel.createSession({
      mode: 'proposal',
      initiator: 'fe-agent',
      title: 'Resolve intent conflict on src/routes.ts',
    });

    // Round 1: Scope partitioning
    const r1 = sess.advanceNegotiation('fe-agent', { split: true, acceptedByAll: false });
    assert.equal(r1.round, 1);
    assert.equal(r1.strategy, 'scope_partitioning');

    // Round 2: Temporal sequencing
    const r2 = sess.advanceNegotiation('be-agent', { sequence: ['be', 'fe'], acceptedByAll: true });
    assert.equal(r2.round, 2);
    assert.equal(sess.status, 'concluded');
    assert.ok(sess.outcome.resolved);
  });

  it('manages Quorum mode with threshold consensus', () => {
    const kernel = new MACPKernel('.mesh-test-macp');
    const sess = kernel.createSession({
      mode: 'quorum',
      initiator: 'sec-agent',
      title: 'Delete legacy auth endpoint',
      data: { threshold: 0.67, totalEligible: 3 },
    });

    sess.registerQuorumBallot('agent-1', true);
    sess.registerQuorumBallot('agent-2', true);
    const outcome = sess.registerQuorumBallot('agent-3', false);

    assert.ok(outcome.quorumReached);
    assert.equal(outcome.approves, 2);
    assert.equal(sess.status, 'concluded');
  });
});

describe('Epistemic Merkle DAG State Sourcing', () => {
  it('generates content-addressed nodes, computes Merkle root, and reconciles state vector', () => {
    const dag = new MerkleDAG('.mesh-test-dag');
    const n1 = dag.append('agent-a', 'thought', { reasoning: 'Refactor auth' });
    const n2 = dag.append('agent-b', 'tool_call', { tool: 'edit_file', path: 'auth.ts' });

    assert.ok(n1.id);
    assert.ok(n2.id);
    assert.ok(n2.parents.includes(n1.id));

    const rootHash = dag.getRootHash();
    assert.ok(rootHash);

    // Sync diff given empty remote
    const diff = dag.syncDiff([]);
    assert.equal(diff.missingNodes.length, 2);
    assert.equal(diff.missingNodes[0].id, n1.id);

    // Deterministic replay
    const replay = dag.replay();
    assert.equal(replay.length, 2);
    assert.equal(replay[0].id, n1.id);
    assert.equal(replay[1].id, n2.id);
  });
});

describe('A2A Standard Protocol Gateway', () => {
  it('generates compliant Agent Card with all capabilities and transports', () => {
    const card = generateAgentCard('https://mesh.local');
    assert.equal(card.name, 'AgentMesh Swarm Coordinator');
    assert.ok(card.capabilities.includes('semantic_crdt_sync'));
    assert.ok(card.capabilities.includes('multi_agent_coordination'));
  });

  it('handles JSON-RPC 2.0 agent.discover and agent.sync', () => {
    const doc = new SemanticDocument('a2a-test');
    doc.setSymbol('config:env', 'production', 'admin');

    const resDiscover = handleA2ARpc({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'agent.discover',
    }, { crdtDoc: doc });

    assert.equal(resDiscover.result.card.name, 'AgentMesh Swarm Coordinator');

    const resSync = handleA2ARpc({
      jsonrpc: '2.0',
      id: 'req-2',
      method: 'agent.sync',
      params: { sinceClock: {} },
    }, { crdtDoc: doc });

    assert.ok(resSync.result.delta);
    assert.equal(resSync.result.clock.admin, 1);
  });
});
