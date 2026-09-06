/**
 * Saved customers and operator shifts.
 *
 * Two small tables added by migration 012. Neither holds money: a shift is a
 * labelled span of time a statement can be grouped by, and a customer row is
 * a name beside a masked number. The ledger remains the only place value
 * moves.
 *
 * ## The phone number is stored masked
 *
 * `phone_masked` is exactly that — masked before it arrives, the same way
 * `transactions.recipient_masked` and `pending_orders.recipient` are. This
 * table is a convenience for recognising a regular, not a reason to start
 * keeping full numbers on a machine that sits on a counter. See the migration
 * and `ASSUMPTIONS.md` for why that limitation is deliberate.
 */

import type { DeviceId, MerchantId, MerchantUserId, Timestamp } from '@telga/domain';
import type { Db } from '../sqlite/connection';
import type { CustomerRow, ShiftRow } from '../schema/types';

// --- customers ----------------------------------------------------------------

export interface CustomerInput {
  readonly id: string;
  readonly merchantId: MerchantId;
  readonly displayName: string;
  /** Already masked. Never a full number. */
  readonly phoneMasked: string;
  readonly at: Timestamp;
}

export function saveCustomer(db: Db, input: CustomerInput): CustomerRow {
  db.prepare(
    `INSERT INTO customers (
       id, merchant_id, display_name, phone_masked, created_at, updated_at, mode)
     VALUES (@id, @merchantId, @displayName, @phoneMasked, @at, @at, 'TRAINING')`,
  ).run(input);
  return findCustomer(db, input.id) as CustomerRow;
}

export function findCustomer(db: Db, id: string): CustomerRow | undefined {
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as CustomerRow | undefined;
}

/** Scoped by merchant, so one shop can never read another's regulars. */
export function listCustomers(db: Db, merchantId: MerchantId): readonly CustomerRow[] {
  return db
    .prepare('SELECT * FROM customers WHERE merchant_id = ? ORDER BY display_name')
    .all(merchantId) as CustomerRow[];
}

// --- shifts -------------------------------------------------------------------

export interface ShiftInput {
  readonly id: string;
  readonly merchantId: MerchantId;
  readonly operatorId: MerchantUserId;
  readonly deviceId: DeviceId;
  readonly at: Timestamp;
}

export function openShift(db: Db, input: ShiftInput): ShiftRow {
  db.prepare(
    `INSERT INTO shifts (id, merchant_id, operator_id, device_id, opened_at, closed_at, mode)
     VALUES (@id, @merchantId, @operatorId, @deviceId, @at, NULL, 'TRAINING')`,
  ).run(input);
  return db.prepare('SELECT * FROM shifts WHERE id = ?').get(input.id) as ShiftRow;
}

/** The operator's open shift on this merchant, if there is one. */
export function findOpenShift(
  db: Db,
  merchantId: MerchantId,
  operatorId: MerchantUserId,
): ShiftRow | undefined {
  return db
    .prepare(
      `SELECT * FROM shifts
        WHERE merchant_id = ? AND operator_id = ? AND closed_at IS NULL
        ORDER BY opened_at DESC LIMIT 1`,
    )
    .get(merchantId, operatorId) as ShiftRow | undefined;
}

/**
 * Close a shift.
 *
 * Only from open, so a double press closes once and the second returns
 * `false` — the same single-winner discipline `authorizePendingOrder` uses.
 * The row is never deleted: a shift that happened stays recorded.
 */
export function closeShift(db: Db, id: string, at: Timestamp): boolean {
  const result = db
    .prepare('UPDATE shifts SET closed_at = ? WHERE id = ? AND closed_at IS NULL')
    .run(at, id);
  return result.changes === 1;
}
