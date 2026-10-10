// src/dag.mjs — Epistemic Merkle-DAG State Sourcing & Deterministic Replay
// Cryptographic content-addressed provenance for autonomous agent reasoning and code mutations.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function hashObject(obj) {
  const str = JSON.stringify(obj, Object.keys(obj).sort());
  return createHash('sha256').update(str).digest('hex').slice(0, 32);
}

export class MerkleNode {
  constructor({ id, parents = [], actor, kind, payload, timestamp = Date.now(), metadata = {} }) {
    this.parents = parents.sort();
    this.actor = actor;
    this.kind = kind; // 'thought' | 'tool_call' | 'intent' | 'contract_diff' | 'crdt_delta'
    this.payload = payload;
    this.timestamp = timestamp;
    this.metadata = metadata;
    // Content-addressable hash identity
    this.id = id || hashObject({
      parents: this.parents,
      actor: this.actor,
      kind: this.kind,
      payload: this.payload,
      timestamp: this.timestamp,
    });
  }

  toJSON() {
    return {
      id: this.id,
      parents: this.parents,
      actor: this.actor,
      kind: this.kind,
      payload: this.payload,
      timestamp: this.timestamp,
      metadata: this.metadata,
    };
  }
}

export class MerkleDAG {
  constructor(dir = '.mesh') {
    this.dir = dir;
    this.nodes = new Map(); // id -> MerkleNode
    this.heads = new Set(); // current leaf node ids
    this.roots = new Set(); // nodes with 0 parents
    this.load();
  }

  load() {
    const file = join(this.dir, 'dag.json');
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        for (const n of raw.nodes || []) {
          const node = new MerkleNode(n);
          this.nodes.set(node.id, node);
        }
        this.recomputeHeadsAndRoots();
      } catch {}
    }
  }

  save() {
    const file = join(this.dir, 'dag.json');
    try {
      const out = {
        updatedAt: Date.now(),
        rootHash: this.getRootHash(),
        heads: [...this.heads],
        nodes: [...this.nodes.values()].map((n) => n.toJSON()),
      };
      writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
    } catch {}
  }

  recomputeHeadsAndRoots() {
    this.heads = new Set(this.nodes.keys());
    this.roots = new Set();

    for (const node of this.nodes.values()) {
      if (!node.parents || node.parents.length === 0) {
        this.roots.add(node.id);
      }
      // Any node referenced as a parent is not a head
      for (const p of node.parents) {
        this.heads.delete(p);
      }
    }
  }

  append(actor, kind, payload, parentIds = null, metadata = {}) {
    // If no parents explicitly provided, link to all current heads
    const parents = parentIds !== null ? parentIds : [...this.heads];
    const node = new MerkleNode({
      parents,
      actor,
      kind,
      payload,
      metadata,
    });

    this.nodes.set(node.id, node);
    // Update heads: remove current parents, add new node
    for (const p of node.parents) {
      this.heads.delete(p);
    }
    this.heads.add(node.id);
    if (node.parents.length === 0) {
      this.roots.add(node.id);
    }

    this.save();
    return node;
  }

  getNode(id) {
    return this.nodes.get(id) || null;
  }

  getRootHash() {
    const headList = [...this.heads].sort();
    return createHash('sha256').update(headList.join(':')).digest('hex').slice(0, 32);
  }

  // State vector exchange: find missing nodes given remote known heads
  syncDiff(remoteHeads = []) {
    const remoteSet = new Set(remoteHeads);
    const missing = [];
    const queue = [...this.heads];
    const visited = new Set();

    while (queue.length > 0) {
      const curr = queue.shift();
      if (!curr || visited.has(curr) || remoteSet.has(curr)) continue;
      visited.add(curr);

      const node = this.nodes.get(curr);
      if (node) {
        missing.push(node.toJSON());
        for (const p of node.parents) {
          if (!remoteSet.has(p)) queue.push(p);
        }
      }
    }

    return {
      rootHash: this.getRootHash(),
      heads: [...this.heads],
      missingNodes: missing.reverse(), // Causal chronological order
    };
  }

  // Merge nodes received from peer
  mergeNodes(incomingNodes = []) {
    let count = 0;
    for (const n of incomingNodes) {
      if (!this.nodes.has(n.id)) {
        const node = new MerkleNode(n);
        this.nodes.set(node.id, node);
        count++;
      }
    }
    this.recomputeHeadsAndRoots();
    this.save();
    return { added: count, total: this.nodes.size, rootHash: this.getRootHash() };
  }

  // Deterministic replay: return chronological topological sort of all nodes
  replay() {
    const inDegree = new Map();
    const adj = new Map(); // parent -> children

    for (const id of this.nodes.keys()) {
      inDegree.set(id, 0);
      adj.set(id, []);
    }

    for (const node of this.nodes.values()) {
      inDegree.set(node.id, node.parents.length);
      for (const p of node.parents) {
        if (adj.has(p)) adj.get(p).push(node.id);
      }
    }

    const q = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) q.push(id);
    }

    const order = [];
    while (q.length > 0) {
      const curr = q.shift();
      const node = this.nodes.get(curr);
      if (node) order.push(node.toJSON());

      for (const child of adj.get(curr) || []) {
        const deg = inDegree.get(child) - 1;
        inDegree.set(child, deg);
        if (deg === 0) q.push(child);
      }
    }

    return order;
  }
}
