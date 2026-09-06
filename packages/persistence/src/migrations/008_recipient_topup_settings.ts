import type { Migration } from './index';

/**
 * Recipient, top-up, and merchant settings.
 *
 * Three changes, each supporting a later stage:
 *
 *   1. **`pending_orders.recipient`** — the customer's phone number for an
 *      airtime sale. Nullable, because every order written before this
 *      migration genuinely had none: the voucher flow was denomination-only
 *      by design. A backfill would have to invent numbers, so the column
 *      records the honest absence instead.
 *
 *   2. **A widened `product_type`** — `TOPUP` alongside `AIRTIME`. Direct
 *      top-up is a different product with a different flow (no denomination,
 *      an operator-typed amount, a phone number), and the previous
 *      single-value CHECK made it unstorable.
 *
 *   3. **`settings`** — merchant-scoped key/value rows for slip size,
 *      advertisement text and the training profit percentage. Deliberately
 *      key/value rather than a column per setting: these are training
 *      presentation and rate values that will churn, and a table that needs
 *      a migration for each new one would make every small change a schema
 *      change.
 *
 * ## Why `pending_orders` is rebuilt rather than altered
 *
 * SQLite can add a column with `ALTER TABLE`, but it cannot change a CHECK
 * constraint. Change (2) therefore requires the standard rebuild, and since
 * the table is being rebuilt anyway change (1) rides along in the same new
 * shape rather than as a separate `ALTER`.
 *
 * ## No data is lost
 *
 * Every existing column is copied across by name, in a single transaction the
 * migrator wraps. `recipient` is the only new column and it is nullable, so
 * existing rows land as `NULL` rather than being rejected by a NOT NULL they
 * cannot satisfy. Both indexes are recreated identically. Nothing in
 * `transactions`, `ledger_entries` or `audit_events` is touched.
 *
 * `pending_orders` also holds no value of its own: it is a short-lived
 * intent record that expires after ten minutes, and the ledger and
 * transaction history are elsewhere. Even a total loss of this table would
 * cost nothing but in-flight orders — which is not the case here, but is
 * worth knowing when judging the risk of the rebuild.
 */
export const m008RecipientTopupSettings: Migration = {
  version: '008',
  name: 'recipient_topup_settings',
  sql: `
CREATE TABLE pending_orders_new (
  id                  TEXT PRIMARY KEY,
  merchant_id         TEXT NOT NULL REFERENCES merchants(id),
  device_id           TEXT NOT NULL REFERENCES devices(id),
  operator_id         TEXT NOT NULL REFERENCES merchant_users(id),
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  network             TEXT NOT NULL,
  product_type        TEXT NOT NULL CHECK (product_type IN ('AIRTIME','TOPUP')),
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
  created_at, expires_at, transaction_id, NULL
FROM pending_orders;

DROP TABLE pending_orders;
ALTER TABLE pending_orders_new RENAME TO pending_orders;

CREATE INDEX idx_pending_orders_session ON pending_orders(session_id, status);
CREATE UNIQUE INDEX idx_pending_orders_merchant_client_request
  ON pending_orders(merchant_id, client_request_id);

-- Merchant-scoped training settings. The key is constrained so a typo
-- becomes a refused write rather than a setting that silently never applies.
CREATE TABLE settings (
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  key         TEXT NOT NULL CHECK (key IN (
                'SLIP_SIZE','SLIP_ADVERT','PROFIT_PERCENT_BPS')),
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (merchant_id, key)
) STRICT;
`,
};
