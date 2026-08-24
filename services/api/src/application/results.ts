/**
 * Typed results for the sale orchestration.
 *
 * Two rules shape this file:
 *
 *  1. **The merchant never sees a raw error.** Every result carries a
 *     `messageKey` into `04 UX UI/English Strings.md` and a `nextAction` the POS
 *     layer switches on. No stack trace, no SQL text, no provider body.
 *  2. **An unknown outcome is its own result.** `PENDING` is not a failure and
 *     not a success; it is a first-class member of the union, so a caller
 *     cannot accidentally treat it as either.
 */

import type { TransactionState } from '@telga/domain';

/** What the POS should do next. The UI switches on this, never on a message. */
export type MerchantNextAction =
  | 'DISPLAY_RESULT_AND_OFFER_RECEIPT'
  | 'EXPLAIN_NO_SALE_FUNDS_RELEASED'
  | 'DO_NOT_RETRY_YET'
  | 'CONTACT_SUPPORT_WITH_REFERENCE'
  | 'SHOW_PROVIDER_UNAVAILABLE_NO_CHARGE'
  | 'SHOW_EXISTING_TRANSACTION_STATE'
  | 'SHOW_VALIDATION_ERROR'
  | 'SHOW_PERMISSION_ERROR'
  | 'SHOW_SYSTEM_ERROR';

/** Coarse, safe categories. Never a provider message verbatim. */
export type ProviderErrorCategory =
  | 'NONE'
  | 'PROVIDER_CONFIRMED_FAILURE'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_INDETERMINATE'
  | 'PROVIDER_DUPLICATE'
  | 'PROVIDER_UNREACHABLE';

interface ResultBase {
  readonly transactionId: string;
  readonly state: TransactionState;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly providerReference?: string;
  /** Always true in this build. */
  readonly simulated: true;
  readonly messageKey: string;
  readonly nextAction: MerchantNextAction;
  readonly providerErrorCategory: ProviderErrorCategory;
}

export interface SuccessfulResult extends ResultBase {
  readonly kind: 'SUCCESSFUL';
  readonly state: 'SUCCESSFUL';
  readonly nextAction: 'DISPLAY_RESULT_AND_OFFER_RECEIPT';
}

export interface FailedResult extends ResultBase {
  readonly kind: 'FAILED';
  readonly state: 'FAILED';
  readonly nextAction: 'EXPLAIN_NO_SALE_FUNDS_RELEASED';
}

export interface PendingResult extends ResultBase {
  readonly kind: 'PENDING';
  readonly state: 'PENDING';
  readonly nextAction: 'DO_NOT_RETRY_YET';
  /** When this must be escalated to UNDER_REVIEW if still unresolved. */
  readonly deadlineAt: string;
}

export interface UnderReviewResult extends ResultBase {
  readonly kind: 'UNDER_REVIEW';
  readonly state: 'UNDER_REVIEW';
  readonly nextAction: 'CONTACT_SUPPORT_WITH_REFERENCE';
  readonly supportReference: string;
}

export interface ReversalRequiredResult extends ResultBase {
  readonly kind: 'REVERSAL_REQUIRED';
  readonly state: 'REVERSAL_REQUIRED';
  readonly nextAction: 'CONTACT_SUPPORT_WITH_REFERENCE';
  readonly supportReference: string;
}

export interface ReversedResult extends ResultBase {
  readonly kind: 'REVERSED';
  readonly state: 'REVERSED';
  readonly nextAction: 'EXPLAIN_NO_SALE_FUNDS_RELEASED';
  readonly supportReference: string;
}

/** A true duplicate: same identity, same payload. Returns the original outcome. */
export interface DuplicateRequestResult {
  readonly kind: 'DUPLICATE_REQUEST';
  readonly originalTransactionId: string;
  readonly state: TransactionState;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly simulated: true;
  readonly messageKey: string;
  readonly nextAction: 'SHOW_EXISTING_TRANSACTION_STATE';
}

export type RejectionKind =
  | 'PAYLOAD_MISMATCH'
  | 'INSUFFICIENT_BALANCE'
  | 'UNAUTHORIZED'
  | 'PRODUCT_UNAVAILABLE'
  | 'PROVIDER_UNAVAILABLE'
  | 'SIMULATED_ONLY'
  | 'PERSISTENCE_FAILURE'
  | 'INVALID_REQUEST';

export interface RejectedResult {
  readonly kind: RejectionKind;
  readonly correlationId: string;
  readonly idempotencyKey?: string;
  readonly transactionId?: string;
  readonly simulated: true;
  readonly messageKey: string;
  readonly nextAction: MerchantNextAction;
  /** Stable, safe code for logs and metrics. Never a raw error message. */
  readonly reasonCode: string;
}

export type SaleResult =
  | SuccessfulResult
  | FailedResult
  | PendingResult
  | UnderReviewResult
  | ReversalRequiredResult
  | ReversedResult
  | DuplicateRequestResult
  | RejectedResult;

/** Results that mean a sale outcome exists, as opposed to a rejection. */
export const OUTCOME_KINDS = [
  'SUCCESSFUL',
  'FAILED',
  'PENDING',
  'UNDER_REVIEW',
  'REVERSAL_REQUIRED',
  'REVERSED',
] as const;

export function isOutcome(result: SaleResult): boolean {
  return (OUTCOME_KINDS as readonly string[]).includes(result.kind);
}

/** Message keys, resolved by the POS against the bilingual string files. */
export const MESSAGE_KEYS = Object.freeze({
  SUCCESSFUL: 'status.successful',
  FAILED: 'status.failed.message',
  PENDING: 'status.pending.message',
  UNDER_REVIEW: 'status.under_review.message',
  REVERSAL_REQUIRED: 'status.under_review.message',
  REVERSED: 'status.failed.message',
  DUPLICATE_REQUEST: 'error.duplicate.blocked',
  PAYLOAD_MISMATCH: 'error.duplicate.blocked',
  INSUFFICIENT_BALANCE: 'error.balance.insufficient',
  UNAUTHORIZED: 'error.permission.denied',
  PRODUCT_UNAVAILABLE: 'status.provider_unavailable.message',
  PROVIDER_UNAVAILABLE: 'status.provider_unavailable.message',
  SIMULATED_ONLY: 'mode.training',
  PERSISTENCE_FAILURE: 'status.sales_unavailable',
  INVALID_REQUEST: 'error.validation.recipient',
});
