/**
 * The DeepSeek Harness binding of the Entropy control layer: one controller per
 * agent, one control cycle per tool call.
 *
 * Cycle mapping (the SDK's Algorithm 1 onto a tool registry):
 * - **observation and gear read** — the registry hands us the pending call.
 * - **action generation** — the call itself, classified onto the gear ladder.
 * - **utility gate** — `admit()`; a rejection is recorded immediately, so a
 *   denied call can never execute (Theorem 2).
 * - **execute and feedback** — the call settles on `tools/result`, where an
 *   errored tool result counts as a rejected cycle (sigma rises) and a
 *   successful one as a clean cycle (sigma decays, the patience counter
 *   advances).
 *
 * Denials are a tool registry **guard** — a monotonic, order-independent,
 * synchronous veto — rather than a `tools/pre-execute` listener, so no other
 * plugin can turn a safety denial back into an admission. Under
 * `enforcement: 'observe'` the same decisions are computed and audited but never
 * enforced, which is what makes the plugin safe to install before trusting it.
 *
 * @module dsh-entropy-guard/controller
 */

import { createHash } from 'node:crypto';
import { AuditLog, EntropyRuntime, Gear, GEAR_LABELS, gearLabel, snapshot } from './core.js';
import { buildUtility, classify } from './config.js';

/** How many recent audit entries a status report shows. */
const REPORT_TAIL = 8;

/** Longest argument string stored when `audit.includeArguments` is on. */
const MAX_STORED_ARGUMENT_CHARS = 2000;

/**
 * Canonical JSON, so the same call digests to the same value whatever order its
 * keys arrive in. A digest that moved with key order would be useless as a
 * commitment.
 * @param value - any JSON-safe value.
 * @returns the canonical string.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null) ?? 'null';
}

/**
 * SHA-256 over the canonical arguments: a commitment, not a copy, so the ledger
 * can name the object of a decision without storing the payload.
 * @param args - the call's arguments.
 * @returns hex digest, or `null` when the arguments cannot be canonicalized.
 */
function digestArguments(args) {
  try {
    return createHash('sha256').update(canonicalJson(args ?? null)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * A size-bounded copy of the arguments, for deployments that opt into storing
 * them: long strings are truncated, depth is capped.
 * @param args - the call's arguments.
 * @returns the bounded copy.
 */
function boundedArguments(args) {
  const bound = (value, depth) => {
    if (typeof value === 'string') {
      return value.length > MAX_STORED_ARGUMENT_CHARS
        ? `${value.slice(0, MAX_STORED_ARGUMENT_CHARS)}…[${value.length - MAX_STORED_ARGUMENT_CHARS} chars omitted]`
        : value;
    }
    if (Array.isArray(value)) return depth > 6 ? '[deep]' : value.map((item) => bound(item, depth + 1));
    if (value !== null && typeof value === 'object') {
      if (depth > 6) return '[deep]';
      const out = {};
      for (const [key, item] of Object.entries(value)) out[key] = bound(item, depth + 1);
      return out;
    }
    return value ?? null;
  };
  return bound(args ?? null, 0);
}

/** How many permitted tool names a denial reason lists. */
const PERMITTED_SAMPLE = 14;

/**
 * Build one runtime for a resolved configuration.
 * @param config - the resolved policy.
 * @param auditPath - the chain path, or `null`.
 * @returns the runtime.
 */
function buildRuntime(config, auditPath) {
  return new EntropyRuntime({
    utility: buildUtility(config.weights),
    theta: config.theta,
    policy: config.policy,
    fallback: config.fallback,
    auditLog: new AuditLog(auditPath),
    initialGear: config.initialGear,
    enforcement: config.enforcement,
  });
}

/**
 * One agent's autonomy governor.
 */
export class EntropyController {
  /**
   * @param options - construction options.
   * @param options.agentId - the owning agent/session id (`null` for process-level calls).
   * @param options.config - a resolved plugin configuration.
   * @param options.auditPath - the JSONL chain path, or `null` for memory only.
   */
  constructor({ agentId, config, auditPath = null }) {
    this.agentId = agentId;
    this.config = config;
    this.auditPath = auditPath;
    this.runtime = buildRuntime(config, auditPath);
    /** @type {Map<string, {action: object, at: number}>} admitted calls awaiting `tools/result`. */
    this.pending = new Map();
    /** Count of audit-append failures observed (an operational alarm signal). */
    this.auditFailures = 0;
    /** @type {string|null} */
    this.lastAuditError = null;
    /** Counterfactual denials recorded under `enforcement: 'observe'`. */
    this.wouldDeny = 0;
    /** When this governor started, for the export report. */
    this.startedAt = Date.now();
  }

  /* ---------------------------------------------------------------- *
   * Classification and utility input
   * ---------------------------------------------------------------- */

  /**
   * Turn one pending tool call into a gated action.
   *
   * The action carries the *object* as well as the verdict: a digest over the
   * canonical arguments always, and the arguments themselves only when the
   * deployment asks for them. Before 0.2.2 the chain recorded decisions about
   * calls whose target it could not name — and for a wall whose product is
   * non-repudiation, "which object" is the first question (defect 10).
   * @param name - tool name.
   * @param args - parsed arguments.
   * @returns the action object handed to the gate.
   */
  actionFor(name, args) {
    const attrs = classify(name, args, this.config);
    return {
      requiredGear: attrs.gear,
      name,
      attrs,
      argsDigest: digestArguments(args),
      // Whether the tool was classified by the table or by `defaultTool`. Ops
      // must be able to see a host rename as a number, not as a silent drift from
      // an explicit entry to the generic baseline.
      toolSource: attrs.known ? 'table' : 'default',
      ...(this.config.audit.includeArguments ? { args: boundedArguments(args) } : {}),
      description: attrs.labels.length > 0 ? `flagged: ${attrs.labels.join(', ')}` : '',
    };
  }

  /**
   * The environment state the utility function scores against.
   * @param name - tool name.
   * @returns the environment record.
   */
  env(name) {
    const state = this.runtime.state;
    return {
      agentId: this.agentId,
      tool: name,
      gear: state.gear,
      cycle: state.cycle,
      sigma: state.sigma,
      suspended: state.suspended,
    };
  }

  /* ---------------------------------------------------------------- *
   * The guard: one call, one decision
   * ---------------------------------------------------------------- */

  /**
   * Decide a pending call and mutate state on rejection.
   * @param exec - the pending tool execution (`name`, `arguments`, `callId`, `agent`).
   * @returns a denial reason, or `undefined` to let the call proceed.
   */
  guard(exec) {
    if (!this.config.enabled) return undefined;
    const name = String(exec?.name ?? '');
    if (this.config.controlTools.has(name)) return undefined;

    const callId = String(exec?.callId ?? '');
    const action = this.actionFor(name, exec?.arguments);
    const state = this.runtime.state;
    const observing = this.config.enforcement === 'observe';

    // `observe-only` keeps G0 available while suspended (paper Theorem 4's
    // recovery path); `deny-all` reproduces the SDK's `suspended_skip` exactly.
    const observeOnly = state.suspended
      && this.config.suspendedBehavior === 'observe-only'
      && action.requiredGear === Gear.OBSERVE;

    let decision;
    try {
      decision = this.runtime.admit(this.env(name), action, { ignoreSuspension: observeOnly });
    } catch (error) {
      // An audit-append failure is a fail-closed condition, not a warning.
      this.auditFailures += 1;
      this.lastAuditError = error?.message ?? String(error);
      if (observing) return undefined;
      return `entropy-guard: audit chain unavailable (${this.lastAuditError}); denied (fail-closed)`;
    }

    if (decision.admitted) {
      this.track(callId, action);
      return undefined;
    }

    if (observing) {
      // Measure, do not enforce: record exactly what the policy wanted to do.
      this.wouldDeny += 1;
      this.auditSafe('would_deny', {
        tool: name,
        denial_kind: decision.kind,
        required_gear: action.requiredGear,
        cycle: state.cycle,
        reason: decision.reason,
      });
      this.track(callId, action);
      return undefined;
    }

    if (decision.suspended || decision.kind === 'suspended') {
      return `entropy-guard denied "${name}": suspended, awaiting human review. `
        + 'Only read-only (G0) tools run until a human runs /entropy resume.';
    }

    let transition = null;
    try {
      transition = this.runtime.reject({ gearDenied: decision.kind === 'gear' });
      this.auditSafe('call_rejected', {
        tool: name,
        denial_kind: decision.kind,
        required_gear: action.requiredGear,
        cycle: state.cycle,
        reason: decision.reason,
      });
    } catch (error) {
      this.auditFailures += 1;
      this.lastAuditError = error?.message ?? String(error);
    }
    return this.denialReason(name, action, decision, transition);
  }

  /**
   * Compose a denial the model can act on: what was refused, why, what it may
   * use instead, and exactly what it takes to earn the gear back.
   * @param name - the tool name.
   * @param action - the classified action.
   * @param decision - the gate decision.
   * @param transition - the state transition, when it ran.
   * @returns the model-facing reason.
   */
  denialReason(name, action, decision, transition) {
    const state = this.runtime.state;
    const parts = [`entropy-guard denied "${name}"`];
    if (action.attrs.labels.length > 0) parts.push(`flagged [${action.attrs.labels.join(', ')}]`);
    parts.push(decision.kind === 'gear'
      ? `needs ${gearLabel(action.requiredGear)}, this session is at ${gearLabel(state.gear)}`
      : decision.reason);

    // `denials: 'terse'` withholds the permitted-tool list and the earn-back
    // arithmetic: publishing a heuristic gate's exact thresholds makes it cheaper
    // to probe. `'actionable'` trades that secrecy for a refusal the model can
    // act on, which is the better default for a research or single-tenant run.
    if (decision.kind === 'gear' && this.config.denials === 'actionable') {
      const permitted = this.permittedTools();
      if (permitted.length > 0) parts.push(`permitted now: ${permitted.join(', ')}`);
    }

    parts.push(
      `state: gear ${gearLabel(state.gear)}, sigma=${state.sigma.toFixed(2)}, `
      + `clean streak ${state.cleanStreak}/${this.runtime.policy.patience}, `
      + `${state.consecutiveRejections}/${this.runtime.fallback.maxConsecutiveRejections} consecutive rejections`,
    );

    if (state.suspended) {
      parts.push('SUSPENDED at G0 — a human must run /entropy resume before side-effecting work resumes');
    } else if (this.config.denials === 'actionable') {
      parts.push(this.earnBack(state));
    }
    if (transition !== null) {
      parts.push('the rejection is in the audit chain (/entropy status)');
    }
    return parts.join(' — ');
  }

  /**
   * Describe the shortest path back to the next gear level.
   * @param state - the current runtime state.
   * @returns a one-clause instruction.
   */
  earnBack(state) {
    const policy = this.runtime.policy;
    const cyclesToSettle = state.sigma >= policy.sigmaLow
      ? Math.ceil((state.sigma - policy.sigmaLow) / policy.sigmaDecay) + 1
      : 0;
    const cyclesToStreak = Math.max(0, policy.patience - state.cleanStreak);
    const total = cyclesToSettle + cyclesToStreak;
    if (state.gear >= Gear.INTEGRATE && total === 0) return 'already at the top gear';
    return `to earn ${gearLabel(Math.min(state.gear + 1, Gear.INTEGRATE))}: `
      + `${total} clean cycle${total === 1 ? '' : 's'} at the current gear without a rejection`;
  }

  /**
   * The tool names the current gear permits, most demanding first.
   * @returns a bounded sample of permitted tool names.
   */
  permittedTools() {
    const gear = this.runtime.state.gear;
    const names = Object.entries(this.config.tools)
      .filter(([, descriptor]) => descriptor.gear <= gear)
      .sort((a, b) => b[1].gear - a[1].gear || a[0].localeCompare(b[0]))
      .map(([name]) => name);
    if (names.length <= PERMITTED_SAMPLE) return names;
    return [...names.slice(0, PERMITTED_SAMPLE), `+${names.length - PERMITTED_SAMPLE} more`];
  }

  /**
   * Record the outcome of one admitted call, when its final result arrives.
   * @param callId - the registry's call id.
   * @param isError - whether the materialized result is an error.
   * @returns settle facts, or `null` when the call was never admitted.
   */
  settle(callId, isError) {
    const entry = this.pending.get(callId);
    if (entry === undefined) return null;
    this.pending.delete(callId);
    const outcome = isError ? 'rejected' : 'executed';
    let transition = null;
    try {
      transition = this.runtime.settle(outcome);
      if (isError) {
        this.auditSafe('tool_error', {
          tool: entry.action.name,
          cycle: this.runtime.state.cycle,
          required_gear: entry.action.requiredGear,
        });
      }
    } catch (error) {
      this.auditFailures += 1;
      this.lastAuditError = error?.message ?? String(error);
    }
    return { action: entry.action, outcome, transition };
  }

  /* ---------------------------------------------------------------- *
   * Pending-call bookkeeping
   * ---------------------------------------------------------------- */

  /**
   * Remember an admitted call so its result can settle the cycle.
   * @param callId - the registry call id (empty ids are not tracked).
   * @param action - the admitted action.
   */
  track(callId, action) {
    if (callId.length === 0) return;
    this.sweep();
    if (this.pending.size >= this.config.maxPending) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    this.pending.set(callId, { action, at: Date.now() });
  }

  /**
   * Drop admitted calls whose result never arrived, so a lost notification
   * cannot leak memory or hold a cycle open forever.
   * @returns the number of abandoned entries.
   */
  sweep() {
    const cutoff = Date.now() - this.config.pendingTtlMs;
    let dropped = 0;
    for (const [callId, entry] of this.pending) {
      if (entry.at > cutoff) continue;
      this.pending.delete(callId);
      dropped += 1;
      this.auditSafe('call_abandoned', { tool: entry.action.name, call_id: callId });
    }
    return dropped;
  }

  /* ---------------------------------------------------------------- *
   * Human-review control plane
   * ---------------------------------------------------------------- */

  /** Lift the suspension. sigma deliberately persists: gears must be re-earned. */
  resume() {
    this.runtime.resume();
    return this.status();
  }

  /**
   * Human override of the gear. A supervisor setting a gear explicitly also
   * clears the suspension, because that is the same judgement.
   * @param gear - the gear to set (0–4).
   * @returns the new status.
   */
  setGear(gear) {
    const state = this.runtime.state;
    const from = state.gear;
    state.gear = gear;
    state.cleanStreak = 0;
    state.suspended = false;
    state.consecutiveRejections = 0;
    this.runtime.audit.record('gear_manual', { cycle: state.cycle, from, to: gear });
    return this.status();
  }

  /**
   * Rebuild the runtime for this agent, archiving the previous chain in place.
   * @returns the fresh status.
   */
  reset() {
    this.runtime = buildRuntime(this.config, this.auditPath);
    this.pending.clear();
    this.wouldDeny = 0;
    this.runtime.audit.record('reset', {});
    return this.status();
  }

  /* ---------------------------------------------------------------- *
   * Reporting
   * ---------------------------------------------------------------- */

  /**
   * Fold the chain into the readings the paper's empirical sections ask for.
   * @returns `{ perTool, transitions, suspensions, sigmaTrajectory, totals }`.
   */
  metrics() {
    const entries = this.runtime.audit.entries;
    const perTool = {};
    const transitions = [];
    const suspensions = [];
    const sigmaTrajectory = [];
    let decisions = 0;
    let admitted = 0;
    let enforcedDecisions = 0;
    let enforcedAdmitted = 0;
    let observedDecisions = 0;
    let wouldDeny = 0;
    let defaultedTools = 0;

    for (const entry of entries) {
      switch (entry.kind) {
        case 'gate_decision': {
          decisions += 1;
          if (entry.admitted === true) admitted += 1;
          // Entries written before this field existed were gate-mode by
          // construction, so they count as enforced.
          if ((entry.enforcement ?? 'gate') === 'observe') {
            observedDecisions += 1;
          } else {
            enforcedDecisions += 1;
            if (entry.admitted === true) enforcedAdmitted += 1;
          }
          const tool = entry.tool ?? '(unknown)';
          const bucket = perTool[tool] ?? {
            decisions: 0, admitted: 0, denied: 0, maxGear: 0, observed: 0, wouldDeny: 0,
          };
          bucket.decisions += 1;
          if (entry.admitted === true) bucket.admitted += 1;
          else bucket.denied += 1;
          if ((entry.enforcement ?? 'gate') === 'observe') bucket.observed += 1;
          if (entry.tool_source === 'default') defaultedTools += 1;
          bucket.maxGear = Math.max(bucket.maxGear, Number(entry.gear ?? 0));
          perTool[tool] = bucket;
          sigmaTrajectory.push({
            cycle: entry.cycle ?? null,
            gear: entry.gear ?? null,
            sigma: entry.sigma ?? null,
            admitted: entry.admitted === true,
            enforcement: entry.enforcement ?? 'gate',
            tool,
          });
          break;
        }
        case 'would_deny': {
          wouldDeny += 1;
          const tool = entry.tool ?? '(unknown)';
          const bucket = perTool[tool] ?? {
            decisions: 0, admitted: 0, denied: 0, maxGear: 0, observed: 0, wouldDeny: 0,
          };
          bucket.wouldDeny += 1;
          perTool[tool] = bucket;
          break;
        }
        case 'gear_transition':
          transitions.push({
            cycle: entry.cycle ?? null,
            from: entry.from ?? null,
            to: entry.to ?? null,
            sigma: entry.sigma ?? null,
            reason: entry.reason ?? null,
          });
          break;
        case 'suspend':
          suspensions.push({
            cycle: entry.cycle ?? null,
            rejections: entry.consecutive_rejections ?? null,
          });
          break;
        default:
          break;
      }
    }

    return {
      perTool,
      transitions,
      suspensions,
      sigmaTrajectory,
      totals: {
        decisions,
        admitted,
        denied: decisions - admitted,
        enforcedDecisions,
        enforcedAdmitted,
        observedDecisions,
        wouldDeny,
        defaultedTools,
        // Two readings that must never be blended: the rate the gate actually
        // produced, and the refusal rate the policy *wanted* while observing.
        // One mixed number would poison cross-deployment comparison.
        acceptance: enforcedDecisions === 0 ? null : enforcedAdmitted / enforcedDecisions,
        wouldDenyRate: observedDecisions === 0 ? null : wouldDeny / observedDecisions,
      },
    };
  }

  /**
   * The live state plus the paper's empirical readings.
   * @returns a JSON-safe status object.
   */
  status() {
    const state = this.runtime.state;
    const audit = this.runtime.audit;
    const metrics = this.metrics();
    return {
      ...snapshot(state),
      agentId: this.agentId,
      enforcement: this.config.enforcement,
      suspendedBehavior: this.config.suspendedBehavior,
      theta: this.runtime.gate.theta,
      policy: { ...this.runtime.policy },
      fallback: { ...this.runtime.fallback },
      // Enforced-only by default, so an observe-mode run cannot dilute it; the
      // raw chain-wide reading stays available beside it.
      gateAcceptanceRate: metrics.totals.acceptance,
      chainAcceptanceRate: audit.gateAcceptanceRate(),
      wouldDenyRate: metrics.totals.wouldDenyRate,
      gearHistogram: audit.gearHistogram(),
      decisions: metrics.totals.decisions,
      denied: metrics.totals.denied,
      observedDecisions: metrics.totals.observedDecisions,
      wouldDeny: metrics.totals.wouldDeny,
      defaultedTools: metrics.totals.defaultedTools,
      storeArguments: this.config.audit.includeArguments === true,
      chain: audit.verify(),
      pendingCalls: this.pending.size,
      auditPath: this.auditPath,
      auditFailures: this.auditFailures,
      lastAuditError: this.lastAuditError,
      uptimeMs: Date.now() - this.startedAt,
      recent: audit.entries.slice(-REPORT_TAIL).map((entry) => ({
        kind: entry.kind,
        cycle: entry.cycle ?? null,
        admitted: entry.admitted ?? null,
        args_digest: entry.args_digest ?? null,
        reason: entry.reason ?? null,
      })),
    };
  }

  /**
   * The model-facing one-liner injected as per-agent runtime context.
   * @returns the line, or an empty string when the guard is off.
   */
  promptLine() {
    if (!this.config.enabled) return '';
    const state = this.runtime.state;
    const rate = this.runtime.audit.gateAcceptanceRate();
    const acceptance = rate === null ? 'n/a' : `${Math.round(rate * 100)}%`;
    const mode = this.config.enforcement === 'observe'
      ? ' · OBSERVE mode: nothing is denied, decisions are measured only'
      : '';
    const held = state.suspended
      ? ' · SUSPENDED at G0 (only read-only tools run; a human must run /entropy resume)'
      : '';
    return `Entropy guard: gear ${gearLabel(state.gear)} (G0 Observe → G4 Integrate)`
      + ` · sigma=${state.sigma.toFixed(2)}`
      + ` · clean streak ${state.cleanStreak}/${this.runtime.policy.patience}`
      + ` · ${state.consecutiveRejections}/${this.runtime.fallback.maxConsecutiveRejections} consecutive rejections`
      + ` · gate acceptance ${acceptance}`
      + mode
      + held;
  }

  /**
   * A human-readable multi-line report for the `/entropy status` command.
   * @returns the report text.
   */
  report() {
    const status = this.status();
    const metrics = this.metrics();
    const lines = [
      `Entropy guard — agent ${status.agentId ?? '(process-level)'}`,
      `  enforcement   ${status.enforcement}${status.enforcement === 'observe' ? ' (measuring only; nothing is denied)' : ''}`,
      `  gear          ${gearLabel(status.gear)}`,
      `  sigma         ${status.sigma}`,
      `  clean streak  ${status.cleanStreak}/${this.runtime.policy.patience} (escalation needs sigma < ${this.runtime.policy.sigmaLow}; fast down on ${this.runtime.policy.fastDown})`,
      `  rejections    ${status.consecutiveRejections}/${this.runtime.fallback.maxConsecutiveRejections} consecutive`,
      `  cycles        ${status.cycle} (${status.decisions} decisions, ${status.denied} denied, ${status.wouldDeny} would-deny)`,
      `  suspended     ${status.suspended ? `yes — ${status.suspendedBehavior}` : 'no'}`,
      `  acceptance    ${status.gateAcceptanceRate === null ? 'n/a' : status.gateAcceptanceRate.toFixed(4)} (enforced decisions only; chain-wide ${status.chainAcceptanceRate === null ? 'n/a' : status.chainAcceptanceRate.toFixed(4)})`,
      `  would-deny    ${status.wouldDenyRate === null ? 'n/a' : status.wouldDenyRate.toFixed(4)} over ${status.observedDecisions} observe-mode decisions`,
      `  object        ${status.storeArguments ? 'arguments stored' : 'arguments digested only (args_digest per decision)'} · ${status.defaultedTools} decision(s) classified by defaultTool`,
      `  histogram     ${JSON.stringify(status.gearHistogram)}`,
      `  chain         ${status.chain.status === 'tampered'
        ? `TAMPERED at seq ${status.chain.brokenAt}: ${status.chain.reason}`
        : `${status.chain.status.toUpperCase()} — ${status.chain.chained} chained, ${status.chain.legacy} legacy`
          + `${status.chain.interleaved > 0 ? `, ${status.chain.interleaved} interleaved` : ''}`
          + `${status.chain.forks > 0 ? `, ${status.chain.forks} forked` : ''}`
          + `, ${status.chain.corrupt} corrupt`
          + `${status.chain.reason.length > 0 ? ` — ${status.chain.reason}` : ''}`}`,
      `  transitions   ${metrics.transitions.length} across ${Object.keys(metrics.perTool).length} tools`,
      `  audit chain   ${status.auditPath ?? '(memory only)'}${status.auditFailures > 0 ? ` — ${status.auditFailures} append failures, last: ${status.lastAuditError}` : ''}`,
      '  recent:',
    ];
    for (const entry of status.recent) {
      lines.push(`    [${entry.kind}] cycle=${entry.cycle} admitted=${entry.admitted} ${entry.reason ?? ''}`.trimEnd());
    }
    return lines.join('\n');
  }

  /**
   * A paper-ready snapshot of this agent's run: state, policy, and every
   * empirical reading the chain supports, plus the raw chain path so a reader
   * can re-derive it. This is the artifact the SDK's §8 empirical requirements
   * ask for.
   * @returns the export object.
   */
  exportReport() {
    const status = this.status();
    const metrics = this.metrics();
    return {
      schema: 'dsh-entropy-guard/report@1',
      generatedAt: new Date().toISOString(),
      agentId: this.agentId,
      state: {
        gear: status.gear,
        gearLabel: status.gearLabel,
        sigma: status.sigma,
        cleanStreak: status.cleanStreak,
        consecutiveRejections: status.consecutiveRejections,
        suspended: status.suspended,
        cycles: status.cycle,
      },
      policy: {
        enforcement: status.enforcement,
        suspendedBehavior: status.suspendedBehavior,
        theta: status.theta,
        // Field-level, beside theta rather than only inside the nested snapshot:
        // two runs sampled under different fast-down semantics are not
        // comparable, so the mode travels with the numbers.
        fastDown: status.policy.fastDown,
        weights: this.config.weights,
        denials: this.config.denials,
        policy: status.policy,
        fallback: status.fallback,
      },
      metrics: {
        gateAcceptanceRate: status.gateAcceptanceRate,
        chainAcceptanceRate: status.chainAcceptanceRate,
        wouldDenyRate: status.wouldDenyRate,
        gearHistogram: status.gearHistogram,
        totals: metrics.totals,
        perTool: metrics.perTool,
        transitions: metrics.transitions,
        suspensions: metrics.suspensions,
        sigmaTrajectory: metrics.sigmaTrajectory,
      },
      chainIntegrity: this.runtime.audit.verify(),
      chain: this.auditPath,
    };
  }

  /**
   * Render an export as a compact markdown report.
   * @returns the markdown text.
   */
  exportMarkdown() {
    const report = this.exportReport();
    const { metrics } = report;
    const lines = [
      `# Entropy guard report — ${report.agentId ?? '(process-level)'}`,
      '',
      `Generated: ${report.generatedAt}`,
      '',
      '## State',
      '',
      `- Gear: **${report.state.gearLabel}** (G${report.state.gear})`,
      `- sigma: ${report.state.sigma} (escalation below ${report.policy.policy.sigmaLow}; fast down on ${report.policy.policy.fastDown})`,
      `- Clean streak: ${report.state.cleanStreak}/${report.policy.policy.patience}`,
      `- Consecutive rejections: ${report.state.consecutiveRejections}/${report.policy.fallback.maxConsecutiveRejections}`,
      `- Suspended: ${report.state.suspended ? 'yes' : 'no'}`,
      `- Cycles: ${report.state.cycles}`,
      `- Enforcement: ${report.policy.enforcement}`,
      '',
      '## Gate acceptance (Theorem 1 reading)',
      '',
      `- Rate: ${metrics.gateAcceptanceRate === null ? 'n/a' : metrics.gateAcceptanceRate.toFixed(4)}`,
      `- Decisions: ${metrics.totals.decisions} (${metrics.totals.admitted} admitted, ${metrics.totals.denied} denied, ${metrics.totals.wouldDeny} would-deny)`,
      '',
      '## Gear transitions (Theorem 3 reading)',
      '',
      `- Histogram: \`${JSON.stringify(metrics.gearHistogram)}\``,
      `- Transitions: ${metrics.transitions.length}`,
      `- Suspensions: ${metrics.suspensions.length}`,
      '',
      '| cycle | from | to | sigma | reason |',
      '|---|---|---|---|---|',
    ];
    for (const transition of metrics.transitions) {
      lines.push(`| ${transition.cycle} | G${transition.from} | G${transition.to} | ${transition.sigma} | ${transition.reason ?? ''} |`);
    }
    lines.push(
      '',
      '## Per-tool decisions',
      '',
      '| tool | decisions | admitted | denied | gear seen |',
      '|---|---|---|---|---|',
    );
    for (const [tool, bucket] of Object.entries(metrics.perTool).sort((a, b) => b[1].decisions - a[1].decisions)) {
      lines.push(`| ${tool} | ${bucket.decisions} | ${bucket.admitted} | ${bucket.denied} | G${bucket.maxGear} |`);
    }
    lines.push('', `Raw chain: \`${report.chain ?? '(memory only)'}\``, '');
    return lines.join('\n');
  }

  /**
   * Record an audit entry without letting a chain failure escalate.
   * @param kind - event kind.
   * @param fields - event fields.
   */
  auditSafe(kind, fields) {
    try {
      this.runtime.audit.record(kind, fields);
    } catch (error) {
      this.auditFailures += 1;
      this.lastAuditError = error?.message ?? String(error);
    }
  }
}

/** All gear labels, for UI and description text. */
export { GEAR_LABELS };
