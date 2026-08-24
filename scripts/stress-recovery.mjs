#!/usr/bin/env node
/**
 * Recovery stress runner — the A44 reproduction command.
 *
 * Two complementary passes, because the two failures seen so far had different
 * shapes:
 *
 *   1. **Soak.** The escalation scenario many times over, each on a fresh
 *      database, in one process. Catches a defect in the logic itself.
 *   2. **Shuffled repeats.** The whole recovery suite, several times, with
 *      randomised test order. Catches order dependence and leaked state — the
 *      class of problem a single isolated run can never find.
 *
 * ## A57-adjacent defect, found and fixed here
 *
 * The soak pass used to run `vitest --config vitest.stress.config.ts` with no
 * file argument. That config's `include` glob matches every file under
 * `tests/stress/`, which is **two** unrelated scenarios: this one, and the
 * A54 multi-process test — which needs a compiled worker binary the
 * `recovery stress` CI job never builds. Every remote run was silently also
 * running A54's scenario, which failed immediately on its own missing-build
 * guard, and reporting that failure under the label `soak-200` — a scenario
 * that was never actually broken. Confirmed by reproducing with the build
 * removed: `Test Files 1 failed | 1 passed (2)`, the failure entirely inside
 * `child-process.stress.test.ts`, while the real A44 soak passed. Fixed by
 * scoping the soak invocation to its own file, matching how
 * `stress-child-process.mjs` already scopes its own two invocations.
 *
 * ## Two kinds of failure, reported differently
 *
 * A non-zero exit from a pass means one of two very different things, and
 * treating them alike wastes an investigation — see `stress-child-process.mjs`
 * for the original statement of this. In short: an assertion failing (or a
 * written artifact) is decisive and reported as **ASSERTION**; a reporter or
 * worker giving up with no assertion failed is **INFRASTRUCTURE** — the A51
 * pattern. Neither is retried or hidden.
 *
 * Exits non-zero on any failure, and leaves the failing output on disk *and*
 * prints it in full, so CI's own job log carries the real diagnostic without
 * a separate download.
 *
 * Usage:
 *   node scripts/stress-recovery.mjs
 *   node scripts/stress-recovery.mjs --iterations 500 --repeats 10
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOG_DIR = join(ROOT, 'stress-logs');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1] !== undefined) return process.argv[index + 1];
  return fallback;
}

const iterations = arg('iterations', '120');
const repeats = Number(arg('repeats', '5'));

/** Vitest's own machinery giving up, as opposed to a test failing. */
const INFRASTRUCTURE = [
  /Timeout calling "\w+"/,
  /\[vitest-worker\]/,
  /caught \d+ unhandled error/,
  /Failed to terminate worker/,
];

/** A test actually failing. */
const ASSERTION = [/AssertionError/, /Tests\s+\d+ failed/, /A44 REPRODUCED/];

/** Same decision rule as `stress-child-process.mjs`: an assertion is decisive. */
function classify(output) {
  if (ASSERTION.some((rx) => rx.test(output))) return 'ASSERTION';
  if (INFRASTRUCTURE.some((rx) => rx.test(output))) return 'INFRASTRUCTURE';
  return 'UNKNOWN';
}

/**
 * The soak pass only ever spawns one vitest file. If a future edit to
 * `vitest.stress.config.ts` or this script's own arguments widens that again,
 * this is the guard that catches it — a silently-included second file is
 * exactly the A57-adjacent defect this file was just fixed for.
 */
function checkSingleFile(output, label) {
  const match = /Test Files\s+(?:\d+\s+\w+\s*\|\s*)*(\d+)\s+\w+\s*\((\d+)\)/.exec(output);
  if (match && Number(match[2]) !== 1) {
    return `${label} ran ${match[2]} test files, not 1 — the vitest invocation is scoped too broadly again`;
  }
  return undefined;
}

const results = [];

function record(label, result, { expectSingleFile = false } = {}) {
  const ok = result.status === 0;
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

  const scopeProblem = expectSingleFile ? checkSingleFile(output, label) : undefined;

  if (ok && !scopeProblem) {
    console.log(`PASS  ${label}`);
    results.push({ label, ok: true });
    return;
  }

  const kind = scopeProblem ? 'HARNESS' : classify(output);
  console.log(`FAIL  ${label}  [${kind}]`);
  if (scopeProblem) console.error(`  ${scopeProblem}`);
  mkdirSync(LOG_DIR, { recursive: true });
  const file = join(LOG_DIR, `${label.replace(/[^a-z0-9]+/gi, '-')}.log`);
  writeFileSync(file, output);
  console.error(`  output written to ${file}`);
  // Printed in full, not just saved: this is what lets a CI job log show the
  // real failure without a separate artifact download.
  console.error(output);
  results.push({ label, ok: false, kind });
}

console.log(`Recovery stress: ${iterations} soak iterations, ${String(repeats)} shuffled repeats\n`);

// Pass 1 — the soak. Scoped to its own file — see the A57-adjacent note above.
record(
  `soak-${iterations}`,
  spawnSync(
    process.execPath,
    [
      join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      'tests/stress/recovery-manual-review.stress.test.ts',
      '--config',
      'vitest.stress.config.ts',
      '--reporter=dot',
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, TELGA_STRESS_ITERATIONS: iterations, CI: '1' },
    },
  ),
  { expectSingleFile: true },
);

// Pass 2 — shuffled repeats of the real recovery and worker suites.
for (let i = 1; i <= repeats; i += 1) {
  const seed = String(Date.now() + i);
  record(
    `shuffled-repeat-${String(i)}-seed-${seed}`,
    spawnSync(
      process.execPath,
      [
        join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        'tests/recovery/',
        'tests/worker/',
        '--sequence.shuffle',
        '--sequence.seed',
        seed,
        '--testTimeout=180000',
        '--reporter=dot',
      ],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CI: '1' } },
    ),
  );
}

console.log('');
const failures = results.filter((r) => !r.ok);
if (failures.length > 0) {
  console.error(`stress FAILED: ${String(failures.length)} of ${String(repeats + 1)} passes failed`);
  for (const f of failures) console.error(`  - ${f.label} [${f.kind}]`);

  // An assertion (or a harness-scope defect actually changing what ran) is
  // decisive, whatever infrastructure noise happened alongside it.
  const decisive = failures.some((f) => f.kind === 'ASSERTION' || f.kind === 'HARNESS');
  if (!decisive) {
    console.error(
      '\nEvery failure here was the harness giving up (reporter or worker timeout), not an\n' +
        'assertion. This is the A51 pattern: re-run with nothing else competing for CPU\n' +
        'before treating this as a recovery defect.',
    );
    process.exit(3);
  }
  process.exit(1);
}
console.log(`stress passed: soak of ${iterations} iterations plus ${String(repeats)} shuffled repeats`);
