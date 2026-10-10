// src/p2p.mjs — WebRTC DataChannel Swarm Signaling & Mesh Coordinator
// Provides serverless direct peer-to-peer agent-to-agent intent and CRDT gossiping.

export class P2PSwarmCoordinator {
  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
    this.peers = new Map(); // actor -> { joinedAt, lastSeen, ip, metadata }
    this.signalMailbox = new Map(); // toActor -> Array of { from, type, data, timestamp }
  }

  join(actor, metadata = {}) {
    const now = Date.now();
    this.peers.set(actor, {
      joinedAt: now,
      lastSeen: now,
      metadata,
    });
    return { ok: true, peers: this.listPeers() };
  }

  leave(actor) {
    this.peers.delete(actor);
    this.signalMailbox.delete(actor);
    return { ok: true };
  }

  heartbeat(actor) {
    const peer = this.peers.get(actor);
    if (peer) {
      peer.lastSeen = Date.now();
    }
  }

  sendSignal(fromActor, toActor, type, data) {
    this.heartbeat(fromActor);
    const box = this.signalMailbox.get(toActor) || [];
    box.push({
      from: fromActor,
      type, // 'offer' | 'answer' | 'candidate' | 'gossip'
      data,
      timestamp: Date.now(),
    });
    this.signalMailbox.set(toActor, box);
    return { ok: true, queued: box.length };
  }

  drainSignals(toActor) {
    this.heartbeat(toActor);
    const box = this.signalMailbox.get(toActor) || [];
    this.signalMailbox.set(toActor, []);
    return box;
  }

  sweep(now = Date.now()) {
    for (const [actor, peer] of this.peers.entries()) {
      if (now - peer.lastSeen > this.ttlMs) {
        this.peers.delete(actor);
        this.signalMailbox.delete(actor);
      }
    }
    for (const [actor, signals] of this.signalMailbox.entries()) {
      const fresh = signals.filter((s) => now - s.timestamp <= this.ttlMs);
      if (fresh.length === 0) this.signalMailbox.delete(actor);
      else this.signalMailbox.set(actor, fresh);
    }
  }

  listPeers() {
    return [...this.peers.entries()].map(([actor, p]) => ({
      actor,
      joinedAt: p.joinedAt,
      lastSeen: p.lastSeen,
      metadata: p.metadata,
    }));
  }
}
