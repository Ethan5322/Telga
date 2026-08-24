/**
 * Balance reservations.
 *
 * The reservation row is the *lifecycle* record — held, under review, released,
 * settled. The value itself lives in the ledger buckets, so a reservation row
 * and the postings that accompany it must always agree; the atomic operations
 * in `../operations.ts` are what keep them in step.
 */

import type { BalanceReservation, MerchantId, TransactionId } from '@telga/domain';
import type { Db } from '../sqlite/connection';
import type { ReservationRow, ReservationStatus } from '../schema/types';

export function saveReservation(
  db: Db,
  reservation: BalanceReservation,
  correlationId: string,
): ReservationRow {
  const releasedAt =
    reservation.state === 'RELEASED' || reservation.state === 'SETTLED' ? reservation.updatedAt : null;

  db.prepare(
    `INSERT INTO balance_reservations (
       id, merchant_id, transaction_id, amount_minor, currency, status, correlation_id,
       created_at, updated_at, released_at)
     VALUES (@id, @merchantId, @transactionId, @amountMinor, @currency, @status, @correlationId,
       @createdAt, @updatedAt, @releasedAt)
     ON CONFLICT(id) DO UPDATE SET
       status = @status,
       updated_at = @updatedAt,
       released_at = @releasedAt`,
  ).run({
    id: reservation.id,
    merchantId: reservation.merchantId,
    transactionId: reservation.transactionId,
    amountMinor: reservation.amount.minor,
    currency: reservation.amount.currency,
    status: reservation.state,
    correlationId,
    createdAt: reservation.createdAt,
    updatedAt: reservation.updatedAt,
    releasedAt,
  });

  const row = findReservationById(db, reservation.id);
  if (!row) throw new Error(`Reservation ${reservation.id} was not persisted`);
  return row;
}

export function findReservationById(db: Db, id: string): ReservationRow | undefined {
  return db.prepare('SELECT * FROM balance_reservations WHERE id = ?').get(id) as
    | ReservationRow
    | undefined;
}

/** Scoped in SQL — another merchant's reservation is not found, not filtered later. */
export function findReservation(
  db: Db,
  transactionId: TransactionId,
  merchantId?: MerchantId,
): ReservationRow | undefined {
  if (merchantId === undefined) {
    return db.prepare('SELECT * FROM balance_reservations WHERE transaction_id = ?').get(transactionId) as
      | ReservationRow
      | undefined;
  }
  return db
    .prepare('SELECT * FROM balance_reservations WHERE transaction_id = ? AND merchant_id = ?')
    .get(transactionId, merchantId) as ReservationRow | undefined;
}

export function findReservationsByMerchant(db: Db, merchantId: MerchantId): readonly ReservationRow[] {
  return db
    .prepare('SELECT * FROM balance_reservations WHERE merchant_id = ? ORDER BY created_at, id')
    .all(merchantId) as ReservationRow[];
}

/**
 * Move a reservation to a new status **only if** it is currently `HELD`.
 *
 * The `WHERE status = 'HELD'` clause is the concurrency guard: two racing
 * releases both attempt the update, but only one changes a row. The caller
 * checks `changes` and refuses to post a second balancing entry — which is what
 * stops a repeated release from double-crediting.
 */
export function transitionHeldReservation(
  db: Db,
  id: string,
  to: ReservationStatus,
  at: string,
): boolean {
  const releasedAt = to === 'RELEASED' || to === 'SETTLED' ? at : null;
  const result = db
    .prepare(
      `UPDATE balance_reservations
       SET status = ?, updated_at = ?, released_at = ?
       WHERE id = ? AND status = 'HELD'`,
    )
    .run(to, at, releasedAt, id);
  return result.changes === 1;
}

/** Same guard, from the under-review bucket. */
export function transitionUnderReviewReservation(
  db: Db,
  id: string,
  to: ReservationStatus,
  at: string,
): boolean {
  const releasedAt = to === 'RELEASED' || to === 'SETTLED' ? at : null;
  const result = db
    .prepare(
      `UPDATE balance_reservations
       SET status = ?, updated_at = ?, released_at = ?
       WHERE id = ? AND status = 'UNDER_REVIEW'`,
    )
    .run(to, at, releasedAt, id);
  return result.changes === 1;
}
