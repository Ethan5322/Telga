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
