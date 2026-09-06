import type { Migration } from './index';

/**
 * Voucher pending orders, and a third `auth_attempts` scope.
 *
 * ## `pending_orders`
 *
 * Created once, at the amount-selection step, holding the network, product
 * and amount a client cannot change afterward. PIN authorization only ever
 * reads this row by id plus the authenticated session/device/merchant — it
 * never re-accepts those three fields from a request body. `client_request_id`
 * is generated once, at creation, and reused for the eventual `createSale`
 * call, so the existing idempotency mechanism (`idempotency_records`) covers
 * a duplicate PIN submission exactly as it already covers a duplicate `/sell`
 * submission — no new duplicate-prevention mechanism was invented.
 *
 * `total_minor = amount_minor` is enforced by a CHECK rather than left
 * implicit: quantity is deferred (see `07 Governance/Decision Log.md`), and a
 * table that could silently hold `total_minor != amount_minor` would be a
 * table with an unenforced invariant waiting for a bug to find it.
 *
 * ## Widening `auth_attempts.scope`
 *
 * SQLite has no `ALTER TABLE ... MODIFY CHECK`, so adding `'PIN_AUTH'` to the
 * scope list is a table rebuild: create the new shape, copy every existing
 * row across unchanged, drop the old table, rename. Column-for-column
 * identical to `006_auth_and_devices.ts` except the one CHECK list.
 *
 * `PIN_AUTH` is deliberately **not** merged into the existing lockout that
 * `merchant_users.failed_attempts` / `locked_until` already implement for
 * `LOGIN`. A wrong voucher transaction PIN must never lock a merchant out of
 * signing in — see the Decision Log entry this migration implements. The
 * lockout for `PIN_AUTH` is computed purely from recent `auth_attempts` rows
 * (a trailing-window failure count), so it needs no stored "locked until"
 * column of its own and cannot reach into `merchant_users` even by accident.
 */
export const m007PendingOrders: Migration = {
  version: '007',
  name: 'pending_orders',
  sql: `
CREATE TABLE pending_orders (
  id                  TEXT PRIMARY KEY,
  merchant_id         TEXT NOT NULL REFERENCES merchants(id),
  device_id           TEXT NOT NULL REFERENCES devices(id),
  operator_id         TEXT NOT NULL REFERENCES merchant_users(id),
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  network             TEXT NOT NULL,
  product_type        TEXT NOT NULL CHECK (product_type = 'AIRTIME'),
  product_id          TEXT NOT NULL,
  amount_minor        INTEGER NOT NULL CHECK (amount_minor > 0),
  currency            TEXT NOT NULL CHECK (currency = 'ETB'),
  total_minor         INTEGER NOT NULL CHECK (total_minor = amount_minor),
  client_request_id   TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('OPEN','AUTHORIZED','CANCELLED','EXPIRED')),
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  transaction_id      TEXT
) STRICT;

CREATE INDEX idx_pending_orders_session ON pending_orders(session_id, status);
CREATE UNIQUE INDEX idx_pending_orders_merchant_client_request
  ON pending_orders(merchant_id, client_request_id);

CREATE TABLE auth_attempts_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL CHECK (scope IN ('LOGIN','SALE','PIN_AUTH')),
  subject    TEXT NOT NULL,
  outcome    TEXT NOT NULL CHECK (outcome IN ('SUCCESS','FAILURE')),
  created_at TEXT NOT NULL
) STRICT;
INSERT INTO auth_attempts_new (id, scope, subject, outcome, created_at)
  SELECT id, scope, subject, outcome, created_at FROM auth_attempts;
DROP TABLE auth_attempts;
ALTER TABLE auth_attempts_new RENAME TO auth_attempts;
CREATE INDEX idx_auth_attempts_subject ON auth_attempts(scope, subject, created_at);
`,
};
