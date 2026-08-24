/**
 * The supervised sweep loop.
 *
 * ## Scheduling is fixed-delay, not fixed-rate
 *
 * The next sweep is scheduled from the **end** of the previous one. Fixed-rate
 * scheduling — "every N ms from a start point" — degenerates into continuous
 * execution the moment a sweep takes longer than its interval: the scheduler
 * spends the rest of its life catching up on a backlog it can never clear.
 * Fixed delay cannot run away.
 *
 * ## Real time lives here and nowhere below
 *
 * `WorkerClock` is the only place a system clock is read. The recovery service
 * and everything under it take time as an argument, so this boundary is what
 * keeps them testable.
 */

import type { Timestamp } from '@telga/domain';
import { timestamp } from '@telga/domain';
import type { SweepOptions, SweepReport } from '@telga/api';
import type { BackoffState } from './backoff';
import { advanceBackoff, initialBackoffState, nextDelayMs, resetBackoff } from './backoff';
import { classifyWorkerFailure } from './failures';
import type { ClassifiedFailure } from './failures';
import { METRIC } from './observability';
import type { Logger, MetricsSink } from './observability';
import type { ShutdownController, ShutdownReason } from './shutdown';
import type { RecoveryWorkerPolicy } from './workerConfig';
import { DEFAULT_HEALTH_THRESHOLDS, healthLevel, summarizeSweep } from './workerHealth';
import type { HealthThresholds, WorkerFailureRecord, WorkerHealth, WorkerStatus } from './workerHealth';

export interface WorkerClock {
  /** Wall-clock time, for records. */
  now(): Timestamp;
  /** Monotonic milliseconds, for measuring durations. Never goes backwards. */
  monotonicMs(): number;
  /** Interruptible sleep. Resolves early when the controller stops. */
  sleep(ms: number, shutdown?: ShutdownController): Promise<void>;
  random(): number;
}

/** The only place in the worker that touches the real system clock. */
export function systemWorkerClock(): WorkerClock {
  return {
    now: () => timestamp(new Date()),
    monotonicMs: () => Number(process.hrtime.bigint() / 1_000_000n),
    random: () => Math.random(),
    sleep(ms, shutdown) {
      return new Promise<void>((resolve) => {
        if (ms <= 0) {
          resolve();
          return;
        }
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          off?.();
          resolve();
        };
        const timer = setTimeout(finish, ms);
        // Do not hold the process open purely to finish a sleep.
        timer.unref?.();
        const off = shutdown?.onStop(finish);
        if (shutdown?.stopRequested === true) finish();
      });
    },
  };
}

/** Gauges the loop reads for health and metrics. */
export interface WorkerGauges {
  readonly oldestUnresolvedAgeMs: number;
  readonly pending: number;
  readonly underReview: number;
  readonly activeClaims: number;
  readonly ledgerResidualMinor: number;
  readonly databaseHealthy: boolean;
}

export interface LoopDependencies {
  readonly workerId: string;
  readonly policy: RecoveryWorkerPolicy;
  readonly clock: WorkerClock;
  readonly shutdown: ShutdownController;
  readonly logger: Logger;
  readonly metrics: MetricsSink;
  readonly healthThresholds?: HealthThresholds;
  /** Runs one sweep. Injected so the loop is testable without a database. */
  runSweep(options: SweepOptions): Promise<SweepReport>;
  readonly gauges: () => WorkerGauges;
  /** Called once the loop has stopped, for connection cleanup. */
  onStopped?: (reason: ShutdownReason | undefined) => void | Promise<void>;
  /** Releases claims this worker owns. Called during shutdown. */
  releaseOwnClaims?: () => number;
}

export class RecoveryWorkerLoop {
  private readonly deps: LoopDependencies;
  private readonly thresholds: HealthThresholds;

  private status: WorkerStatus = 'STARTING';
  private backoff: BackoffState = initialBackoffState();
  private startedAt: string;
  private sweepInFlight = false;

  private lastSweepStartedAt: string | undefined;
  private lastSweepCompletedAt: string | undefined;
  private lastSuccessfulSweepAt: string | undefined;
  private lastFailure: WorkerFailureRecord | undefined;
  private lastSweepReport: SweepReport | undefined;
  private lastSweepDurationMs: number | undefined;

  private sweepsScheduled = 0;
  private sweepsStarted = 0;
  private sweepsCompleted = 0;
  private sweepsFailed = 0;
  private sweepsSkipped = 0;

  constructor(deps: LoopDependencies) {
    this.deps = deps;
    this.thresholds = deps.healthThresholds ?? DEFAULT_HEALTH_THRESHOLDS;
    this.startedAt = deps.clock.now();
  }

  /**
   * Run the loop until shutdown.
   *
   * Returns when the worker has stopped, so a caller can await a clean exit.
   */
  async start(): Promise<WorkerHealth> {
    const { policy, clock, shutdown, logger, metrics, workerId } = this.deps;

    this.startedAt = clock.now();

    if (!policy.recoveryWorkerEnabled) {
      // Explicitly disabled is a normal state, not a failure.
      this.status = 'STOPPED';
      logger.log({
        level: 'info',
        event: 'worker.disabled',
        workerId,
        at: clock.now(),
        detail: { reason: 'recoveryWorkerEnabled is false' },
      });
      return this.health();
    }

    this.status = 'RUNNING';
    metrics.increment(METRIC.workerStarts);
    logger.log({ level: 'info', event: 'worker.started', workerId, at: clock.now() });

    if (!policy.runInitialSweepOnStart) {
      await clock.sleep(nextDelayMs(policy, this.backoff, clock.random), shutdown);
    }

    while (!shutdown.stopRequested) {
      await this.runOnce();
      if (shutdown.stopRequested) break;

      // Fixed delay from the end of the sweep: cannot run away.
      const delay = nextDelayMs(policy, this.backoff, clock.random);
      this.sweepsScheduled += 1;
      await clock.sleep(delay, shutdown);
    }

    return this.shutdownGracefully();
  }

  /**
   * Run exactly one sweep.
   *
   * Guarded against overlap: a second call while one is in flight is recorded
   * as skipped rather than run concurrently.
   */
  async runOnce(): Promise<SweepReport | undefined> {
    const { clock, shutdown, logger, metrics, workerId } = this.deps;

    if (this.sweepInFlight) {
      this.sweepsSkipped += 1;
      metrics.increment(METRIC.sweepSkipped);
      logger.log({ level: 'warn', event: 'worker.sweep.skipped_overlap', workerId, at: clock.now() });
      return undefined;
    }
    if (shutdown.stopRequested) return undefined;

    this.sweepInFlight = true;
    this.sweepsStarted += 1;
    this.lastSweepStartedAt = clock.now();
    const startedMono = clock.monotonicMs();
    metrics.increment(METRIC.sweepStarted);
    logger.log({ level: 'info', event: 'worker.sweep.started', workerId, at: this.lastSweepStartedAt });

    try {
      const report = await this.deps.runSweep({ shouldContinue: shutdown.shouldContinue });
      const durationMs = Math.max(0, clock.monotonicMs() - startedMono);

      this.lastSweepReport = report;
      this.lastSweepDurationMs = durationMs;
      this.lastSweepCompletedAt = clock.now();
      this.lastSuccessfulSweepAt = this.lastSweepCompletedAt;
      this.sweepsCompleted += 1;
      this.backoff = resetBackoff();
      this.status = 'RUNNING';

      this.recordSweepMetrics(report, durationMs);
      logger.log({
        level: 'info',
        event: 'worker.sweep.completed',
        workerId,
        at: this.lastSweepCompletedAt,
        sweepId: report.scanId,
        durationMs,
        detail: {
          found: report.found,
          claimed: report.claimed,
          recoveredSuccessful: report.recoveredSuccessful,
          recoveredFailed: report.recoveredFailed,
          movedToPending: report.movedToPending,
          escalated: report.escalatedUnderReview,
          conflicts: report.duplicateWorkersPrevented,
          stoppedEarly: report.stoppedEarly,
        },
      });

      return report;
    } catch (error) {
      const failure = classifyWorkerFailure(error);
      this.recordFailure(failure);
      return undefined;
    } finally {
      this.sweepInFlight = false;
      this.publishGauges();
    }
  }

  private recordFailure(failure: ClassifiedFailure): void {
    const { clock, logger, metrics, workerId, policy, shutdown } = this.deps;

    this.sweepsFailed += 1;
    this.lastSweepCompletedAt = clock.now();
    this.lastFailure = {
      at: clock.now(),
      category: failure.category,
      code: failure.code,
      fatal: failure.fatal,
    };

    metrics.increment(METRIC.sweepFailed, 1);
    if (failure.category === 'DATABASE_CONNECTION' || failure.category === 'MIGRATION_SCHEMA') {
      metrics.increment(METRIC.databaseErrors);
    }
    if (failure.category === 'PROVIDER_ADAPTER') {
      metrics.increment(METRIC.providerStatusErrors);
    }

    if (failure.fatal) {
      // A schema or connection failure is not something to retry into.
      this.status = 'FAILED';
      logger.log({
        level: 'error',
        event: 'worker.sweep.failed_fatal',
        workerId,
        at: clock.now(),
        errorCode: failure.code,
        outcome: failure.category,
      });
      shutdown.requestStop('FATAL_FAILURE');
      return;
    }

    this.backoff = advanceBackoff(policy, this.backoff, clock.random);
    this.status = 'BACKING_OFF';
    metrics.increment(METRIC.backoffEvents);
    logger.log({
      level: 'warn',
      event: 'worker.sweep.failed',
      workerId,
      at: clock.now(),
      errorCode: failure.code,
      outcome: failure.category,
      attempt: this.backoff.consecutiveFailures,
      detail: { backoffMs: this.backoff.currentDelayMs },
    });
  }

  private recordSweepMetrics(report: SweepReport, durationMs: number): void {
    const { metrics } = this.deps;
    metrics.increment(METRIC.sweepCompleted);
    metrics.observe(METRIC.sweepDurationMs, durationMs);
    metrics.increment(METRIC.found, report.found);
    metrics.increment(METRIC.claimed, report.claimed);
    metrics.increment(METRIC.recoveredSuccessful, report.recoveredSuccessful);
    metrics.increment(METRIC.recoveredFailed, report.recoveredFailed);
    metrics.increment(METRIC.movedToPending, report.movedToPending);
    metrics.increment(METRIC.escalated, report.escalatedUnderReview);
    metrics.increment(METRIC.claimConflicts, report.duplicateWorkersPrevented);
  }

  private publishGauges(): void {
    try {
      const gauges = this.deps.gauges();
      const { metrics } = this.deps;
      metrics.gauge(METRIC.oldestUnresolvedAgeMs, gauges.oldestUnresolvedAgeMs);
      metrics.gauge(METRIC.pendingQueueSize, gauges.pending);
      metrics.gauge(METRIC.underReviewQueueSize, gauges.underReview);
      metrics.gauge(METRIC.activeClaims, gauges.activeClaims);
    } catch {
      // Gauges are diagnostics. A failure to read them must never take the
      // worker down or mask the sweep's own result.
    }
  }

  /**
   * Stop cleanly.
   *
   * Waits for an in-flight sweep up to the configured timeout, then releases
   * only this worker's claims and lets everything else expire naturally.
   */
  private async shutdownGracefully(): Promise<WorkerHealth> {
    const { clock, logger, metrics, workerId, policy, shutdown } = this.deps;
    const startedMono = clock.monotonicMs();

    if (this.status !== 'FAILED') this.status = 'STOPPING';
    logger.log({
      level: 'info',
      event: 'worker.stopping',
      workerId,
      at: clock.now(),
      outcome: shutdown.reason ?? 'REQUESTED',
    });

    // Wait for the active sweep to reach its own safe boundary.
    const deadline = startedMono + policy.gracefulShutdownTimeoutMs;
    while (this.sweepInFlight && clock.monotonicMs() < deadline) {
      await clock.sleep(Math.min(25, policy.gracefulShutdownTimeoutMs));
    }

    if (this.sweepInFlight) {
      logger.log({
        level: 'warn',
        event: 'worker.shutdown.timeout',
        workerId,
        at: clock.now(),
        detail: { timeoutMs: policy.gracefulShutdownTimeoutMs },
      });
    }

    // Only our own claims. Anything else belongs to a live worker and is left
    // alone; an abandoned lease expires on its own.
    let released = 0;
    try {
      released = this.deps.releaseOwnClaims?.() ?? 0;
    } catch {
      // A failure to release is survivable: the leases expire.
    }

    await this.deps.onStopped?.(shutdown.reason);

    if (this.status !== 'FAILED') this.status = 'STOPPED';
    const durationMs = Math.max(0, clock.monotonicMs() - startedMono);
    metrics.observe(METRIC.shutdownDurationMs, durationMs);
    metrics.increment(METRIC.workerStops);
    logger.log({
      level: 'info',
      event: 'worker.stopped',
      workerId,
      at: clock.now(),
      durationMs,
      detail: { claimsReleased: released, reason: shutdown.reason ?? 'REQUESTED' },
    });

    return this.health();
  }

  health(): WorkerHealth {
    const { clock, workerId } = this.deps;
    let gauges: WorkerGauges;
    try {
      gauges = this.deps.gauges();
    } catch {
      gauges = {
        oldestUnresolvedAgeMs: 0,
        pending: 0,
        underReview: 0,
        activeClaims: 0,
        ledgerResidualMinor: 0,
        databaseHealthy: false,
      };
    }

    const level = healthLevel(
      {
        workerId,
        status: this.status,
        startedAt: this.startedAt,
        now: clock.now(),
        backoff: this.backoff,
        lastFailure: this.lastFailure,
        lastSuccessfulSweepAt: this.lastSuccessfulSweepAt,
        ledgerResidualMinor: gauges.ledgerResidualMinor,
        databaseHealthy: gauges.databaseHealthy,
        oldestUnresolvedAgeMs: gauges.oldestUnresolvedAgeMs,
        // What the last sweep actually did. A worker that claimed work and
        // resolved none of it is not healthy, however balanced the ledger is.
        lastSweep:
          this.lastSweepReport === undefined
            ? undefined
            : summarizeSweep(this.lastSweepReport),
      },
      this.thresholds,
    );

    return Object.freeze({
      workerId,
      status: this.status,
      level,
      startedAt: this.startedAt,
      lastSweepStartedAt: this.lastSweepStartedAt,
      lastSweepCompletedAt: this.lastSweepCompletedAt,
      lastSuccessfulSweepAt: this.lastSuccessfulSweepAt,
      lastFailure: this.lastFailure,
      consecutiveFailures: this.backoff.consecutiveFailures,
      currentBackoffMs: this.backoff.currentDelayMs,
      lastSweepReport: this.lastSweepReport,
      lastSweepDurationMs: this.lastSweepDurationMs,
      oldestUnresolvedAgeMs: gauges.oldestUnresolvedAgeMs,
      activeClaims: gauges.activeClaims,
      sweepsScheduled: this.sweepsScheduled,
      sweepsStarted: this.sweepsStarted,
      sweepsCompleted: this.sweepsCompleted,
      sweepsFailed: this.sweepsFailed,
      sweepsSkipped: this.sweepsSkipped,
      ledgerResidualMinor: gauges.ledgerResidualMinor,
      databaseHealthy: gauges.databaseHealthy,
    });
  }
}
