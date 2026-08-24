/**
 * Recovery gauges.
 *
 * Counters for a single sweep live on its `SweepReport`; these are the standing
 * numbers a monitor reads between sweeps. Each maps to an alert in
 * `09 Engineering/Observability.md`.
 */

import type { MerchantId, Timestamp } from '@telga/domain';
import type { SqliteLedgerDriver } from '@telga/persistence';
import { UNRESOLVED_STATES } from './recoverInFlight';

export interface RecoveryGauges {
  readonly at: string;
  readonly processing: number;
  readonly reserved: number;
  readonly pending: number;
  readonly underReview: number;
  readonly reversalRequired: number;
  /** Age in milliseconds of the oldest transaction still holding merchant value. */
  readonly oldestUnresolvedAgeMs: number;
  readonly oldestUnresolvedId?: string;
  readonly openManualReviews: number;
  readonly awaitingResolutions: number;
  /** Must be zero. Anything else is the highest-severity signal Telga has. */
  readonly ledgerResidualMinor: number;
  readonly healthy: boolean;
}

export function recoveryGauges(
  driver: SqliteLedgerDriver,
  now: Timestamp,
  merchantId?: MerchantId,
): RecoveryGauges {
  const oldest = driver.oldestUnresolved(UNRESOLVED_STATES);
  const oldestAge = oldest ? new Date(now).getTime() - new Date(oldest.updated_at).getTime() : 0;

  return Object.freeze({
    at: now,
    processing: driver.countTransactionsByState('PROCESSING'),
    reserved: driver.countTransactionsByState('RESERVED'),
    pending: driver.countTransactionsByState('PENDING'),
    underReview: driver.countTransactionsByState('UNDER_REVIEW'),
    reversalRequired: driver.countTransactionsByState('REVERSAL_REQUIRED'),
    oldestUnresolvedAgeMs: Math.max(0, oldestAge),
    oldestUnresolvedId: oldest?.id,
    openManualReviews: driver.countOpenManualReviews(),
    awaitingResolutions: driver.awaitingResolutions(merchantId).length,
    ledgerResidualMinor: driver.ledgerResidualMinor(),
    healthy: driver.health().healthy,
  });
}

export interface RecoveryAlert {
  readonly code: string;
  readonly severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  readonly message: string;
}

export interface AlertThresholds {
  /** Beyond this, a held transaction is an incident rather than a wait. */
  readonly maxSafeUnresolvedMs: number;
  readonly maxManualReviewQueue: number;
  readonly maxRecoveryFailures: number;
}

/**
 * Evaluate the alert conditions.
 *
 * Returned rather than logged, so the caller decides where an alert goes — this
 * package writes no logs and knows nothing about a paging system.
 */
export function evaluateAlerts(
  gauges: RecoveryGauges,
  thresholds: AlertThresholds,
  sweep?: { recoveryFailures: number; duplicateWorkersPrevented: number; operationalAlerts: number },
): readonly RecoveryAlert[] {
  const alerts: RecoveryAlert[] = [];

  if (gauges.ledgerResidualMinor !== 0) {
    alerts.push({
      code: 'LEDGER_RESIDUAL_NON_ZERO',
      severity: 'CRITICAL',
      message: `Ledger residual is ${String(gauges.ledgerResidualMinor)}; double entry has broken`,
    });
  }
  if (!gauges.healthy) {
    alerts.push({ code: 'DATABASE_UNHEALTHY', severity: 'CRITICAL', message: 'Driver health check failed' });
  }
  if (gauges.oldestUnresolvedAgeMs > thresholds.maxSafeUnresolvedMs) {
    alerts.push({
      code: 'TRANSACTION_STUCK_BEYOND_SAFE_PERIOD',
      severity: 'HIGH',
      message: `Oldest unresolved transaction ${gauges.oldestUnresolvedId ?? ''} is beyond the safe period`,
    });
  }
  if (gauges.openManualReviews > thresholds.maxManualReviewQueue) {
    alerts.push({
      code: 'MANUAL_REVIEW_QUEUE_GROWING',
      severity: 'MEDIUM',
      message: `${String(gauges.openManualReviews)} open manual reviews`,
    });
  }
  if (sweep && sweep.recoveryFailures > thresholds.maxRecoveryFailures) {
    alerts.push({
      code: 'RECOVERY_WORKER_FAILURES',
      severity: 'HIGH',
      message: `${String(sweep.recoveryFailures)} recovery attempts failed in one sweep`,
    });
  }
  if (sweep && sweep.operationalAlerts > 0) {
    alerts.push({
      code: 'PROVIDER_LOOKUP_FAILURE_SPIKE',
      severity: 'HIGH',
      message: 'Provider status lookups are failing for configuration or authorization reasons',
    });
  }
  if (sweep && sweep.duplicateWorkersPrevented > 0) {
    alerts.push({
      code: 'MULTIPLE_RECOVERY_ATTEMPTS',
      severity: 'MEDIUM',
      message: `${String(sweep.duplicateWorkersPrevented)} duplicate worker claims were refused`,
    });
  }

  return Object.freeze(alerts);
}
