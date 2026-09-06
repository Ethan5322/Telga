/**
 * Voucher pending orders.
 *
 * Every write here is a single-row `UPDATE ... WHERE status = 'OPEN'`, so a
 * concurrent authorize-and-cancel race resolves to exactly one outcome:
 * whichever `UPDATE` finds the row still `OPEN` wins, and the other's
 * `changes` count comes back zero. Nothing here calls `createSale` or touches
 * the ledger — this file only ever reads and writes `pending_orders`.
 */

import type {
  DeviceId,
  MerchantId,
  MerchantUserId,
  Timestamp,
  TransactionId,
} from '@telga/domain';
import type { Db } from '../sqlite/connection';
import type { PendingOrderRow } from '../schema/types';

export interface PendingOrderInput {
  readonly id: string;
  readonly merchantId: MerchantId;
  readonly deviceId: DeviceId;
  readonly operatorId: MerchantUserId;
  readonly sessionId: string;
  readonly network: string;
  readonly productId: string;
  readonly amountMinor: number;
  readonly clientRequestId: string;
  readonly createdAt: Timestamp;
  readonly expiresAt: Timestamp;
  /** `AIRTIME` unless stated. `TOPUP` is a direct top-up of a phone number. */
  readonly productType?: 'AIRTIME' | 'TOPUP' | 'DATA';
  /** Masked before it reaches here. Null when the product needs no recipient. */
  readonly recipient?: string | null;
  /** How many vouchers. 1 unless bulk printing was used; bounded by the CHECK. */
  readonly quantity?: number;
}

export function createPendingOrder(db: Db, input: PendingOrderInput): PendingOrderRow {
  db.prepare(
    `INSERT INTO pending_orders (
       id, merchant_id, device_id, operator_id, session_id, network, product_type,
       product_id, amount_minor, currency, quantity, total_minor, client_request_id,
       status, created_at, expires_at, transaction_id, recipient)
     VALUES (
       @id, @merchantId, @deviceId, @operatorId, @sessionId, @network, @productType,
       @productId, @amountMinor, 'ETB', @quantity, @amountMinor * @quantity,
       @clientRequestId, 'OPEN', @createdAt, @expiresAt, NULL, @recipient)`,
  ).run({
    ...input,
    productType: input.productType ?? 'AIRTIME',
    recipient: input.recipient ?? null,
    // `amount_minor` stays the price of one voucher; `total_minor` is the
    // whole order. The CHECK enforces the relationship in the database, so a
    // caller cannot store a total that does not follow from the two.
    quantity: input.quantity ?? 1,
  });
  return findPendingOrder(db, input.id) as PendingOrderRow;
}

export function findPendingOrder(db: Db, id: string): PendingOrderRow | undefined {
  return db.prepare('SELECT * FROM pending_orders WHERE id = ?').get(id) as
    | PendingOrderRow
    | undefined;
}

/** Marks an `OPEN` order `EXPIRED` if `now` is past its `expires_at`. Idempotent. */
export function expireIfDue(db: Db, id: string, now: Timestamp): void {
  db.prepare(
    `UPDATE pending_orders SET status = 'EXPIRED'
      WHERE id = ? AND status = 'OPEN' AND expires_at <= ?`,
  ).run(id, now);
}

/** Only succeeds from `OPEN`. Returns `false` if the order had already moved on. */
export function cancelPendingOrder(db: Db, id: string): boolean {
  const result = db
    .prepare(`UPDATE pending_orders SET status = 'CANCELLED' WHERE id = ? AND status = 'OPEN'`)
    .run(id);
  return result.changes === 1;
}

/**
 * Marks the order `AUTHORIZED` and records the transaction it produced.
 *
 * Only succeeds from `OPEN` — the same guard that makes a race between two
 * PIN submissions resolve to one winner without any extra locking.
 */
export function authorizePendingOrder(
  db: Db,
  id: string,
  transactionId: TransactionId,
): boolean {
  const result = db
    .prepare(
      `UPDATE pending_orders SET status = 'AUTHORIZED', transaction_id = ?
        WHERE id = ? AND status = 'OPEN'`,
    )
    .run(transactionId, id);
  return result.changes === 1;
}
