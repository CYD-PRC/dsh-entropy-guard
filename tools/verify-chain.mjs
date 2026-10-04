#!/usr/bin/env node
/**
 * Offline chain verifier and report generator.
 *
 * Lets anyone check the accountability claim without a running Harness: point it
 * at an audit chain and it re-walks the SHA-256 chain, re-derives the empirical
 * readings from the raw entries, and prints the same report `/entropy export`
 * writes. `--demo` proves the tamper detection on a throwaway copy.
 *
 * The instrument is read-only against its target (0.3.2, defect 16): the report
 * needs a controller, and constructing one writes `init`/`restore` entries — so
 * the controller is built over a scratch copy in a temporary directory, and the
 * audited file's bytes are exactly the same after the run as before it. The
 * pre-fix version appended two entries to the chain it audited on every run.
 *
 * Usage:
 *   node tools/verify-chain.mjs <chain.jsonl>          # verify + markdown report
 *   node tools/verify-chain.mjs <chain.jsonl> --json   # full JSON report
 *   node tools/verify-chain.mjs --demo                 # tamper demonstration
 *
 * `ENTROPY_SEED=<chain.jsonl>` seeds the demo with a real chain, so the run also
 * shows how an upgraded chain reports its unchained legacy prefix.
 *
 * @module dsh-entropy-guard/tools/verify-chain
 */

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EntropyController } from '../lib/controller.js';
import { resolveConfig } from '../lib/config.js';
import { AuditLog } from '../lib/core.js';

const [target, flag] = process.argv.slice(2);

/**
 * Build a controller bound to one chain file.
 * @param path - the JSONL chain path.
 * @returns the controller.
 */
function controllerFor(path) {
  return new EntropyController({
    agentId: 'offline-verifier',
    config: resolveConfig({}),
    auditPath: path,
  });
}

/**
 * Print one verification reading in a fixed, greppable shape. The grade comes
 * first: `TAMPERED` is the alarm, `DISCONTINUITY` is what an in-place upgrade
 * looks like while two generations write one chain, `VERIFIED` is clean.
 * @param label - the line's label.
 * @param reading - the `AuditLog.verify()` result.
 */
function printReading(label, reading) {
  console.log(
    `${label}: ${reading.status.toUpperCase()} · entries ${reading.entries} · chained ${reading.chained} · `
    + `unchained legacy ${reading.legacy} · interleaved ${reading.interleaved} · corrupt lines ${reading.corrupt}`
    + (reading.reason.length > 0 ? ` · ${reading.reason}` : ''),
  );
}

if (target === '--demo') {
  const dir = mkdtempSync(join(tmpdir(), 'entropy-verify-'));
  const path = join(dir, 'chain.jsonl');
  try {
    const seed = process.env.ENTROPY_SEED;
    if (seed !== undefined && seed.length > 0) {
      copyFileSync(seed, path);
      console.log(`seeded from ${seed}`);
    }
    const controller = controllerFor(path);
    controller.guard({ name: 'read', arguments: {}, callId: 'demo-1' });
    controller.settle('demo-1', false);
    printReading('after appending two chained entries', controller.runtime.audit.verify());

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    last.admitted = !(last.admitted === true);
    lines[lines.length - 1] = JSON.stringify(last);
    writeFileSync(path, `${lines.join('\n')}\n`);
    printReading('after editing the last entry on disk', controller.runtime.audit.verify());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else if (target !== undefined) {
  printReading(`chain ${target}`, new AuditLog(target).verify());
  console.log('');
  // The report path constructs a controller, and a controller's constructor
  // appends `init` + `restore` to whatever chain it is bound to. Bind it to a
  // scratch copy: the instrument must not be a participant in the chain it
  // audits (defect 16).
  const dir = mkdtempSync(join(tmpdir(), 'entropy-verify-'));
  try {
    const scratch = join(dir, 'chain.jsonl');
    try {
      copyFileSync(target, scratch);
    } catch {
      writeFileSync(scratch, '', 'utf8'); // a missing chain reports as empty
    }
    const controller = controllerFor(scratch);
    console.log(flag === '--json'
      ? JSON.stringify(controller.exportReport(), null, 2)
      : controller.exportMarkdown());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  console.error('usage: node tools/verify-chain.mjs <chain.jsonl> [--json] | --demo');
  process.exit(2);
}
