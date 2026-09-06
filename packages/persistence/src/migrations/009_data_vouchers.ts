import type { Migration } from './index';

/**
 * Data vouchers.
 *
 * One change: **`DATA` in `pending_orders.product_type`**. A data bundle is a
 * third product beside airtime and top-up, with its own sub-flow (category,
 * then a bundle of a given volume and validity). Approved as a
 * **training-only** flow; see [[Decision Log]] D72. The previous CHECK made
 * it unstorable, and SQLite cannot alter a CHECK, so the table is rebuilt
 * exactly as migration 008 rebuilt it.
 *
 * ## Why there is no table for voucher redemption codes
 *
 * The slip now prints a simulated PIN, token reference and dial string. It
 * would be natural to store them — and it is deliberately not done, because
 * `simulatedVoucherCode()` is a **pure function of the transaction id**. The
 * same transaction yields the same code forever, so a reprint prints exactly
 * what the first slip printed without anything being written down, a sale
 * resolved later by the recovery worker gets a code without that worker
 * knowing anything about slips, and `lookupReceipt` stays what its own
 * documentation promises: a read that writes nothing at all, not even an
 * audit event.
 *
 * A table would only buy the ability to change the generator later without
 * changing already-printed codes. For codes that are deliberately worthless
 * and clearly labelled as training, that does not justify a table, two
 * append-only triggers, and a write on the sale path.
 *
 * ## No data is lost
 *
 * Every existing column is copied across by name in the transaction the
 * migrator wraps, `recipient` included — unlike migration 008, which had to
 * insert `NULL` for a column that did not yet exist. Both indexes are
 * recreated identically. Nothing in `transactions`, `ledger_entries`,
 * `audit_events` or `settings` is touched.
 */
export const m009DataVouchers: Migration = {
  version: '009',
  name: 'data_vouchers',
  sql: `
CREATE TABLE pending_orders_new (
  id                  TEXT PRIMARY KEY,
  merchant_id         TEXT NOT NULL REFERENCES merchants(id),
  device_id           TEXT NOT NULL REFERENCES devices(id),
  operator_id         TEXT NOT NULL REFERENCES merchant_users(id),
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  network             TEXT NOT NULL,
  product_type        TEXT NOT NULL CHECK (product_type IN ('AIRTIME','TOPUP','DATA')),
  product_id          TEXT NOT NULL,
  amount_minor        INTEGER NOT NULL CHECK (amount_minor > 0),
  currency            TEXT NOT NULL CHECK (currency = 'ETB'),
  total_minor         INTEGER NOT NULL CHECK (total_minor = amount_minor),
  client_request_id   TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('OPEN','AUTHORIZED','CANCELLED','EXPIRED')),
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  transaction_id      TEXT,
  recipient           TEXT
) STRICT;

INSERT INTO pending_orders_new (
  id, merchant_id, device_id, operator_id, session_id, network, product_type,
  product_id, amount_minor, currency, total_minor, client_request_id, status,
  created_at, expires_at, transaction_id, recipient)
SELECT
  id, merchant_id, device_id, operator_id, session_id, network, product_type,
  product_id, amount_minor, currency, total_minor, client_request_id, status,
  created_at, expires_at, transaction_id, recipient
FROM pending_orders;

DROP TABLE pending_orders;
ALTER TABLE pending_orders_new RENAME TO pending_orders;

CREATE INDEX idx_pending_orders_session ON pending_orders(session_id, status);
CREATE UNIQUE INDEX idx_pending_orders_merchant_client_request
  ON pending_orders(merchant_id, client_request_id);
`,
};
