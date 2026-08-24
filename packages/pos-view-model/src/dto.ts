/**
 * The wire contract between the API and the POS.
 *
 * This lives in the view-model package, not in the API, because both sides need
 * it and neither should own it. The API builds these shapes; the typed client
 * parses them; the render functions consume them. One definition, three users,
 * no hand-written duplicate that drifts.
 *
 * ## What is deliberately absent
 *
 * - The full recipient number. Only `recipientMasked` crosses the wire.
 * - The recipient hash. It is a lookup key for the server, not for a browser.
 * - The payload fingerprint and idempotency key material beyond the key itself.
 * - Any provider credential, endpoint, or raw provider body.
 *
 * `redaction.ts` asserts the absence rather than trusting it.
 */

import type { TransactionState } from '@telga/domain';

/** Money on the wire: integer minor units, never a float. */
export interface MoneyDto {
  readonly amountMinor: number;
  readonly currency: string;
  /** Preformatted by the server so every surface agrees on presentation. */
  readonly formatted: string;
}

/** Where the recovery sweep has got to with this transaction. */
export interface RecoveryDto {
  /** `AWAITING`, `RESOLVED`, `ESCALATED`, or null when never pending. */
  readonly pendingStatus: 'AWAITING' | 'RESOLVED' | 'ESCALATED' | null;
  readonly attempts: number;
  readonly maxAttempts: number | null;
  readonly firstPendingAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly nextCheckAt: string | null;
  readonly deadlineAt: string | null;
  /** Safe category only. Never a provider message. */
  readonly lastOutcomeCategory: string | null;
  readonly manualReviewStatus: string;
  /** True when a worker currently holds a lease on this transaction. */
  readonly claimActive: boolean;
  readonly claimAttemptNo: number | null;
}

export interface SupportDto {
  readonly reference: string;
  readonly reason: string;
  readonly status: string;
  readonly openedAt: string;
  /** Present only once a supervisor has authorized something. */
  readonly approvedBy: string | null;
}

export interface TransactionDto {
  readonly transactionId: string;
  readonly merchantId: string;
  readonly deviceId: string;
  readonly state: TransactionState;
  readonly productType: string;
  readonly amount: MoneyDto;
  /** Masked at write time by the persistence layer. Never the full number. */
  readonly recipientMasked: string;
  readonly providerReference: string | null;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Always `TRAINING` in this build. The POS refuses to render anything else. */
  readonly mode: string;
  readonly simulated: true;
  readonly recovery: RecoveryDto;
  readonly support: SupportDto | null;
  /** Value currently held against this transaction, if any. */
  readonly reservation: {
    readonly status: string;
    readonly amount: MoneyDto;
  } | null;
}

export interface BalanceDto {
  readonly available: MoneyDto;
  readonly reserved: MoneyDto;
  readonly underReview: MoneyDto;
  readonly total: MoneyDto;
}

export interface QueueDto {
  readonly pending: readonly TransactionDto[];
  readonly underReview: readonly TransactionDto[];
  readonly reversalRequired: readonly TransactionDto[];
}

/** What the server tells the client about how often to look again. */
export interface PollingHintDto {
  readonly statusCheckIntervalMs: number;
  /** Client-side cap. A screen never polls forever. */
  readonly maxPolls: number;
}

/** Everything a POS screen needs in one response. */
export interface EnvelopeMeta {
  readonly correlationId: string;
  readonly mode: string;
  readonly simulated: true;
  readonly serverTime: string;
  readonly polling: PollingHintDto;
}

export interface ApiSuccess<T> {
  readonly ok: true;
  readonly data: T;
  readonly meta: EnvelopeMeta;
}

/**
 * A failure the merchant can be shown.
 *
 * `messageKey` resolves against `@telga/localization`; `reasonCode` is for logs
 * and metrics. Neither is ever a raw exception message.
 */
export interface ApiFailure {
  readonly ok: false;
  readonly error: {
    readonly kind: string;
    readonly reasonCode: string;
    readonly messageKey: string;
    readonly status: number;
  };
  readonly meta: EnvelopeMeta;
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

export function isSuccess<T>(envelope: ApiEnvelope<T>): envelope is ApiSuccess<T> {
  return envelope.ok;
}

/** The body a POS sends to start a training sale. */
export interface CreateSaleBody {
  readonly merchantId: string;
  readonly deviceId: string;
  readonly operatorId: string;
  readonly productId: string;
  readonly amountMinor: number;
  readonly recipient: string;
  /**
   * Generated once when the confirmation screen opens, so a double press
   * carries the same value and resolves to the same transaction.
   */
  readonly clientRequestId: string;
  /**
   * Training-only: which scripted provider outcome to exercise.
   *
   * This is the "simulate provider outcome" control. It selects a behaviour on
   * the **mock** adapter and has no meaning outside training mode; the handler
   * refuses the whole request if the mode is not TRAINING.
   */
  readonly simulatedProviderBehaviour?: string;
}

/** What `POST /sales` returns: the sale result plus the transaction it produced. */
export interface CreateSaleResultDto {
  readonly kind: string;
  readonly state: TransactionState | null;
  readonly transactionId: string | null;
  readonly messageKey: string;
  readonly nextAction: string;
  readonly providerErrorCategory: string | null;
  readonly reasonCode: string | null;
  readonly simulated: true;
  /** Present whenever a transaction row exists to look at. */
  readonly transaction: TransactionDto | null;
}
