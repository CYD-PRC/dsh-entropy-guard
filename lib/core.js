/**
 * Entropy control core — a faithful, dependency-free JavaScript port of
 * `entropy-sdk` 0.1.9 (https://github.com/CYD-PRC/entropy-sdk, MIT),
 * the embeddable distillation of the EntropyRuntime paper (arXiv:2607.00334).
 *
 * Ported abstractions, one-to-one with the Python source:
 * - `Gear`                 five-level gear ladder G0–G4 (Definition 1)
 * - `UtilityGate`          U(s,a) >= theta, the sole dispatch channel (Theorems 2–3)
 * - `GearPolicy`           slow-up / fast-down gear state machine (§4)
 * - `FallbackConfig`       event-driven fallback bounds (Theorem 4)
 * - `RuntimeState`         rho = (g, sigma, epsilon) (Definition 4)
 * - `AuditLog`             append-only JSONL audit chain (§5/§8)
 * - `EntropyRuntime`       the control cycle (Algorithm 1)
 *
 * Fail-closed rules carried over verbatim from the Python implementation:
 * - the utility function must be injected explicitly; there is no fail-open mode;
 * - a throwing or non-finite utility is a denial (U = -inf), never an admission;
 * - an invalid `requiredGear` attestation is a denial, not a stack unwind;
 * - a failed audit append is an error, never a silent drop.
 *
 * @module dsh-entropy-guard/core
 */

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/* ------------------------------------------------------------------ *
 * Gear ladder (Definition 1)
 * ------------------------------------------------------------------ */

/** The five gears. The action space is monotonically nested: A0 ⊂ A1 ⊂ … ⊂ A4. */
export const Gear = Object.freeze({
  /** G0 — read-only observation, safe holding. */
  OBSERVE: 0,
  /** G1 — side-effect-free candidate plans. */
  SUGGEST: 1,
  /** G2 — bounded, reversible recovery actions. */
  PLAN: 2,
  /** G3 — independently chosen side-effecting actions. */
  EXECUTE: 3,
  /** G4 — system-level coordination. */
  INTEGRATE: 4,
});

/** Human labels indexed by gear value. */
export const GEAR_LABELS = Object.freeze(['Observe', 'Suggest', 'Plan', 'Execute', 'Integrate']);

/** Every gear value, lowest first. */
export const GEAR_VALUES = Object.freeze([0, 1, 2, 3, 4]);

/**
 * Render a gear the way the SDK does: `G3 Execute`.
 * @param gear - a gear value.
 * @returns the short label.
 */
export function gearLabel(gear) {
  return `G${gear} ${GEAR_LABELS[gear] ?? 'Unknown'}`;
}

/**
 * Nested action space: the current gear permits every requirement at or below it.
 * @param gear - current gear.
 * @param required - gear the action attests to needing.
 * @returns whether the action is inside the current action space.
 */
export function gearPermits(gear, required) {
  return required <= gear;
}

/**
 * Collapse a caller-declared `requiredGear` into a legal gear, or `null`.
 *
 * Mirrors `_safe_gear`: booleans are rejected explicitly (Python's IntEnum
 * lookup would silently read `True` as SUGGEST), floats and non-numbers are
 * rejected, and out-of-range integers are rejected. Callers treat `null` as a
 * failed attestation, i.e. fail-closed denial.
 * @param value - the untrusted attestation.
 * @returns a gear value, or `null`.
 */
export function safeGear(value) {
  if (typeof value === 'boolean') return null;
  if (!Number.isInteger(value)) return null;
  if (value < Gear.OBSERVE || value > Gear.INTEGRATE) return null;
  return value;
}

/* ------------------------------------------------------------------ *
 * Utility gate (Definitions 2–3, Theorem 2)
 * ------------------------------------------------------------------ */

/**
 * A gate decision. Mirrors `GateDecision` (a frozen record in Python).
 * @typedef {object} GateDecision
 * @property {boolean} admitted - whether the action may be dispatched.
 * @property {number} utility - the evaluated utility (may be non-finite).
 * @property {number} theta - the threshold in force.
 * @property {string} reason - human-readable explanation.
 * @property {Record<string, unknown>} meta - structured side facts (`gate_error`).
 */

/**
 * Binary utility gate: `Gate(s,a) = 1 iff U(s,a) >= theta`.
 *
 * The utility function is mandatory and injected by the deployer; there is no
 * fail-open switch, because the gate is the sole dispatch channel.
 */
export class UtilityGate {
  /**
   * @param utility - `U(state, action) -> number`.
   * @param theta - non-negative finite threshold.
   */
  constructor(utility, theta = 0) {
    if (typeof utility !== 'function') {
      throw new Error(
        'UtilityGate requires an explicit utility function. '
        + 'There is no fail-open mode: the gate is the sole dispatch channel.',
      );
    }
    if (typeof theta === 'boolean' || typeof theta !== 'number' || !Number.isFinite(theta) || theta < 0) {
      throw new Error('theta must be finite and >= 0 (paper Definition 3)');
    }
    this.utility = utility;
    this.theta = theta;
  }

  /**
   * Evaluate one candidate action.
   * @param state - the environment state handed to the utility function.
   * @param action - the candidate action.
   * @returns {GateDecision} the decision.
   */
  evaluate(state, action) {
    let raw;
    try {
      raw = Number(this.utility(state, action));
    } catch (error) {
      const err = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;
      return Object.freeze({
        admitted: false,
        utility: Number.NEGATIVE_INFINITY,
        theta: this.theta,
        reason: `gate_error: utility raised ${err} (treated as U=-inf)`,
        meta: Object.freeze({ gate_error: err }),
      });
    }
    // A throwing utility fails closed through the catch above; +Infinity would
    // otherwise pass `>= theta` unconditionally, so non-finite is denied here.
    if (!Number.isFinite(raw)) {
      return Object.freeze({
        admitted: false,
        utility: raw,
        theta: this.theta,
        reason: `nonfinite utility: ${String(raw)} (fail-closed)`,
        meta: Object.freeze({}),
      });
    }
    const admitted = raw >= this.theta;
    return Object.freeze({
      admitted,
      utility: raw,
      theta: this.theta,
      reason: admitted ? '' : `U=${raw.toFixed(4)} < theta=${this.theta.toFixed(4)}`,
      meta: Object.freeze({}),
    });
  }
}

/* ------------------------------------------------------------------ *
 * Gear transfer policy (§4)
 * ------------------------------------------------------------------ */

/**
 * Slow up, fast down: escalation needs `sigma < sigmaLow` **and** `patience`
 * consecutive clean cycles; de-escalation on sigma overflow or error is immediate.
 */
export class GearPolicy {
  /**
   * @param options - partial policy; omitted fields take the SDK defaults.
   */
  constructor(options = {}) {
    const o = options ?? {};
    this.sigmaLow = o.sigmaLow ?? 0.3;
    this.sigmaHigh = o.sigmaHigh ?? 1.0;
    this.patience = o.patience ?? 3;
    this.sigmaDecay = o.sigmaDecay ?? 0.1;
    this.sigmaStep = o.sigmaStep ?? 0.1;
    this.fastDown = o.fastDown ?? 'error';
    if (this.fastDown !== 'error' && this.fastDown !== 'overflow') {
      throw new Error(`fastDown must be "error" or "overflow", got ${String(this.fastDown)}`);
    }

    for (const name of ['sigmaLow', 'sigmaHigh', 'sigmaDecay', 'sigmaStep']) {
      const v = this[name];
      if (typeof v === 'boolean') throw new Error(`${name}: bool is not a legal number (got ${String(v)})`);
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`${name} must be finite, got ${String(v)}`);
      }
    }
    if (typeof this.patience === 'boolean' || !Number.isInteger(this.patience)) {
      throw new Error(`patience must be an integer, got ${String(this.patience)}`);
    }
    if (this.patience < 1) throw new Error('patience must be >= 1');
    if (this.sigmaDecay < 0) throw new Error('sigmaDecay must be >= 0');
    if (this.sigmaStep < 0) throw new Error('sigmaStep must be >= 0');
    if (!(this.sigmaLow < this.sigmaHigh)) throw new Error('sigmaLow must be < sigmaHigh');
  }

  /**
   * The gear this state should occupy next cycle (pi_G).
   * @param state - the runtime state.
   * @returns the next gear value.
   */
  nextGear(state) {
    // `fastDown: 'error'` is the SDK's law: the epsilon flag alone de-escalates
    // one gear. `'overflow'` waits for sigma to cross sigmaHigh first, so a
    // single tool error costs sigmaStep instead of a whole gear.
    const unstable = this.fastDown === 'error'
      ? (state.sigma > this.sigmaHigh || state.error)
      : state.sigma > this.sigmaHigh;
    if (unstable) {
      return Math.max(state.gear - 1, Gear.OBSERVE);
    }
    if (state.sigma < this.sigmaLow && state.cleanStreak >= this.patience) {
      return Math.min(state.gear + 1, Gear.INTEGRATE);
    }
    return state.gear;
  }
}

/* ------------------------------------------------------------------ *
 * Fallback bounds (Theorem 4)
 * ------------------------------------------------------------------ */

/** Bounded recovery: how many alternatives may be tried, and when to suspend. */
export class FallbackConfig {
  /**
   * @param options - `maxAlternatives` (k), `maxConsecutiveRejections` (m), and
   * `countGearDenials` (whether a ladder refusal advances the suspension count).
   */
  constructor(options = {}) {
    const o = options ?? {};
    this.maxAlternatives = o.maxAlternatives ?? 3;
    this.maxConsecutiveRejections = o.maxConsecutiveRejections ?? 5;
    this.countGearDenials = o.countGearDenials ?? true;

    for (const name of ['maxAlternatives', 'maxConsecutiveRejections']) {
      const v = this[name];
      if (typeof v === 'boolean' || !Number.isInteger(v)) {
        throw new Error(`${name} must be a finite integer, got ${String(v)}`);
      }
    }
    if (typeof this.countGearDenials !== 'boolean') {
      throw new Error(`countGearDenials must be a boolean, got ${String(this.countGearDenials)}`);
    }
    if (this.maxAlternatives < 0 || this.maxAlternatives > 100) {
      throw new Error('maxAlternatives must be in [0, 100] (0 = fallback off)');
    }
    if (this.maxConsecutiveRejections < 1) {
      throw new Error('maxConsecutiveRejections must be >= 1');
    }
  }
}

/* ------------------------------------------------------------------ *
 * Runtime state rho = (g, sigma, epsilon) (Definition 4)
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} RuntimeState
 * @property {number} gear - current gear.
 * @property {number} sigma - accumulated instability.
 * @property {boolean} error - the epsilon flag.
 * @property {number} cycle - discrete cycle counter.
 * @property {number} cleanStreak - consecutive clean cycles (patience counter).
 * @property {number} consecutiveRejections - consecutive rejections.
 * @property {boolean} suspended - awaiting human review.
 */

/**
 * Create a fresh runtime state.
 * @param partial - initial overrides.
 * @returns {RuntimeState} the state.
 */
export function createState(partial = {}) {
  const gear = safeGear(partial.gear ?? Gear.OBSERVE);
  if (gear === null) throw new Error(`invalid state gear ${String(partial.gear)} (want an integer 0-4)`);
  return {
    gear,
    sigma: partial.sigma ?? 0,
    error: partial.error ?? false,
    cycle: partial.cycle ?? 0,
    cleanStreak: partial.cleanStreak ?? 0,
    consecutiveRejections: partial.consecutiveRejections ?? 0,
    suspended: partial.suspended ?? false,
  };
}

/**
 * Detached, JSON-safe snapshot of one state.
 * @param state - the runtime state.
 * @returns the snapshot.
 */
export function snapshot(state) {
  return {
    gear: state.gear,
    gearLabel: GEAR_LABELS[state.gear],
    sigma: Number(state.sigma.toFixed(6)),
    error: state.error,
    cycle: state.cycle,
    cleanStreak: state.cleanStreak,
    consecutiveRejections: state.consecutiveRejections,
    suspended: state.suspended,
  };
}

/* ------------------------------------------------------------------ *
 * Append-only audit chain (§5/§8)
 * ------------------------------------------------------------------ */

/** Depth cap for the recursive non-finite sanitizer (guards against deep nesting). */
const SANITIZE_MAX_DEPTH = 32;

/**
 * Render one non-finite number with its sign, preserving information the way the
 * SDK's `_nonfinite` markers do.
 * @param value - a non-finite number.
 * @returns `'nan'`, `'+inf'`, or `'-inf'`.
 */
function nonFiniteLabel(value) {
  return Number.isNaN(value) ? 'nan' : (value > 0 ? '+inf' : '-inf');
}

/**
 * Recursively replace non-finite numbers inside an audit field with string
 * markers, degrading unknown types to `String(value)` exactly like the SDK's
 * file-mode `json.dumps(default=str)`. Cycle- and depth-safe.
 * @param value - the field value.
 * @param depth - internal recursion depth.
 * @param seen - internal identity set for the current path.
 * @returns a JSON-safe value.
 */
function sanitizeNonFinite(value, depth = 0, seen = undefined) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : nonFiniteLabel(value);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
    const path = seen ?? new Set();
    if (depth >= SANITIZE_MAX_DEPTH || path.has(value)) return '<truncated:depth-or-cycle>';
    path.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => sanitizeNonFinite(item, depth + 1, path));
      const out = {};
      const seenKeys = new Set();
      let collision = false;
      for (const [key, item] of Object.entries(value)) {
        const renderKey = typeof key === 'string' ? key : String(key);
        if (seenKeys.has(renderKey)) {
          collision = true;
          continue;
        }
        seenKeys.add(renderKey);
        out[renderKey] = sanitizeNonFinite(item, depth + 1, path);
      }
      // `_audit_meta` is a reserved namespace; a user field of that name is
      // preserved under `user_field_shadowed` rather than overwritten.
      if (collision) {
        out._audit_meta = '_audit_meta' in out
          ? { user_field_shadowed: out._audit_meta, key_collision: true }
          : { key_collision: true };
      }
      return out;
    } finally {
      path.delete(value);
    }
  }
  return String(value);
}

/** JSON replacer retaining the SDK's "unknown types become their string form" contract. */
function auditReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return String(value);
  return value;
}

/**
 * Append-only, tamper-evident JSONL audit chain. Reads are cached on
 * `(mtimeMs, size)` so the metric API can walk the chain twice without two disk
 * scans; writes are synchronous and fail loudly (fail-closed), and every read is
 * deep-copied so a caller cannot mutate the ledger.
 *
 * Every entry additionally carries a monotonic `seq` and the SHA-256 `hash` of
 * the entry before it, so `verify()` can show that the chain was neither edited,
 * reordered, nor truncated — the difference between "there is a log" and "the log
 * was not rewritten". That is an addition to the SDK's chain, which is
 * append-only but not self-checking; entries written before chaining existed are
 * reported as an unverifiable legacy prefix rather than silently trusted.
 */
export class AuditLog {
  /**
   * @param path - absolute JSONL path, or `null` for the in-memory ledger.
   */
  constructor(path = null) {
    /** @type {string|null} */
    this.path = path ?? null;
    /** @type {Record<string, unknown>[]} */
    this._buffer = [];
    /** Bad lines skipped by the most recent disk read. */
    this.corruptLines = 0;
    this._cacheKey = null;
    this._cacheEntries = [];
    /** Continuation state of the hash chain, loaded lazily from an existing file. */
    this._seq = null;
    this._tailHash = null;
    this._tailLoaded = false;
  }

  /**
   * Append one entry.
   * @param kind - the event kind (`gate_decision`, `gear_transition`, …).
   * @param fields - JSON-compatible fields.
   * @returns a deep copy of the appended entry.
   */
  record(kind, fields = {}) {
    const clean = {};
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        clean[key] = null;
        clean[`${key}_nonfinite`] = nonFiniteLabel(value);
      } else {
        clean[key] = sanitizeNonFinite(value);
      }
    }
    this._loadTail();
    // The event kind is spread after the caller's fields, so a field named
    // `kind` cannot silently rewrite the entry's own type. (Python raises on that
    // collision; losing the event type would make the chain uninterpretable.)
    const base = {
      ts: Date.now() / 1000,
      seq: this._seq,
      ...clean,
      kind,
      prev: this._tailHash,
    };
    const hash = createHash('sha256').update(JSON.stringify(base, auditReplacer)).digest('hex');
    const entry = { ...base, hash };
    this._seq += 1;
    this._tailHash = hash;
    if (this.path !== null) {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(entry, auditReplacer)}\n`, 'utf8');
    } else {
      this._buffer.push(entry);
    }
    return structuredClone(entry);
  }

  /**
   * Continue an existing chain: read its tail once per instance, so appending
   * does not rescan the file for every entry.
   */
  _loadTail() {
    if (this._tailLoaded) return;
    this._tailLoaded = true;
    const entries = this._readAll();
    let tail = null;
    for (const entry of entries) {
      if (typeof entry?.seq === 'number' && typeof entry?.hash === 'string') tail = entry;
    }
    if (tail === null) {
      // A fresh chain, or one whose entries all predate hash chaining: the next
      // entry becomes the root of the verifiable suffix.
      this._seq = entries.length;
      this._tailHash = null;
      return;
    }
    this._seq = tail.seq + 1;
    this._tailHash = tail.hash;
  }

  /**
   * Acknowledge the operational history up to here, inside the chain itself.
   *
   * A fork or a mixed-generation run is not a rewrite, and letting it colour the
   * standing reading forever is how a grade stops being read. Sealing records the
   * boundary *and* the counts as an ordinary entry, so the acknowledgement is
   * auditable rather than a configuration flag someone can flip — and `verify()`
   * never lets a seal hide a tamper finding.
   * @param note - optional human note recorded with the seal.
   * @returns the verification reading taken just before sealing.
   */
  seal(note = '') {
    const before = this.verify();
    this._loadTail();
    this.record('chain_seal', {
      // Informational: `verify()` bounds on the seal entry's position, since
      // unchained entries carry no seq to compare against.
      sealed_through_seq: this._seq - 1,
      sealed_forks: before.forks - before.liveForks,
      sealed_interleaved: before.interleaved - before.liveInterleaved,
      chained_before: before.chained,
      ...(note.length > 0 ? { note } : {}),
    });
    return before;
  }

  /**
   * Walk the chain and grade what it finds, on both sides of the last seal.
   *
   * - `tampered` — the entry's bytes changed after it was written, its link into
   *   the previous entry was rewritten, or an entry that existed is gone (a seq
   *   gap). Rewrite-shaped, the only grade an operator must treat as hostile, and
   *   **never suppressed by a seal**: acknowledging history must not launder a
   *   rewrite.
   * - `forked` — a seq repeats or regresses: two writers appended from the same
   *   tail and the history branched. Operational, not adversarial — and invisible
   *   everywhere except here, which is the point.
   * - `discontinuity` — unchained entries sit among chained ones, which is what an
   *   in-place upgrade looks like while two plugin generations write one file.
   * - `verified` — nothing to note.
   *
   * The grade comes from findings *after* the last seal, so an acknowledged fork
   * stops colouring the current reading; the sealed counts are reported beside it
   * rather than dropped. The tamper checks run over the chained subsequence only,
   * so a mixed file still proves whether its chained part is intact.
   * @returns the verification reading.
   */
  verify() {
    const entries = this._readAll();
    const severity = { tampered: 3, forked: 2, discontinuity: 1, verified: 0 };
    let legacy = 0;
    let chained = 0;
    let interleaved = 0;
    let forks = 0;
    let liveInterleaved = 0;
    let liveForks = 0;
    let expectedSeq = null;
    let previousHash = null;
    let firstChainedIndex = -1;
    let lastChainedIndex = -1;

    // The seal boundary is an entry index: file order is the only ordering every
    // entry shares, since unchained entries carry no seq.
    let sealedBoundaryIndex = -1;
    for (let index = 0; index < entries.length; index += 1) {
      if (entries[index]?.kind === 'chain_seal') sealedBoundaryIndex = index;
    }
    const sealedThroughSeq = sealedBoundaryIndex < 0
      ? null
      : (entries[sealedBoundaryIndex].sealed_through_seq ?? null);

    let tamper = null;
    let live = null;
    let currentIndex = -1;

    /**
     * Keep the most severe finding on each side of the seal. A tamper is kept
     * whichever side it falls on.
     */
    const record = (grade, seq, reason) => {
      if (grade === 'tampered') {
        if (tamper === null || severity[tamper.grade] < severity[grade]) tamper = { grade, seq, reason };
        return;
      }
      if (currentIndex <= sealedBoundaryIndex) return;
      if (live === null || severity[live.grade] < severity[grade]) live = { grade, seq, reason };
    };

    for (let index = 0; index < entries.length; index += 1) {
      currentIndex = index;
      const entry = entries[index];
      const chainedEntry = typeof entry?.seq === 'number' && typeof entry?.hash === 'string';
      if (!chainedEntry) {
        if (chained === 0) legacy += 1;
        else interleaved += 1;
        continue;
      }
      if (expectedSeq === null) expectedSeq = entry.seq;
      // The per-entry content check is unambiguous on any branch, so it always
      // runs: a rewrite is still caught even inside a forked history.
      const { hash, ...rest } = entry;
      const recomputed = createHash('sha256').update(JSON.stringify(rest, auditReplacer)).digest('hex');
      if (recomputed !== hash) record('tampered', entry.seq, `seq ${entry.seq} was modified after it was written`);

      // Sequence and link checks assume a single line. Once the chain has been
      // seen to branch they are meaningless — the fork writer's own continuation
      // would read as a missing entry — so they stop at the first fork, which is
      // already the loudest thing this walk can say.
      if (forks === 0) {
        if (entry.seq > expectedSeq) {
          record('tampered', entry.seq, `seq jumped from ${expectedSeq - 1} to ${entry.seq} — an entry is missing`);
        } else if (entry.seq < expectedSeq) {
          forks += 1;
          if (currentIndex > sealedBoundaryIndex) liveForks += 1;
          record('forked', entry.seq, `seq ${entry.seq} repeats after ${expectedSeq - 1} — a second writer branched this chain`);
        } else if ((entry.prev ?? null) !== previousHash) {
          record('tampered', entry.seq, `the link into seq ${entry.seq} does not match the previous entry`);
        } else {
          previousHash = hash;
          expectedSeq = entry.seq + 1;
        }
      }
      chained += 1;
      if (firstChainedIndex < 0) firstChainedIndex = index;
      lastChainedIndex = index;
    }

    // Unchained entries carry no seq, so which side of the seal they fall on is
    // decided by position — the one ordering every entry shares.
    let chainedSeen = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const chainedEntry = typeof entry?.seq === 'number' && typeof entry?.hash === 'string';
      if (!chainedEntry) {
        if (chainedSeen > 0 && index > sealedBoundaryIndex) liveInterleaved += 1;
        continue;
      }
      chainedSeen += 1;
    }

    const sealedForks = forks - liveForks;
    const sealedInterleaved = interleaved - liveInterleaved;
    const sealedNote = sealedBoundaryIndex < 0
      ? ''
      : `${sealedForks} fork${sealedForks === 1 ? '' : 's'} and ${sealedInterleaved} interleaved `
        + `entr${sealedInterleaved === 1 ? 'y' : 'ies'} sealed as history`
        + `${sealedThroughSeq === null ? '' : ` through seq ${sealedThroughSeq}`}`;

    const status = tamper !== null
      ? 'tampered'
      : (live !== null
        ? live.grade
        : (liveInterleaved > 0 ? 'discontinuity' : 'verified'));
    return {
      status,
      // `ok` answers the operator's question — was anything rewritten? — while
      // `clean` additionally requires that there is nothing left to look at, now
      // that sealed history is no longer something to look at.
      ok: status !== 'tampered',
      tampered: status === 'tampered',
      clean: status === 'verified',
      entries: entries.length,
      chained,
      legacy,
      interleaved,
      liveInterleaved,
      forks,
      liveForks,
      corrupt: this.corruptLines,
      brokenAt: tamper !== null ? tamper.seq : (live !== null ? live.seq : null),
      reason: tamper !== null
        ? tamper.reason
        : (live !== null
          ? live.reason
          : (liveInterleaved > 0
            ? `${liveInterleaved} unchained entr${liveInterleaved === 1 ? 'y' : 'ies'} among chained ones (two plugin generations wrote this chain)`
            : sealedNote)),
      sealed: sealedBoundaryIndex < 0
        ? null
        : {
          boundaryIndex: sealedBoundaryIndex,
          throughSeq: sealedThroughSeq,
          forks: sealedForks,
          interleaved: sealedInterleaved,
        },
      chainedRange: firstChainedIndex < 0 ? null : [firstChainedIndex, lastChainedIndex],
    };
  }

  /**
   * Every entry, oldest first, as detached copies.
   * @returns the entries.
   */
  get entries() {
    return this._readAll().map((entry) => structuredClone(entry));
  }

  /** @returns {Record<string, unknown>[]} the cached read. */
  _readAll() {
    if (this.path !== null) {
      let stats;
      try {
        stats = statSync(this.path);
      } catch {
        // A missing chain file reads as empty; deployers should alert on it.
        this.corruptLines = 0;
        return [];
      }
      const key = `${stats.mtimeMs}:${stats.size}`;
      if (key !== this._cacheKey) {
        const entries = [];
        let corrupt = 0;
        for (const line of readFileSync(this.path, 'utf8').split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          try {
            entries.push(JSON.parse(trimmed));
          } catch {
            corrupt += 1;
          }
        }
        this._cacheKey = key;
        this._cacheEntries = entries;
        this.corruptLines = corrupt;
      }
      return this._cacheEntries;
    }
    this.corruptLines = 0;
    return this._buffer;
  }

  /**
   * Gear transition histogram (Theorem 3 evidence).
   * @returns counts keyed by destination gear.
   */
  gearHistogram() {
    const histogram = {};
    for (const entry of this._readAll()) {
      if (entry?.kind !== 'gear_transition') continue;
      const to = String(entry.to);
      histogram[to] = (histogram[to] ?? 0) + 1;
    }
    return histogram;
  }

  /**
   * Gate acceptance rate (the Theorem 1 assumption's empirical reading).
   * @param options - `enforcement` restricts the reading to one mode, so an
   * observe-mode run can never dilute a gate-mode rate. Entries written before
   * the field existed count as `gate`, because that is what produced them.
   * @returns the rate in [0, 1], or `null` when no decision matches.
   */
  gateAcceptanceRate(options = {}) {
    const wanted = options.enforcement;
    const decisions = this._readAll().filter((entry) => {
      if (entry?.kind !== 'gate_decision') return false;
      if (wanted === undefined) return true;
      return (entry.enforcement ?? 'gate') === wanted;
    });
    if (decisions.length === 0) return null;
    return decisions.filter((entry) => entry.admitted === true).length / decisions.length;
  }
}

/* ------------------------------------------------------------------ *
 * The control cycle (Algorithm 1)
 * ------------------------------------------------------------------ */

/**
 * Result of one control cycle. Mirrors `CycleResult`.
 * @typedef {object} CycleResult
 * @property {boolean} executed
 * @property {unknown} action
 * @property {GateDecision|null} gate
 * @property {number} gearBefore
 * @property {number} gearAfter
 * @property {boolean} usedFallback
 * @property {boolean} suspended
 * @property {unknown} result
 * @property {string|null} error
 */

/**
 * The embeddable gear-based safety control layer.
 *
 * `step()` runs the whole cycle. `admit()` / `settle()` expose the same cycle
 * split in two, for hosts (like a tool registry) whose dispatch happens between
 * the decision and its outcome; both paths mutate state through the one
 * `_advance()` transition, so they cannot drift apart.
 */
export class EntropyRuntime {
  /**
   * @param options - runtime construction options.
   * @param options.utility - `U(state, action) -> number`, injected explicitly.
   * @param options.theta - gate threshold, finite and >= 0.
   * @param options.policy - `GearPolicy` instance or a policy options object.
   * @param options.fallback - `FallbackConfig` instance or an options object.
   * @param options.auditLog - an `AuditLog` instance, a path, or `null`.
   * @param options.initialGear - starting gear (integer 0–4).
   */
  constructor(options) {
    const o = options ?? {};
    this.gate = new UtilityGate(o.utility, o.theta ?? 0);
    this.policy = o.policy instanceof GearPolicy ? o.policy : new GearPolicy(o.policy ?? {});
    this.fallback = o.fallback instanceof FallbackConfig ? o.fallback : new FallbackConfig(o.fallback ?? {});
    this.audit = o.auditLog instanceof AuditLog ? o.auditLog : new AuditLog(o.auditLog ?? null);
    /**
     * Stamped on every chain entry. `'observe'` means the deployment is
     * measuring the policy without letting it deny: the host enforces nothing,
     * so a reader can tell a rejection the gate made from one it only wanted to
     * make.
     */
    this.enforcement = o.enforcement === 'observe' ? 'observe' : 'gate';
    const gear0 = safeGear(o.initialGear ?? Gear.OBSERVE);
    if (gear0 === null) {
      throw new Error(`invalid initialGear ${String(o.initialGear)} (want an integer 0-4)`);
    }
    /** @type {RuntimeState} */
    this.state = createState({ gear: gear0 });
    this.audit.record('init', {
      gear: gear0,
      theta: this.gate.theta,
      enforcement: this.enforcement,
    });
  }

  /* -------------------------------------------------------------- */

  /**
   * Decide one candidate action without executing it.
   *
   * Mutates nothing on admission; a rejection is recorded by `settle()` so the
   * host can attribute the rejection to the exact call it denied.
   * @param env - the environment state handed to the utility function.
   * @param action - the candidate action (`requiredGear` attestation included).
   * @param options - `ignoreSuspension` lets a host keep the paper's G0 recovery
   * path open while a suspension is under human review.
   * @returns `{ admitted, gate, required, reason, suspended }`.
   */
  admit(env, action, options = {}) {
    const state = this.state;
    if (state.suspended && options.ignoreSuspension !== true) {
      this.audit.record('suspended_skip', { cycle: state.cycle, tool: action?.name ?? null });
      return {
        admitted: false,
        kind: 'suspended',
        gate: null,
        required: null,
        suspended: true,
        reason: 'suspended: awaiting human review',
      };
    }

    const declared = action?.requiredGear ?? Gear.EXECUTE;
    const required = safeGear(declared);
    // Every decision entry carries the control quantities, so the chain is a
    // complete sigma/gear trajectory rather than only a list of verdicts.
    const stamp = {
      cycle: state.cycle,
      tool: action?.name ?? null,
      gear: state.gear,
      sigma: Number(state.sigma.toFixed(4)),
      enforcement: this.enforcement,
    };

    if (required === null) {
      const reason = `invalid required_gear ${String(declared)} (attestation rejected)`;
      this.audit.record('gate_decision', { ...stamp, admitted: false, reason });
      return { admitted: false, kind: 'invalid', gate: null, required: null, suspended: false, reason };
    }

    if (!gearPermits(state.gear, required)) {
      const reason = `gear ${gearLabel(state.gear)} does not permit ${gearLabel(required)}`;
      this.audit.record('gate_decision', { ...stamp, admitted: false, reason });
      return {
        admitted: false,
        kind: 'gear',
        gate: null,
        required,
        suspended: false,
        reason,
        gearBlocked: true,
      };
    }

    const decision = this.gate.evaluate(env, action);
    this.audit.record('gate_decision', {
      ...stamp,
      admitted: decision.admitted,
      utility: decision.utility,
      theta: decision.theta,
      reason: decision.reason,
    });
    if (decision.meta.gate_error !== undefined) {
      this.audit.record('gate_error', { cycle: state.cycle, error: decision.meta.gate_error });
    }
    return {
      admitted: decision.admitted,
      kind: decision.admitted ? 'admitted' : 'utility',
      gate: decision,
      required,
      suspended: false,
      reason: decision.reason,
    };
  }

  /**
   * Record the outcome of an admitted call and run the gear transition.
   * @param outcome - `'executed'`, `'fallback'`, or `'rejected'`.
   * @returns `{ gearBefore, gearAfter, suspended }` plus the transition flag.
   */
  settle(outcome, meta = {}) {
    return this._advance(outcome, meta);
  }

  /**
   * Record a rejection decided by `admit()` (or by the host) and transition.
   * @param meta - `gearDenied: true` marks a ladder refusal rather than a
   * refused action, which `countGearDenials: false` keeps out of the
   * suspension count.
   * @returns the same shape as `settle`.
   */
  reject(meta = {}) {
    return this._advance('rejected', meta);
  }

  /**
   * Run one full control cycle: gate, execute, feedback.
   * @param env - the environment state handed to the utility function.
   * @param action - the candidate action.
   * @param execute - invoked only when the gate admits.
   * @param proposeAlternative - optional recovery proposer.
   * @returns {Promise<CycleResult>} the cycle result.
   */
  async step(env, action, execute, proposeAlternative = null) {
    const state = this.state;
    if (state.suspended) {
      this.audit.record('suspended_skip', { cycle: state.cycle });
      return {
        executed: false,
        action: null,
        gate: null,
        gearBefore: state.gear,
        gearAfter: state.gear,
        usedFallback: false,
        suspended: true,
        result: null,
        error: 'suspended: awaiting human review',
      };
    }

    const gearBefore = state.gear;
    let result = await this._dispatch(env, action, execute, proposeAlternative);

    if (result.executed && !result.usedFallback) {
      this._advance('executed');
    } else if (result.executed) {
      this._advance('fallback');
    } else {
      this._advance('rejected');
    }

    result.gearBefore = gearBefore;
    result.gearAfter = this.state.gear;
    return result;
  }

  /**
   * Human review lifted the suspension. sigma deliberately persists: gears must
   * be re-earned through clean cycles.
   */
  resume() {
    this.state.suspended = false;
    this.state.consecutiveRejections = 0;
    this.state.error = false;
    this.audit.record('resume', { cycle: this.state.cycle });
  }

  /* -------------------------------------------------------------- */

  /**
   * One state transition: sigma/epsilon/streak, then the gear transfer, then
   * the suspension endpoint (Algorithm 1, lines 7/11/13 and Theorem 4).
   * @param outcome - `'executed'`, `'fallback'`, or `'rejected'`.
   * @returns transition facts.
   */
  _advance(outcome, meta = {}) {
    const state = this.state;
    const policy = this.policy;
    const gearBefore = state.gear;

    if (outcome === 'executed') {
      state.sigma = Math.max(0, state.sigma - policy.sigmaDecay);
      state.error = false;
      state.cleanStreak += 1;
      state.consecutiveRejections = 0;
    } else if (outcome === 'fallback') {
      state.error = false; // sigma is deliberately held
      state.cleanStreak += 1;
      state.consecutiveRejections = 0;
    } else {
      state.sigma += policy.sigmaStep;
      state.error = true;
      state.cleanStreak = 0;
      // A ladder refusal is a consequence of the current gear, not a proposal of
      // dangerous work: it still costs sigma, but with `countGearDenials: false`
      // it does not march the session toward the G0 suspension endpoint.
      const counts = !(meta.gearDenied === true && this.fallback.countGearDenials === false);
      if (counts) state.consecutiveRejections += 1;
    }

    const gearAfter = policy.nextGear(state);
    if (gearAfter !== state.gear) {
      this.audit.record('gear_transition', {
        cycle: state.cycle,
        from: state.gear,
        to: gearAfter,
        sigma: Number(state.sigma.toFixed(4)),
      });
      // Every gear must be re-earned: a transition clears the patience counter.
      state.cleanStreak = 0;
      state.gear = gearAfter;
    }

    let suspendedNow = false;
    if (state.consecutiveRejections >= this.fallback.maxConsecutiveRejections) {
      if (state.gear !== Gear.OBSERVE) {
        this.audit.record('gear_transition', {
          cycle: state.cycle,
          from: state.gear,
          to: Gear.OBSERVE,
          sigma: Number(state.sigma.toFixed(4)),
          reason: 'suspend',
        });
      }
      state.gear = Gear.OBSERVE;
      state.suspended = true;
      suspendedNow = true;
      this.audit.record('suspend', {
        cycle: state.cycle,
        consecutive_rejections: state.consecutiveRejections,
      });
    }

    state.cycle += 1;
    return { gearBefore, gearAfter: state.gear, suspended: suspendedNow };
  }

  /**
   * Gate one action, falling back through the proposer when rejected.
   * @param env - environment state for the utility.
   * @param action - the candidate action.
   * @param execute - the dispatch callback.
   * @param proposeAlternative - optional proposer.
   * @returns {Promise<CycleResult>} the dispatch result (state not yet advanced).
   */
  async _dispatch(env, action, execute, proposeAlternative) {
    const admitted = this.admit(env, action);
    if (!admitted.admitted) {
      const alternative = await this._tryAlternatives(env, action, execute, proposeAlternative);
      if (alternative !== null) return alternative;
      return this._result(false, action, admitted.gate, false, null, null);
    }
    return this._run(action, execute, admitted.gate, false);
  }

  /**
   * Ask the proposer for alternatives until one clears both the gear gate and
   * the utility gate. A proposer that throws ends the search (Theorem 4 keeps
   * the ordinary rejection path intact).
   * @param env - environment state for the utility.
   * @param rejected - the rejected action.
   * @param execute - the dispatch callback.
   * @param proposeAlternative - the proposer.
   * @returns {Promise<CycleResult|null>} the accepted cycle, or `null`.
   */
  async _tryAlternatives(env, rejected, execute, proposeAlternative) {
    if (typeof proposeAlternative !== 'function' || this.fallback.maxAlternatives === 0) return null;
    for (let index = 0; index < this.fallback.maxAlternatives; index += 1) {
      let alternative;
      try {
        alternative = await proposeAlternative(this.state, rejected, index);
      } catch (error) {
        this.audit.record('proposer_error', {
          cycle: this.state.cycle,
          attempt_index: index,
          error: error?.name ?? 'Error',
        });
        break;
      }
      if (alternative === null || alternative === undefined) break;
      const required = safeGear(alternative.requiredGear ?? Gear.EXECUTE);
      if (required === null) {
        this.audit.record('gate_decision', {
          cycle: this.state.cycle,
          admitted: false,
          reason: `fallback#${index}: invalid required_gear ${String(alternative.requiredGear)} (attestation rejected)`,
        });
        continue;
      }
      if (!gearPermits(this.state.gear, required)) continue;
      const decision = this.gate.evaluate(env, alternative);
      this.audit.record('gate_decision', {
        cycle: this.state.cycle,
        admitted: decision.admitted,
        utility: decision.utility,
        theta: decision.theta,
        reason: `fallback#${index}: ${decision.reason}`,
      });
      if (decision.admitted) return this._run(alternative, execute, decision, true);
    }
    return null;
  }

  /**
   * Execute an admitted action. An execution error is treated as a rejection on
   * the next transition (sigma rises, epsilon = 1).
   * @param action - the admitted action.
   * @param execute - the dispatch callback.
   * @param decision - the admitting gate decision.
   * @param usedFallback - whether this action came from the proposer.
   * @returns {Promise<CycleResult>} the cycle result.
   */
  async _run(action, execute, decision, usedFallback) {
    try {
      const out = await execute(action);
      this.audit.record('execute', { cycle: this.state.cycle, fallback: usedFallback });
      return this._result(true, action, decision, usedFallback, out, null);
    } catch (error) {
      const message = error?.message ?? String(error);
      this.audit.record('execute_error', { cycle: this.state.cycle, error: message });
      return this._result(false, action, decision, usedFallback, null, message);
    }
  }

  /**
   * Build a cycle result.
   * @param executed - whether dispatch happened.
   * @param action - the action.
   * @param gate - the gate decision, when the gate ran.
   * @param usedFallback - whether the proposer supplied the action.
   * @param result - the dispatch output.
   * @param error - the error message.
   * @returns {CycleResult} the result.
   */
  _result(executed, action, gate, usedFallback, result, error) {
    return {
      executed,
      action,
      gate: gate ?? null,
      gearBefore: this.state.gear,
      gearAfter: this.state.gear,
      usedFallback,
      suspended: false,
      result,
      error,
    };
  }
}
