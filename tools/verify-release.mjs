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
 *   node tools/verify-release.mjs --spec pkg@1.2.3   # a different version of *this* package
 *   node tools/verify-release.mjs --pack             # pre-publish: pack this tree and check it
 *   node tools/verify-release.mjs --run-tests        # also run the suite inside the artifact
 *   node tools/verify-release.mjs --packer "<cmd>"   # packer command to use with --pack
 *                                                    # (the tool appends `pack`)
 *   node tools/verify-release.mjs --wait <seconds>   # poll the registry until a fresh
 *                                                    # publish settles (packument and
 *                                                    # tarball propagate independently)
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
 *
 * And two guardrails learned the same way (0.3.2):
 *  - The tree anchor is this file's own location, so running *this* copy against
 *    *another* package compares the wrong trees and reports every file as
 *    different (defect 17). A `--spec` naming a different package is refused.
 *  - Metadata references are not the only ring: shipped code that reads a file
 *    the artifact does not carry fails for every installer (the sibling guard's
 *    `verify-invariants.mjs` shipped that way). The artifact's `.js`/`.mjs` are
 *    scanned for file literals that resolve nowhere in the artifact.
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

/**
 * Could these bytes be a text file? No NUL and valid UTF-8. This — not the
 * file name — decides the line-ending equivalence class: `LICENSE` has no
 * extension, and an `.svg` is text, while a `.png` in the tree never wants the
 * comparison at all.
 */
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

/**
 * @param buffer - raw file bytes.
 * @returns whether the bytes are text for comparison purposes.
 */
export function looksLikeText(buffer) {
  if (buffer.includes(0)) return false;
  try {
    TEXT_DECODER.decode(buffer);
    return true;
  } catch {
    return false;
  }
}

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
 * Are two texts equal once CRLF is normalised to LF?
 *
 * `core.autocrlf=true` is the default on Windows, so a fresh checkout there
 * holds CRLF bytes where the artifact holds LF. Comparing raw bytes then turns
 * every text file into a false DIFF — measured by the test side as 17 phantom
 * mismatches on a good release, nearly declared bad (defect 20).
 * @param a - first text.
 * @param b - second text.
 * @returns true when the texts agree modulo line endings.
 */
export function sameTextModuloLineEndings(a, b) {
  return a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
}

/**
 * The tree's HEAD commit, so a reading names what it compared against — the
 * first question a mismatch report has to answer is "which tree was this?".
 * @param root - the tree root.
 * @returns the short hash, or null outside a git checkout.
 */
export function treeHeadOf(root) {
  try {
    const result = spawnSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: root, encoding: 'utf8' });
    const head = result.status === 0 ? result.stdout.trim() : '';
    return /^[0-9a-f]{7,40}$/.test(head) ? head : null;
  } catch {
    return null;
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
    // A checkout may legitimately hold CRLF where the artifact holds LF: text
    // files compare modulo line endings, and the report says so (defect 20).
    // Text-ness is sniffed from the bytes, not the name, so `LICENSE` (no
    // extension) is covered and a `.png` never enters the comparison.
    const localBytes = readFileSync(join(ROOT, path));
    if (looksLikeText(localBytes) && looksLikeText(bytes)
      && sameTextModuloLineEndings(localBytes.toString('utf8'), bytes.toString('utf8'))) {
      rows.push({ path, verdict: 'match (line endings normalized by the checkout)' });
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

/** File-looking string literals in a source text. */
const CODE_REFERENCE = /['"]([A-Za-z0-9._-]+\.(?:md|json|ya?ml|txt|js|mjs))['"]/g;

/**
 * Does the artifact carry everything its shipped *code* reads?
 *
 * `checkReferences` covers the paths `package.json` points at; this covers the
 * next ring out — a shipped tool that does `readFileSync(join(root, 'X'))` for
 * an `X` the artifact does not carry fails for every user who installs the
 * package. Found on the sibling guard: its shipped invariant harness read
 * `DESIGN-v1.md` and the external negative anchor, neither of which shipped.
 *
 * A basename match counts as carried: a `join(dir, name)` literal and a nested
 * copy both satisfy it. That makes this a heuristic whose only job is to flag
 * references that resolve *nowhere* in the artifact. Three scoping decisions keep
 * it quiet enough to be trusted:
 *
 *  - `test/` is not scanned: fixture names in tests are data, not reads
 *    (a `file_path` fixture value never opens the file it names), and a test
 *    that reads an unshipped fixture already fails the `--run-tests` ring.
 *  - `node_modules/` is not scanned: bundled dependencies are someone else's
 *    package — their own `verify-release` already vouched for them.
 *  - a literal without an extension never matches, so prose examples survive.
 *
 * @param artifact - the readTarGz map of artifact-relative path to bytes.
 * @returns `{ scanned, unresolved: [{file, reference}] }`.
 */
export function scanShippedReferences(artifact) {
  const paths = [...artifact.keys()];
  const basenames = new Set(paths.map((path) => path.split('/').at(-1)));
  const unresolved = [];
  let scanned = 0;
  for (const [path, bytes] of artifact) {
    if (!/\.(?:js|mjs)$/.test(path)) continue;
    if (path.startsWith('test/')) continue;
    if (path.startsWith('node_modules/')) continue;
    scanned += 1;
    const text = bytes.toString('utf8');
    for (const match of text.matchAll(CODE_REFERENCE)) {
      const reference = match[1];
      if (basenames.has(reference)) continue;
      unresolved.push({ file: path, reference });
    }
  }
  return { scanned, unresolved };
}

/** The package name part of a spec like `@scope/pkg@1.2.3` (or `pkg`). */
function nameOfSpec(spec) {
  const slash = spec.startsWith('@') ? spec.indexOf('/') : -1;
  const at = spec.lastIndexOf('@');
  return at > slash ? spec.slice(0, at) : spec;
}

async function fetchArtifact(spec, waitSeconds = 0) {
  const name = nameOfSpec(spec);
  const slash = spec.startsWith('@') ? spec.indexOf('/') : -1;
  const at = spec.lastIndexOf('@');
  const version = at > slash ? spec.slice(at + 1) : 'latest';
  const base = `https://registry.npmjs.org/${name.replace('/', '%2F')}`;
  const deadline = Date.now() + waitSeconds * 1000;
  const sleep = (ms) => new Promise((resolveSleep) => { setTimeout(resolveSleep, ms); });
  // Registry reads settle eventually: the packument and the tarball propagate
  // independently, and this project has been bitten in *both* orders (a tarball
  // already 200 while the packument still 404s, and the reverse). Neither is an
  // immediate verdict — with --wait, poll until the deadline.
  for (;;) {
    let lastProblem;
    try {
      const metaResponse = await fetch(`${base}/${version}`);
      const meta = metaResponse.ok ? await metaResponse.json() : null;
      const tarball = meta?.dist?.tarball;
      if (tarball === undefined) {
        lastProblem = `${name}@${version} is not in the registry yet`;
      } else {
        const response = await fetch(tarball);
        if (!response.ok) {
          lastProblem = `the tarball is not fetchable yet (HTTP ${response.status})`;
        } else {
          // M6: the version document and the tarball being 200 is not enough —
          // `npm install <name>` enters through the ROOT packument, which
          // propagates later (measured on a fresh package: ~2.5 minutes behind).
          // A release is not verified while the name itself still 404s.
          const packumentResponse = await fetch(base);
          const packument = packumentResponse.ok ? await packumentResponse.json() : null;
          if (packument?.versions?.[meta.version] === undefined) {
            lastProblem = 'the root packument does not list it yet (install-by-name still fails)';
          } else {
            const bytes = Buffer.from(await response.arrayBuffer());
            const integrityOk = meta.dist.shasum ? sha1(bytes) === meta.dist.shasum : null;
            const latest = packument?.['dist-tags']?.latest ?? null;
            return { name, version: meta.version, bytes, meta, integrityOk, latest };
          }
        }
      }
    } catch (error) {
      lastProblem = `registry read failed (${error?.message ?? error})`;
    }
    if (Date.now() >= deadline) {
      // The usual cause is the one this tool exists for: the working copy is
      // ahead of the registry, because the version in package.json is not
      // published yet.
      const packument = await fetch(base).then((r) => r.json()).catch(() => null);
      const published = packument?.versions === undefined ? '(unknown)' : Object.keys(packument.versions).join(', ');
      throw new Error(
        `${name}@${version} could not be fetched (${lastProblem}; published: ${published}). `
        + 'If this is a pre-release checkout that is expected: use --pack to verify the local tarball, '
        + '--wait <seconds> to let a fresh publish settle, '
        + 'or --spec to verify an artifact that is already published.',
      );
    }
    await sleep(2000);
  }
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

/**
 * A package carrying `bundleDependencies` ships those deps inlined under
 * `node_modules/` in the tarball. They are not part of the tree comparison —
 * they are somebody else's package — but their *versions* are this release's
 * contract: the bundled copy must match the declared spec, and the spec must be
 * an exact pin (a range makes the artifact's contents depend on when it was
 * packed).
 * @param manifest - the tree's package.json, parsed.
 * @param artifact - the readTarGz map.
 * @returns `{ checked: [{name, spec, bundled, ok}], mismatches: number, excluded: string[] }`.
 */
export function checkBundledDependencies(manifest, artifact) {
  const bundled = Array.isArray(manifest.bundleDependencies) ? manifest.bundleDependencies : [];
  const checked = [];
  let mismatches = 0;
  for (const name of bundled) {
    const spec = manifest.dependencies?.[name] ?? null;
    const packedManifest = artifact.get(`node_modules/${name}/package.json`);
    const bundledVersion = packedManifest === undefined ? null : JSON.parse(packedManifest.toString('utf8')).version;
    const ok = spec !== null && spec === bundledVersion;
    if (!ok) mismatches += 1;
    checked.push({ name, spec, bundled: bundledVersion, ok });
  }
  const excluded = bundled.length === 0
    ? []
    : [...artifact.keys()].filter((path) => bundled.some((name) => path.startsWith(`node_modules/${name}/`)));
  return { checked, mismatches, excluded };
}

function main(argv) {
  const options = { spec: null, pack: false, runTests: false, json: false, packer: null, wait: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--spec') options.spec = argv[++index];
    else if (arg === '--packer') options.packer = argv[++index];
    else if (arg === '--wait') {
      const seconds = Number(argv[++index]);
      if (!Number.isFinite(seconds) || seconds < 0) {
        process.stderr.write(`--wait wants a non-negative number of seconds, got: ${argv[index]}\n`);
        return 1;
      }
      options.wait = seconds;
    } else if (arg === '--pack') options.pack = true;
    else if (arg === '--run-tests') options.runTests = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: verify-release.mjs [--spec name@version] [--pack] [--run-tests] [--packer cmd] [--wait seconds] [--json]\n');
      return 0;
    } else {
      process.stderr.write(`unknown argument: ${arg}\n`);
      return 1;
    }
  }

  const manifestText = readFileSync(join(ROOT, 'package.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  const spec = options.spec ?? `${manifest.name}@${manifest.version}`;
  const treeHead = treeHeadOf(ROOT);
  // The tree anchor is this file's own location. Running this copy against a
  // *different* package compares the wrong trees and reports every file as a
  // difference (defect 17): refuse the mismatch rather than print 14 false DIFFs.
  if (nameOfSpec(spec) !== manifest.name) {
    process.stderr.write(
      `verify-release: --spec names "${nameOfSpec(spec)}" but this copy ships with "${manifest.name}". `
      + 'The tree anchor is the tool\'s own location — run the copy inside the package you are verifying.\n',
    );
    return 1;
  }

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
        const fetched = await fetchArtifact(spec, options.wait);
        bytes = fetched.bytes;
        source = `registry ${fetched.name}@${fetched.version}`;
        if (fetched.integrityOk === false) {
          process.stdout.write(`container integrity: MISMATCH (dist.shasum ${fetched.meta.dist.shasum})\n`);
        }
        // Informational, never a failure: verifying an older release while a
        // newer one is `latest` is ordinary work.
        if (fetched.latest !== null && fetched.latest !== fetched.version) {
          process.stdout.write(`note: dist-tags.latest is ${fetched.latest}; you are verifying ${fetched.version}\n`);
        }
      }
      const artifact = readTarGz(bytes);
      const tree = walkTree(ROOT);
      // Bundled dependencies ship inside the artifact under node_modules/: they
      // are someone else's package, so they leave the tree comparison — but
      // their versions are this release's contract.
      const bundled = checkBundledDependencies(manifest, artifact);
      const artifactForCompare = bundled.excluded.length === 0
        ? artifact
        : new Map([...artifact].filter(([path]) => !bundled.excluded.includes(path)));
      const comparison = compareArtifact(artifactForCompare, tree);
      // The artifact's *own* metadata is what has to be self-consistent: a package
      // whose manifest points at something it does not carry is broken wherever it
      // is installed from, which is exactly what shipped in 0.2.2.
      const innerManifest = artifact.get('package.json');
      const references = checkReferences(
        innerManifest === undefined ? manifestText : innerManifest.toString('utf8'),
        artifact,
      );
      // The next ring out: shipped code reading files the artifact does not carry.
      const codeReferences = scanShippedReferences(artifact);
      const localOnly = [...tree.keys()].filter((path) => !artifact.has(path)).sort();
      let tests = null;
      if (options.runTests) tests = runTestsInside(artifact);

      if (options.json) {
        process.stdout.write(`${JSON.stringify({
          source, spec, treeHead, files: artifact.size, comparison, references, codeReferences, bundled, localOnly, tests,
        }, null, 2)}\n`);
      } else {
        process.stdout.write(`verify-release: ${source} (${artifact.size} files) · tree ${treeHead ?? '(unknown HEAD)'}\n`);
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
        process.stdout.write(`  code references scanned: ${codeReferences.scanned}  unresolved: ${codeReferences.unresolved.length}\n`);
        for (const entry of codeReferences.unresolved) {
          process.stdout.write(`    UNRESOLVED ${entry.file} -> ${entry.reference}\n`);
        }
        process.stdout.write(`  in the tree but not in the artifact: ${localOnly.length === 0 ? '(none)' : localOnly.join(', ')}\n`);
        if (bundled.checked.length > 0) {
          process.stdout.write(`  bundled dependencies: ${bundled.checked.length}  mismatches: ${bundled.mismatches} (excluded from the tree comparison: ${bundled.excluded.length} files)\n`);
          for (const entry of bundled.checked) {
            if (!entry.ok) {
              process.stdout.write(`    BUNDLED-MISMATCH ${entry.name}: manifest pins ${entry.spec ?? '(undeclared)'}, the artifact carries ${entry.bundled ?? '(absent)'}\n`);
            }
          }
        }
        if (tests !== null) {
          process.stdout.write(`  suite inside the artifact: ${tests.ran ? `ran ${tests.testFile}, exit ${tests.status}` : tests.reason}\n`);
        }
      }
      const failed = comparison.mismatches > 0
        || references.missing > 0
        || references.promisedButAbsent.length > 0
        || codeReferences.unresolved.length > 0
        || bundled.mismatches > 0
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
