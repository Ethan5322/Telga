/**
 * Types for `run-suite.mjs`.
 *
 * The script stays JavaScript because it is a command the toolchain runs
 * directly, before and independently of any build — a compiled runner could not
 * be used to diagnose a broken build. This declaration exists so that
 * `tests/build/suite-classifier.test.ts` can import `classify` and hold it to
 * the same type checking as everything else.
 *
 * Only the pure, importable surface is declared. `main()` is deliberately not
 * exported: it spawns a test run, and nothing but the command line should be
 * able to start one.
 */

/** Which kind of failure a non-zero vitest run was. */
export type FailureKind = 'ASSERTION' | 'INFRASTRUCTURE' | 'UNKNOWN';

/**
 * Classify captured vitest output.
 *
 * An assertion failure wins over an infrastructure signature: a run that both
 * failed a test and starved its reporter is a test failure.
 */
export function classify(output: string): FailureKind;

/** `0` passed · `1` a test failed · `3` the harness failed (A51). */
export const EXIT: {
  readonly ok: 0;
  readonly testFailed: 1;
  readonly harnessFailed: 3;
};
