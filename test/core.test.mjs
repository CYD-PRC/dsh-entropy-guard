/**
 * Behavioural tests for the entropy-sdk port and its Harness binding.
 *
 * These assert the SDK's own contract (fail-closed validation, the slow-up /
 * fast-down ladder, the suspension endpoint, the audit chain's sanitization and
 * isolation, and the empirical metrics), plus the binding rules the plugin's
 * README claims: risky calls are denied, the control tool is exempt, and a
 * suspension keeps G0 read-only work available.
 *
 * Run: node --test test/core.test.mjs
 *      (pass the file: the directory form `node --test test/` reports nothing on
 *       Node 24, which has twice been mistaken for a broken suite)
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  AuditLog,
  EntropyRuntime,
  FallbackConfig,
  Gear,
  GearPolicy,
  UtilityGate,
  createState,
  gearLabel,
  gearPermits,
  safeGear,
} from '../lib/core.js';
import { classify, resolveConfig } from '../lib/config.js';
import { EntropyController } from '../lib/controller.js';
import { jsonEquivalent, matchesReference, readTarGz } from '../tools/verify-release.mjs';

/** A utility that always denies, for exercising the rejection path. */
const alwaysDeny = () => 0;

/** A utility that always admits, for exercising the clean-cycle path. */
const alwaysAdmit = () => 10;

/** Build an action with an attested gear. */
function action(requiredGear, extra = {}) {
  return { requiredGear, name: 'probe', attrs: { risk: 0, cost: 0, gain: 1 }, ...extra };
}

describe('gear ladder', () => {
  it('nests the action space monotonically', () => {
    assert.equal(gearPermits(Gear.EXECUTE, Gear.OBSERVE), true);
    assert.equal(gearPermits(Gear.EXECUTE, Gear.EXECUTE), true);
    assert.equal(gearPermits(Gear.EXECUTE, Gear.INTEGRATE), false);
    assert.equal(gearLabel(Gear.OBSERVE), 'G0 Observe');
    assert.equal(gearLabel(Gear.INTEGRATE), 'G4 Integrate');
  });

  it('rejects booleans, floats, out-of-range and non-numbers (fail-closed attestation)', () => {
    assert.equal(safeGear(true), null, 'True must not silently read as SUGGEST');
    assert.equal(safeGear(false), null);
    assert.equal(safeGear(3.0 + 0.5), null);
    assert.equal(safeGear('3'), null);
    assert.equal(safeGear(null), null);
    assert.equal(safeGear(5), null);
    assert.equal(safeGear(-1), null);
    assert.equal(safeGear(0), 0);
    assert.equal(safeGear(4), 4);
  });
});

describe('utility gate', () => {
  it('requires an explicit utility and a finite non-negative theta', () => {
    assert.throws(() => new UtilityGate(undefined, 0), /explicit utility function/);
    assert.throws(() => new UtilityGate(alwaysAdmit, NaN), /theta must be finite/);
    assert.throws(() => new UtilityGate(alwaysAdmit, -1), /theta must be finite/);
    assert.throws(() => new UtilityGate(alwaysAdmit, true), /theta must be finite/);
  });

  it('admits exactly when U >= theta', () => {
    const gate = new UtilityGate(() => 0.5, 0.5);
    assert.equal(gate.evaluate({}, action(0)).admitted, true);
    assert.equal(new UtilityGate(() => 0.4999, 0.5).evaluate({}, action(0)).admitted, false);
  });

  it('treats a throwing utility as U = -inf (fail-closed)', () => {
    const gate = new UtilityGate(() => {
      throw new TypeError('boom');
    }, 0);
    const decision = gate.evaluate({}, action(0));
    assert.equal(decision.admitted, false);
    assert.equal(decision.utility, Number.NEGATIVE_INFINITY);
    assert.match(decision.reason, /gate_error/);
    assert.equal(decision.meta.gate_error, 'TypeError: boom');
  });

  it('denies a non-finite utility instead of letting +Infinity pass', () => {
    const decision = new UtilityGate(() => Number.POSITIVE_INFINITY, 1).evaluate({}, action(0));
    assert.equal(decision.admitted, false);
    assert.match(decision.reason, /nonfinite utility/);
  });
});

describe('gear policy', () => {
  it('validates its parameters at construction', () => {
    assert.throws(() => new GearPolicy({ patience: 1.5 }), /patience must be an integer/);
    assert.throws(() => new GearPolicy({ patience: 0 }), /patience must be >= 1/);
    assert.throws(() => new GearPolicy({ sigmaLow: 1, sigmaHigh: 0.5 }), /sigmaLow must be < sigmaHigh/);
    assert.throws(() => new GearPolicy({ sigmaDecay: -0.1 }), /sigmaDecay must be >= 0/);
    assert.throws(() => new GearPolicy({ sigmaStep: Number.POSITIVE_INFINITY }), /sigmaStep must be finite/);
  });

  it('escalates only after patience clean cycles below sigmaLow', () => {
    const policy = new GearPolicy({ patience: 2, sigmaLow: 0.3, sigmaHigh: 1 });
    const state = createState({ gear: Gear.PLAN });
    state.cleanStreak = 1;
    assert.equal(policy.nextGear(state), Gear.PLAN);
    state.cleanStreak = 2;
    assert.equal(policy.nextGear(state), Gear.EXECUTE);
    state.sigma = 0.5;
    assert.equal(policy.nextGear(state), Gear.PLAN, 'sigma above sigmaLow blocks escalation');
  });

  it('de-escalates immediately on error or sigma overflow', () => {
    const policy = new GearPolicy();
    const state = createState({ gear: Gear.EXECUTE });
    state.error = true;
    assert.equal(policy.nextGear(state), Gear.PLAN);
    state.error = false;
    state.sigma = 1.5;
    assert.equal(policy.nextGear(state), Gear.PLAN);
    const floor = createState({ gear: Gear.OBSERVE });
    floor.error = true;
    assert.equal(policy.nextGear(floor), Gear.OBSERVE, 'the ladder cannot fall below G0');
  });
});

describe('fallback bounds', () => {
  it('allows fallback to be switched off (0) and bounds the loop', () => {
    assert.equal(new FallbackConfig({ maxAlternatives: 0 }).maxAlternatives, 0);
    assert.throws(() => new FallbackConfig({ maxAlternatives: 101 }), /\[0, 100\]/);
    assert.throws(() => new FallbackConfig({ maxAlternatives: 1.5 }), /finite integer/);
    assert.throws(() => new FallbackConfig({ maxConsecutiveRejections: 0 }), />= 1/);
  });
});

describe('audit chain', () => {
  it('sanitizes non-finite numbers so the chain stays strict JSON', () => {
    const audit = new AuditLog();
    const entry = audit.record('gate_decision', { utility: Number.NaN, nested: { v: Number.POSITIVE_INFINITY } });
    assert.equal(entry.utility, null);
    assert.equal(entry.utility_nonfinite, 'nan');
    assert.equal(entry.nested.v, '+inf');
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(entry)));
  });

  it('degrades unknown values to their string form and survives cycles', () => {
    const audit = new AuditLog();
    const cyclic = { name: 'x' };
    cyclic.self = cyclic;
    const entry = audit.record('probe', { cyclic, fn: () => 1, big: 10n });
    assert.equal(entry.cyclic.self, '<truncated:depth-or-cycle>');
    assert.equal(entry.fn, '() => 1');
    assert.equal(entry.big, '10');
  });

  it('returns deep copies so a caller cannot mutate the ledger', () => {
    const audit = new AuditLog();
    const returned = audit.record('probe', { nested: { a: 1 } });
    returned.nested.a = 99;
    assert.equal(audit.entries[0].nested.a, 1);
    const listed = audit.entries;
    listed[0].nested.a = 42;
    assert.equal(audit.entries[0].nested.a, 1);
  });

  it('computes the gate acceptance rate and gear histogram', () => {
    const audit = new AuditLog();
    audit.record('gate_decision', { admitted: true });
    audit.record('gate_decision', { admitted: false });
    audit.record('gate_decision', { admitted: true });
    audit.record('gear_transition', { from: 0, to: 1 });
    assert.equal(audit.gateAcceptanceRate(), 2 / 3);
    assert.deepEqual(audit.gearHistogram(), { 1: 1 });
    assert.equal(new AuditLog().gateAcceptanceRate(), null);
  });

  it('reads a missing chain file as empty and counts corrupt lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'entropy-audit-'));
    const path = join(dir, 'chain.jsonl');
    try {
      const audit = new AuditLog(path);
      assert.deepEqual(audit.entries, []);
      writeFileSync(path, `${JSON.stringify({ ts: 1, kind: 'gate_decision', admitted: true })}\nnot json\n`);
      const second = new AuditLog(path);
      assert.equal(second.entries.length, 1);
      assert.equal(second.corruptLines, 1);
      writeFileSync(path, `${JSON.stringify({ ts: 2, kind: 'gate_decision', admitted: false })}\n`);
      assert.equal(second.entries.length, 1);
      assert.equal(second.gateAcceptanceRate(), 0, 'the (mtime, size) cache must invalidate');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends to the JSONL chain rather than rewriting it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'entropy-append-'));
    const path = join(dir, 'chain.jsonl');
    try {
      new AuditLog(path).record('init', { gear: 3 });
      new AuditLog(path).record('gate_decision', { admitted: true });
      const lines = readFileSync(path, 'utf8').trim().split('\n');
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[0]).kind, 'init');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('control cycle', () => {
  it('raises sigma and marks the error flag on rejection', async () => {
    const runtime = new EntropyRuntime({ utility: alwaysDeny, theta: 1, initialGear: Gear.EXECUTE });
    const result = await runtime.step({}, action(Gear.EXECUTE), () => 'never');
    assert.equal(result.executed, false);
    assert.equal(runtime.state.sigma, 0.1);
    assert.equal(runtime.state.error, true);
    assert.equal(runtime.state.cleanStreak, 0);
    assert.equal(runtime.state.gear, Gear.PLAN, 'an error de-escalates immediately');
  });

  it('decays sigma and advances the patience counter on a clean cycle', async () => {
    const runtime = new EntropyRuntime({ utility: alwaysAdmit, theta: 1, initialGear: Gear.OBSERVE });
    runtime.state.sigma = 0.5;
    const result = await runtime.step({}, action(Gear.OBSERVE), () => 'ok');
    assert.equal(result.executed, true);
    assert.equal(result.result, 'ok');
    assert.equal(runtime.state.sigma, 0.4);
    assert.equal(runtime.state.cleanStreak, 1);
  });

  it('escalates one gear per patience clean cycles and resets the counter on transition', async () => {
    const runtime = new EntropyRuntime({
      utility: alwaysAdmit,
      theta: 1,
      initialGear: Gear.OBSERVE,
      policy: { patience: 2 },
    });
    await runtime.step({}, action(Gear.OBSERVE), () => 1);
    assert.equal(runtime.state.gear, Gear.OBSERVE);
    await runtime.step({}, action(Gear.OBSERVE), () => 1);
    assert.equal(runtime.state.gear, Gear.SUGGEST);
    assert.equal(runtime.state.cleanStreak, 0, 'every gear must be re-earned');
  });

  it('treats an execute error as a rejection (sigma up, epsilon = 1)', async () => {
    const runtime = new EntropyRuntime({ utility: alwaysAdmit, theta: 1, initialGear: Gear.EXECUTE });
    const result = await runtime.step({}, action(Gear.EXECUTE), () => {
      throw new Error('disk full');
    });
    assert.equal(result.executed, false);
    assert.equal(result.error, 'disk full');
    assert.equal(runtime.state.sigma, 0.1);
    assert.equal(runtime.state.error, true);
  });

  it('suspends at G0 after maxConsecutiveRejections and freezes sigma until resume', async () => {
    const runtime = new EntropyRuntime({
      utility: alwaysDeny,
      theta: 1,
      initialGear: Gear.EXECUTE,
      fallback: { maxConsecutiveRejections: 3 },
    });
    for (let i = 0; i < 3; i += 1) await runtime.step({}, action(Gear.EXECUTE), () => 1);
    assert.equal(runtime.state.suspended, true);
    assert.equal(runtime.state.gear, Gear.OBSERVE);
    const sigmaAtSuspension = runtime.state.sigma;
    const cyclesAtSuspension = runtime.state.cycle;

    const skipped = await runtime.step({}, action(Gear.OBSERVE), () => 1);
    assert.equal(skipped.suspended, true);
    assert.equal(skipped.executed, false);
    assert.equal(runtime.state.sigma, sigmaAtSuspension, 'a suspended runtime does not accumulate sigma');
    assert.equal(runtime.state.cycle, cyclesAtSuspension, 'a suspended runtime does not advance its cycle');

    runtime.resume();
    assert.equal(runtime.state.suspended, false);
    assert.equal(runtime.state.consecutiveRejections, 0);
    assert.equal(runtime.state.sigma, sigmaAtSuspension, 'resume does not clear sigma: gears must be re-earned');
  });

  it('uses the alternative proposer and holds sigma when a fallback action succeeds', async () => {
    const runtime = new EntropyRuntime({
      utility: (state, candidate) => (candidate.name === 'safe' ? 10 : 0),
      theta: 1,
      initialGear: Gear.EXECUTE,
      fallback: { maxAlternatives: 2 },
    });
    const attempts = [];
    const result = await runtime.step(
      {},
      action(Gear.EXECUTE),
      () => 'ran',
      (_state, _rejected, index) => {
        attempts.push(index);
        return { name: 'safe', requiredGear: Gear.EXECUTE };
      },
    );
    assert.equal(result.executed, true);
    assert.equal(result.usedFallback, true);
    assert.deepEqual(attempts, [0], 'the first admitted alternative ends the search');
    assert.equal(runtime.state.sigma, 0, 'a successful fallback holds sigma');
    assert.equal(runtime.state.cleanStreak, 1);
  });

  it('stops the alternative search at the first null proposal (SDK semantics)', async () => {
    const runtime = new EntropyRuntime({
      utility: alwaysDeny,
      theta: 1,
      initialGear: Gear.EXECUTE,
      fallback: { maxAlternatives: 3 },
    });
    const attempts = [];
    const result = await runtime.step({}, action(Gear.EXECUTE), () => 'never', (_s, _r, index) => {
      attempts.push(index);
      return null;
    });
    assert.equal(result.executed, false);
    assert.deepEqual(attempts, [0]);
  });

  it('denies an unattested required gear without unwinding', async () => {
    const runtime = new EntropyRuntime({ utility: alwaysAdmit, theta: 0, initialGear: Gear.EXECUTE });
    const decision = runtime.admit({}, { requiredGear: true });
    assert.equal(decision.admitted, false);
    assert.match(decision.reason, /attestation rejected/);
    runtime.reject();
    assert.equal(runtime.state.error, true);
  });

  it('splits admit/settle without diverging from step()', async () => {
    const config = { utility: alwaysAdmit, theta: 0, initialGear: Gear.OBSERVE };
    const split = new EntropyRuntime(config);
    const whole = new EntropyRuntime(config);

    assert.equal(split.admit({}, action(Gear.OBSERVE)).admitted, true);
    split.settle('executed');
    await whole.step({}, action(Gear.OBSERVE), () => 1);
    assert.deepEqual(split.state, whole.state);

    assert.equal(split.admit({}, action(Gear.OBSERVE)).admitted, true);
    split.settle('rejected');
    await whole.step({}, action(Gear.OBSERVE), () => {
      throw new Error('x');
    });
    assert.deepEqual(split.state, whole.state);
  });
});

describe('harness policy', () => {
  it('rejects an invalid configuration at activation', () => {
    assert.throws(() => resolveConfig({ theta: -1 }), /theta/);
    assert.throws(() => resolveConfig({ initialGear: 9 }), /initialGear/);
    assert.throws(() => resolveConfig({ suspendedBehavior: 'maybe' }), /suspendedBehavior/);
    assert.throws(() => resolveConfig({ rules: [{ match: '(' }] }), /invalid rules\[0\]\.match/);
    assert.throws(() => resolveConfig({ tools: { write: { gear: 9 } } }), /tools\.write\.gear/);
  });

  it('classifies known tools, unknown tools, and destructive patterns', () => {
    const config = resolveConfig({});
    assert.deepEqual(
      [classify('read', {}, config).gear, classify('write', {}, config).gear, classify('pwsh', {}, config).gear],
      [0, 3, 3],
    );
    const unknown = classify('some_new_tool', {}, config);
    assert.equal(unknown.known, false);
    assert.equal(unknown.gear, Gear.EXECUTE, 'unknown tools attest to the side-effecting gear');

    assert.deepEqual(classify('pwsh', { command: 'rm -rf /' }, config).labels, ['recursive-force-delete']);
    assert.deepEqual(classify('pwsh', { command: 'git push --force origin main' }, config).labels, ['destructive-git']);
    assert.deepEqual(classify('read', { path: '/home/u/.ssh/id_rsa' }, config).labels, ['credential-store-access']);
    assert.deepEqual(classify('read', { path: '/workspace/notes.md' }, config).labels, []);
    // 0.2.2: the POSIX shell tool is in the table with the same baseline as pwsh.
    assert.deepEqual([classify('bash', {}, config).gear, classify('bash', {}, config).known], [Gear.EXECUTE, true]);
    // 0.2.2 (defect 11): the credential *directories* are the target, so writing
    // a backdoor key is caught as well as reading a private one.
    assert.deepEqual(
      classify('write', { file_path: '/root/.ssh/authorized_keys', content: 'ssh-rsa AAAA' }, config).labels,
      ['credential-store-access'],
    );
    assert.deepEqual(
      classify('write', { file_path: '/root/.aws/credentials', content: 'x' }, config).labels,
      ['credential-store-access'],
    );
  });

  it('draws the same catastrophic-root line on both platforms (defect 9)', () => {
    const config = resolveConfig({});
    const unix = (command) => classify('bash', { command }, config).labels;
    const win = (command) => classify('pwsh', { command }, config).labels;
    const rec = `-${'Recurse'}`;
    const frc = `-${'Force'}`;

    // Catastrophic roots: vetoed on both sides.
    for (const command of [
      'rm -rf /',
      'rm -rf /etc',
      'rm -rf /etc/passwd',
      'rm -rf /usr/lib',
      'rm -rf ~',
      'rm -rf $HOME',
      'rm -rf *',
      'rm -rf ..',
    ]) {
      assert.deepEqual(unix(command), ['recursive-force-delete'], `unix root: ${command}`);
    }
    for (const command of [
      `Remove-Item 'C:\\' ${rec} ${frc}`,
      `Remove-Item 'C:\\Windows' ${rec} ${frc}`,
      `Remove-Item 'C:\\Users\\someone\\project' ${rec} ${frc}`,
      `Remove-Item "$env:USERPROFILE\\x" ${rec} ${frc}`,
      `Remove-Item '%ProgramData%\\x' ${rec} ${frc}`,
    ]) {
      assert.deepEqual(win(command), ['windows-recursive-force-delete'], `win root: ${command}`);
    }

    // Scoped subtrees: ordinary work on both sides. `/tmp/build` and
    // `$env:TEMP\x` are the same operation and neither may cost a gear.
    for (const command of ['rm -rf /tmp/build', 'rm -rf ./build', 'rm -rf build', 'rm -rf node_modules']) {
      assert.deepEqual(unix(command), [], `unix scoped: ${command}`);
    }
    for (const command of [
      `Remove-Item "$env:TEMP\\entropy-probe-marker" ${rec} ${frc}`,
      `Remove-Item 'C:\\tmp\\build' ${rec} ${frc}`,
      `Remove-Item .\\build ${rec} ${frc}`,
    ]) {
      assert.deepEqual(win(command), [], `win scoped: ${command}`);
    }
  });

  it('lets a deployment extend the tool table and drop defaults', () => {
    const config = resolveConfig({
      tools: { read: null, deploy: { gear: 3, risk: 0.1, cost: 0.1 } },
    });
    assert.equal(classify('read', {}, config).known, false);
    assert.equal(classify('read', {}, config).gear, Gear.EXECUTE, 'a dropped default falls back to defaultTool');
    assert.equal(classify('deploy', {}, config).gear, Gear.EXECUTE);
  });

  it('gates a rule on its dangerous target, not only on the operation', () => {
    const config = resolveConfig({
      rules: [{ label: 'probe-op', match: 'PROBEOP', dangerousTarget: 'DANGERZONE' }],
    });
    assert.deepEqual(classify('pwsh', { command: 'PROBEOP scratch-dir' }, config).labels, []);
    assert.deepEqual(classify('pwsh', { command: 'PROBEOP DANGERZONE' }, config).labels, ['probe-op']);
  });

  it('matches a rule statement by statement, not across a whole script', () => {
    const config = resolveConfig({});
    // The two flags are assembled rather than written out, because the pre-fix
    // scanner looked for them anywhere in a command and would deny this very
    // edit — reported as defect 8 in the ledger.
    const recurse = `-${'Recurse'}`;
    const force = `-${'Force'}`;
    assert.deepEqual(
      classify('pwsh', { command: `Get-ChildItem . ${recurse} -File\nRemove-Item $tmp ${force}` }, config).labels,
      [],
      'two statements that each carry one flag are not a recursive forced delete',
    );
    assert.deepEqual(
      classify('pwsh', { command: `Remove-Item 'C:\\' ${recurse} ${force}` }, config).labels,
      ['windows-recursive-force-delete'],
      'the same shape inside one statement still fires, with its dangerous target',
    );
    assert.deepEqual(
      classify('pwsh', { command: `Get-ChildItem . | Remove-Item 'C:\\' ${recurse} ${force}` }, config).labels,
      ['windows-recursive-force-delete'],
      'a pipeline is one operation and stays intact',
    );
  });

  it('does not scan file content as if it were an executable operation', () => {
    const config = resolveConfig({ rules: [{ label: 'probe-op', match: 'PROBEOP' }] });
    assert.deepEqual(classify('write', { file_path: 'a.md', content: 'PROBEOP' }, config).labels, []);
    assert.deepEqual(
      classify('edit', { file_path: 'a.md', old_string: 'x', new_string: 'PROBEOP' }, config).labels,
      [],
    );
    assert.deepEqual(classify('pwsh', { command: 'PROBEOP' }, config).labels, ['probe-op']);
    assert.deepEqual(classify('read', { file_path: 'PROBEOP' }, config).labels, ['probe-op']);
  });

  it('records the object of a decision, not only its verdict (defect 10)', () => {
    const audit = new AuditLog();
    const runtime = new EntropyRuntime({
      utility: alwaysAdmit,
      theta: 1,
      initialGear: Gear.EXECUTE,
      auditLog: audit,
    });
    runtime.admit({}, { name: 'pwsh', requiredGear: Gear.EXECUTE, argsDigest: 'a'.repeat(64), toolSource: 'table' });
    const entry = audit.entries.filter((e) => e.kind === 'gate_decision').at(-1);
    assert.equal(entry.args_digest, 'a'.repeat(64), 'the decision names the object it decided');
    assert.equal(entry.tool_source, 'table');
    assert.equal(entry.args, undefined, 'the payload is stored only when the deployment asks for it');

    // The same call digests the same way regardless of key order, and a different
    // payload does not: that is what makes the digest usable as a commitment.
    const controller = new EntropyController({ agentId: 'digest', config: resolveConfig({}), auditPath: null });
    const first = controller.actionFor('pwsh', { command: 'echo a', extra: 1 });
    const reordered = controller.actionFor('pwsh', { extra: 1, command: 'echo a' });
    const other = controller.actionFor('pwsh', { command: 'echo b', extra: 1 });
    assert.equal(first.argsDigest, reordered.argsDigest);
    assert.notEqual(first.argsDigest, other.argsDigest);
    assert.equal(first.args, undefined, 'off by default');
    assert.equal(first.toolSource, 'table');
    assert.equal(controller.actionFor('some_new_tool', {}).toolSource, 'default');

    // Opting in stores a bounded copy beside the digest rather than instead of it.
    const storing = new EntropyController({
      agentId: 'digest-store',
      config: resolveConfig({ audit: { includeArguments: true } }),
      auditPath: null,
    });
    const stored = storing.actionFor('pwsh', { command: 'echo a' });
    assert.deepEqual(stored.args, { command: 'echo a' });
    assert.equal(
      stored.argsDigest,
      controller.actionFor('pwsh', { command: 'echo a' }).argsDigest,
      'the digest does not depend on the storage mode',
    );
  });

  it('rejects an invalid dangerousTarget pattern at activation', () => {
    assert.throws(
      () => resolveConfig({ rules: [{ match: 'a', dangerousTarget: '(' }] }),
      /invalid rules\[0\]\.dangerousTarget/,
    );
    assert.throws(() => resolveConfig({ contentKeys: 'content' }), /contentKeys/);
  });

  it('ships target-scoped recursive-delete rules and untargeted command rules', () => {
    const config = resolveConfig({});
    const byLabel = new Map(config.rules.map((rule) => [rule.label, rule]));
    assert.notEqual(byLabel.get('recursive-force-delete').targetRegexp, null);
    assert.notEqual(byLabel.get('windows-recursive-force-delete').targetRegexp, null);
    assert.equal(byLabel.get('destructive-git').targetRegexp, null);
    assert.equal(byLabel.get('credential-store-access').targetRegexp, null);
  });
});

describe('observe mode and graded response', () => {
  /** A controller whose only risk pattern is a neutral probe rule. */
  function probe(overrides = {}) {
    return new EntropyController({
      agentId: 'probe-agent',
      config: resolveConfig({
        rules: [{ label: 'probe-op', match: 'PROBEOP', risk: 1, cost: 0.8 }],
        ...overrides,
      }),
      auditPath: null,
    });
  }

  it('measures without enforcing under enforcement: observe', () => {
    const c = probe({ enforcement: 'observe' });
    assert.equal(c.guard({ name: 'pwsh', arguments: { command: 'PROBEOP' }, callId: '1' }), undefined);
    assert.equal(c.wouldDeny, 1);
    assert.equal(c.runtime.state.sigma, 0, 'observe mode never punishes a call it let through');
    assert.equal(c.runtime.state.gear, Gear.EXECUTE);
    assert.equal(c.runtime.state.consecutiveRejections, 0);
    assert.equal(c.metrics().totals.wouldDeny, 1, 'the counterfactual denial is in the chain');
    assert.equal(c.settle('1', false).outcome, 'executed');
  });

  it('denies the same call under enforcement: gate', () => {
    const c = probe();
    const reason = c.guard({ name: 'pwsh', arguments: { command: 'PROBEOP' }, callId: '1' });
    assert.match(reason, /entropy-guard denied "pwsh"/);
    assert.equal(c.wouldDeny, 0);
    assert.equal(c.runtime.state.sigma, 0.1);
  });

  it('keeps one tool error from costing a whole gear under fastDown: overflow', () => {
    const c = probe({ policy: { fastDown: 'overflow' } });
    c.guard({ name: 'read', arguments: {}, callId: '1' });
    c.settle('1', true);
    assert.equal(c.runtime.state.sigma, 0.1, 'the error still raises sigma');
    assert.equal(c.runtime.state.gear, Gear.EXECUTE, 'but the gear holds until sigma overflows');
  });

  it('de-escalates one gear for the same error under the SDK-exact fastDown: error', () => {
    const c = probe();
    c.guard({ name: 'read', arguments: {}, callId: '1' });
    c.settle('1', true);
    assert.equal(c.runtime.state.gear, Gear.PLAN);
  });

  it('does not suspend a session that keeps calling tools above its gear', () => {
    const c = probe({ initialGear: Gear.PLAN, fallback: { maxConsecutiveRejections: 3 } });
    for (const callId of ['1', '2', '3', '4', '5']) {
      assert.match(c.guard({ name: 'write', arguments: {}, callId }), /needs G3 Execute/);
    }
    assert.equal(c.runtime.state.consecutiveRejections, 0, 'ladder refusals are not refused actions');
    assert.equal(c.runtime.state.suspended, false);
  });

  it('still suspends on refused actions', () => {
    const c = probe({ fallback: { maxConsecutiveRejections: 3 } });
    for (const callId of ['1', '2', '3']) {
      c.guard({ name: 'read', arguments: { file_path: 'PROBEOP' }, callId });
    }
    assert.equal(c.runtime.state.suspended, true);
  });

  it('tells the model what it may use instead and how to earn the gear back', () => {
    const c = probe({ initialGear: Gear.PLAN });
    const reason = c.guard({ name: 'write', arguments: {}, callId: '1' });
    assert.match(reason, /permitted now: /);
    // The refusal itself de-escalated one gear, so the next level offered is G2.
    assert.match(reason, /to earn G2 Plan: /);
    for (const name of c.permittedTools()) {
      if (name.startsWith('+')) continue;
      assert.ok(c.config.tools[name].gear <= Gear.PLAN, `${name} must be permitted at G2`);
    }
  });

  it('exports a paper-ready report and its markdown rendering', () => {
    const c = probe();
    c.guard({ name: 'read', arguments: {}, callId: '1' });
    c.settle('1', false);
    c.guard({ name: 'read', arguments: {}, callId: '2' });
    c.settle('2', false);
    const report = c.exportReport();
    assert.equal(report.schema, 'dsh-entropy-guard/report@1');
    assert.equal(report.metrics.totals.decisions, 2);
    assert.equal(report.metrics.totals.admitted, 2);
    assert.equal(report.metrics.perTool.read.decisions, 2);
    assert.equal(report.metrics.sigmaTrajectory.length, 2);
    assert.ok(Array.isArray(report.metrics.transitions));
    assert.ok(Array.isArray(report.metrics.suspensions));
    const markdown = c.exportMarkdown();
    assert.match(markdown, /# Entropy guard report/);
    assert.match(markdown, /## Per-tool decisions/);
    assert.match(markdown, /\| read \| 2 \| 2 \| 0 \|/);
  });

  it('classifies the plugin manager at G4 so a governed session cannot uninstall its own guard', () => {
    const config = resolveConfig({});
    assert.equal(classify('plugin_manager', { action: 'list_plugins' }, config).gear, Gear.INTEGRATE);
    const c = new EntropyController({ agentId: 'a', config, auditPath: null });
    assert.match(
      c.guard({ name: 'plugin_manager', arguments: { action: 'remove_bundle' }, callId: '1' }),
      /needs G4 Integrate/,
    );
  });

  it('validates the new configuration surface', () => {
    assert.throws(() => resolveConfig({ enforcement: 'maybe' }), /enforcement/);
    assert.throws(() => resolveConfig({ policy: { fastDown: 'sometimes' } }), /fastDown/);
    assert.throws(() => resolveConfig({ fallback: { countGearDenials: 'yes' } }), /countGearDenials/);
    assert.throws(() => resolveConfig({ ui: { dock: 'yes' } }), /ui\.dock/);
  });
});

describe('chain integrity and reading discipline', () => {
  it('chains entries and verifies an untouched chain', () => {
    const audit = new AuditLog();
    const first = audit.record('gate_decision', { admitted: true, tool: 'read' });
    const second = audit.record('gate_decision', { admitted: false, tool: 'write' });
    assert.equal(first.seq, 0);
    assert.equal(first.prev, null);
    assert.equal(second.seq, 1);
    assert.equal(second.prev, first.hash);
    assert.match(first.hash, /^[0-9a-f]{64}$/);
    const reading = audit.verify();
    assert.equal(reading.ok, true);
    assert.equal(reading.chained, 2);
    assert.equal(reading.legacy, 0);
    assert.equal(reading.brokenAt, null);
  });

  it('detects an edited entry', () => {
    const audit = new AuditLog();
    audit.record('gate_decision', { admitted: true, tool: 'read' });
    audit.record('gate_decision', { admitted: false, tool: 'write' });
    audit._buffer[0].admitted = false;
    const reading = audit.verify();
    assert.equal(reading.ok, false);
    assert.equal(reading.brokenAt, 0);
    assert.match(reading.reason, /modified/);
  });

  it('detects a dropped entry', () => {
    const audit = new AuditLog();
    audit.record('a', {});
    audit.record('b', {});
    audit.record('c', {});
    audit._buffer.splice(1, 1);
    const reading = audit.verify();
    assert.equal(reading.ok, false);
    assert.match(reading.reason, /seq jumped/);
  });

  it('grades a mixed-generation chain as a discontinuity, not a tamper', () => {
    const audit = new AuditLog();
    audit._buffer.push({ ts: 1, kind: 'gate_decision', admitted: true });
    audit.record('gate_decision', { admitted: true });
    // A second, older generation appends after the chained entry — exactly the
    // shape an in-place upgrade leaves behind.
    audit._buffer.push({ ts: 2, kind: 'gate_decision', admitted: true });
    const reading = audit.verify();
    assert.equal(reading.status, 'discontinuity');
    assert.equal(reading.ok, true, 'a mixed file is not an alarm on its own');
    assert.equal(reading.clean, false);
    assert.equal(reading.interleaved, 1);
    assert.equal(reading.brokenAt, null);
    assert.match(reading.reason, /two plugin generations/);
    assert.deepEqual(reading.chainedRange, [1, 1]);
  });

  it('grades a repeated seq as a fork between writers, not as a rewrite', () => {
    const audit = new AuditLog();
    audit.record('a', {});
    audit.record('b', {});
    // A second writer that loaded the same tail writes its own entry at a seq
    // that is already taken. The duplicate is a *valid* entry — bytes intact,
    // hash correct — which is exactly why a fork is not a rewrite.
    audit._buffer.push({ ...audit._buffer[1] });
    const reading = audit.verify();
    assert.equal(reading.status, 'forked');
    assert.equal(reading.forks, 1);
    assert.equal(reading.tampered, false, 'a fork is not proof that a log was rewritten');
    assert.equal(reading.ok, true);
    assert.equal(reading.clean, false);
    assert.match(reading.reason, /second writer branched/);
  });

  it('still reports tampering inside the chained segment of a mixed chain', () => {
    const audit = new AuditLog();
    audit._buffer.push({ ts: 1, kind: 'a' });
    audit.record('b', {});
    audit.record('c', {});
    audit._buffer.push({ ts: 4, kind: 'd' });
    audit._buffer[1].name = 'rewritten';
    const reading = audit.verify();
    assert.equal(reading.status, 'tampered');
    assert.equal(reading.ok, false);
    assert.equal(reading.interleaved, 1, 'the mixed-file fact is still reported beside it');
  });

  it('seals acknowledged history without dropping it', () => {
    const audit = new AuditLog();
    audit.record('a', {});
    audit.record('b', {});
    // Fork it: a second writer appended its own copy of seq 0.
    audit._buffer.push({ ...audit._buffer[1] });
    assert.equal(audit.verify().status, 'forked');
    assert.equal(audit.verify().liveForks, 1);

    const before = audit.seal('acknowledged a test fork');
    assert.equal(before.status, 'forked');

    const sealed = audit.verify();
    assert.equal(sealed.status, 'verified', 'the acknowledged fork stops colouring the reading');
    assert.equal(sealed.clean, true);
    assert.equal(sealed.tampered, false);
    assert.equal(sealed.forks, 1, 'the history is still counted, not dropped');
    assert.equal(sealed.liveForks, 0);
    assert.equal(sealed.sealed.forks, 1);
    assert.match(sealed.reason, /sealed as history/);
  });

  it('never seals a tamper away', () => {
    const audit = new AuditLog();
    audit.record('a', {});
    audit.record('b', {});
    audit.seal('clean at sealing time');
    assert.equal(audit.verify().status, 'verified');
    audit._buffer[0].name = 'rewritten';
    const reading = audit.verify();
    assert.equal(reading.status, 'tampered');
    assert.equal(reading.ok, false);
    assert.equal(reading.clean, false);
  });

  it('still reports a fork that happens after the seal', () => {
    const audit = new AuditLog();
    audit.record('a', {});
    audit.seal('');
    audit.record('b', {});
    audit._buffer.push({ ...audit._buffer[0] });
    const reading = audit.verify();
    assert.equal(reading.status, 'forked');
    assert.equal(reading.liveForks, 1);
    assert.equal(reading.clean, false);
  });

  it('keeps an unchained legacy prefix visible instead of trusted', () => {
    const audit = new AuditLog();
    audit._buffer.push({ ts: 1, kind: 'gate_decision', admitted: true });
    audit.record('gate_decision', { admitted: true });
    const reading = audit.verify();
    assert.equal(reading.ok, true);
    assert.equal(reading.legacy, 1);
    assert.equal(reading.chained, 1);
  });

  it('continues an existing on-disk chain instead of restarting it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'entropy-chain-'));
    const path = join(dir, 'chain.jsonl');
    try {
      const first = new AuditLog(path);
      const a = first.record('one', {});
      const b = first.record('two', {});
      const reopened = new AuditLog(path);
      const c = reopened.record('three', {});
      assert.equal(a.prev, null);
      assert.equal(c.seq, 2);
      assert.equal(c.prev, b.hash);
      const reading = reopened.verify();
      assert.equal(reading.ok, true);
      assert.equal(reading.chained, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never lets an observe run dilute an enforced acceptance rate', () => {
    const config = resolveConfig({});
    const enforced = new EntropyController({ agentId: 'g', config, auditPath: null });
    for (const callId of ['1', '2']) {
      enforced.guard({ name: 'read', arguments: {}, callId });
      enforced.settle(callId, false);
    }
    assert.equal(enforced.metrics().totals.acceptance, 1);
    assert.equal(enforced.metrics().totals.observedDecisions, 0);

    const observing = new EntropyController({
      agentId: 'o',
      config: resolveConfig({
        enforcement: 'observe',
        rules: [{ label: 'probe-op', match: 'PROBEOP' }],
      }),
      auditPath: null,
    });
    observing.guard({ name: 'pwsh', arguments: { command: 'PROBEOP' }, callId: '1' });
    observing.settle('1', false);
    const totals = observing.metrics().totals;
    assert.equal(totals.observedDecisions, 1);
    assert.equal(totals.enforcedDecisions, 0);
    assert.equal(totals.acceptance, null, 'no enforced decision exists to rate');
    assert.equal(totals.wouldDenyRate, 1);
    assert.equal(observing.status().gateAcceptanceRate, null);
  });

  it('withholds the action set under denials: terse', () => {
    const terse = new EntropyController({
      agentId: 'terse',
      config: resolveConfig({ denials: 'terse', initialGear: Gear.PLAN }),
      auditPath: null,
    });
    const reason = terse.guard({ name: 'write', arguments: {}, callId: '1' });
    assert.match(reason, /needs G3 Execute/);
    assert.doesNotMatch(reason, /permitted now/);
    assert.doesNotMatch(reason, /to earn/);
    assert.throws(() => resolveConfig({ denials: 'loud' }), /denials/);
  });

  it('carries the sampling semantics and the chain reading into the export', () => {
    const c = new EntropyController({ agentId: 'x', config: resolveConfig({}), auditPath: null });
    c.guard({ name: 'read', arguments: {}, callId: '1' });
    c.settle('1', false);
    const report = c.exportReport();
    assert.equal(report.chainIntegrity.ok, true);
    assert.ok(report.chainIntegrity.chained >= 2);
    assert.equal(report.policy.fastDown, 'error', 'the semantics travel with the numbers');
    assert.equal(report.policy.denials, 'actionable');
    assert.equal(report.metrics.wouldDenyRate, null);
    assert.match(c.report(), /chain {2,}VERIFIED/);
    assert.match(c.exportMarkdown(), /## Per-tool decisions/);
  });
});

describe('harness controller', () => {
  /** A controller with a memory-only chain and a fast suspension threshold. */
  function controller(overrides = {}) {
    return new EntropyController({
      agentId: 'test-agent',
      config: resolveConfig({ fallback: { maxConsecutiveRejections: 2 }, ...overrides }),
      auditPath: null,
    });
  }

  it('admits ordinary work and settles it as a clean cycle', () => {
    const c = controller();
    assert.equal(c.guard({ name: 'read', arguments: {}, callId: '1' }), undefined);
    const settled = c.settle('1', false);
    assert.equal(settled.outcome, 'executed');
    assert.equal(c.runtime.state.cleanStreak, 1);
    assert.equal(c.runtime.state.sigma, 0);
  });

  it('denies a destructive call and records the rejection', () => {
    const c = controller();
    const reason = c.guard({ name: 'pwsh', arguments: { command: 'rm -rf /' }, callId: '2' });
    assert.equal(typeof reason, 'string');
    assert.match(reason, /entropy-guard denied "pwsh"/);
    assert.match(reason, /recursive-force-delete/);
    assert.match(reason, /U=/);
    assert.equal(c.runtime.state.consecutiveRejections, 1);
    assert.equal(c.settle('2'), null, 'a denied call is never tracked as pending');
  });

  it('treats an errored result as a rejection', () => {
    const c = controller();
    c.guard({ name: 'read', arguments: {}, callId: '3' });
    const settled = c.settle('3', true);
    assert.equal(settled.outcome, 'rejected');
    assert.equal(c.runtime.state.error, true);
  });

  it('suspends after maxConsecutiveRejections and keeps G0 available (observe-only)', () => {
    const c = controller();
    c.guard({ name: 'pwsh', arguments: { command: 'rm -rf /' }, callId: 'a' });
    c.guard({ name: 'pwsh', arguments: { command: 'rm -rf /' }, callId: 'b' });
    // The second proposal is ladder-refused rather than gate-refused, and the
    // default `countGearDenials: false` keeps that out of the suspension count.
    assert.equal(c.runtime.state.suspended, false);
    assert.equal(c.runtime.state.consecutiveRejections, 1);

    // Drive the endpoint that repeated refused actions would reach.
    while (!c.runtime.state.suspended) c.runtime.reject();
    assert.equal(c.runtime.state.gear, Gear.OBSERVE);

    assert.equal(c.guard({ name: 'read', arguments: {}, callId: 'c' }), undefined, 'G0 stays available');
    const denied = c.guard({ name: 'write', arguments: {}, callId: 'd' });
    assert.match(denied, /suspended, awaiting human review/);
  });

  it('honours deny-all for SDK-exact suspension semantics', () => {
    const c = controller({ suspendedBehavior: 'deny-all' });
    c.guard({ name: 'pwsh', arguments: { command: 'rm -rf /' }, callId: 'a' });
    c.guard({ name: 'pwsh', arguments: { command: 'rm -rf /' }, callId: 'b' });
    while (!c.runtime.state.suspended) c.runtime.reject();
    assert.match(c.guard({ name: 'read', arguments: {}, callId: 'c' }), /suspended/);
  });

  it('never gates the control-plane tool', () => {
    const c = controller();
    c.guard({ name: 'pwsh', arguments: { command: 'rm -rf /' }, callId: 'a' });
    c.guard({ name: 'pwsh', arguments: { command: 'rm -rf /' }, callId: 'b' });
    assert.equal(c.guard({ name: 'entropy_status', arguments: {}, callId: 'c' }), undefined);
  });

  it('bounds untracked pending calls and sweeps abandoned ones', () => {
    const c = controller({ maxPending: 2, pendingTtlMs: 1000 });
    c.guard({ name: 'read', arguments: {}, callId: '1' });
    c.guard({ name: 'read', arguments: {}, callId: '2' });
    c.guard({ name: 'read', arguments: {}, callId: '3' });
    assert.equal(c.pending.size, 2, 'the oldest pending entry is evicted');

    c.pending.get('3').at = Date.now() - 5000;
    assert.equal(c.sweep(), 1);
    assert.equal(c.pending.size, 1);
  });

  it('reports live state and the paper metrics, and lets a human steer it', () => {
    const c = controller();
    c.guard({ name: 'read', arguments: {}, callId: '1' });
    c.settle('1', false);
    const status = c.status();
    assert.equal(status.agentId, 'test-agent');
    assert.equal(status.gear, Gear.EXECUTE);
    assert.equal(status.gateAcceptanceRate, 1);
    assert.match(c.report(), /Entropy guard — agent test-agent/);
    assert.match(c.promptLine(), /gear G3 Execute/);

    c.setGear(Gear.OBSERVE);
    assert.equal(c.runtime.state.gear, Gear.OBSERVE);
    assert.equal(c.runtime.audit.entries.at(-1).kind, 'gear_manual');

    c.reset();
    assert.equal(c.runtime.state.cycle, 0);
    assert.equal(c.runtime.audit.entries.at(-1).kind, 'reset');
  });

  it('is inert when disabled', () => {
    const c = controller({ enabled: false });
    assert.equal(c.guard({ name: 'pwsh', arguments: { command: 'rm -rf /' }, callId: '1' }), undefined);
    assert.equal(c.promptLine(), '');
  });

  it('folds the ladder state back out of the chain on activation (defect 13)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'entropy-restore-'));
    const path = join(dir, 'chain.jsonl');
    try {
      const config = resolveConfig({ fallback: { maxConsecutiveRejections: 8 } });
      const first = new EntropyController({ agentId: 'a', config, auditPath: path });
      // Two clean cycles, not three: the third reaches `patience` and escalates a
      // gear, and a transition deliberately clears the patience counter.
      for (const id of ['1', '2']) {
        first.guard({ name: 'read', arguments: {}, callId: id });
        first.settle(id, false);
      }
      assert.equal(first.runtime.state.cleanStreak, 2);
      // One errored call: sigma rises, the streak resets, and the ladder drops a
      // gear. Because `tool_error` carries the post-transition state, the fold has
      // to see all three.
      first.guard({ name: 'read', arguments: {}, callId: '4' });
      first.settle('4', true);
      assert.equal(first.runtime.state.cleanStreak, 0);
      assert.ok(first.runtime.state.sigma > 0);

      const second = new EntropyController({ agentId: 'a', config, auditPath: path });
      assert.notEqual(second.runtime.restoredState, null, 'the state is folded, not discarded');
      assert.equal(second.runtime.state.gear, first.runtime.state.gear);
      assert.equal(second.runtime.state.sigma, first.runtime.state.sigma);
      assert.equal(second.runtime.state.cleanStreak, first.runtime.state.cleanStreak);
      const restore = second.runtime.audit.entries.filter((e) => e.kind === 'restore').at(-1);
      assert.equal(restore.applied, true);
      assert.match(restore.reason, /folded \d+ entr/);
      assert.equal(second.runtime.audit.entries.filter((e) => e.kind === 'init').at(-1).restored, true);
      assert.match(second.report(), /restore\s+state folded from the chain/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts fresh when asked, and treats a human reset as the fold origin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'entropy-fresh-'));
    const path = join(dir, 'chain.jsonl');
    try {
      const config = resolveConfig({ fallback: { maxConsecutiveRejections: 8 } });
      const first = new EntropyController({ agentId: 'a', config, auditPath: path });
      for (const id of ['1', '2']) {
        first.guard({ name: 'read', arguments: {}, callId: id });
        first.settle(id, false);
      }
      first.setGear(Gear.SUGGEST);

      const off = new EntropyController({
        agentId: 'a',
        config: resolveConfig({ restoreState: false, fallback: { maxConsecutiveRejections: 8 } }),
        auditPath: path,
      });
      assert.equal(off.runtime.restoredState, null);
      assert.equal(off.runtime.state.gear, Gear.EXECUTE, 'a fresh session starts at initialGear');
      assert.match(off.runtime.restoreNote, /disabled/);

      // That deliberately fresh activation must not erase the state for later
      // activations: the human's gear choice still folds out.
      const third = new EntropyController({ agentId: 'a', config, auditPath: path });
      assert.equal(third.runtime.state.gear, Gear.SUGGEST, 'the human gear choice survived');

      third.reset();
      assert.equal(third.runtime.state.gear, Gear.EXECUTE);
      const after = new EntropyController({ agentId: 'a', config, auditPath: path });
      assert.equal(after.runtime.state.gear, Gear.EXECUTE, 'the reset is the new origin');
      assert.equal(after.runtime.state.cleanStreak, 0);
      assert.equal(after.runtime.state.sigma, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never folds a tampered chain back into state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'entropy-tamper-'));
    const path = join(dir, 'chain.jsonl');
    try {
      const config = resolveConfig({ fallback: { maxConsecutiveRejections: 8 } });
      const first = new EntropyController({ agentId: 'a', config, auditPath: path });
      first.guard({ name: 'read', arguments: {}, callId: '1' });
      first.settle('1', false);

      const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '');
      const index = lines.findIndex((line) => line.includes('"kind":"gate_decision"'));
      lines[index] = lines[index].replace('"tool":"read"', '"tool":"wr1te"');
      writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');

      const second = new EntropyController({ agentId: 'a', config, auditPath: path });
      assert.equal(second.runtime.restoredState, null);
      assert.match(second.runtime.restoreNote, /tampered/);
      assert.equal(second.runtime.audit.entries.filter((e) => e.kind === 'restore').at(-1).applied, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('release verification', () => {
  /** A minimal tar.gz writer, so the reader is exercised against real bytes. */
  function buildTarGz(files) {
    const blocks = [];
    for (const [path, text] of Object.entries(files)) {
      const body = Buffer.from(text, 'utf8');
      const header = Buffer.alloc(512);
      header.write(path, 0, 'utf8');
      header.write(body.length.toString(8).padStart(11, '0'), 124, 'utf8');
      header[156] = 48;
      header.write('ustar', 257, 'utf8');
      header.write('        ', 148, 'utf8');
      let sum = 0;
      for (const byte of header) sum += byte;
      header.write(sum.toString(8).padStart(6, '0'), 148, 'utf8');
      blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(blocks));
  }

  it('treats a packer-rewritten package.json as equivalent, not as a difference', () => {
    const withNewline = '{\n  "name": "x",\n  "version": "1.0.0"\n}\n';
    const stripped = '{\n  "name": "x",\n  "version": "1.0.0"\n}';
    assert.equal(jsonEquivalent(withNewline, stripped), true, 'the packer strips the trailing newline');
    assert.equal(jsonEquivalent('{"a":1,"b":2}', '{"b":2,"a":1}'), true, 'key order is the packer business too');
    assert.equal(jsonEquivalent('{"a":1}', '{"a":2}'), false);
    assert.equal(jsonEquivalent('not json', '{"a":1}'), false);
  });

  it('resolves metadata references as files, directories or globs', () => {
    const paths = ['index.js', 'lib/core.js', 'lib/config.js', 'locale/en.json', 'locale/zh.json'];
    assert.equal(matchesReference('./index.js', paths), true);
    assert.equal(matchesReference('lib', paths), true, 'a directory reference ships a tree');
    assert.equal(matchesReference('./locale/*.json', paths), true, 'a glob is not a filename — the audit false positive');
    assert.equal(matchesReference('./missing.js', paths), false);
    assert.equal(matchesReference('locales', paths), false, 'a prefix that is not a path boundary');
  });

  it('reads a .tar.gz in process, without tar', () => {
    const artifact = readTarGz(buildTarGz({
      'package/index.js': 'export const a = 1;\n',
      'package/lib/x.js': 'x',
      'package/locale/en.json': '{}',
    }));
    assert.deepEqual([...artifact.keys()].sort(), ['index.js', 'lib/x.js', 'locale/en.json']);
    assert.equal(artifact.get('index.js').toString('utf8'), 'export const a = 1;\n');
    assert.equal(artifact.get('lib/x.js').toString('utf8'), 'x');
  });
});
