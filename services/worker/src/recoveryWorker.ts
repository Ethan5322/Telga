/**
 * The recovery worker.
 *
 * Wires a driver, a provider adapter and a validated policy into the supervised
 * loop. This is the composition root: it is the only file that knows about all
 * three layers at once.
 *
 * TRAINING MODE — NO REAL VALUE. The worker refuses any mode but `TRAINING`,
 * and the layers beneath it refuse independently.
 */

import { LiveMoneyDisabledError } from '@telga/domain';
import type { OperatingMode, ProviderId, Timestamp } from '@telga/domain';
import { recoverInFlight, recoveryGauges, UNRESOLVED_STATES } from '@telga/api';
import type { ProductCatalog, RecoveryConfig, RecoveryDeps, SweepOptions, SweepReport } from '@telga/api';
import type { AirtimeProvider } from '@telga/domain';
import type { SqliteLedgerDriver } from '@telga/persistence';
import type { Logger, MetricsSink } from './observability';
import { noopLogger, noopMetrics } from './observability';
import { ShutdownController } from './shutdown';
import type { RecoveryWorkerPolicy } from './workerConfig';
import { validateWorkerPolicy } from './workerConfig';
import { RecoveryWorkerLoop, systemWorkerClock } from './workerLifecycle';
import { runDueSoftwareFees } from './softwareFeeRun';
import type { WorkerClock, WorkerGauges } from './workerLifecycle';
import type { HealthThresholds, WorkerHealth } from './workerHealth';

export interface RecoveryWorkerOptions {
  readonly workerId: string;
  readonly policy: RecoveryWorkerPolicy;
  readonly driver: SqliteLedgerDriver;
  readonly provider: AirtimeProvider;
  readonly providerId: ProviderId;
  readonly catalog: ProductCatalog;
  readonly recipientSalt: string;
  readonly mode: OperatingMode;
  /** Deterministic id generation. The worker supplies one if omitted. */
  readonly newId?: (prefix: string) => string;
  readonly clock?: WorkerClock;
  /**
   * Keep the process alive between sweeps.
   *
   * Set by a caller that intends to run the supervised loop. Without it the
   * default clock unrefs its sleep timer, and a worker with nothing else in
   * the event loop exits cleanly, silently, mid-sleep — see
   * `systemWorkerClock`. Ignored when an explicit `clock` is supplied.
   */
  readonly keepAlive?: boolean;
  readonly shutdown?: ShutdownController;
  readonly logger?: Logger;
  readonly metrics?: MetricsSink;
  readonly healthThresholds?: HealthThresholds;
  /** Per-provider recovery overrides, if any. */
  readonly perProvider?: RecoveryConfig['perProvider'];
  /** Called after the loop stops, for closing connections. */
  readonly onStopped?: () => void | Promise<void>;
}

/** Default id generator: worker id plus a monotonically increasing counter. */
function defaultIdFactory(workerId: string): (prefix: string) => string {
  let n = 0;
  return (prefix: string) => {
    n += 1;
    return `${prefix}_${workerId}_${String(n)}`;
  };
}

export interface RecoveryWorker {
  start(): Promise<WorkerHealth>;
  runOnce(): Promise<SweepReport | undefined>;
  stop(reason?: 'REQUESTED' | 'SIGTERM' | 'SIGINT'): void;
  health(): WorkerHealth;
  readonly workerId: string;
  readonly shutdown: ShutdownController;
}

/**
 * Build a recovery worker.
 *
 * Validates the policy up front and throws a typed configuration error rather
 * than starting with settings that do not make sense.
 */
export function createRecoveryWorker(options: RecoveryWorkerOptions): RecoveryWorker {
  const policy = validateWorkerPolicy(options.policy);

  if (options.mode !== 'TRAINING') {
    throw new LiveMoneyDisabledError();
  }

  // `keepAlive` only when this worker is going to supervise. A one-shot sweep
  // should exit the moment it is done; a loop must not exit while it sleeps.
  const clock = options.clock ?? systemWorkerClock({ keepAlive: options.keepAlive === true });
  const shutdown = options.shutdown ?? new ShutdownController();
  const logger = options.logger ?? noopLogger();
  const metrics = options.metrics ?? noopMetrics();
  const newId = options.newId ?? defaultIdFactory(options.workerId);

  const recovery: RecoveryConfig = {
    recoveryAgeMs: policy.recoveryAgeMs,
    pendingMaximumMs: policy.pendingMaximumMs,
    maxStatusAttempts: policy.maxStatusAttempts,
    claimLeaseMs: policy.claimLeaseMs,
    statusCheckIntervalMs: policy.statusCheckIntervalMs,
    batchLimit: policy.recoveryBatchLimit,
    perProvider: options.perProvider,
  };

  const deps: RecoveryDeps = {
    driver: options.driver,
    provider: options.provider,
    providerId: options.providerId,
    catalog: options.catalog,
    mode: options.mode,
    recipientSalt: options.recipientSalt,
    now: () => clock.now(),
    newId,
    workerId: options.workerId,
    recovery,
  };

  const gauges = (): WorkerGauges => {
    const now: Timestamp = clock.now();
    const g = recoveryGauges(options.driver, now);
    return {
      oldestUnresolvedAgeMs: g.oldestUnresolvedAgeMs,
      pending: g.pending,
      underReview: g.underReview,
      activeClaims: options.driver.countActiveClaims(options.workerId),
      ledgerResidualMinor: g.ledgerResidualMinor,
      databaseHealthy: g.healthy,
    };
  };

  const loop = new RecoveryWorkerLoop({
    workerId: options.workerId,
    policy,
    clock,
    shutdown,
    logger,
    metrics,
    healthThresholds: options.healthThresholds,
    /**
     * The sweep recovers in-flight sales, and then charges whatever monthly
     * software fee is due.
     *
     * ## Why it hangs off the sweep rather than a schedule of its own
     *
     * `runDueSoftwareFees` charges the month that has **finished**, and the
     * charge is idempotent per shop per month — `(merchant_id, period)` is
     * unique, so the first sweep after a month ends does the work and every
     * sweep after that finds the row and moves nothing. That makes "run it
     * often" and "run it once" the same thing, which is what lets it ride the
     * loop that already exists.
     *
     * A cron entry would be the conventional answer and is worse here: a cron
     * that does not fire is a month nobody is charged for and nothing that
     * notices. This recovers by itself the next time the worker runs at all.
     *
     * ## Why a failure here does not fail the sweep
     *
     * Recovering an in-flight sale is the worker's actual job, and a sale left
     * unresolved is money in limbo (section 15). Billing is not allowed to
     * stand in front of that: if the fee run throws, it is logged and the sweep
     * reports its own result, and the next sweep tries the fee again.
     */
    runSweep: async (sweepOptions: SweepOptions) => {
      /**
       * Recovery first, and its outcome is what the sweep reports.
       *
       * The fee runs **either way**. An earlier version of this awaited
       * recovery and then charged, so a sweep that threw skipped billing
       * silently — and a sweep that throws repeatedly is exactly the situation
       * in which nobody is watching closely. Recovering an in-flight sale and
       * charging a monthly fee are unrelated pieces of work sharing a timer;
       * neither should be able to cancel the other.
       */
      let failure: unknown;
      let report: SweepReport | undefined;
      try {
        report = await recoverInFlight(deps, sweepOptions);
      } catch (error) {
        failure = error;
      }

      try {
        const fees = runDueSoftwareFees({
          driver: options.driver,
          now: () => clock.now(),
          newId,
        });
        if (fees.charged > 0 || fees.arrears > 0 || fees.recovered > 0) {
          logger.log({
            level: 'info',
            event: 'worker.software_fee.charged',
            workerId: options.workerId,
            at: clock.now(),
            detail: {
              period: fees.period,
              charged: fees.charged,
              chargedMinor: fees.chargedMinor,
              // A shop that could not pay is the line an operations desk acts
              // on, so it is logged at the same level as a successful charge
              // rather than left to be discovered in the database.
              arrears: fees.arrears,
              recovered: fees.recovered,
            },
          });
        }
      } catch (error) {
        logger.log({
          level: 'error',
          event: 'worker.software_fee.failed',
          workerId: options.workerId,
          at: clock.now(),
          detail: { reason: error instanceof Error ? error.name : 'unknown error' },
        });
      }

      // Recovery's failure is the sweep's failure, reported after the fee has
      // had its turn rather than instead of it.
      if (failure !== undefined) throw failure;
      // Unreachable: `recoverInFlight` either returns a report or throws.
      if (report === undefined) throw new Error('recovery returned no report');
      return report;
    },
    gauges,
    releaseOwnClaims: () => options.driver.releaseClaimsOwnedBy(options.workerId, clock.now()),
    onStopped: async () => {
      await options.onStopped?.();
    },
  });

  return {
    workerId: options.workerId,
    shutdown,
    start: () => loop.start(),
    runOnce: () => loop.runOnce(),
    stop: (reason = 'REQUESTED') => {
      shutdown.requestStop(reason);
    },
    health: () => loop.health(),
  };
}

export { UNRESOLVED_STATES };
