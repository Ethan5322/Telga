import type { Migration } from './index';

/**
 * Corporate settings: who the shop is, printed on every slip.
 *
 * Migration 008 created `settings` with a CHECK listing three keys — slip
 * size, advertisement, profit rate. Those are presentation and rate values.
 * What was missing is the shop's own identity: a slip that says only
 * `merchant_alpha` is a debugging artefact, not a receipt a customer can take
 * to a shop and be recognised at.
 *
 * Six keys are added:
 *
 * | Key | On the slip |
 * |---|---|
 * | `BUSINESS_NAME` | the trading name, in place of the merchant id |
 * | `BUSINESS_ADDRESS` | where the shop is |
 * | `BUSINESS_PHONE` | how a customer reaches the shop, not Telga |
 * | `BUSINESS_TIN` | tax identification number, where one is displayed |
 * | `BUSINESS_LICENCE` | trade licence number, where one is displayed |
 * | `SLIP_FOOTER` | a closing line, separate from the advertisement |
 *
 * ## These are labels, not claims
 *
 * Telga does not verify any of them. An owner types their own trading name
 * and licence number, and the slip prints what it was given. Nothing here
 * asserts that a business is registered, licensed, or tax-compliant — see
 * CLAUDE.md §8, which forbids claiming compliance without documented review.
 * The `TRAINING — NO REAL VALUE` banner still prints above all of it.
 *
 * ## Why the CHECK is widened rather than dropped
 *
 * The constraint is what turns a typo into a refused write instead of a
 * setting that silently never applies. SQLite cannot alter a CHECK, so the
 * table is rebuilt — the same pattern migrations 008, 009 and 010 use.
 *
 * ## No data is lost
 *
 * Every existing row is copied by name inside the transaction the migrator
 * wraps. The primary key is recreated identically. Only `settings` is
 * touched; `pending_orders`, `transactions` and `ledger_entries` are not.
 *
 * ## Rollback
 *
 * Forward-fix only, like every migration here. To undo: restore from a
 * backup taken before it (`npm run restore`). A database migrated but never
 * written to by corporate-settings-aware code is functionally identical to
 * one that was not — the new keys simply have no rows.
 */
export const m011CorporateSettings: Migration = {
  version: '011',
  name: 'corporate_settings',
  sql: `
CREATE TABLE settings_new (
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  key         TEXT NOT NULL CHECK (key IN (
                'SLIP_SIZE','SLIP_ADVERT','PROFIT_PERCENT_BPS',
                'BUSINESS_NAME','BUSINESS_ADDRESS','BUSINESS_PHONE',
                'BUSINESS_TIN','BUSINESS_LICENCE','SLIP_FOOTER')),
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (merchant_id, key)
) STRICT;

INSERT INTO settings_new (merchant_id, key, value, updated_at)
SELECT merchant_id, key, value, updated_at FROM settings;

DROP TABLE settings;
ALTER TABLE settings_new RENAME TO settings;
`,
};
