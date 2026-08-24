/**
 * Worker health model.
 *
 * A plain typed value an operations console can render later. No HTTP endpoint
 * exists yet; when one does, it serves this object.
 *
 * The distinction that matters: **degraded** means the worker is running but
 * things are going wrong, **unhealthy** means it is not doing its job at all.
 * A worker that stopped is unhealthy even though it is not erroring.
 *
 * ## A zero ledger residual is necessary, not sufficient
 *
 * The first version of this policy looked only at process state, failures and
 * lag. A sweep that **found work, claimed it, and resolved none of it** reported
 * `HEALTHY` — which is exactly what happened while investigating A54, and it is
 * the wrong answer twice over: the residual was indeed zero, and nothing had
 * been recovered. Double entry holding says the books are consistent; it says
 * nothing about whether recovery is doing its job.
 *
 * So the outcome of the last sweep is now an input. See `SweepOutcome`.
 */

import type { SweepReport } from '@telga/api';
import type { BackoffState } from './backoff';
import type { ClassifiedFailure } from './failures';

export type WorkerStatus = 'STARTING' | 'RUNNING' | 'BACKING_OFF' | 'STOPPING' | 'STOPPED' | 'FAILED';

export type HealthLevel = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';

export interface WorkerFailureRecord {
  readonly at: string;
  readonly category: ClassifiedFailure['category'];
  readonly code: string;
  readonly fatal: boolean;
}

export interface WorkerHealth {
  readonly workerId: string;
  readonly status: WorkerStatus;
  readonly level: HealthLevel;
  readonly startedAt: string;
  readonly lastSweepStartedAt?: string;
  readonly lastSweepCompletedAt?: string;
  readonly lastSuccessfulSweepAt?: string;
  readonly lastFailure?: WorkerFailureRecord;
  readonly consecutiveFailures: number;
  readonly currentBackoffMs: number;
  readonly lastSweepReport?: SweepReport;
  readonly lastSweepDurationMs?: number;
  readonly oldestUnresolvedAgeMs: number;
  readonly activeClaims: number;
  readonly sweepsScheduled: number;
  readonly sweepsStarted: number;
  readonly sweepsCompleted: number;
  readonly sweepsFailed: number;
  readonly sweepsSkipped: number;
  readonly ledgerResidualMinor: number;
  readonly databaseHealthy: boolean;
}

/**
 * What the last sweep actually did.
 *
 * Deliberately a summary rather than the whole `SweepReport`: health is a
 * decision about counts, and passing the full report would invite the policy to
 * start reading per-transaction detail it has no business in.
 */
export interface SweepOutcome {
  readonly found: number;
  readonly claimed: number;
  /** Everything that reached a definite disposition, successful or not. */
  readonly resolved: number;
  readonly skipped: number;
  readonly recoveryFailures: number;
  readonly duplicateWorkersPrevented: number;
}

/** Summarise a sweep report for the health policy. */
export function summarizeSweep(report: SweepReport): SweepOutcome {
  return {
    found: report.found,
    claimed: report.claimed,
    resolved:
      report.recoveredSuccessful +
      report.recoveredFailed +
      report.releasedNeverSubmitted +
      report.movedToPending +
      report.escalatedUnderReview,
    skipped: report.skipped,
    recoveryFailures: report.recoveryFailures,
    duplicateWorkersPrevented: report.duplicateWorkersPrevented,
  };
}

export interface HealthThresholds {
  /** Consecutive failures at which a running worker is considered degraded. */
  readonly degradedAfterFailures: number;
  /** Age of the oldest unresolved transaction that means recovery is not keeping up. */
  readonly degradedOldestUnresolvedMs: number;
  /** How long without a successful sweep before the worker is considered stale. */
  readonly staleAfterMs: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = Object.freeze({
  degradedAfterFailures: 1,
  degradedOldestUnresolvedMs: 15 * 60_000,
  staleAfterMs: 10 * 60_000,
});

export interface HealthInputs {
  readonly workerId: string;
  readonly status: WorkerStatus;
  readonly startedAt: string;
  readonly now: string;
  readonly backoff: BackoffState;
  readonly lastFailure?: WorkerFailureRecord;
  readonly lastSuccessfulSweepAt?: string;
  readonly ledgerResidualMinor: number;
  readonly databaseHealthy: boolean;
  readonly oldestUnresolvedAgeMs: number;
  /** The last completed sweep, when there has been one. */
  readonly lastSweep?: SweepOutcome;
}

/**
 * Decide the health level.
 *
 * Ordered from most to least severe so the first matching condition wins.
 */
export function healthLevel(inputs: HealthInputs, thresholds: HealthThresholds): HealthLevel {
  // Not doing its job at all.
  if (inputs.status === 'FAILED' || inputs.status === 'STOPPED') return 'UNHEALTHY';
  if (!inputs.databaseHealthy) return 'UNHEALTHY';
  if (inputs.ledgerResidualMinor !== 0) return 'UNHEALTHY';
  if (inputs.lastFailure?.fatal === true) return 'UNHEALTHY';

  // Running, but something is wrong.
  //
  // The sweep outcome comes first among the degraded conditions, because it is
  // the most specific evidence available: a failure that already happened beats
  // an inference from lag or a failure counter.
  const sweep = inputs.lastSweep;
  if (sweep !== undefined) {
    // Work was claimed and could not be resolved. Safe — the transactions stay
    // where they were and the next sweep retries — but not healthy.
    if (sweep.recoveryFailures > 0) return 'DEGRADED';
    // Claimed something and disposed of nothing, with no failure recorded.
    // Whatever that is, it is not a worker doing its job.
    if (sweep.claimed > 0 && sweep.resolved === 0) return 'DEGRADED';
  }

  if (inputs.status === 'BACKING_OFF') return 'DEGRADED';
  if (inputs.backoff.consecutiveFailures >= thresholds.degradedAfterFailures) return 'DEGRADED';
  if (inputs.oldestUnresolvedAgeMs > thresholds.degradedOldestUnresolvedMs) return 'DEGRADED';

  // Running but nothing has succeeded in a long time — stale rather than broken.
  if (inputs.lastSuccessfulSweepAt !== undefined) {
    const sinceSuccess = new Date(inputs.now).getTime() - new Date(inputs.lastSuccessfulSweepAt).getTime();
    if (sinceSuccess > thresholds.staleAfterMs) return 'DEGRADED';
  }

  if (inputs.status === 'STARTING' || inputs.status === 'STOPPING') return 'DEGRADED';

  return 'HEALTHY';
}
