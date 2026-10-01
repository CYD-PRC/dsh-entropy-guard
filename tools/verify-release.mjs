#!/usr/bin/env node
/**
 * Release verification: the layer the test suite cannot see.
 *
 * The suite runs against the source tree. It says nothing about what a package
 * manager actually puts in a tarball, whether a published artifact still matches
 * the commit it claims to be, or whether the metadata inside the package points
 * at files the package does not carry. Both failure modes have happened here:
 *
 *  - 0.2.0 published an artifact that predated its own commit — caught only by
 *    comparing the tarball to the tree, file by file;
 *  - 0.2.2 declared `dsh.bundle.patch` while `files` omitted that file, so a
 *    registry install resolved to a package with no row to apply, and only a
 *    local-path install worked.
 *
 * This tool is those two checks, made recomputable. Run it from a checkout.
 *
 * Usage:
 *   node tools/verify-release.mjs                    # published name@version vs this tree
 *   node tools/verify-release.mjs --spec pkg@1.2.3   # a different artifact
 *   node tools/verify-release.mjs --pack             # pre-publish: pack this tree and check it
 *   node tools/verify-release.mjs --run-tests        # also run the suite inside the artifact
 *   node tools/verify-release.mjs --packer "<cmd>"   # packer command to use with --pack
 *                                                    # (the tool appends `pack`)
 *   node tools/verify-release.mjs --json
 *
 * Exit code 0 = verified, 1 = discrepancies (or a usage/network failure).
 *
 * Two deliberate choices, both learned from auditing this package:
 *  - No external tools. The tarball is gunzipped with `zlib` and read with an
 *    in-process tar reader, so the check runs wherever Node does.
 *  - `.json` files are compared *semantically* when their bytes differ, because
 *    the published `package.json` is the tree's minus the packer's trailing
 *    newline. A checker that cried wolf on that would be ignored, and an ignored
 *    checker is worse than none. The difference is still reported, never hidden.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

/** Directories that are never part of an artifact. */
const SKIP_DIRS = new Set(['.git', 'node_modules']);

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const sha1 = (buffer) => createHash('sha1').update(buffer).digest('hex');

/**
 * Canonical JSON: sorted keys, so two texts are compared by value and not by the
 * order a packer happened to write them in.
 * @param value - any JSON-safe value.
 * @returns the canonical string.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null) ?? 'null';
}

/**
 * Are two texts the same JSON document, whatever their bytes?
 * @param a - first text.
 * @param b - second text.
 * @returns true when both parse and their canonical forms are equal.
 */
export function jsonEquivalent(a, b) {
  try {
    return canonicalJson(JSON.parse(a)) === canonicalJson(JSON.parse(b));
  } catch {
    return false;
  }
}

/**
 * Does the artifact carry what a metadata reference points at?
 *
 * A reference may be a file, a directory (`files: ["lib"]` ships a tree) or a
 * glob (`exports: { "./locale/*.json": … }`). Treating a glob as a literal
 * filename is a false positive this tool's own audit produced once, which is why
 * the glob case is a unit test here rather than a comment.
 * @param reference - the path as written in package.json.
 * @param paths - the artifact's file paths.
 * @returns true when something in the artifact satisfies the reference.
 */
export function matchesReference(reference, paths) {
  const clean = String(reference).replace(/^\.\//, '');
  if (clean.length === 0) return true;
  if (clean.includes('*')) {
    const pattern = new RegExp(`^${clean.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
    return paths.some((path) => pattern.test(path));
  }
  return paths.some((path) => path === clean || path.startsWith(`${clean}/`));
}

/**
 * Read a `.tar.gz` in process: no `tar`, no temporary directory.
 * @param buffer - the tarball bytes.
 * @returns a map of artifact-relative path to file bytes.
 */
export function readTarGz(buffer) {
  const tar = gunzipSync(buffer);
  const files = new Map();
  const cstr = (slice) => {
    const end = slice.indexOf(0);
    return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
  };
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = cstr(header.subarray(0, 100));
    const prefix = cstr(header.subarray(345, 500));
    const sizeText = cstr(header.subarray(124, 136)).trim();
    const size = sizeText.length === 0 ? 0 : Number.parseInt(sizeText, 8) || 0;
    const type = String.fromCharCode(header[156] === 0 ? 48 : header[156]);
    const full = prefix.length > 0 ? `${prefix}/${name}` : name;
    // npm tarballs wrap everything in `package/`; that prefix is not part of the
    // package's own layout.
    const key = full.startsWith('package/') ? full.slice('package/'.length) : full;
    if (type === '0' && size > 0) {
      files.set(key, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Walk the working tree, skipping the directories an artifact never carries. */
function walkTree(root) {
  const files = new Map();
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      const info = statSync(full);
      if (info.isDirectory()) visit(full);
      else if (info.isFile()) files.set(relative(root, full).split(sep).join('/'), sha256(readFileSync(full)));
    }
  };
  visit(root);
  return files;
}

/** Compare an artifact against a tree: bytes first, JSON semantics second. */
function compareArtifact(artifact, tree) {
  const rows = [];
  let mismatches = 0;
  for (const [path, bytes] of [...artifact.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const local = tree.get(path);
    if (local === undefined) {
      rows.push({ path, verdict: 'IN-ARTIFACT-ONLY' });
      mismatches += 1;
      continue;
    }
    const digest = sha256(bytes);
    if (digest === local) {
      rows.push({ path, verdict: 'match' });
      continue;
    }
    if (path.endsWith('.json') && jsonEquivalent(readFileSync(join(ROOT, path), 'utf8'), bytes.toString('utf8'))) {
      rows.push({ path, verdict: 'match (json-equivalent; bytes differ by the packer)' });
      continue;
    }
    rows.push({ path, verdict: 'DIFF' });
    mismatches += 1;
  }
  return { rows, mismatches };
}

/** Check every path package.json references against the artifact's file list. */
function checkReferences(manifestText, artifact) {
  const manifest = JSON.parse(manifestText);
  const paths = [...artifact.keys()];
  const checked = [];
  let missing = 0;
  const add = (label, reference) => {
    const present = matchesReference(reference, paths);
    if (!present) missing += 1;
    checked.push({ label, reference, present });
  };
  if (manifest.icon) add('icon', manifest.icon);
  for (const [key, value] of Object.entries(manifest.exports ?? {})) {
    if (typeof value === 'string') add(`exports[${key}]`, value);
  }
  if (manifest.dsh?.bundle?.patch) add('dsh.bundle.patch', manifest.dsh.bundle.patch);
  for (const entry of manifest.files ?? []) add(`files:${entry}`, entry);
  // The other direction: something `files` promises that the artifact lacks.
  const promisedButAbsent = [];
  for (const entry of manifest.files ?? []) {
    const clean = String(entry).replace(/^\.\//, '');
    const listed = paths.some((path) => path === clean || path.startsWith(`${clean}/`));
    if (!listed && !clean.includes('*')) promisedButAbsent.push(clean);
  }
  return { checked, missing, promisedButAbsent };
}

async function fetchArtifact(spec) {
  const slash = spec.startsWith('@') ? spec.indexOf('/') : -1;
  const at = spec.lastIndexOf('@');
  const name = at > slash ? spec.slice(0, at) : spec;
  const version = at > slash ? spec.slice(at + 1) : 'latest';
  const base = `https://registry.npmjs.org/${name.replace('/', '%2F')}`;
  const meta = await (await fetch(`${base}/${version}`)).json();
  if (meta?.dist?.tarball === undefined) {
    // The usual cause is the one this tool exists for: the working copy is ahead
    // of the registry, because the version in package.json is not published yet.
    const packument = await (await fetch(base)).json().catch(() => null);
    const published = packument?.versions === undefined ? '(unknown)' : Object.keys(packument.versions).join(', ');
    throw new Error(
      `${name}@${version} is not in the registry (published: ${published}). `
      + 'If this is a pre-release checkout that is expected: use --pack to verify the local tarball, '
      + 'or --spec to verify an artifact that is already published.',
    );
  }
  const bytes = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer());
  const integrityOk = meta.dist.shasum ? sha1(bytes) === meta.dist.shasum : null;
  return { name, version: meta.version, bytes, meta, integrityOk };
}

function packTree(packer) {
  const candidates = packer === null
    ? [['npm'], ['pnpm'], ['npx', ['--yes', 'pnpm']]]
    : [packer.split(' ').filter((part) => part.length > 0)];
  const destination = mkdtempSync(join(tmpdir(), 'verify-release-pack-'));
  const attempts = [];
  try {
    for (const candidate of candidates) {
      const [command, ...args] = candidate;
      if (command === undefined) continue;
      // `--packer` names the packer *command* (with any of its own flags); the
      // `pack` subcommand and the destination are appended here, so a packer that
      // is not on PATH — `--packer "node /path/to/pnpm.mjs"` — works the same way.
      const result = spawnSync(command, [...args, 'pack', '--pack-destination', destination], {
        cwd: ROOT,
        encoding: 'utf8',
        // An explicitly given packer is spawned as written; the bare command names
        // need a shell on Windows to reach their `.cmd` shims.
        shell: packer === null && process.platform === 'win32',
      });
      if (result.status === 0) {
        const tarball = readdirSync(destination).find((name) => name.endsWith('.tgz'));
        if (tarball !== undefined) {
          return { bytes: readFileSync(join(destination, tarball)), packer: `${command} ${args.join(' ')}`, attempts };
        }
        attempts.push(`${command}: exited 0 but wrote no tarball`);
      } else {
        const detail = `${result.stderr ?? result.error?.message ?? ''}`.trim().split('\n')[0];
        attempts.push(`${command}: ${detail.length > 0 ? detail : `exit ${result.status}`}`);
      }
    }
    return { bytes: null, attempts };
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

function runTestsInside(artifact) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-release-run-'));
  try {
    for (const [path, bytes] of artifact) {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, bytes);
    }
    const testFile = [...artifact.keys()].find((path) => /^test\/.+\.test\.mjs$/.test(path));
    if (testFile === undefined) return { ran: false, reason: 'the artifact carries no test suite' };
    const result = spawnSync(process.execPath, ['--test', testFile], { cwd: dir, stdio: 'inherit' });
    return { ran: true, status: result.status, testFile };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv) {
  const options = { spec: null, pack: false, runTests: false, json: false, packer: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--spec') options.spec = argv[++index];
    else if (arg === '--packer') options.packer = argv[++index];
    else if (arg === '--pack') options.pack = true;
    else if (arg === '--run-tests') options.runTests = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: verify-release.mjs [--spec name@version] [--pack] [--run-tests] [--packer cmd] [--json]\n');
      return 0;
    } else {
      process.stderr.write(`unknown argument: ${arg}\n`);
      return 1;
    }
  }

  const manifestText = readFileSync(join(ROOT, 'package.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  const spec = options.spec ?? `${manifest.name}@${manifest.version}`;

  Promise.resolve()
    .then(async () => {
      let bytes; let source;
      if (options.pack) {
        const packed = packTree(options.packer);
        if (packed.bytes === null) {
          process.stderr.write(`no packer available; pass --packer "<command>". tried: ${packed.attempts.join(' | ')}\n`);
          return 1;
        }
        bytes = packed.bytes;
        source = `packed locally with ${packed.packer}`;
      } else {
        const fetched = await fetchArtifact(spec);
        bytes = fetched.bytes;
        source = `registry ${fetched.name}@${fetched.version}`;
        if (fetched.integrityOk === false) {
          process.stdout.write(`container integrity: MISMATCH (dist.shasum ${fetched.meta.dist.shasum})\n`);
        }
      }
      const artifact = readTarGz(bytes);
      const tree = walkTree(ROOT);
      const comparison = compareArtifact(artifact, tree);
      // The artifact's *own* metadata is what has to be self-consistent: a package
      // whose manifest points at something it does not carry is broken wherever it
      // is installed from, which is exactly what shipped in 0.2.2.
      const innerManifest = artifact.get('package.json');
      const references = checkReferences(
        innerManifest === undefined ? manifestText : innerManifest.toString('utf8'),
        artifact,
      );
      const localOnly = [...tree.keys()].filter((path) => !artifact.has(path)).sort();
      let tests = null;
      if (options.runTests) tests = runTestsInside(artifact);

      if (options.json) {
        process.stdout.write(`${JSON.stringify({
          source, spec, files: artifact.size, comparison, references, localOnly, tests,
        }, null, 2)}\n`);
      } else {
        process.stdout.write(`verify-release: ${source} (${artifact.size} files)\n`);
        for (const row of comparison.rows) {
          if (row.verdict !== 'match') process.stdout.write(`  ${row.path.padEnd(28)} ${row.verdict}\n`);
        }
        process.stdout.write(`  compared: ${comparison.rows.length}  mismatches: ${comparison.mismatches}\n`);
        process.stdout.write(`  metadata references checked: ${references.checked.length}  missing: ${references.missing}\n`);
        for (const entry of references.checked) {
          if (!entry.present) process.stdout.write(`    MISSING ${entry.label} -> ${entry.reference}\n`);
        }
        if (references.promisedButAbsent.length > 0) {
          process.stdout.write(`  promised by files but absent: ${references.promisedButAbsent.join(', ')}\n`);
        }
        process.stdout.write(`  in the tree but not in the artifact: ${localOnly.length === 0 ? '(none)' : localOnly.join(', ')}\n`);
        if (tests !== null) {
          process.stdout.write(`  suite inside the artifact: ${tests.ran ? `ran ${tests.testFile}, exit ${tests.status}` : tests.reason}\n`);
        }
      }
      const failed = comparison.mismatches > 0
        || references.missing > 0
        || references.promisedButAbsent.length > 0
        || (tests !== null && tests.ran && tests.status !== 0);
      return failed ? 1 : 0;
    })
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.stderr.write(`verify-release failed: ${error?.message ?? error}\n`);
      process.exitCode = 1;
    });
  return null;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = main(process.argv.slice(2));
  if (typeof code === 'number') process.exitCode = code;
}
