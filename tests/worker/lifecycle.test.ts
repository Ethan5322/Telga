/**
 * The supervised loop: scheduling, overlap, backoff behaviour, shutdown and health.
 *
 * These drive `RecoveryWorkerLoop` with an injected sweep function, so they test
 * the supervision itself without a database in the way.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SweepReport } from '@telga/api';
import {
  collectingLogger,
  collectingMetrics,
  METRIC,
  RecoveryWorkerLoop,
  ShutdownController,
  assertSafeLogDetail,
  FORBIDDEN_LOG_KEYS,
} from '@telga/worker';
import type { LoopDependencies, WorkerGauges } from '@telga/worker';
import { fakeClock, fakeSignals, policy } from './helpers';
import type { FakeClock } from './helpers';

function report(overrides: Partial<SweepReport> = {}): SweepReport {
  return {
    scanId: 'scan_1',
    startedAt: '2026-08-20T09:00:00.000Z',
    finishedAt: '2026-08-20T09:00:01.000Z',
    found: 2,
    claimed: 2,
    duplicateWorkersPrevented: 0,
    recoveredSuccessful: 1,
    recoveredFailed: 1,
    releasedNeverSubmitted: 0,
    movedToPending: 0,
    escalatedUnderReview: 0,
    skipped: 0,
    recoveryFailures: 0,
    operationalAlerts: 0,
    providerLookupMs: 5,
    stoppedEarly: false,
    results: [],
    ...overrides,
  };
}

const healthyGauges = (): WorkerGauges => ({
  oldestUnresolvedAgeMs: 0,
  pending: 0,
  underReview: 0,
  activeClaims: 0,
  ledgerResidualMinor: 0,
  databaseHealthy: true,
});

interface Built {
  loop: RecoveryWorkerLoop;
  clock: FakeClock;
  shutdown: ShutdownController;
  logger: ReturnType<typeof collectingLogger>;
  metrics: ReturnType<typeof collectingMetrics>;
  released: { count: number };
}

function build(
  overrides: Partial<LoopDependencies> = {},
  options: { stopAfterSleeps?: number; policyOverrides?: Parameters<typeof policy>[0] } = {},
): Built {
  const shutdown = new ShutdownController();
  const clock = fakeClock({ stopAfterSleeps: options.stopAfterSleeps ?? 3, shutdown });
  const logger = collectingLogger();
  const metrics = collectingMetrics();
  const released = { count: 0 };

  const loop = new RecoveryWorkerLoop({
    workerId: 'worker_test',
    policy: policy(options.policyOverrides),
    clock,
    shutdown,
    logger,
    metrics,
    runSweep: () => Promise.resolve(report()),
    gauges: healthyGauges,
    releaseOwnClaims: () => {
      released.count += 1;
      return 2;
    },
    ...overrides,
  });

  return { loop, clock, shutdown, logger, metrics, released };
}

describe('enablement', () => {
  it('does nothing when disabled', async () => {
    const runSweep = vi.fn(() => Promise.resolve(report()));
    const { loop, metrics } = build(
      { runSweep },
      { policyOverrides: { recoveryWorkerEnabled: false } },
    );

    const health = await loop.start();

    expect(runSweep).not.toHaveBeenCalled();
    expect(health.status).toBe('STOPPED');
    expect(metrics.countOf(METRIC.workerStarts)).toBe(0);
  });

  it('logs why it did not start', async () => {
    const { loop, logger } = build({}, { policyOverrides: { recoveryWorkerEnabled: false } });
    await loop.start();
    expect(logger.events.some((e) => e.event === 'worker.disabled')).toBe(true);
  });

  it('runs when enabled', async () => {
    const runSweep = vi.fn(() => Promise.resolve(report()));
    const { loop, metrics } = build({ runSweep }, { stopAfterSleeps: 2 });

    await loop.start();

    expect(runSweep).toHaveBeenCalled();
    expect(metrics.countOf(METRIC.workerStarts)).toBe(1);
    expect(metrics.countOf(METRIC.sweepCompleted)).toBeGreaterThan(0);
  });
});

describe('scheduling', () => {
  it('sweeps immediately when configured to', async () => {
    const calls: number[] = [];
    const { loop, clock } = build(
      { runSweep: () => { calls.push(clock.nowMs()); return Promise.resolve(report()); } },
      { stopAfterSleeps: 1, policyOverrides: { runInitialSweepOnStart: true } },
    );

    await loop.start();
    // The first sweep happened before any sleep.
    expect(calls).toHaveLength(1);
    expect(clock.sleeps.length).toBeGreaterThanOrEqual(1);
  });

  it('waits one interval first when configured to', async () => {
    const { loop, clock } = build(
      {},
      { stopAfterSleeps: 1, policyOverrides: { runInitialSweepOnStart: false, recoveryIntervalMs: 5_000 } },
    );

    await loop.start();
    expect(clock.sleeps[0]).toBe(5_000);
  });

  it('respects the configured interval between sweeps', async () => {
    const { loop, clock } = build(
      {},
      { stopAfterSleeps: 3, policyOverrides: { recoveryIntervalMs: 7_000, recoveryJitterMs: 0 } },
    );

    await loop.start();
    const scheduling = clock.sleeps.filter((ms) => ms === 7_000);
    expect(scheduling.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps jitter within the configured bound', async () => {
    const shutdown = new ShutdownController();
    const clock = fakeClock({ stopAfterSleeps: 6, shutdown, random: 0.99 });
    const loop = new RecoveryWorkerLoop({
      workerId: 'worker_jitter',
      policy: policy({ recoveryIntervalMs: 10_000, recoveryJitterMs: 1_000 }),
      clock,
      shutdown,
      logger: collectingLogger(),
      metrics: collectingMetrics(),
      runSweep: () => Promise.resolve(report()),
      gauges: healthyGauges,
    });

    await loop.start();

    const scheduling = clock.sleeps.filter((ms) => ms >= 10_000);
    expect(scheduling.length).toBeGreaterThan(0);
    for (const ms of scheduling) {
      expect(ms).toBeGreaterThanOrEqual(10_000);
      expect(ms).toBeLessThanOrEqual(11_000);
    }
  });

  it('never runs two sweeps at once', async () => {
    let active = 0;
    let maxActive = 0;
    const { loop } = build(
      {
        runSweep: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          active -= 1;
          return report();
        },
      },
      { stopAfterSleeps: 4 },
    );

    await loop.start();
    expect(maxActive).toBe(1);
  });

  it('records an overlapping runOnce as skipped rather than running it', async () => {
    const shutdown = new ShutdownController();
    const clock = fakeClock({ shutdown });
    const metrics = collectingMetrics();
    let release!: () => void;

    const loop = new RecoveryWorkerLoop({
      workerId: 'worker_overlap',
      policy: policy(),
      clock,
      shutdown,
      logger: collectingLogger(),
      metrics,
      runSweep: () =>
        new Promise<SweepReport>((resolve) => {
          release = () => resolve(report());
        }),
      gauges: healthyGauges,
    });

    const first = loop.runOnce();
    const second = await loop.runOnce();

    expect(second).toBeUndefined();
    expect(metrics.countOf(METRIC.sweepSkipped)).toBe(1);

    release();
    await first;
    expect(loop.health().sweepsSkipped).toBe(1);
  });

  it('a slow sweep does not cause a runaway loop', async () => {
    // Each sweep takes four intervals. Fixed-delay scheduling means the next
    // sleep is still a full interval, not zero.
    const { loop, clock } = build(
      {
        runSweep: () => {
          clock.advance(40_000);
          return Promise.resolve(report());
        },
      },
      { stopAfterSleeps: 3, policyOverrides: { recoveryIntervalMs: 10_000, recoveryJitterMs: 0 } },
    );

    await loop.start();

    for (const ms of clock.sleeps) {
      expect(ms).toBeGreaterThan(0);
    }
    expect(clock.sleeps.every((ms) => ms === 10_000)).toBe(true);
  });

  it('passes the shutdown check into the sweep as its safe boundary', async () => {
    const seen: boolean[] = [];
    const { loop, shutdown } = build(
      {
        runSweep: (options) => {
          seen.push(typeof options.shouldContinue === 'function');
          expect(options.shouldContinue?.()).toBe(!shutdown.stopRequested);
          return Promise.resolve(report());
        },
      },
      { stopAfterSleeps: 1 },
    );

    await loop.start();
    expect(seen[0]).toBe(true);
  });
});

describe('failure and backoff', () => {
  const failing = (error: Error) => () => Promise.reject(error);

  it('backs off after a failure and records it', async () => {
    const { loop, clock, metrics } = build(
      { runSweep: failing(new Error('boom')) },
      { stopAfterSleeps: 1, policyOverrides: { failureBackoffInitialMs: 2_000, recoveryJitterMs: 0 } },
    );

    await loop.start();

    expect(clock.sleeps[0]).toBe(2_000);
    expect(metrics.countOf(METRIC.sweepFailed)).toBe(1);
    expect(metrics.countOf(METRIC.backoffEvents)).toBe(1);
  });

  it('increases backoff across repeated failures', async () => {
    const { loop, clock } = build(
      { runSweep: failing(new Error('boom')) },
      {
        stopAfterSleeps: 3,
        policyOverrides: { failureBackoffInitialMs: 1_000, failureBackoffMultiplier: 2, recoveryJitterMs: 0 },
      },
    );

    await loop.start();
    expect(clock.sleeps.slice(0, 3)).toEqual([1_000, 2_000, 4_000]);
  });

  it('resets backoff after a success', async () => {
    let calls = 0;
    const { loop, clock } = build(
      {
        runSweep: () => {
          calls += 1;
          if (calls <= 2) return Promise.reject(new Error('boom'));
          return Promise.resolve(report());
        },
      },
      {
        stopAfterSleeps: 4,
        policyOverrides: { recoveryIntervalMs: 9_000, failureBackoffInitialMs: 1_000, recoveryJitterMs: 0 },
      },
    );

    const health = await loop.start();

    expect(clock.sleeps.slice(0, 3)).toEqual([1_000, 2_000, 9_000]);
    expect(health.consecutiveFailures).toBe(0);
  });

  it('classifies a provider failure and keeps going', async () => {
    const error = new Error('unreachable');
    error.name = 'ProviderUnavailableError';
    const { loop, metrics } = build({ runSweep: failing(error) }, { stopAfterSleeps: 2 });

    const health = await loop.start();

    expect(health.lastFailure?.category).toBe('PROVIDER_ADAPTER');
    expect(health.status).toBe('STOPPED');
    expect(metrics.countOf(METRIC.providerStatusErrors)).toBeGreaterThan(0);
  });

  it('stops the worker on a database failure rather than retrying into it', async () => {
    const error = new Error('cannot open');
    Object.assign(error, { code: 'SQLITE_CANTOPEN' });
    const { loop, metrics, shutdown } = build({ runSweep: failing(error) }, { stopAfterSleeps: 5 });

    const health = await loop.start();

    expect(health.status).toBe('FAILED');
    expect(health.lastFailure?.category).toBe('DATABASE_CONNECTION');
    expect(health.lastFailure?.fatal).toBe(true);
    expect(shutdown.reason).toBe('FATAL_FAILURE');
    expect(metrics.countOf(METRIC.databaseErrors)).toBe(1);
  });

  it('a sweep reporting per-transaction failures is still a successful sweep', async () => {
    const { loop } = build(
      { runSweep: () => Promise.resolve(report({ recoveryFailures: 2 })) },
      { stopAfterSleeps: 1 },
    );

    const health = await loop.start();
    expect(health.sweepsCompleted).toBe(1);
    expect(health.sweepsFailed).toBe(0);
    expect(health.lastSweepReport?.recoveryFailures).toBe(2);
  });

  it('never hides a failure', async () => {
    const { loop, logger } = build({ runSweep: failing(new Error('boom')) }, { stopAfterSleeps: 1 });
    await loop.start();

    const failure = logger.events.find((e) => e.event === 'worker.sweep.failed');
    expect(failure).toBeDefined();
    expect(failure?.level).toBe('warn');
    expect(failure?.errorCode).toBeDefined();
  });
});

describe('shutdown', () => {
  it('SIGTERM stops new work', async () => {
    const signals = fakeSignals();
    const shutdown = new ShutdownController();
    shutdown.install(signals);

    let sweeps = 0;
    const clock = fakeClock({ shutdown });
    const loop = new RecoveryWorkerLoop({
      workerId: 'worker_sigterm',
      policy: policy(),
      clock,
      shutdown,
      logger: collectingLogger(),
      metrics: collectingMetrics(),
      runSweep: () => {
        sweeps += 1;
        if (sweeps === 1) signals.emit('SIGTERM');
        return Promise.resolve(report());
      },
      gauges: healthyGauges,
    });

    const health = await loop.start();

    expect(sweeps).toBe(1);
    expect(shutdown.reason).toBe('SIGTERM');
    expect(health.status).toBe('STOPPED');
    shutdown.dispose();
  });

  it('SIGINT stops new work', async () => {
    const signals = fakeSignals();
    const shutdown = new ShutdownController();
    shutdown.install(signals);
    const clock = fakeClock({ shutdown });

    let sweeps = 0;
    const loop = new RecoveryWorkerLoop({
      workerId: 'worker_sigint',
      policy: policy(),
      clock,
      shutdown,
      logger: collectingLogger(),
      metrics: collectingMetrics(),
      runSweep: () => {
        sweeps += 1;
        signals.emit('SIGINT');
        return Promise.resolve(report());
      },
      gauges: healthyGauges,
    });

    await loop.start();
    expect(sweeps).toBe(1);
    expect(shutdown.reason).toBe('SIGINT');
    shutdown.dispose();
  });

  it('is idempotent — a second request keeps the first reason', () => {
    const shutdown = new ShutdownController();
    shutdown.requestStop('SIGTERM');
    shutdown.requestStop('SIGINT');
    expect(shutdown.reason).toBe('SIGTERM');
  });

  it('notifies listeners exactly once', () => {
    const shutdown = new ShutdownController();
    const listener = vi.fn();
    shutdown.onStop(listener);
    shutdown.requestStop();
    shutdown.requestStop();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('releases only its own claims', async () => {
    const { loop, released } = build({}, { stopAfterSleeps: 1 });
    await loop.start();
    expect(released.count).toBe(1);
  });

  it('closes resources through onStopped', async () => {
    const onStopped = vi.fn();
    const { loop } = build({ onStopped }, { stopAfterSleeps: 1 });
    await loop.start();
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  it('survives a failure to release claims', async () => {
    const { loop } = build(
      {
        releaseOwnClaims: () => {
          throw new Error('release failed');
        },
      },
      { stopAfterSleeps: 1 },
    );

    const health = await loop.start();
    expect(health.status).toBe('STOPPED');
  });

  it('logs a shutdown event with a duration', async () => {
    const { loop, logger, metrics } = build({}, { stopAfterSleeps: 1 });
    await loop.start();

    const stopped = logger.events.find((e) => e.event === 'worker.stopped');
    expect(stopped).toBeDefined();
    expect(metrics.observations.get(METRIC.shutdownDurationMs)).toBeDefined();
  });

  it('uninstalls its signal handlers on dispose', () => {
    const signals = fakeSignals();
    const shutdown = new ShutdownController();
    const uninstall = shutdown.install(signals);
    expect(signals.handlers).toBe(2);
    uninstall();
    expect(signals.handlers).toBe(0);
  });
});

describe('health', () => {
  it('is healthy after a successful sweep', async () => {
    const { loop } = build({}, { stopAfterSleeps: 1 });
    await loop.start();
    const health = loop.health();

    expect(health.lastSuccessfulSweepAt).toBeDefined();
    expect(health.sweepsCompleted).toBe(1);
    expect(health.consecutiveFailures).toBe(0);
  });

  it('is degraded while backing off', async () => {
    const shutdown = new ShutdownController();
    const clock = fakeClock({ shutdown });
    const loop = new RecoveryWorkerLoop({
      workerId: 'worker_degraded',
      policy: policy(),
      clock,
      shutdown,
      logger: collectingLogger(),
      metrics: collectingMetrics(),
      runSweep: () => Promise.reject(new Error('boom')),
      gauges: healthyGauges,
    });

    await loop.runOnce();
    const health = loop.health();

    expect(health.status).toBe('BACKING_OFF');
    expect(health.level).toBe('DEGRADED');
    expect(health.consecutiveFailures).toBe(1);
  });

  it('is unhealthy when the ledger residual is non-zero', async () => {
    const { loop } = build(
      { gauges: () => ({ ...healthyGauges(), ledgerResidualMinor: 25 }) },
      { stopAfterSleeps: 1 },
    );
    await loop.start();
    expect(loop.health().level).toBe('UNHEALTHY');
  });

  it('is unhealthy when the database is unhealthy', async () => {
    const { loop } = build(
      { gauges: () => ({ ...healthyGauges(), databaseHealthy: false }) },
      { stopAfterSleeps: 1 },
    );
    await loop.start();
    expect(loop.health().level).toBe('UNHEALTHY');
  });

  it('is degraded when the oldest unresolved transaction is too old', async () => {
    const shutdown = new ShutdownController();
    const clock = fakeClock({ shutdown });
    const loop = new RecoveryWorkerLoop({
      workerId: 'worker_old',
      policy: policy(),
      clock,
      shutdown,
      logger: collectingLogger(),
      metrics: collectingMetrics(),
      runSweep: () => Promise.resolve(report()),
      gauges: () => ({ ...healthyGauges(), oldestUnresolvedAgeMs: 60 * 60_000 }),
    });

    await loop.runOnce();
    expect(loop.health().level).toBe('DEGRADED');
  });

  it('reports the oldest unresolved transaction and active claims', async () => {
    const { loop } = build(
      { gauges: () => ({ ...healthyGauges(), oldestUnresolvedAgeMs: 1_234, activeClaims: 3 }) },
      { stopAfterSleeps: 1 },
    );
    await loop.start();

    const health = loop.health();
    expect(health.oldestUnresolvedAgeMs).toBe(1_234);
    expect(health.activeClaims).toBe(3);
  });

  it('survives a gauge read that throws', async () => {
    const { loop } = build(
      {
        gauges: () => {
          throw new Error('db gone');
        },
      },
      { stopAfterSleeps: 1 },
    );

    const health = await loop.start();
    expect(health.level).toBe('UNHEALTHY');
    expect(health.databaseHealthy).toBe(false);
  });
});

describe('metrics and logging', () => {
  it('emits each sweep metric once per sweep', async () => {
    const { loop, metrics } = build({}, { stopAfterSleeps: 2 });
    await loop.start();

    const started = metrics.countOf(METRIC.sweepStarted);
    expect(metrics.countOf(METRIC.sweepCompleted)).toBe(started);
    expect(metrics.countOf(METRIC.found)).toBe(started * 2);
    expect(metrics.observations.get(METRIC.sweepDurationMs)).toHaveLength(started);
  });

  it('publishes queue gauges', async () => {
    const { loop, metrics } = build(
      { gauges: () => ({ ...healthyGauges(), pending: 4, underReview: 2, activeClaims: 1 }) },
      { stopAfterSleeps: 1 },
    );
    await loop.start();

    expect(metrics.gauges.get(METRIC.pendingQueueSize)).toBe(4);
    expect(metrics.gauges.get(METRIC.underReviewQueueSize)).toBe(2);
    expect(metrics.gauges.get(METRIC.activeClaims)).toBe(1);
  });

  it('includes worker and sweep identifiers on log events', async () => {
    const { loop, logger } = build({}, { stopAfterSleeps: 1 });
    await loop.start();

    const completed = logger.events.find((e) => e.event === 'worker.sweep.completed');
    expect(completed?.workerId).toBe('worker_test');
    expect(completed?.sweepId).toBe('scan_1');
    expect(completed?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('refuses to log a sensitive key', () => {
    for (const key of FORBIDDEN_LOG_KEYS) {
      expect(() => {
        assertSafeLogDetail({ [key]: 'x' });
      }).toThrow(/sensitive/i);
    }
  });

  it('allows safe detail', () => {
    expect(() => {
      assertSafeLogDetail({ found: 3, workerId: 'w1', stoppedEarly: false });
    }).not.toThrow();
  });
});
