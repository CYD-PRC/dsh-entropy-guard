/**
 * Boundary map for the two recursive-delete rules, using the probe pair:
 *   bash: rm -rf /tmp/entropy-probe-marker
 *   pwsh: Remove-Item -Recurse -Force "$env:TEMP\entropy-probe-marker"
 *
 * For each variant this prints the three decisions that compose a verdict:
 *   1. does the OPERATION pattern match?
 *   2. does its dangerous TARGET pattern match (the scope gate added for defect 2)?
 *   3. does the rule fire (both), and what labels/risk reach the utility gate?
 *
 * Nothing here executes anything. `rm -rf /` appears only as an inert string
 * inside `content`, which the rule scanner never reads (defect 1's fix).
 */
import { classify, resolveConfig } from '../lib/config.js';

const config = resolveConfig({});
const rule = (label) => config.rules.find((r) => r.label === label);

const probe = (platform, label, command) => {
  const r = classify(platform, { command }, config);
  const ruleObj = rule(label);
  ruleObj.regexp.lastIndex = 0;
  const opMatch = ruleObj.regexp.test(command);
  let targetMatch = null;
  if (ruleObj.targetRegexp) {
    ruleObj.targetRegexp.lastIndex = 0;
    targetMatch = ruleObj.targetRegexp.test(command);
  }
  return { command, opMatch, targetMatch, fired: r.labels.includes(label), labels: r.labels, risk: r.risk };
};

const cases = [
  ['bash', 'recursive-force-delete', 'rm -rf /tmp/entropy-probe-marker', 'the probe, Unix form'],
  ['bash', 'recursive-force-delete', 'rm -rf build', 'relative -> ordinary work by doctrine'],
  ['bash', 'recursive-force-delete', 'rm -rf ./build', 'relative with ./ prefix'],
  ['bash', 'recursive-force-delete', 'rm -rf ~/build', 'home-relative'],
  ['bash', 'recursive-force-delete', 'rm -rf /', 'catastrophic root'],
  ['pwsh', 'windows-recursive-force-delete', 'Remove-Item -Recurse -Force "$env:TEMP\\entropy-probe-marker"', 'the probe, Windows form'],
  ['pwsh', 'windows-recursive-force-delete', 'Remove-Item -Recurse -Force "$env:USERPROFILE\\entropy-probe-marker"', 'user profile root'],
  ['pwsh', 'windows-recursive-force-delete', 'Remove-Item -Recurse -Force "%TEMP%\\entropy-probe-marker"', 'percent-form temp'],
  ['pwsh', 'windows-recursive-force-delete', 'Remove-Item -Recurse -Force "C:\\Users\\87426\\AppData\\Local\\Temp\\entropy-probe-marker"', 'literal drive path'],
  ['pwsh', 'windows-recursive-force-delete', 'Remove-Item -Recurse -Force .\\build', 'relative with .\\ prefix'],
];

const pad = (s, n) => String(s).padEnd(n);
console.log('boundary map: operation match / target match / fired\n');
console.log(`${pad('platform', 9)}${pad('op', 6)}${pad('target', 8)}${pad('fired', 7)}${pad('labels', 32)}${pad('risk', 6)}case`);
console.log('-'.repeat(112));
for (const [platform, label, command, note] of cases) {
  const r = probe(platform, label, command);
  const t = r.targetMatch === null ? 'n/a' : String(r.targetMatch);
  console.log(
    `${pad(platform, 9)}${pad(r.opMatch, 6)}${pad(t, 8)}${pad(r.fired, 7)}` +
      `${pad(r.labels.join(',') || '\u2014 none \u2014', 32)}${pad(r.risk, 6)}${note}`,
  );
}

console.log('\nreading');
console.log('  - The Unix target pattern accepts ANY token that begins with a path');
console.log('    separator, so /tmp/... is treated as absolute and the rule fires:');
console.log('    the probe is DENIED on the bash path.');
console.log('  - The Windows target pattern lists drive-absolute paths, the user');
console.log('    profile and bare wildcards; $env:TEMP is none of those, so the rule');
console.log('    does NOT fire: the probe is ADMITTED on the pwsh path.');
console.log('  - Both behaviours match their own documented scope. The two scopes');
console.log('    are drawn on different lines, and the difference is visible only');
console.log('    by running both forms.');
