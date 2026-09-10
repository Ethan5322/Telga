/**
 * Rows for the three extension features — reversal requests, complaint reviews
 * and shop transfers.
 *
 * `CLAUDE.md` §17.1, §17.2, §19.1. One module because they share a shape: a
 * merchant asks, Telga decides, and the decision stays answerable.
 *
 * ## None of this moves money
 *
 * Every function here writes a *record of an intention or a decision*. The
 * money is `ledger_entries`, written by the ledger code inside its own
 * transaction, and §13 keeps it append-only with every debit matched. Keeping
 * the two apart is what stops a status column becoming a second, disagreeing
 * answer to "how much does this shop have".
 */

import type { Db } from '../sqlite/connection';

// ---------------------------------------------------------------------------
// Reversal requests — §17.1
// ---------------------------------------------------------------------------

export type ReversalStatus =
  | 'REQUESTED'
  | 'NEEDS_APPROVAL'
  | 'APPROVED'
  | 'REFUSED'
  | 'SETTLED';

export interface ReversalRequestRow {
  id: string;
  transaction_id: string;
  merchant_id: string;
  requested_by: string;
  device_id: string;
  reason: string;
  amount_minor: number;
  redemption: string;
  status: ReversalStatus;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  reversal_entry_id: string | null;
  correlation_id: string;
  created_at: string;
  updated_at: string;
}

export interface NewReversalRequest {
  readonly id: string;
  readonly transactionId: string;
  readonly merchantId: string;
  readonly requestedBy: string;
  readonly deviceId: string;
  readonly reason: string;
  readonly amountMinor: number;
  readonly redemption: 'REDEEMED' | 'UNREDEEMED' | 'UNKNOWN';
  readonly status: ReversalStatus;
  readonly correlationId: string;
  readonly at: string;
}

/**
 * File a request.
 *
 * The partial unique index refuses a second **open** request for the same
 * transaction — filing twice does not make it move faster, and two open
 * requests is two people deciding separately. A caller meeting that constraint
 * should treat it as "already asked", not as an error.
 */
export function saveReversalRequest(db: Db, input: NewReversalRequest): void {
  db.prepare(
    `INSERT INTO reversal_requests
       (id, transaction_id, merchant_id, requested_by, device_id, reason, amount_minor,
        redemption, status, correlation_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.transactionId,
    input.merchantId,
    input.requestedBy,
    input.deviceId,
    input.reason.trim(),
    input.amountMinor,
    input.redemption,
    input.status,
    input.correlationId,
    input.at,
    input.at,
  );
}

/** The open request for a transaction, if one exists. */
export const findOpenReversalRequest = (
  db: Db,
  transactionId: string,
): ReversalRequestRow | undefined =>
  db
    .prepare(
      `SELECT * FROM reversal_requests
        WHERE transaction_id = ? AND status IN ('REQUESTED','NEEDS_APPROVAL','APPROVED')`,
    )
    .get(transactionId) as ReversalRequestRow | undefined;

/** Everything waiting for a person, oldest first — a queue, not a list. */
export const listReversalQueue = (db: Db): readonly ReversalRequestRow[] =>
  db
    .prepare(
      `SELECT * FROM reversal_requests
        WHERE status IN ('REQUESTED','NEEDS_APPROVAL')
        ORDER BY created_at`,
    )
    .all() as ReversalRequestRow[];

/**
 * Record a supervisor's decision.
 *
 * `decided_by` and `decided_at` move together with the status, in one
 * statement: a decided request with no decider is a decision nobody can be
 * asked about.
 *
 * ## Only an undecided request
 *
 * `REQUESTED` and `NEEDS_APPROVAL` only. `APPROVED` was in this list and should
 * not have been: it let an approved reversal be flipped to `REFUSED` afterwards
 * by anybody with the permission, leaving two decisions in the trail and no
 * indication which one governed the money. A test caught it.
 *
 * Settlement moving `APPROVED` to `SETTLED` is a **different act** and needs
 * its own path — that is exactly why widening this one to cover it was wrong.
 * Returns the number of rows changed, so `0` means "already decided" rather
 * than an error a caller has to interpret.
 */
export function decideReversalRequest(
  db: Db,
  input: {
    readonly id: string;
    readonly status: ReversalStatus;
    readonly decidedBy: string;
    readonly reason: string;
    readonly at: string;
  },
): number {
  const result = db
    .prepare(
      `UPDATE reversal_requests
          SET status = ?, decided_by = ?, decided_at = ?, decision_reason = ?, updated_at = ?
        WHERE id = ? AND status IN ('REQUESTED','NEEDS_APPROVAL')`,
    )
    .run(input.status, input.decidedBy, input.at, input.reason, input.at, input.id);
  return result.changes;
}

// ---------------------------------------------------------------------------
// Complaint reviews — §17.2
// ---------------------------------------------------------------------------

export interface ComplaintReviewRow {
  id: string;
  support_case_id: string;
  merchant_id: string;
  description: string;
  telga_state: string | null;
  provider_state: string | null;
  redemption: string | null;
  verdict: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  verdict_reason: string | null;
  created_at: string;
  updated_at: string;
}

export function saveComplaintReview(
  db: Db,
  input: {
    readonly id: string;
    readonly supportCaseId: string;
    readonly merchantId: string;
    readonly description: string;
    readonly at: string;
  },
): void {
  db.prepare(
    `INSERT INTO complaint_reviews
       (id, support_case_id, merchant_id, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.supportCaseId,
    input.merchantId,
    input.description.trim(),
    input.at,
    input.at,
  );
}

/** Complaints with no verdict yet, oldest first. */
export const listOpenComplaints = (db: Db): readonly ComplaintReviewRow[] =>
  db
    .prepare(`SELECT * FROM complaint_reviews WHERE verdict IS NULL ORDER BY created_at`)
    .all() as ComplaintReviewRow[];

export const findComplaintReview = (db: Db, id: string): ComplaintReviewRow | undefined =>
  db.prepare(`SELECT * FROM complaint_reviews WHERE id = ?`).get(id) as
    | ComplaintReviewRow
    | undefined;

/**
 * Record what the evidence said, and what a person concluded from it.
 *
 * Evidence and verdict are written together on purpose. A verdict stored
 * without the evidence it rested on cannot be reviewed later, and §17's whole
 * point is that a merchant gets an answer somebody can stand behind.
 */
export function recordComplaintVerdict(
  db: Db,
  input: {
    readonly id: string;
    readonly telgaState: string | null;
    readonly providerState: string | null;
    readonly redemption: string | null;
    readonly verdict: 'LEGITIMATE' | 'SCAM' | 'UNCERTAIN';
    readonly reviewedBy: string;
    readonly reason: string;
    readonly at: string;
  },
): number {
  const result = db
    .prepare(
      `UPDATE complaint_reviews
          SET telga_state = ?, provider_state = ?, redemption = ?, verdict = ?,
              reviewed_by = ?, reviewed_at = ?, verdict_reason = ?, updated_at = ?
        WHERE id = ? AND verdict IS NULL`,
    )
    .run(
      input.telgaState,
      input.providerState,
      input.redemption,
      input.verdict,
      input.reviewedBy,
      input.at,
      input.reason,
      input.at,
      input.id,
    );
  return result.changes;
}

// ---------------------------------------------------------------------------
// Shop transfers — §19.1
// ---------------------------------------------------------------------------

export interface ShopTransferRow {
  id: string;
  sender_merchant_id: string;
  sender_device_id: string;
  sender_operator_id: string;
  recipient_device_id: string;
  recipient_merchant_id: string;
  amount_minor: number;
  fee_minor: number;
  status: string;
  refusal_reason: string | null;
  approved_by: string | null;
  approved_at: string | null;
  posting_id: string | null;
  correlation_id: string;
  mode: string;
  created_at: string;
  updated_at: string;
}

export function saveShopTransfer(
  db: Db,
  input: {
    readonly id: string;
    readonly senderMerchantId: string;
    readonly senderDeviceId: string;
    readonly senderOperatorId: string;
    readonly recipientDeviceId: string;
    readonly recipientMerchantId: string;
    readonly amountMinor: number;
    readonly feeMinor: number;
    readonly status: 'REQUESTED' | 'NEEDS_APPROVAL' | 'SETTLED' | 'REFUSED';
    readonly refusalReason?: string;
    readonly postingId?: string;
    readonly correlationId: string;
    readonly at: string;
  },
): void {
  db.prepare(
    `INSERT INTO shop_transfers
       (id, sender_merchant_id, sender_device_id, sender_operator_id,
        recipient_device_id, recipient_merchant_id, amount_minor, fee_minor,
        status, refusal_reason, posting_id, correlation_id, mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'TRAINING', ?, ?)`,
  ).run(
    input.id,
    input.senderMerchantId,
    input.senderDeviceId,
    input.senderOperatorId,
    input.recipientDeviceId,
    input.recipientMerchantId,
    input.amountMinor,
    input.feeMinor,
    input.status,
    input.refusalReason ?? null,
    input.postingId ?? null,
    input.correlationId,
    input.at,
    input.at,
  );
}

/**
 * What a shop has already sent today, for the daily limit.
 *
 * Counts `SETTLED` **and** anything still awaiting approval. A shop with three
 * large transfers queued has committed that money in every sense that matters;
 * counting only settled ones would let them queue past their own limit and
 * discover it when a supervisor approved the fourth.
 *
 * The fee is excluded: the limit is on what a shop **sends**, not on what
 * Telga charges for sending it.
 */
export function sentTodayMinor(db: Db, merchantId: string, sinceIso: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_minor), 0) AS total
         FROM shop_transfers
        WHERE sender_merchant_id = ?
          AND created_at >= ?
          AND status IN ('SETTLED','REQUESTED','NEEDS_APPROVAL')`,
    )
    .get(merchantId, sinceIso) as { total: number };
  return row.total;
}

/** Both sides of a shop's transfer history, newest first. */
export const listTransfersFor = (
  db: Db,
  merchantId: string,
  limit = 50,
): readonly ShopTransferRow[] =>
  db
    .prepare(
      `SELECT * FROM shop_transfers
        WHERE sender_merchant_id = ? OR recipient_merchant_id = ?
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(merchantId, merchantId, limit) as ShopTransferRow[];

export const listTransferQueue = (db: Db): readonly ShopTransferRow[] =>
  db
    .prepare(
      `SELECT * FROM shop_transfers WHERE status = 'NEEDS_APPROVAL' ORDER BY created_at`,
    )
    .all() as ShopTransferRow[];
