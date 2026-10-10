// src/macp.mjs — Multi-Agent Coordination Protocol (MACP) Engine
// RFC-grade bounded coordination sessions: Decision, Proposal, Task, Handoff, Quorum.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const MACP_MODES = ['decision', 'proposal', 'task', 'handoff', 'quorum'];

function genId(prefix = 'sess') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export class MACPSession {
  constructor(options = {}) {
    this.id = options.id || genId('macp');
    this.mode = options.mode;
    if (!MACP_MODES.includes(this.mode)) {
      throw new Error(`Invalid MACP mode: ${this.mode}. Expected one of ${MACP_MODES.join(', ')}`);
    }
    this.initiator = options.initiator || 'anonymous';
    this.title = options.title || 'Untitled Session';
    this.participants = new Set(options.participants || [this.initiator]);
    this.status = options.status || 'active'; // 'active' | 'concluded' | 'expired' | 'aborted'
    this.createdAt = options.createdAt || Date.now();
    this.ttlMs = options.ttlMs || 300_000; // 5 min default
    this.expiresAt = this.createdAt + this.ttlMs;
    this.history = options.history || [];
    this.data = options.data || {};
    this.outcome = options.outcome || null;
  }

  isExpired(now = Date.now()) {
    return now > this.expiresAt && this.status === 'active';
  }

  logStep(actor, action, payload = {}) {
    const entry = {
      seq: this.history.length + 1,
      actor,
      action,
      payload,
      timestamp: Date.now(),
    };
    this.history.push(entry);
    return entry;
  }

  // ---- Mode 1: Decision (Proposal, evaluations, weighted votes, binding outcome) ----
  castVote(actor, vote, weight = 1, rationale = '') {
    if (this.mode !== 'decision') throw new Error('castVote only valid in decision mode');
    if (this.status !== 'active') throw new Error(`Session is ${this.status}`);
    this.participants.add(actor);

    this.data.votes = this.data.votes || {};
    this.data.votes[actor] = { vote, weight, rationale, timestamp: Date.now() };
    this.logStep(actor, 'vote_cast', { vote, weight, rationale });

    // Check if all designated participants voted or quorum achieved
    return this.evaluateDecision();
  }

  evaluateDecision() {
    const votes = Object.values(this.data.votes || {});
    let yesWeight = 0;
    let noWeight = 0;
    let totalWeight = 0;

    for (const v of votes) {
      if (v.vote === 'yes' || v.vote === true || v.vote === 'approve') yesWeight += v.weight;
      else if (v.vote === 'no' || v.vote === false || v.vote === 'reject') noWeight += v.weight;
      totalWeight += v.weight;
    }

    const minQuorum = this.data.minQuorum || 2;
    if (votes.length >= minQuorum) {
      const passed = yesWeight > noWeight;
      this.outcome = {
        result: passed ? 'approved' : 'rejected',
        yesWeight,
        noWeight,
        totalWeight,
        votesCount: votes.length,
        concludedAt: Date.now(),
      };
      this.status = 'concluded';
      this.logStep('system', 'decision_concluded', this.outcome);
    }
    return this.outcome;
  }

  // ---- Mode 2: Proposal (Negotiation Ladder: Scope Split -> Temporal -> Human) ----
  advanceNegotiation(actor, proposal) {
    if (this.mode !== 'proposal') throw new Error('advanceNegotiation only valid in proposal mode');
    this.data.rounds = this.data.rounds || [];
    const roundNumber = this.data.rounds.length + 1;

    let strategy = 'scope_partitioning';
    if (roundNumber === 2) strategy = 'temporal_sequencing';
    else if (roundNumber >= 3) strategy = 'human_arbitration';

    const roundData = {
      round: roundNumber,
      actor,
      strategy,
      proposal,
      timestamp: Date.now(),
    };
    this.data.rounds.push(roundData);
    this.logStep(actor, `negotiation_round_${roundNumber}`, roundData);

    if (proposal.acceptedByAll || roundNumber >= 3) {
      this.status = 'concluded';
      this.outcome = {
        resolved: !!proposal.acceptedByAll,
        strategy,
        finalProposal: proposal,
        concludedAt: Date.now(),
      };
      this.logStep('system', 'proposal_resolved', this.outcome);
    }
    return roundData;
  }

  // ---- Mode 3: Task (Bounded Task Delegation with contract) ----
  updateTask(actor, status, result = null) {
    if (this.mode !== 'task') throw new Error('updateTask only valid in task mode');
    const valid = ['assigned', 'accepted', 'in_progress', 'completed', 'failed'];
    if (!valid.includes(status)) throw new Error(`Invalid task status: ${status}`);

    this.data.taskStatus = status;
    if (result) this.data.result = result;
    this.logStep(actor, `task_${status}`, { status, result });

    if (status === 'completed' || status === 'failed') {
      this.status = 'concluded';
      this.outcome = { status, result, completedBy: actor, concludedAt: Date.now() };
    }
    return this.data;
  }

  // ---- Mode 4: Handoff (Context capsule transfer between agents) ----
  completeHandoff(fromActor, toActor, capsule) {
    if (this.mode !== 'handoff') throw new Error('completeHandoff only valid in handoff mode');
    this.data.handoff = {
      from: fromActor,
      to: toActor,
      capsule,
      transferredAt: Date.now(),
    };
    this.status = 'concluded';
    this.outcome = {
      status: 'transferred',
      from: fromActor,
      to: toActor,
      capsuleId: capsule.id || genId('cap'),
      concludedAt: Date.now(),
    };
    this.logStep(fromActor, 'handoff_completed', this.outcome);
    return this.outcome;
  }

  // ---- Mode 5: Quorum (Threshold consensus e.g. >= 67% for migrations/merges) ----
  registerQuorumBallot(actor, approve, rationale = '') {
    if (this.mode !== 'quorum') throw new Error('registerQuorumBallot only valid in quorum mode');
    this.data.ballots = this.data.ballots || {};
    this.data.ballots[actor] = { approve: !!approve, rationale, timestamp: Date.now() };
    this.logStep(actor, 'quorum_ballot', { approve: !!approve, rationale });

    const totalEligible = this.data.totalEligible || Math.max(this.participants.size, 3);
    const ballots = Object.values(this.data.ballots);
    const approves = ballots.filter((b) => b.approve).length;
    const threshold = this.data.threshold || 0.67; // 67% default

    if (ballots.length >= Math.ceil(totalEligible * threshold) || ballots.length >= totalEligible) {
      const ratio = approves / totalEligible;
      const reached = (ratio + 0.005) >= threshold;
      this.status = 'concluded';
      this.outcome = {
        quorumReached: reached,
        ratio,
        threshold,
        approves,
        totalBallots: ballots.length,
        totalEligible,
        concludedAt: Date.now(),
      };
      this.logStep('system', 'quorum_concluded', this.outcome);
    }
    return this.outcome || { pending: true, approves, ballotsCount: ballots.length };
  }

  toJSON() {
    return {
      id: this.id,
      mode: this.mode,
      title: this.title,
      initiator: this.initiator,
      participants: [...this.participants],
      status: this.status,
      createdAt: this.createdAt,
      expiresAt: this.expiresAt,
      ttlMs: this.ttlMs,
      history: this.history,
      data: this.data,
      outcome: this.outcome,
    };
  }
}

export class MACPKernel {
  constructor(dir = '.mesh') {
    this.dir = dir;
    this.sessions = new Map();
    this.load();
  }

  load() {
    const file = join(this.dir, 'macp.json');
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        for (const s of raw.sessions || []) {
          this.sessions.set(s.id, new MACPSession(s));
        }
      } catch {}
    }
  }

  save() {
    const file = join(this.dir, 'macp.json');
    try {
      const out = {
        updatedAt: Date.now(),
        sessions: [...this.sessions.values()].map((s) => s.toJSON()),
      };
      writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
    } catch {}
  }

  createSession(options) {
    const sess = new MACPSession(options);
    this.sessions.set(sess.id, sess);
    this.save();
    return sess;
  }

  getSession(id) {
    const sess = this.sessions.get(id);
    if (sess && sess.isExpired()) {
      sess.status = 'expired';
      this.save();
    }
    return sess || null;
  }

  listSessions(filter = {}) {
    const now = Date.now();
    const list = [...this.sessions.values()].map((s) => {
      if (s.isExpired(now)) s.status = 'expired';
      return s.toJSON();
    });
    if (filter.mode) return list.filter((s) => s.mode === filter.mode);
    if (filter.status) return list.filter((s) => s.status === filter.status);
    return list;
  }
}
