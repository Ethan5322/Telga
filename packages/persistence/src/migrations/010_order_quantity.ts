import type { Migration } from './index';

/**
 * Bulk printing: an order may be for more than one voucher.
 *
 * A shop selling ten 25-birr vouchers should press PIN once, not ten times.
 * That needs two changes, and both are CHECK changes, so `pending_orders` is
 * rebuilt exactly as migrations 008 and 009 rebuilt it.
 *
 *   1. **`quantity`** — how many vouchers this order is for. `NOT NULL
 *      DEFAULT 1`, so every existing row is a single-voucher order, which is
 *      precisely what it was.
 *
 *   2. **`total_minor = amount_minor * quantity`** — the old CHECK insisted
 *      `total_minor = amount_minor`, which made a quantity above one
 *      unstorable. `amount_minor` stays the price of **one** voucher, so the
 *      denomination on the screen and the denomination in the ledger remain
 *      the same number.
 *
 * The ceiling of 20 is a training bound, not a business rule: it stops a
 * typo turning into two hundred ledger postings and a printer queue nobody
 * asked for. It lives in the CHECK as well as in the application so a
 * request that bypasses the service still cannot store one.
 *
 * ## Each voucher is still its own sale
 *
 * Nothing here batches money. A quantity of ten authorizes ten separate
 * transactions, each with its own idempotency key, its own reservation, its
 * own ledger postings and its own simulated redemption code — because ten
 * vouchers is ten things a customer can hold, and a single row could not
 * carry ten different PINs. The order is only the *intent* to create them.
 *
 * ## No data is lost
 *
 * Every existing column is copied across by name inside the transaction the
 * migrator wraps, and both indexes are recreated identically. `quantity` is
 * the only new column and every existing row lands as `1`. Nothing in
 * `transactions`, `ledger_entries`, `audit_events` or `settings` is touched.
 *
 * ## Rollback
 *
 * Forward-fix only, like every migration here. To undo: restore the database
 * from a backup taken before it (`npm run restore`). A database migrated but
 * never written to by quantity-aware code is functionally identical to one
 * that was not, because every row reads `quantity = 1`.
 */
export const m010OrderQuantity: Migration = {
  version: '010',
  name: 'order_quantity',
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
  quantity            INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 20),
  total_minor         INTEGER NOT NULL CHECK (total_minor = amount_minor * quantity),
  client_request_id   TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('OPEN','AUTHORIZED','CANCELLED','EXPIRED')),
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  transaction_id      TEXT,
  recipient           TEXT
) STRICT;

INSERT INTO pending_orders_new (
  id, merchant_id, device_id, operator_id, session_id, network, product_type,
  product_id, amount_minor, currency, quantity, total_minor, client_request_id,
  status, created_at, expires_at, transaction_id, recipient)
SELECT
  id, merchant_id, device_id, operator_id, session_id, network, product_type,
  product_id, amount_minor, currency, 1, total_minor, client_request_id,
  status, created_at, expires_at, transaction_id, recipient
FROM pending_orders;

DROP TABLE pending_orders;
ALTER TABLE pending_orders_new RENAME TO pending_orders;

CREATE INDEX idx_pending_orders_session ON pending_orders(session_id, status);
CREATE UNIQUE INDEX idx_pending_orders_merchant_client_request
  ON pending_orders(merchant_id, client_request_id);
`,
};
