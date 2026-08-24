/**
 * Worker failure classification.
 *
 * The categories differ in what they mean for the *worker*, not for a merchant:
 * a provider being unreachable is a reason to back off and retry, whereas a
 * schema failure means this worker must stop and be looked at.
 */

import { WorkerConfigurationError } from './workerConfig';

export type FailureCategory =
  | 'CONFIGURATION'
  | 'DATABASE_CONNECTION'
  | 'MIGRATION_SCHEMA'
  | 'PROVIDER_ADAPTER'
  | 'SHUTDOWN_CANCELLED'
  | 'PARTIAL_BATCH'
  | 'UNEXPECTED';

/** Categories that must stop the worker rather than back it off. */
export const FATAL_CATEGORIES: readonly FailureCategory[] = [
  'CONFIGURATION',
  'DATABASE_CONNECTION',
  'MIGRATION_SCHEMA',
];

export const isFatal = (category: FailureCategory): boolean => FATAL_CATEGORIES.includes(category);

export interface ClassifiedFailure {
  readonly category: FailureCategory;
  /** Stable, safe code. Never a raw message. */
  readonly code: string;
  readonly fatal: boolean;
}

const codeOf = (error: unknown): string => {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.name : 'UNKNOWN_ERROR';
};

/**
 * Classify a failure from a sweep.
 *
 * Reads the error's constructor, `name` and `code` — never its message, so a
 * provider payload or a SQL fragment cannot reach a log line or a decision.
 */
export function classifyWorkerFailure(error: unknown): ClassifiedFailure {
  const code = codeOf(error);
  const name = error instanceof Error ? error.name : '';
  const token = `${name}:${code}`.toUpperCase();

  let category: FailureCategory;

  if (error instanceof WorkerConfigurationError) {
    category = 'CONFIGURATION';
  } else if (/SQLITE_CANTOPEN|SQLITE_IOERR|SQLITE_CORRUPT|SQLITE_NOTADB|DRIVER_CLOSED|DATABASE/.test(token)) {
    category = 'DATABASE_CONNECTION';
  } else if (/MIGRATION|SQLITE_SCHEMA|NO_SUCH_TABLE|SQLITE_ERROR/.test(token)) {
    category = 'MIGRATION_SCHEMA';
  } else if (/SHUTDOWN|ABORT|CANCELLED|CANCELED/.test(token)) {
    category = 'SHUTDOWN_CANCELLED';
  } else if (/PROVIDER|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|UNAVAILABLE|AUTH/.test(token)) {
    category = 'PROVIDER_ADAPTER';
  } else {
    category = 'UNEXPECTED';
  }

  return Object.freeze({ category, code, fatal: isFatal(category) });
}

/**
 * A sweep that completed but reported per-transaction failures.
 *
 * Not an exception: the batch did its job and the failures are in the report.
 * It becomes a worker-level concern only through the metrics and alerts.
 */
export const partialBatchFailure = (code: string): ClassifiedFailure =>
  Object.freeze({ category: 'PARTIAL_BATCH' as const, code, fatal: false });
