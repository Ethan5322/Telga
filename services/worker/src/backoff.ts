/**
 * Exponential backoff with jitter.
 *
 * Pure functions over an explicit state object and an injected random source,
 * so a test can assert the exact delay for a given failure count.
 *
 * Jitter matters more than it looks: without it, every worker that failed
 * against the same outage retries at the same instant, and the recovery from an
 * outage becomes a second outage.
 */

import type { RecoveryWorkerPolicy } from './workerConfig';

export interface BackoffState {
  readonly consecutiveFailures: number;
  /** The delay applied after the most recent failure, jitter included. */
  readonly currentDelayMs: number;
}

export const initialBackoffState = (): BackoffState =>
  Object.freeze({ consecutiveFailures: 0, currentDelayMs: 0 });

/** The delay before jitter, for `n` consecutive failures. Capped. */
export function baseBackoffMs(policy: RecoveryWorkerPolicy, consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const raw =
    policy.failureBackoffInitialMs * Math.pow(policy.failureBackoffMultiplier, consecutiveFailures - 1);
  return Math.min(raw, policy.failureBackoffMaximumMs);
}

/**
 * Advance the backoff after a failure.
 *
 * Jitter is added on top of the capped base and is itself bounded by
 * `recoveryJitterMs`, so the delay never exceeds `maximum + jitter`.
 */
export function advanceBackoff(
  policy: RecoveryWorkerPolicy,
  state: BackoffState,
  random: () => number,
): BackoffState {
  const consecutiveFailures = state.consecutiveFailures + 1;
  const base = baseBackoffMs(policy, consecutiveFailures);
  const jitter = Math.floor(random() * policy.recoveryJitterMs);
  return Object.freeze({ consecutiveFailures, currentDelayMs: base + jitter });
}

/** A successful sweep clears the failure history entirely. */
export const resetBackoff = (): BackoffState => initialBackoffState();

export const isBackingOff = (state: BackoffState): boolean => state.consecutiveFailures > 0;

/**
 * The delay before the next sweep.
 *
 * Under failure the backoff replaces the interval rather than adding to it —
 * a worker in backoff is deliberately slower, not merely late.
 */
export function nextDelayMs(
  policy: RecoveryWorkerPolicy,
  state: BackoffState,
  random: () => number,
): number {
  if (isBackingOff(state)) return state.currentDelayMs;
  const jitter = Math.floor(random() * policy.recoveryJitterMs);
  return policy.recoveryIntervalMs + jitter;
}
