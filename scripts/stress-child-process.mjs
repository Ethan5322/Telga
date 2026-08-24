#!/usr/bin/env node
/**
 * The A54 stress command.
 *
 *   npm run build:clean
 *   npm run test:child-process:stress
 *
 * Two passes:
 *
 *   1. `tests/stress/child-process.stress.test.ts` — the racing scenarios at
 *      volume (100 iterations each by default), on a fresh database per
 *      iteration, with the complete failing artifact preserved on disk.
 *   2. `tests/build/child-process.test.ts` — the real file, run as itself,
 *      several times. Volume alone would not prove the file passes; running the
 *      file alone would not reach the volume.
 *
 * ## It refuses to build
 *
 * Compiling eight packages while worker children compete for two cores is the
 * A51 pattern, and it is what produced the truncated failure recorded as A55.
 * This script checks the output is present and current, and **stops** if it is
 * not, rather than helpfully building and reintroducing the contention.
 *
 * ## Two kinds of failure, reported differently
 *
 * A non-zero exit from vitest means one of two very different things, and
 * treating them alike wastes an investigation:
 *
 *   **exit 1 - a test failed.** An assertion, a child that exited non-zero, or
 *   a reproduction of A54. A failing iteration leaves its whole database and
 *   both children's output under `stress-logs/child-process/`.
 *
 *   **exit 3 - the harness failed.** Vitest's own reporter RPC timed out
 *   (`Timeout calling "onTaskUpdate"`), or a worker died, while no assertion
 *   failed and no artifact was written. This is the A51 pattern: the machine
 *   was too loaded for the reporter, not the code being wrong.
 *
 * Both are failures and neither is retried or hidden. They are separated so
 * that "the suite is unstable on this machine" is never mistaken for "recovery
 * is broken", nor the reverse.
 *
 * ## The environment this is calibrated for
 *
 *   Node          >= 20. Developed on 25.x; needs a `better-sqlite3` prebuild.
 *   CPU           >= 2 cores. Each iteration spawns two worker processes beside
 *                 the vitest process, so a two-core machine is fully committed -
 *                 deliberately, since contention is what A54 needed to appear.
 *   Concurrency   Nothing else. Never beside `npm run build:clean` or
 *                 `npm test` (A55 / D50).
 *   Duration      Roughly six minutes for 100 iterations on two cores.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const CLI = join(ROOT, 'services', 'worker', 'dist', 'cli.js');
const ARTIFACTS = join(ROOT, 'stress-logs', 'child-process');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? fallback : value;
}

const iterations = Number(arg('iterations', '100'));
const fileRepeats = Number(arg('repeats', '3'));

if (!Number.isInteger(iterations) || iterations < 1) {
  process.stderr.write('--iterations must be a positive whole number\n');
  process.exitCode = 2;
}

// --- the guard --------------------------------------------------------------

function newestSourceMtime(dir) {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) newest = Math.max(newest, newestSourceMtime(full));
    else if (name.endsWith('.ts')) newest = Math.max(newest, stats.mtimeMs);
  }
  return newest;
}

function oldestOutputMtime(dir) {
  if (!existsSync(dir)) return undefined;
  let oldest;
  const walk = (current, inDist) => {
    for (const name of readdirSync(current)) {
      if (name === 'node_modules') continue;
      const full = join(current, name);
      const stats = statSync(full);
      if (stats.isDirectory()) walk(full, inDist || name === 'dist');
      else if (inDist && name.endsWith('.js')) {
        oldest = oldest === undefined ? stats.mtimeMs : Math.min(oldest, stats.mtimeMs);
      }
    }
  };
  walk(dir, false);
  return oldest;
}

function requireCurrentBuild() {
  if (!existsSync(CLI)) {
    process.stderr.write(
      'No compiled worker found.\n\n' +
        '  Run `npm run build:clean` FIRST, and wait for it to finish.\n\n' +
        '  Do not run build and test concurrently on the constrained two-core\n' +
        '  environment: they starve each other, and a run that overlapped a build\n' +
        '  produced four failures whose output was truncated. See A55 / D50.\n',
    );
    process.exit(4);
  }

  const newestSource = Math.max(
    newestSourceMtime(join(ROOT, 'packages')),
    newestSourceMtime(join(ROOT, 'services')),
    newestSourceMtime(join(ROOT, 'apps')),
  );
  let oldestOutput = Number.POSITIVE_INFINITY;
  for (const group of ['packages', 'services', 'apps']) {
    const stamp = oldestOutputMtime(join(ROOT, group));
    if (stamp !== undefined) oldestOutput = Math.min(oldestOutput, stamp);
  }

  if (newestSource > oldestOutput) {
    process.stderr.write(
      'The compiled output is stale: a source file is newer than the build.\n\n' +
        '  Run `npm run build:clean`, wait for it, then run this again.\n' +
        '  This script will not build for you — see A55 / D50.\n',
    );
    process.exit(4);
  }
}

// --- passes -----------------------------------------------------------------

/** Vitest's own machinery giving up, as opposed to a test failing. */
const INFRASTRUCTURE = [
  /Timeout calling "\w+"/,
  /\[vitest-worker\]/,
  /caught \d+ unhandled error/,
  /Failed to terminate worker/,
];

/** A test actually failing. */
const ASSERTION = [/AssertionError/, /Tests\s+\d+ failed/, /A54 REPRODUCED/];

/**
 * Decide which kind of failure this was.
 *
 * A written artifact or a failed assertion is decisive: the code is what
 * failed, whatever else the reporter also did on its way down.
 */
function classify(output) {
  const artifacts = existsSync(ARTIFACTS) && readdirSync(ARTIFACTS).length > 0;
  if (artifacts || ASSERTION.some((rx) => rx.test(output))) return 'ASSERTION';
  if (INFRASTRUCTURE.some((rx) => rx.test(output))) return 'INFRASTRUCTURE';
  return 'UNKNOWN';
}

function runVitest(label, file, env = {}) {
  process.stdout.write(`\n${label}\n`);
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', file, ...configFor(file)],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } },
  );
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (result.status === 0) {
    process.stdout.write(`PASS  ${label} (${seconds}s)\n`);
    return { ok: true, kind: 'PASS' };
  }

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const kind = classify(output);
  process.stdout.write(`FAIL  ${label} (${seconds}s)  [${kind}]\n`);
  // The full output, not a summary: the artifact path is in it.
  process.stdout.write(`${output}\n`);
  return { ok: false, kind };
}

/**
 * Extra vitest arguments per pass.
 *
 * `--reporter=dot` on the stress pass is not cosmetic. Each stress test is one
 * task that runs for minutes without yielding, and the default reporter's
 * `onTaskUpdate` RPC times out under that on a loaded two-core machine — which
 * fails the run with an infrastructure error while every assertion passed. The
 * dot reporter sends far less, so the run reports what the tests actually did.
 *
 * Nothing about the assertions changes; only how much the reporter talks.
 */
const configFor = (file) =>
  file.includes('tests/stress/')
    ? ['--config', 'vitest.stress.config.ts', '--reporter=dot']
    : ['--reporter=dot'];

function main() {
  requireCurrentBuild();

  process.stdout.write(
    `Child-process stress: ${String(iterations)} iterations per scenario, ` +
      `then ${String(fileRepeats)} runs of the real test file.\n` +
      `Cores available: ${String(cpus().length)}.\n`,
  );

  let outcome = runVitest(
    `stress-${String(iterations)}`,
    'tests/stress/child-process.stress.test.ts',
    { TELGA_CHILD_STRESS_ITERATIONS: String(iterations) },
  );

  if (outcome.ok) {
    for (let i = 1; i <= fileRepeats; i += 1) {
      outcome = runVitest(`real-file-run-${String(i)}`, 'tests/build/child-process.test.ts');
      if (!outcome.ok) break;
    }
  }

  if (outcome.ok) {
    process.stdout.write(
      `\nchild-process stress passed: ${String(iterations)} iterations per scenario ` +
        `plus ${String(fileRepeats)} runs of the real file.\n` +
        'A54 was NOT reproduced in this run. That is not the same as resolved.\n',
    );
    return 0;
  }

  if (outcome.kind === 'INFRASTRUCTURE') {
    process.stdout.write(
      '\nchild-process stress FAILED - HARNESS, not code.\n' +
        "  Vitest's own reporter or a worker gave up. No assertion failed and no\n" +
        '  artifact was written, so nothing here says the recovery path is wrong.\n' +
        '  This is the A51 pattern: the machine was too loaded for the reporter.\n' +
        '  Re-run with nothing else running. Do NOT read this as an A54 recurrence.\n',
    );
    return 3;
  }

  process.stdout.write(
    '\nchild-process stress FAILED - a test failed.\n' +
      '  A complete artifact - database rows, audit trail, both worker reports,\n' +
      '  both children output - is under stress-logs/child-process/.\n',
  );
  return 1;
}

process.exitCode = main();
