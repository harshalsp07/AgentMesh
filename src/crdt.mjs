// src/crdt.mjs — Delta-State Semantic CRDT Engine for Multi-Agent Swarms
// Strong Eventual Consistency (SEC) across AST symbols, contracts, and intent scopes.

export class VectorClock {
  constructor(entries = {}) {
    this.map = new Map(Object.entries(entries));
  }

  get(actor) {
    return this.map.get(actor) || 0;
  }

  tick(actor) {
    const next = this.get(actor) + 1;
    this.map.set(actor, next);
    return next;
  }

  update(other) {
    const otherMap = other instanceof VectorClock ? other.map : new Map(Object.entries(other || {}));
    for (const [actor, counter] of otherMap.entries()) {
      if (counter > this.get(actor)) {
        this.map.set(actor, counter);
      }
    }
  }

  toJSON() {
    return Object.fromEntries(this.map.entries());
  }

  clone() {
    return new VectorClock(this.toJSON());
  }

  // Returns: 'equal' | 'before' | 'after' | 'concurrent'
  compare(other) {
    const o = other instanceof VectorClock ? other : new VectorClock(other);
    const allActors = new Set([...this.map.keys(), ...o.map.keys()]);
    let hasGreater = false;
    let hasLesser = false;

    for (const a of allActors) {
      const v1 = this.get(a);
      const v2 = o.get(a);
      if (v1 > v2) hasGreater = true;
      if (v1 < v2) hasLesser = true;
    }

    if (!hasGreater && !hasLesser) return 'equal';
    if (hasGreater && !hasLesser) return 'after';
    if (!hasGreater && hasLesser) return 'before';
    return 'concurrent';
  }
}

export class SemanticRegister {
  constructor(key, value, actor, lamport = 0, deleted = false) {
    this.key = key;
    this.value = value;
    this.actor = actor;
    this.lamport = lamport;
    this.deleted = deleted;
  }

  // Deterministic LWW resolution with actor tie-breaking
  shouldOverrule(incoming) {
    if (incoming.lamport > this.lamport) return true;
    if (incoming.lamport < this.lamport) return false;
    // Tie-breaker: deterministic string comparison
    return incoming.actor > this.actor;
  }

  merge(incoming) {
    if (this.shouldOverrule(incoming)) {
      this.value = incoming.value;
      this.actor = incoming.actor;
      this.lamport = incoming.lamport;
      this.deleted = incoming.deleted;
      return true; // overrule occurred
    }
    return false;
  }

  toJSON() {
    return {
      key: this.key,
      value: this.value,
      actor: this.actor,
      lamport: this.lamport,
      deleted: this.deleted,
    };
  }
}

export class SemanticDocument {
  constructor(docId = 'default') {
    this.docId = docId;
    this.clock = new VectorClock();
    this.registers = new Map(); // key -> SemanticRegister
    this.opLog = []; // causal log of applied deltas
  }

  setSymbol(key, value, actor) {
    const lamport = this.clock.tick(actor);
    const reg = new SemanticRegister(key, value, actor, lamport, false);
    const existing = this.registers.get(key);
    const isConcurrent = existing && existing.lamport === lamport && existing.actor !== actor;
    
    if (!existing || existing.shouldOverrule(reg)) {
      this.registers.set(key, reg);
    }

    const op = { type: 'set', ...reg.toJSON(), clock: this.clock.toJSON() };
    this.opLog.push(op);
    return { op, concurrentConflict: !!isConcurrent };
  }

  deleteSymbol(key, actor) {
    const lamport = this.clock.tick(actor);
    const reg = new SemanticRegister(key, null, actor, lamport, true);
    const existing = this.registers.get(key);
    if (!existing || existing.shouldOverrule(reg)) {
      this.registers.set(key, reg);
    }
    const op = { type: 'delete', ...reg.toJSON(), clock: this.clock.toJSON() };
    this.opLog.push(op);
    return { op };
  }

  getSymbol(key) {
    const reg = this.registers.get(key);
    if (!reg || reg.deleted) return null;
    return reg.value;
  }

  getAllSymbols() {
    const out = {};
    for (const [k, reg] of this.registers.entries()) {
      if (!reg.deleted) out[k] = reg.value;
    }
    return out;
  }

  // Generate delta containing only operations since otherClock
  getDelta(sinceClock = {}) {
    const since = sinceClock instanceof VectorClock ? sinceClock : new VectorClock(sinceClock);
    const ops = this.opLog.filter((op) => {
      const opActor = op.actor;
      const opCount = op.lamport;
      return opCount > since.get(opActor);
    });
    return {
      docId: this.docId,
      clock: this.clock.toJSON(),
      ops,
    };
  }

  // Mathematically merge incoming delta with Strong Eventual Consistency
  applyDelta(delta) {
    if (!delta || !Array.isArray(delta.ops)) return { applied: 0, conflicts: [] };
    const conflicts = [];
    let applied = 0;

    for (const op of delta.ops) {
      const incomingReg = new SemanticRegister(
        op.key,
        op.value,
        op.actor,
        op.lamport,
        op.deleted || op.type === 'delete'
      );

      const existing = this.registers.get(op.key);
      if (existing) {
        // Detect concurrent write to same symbol
        const rel = this.clock.compare(op.clock || {});
        if (rel === 'concurrent' && existing.actor !== op.actor) {
          conflicts.push({
            key: op.key,
            actorA: existing.actor,
            actorB: op.actor,
            valA: existing.value,
            valB: op.value,
            resolution: existing.shouldOverrule(incomingReg) ? op.actor : existing.actor,
          });
        }
        if (existing.merge(incomingReg)) {
          applied++;
        }
      } else {
        this.registers.set(op.key, incomingReg);
        applied++;
      }

      this.clock.update(op.clock || { [op.actor]: op.lamport });
      this.opLog.push(op);
    }

    if (delta.clock) {
      this.clock.update(delta.clock);
    }

    return { applied, conflicts };
  }

  toJSON() {
    return {
      docId: this.docId,
      clock: this.clock.toJSON(),
      symbols: this.getAllSymbols(),
      registers: Object.fromEntries(
        [...this.registers.entries()].map(([k, r]) => [k, r.toJSON()])
      ),
    };
  }
}
