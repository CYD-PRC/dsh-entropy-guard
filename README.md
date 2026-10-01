# Entropy Guard — a DeepSeek Harness plugin

[中文文档 · Chinese documentation](README.zh-CN.md)

The safety control layer of [`entropy-sdk`](https://github.com/CYD-PRC/entropy-sdk)
(an embeddable distillation of the EntropyRuntime paper,
[arXiv:2607.00334](https://arxiv.org/abs/2607.00334)) wired into the Harness tool
registry, so that **an agent's degree of autonomy is observable, governable, and
accountable**.

> Upstream is Python and zero-dependency; this bundle is a faithful,
> dependency-free ESM port of its core (`lib/core.js`, one class per SDK
> abstraction) plus the Harness binding (`lib/config.js`, `lib/controller.js`,
> `index.js`). It imports no `@deepseek-ai/*` package — only Node builtins.

## What it does

Every tool call becomes one EntropyRuntime control cycle (paper §4, Algorithm 1):

| SDK abstraction | Where it lives here |
|---|---|
| `Gear` — five-level ladder G0–G4 | `lib/core.js`; the action space is nested, so a gear permits every requirement at or below it |
| `UtilityGate` — `U(s,a) >= theta` | `lib/core.js`; the sole dispatch channel, evaluated per call |
| `GearPolicy` — slow up, fast down | `lib/core.js`; one level per `patience` clean cycles below `sigmaLow`, immediate drop on error or overflow |
| `FallbackConfig` | `lib/core.js`; `maxConsecutiveRejections` is the suspension threshold |
| `RuntimeState` — ρ = (g, σ, ϵ) | one runtime per agent, keyed by agent id |
| `AuditLog` — append-only JSONL | per-agent chain under `$DSH_HOME/entropy-guard/` |
| `EntropyRuntime` | `lib/controller.js` splits `step()` into `guard()` (admit + reject) and `settle()` on `tools/result` |

Cycle mapping:

1. **Observe / gear read** — the registry hands the pending call to the guard.
2. **Action generation** — the call is classified onto the ladder
   (`lib/config.js`): a tool table, then regex rules over the tool name and its
   arguments, then `defaultTool` for anything unknown.
3. **Utility gate** — `U = task·gain + safety·(1 − risk) − cost·cost`; a
   rejection is recorded *immediately*, so a denied call can never execute.
4. **Execute / feedback** — the call settles on `tools/result`: a successful
   result is a clean cycle (σ decays, the patience counter advances), an errored
   result counts as a rejection (σ rises, ϵ = 1).

Because the veto is a `ctx.tools.guard()` — a monotonic, order-independent,
synchronous registry guard — no other plugin's `tools/pre-execute` listener can
turn a denial back into an admission. A denial returns a reason string to the
model (the same "rejection is feedback" contract the upstream adapters use), and
`maxConsecutiveRejections` consecutive denials **suspend** the agent at G0
pending human review.

## Install

The bundle is installed into the current profile with the plugin manager, using
the absolute package directory as the target. The row's `config` in
`cordis.patch.yml` is the deployment's policy and survives DSH upgrades.

## Surface

**Tool** — `entropy_status` (read-only, exempt from the guard, so it answers even
during a suspension): gear, σ, clean streak, consecutive rejections, suspension,
gate acceptance rate, gear histogram, and the last eight audit entries.

**Command** — `/entropy`:

| Subcommand | Effect |
|---|---|
| `status` (default) | Full report: gear, σ, streak, cycles, gate acceptance rate, gear histogram, recent chain entries |
| `resume` | Lifts the suspension. σ deliberately persists — gears must be re-earned |
| `gear <0-4>` | Human override; also clears the suspension, and is logged as `gear_manual` |
| `reset` | New runtime for this agent |

**Runtime context** — a per-agent line beside the DSH file-policy line, so the
model knows its own gear before choosing an action:

```
Entropy guard: gear G3 Execute (G0 Observe → G4 Integrate) · sigma=0.00 · clean streak 0/3
· 0/5 consecutive rejections · gate acceptance 100% · tools whose attested gear exceeds the
current level are denied, and a denial raises sigma
```

**Audit chain** — `${DSH_HOME}/entropy-guard/<agent>.jsonl`, append-only, one
`gate_decision` / `gear_transition` / `execute` / `call_rejected` / `suspend` /
`resume` per event. `gateAcceptanceRate()` and `gearHistogram()` are the paper's
empirical readings (Theorems 1 and 3).

## Configuration

Every field is optional. The patch ships the defaults spelled out; the full shape:

```yaml
config:
  enabled: true
  initialGear: 3            # 0-4; G3 Execute keeps a normal session autonomous
  theta: 1                  # gate threshold, finite and >= 0
  weights: { task: 1, safety: 2, cost: 0.5 }
  tools:                    # per-tool attestation; `null` deletes a default
    read: { gear: 0, risk: 0.05, cost: 0.2 }
    write: { gear: 3, risk: 0.55, cost: 0.5 }
  rules:                    # regex over the operation surface; max(risk), max(cost)
    - { label: recursive-force-delete, match: '...', dangerousTarget: '...', risk: 1, cost: 0.8 }
  contentKeys: [content, old_string, new_string]   # argument keys rules never scan
  defaultTool: { gear: 3, risk: 0.5, cost: 0.5 }   # unknown tools attest to G3
  policy: { sigmaLow: 0.3, sigmaHigh: 1.0, patience: 3, sigmaDecay: 0.1, sigmaStep: 0.1 }
  # policy: { ..., fastDown: error }   # `overflow` = one error costs sigma, not a whole gear
  fallback: { maxAlternatives: 0, maxConsecutiveRejections: 8, countGearDenials: false }
  enforcement: gate                                # gate | observe (observe denies nothing)
  audit: { dir: null, includeArguments: false }    # null = $DSH_HOME/entropy-guard, "" = memory
  suspendedBehavior: observe-only                  # or deny-all
  controlTools: [entropy_status]
  promptContext: true
  humanCommands: true
  ui: { dock: true, settings: true }               # composer badge + settings page
```

Invalid values throw at activation instead of degrading silently — the same
construct-time fail-closed validation the Python SDK performs.

### Gear ladder

| Gear | Name | Permitted actions |
|---|---|---|
| G0 | Observe | Read-only observation, safe holding |
| G1 | Suggest | Side-effect-free candidate plans |
| G2 | Plan | Bounded, reversible recovery actions |
| G3 | Execute | Independently chosen side-effecting actions |
| G4 | Integrate | System-level coordination |

Nine of the shipped rules (recursive force delete on both platforms, `git push --force`/`reset
--hard`, piping a download into a shell, `mkfs`/`dd` to a device, a fork bomb,
credential-store access, registry/system mutation, world-writable root) push `U`
below `theta` at any gear, so they are denied outright. They are deliberately
narrow: a rule that fires on ordinary work makes the gate unusable.

The two recursive-delete rules are additionally scoped by a `dangerousTarget`: they fire only when the operation targets an absolute path, a home directory, the working directory itself, or a bare wildcard. A recursive force delete of a scoped relative path — an agent clearing its own build output — stays admissible.

Pattern rules scan the tool name and its **operation-bearing** arguments only. Argument keys listed in `contentKeys` (`content`, `old_string`, `new_string`) are never scanned: writing a document, a test, or a policy table that merely *mentions* a dangerous command must not be denied, and a guard that blocks such writes cannot even maintain its own rule set. The moment that matters is execution, and every shell tool's command argument is still scanned. Both refinements came out of dogfooding — the first version of this bundle denied its own source edits.

## Deliberate deviations from the Python SDK

Both are documented, configurable, and tested:

1. **`fallback.maxAlternatives` defaults to 0** (fallback off — an explicitly
   legal SDK configuration since v0.1.2). The Harness cannot rewrite a pending
   tool call into a different call, so a proposer's alternative has nowhere to
   be dispatched; the denial reason is the feedback, exactly as the upstream
   framework adapters document. The proposer itself is fully implemented in
   `lib/core.js` and covered by tests.
2. **`suspendedBehavior` defaults to `observe-only`**, keeping G0 read-only tools
   available during a suspension — the paper's Theorem 4 recovery path, and what
   keeps an embedded agent able to read its own audit chain and the code it must
   fix. `deny-all` reproduces the SDK's `suspended_skip` literally.

## Adoption: start in observe mode

`enforcement: 'observe'` computes and audits every decision but denies nothing, so
the guard can be installed on a live profile and measured before it is trusted:

```yaml
config:
  enforcement: observe
```

`/entropy export` then reports exactly what the policy *would* have refused —
`would_deny` entries sit beside the real decisions in the same chain — and
switching to `enforcement: gate` starts enforcing that same policy.

## Web UI

Two Client contributions, both optional via `ui: { dock: false, settings: false }`:

- **above the composer** — a live badge: the G0–G4 ladder, sigma, clean streak and
  gate acceptance. It follows the current session when the slot identifies one, and
  otherwise reports the **fleet's weakest gear**: G4 is defined as system-level
  coordination, so the level a composition can actually be trusted at is its
  weakest member's, not its strongest.
- **Settings → Entropy Guard** — the ladder, the control quantities, a per-agent
  table, gear-transition history, and per-tool decisions.

The page is plain browser JavaScript: React comes from the module table, styling
uses only `--dsw-alias-*` tokens, and the data comes from the Host's read-only
`/entropy/state` route on the page's own origin. No client Harness package is
imported, and a failed fetch degrades to a "state unavailable" line instead of
blanking the slot.

## Reading the run

| Command | Effect |
|---|---|
| `/entropy fleet` | Every governed agent's gear, sigma, suspension state and decision counts, plus the fleet's weakest gear and aggregate acceptance |
| `/entropy export [dir]` | Writes `entropy-report-<agent>.json` and `.md`: state, policy, acceptance rate, gear-transition table, per-tool decisions and the sigma trajectory — the artifact the SDK's §8 empirical requirements ask for |

## Hardening the control plane

The guard governs *tool calls*; it does not govern the tools that manage the guard. `plugin_manager` is classified at G3 with `U ≈ 1.15`, so an agent above that gear can disable, remove, or reconfigure this very plugin, after which the layer is simply not in force. That is the intended shape of a *policy* layer — a filesystem sandbox does not police its own uninstaller either — but a deployment that wants the guard to be non-bypassable from inside the session should raise that entry above the threshold in its own `config`:

```yaml
tools:
  plugin_manager: { gear: 4, risk: 0.95, cost: 0.65 }   # U = 0.775 < 1 -> denied
```

Treat the guard the way the SDK's threat model treats the gate: a control **inside** the execution paths it governs, not a kernel.

## Verified against the live Harness

Observed on a `danger-full-access` desktop profile with this bundle installed:

- `install_bundle` reported `application: applied`, and the per-agent runtime-context line appeared in the model's own context.
- Read-only calls were admitted at `U = 2.80` (file read) and `U = 2.89` (glob), tracked as pending, and settled by `tools/result` as clean cycles: sigma 0, patience counter advancing, gate acceptance 1.0.
- A shell call whose *text* matched the destructive rule was denied before dispatch — `U = 0.6000 < theta = 1.0000`, `flagged [recursive-force-delete]` — de-escalating G3 → G2 with sigma 0.10, and the call never reached the shell.
- The ladder re-earned G3 after three clean G0 cycles and reached G4 Integrate under sustained clean work. A mid-session reading: 29 cycles, gate acceptance 0.8276, gear histogram `{"2":3,"3":5,"4":3}` — three de-escalations, five climbs to G3, three to G4.
- Every decision, transition, rejection, and suspension candidate landed in the append-only JSONL chain.

## Known limitations

1. **A replaced package does not hot-reload.** Changes to this bundle's own modules are not picked up by a running Host; the already-loaded generation keeps enforcing until a Harness restart loads a fresh one. Re-running `install_bundle` for an already-installed package reports `ambiguous-install` and does not reload it.
2. **Any errored tool result counts as a rejection.** That is the SDK's `epsilon = 1` semantics, but at the Harness level most tool errors are not safety events — a search that finds nothing, or an edit whose anchor no longer matches, costs sigma and a gear level. **`fastDown: 'error'` remains the default because the default is the law's fingerprint: changing it here would fork the sampling semantics of the evaluation section.** For interactive coding the recommended setting is `fastDown: 'overflow'`, under which one failed call costs 0.1 sigma instead of a whole gear and the ladder stops reacting to a stale edit anchor. Measured on this profile under `error`: two failed calls plus three ladder-refused retries walked the session from G4 to G0.
3. **Pattern rules are heuristics, not a classifier.** They are content-blind, so an agent that controls its own payload can always paraphrase around one; that is exactly why the veto belongs at the execution boundary and why file content is not scanned at all.
4. **The guard sees only calls that reach the registry**, and it cannot rewrite a pending call (hence `maxAlternatives: 0`).
5. **Chain integrity is verified, not assumed.** Every entry carries a monotonic `seq` and the SHA-256 hash of the entry before it, so every report and export either verifies the chain or names the exact `seq` at fault. The reading is **graded**, because an alarm that also fires for routine operations stops being read: `tampered` (an entry's bytes changed after it was written, its link was rewritten, or an entry that existed is gone — the alarm), `forked` (a `seq` repeats or regresses, meaning two writers branched the same chain: operational rather than hostile, and visible nowhere else), `discontinuity` (unchained entries among chained ones, which is simply what an in-place upgrade looks like while two plugin generations write one file), and `verified`. `/entropy seal [note]` acknowledges the operational history up to the current entry **inside the chain** — the acknowledgement is an ordinary entry, so it is auditable rather than a flag someone flips; the sealed counts stay reported beside the live grade, and a tamper finding is never sealed away. A person runs it: a model cannot reach a command handler. Entries written before chaining existed are counted as an unchained legacy prefix rather than silently trusted.
6. **The UI cannot steer the guard.** `/entropy/state` answers `GET`/`HEAD` and returns 405 to anything else, and the Client half issues no other request — observation without a write path back into the governor.
7. **A failed tool call is a rejected cycle, even when it failed for a reason outside the agent's control.** Batching a read with an edit of the same file fails the edit — the filesystem observation policy wants the read to have happened in an earlier turn — and under the faithful `fastDown: 'error'` that costs a gear level. On this profile, two such failures plus the three ladder-refused retries that followed walked the session from G4 to G0 in a single round. If you drive an agent under this guard, hand it the pattern explicitly: **read in one turn, edit in the next.**

## 0.2.1

- **Statement-scoped the pattern rules (defect 8).** The Windows recursive-delete rule used two lookaheads that scanned a *whole command*, so a script that listed a directory with one flag and removed a single file with the other was graded as one recursive forced delete — it denied this bundle's own release command while 0.2.0 was being published. Rules now match statement by statement (`;`, `&&`, `||`, escaped newline), and pipelines stay intact because `|` chains a single operation. 66 tests (the count printed in this file said 51 in 0.2.0).

## 0.2.2

- **The same catastrophic-root line on both platforms (defect 9).** The Unix target pattern read "any token that begins with a path separator", so *every* absolute path was vetoed — `/tmp/build` cost a gear and a rejection — while the Windows side vetoed only drive-absolute paths, so `C:\tmp\build` passed. The same operation therefore got opposite verdicts depending on the platform, and nothing documented it. Both lists now name roots (`/`, `/etc`, `/home`, `C:\`, `C:\Windows`, `C:\Users`, the profile roots, a bare wildcard); scoped subtrees (`/tmp/...`, `$env:TEMP\...`, `C:\tmp\...`, `./build`) are ordinary work on both. `bash` also joins the tool table at `pwsh`'s baseline, so a Linux deployment no longer inherits a lower classification for the same power.
- **The chain names the object of a decision (defect 10).** Every `gate_decision` entry now carries `args_digest` — SHA-256 over the canonical arguments, so key order does not move it — plus `tool_source` (`table` or `default`). `audit.includeArguments: true` now actually stores a bounded copy of the arguments; before this release the switch was documented in this file and in `cordis.patch.yml` but **never read by any code**, so a deployment that set it got silence. The rationale is the ledger's own: a pattern table cannot decide an opaque payload (`python3 -c exec(base64…)` is invisible to it), so the record has to be the thing that can name it.
- **Credential directories, not one filename (defect 11).** The rule named `.ssh/id_*`, so *reading* a private key was vetoed while *installing* `authorized_keys` — the higher-impact action, since it grants persistent access instead of merely exposing a key — was not. The credential directories are the target now, whichever file inside them is touched.
- `status` and `/entropy status` report `defaultedTools`, the number of decisions that fell back to `defaultTool`, so a host tool rename shows up as a number rather than as a silent drift from an explicit entry to the generic baseline.

## 0.2.3

- **The published package now carries its own bundle patch (defect 12).** `package.json` declared `dsh.bundle.patch: "./cordis.patch.yml"` while `files` did not list that file, so the npm tarball shipped 13 files without the patch row its own metadata points at: a **registry** install (a bundle spec rather than a local path) resolved to a package with no row to apply, and only a local-path install worked. Found by comparing the published 0.2.2 tarball against its commit, file by file. The fix is one line in `files`; the verification for this release asserts that every path `package.json` references — `icon`, `exports`, `dsh.bundle.patch` — exists inside the tarball.

## 0.2.4

- **The published package carries its own tests.** `test/` is now in `files`, so the suite that certifies a release can be re-run by whoever installs it — verified by running it *from inside the published tarball* (71/71). Before this the package shipped a chain verifier but asked the reader to take the test count on faith, which contradicts the standard the rest of this project is held to. Cost: about 42 KB.
- **The probe and audit scripts ship in `tools/`**: `coverage-audit.mjs` (the rule table against the PRE-GHR XLI corpus), `probe-boundary.mjs`, `probe-encoded.mjs`, `probe-filewrite.mjs`. They are how the numbers in this file were produced, and therefore how they can be recomputed.
- `node --test test/core.test.mjs` — the **file**, not the directory: `node --test test/` reports nothing on Node 24, which has twice been mistaken for a broken suite. The suite's own header says so now.

## 0.3.0

- **The ladder's state is folded back out of the chain on activation (defect 13).** The state existed only as a trajectory in the entries, so every restart re-started the ladder at `initialGear` while the chain kept describing a session that had climbed — measured on a live profile as `cycles 0` beside **413 decisions**. A new activation now folds the last written value of gear, sigma, cycle, clean streak, consecutive rejections and suspension out of the chain, applies it, and records a `restore` entry saying what it applied. `init` is an activation marker rather than an origin — that is precisely what lets autonomy survive a restart. `reset` **is** an origin, so a human reset still means a blank sheet. A **tampered** chain is never used as a state source, and `restoreState: false` restores the previous fresh-session behaviour. `tool_error` now carries the post-transition state, so an errored settle folds exactly. Bounded caveat: the fold is exact to the last state-bearing entry — a *clean* settle after the final decision is not itself an entry, so sigma and the clean streak can be one cycle stale.

## 0.3.1

- **`tools/verify-release.mjs` — the layer the test suite cannot see.** The suite runs against the tree; it cannot tell you whether the published artifact still matches the commit it claims to be (0.2.0's failure) or whether the manifest points at a file the tarball does not carry (0.2.2's failure). This tool does both, and it is how those two checks stop depending on the maintainer remembering them: `--spec name@version` downloads an artifact and compares it to the working tree file by file, `--pack` checks the *local* tarball before publishing, `--run-tests` runs the suite inside the extracted artifact, `--json` for machines. It uses no external tools — `zlib` plus an in-process tar reader — and it compares `.json` files **semantically**, because the published `package.json` is the tree's minus the packer's trailing newline: a checker that cried wolf on that would be ignored, and an ignored checker is worse than none. The glob case (`exports: { "./locale/*.json" }` is not a filename) is a unit test here, because a hand-rolled audit of this package produced exactly that false positive.
- **Operational note: 0.3.0 changed what a restart means.** With the state fold, a session that had been de-escalated **inherits** its gear on the next activation instead of re-earning it from `initialGear`. Restart is no longer a reset: a reproduction that used to begin on a clean ladder can now start at G2 and refuse ordinary work until it climbs back. To start fresh deliberately, use **`/entropy reset`** (which writes the fold's origin), point the deployment at a clean chain directory, or set `restoreState: false`. This was found by an external audit that got bitten by it; it is the intended semantics of defect 13's fix rather than a defect of its own.

## Defect ledger (v0.1 → v0.3.1)

Every entry here was found by running this plugin on a live profile; each names the fix that closed it. The pattern is the point: the defects cluster where a Python-shaped control law meets a tool registry, and three of them were the guard mis-grading *its own maintenance*.

| # | Defect | Observed effect | Fix |
|---|---|---|---|
| 1 | Pattern rules scanned file *content* | The bundle denied its own source edits — patching its own rule table tripped the very rule being edited, so a governed agent could not fix the live generation | `contentKeys` drops content-bearing arguments from the scan surface; the veto belongs at the execution boundary, where the shell tool's command argument is still scanned |
| 2 | Rules matched the operation but not the target | A scoped cleanup of the plugin's own scratch directory was vetoed as if it were a filesystem wipe | `dangerousTarget` scopes each recursive-delete rule to an absolute path, a home directory, the working directory itself, or a bare wildcard |
| 3 | Every errored tool result cost a whole gear | A stale edit anchor, a search that found nothing, or a refused network call dropped the session a level and briefly removed the tools needed to recover | `policy.fastDown` (`overflow` charges sigma instead of a gear) plus `fallback.countGearDenials: false` |
| 4 | Ladder refusals counted toward suspension | An agent working below its gear suspended *itself* by continuing to call the tools its job required | `countGearDenials: false` and a higher `maxConsecutiveRejections` |
| 5 | An audit field named `kind` overwrote the event kind | The chain lost the entry type of every `would_deny` and `call_rejected` record — Python raises on that collision, JavaScript silently clobbered it | the event kind is spread last, so a caller field can never rewrite an entry's type |
| 6 | A replaced package does not hot-reload | Code already fixed on disk kept enforcing its old logic until a restart — including defects 1 and 2 | documented as standing limitation 1; re-running `install_bundle` returns `ambiguous-install` and does not reload |
| 7 | The guard governed tool calls but not the tools managing the guard | A session at G3 could uninstall the layer with the very autonomy the layer granted | `plugin_manager` is classified at G4 Integrate |
| 8 | A rule matched across a whole command instead of per statement | A script that listed a directory with one flag and removed a single file with the other was graded as one recursive forced delete — it denied this bundle's own release command | rules match statement by statement (`;`, `&&`, `\|\|`, escaped newline), and pipelines stay intact because `\|` chains one operation |
| 9 | The destructive-target line was drawn differently per platform | `rm -rf /tmp/build` was vetoed on Unix while `C:\tmp\build` passed on Windows — the same operation, opposite verdicts — and the difference was written down nowhere | both lists name catastrophic roots; scoped subtrees are ordinary work on both; `bash` joins the table at `pwsh`'s baseline |
| 10 | `audit.includeArguments` was documented but never read, and decision entries named no object | A deployment that switched payload recording on got silence; an encoded `exec` call left "shell admitted, U=…" and nothing else — neither the payload nor the target | `args_digest` on every decision, `tool_source` beside it, and the switch now stores a bounded copy |
| 11 | The credential rule named `.ssh/id_*` | Reading a private key was vetoed while writing `authorized_keys` — persistent access — was not | the credential directories are the target, whichever file inside them is touched |
| 12 | The package metadata pointed at a file the tarball did not carry | `dsh.bundle.patch` named the bundle patch while `files` omitted it, so a registry install resolved to a package with no row to apply — the community path was broken while the local path worked | the patch ships in `files`, and the release check asserts that every path the metadata references exists inside the tarball |
| 13 | The chain recorded the session, and the session threw its own state away at every restart | Measured on a live profile: `cycles 0` beside 413 decisions. A session that had climbed and then been rejected back to G2 restarted *more* permissive at `initialGear`, with the evidence for doing better sitting in the chain | a new activation folds gear, sigma, cycle, clean streak, rejections and suspension out of the chain, records a `restore` entry, and refuses a tampered chain as a state source |

## Threat model boundaries (inherited from upstream)

1. The gate is the sole dispatch channel **only for calls that go through the
   Harness tool registry**. Any in-process holder of a raw callable bypasses it.
2. `requiredGear` is a **caller-side attestation**. This bundle derives it from a
   deployment-owned table rather than trusting the model, but the table is a
   policy, not a proof: a tool whose true blast radius exceeds its entry is
   under-tagged, and extending `tools`/`rules` is the deployer's responsibility.
3. The gate governs **invocation, not transactions** — side effects inside an
   executed tool are not rolled back.
4. `resume()` does not clear σ by design: human review is not instant
   restoration of trust.
5. A deleted audit file reads as empty (fail-open read path) while a failed
   append is fail-closed and denies the call; a missing chain file is itself an
   event a deployer should alert on.
6. `includeArguments` is **off** by default: every decision still records a SHA-256 digest of the canonical arguments (`args_digest`), so the chain can name the object of a decision and prove which call it decided — but the payload itself is stored only when the deployment opts in (`audit.includeArguments: true`, bounded to 2 000 characters per string).

## Tests

```
node --test test/core.test.mjs        # 71 tests, no dependencies
```

Covers the ported contract (fail-closed attestation and gate validation, the
slow-up/fast-down ladder, the suspension endpoint and what `resume()` does *not*
do, audit sanitization/deep-copy isolation/file-mode caching and corrupt-line
counting, `admit()`/`settle()` parity with `step()`, the alternative proposer)
and the binding rules (risky calls denied, control tool exempt, observe-only
versus deny-all suspension, pending-call bounds).

## Provenance

Upstream `entropy-sdk` is MIT © Wang Miaosheng (ORCID: 0009-0003-2767-2421).
This bundle ports its published core semantics; it is an independent binding of
that library to the DeepSeek Harness and is not affiliated with its author.
