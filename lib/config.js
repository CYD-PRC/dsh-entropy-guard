/**
 * Deployment policy for the DSH binding of the Entropy control layer.
 *
 * The SDK ships no built-in utility function — `U` must be injected by the
 * deployer (README design rule 2). This module is that injection for a DeepSeek
 * Harness tool registry: it classifies a tool call onto the gear ladder, scores
 * its risk, and evaluates the paper's recommended shape
 *
 *     U(s, a) = alpha * taskGain(a) + beta * safety(a) - gamma * cost(a)
 *     safety(a) = 1 - risk(a)
 *
 * Everything below is a *default*, expressed as data in the plugin's `config`
 * so a deployment can replace it in `cordis.patch.yml` without touching code.
 * Unknown tools are not exempt: they take `defaultTool`, which attests to G3
 * (Execute) — the fail-closed direction on the gear axis.
 *
 * @module dsh-entropy-guard/config
 */

import { Gear, safeGear } from './core.js';

/**
 * Built-in classification of the tools this Harness composition exposes.
 * `gear` is the minimum gear the action attests to needing, `risk` is in
 * [0, 1] where 1 is maximally unsafe, and `cost` is a resource/irreversibility
 * weight. A deployment extends or overrides individual entries.
 */
export const DEFAULT_TOOLS = Object.freeze({
  // G0 — observation only.
  read: { gear: 0, risk: 0.05, cost: 0.2 },
  read_image: { gear: 0, risk: 0.05, cost: 0.2 },
  glob: { gear: 0, risk: 0.03, cost: 0.1 },
  grep: { gear: 0, risk: 0.05, cost: 0.2 },
  web_search: { gear: 0, risk: 0.25, cost: 0.3 },
  web_fetch: { gear: 0, risk: 0.25, cost: 0.3 },
  ask_user_question: { gear: 0, risk: 0.05, cost: 0.3 },
  skill: { gear: 0, risk: 0.02, cost: 0.1 },
  list_agents: { gear: 0, risk: 0.02, cost: 0.1 },
  get_goal: { gear: 0, risk: 0.02, cost: 0.1 },
  job_list: { gear: 0, risk: 0.02, cost: 0.1 },
  job_output: { gear: 0, risk: 0.02, cost: 0.1 },
  job_kill: { gear: 2, risk: 0.3, cost: 0.3 },
  cordis_inspect_list: { gear: 0, risk: 0.02, cost: 0.1 },
  cordis_inspect_query: { gear: 0, risk: 0.02, cost: 0.1 },
  // G1 — side-effect-free planning inside the session.
  todo_write: { gear: 1, risk: 0.02, cost: 0.1 },
  exit_plan_mode: { gear: 1, risk: 0.02, cost: 0.1 },
  // G2 — bounded, reversible control actions.
  create_goal: { gear: 2, risk: 0.1, cost: 0.2 },
  update_goal: { gear: 2, risk: 0.1, cost: 0.2 },
  present: { gear: 2, risk: 0.05, cost: 0.2 },
  send_message: { gear: 2, risk: 0.3, cost: 0.3 },
  interrupt_agent: { gear: 2, risk: 0.35, cost: 0.3 },
  // G3 — independently chosen side effects.
  write: { gear: 3, risk: 0.55, cost: 0.5 },
  edit: { gear: 3, risk: 0.55, cost: 0.5 },
  pwsh: { gear: 3, risk: 0.7, cost: 0.6 },
  /**
   * G4 Integrate, not G3: installing, removing or reconfiguring plugins is
   * system-level coordination of the agent's own control plane, which is exactly
   * what the top gear names. It also closes the hole where a governed session
   * could uninstall the guard with the very tool autonomy the guard granted —
   * at G4 the call is admitted (`U = 1.0`) and nowhere below it.
   */
  plugin_manager: { gear: 4, risk: 0.85, cost: 0.6 },
  subagent: { gear: 3, risk: 0.6, cost: 0.7 },
  subagent_fork: { gear: 3, risk: 0.6, cost: 0.7 },
  workflow: { gear: 3, risk: 0.6, cost: 0.7 },
  // The guard's own read-only report tool: never a risk, never a cost.
  entropy_status: { gear: 0, risk: 0, cost: 0.05 },
});

/**
 * Catastrophic *targets* for a destructive operation.
 *
 * A rule pairs an operation pattern with an optional `dangerousTarget`, and
 * fires only when both match. The line drawn here is deliberate and easy to
 * state: **a recursive force delete of an absolute path, a home directory, or a
 * bare wildcard is vetoed; a scoped relative path is ordinary work.** Clearing a
 * dependency directory or a build output directory is what agents do all day,
 * and a rule that denies it just spams rejections and suspends the agent for
 * doing its job. Wiping the filesystem root, the home directory, a drive root,
 * the user profile, the working directory itself, or a bare wildcard is exactly
 * what deserves an outright veto.
 *
 * One acknowledged over-approximation: any token that begins with a path
 * separator counts as absolute, so a flag value like an exclude root also trips
 * the rule. That errs toward denial, which is the correct direction for a gate.
 */
const UNIX_DANGEROUS_TARGET = String.raw`(?:^|[\s;&|"'=])(?:/|~|\$HOME\b|\$\{HOME\}|\*)`;

/** A lone dot or double dot: a recursive force delete of the whole working directory. */
const UNIX_CWD_TARGET = String.raw`(?:^|[\s;&|"'=])\.\.?(?=\s|$|["';|&])`;

/** Drive-absolute paths, the user profile, and bare wildcards on Windows. */
const WINDOWS_DANGEROUS_TARGET = String.raw`(?:^|[\s;&|"'=])(?:[A-Za-z]:[\\/]|\$HOME\b|\$env:USERPROFILE\b|\$env:HOMEDRIVE\b|%USERPROFILE%|%HOMEDRIVE%|\*)`;

/** A lone dot or double dot on PowerShell. */
const WINDOWS_CWD_TARGET = String.raw`(?:^|[\s;&|"'=])\.\.?(?=\s|$|["';|&])`;

/**
 * High-confidence destructive patterns. Each match raises the action's risk
 * (and often its cost), which is what pushes `U` under `theta` and denies it.
 * These are deliberately narrow: a rule that fires on ordinary work would make
 * the gate unusable, and the deployer can extend the list.
 */
export const DEFAULT_RULES = Object.freeze([
  {
    label: 'recursive-force-delete',
    dangerousTarget: `${UNIX_DANGEROUS_TARGET}|${UNIX_CWD_TARGET}`,
    match: '(?:^|[^A-Za-z0-9_])rm\\s+(?:-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|-[a-zA-Z]*r[a-zA-Z]*\\s+-[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*\\s+-[a-zA-Z]*r[a-zA-Z]*|--recursive\\b[^\\n]{0,40}--force\\b|--force\\b[^\\n]{0,40}--recursive\\b)',
    risk: 1,
    cost: 0.8,
  },
  {
    label: 'windows-recursive-force-delete',
    dangerousTarget: `${WINDOWS_DANGEROUS_TARGET}|${WINDOWS_CWD_TARGET}`,
    match: 'Remove-Item\\b(?=[^\\n]*-Recurse)(?=[^\\n]*-Force)|del\\s+/[sfq]\\b[^\\n]*/[sfq]\\b',
    risk: 1,
    cost: 0.8,
  },
  {
    label: 'destructive-git',
    match: 'git\\s+(?:push\\b[^\\n]*(?:--force\\b|--force-with-lease\\b|\\s-f\\b)|reset\\s+--hard|clean\\s+-[a-zA-Z]*f|filter-branch)',
    risk: 0.95,
    cost: 0.7,
  },
  {
    label: 'pipe-to-shell',
    match: '(?:curl|wget|Invoke-WebRequest|iwr)\\b[^\\n]*\\|\\s*(?:sudo\\s+)?(?:ba|z|k)?sh\\b|(?:curl|wget)\\b[^\\n]*\\|\\s*(?:python[0-9.]*|node|pwsh|powershell)\\b',
    risk: 0.9,
    cost: 0.7,
  },
  {
    label: 'disk-destructive',
    match: '\\bmkfs(?:\\.\\w+)?\\b|\\bdd\\s+[^\\n]*of=/dev/|\\bformat\\s+[a-zA-Z]:|vssadmin\\s+delete\\s+shadows',
    risk: 1,
    cost: 0.9,
  },
  {
    label: 'fork-bomb',
    match: ':\\s*\\(\\s*\\)\\s*\\{[^}]*\\}\\s*;\\s*:',
    risk: 1,
    cost: 0.9,
  },
  {
    label: 'credential-store-access',
    match: '(?:^|[\\\\/\\s"\'])(?:\\.ssh[\\\\/]id_[a-z]+|\\.aws[\\\\/]credentials|\\.netrc|id_rsa|\\.credentials\\.ya?ml|\\.git-credentials)',
    risk: 0.95,
    cost: 0.8,
  },
  {
    label: 'system-registry-mutation',
    match: '\\breg\\s+delete\\b|\\bbcdedit\\b|Remove-Item\\s+[a-zA-Z]:\\\\Windows',
    risk: 0.95,
    cost: 0.7,
  },
  {
    label: 'world-writable-root',
    match: 'chmod\\s+(?:-[a-zA-Z]+\\s+)*777\\s+/\\s*(?:$|[;&|])|chmod\\s+-R\\s+777\\s+/',
    risk: 0.9,
    cost: 0.6,
  },
]);

/** Default gate weights matching the README's recommended utility shape. */
export const DEFAULT_WEIGHTS = Object.freeze({ task: 1, safety: 2, cost: 0.5 });

/**
 * Argument keys that carry *content* rather than an operation.
 *
 * Pattern rules describe executable operations — "does this command delete a
 * filesystem tree?" — so they scan the tool name and its operation-bearing
 * arguments. The bytes a file-writing tool is about to write are not an
 * operation: writing a document, a test, or a policy table that merely *mentions*
 * a destructive command must not be denied (doing so makes the guard unable to
 * maintain its own rule set). The dangerous moment is running such a command,
 * and every shell tool's command argument is still scanned.
 */
export const DEFAULT_CONTENT_KEYS = Object.freeze(['content', 'old_string', 'new_string']);

/** The fully-resolved default configuration. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  /** Start at G3: a normal Harness session keeps its autonomy, and de-escalates on error. */
  initialGear: Gear.EXECUTE,
  theta: 1,
  weights: DEFAULT_WEIGHTS,
  tools: DEFAULT_TOOLS,
  rules: DEFAULT_RULES,
  contentKeys: DEFAULT_CONTENT_KEYS,
  /** Unknown tools are side-effecting (G3) with a mid-range safety score. */
  defaultTool: { gear: Gear.EXECUTE, risk: 0.5, cost: 0.5 },
  policy: {
    sigmaLow: 0.3,
    sigmaHigh: 1,
    patience: 3,
    sigmaDecay: 0.1,
    sigmaStep: 0.1,
    /**
     * `'error'` is the SDK's law: the epsilon flag alone de-escalates one gear
     * immediately. `'overflow'` de-escalates only once sigma crosses
     * `sigmaHigh`, so one Harness tool error costs 0.1 sigma instead of a whole
     * gear. Default stays faithful; `'overflow'` is the recommended setting for
     * an interactive coding agent, where most tool errors — a stale edit anchor,
     * a search that finds nothing — are request outcomes, not control
     * instability.
     */
    fastDown: 'error',
  },
  /**
   * DSH cannot rewrite a pending call, so the SDK's alternative proposer has
   * nowhere to execute: `maxAlternatives` defaults to 0 (fallback off — an
   * explicit legal configuration in v0.1.2+). The rejection itself is the
   * feedback the agent acts on next turn.
   *
   * `countGearDenials: false` points the suspension endpoint at *safety*
   * rejections. A gear-blocked call is a consequence of the ladder, not a
   * proposal of dangerous work, so it still costs sigma (the ladder's fast-down
   * still applies) without marching the session toward a G0 suspension — which
   * otherwise cascades the moment an agent below its working gear keeps calling
   * the tools its job needs. `true` restores the SDK's literal consecutive
   * rejection count.
   */
  fallback: { maxAlternatives: 0, maxConsecutiveRejections: 8, countGearDenials: false },
  /**
   * `'gate'` denies what the utility gate rejects. `'observe'` denies nothing:
   * every call is still classified, gated, audited and reported (with
   * `would_deny`), so a deployment can measure the policy before letting it
   * act. The intended adoption order is install in `observe`, read
   * `/entropy export`, then switch to `gate`.
   */
  enforcement: 'gate',
  /** `null` disables the on-disk chain; the host passes a resolved directory. */
  audit: { dir: null, includeArguments: false },
  /**
   * `observe-only` keeps the paper's Theorem 4 recovery path (G0 read-only
   * actions remain available while suspended) instead of the SDK's stricter
   * `suspended_skip`, which would leave an embedded agent unable to read the
   * audit or the code it must fix. Use `deny-all` for SDK-exact behavior.
   */
  suspendedBehavior: 'observe-only',
  /** Tools that bypass the cycle entirely: the human-review control plane. */
  controlTools: ['entropy_status'],
  promptContext: true,
  humanCommands: true,
  /**
   * How much a denial tells the model. `'actionable'` includes the permitted-tool
   * list and the earn-back arithmetic; `'terse'` reports the refusal and the live
   * state only.
   *
   * Observability is this plugin's product, so `'actionable'` is the default. But
   * the rules are heuristics, and a gate that publishes its own thresholds and
   * the exact action set it still permits is cheaper to probe — so a deployment
   * that treats its policy as sensitive sets `'terse'`. That trade is
   * observability versus secrecy, and it belongs to the deployer.
   */
  denials: 'actionable',
  /** The optional Web UI: a live badge above the composer and a settings page. */
  ui: { dock: true, settings: true },
  /** Bounds on un-settled admitted calls waiting for their `tools/result`. */
  maxPending: 512,
  pendingTtlMs: 600000,
});

/**
 * @param value - candidate.
 * @returns whether the value is a plain object.
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reject a value that is not the expected shape, naming the offending path.
 * @param condition - the assertion.
 * @param path - the config path being validated.
 */
function assert(condition, path) {
  if (!condition) throw new Error(`entropy-guard config: invalid ${path}`);
}

/**
 * Validate and default one tool descriptor.
 * @param raw - candidate descriptor.
 * @param path - config path for diagnostics.
 * @returns the normalized descriptor.
 */
function normalizeTool(raw, path) {
  assert(isPlainObject(raw), path);
  const gear = safeGear(raw.gear ?? Gear.EXECUTE);
  assert(gear !== null, `${path}.gear (want an integer 0-4)`);
  const risk = raw.risk ?? 0.5;
  const cost = raw.cost ?? 0.5;
  const gain = raw.gain ?? 1;
  for (const [name, value] of [['risk', risk], ['cost', cost], ['gain', gain]]) {
    assert(typeof value === 'number' && Number.isFinite(value), `${path}.${name}`);
  }
  assert(risk >= 0 && risk <= 1, `${path}.risk (want 0-1)`);
  return { gear, risk, cost, gain };
}

/**
 * Resolve the plugin's raw `config` into a validated, fully-defaulted policy.
 * Invalid values throw at activation instead of degrading silently, matching
 * the SDK's construct-time fail-closed validation.
 * @param raw - the row's `config` object.
 * @returns the resolved policy.
 */
export function resolveConfig(raw) {
  const input = isPlainObject(raw) ? raw : {};

  const tools = {};
  for (const [toolName, descriptor] of Object.entries(DEFAULT_TOOLS)) {
    tools[toolName] = normalizeTool(descriptor, `tools.${toolName}`);
  }
  if (input.tools !== undefined) {
    assert(isPlainObject(input.tools), 'tools');
    for (const [toolName, descriptor] of Object.entries(input.tools)) {
      tools[toolName] = descriptor === null ? null : normalizeTool(descriptor, `tools.${toolName}`);
    }
    for (const [toolName, descriptor] of Object.entries(tools)) {
      if (descriptor === null) delete tools[toolName];
    }
  }

  const rules = [];
  const ruleInputs = input.rules ?? DEFAULT_RULES;
  assert(Array.isArray(ruleInputs), 'rules');
  for (const [index, rule] of ruleInputs.entries()) {
    assert(isPlainObject(rule) && typeof rule.match === 'string', `rules[${index}].match`);
    let regexp;
    try {
      regexp = new RegExp(rule.match, rule.flags ?? 'i');
    } catch (error) {
      throw new Error(`entropy-guard config: invalid rules[${index}].match: ${error?.message ?? error}`);
    }
    const risk = rule.risk ?? 0.9;
    const cost = rule.cost ?? 0.5;
    const gear = rule.gear === undefined ? null : safeGear(rule.gear);
    assert(typeof risk === 'number' && Number.isFinite(risk) && risk >= 0 && risk <= 1, `rules[${index}].risk`);
    assert(typeof cost === 'number' && Number.isFinite(cost), `rules[${index}].cost`);
    assert(rule.gear === undefined || gear !== null, `rules[${index}].gear (want an integer 0-4)`);
    assert(
      rule.dangerousTarget === undefined || typeof rule.dangerousTarget === 'string',
      `rules[${index}].dangerousTarget`,
    );
    let targetRegexp = null;
    if (rule.dangerousTarget !== undefined) {
      try {
        targetRegexp = new RegExp(rule.dangerousTarget, rule.flags ?? 'i');
      } catch (error) {
        throw new Error(`entropy-guard config: invalid rules[${index}].dangerousTarget: ${error?.message ?? error}`);
      }
    }
    rules.push({ label: rule.label ?? `rule-${index}`, regexp, targetRegexp, risk, cost, gear });
  }

  const policy = { ...DEFAULT_CONFIG.policy, ...(isPlainObject(input.policy) ? input.policy : {}) };
  const fallback = { ...DEFAULT_CONFIG.fallback, ...(isPlainObject(input.fallback) ? input.fallback : {}) };
  const weights = { ...DEFAULT_WEIGHTS, ...(isPlainObject(input.weights) ? input.weights : {}) };
  for (const name of ['task', 'safety', 'cost']) {
    assert(typeof weights[name] === 'number' && Number.isFinite(weights[name]), `weights.${name}`);
  }

  const theta = input.theta ?? DEFAULT_CONFIG.theta;
  assert(typeof theta === 'number' && Number.isFinite(theta) && theta >= 0, 'theta (want finite and >= 0)');

  const initialGear = safeGear(input.initialGear ?? DEFAULT_CONFIG.initialGear);
  assert(initialGear !== null, 'initialGear (want an integer 0-4)');

  const suspendedBehavior = input.suspendedBehavior ?? DEFAULT_CONFIG.suspendedBehavior;
  assert(suspendedBehavior === 'observe-only' || suspendedBehavior === 'deny-all', 'suspendedBehavior');

  const controlTools = input.controlTools ?? DEFAULT_CONFIG.controlTools;
  assert(Array.isArray(controlTools) && controlTools.every((name) => typeof name === 'string'), 'controlTools');

  const audit = { ...DEFAULT_CONFIG.audit, ...(isPlainObject(input.audit) ? input.audit : {}) };
  assert(audit.dir === null || typeof audit.dir === 'string', 'audit.dir');

  const maxPending = input.maxPending ?? DEFAULT_CONFIG.maxPending;
  const pendingTtlMs = input.pendingTtlMs ?? DEFAULT_CONFIG.pendingTtlMs;
  assert(Number.isInteger(maxPending) && maxPending >= 1, 'maxPending');
  assert(Number.isInteger(pendingTtlMs) && pendingTtlMs >= 1000, 'pendingTtlMs');

  const contentKeys = input.contentKeys ?? DEFAULT_CONTENT_KEYS;
  assert(
    Array.isArray(contentKeys) && contentKeys.every((key) => typeof key === 'string'),
    'contentKeys (want an array of argument-key names)',
  );

  const enforcement = input.enforcement ?? DEFAULT_CONFIG.enforcement;
  assert(enforcement === 'gate' || enforcement === 'observe', 'enforcement (want gate or observe)');

  const fastDown = policy.fastDown;
  assert(fastDown === 'error' || fastDown === 'overflow', 'policy.fastDown (want error or overflow)');

  const countGearDenials = fallback.countGearDenials;
  assert(typeof countGearDenials === 'boolean', 'fallback.countGearDenials (want a boolean)');

  const ui = { ...DEFAULT_CONFIG.ui, ...(isPlainObject(input.ui) ? input.ui : {}) };
  assert(typeof ui.dock === 'boolean' && typeof ui.settings === 'boolean', 'ui.dock / ui.settings');

  const denials = input.denials ?? DEFAULT_CONFIG.denials;
  assert(denials === 'actionable' || denials === 'terse', 'denials (want actionable or terse)');

  return {
    enabled: input.enabled !== false,
    initialGear,
    theta,
    weights,
    tools,
    rules,
    contentKeys: new Set(contentKeys),
    defaultTool: normalizeTool(input.defaultTool ?? DEFAULT_CONFIG.defaultTool, 'defaultTool'),
    controlTools: new Set(controlTools),
    policy,
    fallback,
    enforcement,
    denials,
    ui: { dock: ui.dock, settings: ui.settings },
    audit: { dir: audit.dir, includeArguments: audit.includeArguments === true },
    suspendedBehavior,
    promptContext: input.promptContext !== false,
    humanCommands: input.humanCommands !== false,
    maxPending,
    pendingTtlMs,
  };
}

/**
 * Build the surface the pattern rules scan: the tool name plus its
 * operation-bearing arguments, with content payloads removed.
 * @param name - the tool name.
 * @param args - the parsed arguments.
 * @param contentKeys - argument keys treated as content, not operation.
 * @returns the scan surface.
 */
function scanSurface(name, args, contentKeys) {
  if (!isPlainObject(args)) {
    try {
      return `${name} ${JSON.stringify(args ?? null)}`;
    } catch {
      return `${name} [unserializable arguments]`;
    }
  }
  try {
    const operation = {};
    for (const [key, value] of Object.entries(args)) {
      if (contentKeys.has(key)) continue;
      operation[key] = value;
    }
    return `${name} ${JSON.stringify(operation)}`;
  } catch {
    return `${name} [unserializable arguments]`;
  }
}

/**
 * Classify one tool call onto the gear ladder and score it.
 * @param name - the tool name.
 * @param args - the parsed arguments.
 * @param config - the resolved policy.
 * @returns `{ gear, risk, cost, gain, labels, known }`.
 */
export function classify(name, args, config) {
  const base = config.tools[name] ?? config.defaultTool;
  const known = Object.hasOwn(config.tools, name);
  let risk = base.risk;
  let cost = base.cost;
  let gear = base.gear;
  const labels = [];

  if (config.rules.length > 0) {
    // Bound the scanned surface: rules are for commands and paths, not payloads.
    const haystack = scanSurface(name, args, config.contentKeys).slice(0, 8000);
    // A rule describes ONE executable operation, so it is matched statement by
    // statement. Two separate statements that each carry part of a destructive
    // shape are not that shape: a directory listing and a single-file removal
    // living in the same script were reported as one recursive forced delete,
    // which denied this bundle's own release command. Pipelines stay intact —
    // `|` chains one operation, and the download-into-a-shell rule needs that.
    const statements = haystack
      .split(/;|&&|\|\||\\n/)
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    for (const rule of config.rules) {
      const matched = statements.some((statement) => {
        rule.regexp.lastIndex = 0;
        if (!rule.regexp.test(statement)) return false;
        if (rule.targetRegexp === null) return true;
        rule.targetRegexp.lastIndex = 0;
        return rule.targetRegexp.test(statement);
      });
      if (!matched) continue;
      labels.push(rule.label);
      risk = Math.max(risk, rule.risk);
      cost = Math.max(cost, rule.cost);
      if (rule.gear !== null) gear = Math.max(gear, rule.gear);
    }
  }

  return { gear, risk, cost, gain: base.gain, labels, known };
}

/**
 * Build the deployed utility function.
 *
 * `U(s, a) = task * gain(a) + safety * (1 - risk(a)) - cost * cost(a)`
 *
 * It is a pure function of the classified action, so a throwing utility — the
 * SDK's fail-closed `gate_error` path — is structurally unreachable here while
 * remaining fully implemented in the gate itself.
 * @param weights - the resolved weights.
 * @returns the utility function.
 */
export function buildUtility(weights) {
  return function utility(_state, action) {
    const attrs = action.attrs;
    return weights.task * attrs.gain
      + weights.safety * (1 - attrs.risk)
      - weights.cost * attrs.cost;
  };
}
