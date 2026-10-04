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

import { ChainLog } from '@cyd-prc/dsh-audit-chain';

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
 *
 * The chain itself — writer, lock, grader, seal — lives in
 * `@cyd-prc/dsh-audit-chain` since 0.3.4: one chain, one implementation, so
 * this plugin can never drift from the sibling guards again. `AuditLog` below
 * is the shared `ChainLog` plus the entropy-specific readers (the state fold,
 * the gear histogram, the acceptance rate).
 * ------------------------------------------------------------------ */

/**
 * The shared chain plus the entropy-specific readers. The writer and grader
 * (`record`, `seal`, `verify`, the lock, the torn-tail rule) are the package's;
 * what stays here is what only the control face reads.
 */
export class AuditLog extends ChainLog {

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
