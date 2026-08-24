/**
 * Pending resolution jobs and support cases.
 *
 * A transaction that reaches PENDING is not simply left in that state and hoped
 * about — it gets a row here with a deadline, so the pending maximum from
 * `03 Domain/Transaction State Machine.md` is a scheduled fact rather than an
 * intention.
 */

import type { MerchantId, TransactionId } from '@telga/domain';
import type { Db } from '../sqlite/connection';
import type { PendingResolutionRow, SupportCaseRow } from '../schema/types';

export function upsertPendingResolution(
  db: Db,
  input: {
    transactionId: TransactionId;
    merchantId: MerchantId;
    idempotencyKey: string;
    providerReference?: string;
    correlationId: string;
    firstPendingAt: string;
    deadlineAt: string;
  },
): PendingResolutionRow {
  db.prepare(
    `INSERT INTO pending_resolutions (
       transaction_id, merchant_id, idempotency_key, provider_reference, correlation_id,
       attempts, status, first_pending_at, last_attempt_at, deadline_at, created_at, updated_at)
     VALUES (@transactionId, @merchantId, @idempotencyKey, @providerReference, @correlationId,
       0, 'AWAITING', @firstPendingAt, NULL, @deadlineAt, @firstPendingAt, @firstPendingAt)
     ON CONFLICT(transaction_id) DO NOTHING`,
  ).run({
    transactionId: input.transactionId,
    merchantId: input.merchantId,
    idempotencyKey: input.idempotencyKey,
    providerReference: input.providerReference ?? null,
    correlationId: input.correlationId,
    firstPendingAt: input.firstPendingAt,
    deadlineAt: input.deadlineAt,
  });

  const row = findPendingResolution(db, input.transactionId);
  if (!row) throw new Error(`Pending resolution for ${input.transactionId} was not persisted`);
  return row;
}

export function findPendingResolution(
  db: Db,
  transactionId: TransactionId,
): PendingResolutionRow | undefined {
  return db.prepare('SELECT * FROM pending_resolutions WHERE transaction_id = ?').get(transactionId) as
    | PendingResolutionRow
    | undefined;
}

export function awaitingResolutions(db: Db, merchantId?: MerchantId): readonly PendingResolutionRow[] {
  if (merchantId === undefined) {
    return db
      .prepare("SELECT * FROM pending_resolutions WHERE status = 'AWAITING' ORDER BY first_pending_at")
      .all() as PendingResolutionRow[];
  }
  return db
    .prepare(
      "SELECT * FROM pending_resolutions WHERE status = 'AWAITING' AND merchant_id = ? ORDER BY first_pending_at",
    )
    .all(merchantId) as PendingResolutionRow[];
}

export function recordResolutionAttempt(db: Db, transactionId: TransactionId, at: string): void {
  db.prepare(
    `UPDATE pending_resolutions
     SET attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
     WHERE transaction_id = ? AND status = 'AWAITING'`,
  ).run(at, at, transactionId);
}

/**
 * Close a pending job.
 *
 * Guarded on `status = 'AWAITING'` so a repeated callback cannot re-open or
 * re-close it; the caller checks the boolean before posting anything.
 */
export function closePendingResolution(
  db: Db,
  transactionId: TransactionId,
  to: 'RESOLVED' | 'ESCALATED',
  at: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE pending_resolutions SET status = ?, updated_at = ?
       WHERE transaction_id = ? AND status = 'AWAITING'`,
    )
    .run(to, at, transactionId);
  return result.changes === 1;
}

export function createSupportCase(
  db: Db,
  input: {
    id: string;
    merchantId: MerchantId;
    transactionId?: TransactionId;
    reason: SupportCaseRow['reason'];
    reference: string;
    correlationId: string;
    at: string;
  },
): SupportCaseRow {
  db.prepare(
    `INSERT INTO support_cases (
       id, merchant_id, transaction_id, reason, status, reference, correlation_id, created_at, updated_at)
     VALUES (@id, @merchantId, @transactionId, @reason, 'OPEN', @reference, @correlationId, @at, @at)
     ON CONFLICT(id) DO NOTHING`,
  ).run({
    id: input.id,
    merchantId: input.merchantId,
    transactionId: input.transactionId ?? null,
    reason: input.reason,
    reference: input.reference,
    correlationId: input.correlationId,
    at: input.at,
  });

  const row = db.prepare('SELECT * FROM support_cases WHERE id = ?').get(input.id) as
    | SupportCaseRow
    | undefined;
  if (!row) throw new Error(`Support case ${input.id} was not persisted`);
  return row;
}

export function findSupportCaseByTransaction(
  db: Db,
  transactionId: TransactionId,
  merchantId?: MerchantId,
): SupportCaseRow | undefined {
  if (merchantId === undefined) {
    return db.prepare('SELECT * FROM support_cases WHERE transaction_id = ?').get(transactionId) as
      | SupportCaseRow
      | undefined;
  }
  return db
    .prepare('SELECT * FROM support_cases WHERE transaction_id = ? AND merchant_id = ?')
    .get(transactionId, merchantId) as SupportCaseRow | undefined;
}

export function findSupportCasesByMerchant(db: Db, merchantId: MerchantId): readonly SupportCaseRow[] {
  return db
    .prepare('SELECT * FROM support_cases WHERE merchant_id = ? ORDER BY created_at, id')
    .all(merchantId) as SupportCaseRow[];
}

/**
 * Update the metadata a recovery sweep maintains for an unresolved transaction.
 *
 * Only ever records a **safe outcome category** — never a raw provider body.
 */
export function updatePendingMetadata(
  db: Db,
  transactionId: TransactionId,
  input: {
    at: string;
    nextCheckAt?: string;
    lastOutcomeCategory?: string;
    currentState?: string;
    manualReviewStatus?: string;
    deadlineAt?: string;
  },
): void {
  db.prepare(
    `UPDATE pending_resolutions SET
       next_check_at         = COALESCE(@nextCheckAt, next_check_at),
       last_outcome_category = COALESCE(@lastOutcomeCategory, last_outcome_category),
       current_state         = COALESCE(@currentState, current_state),
       manual_review_status  = COALESCE(@manualReviewStatus, manual_review_status),
       deadline_at           = COALESCE(@deadlineAt, deadline_at),
       updated_at            = @at
     WHERE transaction_id = @transactionId`,
  ).run({
    transactionId,
    at: input.at,
    nextCheckAt: input.nextCheckAt ?? null,
    lastOutcomeCategory: input.lastOutcomeCategory ?? null,
    currentState: input.currentState ?? null,
    manualReviewStatus: input.manualReviewStatus ?? null,
    deadlineAt: input.deadlineAt ?? null,
  });
}

/** Record a supervisor approval against a support case. */
export function approveSupportCase(
  db: Db,
  id: string,
  approvedBy: string,
  at: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE support_cases SET approved_by = ?, approved_at = ?, updated_at = ?
       WHERE id = ? AND approved_by IS NULL`,
    )
    .run(approvedBy, at, at, id);
  return result.changes === 1;
}
