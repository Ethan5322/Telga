/**
 * Read model: driver rows to wire DTOs.
 *
 * The one place that decides what leaves the server for a screen.
 *
 * ## What it does not do
 *
 * It does not compute balance, decide state, or infer an outcome. Everything it
 * returns was already decided by the orchestration, the recovery sweep or the
 * ledger; this file reads and shapes. If a value here disagrees with the
 * database, the bug is here and only here.
 *
 * ## What it drops
 *
 * `recipient_hash` and `payload_fingerprint` never leave. They are exact-match
 * lookup keys for the server, and a browser has no use for either — but a hash
 * of a phone number is still derived from a phone number, and it does not
 * belong in a page a shop counter can see.
 */

import { format, money } from '@telga/domain';
import type { MerchantId, Money, TransactionId, TransactionState } from '@telga/domain';
import type {
  PendingResolutionRow,
  SqliteLedgerDriver,
  SupportCaseRow,
  TransactionRow,
} from '@telga/persistence';
import type {
  BalanceDto,
  MoneyDto,
  RecoveryDto,
  SupportDto,
  TransactionDto,
} from '@telga/pos-view-model';

export function toMoneyDto(amount: Money): MoneyDto {
  return { amountMinor: amount.minor, currency: amount.currency, formatted: format(amount) };
}

/**
 * The schema constrains `currency` to ETB, so a row carrying anything else is a
 * corrupted database rather than a display problem. Refuse it here instead of
 * quietly formatting it as birr.
 */
function moneyDtoFromRow(minor: number, currency: string): MoneyDto {
  if (currency !== 'ETB') {
    throw new Error(`Unsupported currency in a stored row: ${currency}`);
  }
  return toMoneyDto(money(minor, 'ETB'));
}

function toSupportDto(row: SupportCaseRow | undefined): SupportDto | null {
  if (!row) return null;
  return {
    reference: row.reference,
    reason: row.reason,
    status: row.status,
    openedAt: row.created_at,
    approvedBy: row.approved_by,
  };
}

function toRecoveryDto(
  pending: PendingResolutionRow | undefined,
  claimActive: boolean,
  claimAttemptNo: number | null,
  maxAttempts: number | null,
): RecoveryDto {
  if (!pending) {
    return {
      pendingStatus: null,
      attempts: 0,
      maxAttempts,
      firstPendingAt: null,
      lastAttemptAt: null,
      nextCheckAt: null,
      deadlineAt: null,
      lastOutcomeCategory: null,
      manualReviewStatus: 'NONE',
      claimActive,
      claimAttemptNo,
    };
  }
  return {
    pendingStatus: pending.status,
    attempts: pending.attempts,
    maxAttempts,
    firstPendingAt: pending.first_pending_at,
    lastAttemptAt: pending.last_attempt_at,
    nextCheckAt: pending.next_check_at,
    deadlineAt: pending.deadline_at,
    lastOutcomeCategory: pending.last_outcome_category,
    manualReviewStatus: pending.manual_review_status,
    claimActive,
    claimAttemptNo,
  };
}

export interface ReadModelDeps {
  readonly driver: SqliteLedgerDriver;
  /** From the recovery policy, so the screen can show "attempt 2 of 5". */
  readonly maxStatusAttempts?: number;
  now(): string;
}

/**
 * Build the DTO for one transaction.
 *
 * `correlationId` comes from the pending-resolution row when there is one,
 * because that is the id a support agent will find in the worker's logs. When
 * there is no pending row the caller's own correlation id is used, which is the
 * id in the request log for this read.
 */
export function toTransactionDto(
  deps: ReadModelDeps,
  row: TransactionRow,
  fallbackCorrelationId: string,
): TransactionDto {
  const txId = row.id as TransactionId;
  const merchant = row.merchant_id as MerchantId;

  const pending = deps.driver.findPendingResolution(txId);
  const support = deps.driver.findSupportCaseByTransaction(txId, merchant);
  const reservation = deps.driver.findReservation(txId, merchant);
  const claim = deps.driver.findClaim(txId);

  const claimActive = claim?.status === 'ACTIVE' && claim.expires_at > deps.now();

  return {
    transactionId: row.id,
    merchantId: row.merchant_id,
    deviceId: row.device_id,
    state: row.state,
    productType: row.product_type,
    amount: moneyDtoFromRow(row.amount_minor, row.currency),
    recipientMasked: row.recipient_masked,
    providerReference: row.provider_reference,
    idempotencyKey: row.idempotency_key,
    correlationId: pending?.correlation_id ?? fallbackCorrelationId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    mode: row.mode,
    simulated: true,
    recovery: toRecoveryDto(
      pending,
      claimActive,
      claim?.attempt_no ?? null,
      deps.maxStatusAttempts ?? null,
    ),
    support: toSupportDto(support),
    reservation: reservation
      ? {
          status: reservation.status,
          amount: moneyDtoFromRow(reservation.amount_minor, reservation.currency),
        }
      : null,
  };
}

export function toBalanceDto(deps: ReadModelDeps, merchantId: MerchantId): BalanceDto {
  const view = deps.driver.balanceFor(merchantId);
  return {
    available: toMoneyDto(view.available),
    reserved: toMoneyDto(view.reserved),
    underReview: toMoneyDto(view.underReview),
    total: toMoneyDto(view.total),
  };
}

/**
 * A merchant's transactions, newest first.
 *
 * Sorted by `created_at` and then by id, not by id alone: ids sort
 * lexicographically, so "last row" is not "newest row" — the same trap that
 * produced a flake in the recovery helpers.
 */
export function listTransactionDtos(
  deps: ReadModelDeps,
  merchantId: MerchantId,
  fallbackCorrelationId: string,
  options: { limit?: number; states?: readonly TransactionState[] } = {},
): readonly TransactionDto[] {
  const rows = [...deps.driver.findTransactionsByMerchant(merchantId)];
  const filtered = options.states
    ? rows.filter((row) => options.states?.includes(row.state))
    : rows;
  filtered.sort((a, b) => {
    if (a.created_at === b.created_at) return a.id < b.id ? 1 : -1;
    return a.created_at < b.created_at ? 1 : -1;
  });
  const limited = options.limit === undefined ? filtered : filtered.slice(0, options.limit);
  return limited.map((row) => toTransactionDto(deps, row, fallbackCorrelationId));
}
