/**
 * Merchant-scoped training settings.
 *
 * Key/value rather than a column per setting: slip size, advertisement text
 * and the training profit rate are presentation and rate values that will
 * churn, and a table needing a migration for each new one would make every
 * small change a schema change.
 *
 * The key set is constrained in SQL (migration 008), so a typo is a refused
 * write rather than a setting that silently never applies.
 */

import type { MerchantId, Timestamp } from '@telga/domain';
import type { Db } from '../sqlite/connection';

/**
 * Every setting a merchant may store.
 *
 * The first three are presentation and rate. The `BUSINESS_*` keys and
 * `SLIP_FOOTER` are the shop's own identity, printed on the slip so a
 * customer holding one knows which shop it came from — added by migration
 * 011. **Telga verifies none of them**: an owner types their own trading name
 * and licence number and the slip prints what it was given.
 */
export type SettingKey =
  | 'SLIP_SIZE'
  | 'SLIP_ADVERT'
  | 'PROFIT_PERCENT_BPS'
  | 'BUSINESS_NAME'
  | 'BUSINESS_ADDRESS'
  | 'BUSINESS_PHONE'
  | 'BUSINESS_TIN'
  | 'BUSINESS_LICENCE'
  | 'SLIP_FOOTER'
  // In-app preferences and local policy (migration 012). All have safe
  // defaults when absent, so a shop that never opens Settings is unaffected.
  | 'SOUND_ENABLED'
  | 'HIDE_BALANCE'
  | 'LOW_BALANCE_ALERT'
  | 'LOW_BALANCE_THRESHOLD_MINOR'
  | 'LOCK_SECONDS'
  | 'STATEMENTS_ADMIN_ONLY'
  | 'PRINT_BARCODE'
  | 'PRINT_LOOKUP_SLIP'
  | 'PIN_LOCK_ENABLED';

/** The on/off preferences, in the order Settings shows them. */
export const TOGGLE_SETTING_KEYS: readonly SettingKey[] = Object.freeze([
  'SOUND_ENABLED',
  'HIDE_BALANCE',
  'LOW_BALANCE_ALERT',
  'STATEMENTS_ADMIN_ONLY',
  'PRINT_BARCODE',
  'PRINT_LOOKUP_SLIP',
  'PIN_LOCK_ENABLED',
]);

/** The corporate-identity subset, in the order they are shown and printed. */
export const CORPORATE_SETTING_KEYS: readonly SettingKey[] = Object.freeze([
  'BUSINESS_NAME',
  'BUSINESS_ADDRESS',
  'BUSINESS_PHONE',
  'BUSINESS_TIN',
  'BUSINESS_LICENCE',
  'SLIP_FOOTER',
]);

export interface SettingRow {
  merchant_id: string;
  key: SettingKey;
  value: string;
  updated_at: string;
}

export function readSetting(db: Db, merchantId: MerchantId, key: SettingKey): string | undefined {
  const row = db
    .prepare('SELECT value FROM settings WHERE merchant_id = ? AND key = ?')
    .get(merchantId, key) as { value: string } | undefined;
  return row?.value;
}

export function readSettings(db: Db, merchantId: MerchantId): readonly SettingRow[] {
  return db
    .prepare('SELECT * FROM settings WHERE merchant_id = ? ORDER BY key')
    .all(merchantId) as SettingRow[];
}

/** Insert or replace one setting. */
export function writeSetting(
  db: Db,
  merchantId: MerchantId,
  key: SettingKey,
  value: string,
  at: Timestamp,
): void {
  db.prepare(
    `INSERT INTO settings (merchant_id, key, value, updated_at)
     VALUES (@merchantId, @key, @value, @at)
     ON CONFLICT(merchant_id, key) DO UPDATE SET value = @value, updated_at = @at`,
  ).run({ merchantId, key, value, at });
}
