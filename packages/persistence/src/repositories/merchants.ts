/**
 * Merchant and device rows.
 *
 * Repositories persist and retrieve. They do not decide — no business rule
 * lives in this file, and none should.
 */

import type { MerchantId } from '@telga/domain';
import type { Db } from '../sqlite/connection';
import type { DeviceInput, MerchantInput } from '../driver/types';
import type { DeviceRow, MerchantRow } from '../schema/types';
import { MerchantScopeViolationError } from '../driver/errors';

export function saveMerchant(db: Db, input: MerchantInput): MerchantRow {
  db.prepare(
    `INSERT INTO merchants (id, status, mode, created_at, updated_at)
     VALUES (@id, @status, @mode, @at, @at)
     ON CONFLICT(id) DO UPDATE SET status = @status, updated_at = @at`,
  ).run({ id: input.id, status: input.status, mode: input.mode, at: input.at });

  const row = findMerchant(db, input.id);
  if (!row) throw new Error(`Merchant ${input.id} was not persisted`);
  return row;
}

/**
 * Give a shop its own deposit reference, if it has none — §20.1.
 *
 * ## Why this is idempotent rather than "set it"
 *
 * A reference already given has been read down a phone line, written on a
 * shop's wall, and possibly quoted on a bank standing order. Re-issuing one
 * would strand every payment quoting the old code in manual review. So a shop
 * that has one keeps it, and this returns what it already had.
 *
 * ## Why the generator is a parameter
 *
 * Persistence keeps no dependency on the domain package, and a test can force
 * a collision by handing this a generator that repeats. Same reasoning as
 * `saveTopupOrder`, and the same `UNIQUE` column decides the outcome: on a
 * collision the insert fails and the caller draws again.
 *
 * Returns the reference now held, whether it was just issued or already there.
 */
export function ensureDepositReference(
  db: Db,
  merchantId: MerchantId,
  newReference: () => string,
  normalize: (raw: string) => string,
  attempts = 5,
): string {
  const existing = db
    .prepare('SELECT deposit_reference FROM merchants WHERE id = ?')
    .get(merchantId) as { deposit_reference: string | null } | undefined;
  if (existing === undefined) throw new Error(`Merchant ${merchantId} does not exist`);
  if (existing.deposit_reference !== null) return existing.deposit_reference;

  const update = db.prepare(
    'UPDATE merchants SET deposit_reference = ? WHERE id = ? AND deposit_reference IS NULL',
  );
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const reference = normalize(newReference());
    try {
      update.run(reference, merchantId);
      return reference;
    } catch (error) {
      // Only a duplicate is worth another draw; anything else is a real fault
      // and must not be retried into silence.
      if (!(error instanceof Error && /UNIQUE constraint failed/i.test(error.message))) throw error;
    }
  }
  throw new Error(
    `Could not draw an unused deposit reference for ${merchantId} in ${String(attempts)} attempts. ` +
      'This is not collision pressure at any plausible scale — suspect the generator.',
  );
}

/**
 * Whose per-shop reference is this?
 *
 * Matched whole, against the **normalised** form, and never on amount or date.
 * §20.1: a reference that does not resolve goes to a person.
 */
export const findMerchantByDepositReference = (
  db: Db,
  reference: string,
): MerchantRow | undefined =>
  db.prepare('SELECT * FROM merchants WHERE deposit_reference = ?').get(reference) as
    | MerchantRow
    | undefined;

export function findMerchant(db: Db, id: MerchantId): MerchantRow | undefined {
  return db.prepare('SELECT * FROM merchants WHERE id = ?').get(id) as MerchantRow | undefined;
}

export function saveDevice(db: Db, input: DeviceInput): DeviceRow {
  db.prepare(
    `INSERT INTO devices (id, merchant_id, status, device_type, created_at, updated_at)
     VALUES (@id, @merchantId, @status, @deviceType, @at, @at)
     ON CONFLICT(id) DO UPDATE SET status = @status, updated_at = @at`,
  ).run({
    id: input.id,
    merchantId: input.merchantId,
    status: input.status,
    deviceType: input.deviceType,
    at: input.at,
  });

  const row = findDevice(db, input.id);
  if (!row) throw new Error(`Device ${input.id} was not persisted`);
  return row;
}

/**
 * Find a device, optionally scoped to a merchant.
 *
 * When `merchantId` is supplied the filter is applied **in SQL**. A device
 * belonging to another merchant is not found — it is not fetched and then
 * checked, which is the pattern that leaks rows when a check is forgotten.
 */
export function findDevice(db: Db, id: string, merchantId?: MerchantId): DeviceRow | undefined {
  if (merchantId === undefined) {
    return db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined;
  }
  return db.prepare('SELECT * FROM devices WHERE id = ? AND merchant_id = ?').get(id, merchantId) as
    | DeviceRow
    | undefined;
}

/** Throw unless the device belongs to the merchant. */
export function assertDeviceOwnership(db: Db, deviceId: string, merchantId: MerchantId): void {
  const row = findDevice(db, deviceId, merchantId);
  if (!row) {
    throw new MerchantScopeViolationError(
      `Device ${deviceId} does not belong to merchant ${merchantId}`,
    );
  }
}
