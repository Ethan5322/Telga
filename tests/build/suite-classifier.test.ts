/**
 * Telling a failed test apart from a failed reporter.
 *
 * `npm test` exits non-zero for two unrelated reasons, and until now the exit
 * code could not distinguish them: a test failed, or **every test passed** and
 * vitest's reporter RPC timed out under CPU starvation. The second is A51, which
 * `09 Engineering/Test Stability Runbook` records as **open by design** — the
 * reporter limit is a property of the machine, so the fix was never to make it
 * impossible, only to make it unmistakable.
 *
 * The classifier is what makes that distinction, so the distinction is what is
 * tested. The samples below are real output shapes, including the run on
 * 2026-09-08 that had *both* a genuine failure and a reporter timeout — the case
 * where getting the precedence wrong would hide a defect.
 */

import { describe, expect, it } from 'vitest';
import { EXIT, classify } from '../../scripts/run-suite.mjs';

/** The A51 signature: reporter gave up, tally shows everything passing. */
const REPORTER_STARVED = `
 ✓ tests/domain/ledger.test.ts (19 tests) 50ms

⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯
Vitest caught 1 unhandled error during the test run.
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 ❯ Object.onTimeoutError node_modules/vitest/dist/chunks/rpc.js:53:10

 Test Files  94 passed (94)
      Tests  1498 passed (1498)
     Errors  1 error
`;

/** An ordinary failing assertion. */
const TEST_FAILED = `
 FAIL  tests/persistence/migration-008.test.ts > leaves the ledger untouched
AssertionError: expected [ 'a' ] to deeply equal [ 'b' ]

 Test Files  1 failed | 93 passed (94)
      Tests  1 failed | 1497 passed (1498)
`;

/**
 * Both at once — the real 2026-09-08 run.
 *
 * A loaded machine starves the reporter *and* a genuine failure is present. If
 * infrastructure won here, a real defect would be reported as "just the
 * machine" and waved through.
 */
const BOTH = `${TEST_FAILED}\n${REPORTER_STARVED}`;

describe('classifying a failed run', () => {
  it('calls a reporter timeout infrastructure when nothing failed', () => {
    expect(classify(REPORTER_STARVED)).toBe('INFRASTRUCTURE');
  });

  it('calls a failed assertion a test failure', () => {
    expect(classify(TEST_FAILED)).toBe('ASSERTION');
  });

  it('lets the assertion win when both appear', () => {
    // The precedence that matters. A run that both failed a test and timed out
    // its reporter is a test failure: the reporter's trouble is a symptom of
    // the same loaded machine and changes nothing about the assertion.
    expect(classify(BOTH)).toBe('ASSERTION');
  });

  it('recognises the other ways vitest gives up', () => {
    for (const output of [
      'Error: [vitest-worker]: Timeout calling "onCollected"',
      'Vitest caught 2 unhandled errors during the test run.',
      'Failed to terminate worker while running tests.',
    ]) {
      expect(classify(output), output).toBe('INFRASTRUCTURE');
    }
  });

  it('refuses to guess, and an unknown failure is treated as a test failure', () => {
    // An unexplained non-zero exit must not be waved through as "just the
    // machine". UNKNOWN maps to exit 1 in the runner.
    expect(classify('something nobody has seen before')).toBe('UNKNOWN');
  });

  it('keeps the three exit codes the runbook names', () => {
    expect(EXIT).toEqual({ ok: 0, testFailed: 1, harnessFailed: 3 });
  });
});
