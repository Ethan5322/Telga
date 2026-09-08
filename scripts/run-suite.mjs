/**
 * Run the test suite and say which kind of failure a failure was.
 *
 * ## Why this exists
 *
 * `npm test` was `vitest run`. On a loaded machine that exits **1** for two
 * completely different reasons, and the exit code cannot tell them apart:
 *
 *   - a test failed;
 *   - **every test passed** and vitest's own reporter RPC timed out —
 *     `Timeout calling "onTaskUpdate"`.
 *
 * The second is **A51**, diagnosed in `09 Engineering/Test Stability Runbook`.
 * Its root cause is CPU starvation on a two-core box, not a race: a long
 * non-yielding task exceeds the reporter's five-second round trip. The runbook
 * is explicit that A51 **stays open** — *"the reporter limit is a property of
 * this machine under load; it can recur"* — so the permanent fix was never
 * going to be making it impossible. It is making it **unmistakable**.
 *
 * `scripts/stress-child-process.mjs` already did exactly this for the stress
 * passes, and the same reasoning applies to the whole suite. This is that
 * mechanism, applied where it was missing.
 *
 * ## Exit codes
 *
 * | Exit | Meaning |
 * |---|---|
 * | `0` | Everything passed |
 * | `1` | **A test failed.** An assertion, or vitest's own `Tests N failed` line |
 * | `3` | **The harness failed.** Reporter RPC timeout or a dead worker, **and** no assertion failed |
 *
 * Both non-zero codes are failures. Neither is retried and neither is hidden —
 * CI fails on both. They are separated so that a green codebase on a busy
 * laptop is not read as a broken one, and so that nobody "fixes" a defect that
 * was never there.
 *
 * **An assertion failure is decisive.** If any test genuinely failed, that is
 * the answer, whatever else the reporter did on its way down. Only when no
 * assertion failed is a run called infrastructure.
 *
 * ## Two things this also fixes
 *
 * **Silence.** A full run takes about twenty minutes here, and piping
 * `vitest run` to a file produced *zero bytes* until it finished — so a run in
 * progress was indistinguishable from a hung one. Output is streamed through as
 * it arrives.
 *
 * **Reporter volume.** When stdout is not a terminal — CI, a background run,
 * a redirect to a file — the dot reporter is used. It sends far less over the
 * RPC that A51 is about, which is precisely when nobody is watching the
 * per-file list anyway. On a terminal the normal reporter is kept.
 *
 * Nothing here changes what any test asserts.
 *
 * Usage:
 *   node scripts/run-suite.mjs                    # the whole suite
 *   node scripts/run-suite.mjs tests/domain       # a subset
 *   node scripts/run-suite.mjs --reporter=verbose # any vitest argument
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const EXIT = Object.freeze({ ok: 0, testFailed: 1, harnessFailed: 3 });

/** Vitest's own machinery giving up, rather than a test failing. */
const INFRASTRUCTURE = [
  /Timeout calling "\w+"/,
  /\[vitest-worker\]/,
  /caught \d+ unhandled error/,
  /Failed to terminate worker/,
];

/**
 * A test actually failing.
 *
 * `Tests N failed` is vitest's own tally and is the reliable signal;
 * `AssertionError` catches a failure that killed the run before the tally was
 * printed.
 */
const ASSERTION = [/AssertionError/, /Tests\s+\d+ failed/, /\d+ failed \|/];

/**
 * Which kind of failure this was.
 *
 * Order matters: an assertion is checked first and wins. A run that both failed
 * a test and timed out its reporter is a **test failure** — the reporter's
 * trouble is a symptom of the same loaded machine and changes nothing about the
 * assertion that did not hold.
 */
export function classify(output) {
  if (ASSERTION.some((rx) => rx.test(output))) return 'ASSERTION';
  if (INFRASTRUCTURE.some((rx) => rx.test(output))) return 'INFRASTRUCTURE';
  return 'UNKNOWN';
}

const ROOT = new URL('..', import.meta.url);

function main(args) {
  // The dot reporter only when nobody is watching a terminal. Not cosmetic: it
  // is the A51 mitigation the runbook prescribes, and a redirected run is
  // exactly the loaded, unattended case where starvation happens.
  const reporter =
    args.some((a) => a.startsWith('--reporter')) || process.stdout.isTTY
      ? []
      : ['--reporter=dot'];

  // Vitest's own entry point under this Node, rather than `npx` through a
  // shell. `shell: true` on Windows concatenates arguments instead of escaping
  // them, which Node now warns about (DEP0190) and which would mangle any
  // argument containing a space.
  const vitest = fileURLToPath(new URL('node_modules/vitest/vitest.mjs', ROOT));
  const child = spawn(process.execPath, [vitest, 'run', ...reporter, ...args], {
    cwd: fileURLToPath(ROOT),
  });

  let captured = '';
  const tee = (stream, into) => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      captured += chunk;
      into.write(chunk);
    });
  };
  tee(child.stdout, process.stdout);
  tee(child.stderr, process.stderr);

  child.on('error', (error) => {
    process.stderr.write(`\nCould not start vitest: ${error.message}\n`);
    process.exit(EXIT.harnessFailed);
  });

  child.on('close', (code) => {
    if (code === 0) process.exit(EXIT.ok);

    const kind = classify(captured);
    if (kind === 'INFRASTRUCTURE') {
      process.stderr.write(
        '\n' +
          '──────────────────────────────────────────────────────────────\n' +
          'HARNESS FAILURE, NOT A TEST FAILURE (A51)\n' +
          '\n' +
          "Vitest's reporter gave up while no assertion failed. This is CPU\n" +
          'starvation under load, not a defect — see\n' +
          'docs/obsidian/09 Engineering/Test Stability Runbook.md.\n' +
          '\n' +
          'Re-run with nothing else running. Do not "fix" a test on this.\n' +
          '──────────────────────────────────────────────────────────────\n',
      );
      process.exit(EXIT.harnessFailed);
    }

    if (kind === 'UNKNOWN') {
      // Neither pattern matched. Reported as a test failure, deliberately: an
      // unexplained non-zero exit must not be waved through as infrastructure.
      process.stderr.write(
        `\nvitest exited ${String(code)} and the output matched no known pattern. ` +
          'Treated as a test failure.\n',
      );
    }
    process.exit(EXIT.testFailed);
  });
}

// Only when run as a command. Importing this module — which
// `tests/build/suite-classifier.test.ts` does, to test `classify` — must not
// start a nested test run. It did, before this guard.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) main(process.argv.slice(2));
