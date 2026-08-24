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

  const clock = options.clock ?? systemWorkerClock();
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
    runSweep: (sweepOptions: SweepOptions) => recoverInFlight(deps, sweepOptions),
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
