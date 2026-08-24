/**
 * Recovery results and provider-outcome classification.
 *
 * The classification exists so that "we could not reach the provider" and
 * "the provider says it failed" are never the same thing. Only the second one
 * may release a merchant's money.
 */

import { LiveMoneyDisabledError } from '@telga/domain';
import type { ProviderStatus, TransactionState } from '@telga/domain';

/**
 * What a status lookup told us.
 *
 * Only `CONFIRMED_SUCCESS` and `CONFIRMED_FAILURE` are determinate. Everything
 * else means we do not know, and holds the merchant's value where it is.
 */
export type ProviderLookupOutcome =
  | 'CONFIRMED_SUCCESS'
  | 'CONFIRMED_FAILURE'
  | 'STILL_PROCESSING'
  | 'UNKNOWN'
  | 'PROVIDER_UNAVAILABLE'
  | 'MALFORMED_RESPONSE'
  | 'AUTH_OR_CONFIG_FAILURE'
  | 'NOT_ATTEMPTED';

export const DETERMINATE_OUTCOMES: readonly ProviderLookupOutcome[] = [
  'CONFIRMED_SUCCESS',
  'CONFIRMED_FAILURE',
];

export const isDeterminate = (outcome: ProviderLookupOutcome): boolean =>
  DETERMINATE_OUTCOMES.includes(outcome);

/**
 * An outcome that means the platform is misconfigured, not that the merchant's
 * sale failed. These raise an operational alert and must never be shown to a
 * merchant as a failed sale.
 */
export const isOperationalFault = (outcome: ProviderLookupOutcome): boolean =>
  outcome === 'AUTH_OR_CONFIG_FAILURE';

export function classifyStatus(status: ProviderStatus): ProviderLookupOutcome {
  switch (status.outcome) {
    case 'SUCCESS':
      return 'CONFIRMED_SUCCESS';
    case 'FAILURE':
      return 'CONFIRMED_FAILURE';
    case 'STILL_PENDING':
      return 'STILL_PROCESSING';
    case 'UNKNOWN_REFERENCE':
      return 'UNKNOWN';
    default: {
      const exhaustive: never = status.outcome;
      return exhaustive;
    }
  }
}

/**
 * Classify a thrown lookup.
 *
 * Deliberately conservative: anything not recognised is `UNKNOWN`, which holds
 * funds. The heuristics read the error's name and code, never its message body,
 * so a provider payload cannot leak into a decision or a log line.
 */
export function classifyLookupFailure(error: unknown): ProviderLookupOutcome {
  if (error instanceof LiveMoneyDisabledError) return 'AUTH_OR_CONFIG_FAILURE';

  const name = error instanceof Error ? error.name : '';
  const code =
    error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string'
      ? (error as { code: string }).code
      : '';
  const token = `${name}:${code}`.toUpperCase();

  if (/AUTH|CREDENTIAL|FORBIDDEN|UNAUTHORIZED|CONFIG|EACCES/.test(token)) return 'AUTH_OR_CONFIG_FAILURE';
  if (/MALFORMED|PARSE|SYNTAX|DECODE|JSON/.test(token)) return 'MALFORMED_RESPONSE';
  if (/UNAVAILABLE|ECONNREFUSED|ECONNRESET|ETIMEDOUT|TIMEOUT|NETWORK|DNS|ENOTFOUND/.test(token)) {
    return 'PROVIDER_UNAVAILABLE';
  }
  return 'UNKNOWN';
}

export type RecoveryKind =
  | 'RECOVERED_SUCCESSFUL'
  | 'RECOVERED_FAILED'
  | 'RELEASED_NEVER_SUBMITTED'
  | 'MOVED_TO_PENDING'
  | 'ESCALATED_UNDER_REVIEW'
  | 'SKIPPED_TOO_RECENT'
  | 'SKIPPED_TERMINAL'
  | 'SKIPPED_CLAIMED_BY_OTHER'
  | 'RECOVERY_FAILED';

export interface RecoveryResult {
  readonly transactionId: string;
  readonly merchantId: string;
  readonly kind: RecoveryKind;
  readonly stateBefore: TransactionState;
  readonly state: TransactionState;
  readonly providerOutcome: ProviderLookupOutcome;
  readonly providerReference?: string;
  readonly attempts: number;
  readonly correlationId: string;
  /** True when this needs a human to look at the platform, not the sale. */
  readonly operationalAlert: boolean;
  readonly supportReference?: string;
  /** Stable, safe code. Never a raw error message. */
  readonly reasonCode?: string;
  readonly simulated: true;
}

export interface SweepReport {
  readonly scanId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly found: number;
  readonly claimed: number;
  readonly duplicateWorkersPrevented: number;
  readonly recoveredSuccessful: number;
  readonly recoveredFailed: number;
  readonly releasedNeverSubmitted: number;
  readonly movedToPending: number;
  readonly escalatedUnderReview: number;
  readonly skipped: number;
  readonly recoveryFailures: number;
  readonly operationalAlerts: number;
  /** Total time spent waiting on provider status lookups, in milliseconds. */
  readonly providerLookupMs: number;
  /** True when the sweep stopped at a safe boundary before exhausting the batch. */
  readonly stoppedEarly: boolean;
  readonly results: readonly RecoveryResult[];
}
