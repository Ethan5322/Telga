import type { Migration } from './index';

/**
 * Shifts, saved customers, and the shop's own preferences.
 *
 * Three things the menu and the settings screen need somewhere to live.
 *
 * ## 1. `shifts`
 *
 * A shift is the span an operator works, opened on first sale and closed by
 * "End shift". It carries no money of its own — the ledger is still the only
 * place value moves — so a shift row is a *label* over a period of time that
 * a statement can be grouped by. Closing one is recorded, never deleted: an
 * append-only `closed_at` rather than a row that disappears.
 *
 * ## 2. `customers`
 *
 * Regulars a shop types in once instead of retyping a phone number every
 * time. **The number is stored masked**, exactly as `pending_orders.recipient`
 * and `transactions.recipient_masked` already are — this table is a
 * convenience, not a reason to start keeping full numbers. A shop that wants
 * to send to a saved customer still types the number; the saved row is how
 * they recognise which customer it was.
 *
 * That is a real limitation and it is deliberate: a customer list holding
 * full numbers would be the largest pool of personal data in the product, on
 * a device that sits on a counter, in a build with no data-protection review
 * behind it (CLAUDE.md §8, §24). See `ASSUMPTIONS.md`.
 *
 * ## 3. More `settings` keys
 *
 * Sound, hiding the balance, the low-balance alert, the idle lock time, and
 * the admin-only toggles. All presentation and local policy, all per
 * merchant, all with safe defaults when absent — so a shop that has never
 * opened Settings behaves exactly as it does today.
 *
 * `settings.key` has a CHECK, and SQLite cannot alter one, so that table is
 * rebuilt as migrations 008–011 rebuilt theirs.
 *
 * ## No data is lost
 *
 * Every existing `settings` row is copied by name inside the transaction the
 * migrator wraps, and its primary key is recreated identically. `shifts` and
 * `customers` are new and empty. Nothing in `pending_orders`, `transactions`,
 * `ledger_entries` or `audit_events` is touched.
 *
 * ## Rollback
 *
 * Forward-fix only, like every migration here. To undo: restore from a backup
 * taken before it (`npm run restore`). A database migrated but never written
 * to by preference-aware code behaves identically to one that was not — the
 * new tables are empty and the new keys have no rows, so every default holds.
 */
export const m012ShiftsCustomersPreferences: Migration = {
  version: '012',
  name: 'shifts_customers_preferences',
  sql: `
CREATE TABLE settings_new (
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  key         TEXT NOT NULL CHECK (key IN (
                'SLIP_SIZE','SLIP_ADVERT','PROFIT_PERCENT_BPS',
                'BUSINESS_NAME','BUSINESS_ADDRESS','BUSINESS_PHONE',
                'BUSINESS_TIN','BUSINESS_LICENCE','SLIP_FOOTER',
                'SOUND_ENABLED','HIDE_BALANCE','LOW_BALANCE_ALERT',
                'LOW_BALANCE_THRESHOLD_MINOR','LOCK_SECONDS',
                'STATEMENTS_ADMIN_ONLY','PRINT_BARCODE','PRINT_LOOKUP_SLIP',
                'PIN_LOCK_ENABLED')),
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (merchant_id, key)
) STRICT;

INSERT INTO settings_new (merchant_id, key, value, updated_at)
SELECT merchant_id, key, value, updated_at FROM settings;

DROP TABLE settings;
ALTER TABLE settings_new RENAME TO settings;

-- A shift is a labelled span of time, not a container of money.
CREATE TABLE shifts (
  id           TEXT PRIMARY KEY,
  merchant_id  TEXT NOT NULL REFERENCES merchants(id),
  operator_id  TEXT NOT NULL REFERENCES merchant_users(id),
  device_id    TEXT NOT NULL REFERENCES devices(id),
  opened_at    TEXT NOT NULL,
  closed_at    TEXT,
  mode         TEXT NOT NULL CHECK (mode = 'TRAINING')
) STRICT;

CREATE INDEX idx_shifts_merchant_open ON shifts(merchant_id, closed_at);

-- Saved regulars. The number is stored MASKED, like everywhere else in this
-- product; this table is a convenience, not a reason to keep full numbers.
CREATE TABLE customers (
  id             TEXT PRIMARY KEY,
  merchant_id    TEXT NOT NULL REFERENCES merchants(id),
  display_name   TEXT NOT NULL,
  phone_masked   TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  mode           TEXT NOT NULL CHECK (mode = 'TRAINING')
) STRICT;

CREATE INDEX idx_customers_merchant ON customers(merchant_id, display_name);
`,
};
