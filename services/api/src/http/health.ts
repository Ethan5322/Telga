/**
 * Health and readiness — public, read-only, no state change.
 *
 * `GET /api/health/live` answers one question: is the process alive and
 * accepting connections. Reaching the handler already proves that, so it
 * never touches the database.
 *
 * `GET /api/health/ready` answers a harder question: is it safe to serve an
 * authenticated training request right now. It reuses `recoveryGauges` and
 * `evaluateAlerts` from `application/recovery/metrics.ts` — the same numbers
 * the worker's own observability already computes — rather than inventing a
 * second, possibly-conflicting definition of "the recovery queue is fine."
 *
 * ## What this process cannot see
 *
 * The POS/API process and the recovery worker are **separate processes**
 * sharing only the database — there is no live channel between them. This
 * endpoint cannot report the worker's actual in-memory health (its backoff
 * state, its consecutive-failure count) the way `services/worker/src/
 * workerHealth.ts` can from inside the worker itself. Everything below is an
 * **inference from persisted state**, not a report from the worker.
 * "Claim state" is reported as a count, not a staleness verdict: whether a
 * claim is stuck is already what the recovery-queue's oldest-unresolved-age
 * check answers, so a second staleness check on claims would duplicate that
 * signal rather than add one.
 *
 * ## What never happens here
 *
 * No write, no ledger entry, no claim, no provider call. Every value comes
 * from a read. A caller that reaches this handler cannot cause any state
 * change through it, regardless of what it asks for.
 */

import { MIGRATIONS } from '@telga/persistence';
import { evaluateAlerts, recoveryGauges } from '../application/recovery/metrics';
import type { AlertThresholds } from '../application/recovery/metrics';
import type { HttpRequest, HttpResponse } from './contract';
import type { AuthedApiDeps } from './deps';

export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'NOT_READY' | 'STARTING' | 'STOPPING';

/**
 * `STARTING` and `STOPPING` are part of the type for completeness against the
 * worker's own `WorkerStatus`, but this endpoint never emits them: a request
 * cannot reach this handler before the HTTP listener is accepting
 * connections, and the transport stops accepting new connections before an
 * in-flight shutdown would ever reach here. Documented rather than built,
 * because there is nothing for it to detect.
 */
export const UNREACHABLE_STATUSES: readonly HealthStatus[] = Object.freeze(['STARTING', 'STOPPING']);

/**
 * Matches the worker's own `degradedOldestUnresolvedMs` (15 minutes, see
 * `services/worker/src/workerHealth.ts`) as a **value**, not an import —
 * `@telga/api` cannot depend on `@telga/worker`; the dependency runs the
 * other way. `maxManualReviewQueue` and `maxRecoveryFailures` have no
 * existing default anywhere in this repository; chosen here as a first,
 * conservative value for a training deployment with a handful of operators,
 * not derived from pilot data that does not yet exist.
 */
export const DEFAULT_READINESS_THRESHOLDS: AlertThresholds = Object.freeze({
  maxSafeUnresolvedMs: 15 * 60_000,
  maxManualReviewQueue: 5,
  maxRecoveryFailures: 1,
});

export interface ReadinessCheck {
  readonly name: string;
  readonly status: HealthStatus;
  /** A safe, stable code — never a raw error message, never a stack trace, never a file path. */
  readonly reasonCode?: string;
}

export interface ReadinessBody {
  readonly status: HealthStatus;
  readonly mode: string;
  readonly serverTime: string;
  readonly checks: readonly ReadinessCheck[];
}

export interface LivenessBody {
  readonly status: 'HEALTHY';
  readonly mode: string;
  readonly serverTime: string;
}

function safeHeaders(correlationId: string, mode: string): Record<string, string> {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-telga-correlation-id': correlationId,
    'x-telga-mode': mode,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
}

/** `GET /api/health/live` */
export function getLiveness(
  deps: AuthedApiDeps,
  _request: HttpRequest,
  correlationId: string,
): HttpResponse {
  const body: LivenessBody = { status: 'HEALTHY', mode: deps.mode, serverTime: deps.now() };
  return { status: 200, headers: safeHeaders(correlationId, deps.mode), body };
}

function overallStatus(checks: readonly ReadinessCheck[]): HealthStatus {
  if (checks.some((c) => c.status === 'NOT_READY')) return 'NOT_READY';
  if (checks.some((c) => c.status === 'UNHEALTHY')) return 'UNHEALTHY';
  if (checks.some((c) => c.status === 'DEGRADED')) return 'DEGRADED';
  return 'HEALTHY';
}

function respond(
  deps: AuthedApiDeps,
  correlationId: string,
  checks: readonly ReadinessCheck[],
): HttpResponse {
  const status = overallStatus(checks);
  const body: ReadinessBody = { status, mode: deps.mode, serverTime: deps.now(), checks };
  // DEGRADED is still "safe to serve" — matches the worker's own DEGRADED
  // meaning ("running, but something is wrong"), not a reason to refuse.
  const httpStatus = status === 'HEALTHY' || status === 'DEGRADED' ? 200 : 503;
  return { status: httpStatus, headers: safeHeaders(correlationId, deps.mode), body };
}

/** `GET /api/health/ready` */
export function getReadiness(
  deps: AuthedApiDeps,
  _request: HttpRequest,
  correlationId: string,
  thresholds: AlertThresholds = DEFAULT_READINESS_THRESHOLDS,
): HttpResponse {
  const checks: ReadinessCheck[] = [];

  checks.push(
    deps.mode === 'TRAINING'
      ? { name: 'mode', status: 'HEALTHY' }
      : { name: 'mode', status: 'NOT_READY', reasonCode: 'NOT_TRAINING_MODE' },
  );

  let gauges;
  try {
    gauges = recoveryGauges(deps.driver, deps.now());
  } catch {
    checks.push({ name: 'database', status: 'UNHEALTHY', reasonCode: 'DATABASE_UNREACHABLE' });
    checks.push({ name: 'ledger_residual', status: 'UNHEALTHY', reasonCode: 'DATABASE_UNREACHABLE' });
    checks.push({ name: 'recovery_queue', status: 'UNHEALTHY', reasonCode: 'DATABASE_UNREACHABLE' });
    checks.push({ name: 'recovery_claims', status: 'UNHEALTHY', reasonCode: 'DATABASE_UNREACHABLE' });
    return respond(deps, correlationId, checks);
  }

  let migrationsCurrent: boolean;
  try {
    const applied = new Set(deps.driver.appliedMigrations().map((m) => m.version));
    migrationsCurrent = MIGRATIONS.every((m) => applied.has(m.version));
  } catch {
    migrationsCurrent = false;
  }

  checks.push(
    !gauges.healthy
      ? { name: 'database', status: 'UNHEALTHY', reasonCode: 'DATABASE_INTEGRITY' }
      : !migrationsCurrent
        ? { name: 'database', status: 'UNHEALTHY', reasonCode: 'MIGRATIONS_NOT_CURRENT' }
        : { name: 'database', status: 'HEALTHY' },
  );

  // A decisive, separate line — the highest-severity signal Telga has gets
  // its own check rather than being folded into the general database line.
  checks.push(
    gauges.ledgerResidualMinor === 0
      ? { name: 'ledger_residual', status: 'HEALTHY' }
      : { name: 'ledger_residual', status: 'UNHEALTHY', reasonCode: 'LEDGER_RESIDUAL_NON_ZERO' },
  );

  const alerts = evaluateAlerts(gauges, thresholds);
  const recoveryDegraded = alerts.some(
    (a) => a.code === 'TRANSACTION_STUCK_BEYOND_SAFE_PERIOD' || a.code === 'MANUAL_REVIEW_QUEUE_GROWING',
  );
  checks.push(
    recoveryDegraded
      ? { name: 'recovery_queue', status: 'DEGRADED', reasonCode: 'RECOVERY_QUEUE_LAGGING' }
      : { name: 'recovery_queue', status: 'HEALTHY' },
  );

  try {
    deps.driver.countActiveClaims();
    checks.push({ name: 'recovery_claims', status: 'HEALTHY' });
  } catch {
    checks.push({ name: 'recovery_claims', status: 'UNHEALTHY', reasonCode: 'RECOVERY_CLAIMS_UNREADABLE' });
  }

  return respond(deps, correlationId, checks);
}
