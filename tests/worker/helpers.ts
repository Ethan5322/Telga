/**
 * Worker test fixtures.
 *
 * The fake clock resolves every sleep immediately while advancing virtual time,
 * so a loop that would take minutes runs in milliseconds and every scheduling
 * decision is still observable. It also stops the loop after a set number of
 * sleeps, which is what keeps an infinite supervised loop finite in a test.
 */

import { timestamp } from '@telga/domain';
import type { Timestamp } from '@telga/domain';
import { ShutdownController, TEST_RECOVERY_WORKER_POLICY } from '@telga/worker';
import type { RecoveryWorkerPolicy, WorkerClock, SignalSource } from '@telga/worker';

export const BASE_TIME = Date.parse('2026-08-20T09:00:00.000Z');

export interface FakeClock extends WorkerClock {
  /** Every sleep duration requested, in order. */
  readonly sleeps: readonly number[];
  advance(ms: number): void;
  setRandom(value: number): void;
  nowMs(): number;
}

export interface FakeClockOptions {
  /** Request shutdown after this many sleeps, so the loop terminates. */
  readonly stopAfterSleeps?: number;
  readonly shutdown?: ShutdownController;
  readonly random?: number;
  readonly startMs?: number;
}

export function fakeClock(options: FakeClockOptions = {}): FakeClock {
  let ms = options.startMs ?? BASE_TIME;
  let random = options.random ?? 0;
  const sleeps: number[] = [];

  return {
    sleeps,
    nowMs: () => ms,
    now: (): Timestamp => timestamp(new Date(ms).toISOString()),
    monotonicMs: () => ms,
    random: () => random,
    setRandom(value) {
      random = value;
    },
    advance(by) {
      ms += by;
    },
    sleep(duration) {
      sleeps.push(duration);
      ms += Math.max(0, duration);
      if (
        options.stopAfterSleeps !== undefined &&
        sleeps.length >= options.stopAfterSleeps &&
        options.shutdown
      ) {
        options.shutdown.requestStop('REQUESTED');
      }
      return Promise.resolve();
    },
  };
}

/** A signal emitter a test can fire without touching the real process. */
export function fakeSignals(): SignalSource & { emit(signal: string): void; readonly handlers: number } {
  const handlers = new Map<string, Set<() => void>>();
  return {
    get handlers() {
      return [...handlers.values()].reduce((n, set) => n + set.size, 0);
    },
    on(signal, handler) {
      const set = handlers.get(signal) ?? new Set();
      set.add(handler);
      handlers.set(signal, set);
      return this;
    },
    off(signal, handler) {
      handlers.get(signal)?.delete(handler);
      return this;
    },
    emit(signal) {
      for (const handler of handlers.get(signal) ?? []) handler();
    },
  };
}

export const policy = (overrides: Partial<RecoveryWorkerPolicy> = {}): RecoveryWorkerPolicy => ({
  ...TEST_RECOVERY_WORKER_POLICY,
  ...overrides,
});

/** Production-style configuration source, for `productionPolicyFrom`. */
export function productionSource(
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    TELGA_RECOVERY_WORKER_ENABLED: 'true',
    TELGA_RECOVERY_INTERVAL_MS: '30000',
    TELGA_RECOVERY_JITTER_MS: '5000',
    TELGA_RECOVERY_BATCH_LIMIT: '100',
    TELGA_RECOVERY_AGE_MS: '60000',
    TELGA_PENDING_MAXIMUM_MS: '300000',
    TELGA_MAX_STATUS_ATTEMPTS: '5',
    TELGA_CLAIM_LEASE_MS: '30000',
    TELGA_STATUS_CHECK_INTERVAL_MS: '30000',
    TELGA_FAILURE_BACKOFF_INITIAL_MS: '1000',
    TELGA_FAILURE_BACKOFF_MAXIMUM_MS: '60000',
    TELGA_FAILURE_BACKOFF_MULTIPLIER: '2',
    TELGA_GRACEFUL_SHUTDOWN_TIMEOUT_MS: '10000',
    TELGA_RUN_INITIAL_SWEEP_ON_START: 'true',
    ...overrides,
  };
}
