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
import {
  appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync,
} from 'node:fs';
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

/** How long an append waits for the chain lock before failing closed, in ms. */
export const LOCK_TIMEOUT_MS = 5000;

/** How long to nap between lock attempts, in ms. */
export const LOCK_BACKOFF_MS = 2;

/** How much of the chain tail to read when recovering `seq` and `prev`. */
const TAIL_READ_BYTES = 65536;

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
  }

  /**
   * Append one entry, serialised against any other writer of the same chain.
   *
   * A file-backed append does all three of these under an exclusive lock:
   * re-read the on-disk tail (never a cached one), take `seq`/`prev` from it,
   * append. The cached-tail version of this method is what produced
   * duplicate-sequence forks the moment two writers shared one chain: each
   * instance loaded the tail once and resumed from the same `seq` (defect 14).
   * @param kind - the event kind (`gate_decision`, `gear_transition`, …).
   * @param fields - JSON-compatible fields.
   * @returns a deep copy of the appended entry.
   * @throws {Error} when the chain cannot be locked or written (fail-closed).
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

    if (this.path === null) {
      // In-memory: one buffer has exactly one writer, so no lock is taken.
      const tail = this._tail();
      const base = { ts: Date.now() / 1000, seq: tail.seq, ...clean, kind, prev: tail.hash };
      const hash = createHash('sha256').update(JSON.stringify(base, auditReplacer)).digest('hex');
      const entry = { ...base, hash };
      this._buffer.push(entry);
      return structuredClone(entry);
    }

    const release = this._lock();
    try {
      const tail = this._tail();
      // The event kind is spread after the caller's fields, so a field named
      // `kind` cannot silently rewrite the entry's own type. (Python raises on
      // that collision; losing the event type would make the chain
      // uninterpretable.)
      const base = {
        ts: Date.now() / 1000,
        seq: tail.seq,
        ...clean,
        kind,
        prev: tail.hash,
      };
      const hash = createHash('sha256').update(JSON.stringify(base, auditReplacer)).digest('hex');
      const entry = { ...base, hash };
      mkdirSync(dirname(this.path), { recursive: true });
      // A crash-torn tail line has no trailing newline; appending without
      // terminating it first fuses the new entry into the corrupt line and the
      // entry is itself lost (defect 19). The torn line stays behind as a
      // counted `corrupt` line — reported, never silently absorbed.
      const line = `${JSON.stringify(entry, auditReplacer)}\n`;
      appendFileSync(this.path, tail.tornTail ? `\n${line}` : line, 'utf8');
      return structuredClone(entry);
    } finally {
      release();
    }
  }

  /**
   * Read the chain's continuation state — the last entry carrying `seq` and
   * `hash` — fresh from the source, never from a per-instance cache. Also
   * reports whether the file ends mid-line (a crash-torn tail), so the next
   * append can terminate the torn line instead of fusing into it.
   * @returns {{ seq: number, hash: string|null, tornTail: boolean }} the next `seq` and `prev`.
   */
  _tail() {
    if (this.path === null) {
      const last = [...this._buffer].reverse()
        .find((entry) => typeof entry?.seq === 'number' && typeof entry?.hash === 'string');
      return last === undefined
        ? { seq: this._buffer.length, hash: null, tornTail: false }
        : { seq: last.seq + 1, hash: String(last.hash), tornTail: false };
    }
    let text = '';
    let size = 0;
    try {
      size = statSync(this.path).size;
      if (size > 0) {
        const length = Math.min(size, TAIL_READ_BYTES);
        const handle = openSync(this.path, 'r');
        try {
          const buffer = Buffer.alloc(length);
          let offset = 0;
          while (offset < length) {
            const read = readSync(handle, buffer, offset, length - offset, size - length + offset);
            if (read <= 0) break;
            offset += read;
          }
          text = buffer.subarray(0, offset).toString('utf8');
        } finally {
          closeSync(handle);
        }
      }
    } catch {
      return { seq: 0, hash: null, tornTail: false };
    }
    const tornTail = text.length > 0 && !text.endsWith('\n');
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const entry = JSON.parse(lines[index]);
        if (typeof entry?.seq === 'number' && typeof entry?.hash === 'string') {
          return { seq: entry.seq + 1, hash: entry.hash, tornTail };
        }
      } catch {
        // A torn or corrupt trailing line is skipped: the verifier reports it
        // rather than the writer refusing to continue.
      }
    }
    // No chained entry in the tail window: the next entry becomes the root of
    // the verifiable suffix, numbered after every line already there. The full
    // line count is read only on this path — the common case never pays for it.
    let count = 0;
    try {
      count = readFileSync(this.path, 'utf8').split('\n').filter((line) => line.trim().length > 0).length;
    } catch {
      count = 0;
    }
    return { seq: count, hash: null, tornTail };
  }

  /**
   * Take the chain lock, retrying briefly.
   *
   * `wx` is the atomic create — it fails when the lock already exists, which is
   * the mutual exclusion. A stale lock older than the timeout is broken, so a
   * crashed process cannot wedge every future append. Ported from the sibling
   * guard's ledger, whose writers share this chain (defect 14).
   * @returns {() => void} the release function.
   */
  _lock() {
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    mkdirSync(dirname(this.path), { recursive: true });
    for (;;) {
      try {
        closeSync(openSync(lockPath, 'wx'));
        return () => {
          try {
            unlinkSync(lockPath);
          } catch {
            // Another writer already cleared it; nothing to release.
          }
        };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > LOCK_TIMEOUT_MS) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          continue; // The lock vanished between the check and the stat: retry.
        }
        if (Date.now() > deadline) {
          throw new Error(`entropy-guard: chain lock ${lockPath} held longer than ${LOCK_TIMEOUT_MS}ms`);
        }
        // A short synchronous nap: `record` is called from a synchronous guard,
        // so there is no event loop to yield to here.
        const until = Date.now() + LOCK_BACKOFF_MS;
        while (Date.now() < until) { /* spin */ }
      }
    }
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
    // Read the tail fresh: the seq the seal names must be the chain's own, not
    // a per-instance cache that a second writer may have moved past.
    const tail = this._tail();
    this.record('chain_seal', {
      // Informational: `verify()` bounds on the seal entry's position, since
      // unchained entries carry no seq to compare against.
      sealed_through_seq: tail.seq - 1,
      sealed_forks: before.forks - before.liveForks,
      sealed_interleaved: before.interleaved - before.liveInterleaved,
      chained_before: before.chained,
      ...(note.length > 0 ? { note } : {}),
    });
    return before;
  }

  /**
   * Fold the chain into the control state it describes.
   *
   * The ladder's state is not written anywhere else: it exists as a trajectory in
   * the entries. Until 0.3.0 every activation restarted at `initialGear` while the
   * record kept describing a session that had climbed — measured on a live profile
   * as `cycles 0` beside 413 decisions. The fold is the inverse of that loss: the
   * last written value of each control quantity wins, under three boundaries.
   *
   * - `init` is an activation marker, **not** an origin. Ignoring it is precisely
   *   what lets one session's autonomy survive a restart; treating it as an origin
   *   is the old behaviour.
   * - `reset` **is** an origin: everything before a human reset is discarded,
   *   which is what the command means.
   * - a quantity no entry ever carried stays `null`, and the caller keeps its
   *   configured default rather than inventing a value.
   *
   * The fold is exact to the last state-bearing entry. An errored settle is one
   * (`tool_error` carries the post-transition state); a *clean* settle after the
   * final decision is not, so sigma and the clean streak can be one cycle stale in
   * that case — the direction the caller must not hide, which is why `restore`
   * records the effective state it applied.
   * @returns the folded state, or `null` when the chain offers none.
   */
  replayState() {
    const entries = this._readAll();
    let origin = -1;
    for (let index = 0; index < entries.length; index += 1) {
      if (entries[index]?.kind === 'reset') origin = index;
    }
    const state = {
      gear: null,
      sigma: null,
      cycle: null,
      cleanStreak: null,
      consecutiveRejections: null,
      suspended: null,
      fromSeq: null,
      fromEntries: entries.length - (origin < 0 ? 0 : origin),
    };
    for (let index = origin < 0 ? 0 : origin; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry === null || typeof entry !== 'object') continue;
      // `init` is an activation marker rather than state, and a `restore` that was
      // *not* applied is the record of a deliberately fresh session: letting it
      // contribute would let one `restoreState: false` activation overwrite the
      // state every later fold reads.
      if (entry.kind === 'init') continue;
      if (entry.kind === 'restore' && entry.applied !== true) continue;
      if (Number.isInteger(entry.gear)) {
        state.gear = entry.gear;
        if (Number.isInteger(entry.seq)) state.fromSeq = entry.seq;
      }
      if (Number.isFinite(entry.sigma)) state.sigma = entry.sigma;
      if (Number.isInteger(entry.cycle)) state.cycle = entry.cycle;
      if (Number.isInteger(entry.clean_streak)) state.cleanStreak = entry.clean_streak;
      if (Number.isInteger(entry.consecutive_rejections)) state.consecutiveRejections = entry.consecutive_rejections;
      if (typeof entry.suspended === 'boolean') state.suspended = entry.suspended;
      if (entry.kind === 'suspend') state.suspended = true;
      if (entry.kind === 'resume' || entry.kind === 'reset') state.suspended = false;
      if (entry.kind === 'gear_manual' && Number.isInteger(entry.to)) state.gear = entry.to;
    }
    const offered = ['gear', 'sigma', 'cycle', 'cleanStreak', 'consecutiveRejections', 'suspended']
      .some((key) => state[key] !== null);
    return offered ? state : null;
  }

  /**
   * Walk the chain and grade what it finds, on both sides of the last seal.
   *
   * - `tampered` — the entry's bytes changed after it was written (the content
   *   re-hash disagrees), a `prev` link dangles (it names a hash no entry in the
   *   file carries, so an entry that existed is gone), a chained root appears
   *   mid-file, or a sequence gap resumes in live history. Rewrite-shaped, the
   *   only grade an operator must treat as hostile, and **never suppressed by a
   *   seal**: acknowledging history must not launder a rewrite.
   * - `forked` — a `seq` repeats: two writers appended from the same tail and
   *   the history branched. Operational, not adversarial. The walk never stops
   *   at the first one: every duplicate is counted, on every branch.
   * - `discontinuity` — unchained entries sit among chained ones, which is what
   *   an in-place upgrade looks like while two plugin generations write one file.
   * - `verified` — nothing to note.
   *
   * The three checks are kept separate, and the walk always completes (defect 15):
   *
   * - **Content** — every chained entry is re-hashed, always, on any branch.
   * - **Link** — fork-aware: `prev` is resolved against every hash the file
   *   carries rather than compared to the previous line. A resolvable
   *   non-predecessor is a branch (the fork writer's own continuation), so a
   *   fork is graded `forked` and the entries after it are still checked — the
   *   pre-fix walk abandoned link checking at the first fork, which let a
   *   deleted entry pass as `verified` on a live chain. Link checking pauses
   *   across an interleaved block and resumes at the next chained entry.
   * - **Sequence** — a repeated `seq` is a fork, never a rewrite. A gap means a
   *   missing entry: `tampered` when it resumes in live history, reported-only
   *   when wholly inside sealed history.
   *
   * Seal semantics: a `chain_seal` is a person's acknowledgement. Fork and gap
   * membership is decided by `seq` (a branch entry written after the seal can
   * still carry a seq the seal covers); interleaved entries carry no `seq`, so
   * their side of the seal is decided by file position. Findings at or below the
   * last seal are reported as `sealed*` and excluded from the live grade.
   *
   * A deliberate divergence from the sibling guard's verifier, recorded rather
   * than hidden: unparsable lines are *reported* in `corrupt` but not graded —
   * a torn final line after a crash must not turn the state fold's integrity
   * gate into a permanent refusal. (The sibling grades `corrupt > 0` as
   * `tampered`; reconciling the two is a contract question, not a code one.)
   * @returns the verification reading.
   */
  verify() {
    const entries = this._readAll();
    let legacy = 0;
    let chained = 0;
    let interleaved = 0;
    let firstChainedIndex = -1;
    let lastChainedIndex = -1;

    // Findings, with the seal boundary applied at the end. A tamper is kept
    // unfiltered — whichever side of a seal it falls on.
    const tampered = [];
    const forks = [];
    const sealedGaps = [];

    // Pass 0 — every hash the file actually carries, so a link can be resolved
    // instead of only compared to the previous line.
    const knownHashes = new Set();
    for (const entry of entries) {
      if (typeof entry?.hash === 'string') knownHashes.add(entry.hash);
    }

    // Seal bookkeeping. The fork axis bounds by seq; the interleaved axis has
    // no seq and bounds by file position.
    let sealedCount = 0;
    let lastSealIndex = -1;
    let sealedThroughSeq = null;

    let linkPaused = false;
    /** File positions of the interleaved (unchained) entries. */
    const interleavedAt = [];
    const seenSeq = new Set();

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const chainedEntry = typeof entry?.seq === 'number' && typeof entry?.hash === 'string';
      if (!chainedEntry) {
        // Before anything chained it is the legacy prefix; afterwards it is an
        // interleaved generation, which is what an in-place upgrade looks like
        // while two writers share one file.
        if (chained === 0) legacy += 1;
        else {
          interleaved += 1;
          interleavedAt.push(index);
          linkPaused = true;
        }
        continue;
      }
      if (firstChainedIndex < 0) firstChainedIndex = index;
      lastChainedIndex = index;
      chained += 1;

      if (entry.kind === 'chain_seal') {
        sealedCount += 1;
        lastSealIndex = index;
        const through = typeof entry.sealed_through_seq === 'number'
          ? entry.sealed_through_seq
          : entry.seq - 1;
        sealedThroughSeq = sealedThroughSeq === null ? through : Math.max(sealedThroughSeq, through);
      }

      // Content: always, for every chained entry, on any branch.
      const { hash, ...rest } = entry;
      const recomputed = createHash('sha256').update(JSON.stringify(rest, auditReplacer)).digest('hex');
      if (recomputed !== hash) {
        tampered.push({ seq: entry.seq, reason: `seq ${entry.seq} was modified after it was written` });
      }

      // Link: dangling is a rewrite; a resolvable non-predecessor is a branch.
      const prev = entry.prev ?? null;
      if (prev !== null && !knownHashes.has(prev)) {
        tampered.push({ seq: entry.seq, reason: `the link into seq ${entry.seq} names a hash no entry carries — an entry that existed is gone` });
      } else if (prev === null && !linkPaused && index > 0 && seenSeq.size > 0) {
        // A chained entry claiming to be a root, mid-file, with no interleaving
        // to explain it: an earlier entry is gone.
        tampered.push({ seq: entry.seq, reason: `seq ${entry.seq} restarts the chain mid-file — an earlier entry is gone` });
      }
      linkPaused = false;

      // Sequence: a repeat is a fork, and the count never stops early.
      if (seenSeq.has(entry.seq)) {
        forks.push({ seq: entry.seq, reason: `duplicate seq ${entry.seq} — a second writer branched this chain` });
      } else {
        seenSeq.add(entry.seq);
      }
    }

    // Pass 2 — a sequence gap means an entry is missing. Graded as a rewrite
    // when it resumes in live history; reported-only inside sealed history.
    const sortedSeq = [...seenSeq].sort((a, b) => a - b);
    for (let index = 1; index < sortedSeq.length; index += 1) {
      if (sortedSeq[index] === sortedSeq[index - 1] + 1) continue;
      const gap = {
        seq: sortedSeq[index],
        reason: `seq jumped from ${sortedSeq[index - 1]} to ${sortedSeq[index]} — an entry is missing`,
      };
      if (sealedThroughSeq !== null && sortedSeq[index] <= sealedThroughSeq) sealedGaps.push(gap);
      else tampered.push(gap);
    }

    // A finding is live when it belongs to sequence history above the seal
    // boundary — by `seq`, not by file position. Interleaved entries have no
    // `seq`, so the seal is applied to them by position.
    const isLive = (finding) => sealedThroughSeq === null || finding.seq > sealedThroughSeq;
    const liveForks = forks.filter(isLive);
    const liveInterleaved = lastSealIndex < 0
      ? interleaved
      : interleavedAt.filter((at) => at > lastSealIndex).length;

    const sealedForks = forks.length - liveForks.length;
    const sealedInterleaved = interleaved - liveInterleaved;
    const sealedNote = sealedCount === 0
      ? ''
      : `${sealedForks} fork${sealedForks === 1 ? '' : 's'} and ${sealedInterleaved} interleaved `
        + `entr${sealedInterleaved === 1 ? 'y' : 'ies'} sealed as history`
        + `${sealedThroughSeq === null ? '' : ` through seq ${sealedThroughSeq}`}`;
    // Contract clause 8: corrupt lines are never graded on their own, but the
    // reason names them whenever there is nothing louder to say.
    const corruptNote = this.corruptLines > 0
      ? `${this.corruptLines} unparsable line(s) (reported, not graded)`
      : '';
    const quietNote = [sealedNote, corruptNote].filter((note) => note.length > 0).join('; ');

    const status = tampered.length > 0
      ? 'tampered'
      : (liveForks.length > 0
        ? 'forked'
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
      forks: forks.length,
      liveForks: liveForks.length,
      // Sequence gaps resume in live history are graded `tampered` (a missing
      // entry is rewrite-shaped), so this pair reports the sealed ones only.
      discontinuities: sealedGaps.length,
      liveDiscontinuities: 0,
      corrupt: this.corruptLines,
      brokenAt: tampered.length > 0
        ? tampered[0].seq
        : (liveForks.length > 0 ? liveForks[0].seq : null),
      reason: tampered.length > 0
        ? tampered[0].reason
        : (liveForks.length > 0
          ? liveForks[0].reason
          : (liveInterleaved > 0
            ? `${liveInterleaved} unchained entr${liveInterleaved === 1 ? 'y' : 'ies'} among chained ones (two plugin generations wrote this chain)`
            : quietNote)),
      sealed: sealedCount === 0
        ? null
        : {
          count: sealedCount,
          boundaryIndex: lastSealIndex,
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
    /**
     * Fold the session's own trajectory back out of the chain (0.3.0). The record
     * already described a session that had climbed; discarding it at every
     * activation was the gap measured as `cycles 0` beside 413 decisions.
     * `restoreState: false` restores the old behaviour. A tampered chain is never
     * used as a state source: once its integrity check fails, the record is
     * evidence rather than a trusted input.
     */
    let restored = null;
    let restoreNote = o.restoreState === false ? 'disabled by configuration' : 'no state in the chain';
    if (o.restoreState !== false) {
      if (this.audit.verify().status === 'tampered') {
        restoreNote = 'chain is tampered; not used as a state source';
      } else {
        const folded = this.audit.replayState();
        const foldedGear = folded === null ? null : safeGear(folded.gear);
        if (folded !== null && foldedGear !== null) {
          restored = { ...folded, gear: foldedGear };
          restoreNote = `folded ${folded.fromEntries} entr${folded.fromEntries === 1 ? 'y' : 'ies'}`;
        }
      }
    }

    /** @type {RuntimeState} */
    this.state = createState({ gear: restored?.gear ?? gear0 });
    if (restored !== null) {
      if (Number.isFinite(restored.sigma) && restored.sigma >= 0) this.state.sigma = restored.sigma;
      if (Number.isInteger(restored.cycle) && restored.cycle >= 0) this.state.cycle = restored.cycle;
      if (Number.isInteger(restored.cleanStreak) && restored.cleanStreak >= 0) {
        this.state.cleanStreak = restored.cleanStreak;
      }
      if (Number.isInteger(restored.consecutiveRejections) && restored.consecutiveRejections >= 0) {
        this.state.consecutiveRejections = restored.consecutiveRejections;
      }
      if (restored.suspended === true) this.state.suspended = true;
    }
    /** What this activation recovered, for `status()`/reports; `null` when fresh. */
    this.restoredState = restored === null ? null : { ...restored };
    /** Why the fold was applied or skipped, so a report can say which it was. */
    this.restoreNote = restoreNote;
    this.audit.record('init', {
      gear: gear0,
      theta: this.gate.theta,
      enforcement: this.enforcement,
      restored: restored !== null,
    });
    this.audit.record('restore', {
      applied: restored !== null,
      reason: restoreNote,
      gear: this.state.gear,
      sigma: Number(this.state.sigma.toFixed(4)),
      cycle: this.state.cycle,
      clean_streak: this.state.cleanStreak,
      consecutive_rejections: this.state.consecutiveRejections,
      suspended: this.state.suspended,
      ...(restored?.fromSeq == null ? {} : { from_seq: restored.fromSeq }),
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
    // complete sigma/gear trajectory rather than only a list of verdicts. Since
    // 0.2.2 it also carries the *object*: a digest of the canonical arguments is
    // always recorded, so the ledger can prove which call it decided even when
    // the payload itself must not be stored (defect 10). The rejection and
    // `tools/result` entries never see arguments at all, which is why the digest
    // belongs here, on the decision.
    const stamp = {
      cycle: state.cycle,
      tool: action?.name ?? null,
      gear: state.gear,
      sigma: Number(state.sigma.toFixed(4)),
      enforcement: this.enforcement,
      args_digest: action?.argsDigest ?? null,
      tool_source: action?.toolSource ?? null,
      // Recorded since 0.3.0 so a restart can fold the ladder's state back out of
      // the chain instead of restarting at `initialGear` (defect 13).
      clean_streak: state.cleanStreak,
      consecutive_rejections: state.consecutiveRejections,
      suspended: state.suspended,
      ...(action?.args === undefined ? {} : { args: action.args }),
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
    this.audit.record('resume', {
      cycle: this.state.cycle,
      gear: this.state.gear,
      sigma: Number(this.state.sigma.toFixed(4)),
      clean_streak: this.state.cleanStreak,
      consecutive_rejections: this.state.consecutiveRejections,
      suspended: this.state.suspended,
    });
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
        gear: state.gear,
        sigma: Number(state.sigma.toFixed(4)),
        clean_streak: state.cleanStreak,
        consecutive_rejections: state.consecutiveRejections,
        suspended: state.suspended,
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
