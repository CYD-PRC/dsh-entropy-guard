/**
 * File-tool surface: what the rule table sees when the operation is a write/read
 * rather than a shell command.
 *
 * Probe under test:
 *   write_file: path=/tmp/entropy-probe.txt, content="probe"
 *
 * `content` is a declared content key, so it is never scanned (defect 1's fix:
 * writing a file that *mentions* a destructive command must not be denied, or the
 * guard cannot maintain its own rule table). The path, the tool name and the
 * other arguments are scanned. So the only question this probe asks is: which
 * paths does the table treat as dangerous?
 *
 * It also re-checks one claim from the attached audit report — that
 * `cat /etc/shadow` is blocked — against this table.
 */
import { classify, resolveConfig } from '../lib/config.js';

const config = resolveConfig({});

/** [id, tool, args, note] */
const cases = [
  ['w-1', 'write_file', { path: '/tmp/entropy-probe.txt', content: 'probe' }, 'the probe'],
  ['w-2', 'write', { path: '/tmp/entropy-probe.txt', content: 'probe' }, 'same call, DSH tool name'],
  ['w-3', 'write_file', { path: '/root/.ssh/id_rsa', content: '-----BEGIN PRIVATE KEY-----' }, 'overwrite a private key'],
  ['w-4', 'write_file', { path: '/root/.ssh/authorized_keys', content: 'ssh-rsa AAAA attacker@host' }, 'install a backdoor key'],
  ['w-5', 'write_file', { path: '/root/.aws/credentials', content: '[default]' }, 'cloud credentials'],
  ['w-6', 'write_file', { path: '/etc/passwd', content: 'root::0:0:root:/root:/bin/sh' }, 'system account file'],
  ['w-7', 'write_file', { path: '/etc/sudoers', content: 'attacker ALL=(ALL) NOPASSWD:ALL' }, 'privilege grant'],
  ['w-8', 'write_file', { path: '/tmp/notes.md', content: 'now run rm -rf / to clean up' }, 'content mentions a destructive command'],
  ['w-9', 'write', { path: 'C:\\Users\\87426\\.ssh\\id_rsa', content: 'x' }, 'Windows credential path'],
  ['r-1', 'read', { path: '/root/.ssh/id_rsa' }, 'read a private key'],
  ['r-2', 'read', { path: '/etc/shadow' }, 'audit report says blocked'],
  ['r-3', 'bash', { command: 'cat /etc/shadow' }, 'audit report says blocked (shell form)'],
];

const pad = (s, n) => String(s).padEnd(n);
console.log('file-tool surface: rule-table verdicts\n');
console.log(`${pad('id', 6)}${pad('tool', 12)}${pad('labels', 26)}${pad('risk', 6)}${pad('gear', 6)}case`);
console.log('-'.repeat(104));
for (const [id, tool, args, note] of cases) {
  const r = classify(tool, args, config);
  console.log(`${pad(id, 6)}${pad(tool, 12)}${pad(r.labels.join(',') || '\u2014 none \u2014', 26)}${pad(r.risk, 6)}${pad(r.gear, 6)}${note}`);
}

const byId = (id) => cases.find((c) => c[0] === id);
console.log('\npointed checks');
for (const id of ['w-4', 'w-6', 'w-7', 'r-2', 'r-3']) {
  const [cid, tool, args] = byId(id);
  const r = classify(tool, args, config);
  console.log(`  ${cid} ${tool} ${args.path ?? args.command} -> ${r.labels.length ? r.labels.join(',') : 'not flagged'}`);
}
