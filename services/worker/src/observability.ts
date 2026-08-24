/**
 * Structured logging and metrics for the worker.
 *
 * Both are interfaces with in-memory implementations, so tests assert what was
 * emitted and production plugs in whatever it uses. This package writes to no
 * console and knows nothing about a log shipper.
 *
 * Redaction is applied on the way out rather than trusted at the call site.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface WorkerLogEvent {
  readonly level: LogLevel;
  readonly event: string;
  readonly workerId: string;
  readonly at: string;
  readonly sweepId?: string;
  readonly correlationId?: string;
  readonly transactionId?: string;
  readonly merchantId?: string;
  readonly providerId?: string;
  readonly outcome?: string;
  readonly errorCode?: string;
  readonly attempt?: number;
  readonly durationMs?: number;
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

export interface Logger {
  log(event: WorkerLogEvent): void;
}

export interface MetricsSink {
  increment(name: string, value?: number, labels?: Readonly<Record<string, string>>): void;
  observe(name: string, value: number, labels?: Readonly<Record<string, string>>): void;
  gauge(name: string, value: number, labels?: Readonly<Record<string, string>>): void;
}

/**
 * Keys that must never appear in a log detail.
 *
 * Blunt by design: a log line is exactly where a secret ends up by accident,
 * and a loud failure in a test beats a quiet credential in a log file.
 */
export const FORBIDDEN_LOG_KEYS = [
  'pin',
  'password',
  'secret',
  'token',
  'credential',
  'apikey',
  'api_key',
  'authorization',
  'recipient',
  'phone',
  'msisdn',
  'salt',
];

export function assertSafeLogDetail(detail: Readonly<Record<string, unknown>> | undefined): void {
  if (!detail) return;
  for (const key of Object.keys(detail)) {
    const normalized = key.toLowerCase().replace(/[^a-z_]/g, '');
    if (FORBIDDEN_LOG_KEYS.some((forbidden) => normalized.includes(forbidden))) {
      throw new Error(`Refusing to log key "${key}": it may carry sensitive data`);
    }
  }
}

/** A logger that keeps events in memory. Used by tests and by the health model. */
export function collectingLogger(limit = 500): Logger & { readonly events: readonly WorkerLogEvent[] } {
  const events: WorkerLogEvent[] = [];
  return {
    get events() {
      return events;
    },
    log(event) {
      assertSafeLogDetail(event.detail);
      events.push(event);
      if (events.length > limit) events.shift();
    },
  };
}

export const noopLogger = (): Logger => ({ log: () => undefined });

export interface CollectedMetrics extends MetricsSink {
  readonly counters: ReadonlyMap<string, number>;
  readonly observations: ReadonlyMap<string, readonly number[]>;
  readonly gauges: ReadonlyMap<string, number>;
  countOf(name: string): number;
}

export function collectingMetrics(): CollectedMetrics {
  const counters = new Map<string, number>();
  const observations = new Map<string, number[]>();
  const gauges = new Map<string, number>();

  return {
    counters,
    observations,
    gauges,
    increment(name, value = 1) {
      counters.set(name, (counters.get(name) ?? 0) + value);
    },
    observe(name, value) {
      const list = observations.get(name) ?? [];
      list.push(value);
      observations.set(name, list);
    },
    gauge(name, value) {
      gauges.set(name, value);
    },
    countOf(name) {
      return counters.get(name) ?? 0;
    },
  };
}

export const noopMetrics = (): MetricsSink => ({
  increment: () => undefined,
  observe: () => undefined,
  gauge: () => undefined,
});

/** Metric names, in one place so they cannot drift between emit and assert. */
export const METRIC = Object.freeze({
  workerStarts: 'worker.starts',
  workerStops: 'worker.stops',
  sweepStarted: 'worker.sweep.started',
  sweepCompleted: 'worker.sweep.completed',
  sweepFailed: 'worker.sweep.failed',
  sweepSkipped: 'worker.sweep.skipped_overlap',
  sweepDurationMs: 'worker.sweep.duration_ms',
  found: 'worker.transactions.found',
  claimed: 'worker.transactions.claimed',
  recoveredSuccessful: 'worker.transactions.recovered_successful',
  recoveredFailed: 'worker.transactions.recovered_failed',
  movedToPending: 'worker.transactions.moved_to_pending',
  escalated: 'worker.transactions.escalated_under_review',
  claimConflicts: 'worker.claims.conflicts',
  leaseExpirations: 'worker.claims.lease_expirations',
  providerStatusErrors: 'worker.provider.status_errors',
  databaseErrors: 'worker.database.errors',
  backoffEvents: 'worker.backoff.events',
  shutdownDurationMs: 'worker.shutdown.duration_ms',
  oldestUnresolvedAgeMs: 'worker.oldest_unresolved_age_ms',
  pendingQueueSize: 'worker.queue.pending',
  underReviewQueueSize: 'worker.queue.under_review',
  activeClaims: 'worker.claims.active',
});
