/**
 * Entropy Guard — the entropy-sdk safety control layer as a DeepSeek Harness
 * plugin.
 *
 * `entropy-sdk` (https://github.com/CYD-PRC/entropy-sdk, MIT — the embeddable
 * distillation of the EntropyRuntime paper, arXiv:2607.00334) makes an agent's
 * degree of autonomy observable, governable, and accountable. This bundle binds
 * that control layer to the Harness tool registry:
 *
 * - **Every tool call is one control cycle.** The call is classified onto the
 *   five-level gear ladder G0–G4 and scored by an injected utility
 *   `U = task·gain + safety·(1 − risk) − cost·cost`.
 * - **The gate is the sole dispatch channel.** A denial is returned from
 *   `ctx.tools.guard()`, a monotonic registry veto no other plugin can turn back
 *   into an admission, so a denied call never executes.
 * - **Autonomy is earned and revocable.** sigma rises on a refused or failed
 *   cycle and falls on clean ones; the ladder climbs one level per `patience`
 *   clean cycles below `sigmaLow` and drops on instability.
 *   `maxConsecutiveRejections` consecutive refusals suspend the session at G0
 *   pending human review.
 * - **The audit chain is a first-class output.** Every decision, gear
 *   transition, execution and suspension is appended to JSONL, and
 *   `/entropy export` turns it into the paper's empirical readings.
 *
 * Deliberate, documented, configurable choices distinguish this binding from a
 * literal transcription of the Python SDK:
 *
 * 1. `enforcement: 'observe'` is available and is the recommended first install:
 *    the same decisions are computed, audited and reported, but nothing is
 *    denied. `/entropy export` then reports what the policy *would* have done.
 * 2. `fallback.maxAlternatives` defaults to 0 (fallback off — an explicitly
 *    legal SDK configuration since v0.1.2). The Harness cannot rewrite a pending
 *    tool call into a different one, so there is nowhere for a proposer's
 *    alternative to be dispatched; the denial reason itself is the feedback the
 *    agent acts on next turn, exactly as the SDK's own framework adapters
 *    document.
 * 3. `fallback.countGearDenials` defaults to false, so the suspension endpoint
 *    tracks *refused actions* rather than the ladder's own refusals — otherwise
 *    an agent working below its gear would suspend itself by continuing to call
 *    the tools its job needs.
 * 4. `suspendedBehavior` defaults to `observe-only`, keeping G0 read-only tools
 *    available during a suspension (the paper's Theorem 4 recovery path) instead
 *    of the SDK's `suspended_skip`, which would leave an embedded agent unable
 *    to read its own audit chain. Set `deny-all` for SDK-exact behavior.
 *
 * @module dsh-entropy-guard
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveConfig } from './lib/config.js';
import { EntropyController } from './lib/controller.js';
import { GEAR_LABELS, gearLabel } from './lib/core.js';

/** Loader-facing display name for this plugin row. */
export const name = 'entropy-guard';

/** Hard dependency: the plugin is inert without a tool registry. */
export const inject = ['tools'];

/**
 * @param rawConfig - the row's `config` from `cordis.patch.yml`.
 * @returns a validated, fully-defaulted policy.
 */
export { resolveConfig };

/**
 * Resolve the audit-chain directory.
 *
 * `audit.dir` semantics: `null` (the default) means "one JSONL chain per agent
 * under `$DSH_HOME/entropy-guard`", an empty string disables the on-disk chain
 * (memory only), and any other string is used verbatim.
 * @param config - the resolved policy.
 * @returns the directory, or `null` for the in-memory ledger.
 */
function resolveAuditDir(config) {
  if (config.audit.dir === '') return null;
  if (typeof config.audit.dir === 'string' && config.audit.dir !== null) return config.audit.dir;
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'entropy-guard');
}

/**
 * Turn one agent id into a safe chain-file stem.
 * @param agentId - the session/agent id.
 * @returns the file stem.
 */
function chainStem(agentId) {
  if (agentId === null) return 'process';
  return String(agentId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'agent';
}

/**
 * Shorten a session id for tabular output while keeping it distinguishable.
 * @param agentId - the session/agent id.
 * @returns the display form.
 */
function shortId(agentId) {
  if (agentId === null) return '(process)';
  const id = String(agentId);
  return id.length <= 18 ? id : `…${id.slice(-17)}`;
}

/**
 * Register the guard: one registry veto, one report tool, one human command, one
 * observability endpoint, and one per-agent runtime-context line.
 * @param ctx - the plugin's Cordis context.
 * @param rawConfig - the row's configuration.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  if (!config.enabled) return;

  const auditDir = resolveAuditDir(config);
  const reportDir = auditDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'entropy-guard');
  /** @type {Map<string, EntropyController>} */
  const controllers = new Map();

  /**
   * Resolve (and lazily create) the controller governing one agent. State is
   * per agent, so a subagent's autonomy is its own.
   * @param agent - the calling agent, when there is one.
   * @returns the controller.
   */
  const controllerFor = (agent) => {
    const id = agent?.id === undefined || agent?.id === null ? null : String(agent.id);
    const key = id ?? '';
    let controller = controllers.get(key);
    if (controller === undefined) {
      controller = new EntropyController({
        agentId: id,
        config,
        auditPath: auditDir === null ? null : join(auditDir, `${chainStem(id)}.jsonl`),
      });
      controllers.set(key, controller);
    }
    return controller;
  };

  /**
   * Fold per-tool decision counts across every governed agent.
   * @returns tool name to decision bucket.
   */
  const mergedPerTool = () => {
    const merged = {};
    for (const controller of controllers.values()) {
      for (const [tool, bucket] of Object.entries(controller.metrics().perTool)) {
        const current = merged[tool] ?? { decisions: 0, admitted: 0, denied: 0, maxGear: 0 };
        current.decisions += bucket.decisions;
        current.admitted += bucket.admitted;
        current.denied += bucket.denied;
        current.maxGear = Math.max(current.maxGear, bucket.maxGear);
        merged[tool] = current;
      }
    }
    return merged;
  };

  /**
   * Every governed agent's live state, with the fleet aggregate. G4 is defined
   * as system-level coordination, so the fleet's *weakest* gear — not its
   * strongest — is the level the composition can be trusted at.
   * @returns the fleet view.
   */
  const fleet = () => {
    const agents = [...controllers.values()].map((controller) => {
      const status = controller.status();
      return {
        agentId: status.agentId,
        label: shortId(status.agentId),
        gear: status.gear,
        gearLabel: gearLabel(status.gear),
        sigma: status.sigma,
        cleanStreak: status.cleanStreak,
        suspended: status.suspended,
        cycle: status.cycle,
        decisions: status.decisions,
        denied: status.denied,
        wouldDeny: status.wouldDeny,
        acceptance: status.gateAcceptanceRate,
      };
    }).sort((a, b) => a.gear - b.gear || String(a.agentId).localeCompare(String(b.agentId)));

    const decisions = agents.reduce((sum, agent) => sum + agent.decisions, 0);
    const admitted = agents.reduce((sum, agent) => sum + (agent.decisions - agent.denied), 0);
    return {
      generatedAt: new Date().toISOString(),
      enforcement: config.enforcement,
      count: agents.length,
      weakestGear: agents.length === 0 ? null : agents[0].gear,
      weakestGearLabel: agents.length === 0 ? null : agents[0].gearLabel,
      suspended: agents.filter((agent) => agent.suspended).length,
      wouldDeny: agents.reduce((sum, agent) => sum + agent.wouldDeny, 0),
      decisions,
      denied: decisions - admitted,
      acceptance: decisions === 0 ? null : admitted / decisions,
      agents,
    };
  };

  /**
   * Render the fleet view for a human command.
   * @returns the report text.
   */
  const fleetReport = () => {
    const view = fleet();
    const lines = [
      `Entropy fleet — ${view.count} governed agent${view.count === 1 ? '' : 's'} (enforcement: ${view.enforcement})`,
      `  weakest gear  ${view.weakestGearLabel ?? 'n/a'} (G0 Observe → G4 Integrate)`,
      `  suspended     ${view.suspended}`,
      `  acceptance    ${view.acceptance === null ? 'n/a' : view.acceptance.toFixed(4)} over ${view.decisions} decisions (${view.denied} denied, ${view.wouldDeny} would-deny)`,
      '',
      '  agent                gear  sigma  susp  cycles  decisions  denied',
    ];
    for (const agent of view.agents) {
      lines.push(
        `  ${agent.label.padEnd(20)} G${agent.gear}    ${String(agent.sigma).padEnd(6)} `
        + `${(agent.suspended ? 'yes' : 'no').padEnd(5)} ${String(agent.cycle).padEnd(7)} `
        + `${String(agent.decisions).padEnd(10)} ${agent.denied}`,
      );
    }
    return lines.join('\n');
  };

  // Prime the process-level controller so an agentless call is governed from the
  // first call rather than only after some agent has run.
  controllerFor(undefined);

  ctx.effect(function* registerGuard() {
    yield ctx.tools.guard((exec) => controllerFor(exec.agent).guard(exec));

    // Settle the cycle when the registry publishes the frozen final outcome.
    // A call our guard admitted but another layer denied arrives here as an
    // error result, which correctly counts as an unresolved cycle.
    yield ctx.on('tools/result', (exec, result) => {
      controllerFor(exec.agent).settle(String(exec.callId ?? ''), result?.isError === true);
    });

    // Per-agent state is dropped with the agent so a long-lived Host does not
    // accumulate governors for retired sessions.
    yield ctx.on('agent/disposed', ({ agent }) => {
      const key = agent?.id === undefined ? '' : String(agent.id);
      const controller = controllers.get(key);
      if (controller === undefined) return;
      controller.sweep();
      controllers.delete(key);
    });

    yield ctx.tools.register({
      name: 'entropy_status',
      description:
        'Report the Entropy guard state for this session: gear level (G0 Observe -> G4 Integrate), '
        + 'sigma, clean-cycle streak, consecutive rejections, suspension, enforcement mode, gate '
        + 'acceptance rate, gear transition histogram, and the most recent decisions. Read-only, and '
        + 'exempt from the guard itself, so it answers even while side-effecting tools are suspended.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: [
            'gear', 'gearLabel', 'sigma', 'cycle', 'cleanStreak', 'consecutiveRejections',
            'suspended', 'enforcement', 'acceptance', 'denied', 'wouldDeny', 'auditPath', 'report',
          ],
          properties: {
            gear: { type: 'integer' },
            gearLabel: { type: 'string' },
            sigma: { type: 'number' },
            cycle: { type: 'integer' },
            cleanStreak: { type: 'integer' },
            consecutiveRejections: { type: 'integer' },
            suspended: { type: 'boolean' },
            enforcement: { type: 'string' },
            acceptance: { type: 'string' },
            denied: { type: 'integer' },
            wouldDeny: { type: 'integer' },
            auditPath: { type: 'string' },
            report: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: String(value.report) }],
      },
      execute(_args, exec) {
        const controller = controllerFor(exec.agent);
        const status = controller.status();
        return Promise.resolve({
          gear: status.gear,
          gearLabel: gearLabel(status.gear),
          sigma: status.sigma,
          cycle: status.cycle,
          cleanStreak: status.cleanStreak,
          consecutiveRejections: status.consecutiveRejections,
          suspended: status.suspended,
          enforcement: status.enforcement,
          acceptance: status.gateAcceptanceRate === null ? 'n/a' : status.gateAcceptanceRate.toFixed(4),
          denied: status.denied,
          wouldDeny: status.wouldDeny,
          auditPath: status.auditPath ?? '(memory only)',
          report: controller.report(),
        });
      },
      presentCall: () => ({ card: 'generic', title: 'Entropy guard status', kind: 'other' }),
    });
  }, 'entropy-guard: registrations');

  if (config.humanCommands) {
    ctx.inject(['commands'], (scope) => {
      scope.commands.register({
        name: 'entropy',
        description: 'Inspect or steer the Entropy guard (autonomy gear, sigma, audit chain, fleet)',
        input: { hint: 'status | fleet | export [dir] | seal [note] | resume | gear <0-4> | reset' },
        recordInput: false,
        handler: (invocation) => {
          const controller = controllerFor(invocation.agent);
          const [subcommand = 'status', argument] = invocation.rawInput.trim().split(/\s+/, 2);
          switch (subcommand.toLowerCase()) {
            case '':
            case 'status':
              return { kind: 'success', text: controller.report() };
            case 'fleet':
              return { kind: 'success', text: fleetReport() };
            case 'export': {
              try {
                const dir = argument !== undefined && argument.length > 0 ? argument : reportDir;
                mkdirSync(dir, { recursive: true });
                const stem = chainStem(controller.agentId);
                const jsonPath = join(dir, `entropy-report-${stem}.json`);
                const markdownPath = join(dir, `entropy-report-${stem}.md`);
                writeFileSync(jsonPath, `${JSON.stringify(controller.exportReport(), null, 2)}\n`, 'utf8');
                writeFileSync(markdownPath, controller.exportMarkdown(), 'utf8');
                return {
                  kind: 'success',
                  text: `Entropy guard export written:\n  ${jsonPath}\n  ${markdownPath}\n\n`
                    + controller.exportMarkdown(),
                };
              } catch (error) {
                return { kind: 'error', text: `Entropy guard export failed: ${error?.message ?? error}` };
              }
            }
            case 'resume':
              controller.resume();
              return {
                kind: 'success',
                text: `Entropy guard resumed at ${gearLabel(controller.runtime.state.gear)}. `
                  + 'sigma persists: gears must be re-earned through clean cycles.\n\n'
                  + controller.report(),
              };
            case 'gear': {
              const gear = Number(argument);
              if (!Number.isInteger(gear) || gear < 0 || gear > 4) {
                return { kind: 'error', text: `Usage: /entropy gear <0-4> (got ${JSON.stringify(argument ?? '')})` };
              }
              controller.setGear(gear);
              return {
                kind: 'success',
                text: `Entropy guard gear set to ${gearLabel(gear)} by human override; suspension cleared.\n\n`
                  + controller.report(),
              };
            }
            case 'reset':
              controller.reset();
              return { kind: 'success', text: `Entropy guard runtime reset.\n\n${controller.report()}` };
            case 'seal': {
              // Human-only by construction: a seal is an acknowledgement a person
              // makes, and a model cannot reach a command handler.
              const before = controller.runtime.audit.seal(argument ?? '');
              const forks = before.forks - before.liveForks;
              const interleaved = before.interleaved - before.liveInterleaved;
              return {
                kind: 'success',
                text: `Entropy guard chain sealed: ${forks} fork${forks === 1 ? '' : 's'} and `
                  + `${interleaved} interleaved entr${interleaved === 1 ? 'y' : 'ies'} acknowledged as history. `
                  + 'No tamper finding is ever sealed away.\n\n'
                  + controller.report(),
              };
            }
            default:
              return {
                kind: 'error',
                text: `Unknown subcommand ${JSON.stringify(subcommand)}. `
                  + 'Usage: /entropy status | fleet | export [dir] | seal [note] | resume | gear <0-4> | reset',
              };
          }
        },
      });
    });
  }

  if (config.promptContext) {
    ctx.inject(['systemPrompt'], (scope) => {
      const sandboxOrder = scope.systemPrompt.getContextOrder?.('SANDBOX_POLICY');
      scope.systemPrompt.context({
        name: 'entropy:guard',
        // Sit directly beside the other runtime policy line; fall back to a fixed
        // order if the named placement is unavailable in this composition.
        order: Number.isFinite(sandboxOrder) ? sandboxOrder + 1 : 60,
        text: (context) => controllerFor(context.agent).promptLine(),
      });
    });
  }

  if (config.ui.dock || config.ui.settings) {
    // The Client half polls this read-only endpoint: a plain same-origin JSON
    // route on the browser carrier the page already talks to, so the UI needs no
    // client-package import, RPC registration, or session projection.
    ctx.inject(['webServer'], (scope) => {
      scope.webServer.register({
        kind: 'exact',
        path: '/entropy/state',
        handler: (req, res) => {
          // Read-only by construction: the Client can observe the guard, never
          // steer it. Anything but a safe method is refused rather than ignored,
          // so no write path exists from the page into the governor — a UI that
          // could change the guard would be one more self-referential hole.
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
            res.end('entropy-guard: /entropy/state is read-only\n');
            return;
          }
          const url = new URL(req.url ?? '/entropy/state', 'http://localhost');
          const wanted = url.searchParams.get('agent');
          const body = wanted !== null && controllers.has(wanted)
            ? { ...controllerFor({ id: wanted }).exportReport(), fleet: fleet() }
            : { ...fleet(), perTool: mergedPerTool() };
          const payload = JSON.stringify(body);
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(payload),
          });
          res.end(payload);
        },
      });
    });
  }

  ctx.logger?.info?.(
    `entropy-guard active (${config.enforcement}): ladder ${GEAR_LABELS.join(' -> ')}, `
    + `theta=${config.theta}, audit=${auditDir ?? '(memory only)'}`,
  );
}
