import type { Migration } from './index';

/**
 * Initial schema.
 *
 * Every table is STRICT, so a text value can never land in an integer money
 * column. Money is `amount_minor INTEGER` throughout — there is no REAL column
 * anywhere in this schema, which is ledger invariant 9 enforced by the engine.
 *
 * `mode` is constrained to `'TRAINING'` on merchants, transactions and ledger
 * entries. Storing live-money data is not merely disabled in application code;
 * the database rejects it.
 */
export const m001InitialSchema: Migration = {
  version: '001',
  name: 'initial_schema',
  sql: `
CREATE TABLE merchants (
  id          TEXT PRIMARY KEY,
  status      TEXT NOT NULL CHECK (status IN ('ONBOARDING','ACTIVE','SUSPENDED','CLOSED')),
  mode        TEXT NOT NULL CHECK (mode = 'TRAINING'),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;

CREATE TABLE devices (
  id          TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  status      TEXT NOT NULL CHECK (status IN ('REGISTERED','ACTIVE','STOPPED','LOST')),
  device_type TEXT NOT NULL CHECK (device_type IN ('ANDROID_PHONE','SMART_POS','WEB_POS')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;

CREATE INDEX idx_devices_merchant ON devices(merchant_id);

CREATE TABLE transactions (
  id                  TEXT PRIMARY KEY,
  merchant_id         TEXT NOT NULL REFERENCES merchants(id),
  device_id           TEXT NOT NULL REFERENCES devices(id),
  operator_id         TEXT,
  product_type        TEXT NOT NULL,
  provider_id         TEXT,
  amount_minor        INTEGER NOT NULL CHECK (amount_minor > 0),
  currency            TEXT NOT NULL CHECK (currency = 'ETB'),
  recipient_masked    TEXT NOT NULL,
  recipient_hash      TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN (
                        'CREATED','VALIDATED','RESERVED','SUBMITTED','PROCESSING','PENDING',
                        'UNDER_REVIEW','REVERSAL_REQUIRED','SUCCESSFUL','FAILED','REVERSED','REJECTED')),
  idempotency_key     TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  provider_reference  TEXT,
  mode                TEXT NOT NULL CHECK (mode = 'TRAINING'),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX idx_transactions_merchant_idempotency
  ON transactions(merchant_id, idempotency_key);
CREATE INDEX idx_transactions_merchant ON transactions(merchant_id);
CREATE INDEX idx_transactions_state ON transactions(state);

CREATE TABLE idempotency_records (
  key                 TEXT NOT NULL,
  merchant_id         TEXT NOT NULL REFERENCES merchants(id),
  request_identity    TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  transaction_id      TEXT NOT NULL REFERENCES transactions(id),
  result_state        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (merchant_id, key)
) STRICT;

CREATE INDEX idx_idempotency_transaction ON idempotency_records(transaction_id);

CREATE TABLE ledger_accounts (
  id           TEXT PRIMARY KEY,
  merchant_id  TEXT REFERENCES merchants(id),
  account_type TEXT NOT NULL CHECK (account_type IN (
                 'MERCHANT_FUNDS','MERCHANT_AVAILABLE','MERCHANT_RESERVED','MERCHANT_UNDER_REVIEW',
                 'TELGA_REVENUE','PROVIDER_SETTLEMENT','HARDWARE_DEPOSITS','REFUND_RESERVES','BANK_CLEARING')),
  currency     TEXT NOT NULL CHECK (currency = 'ETB'),
  created_at   TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX idx_accounts_merchant_type
  ON ledger_accounts(merchant_id, account_type) WHERE merchant_id IS NOT NULL;

CREATE TABLE ledger_entries (
  id                 TEXT PRIMARY KEY,
  posting_id         TEXT NOT NULL,
  transaction_id     TEXT REFERENCES transactions(id),
  account_id         TEXT NOT NULL REFERENCES ledger_accounts(id),
  merchant_id        TEXT REFERENCES merchants(id),
  account_type       TEXT NOT NULL,
  direction          TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_minor       INTEGER NOT NULL CHECK (amount_minor > 0),
  currency           TEXT NOT NULL CHECK (currency = 'ETB'),
  entry_type         TEXT NOT NULL CHECK (entry_type IN (
                       'FUNDING_CREDIT','SALE_DEBIT','COMMISSION_CREDIT','FEE_DEBIT','REVERSAL','ADJUSTMENT')),
  correlation_id     TEXT NOT NULL,
  rule_version       TEXT,
  provider_reference TEXT,
  metadata           TEXT,
  mode               TEXT NOT NULL CHECK (mode = 'TRAINING'),
  created_at         TEXT NOT NULL
) STRICT;

CREATE INDEX idx_entries_posting ON ledger_entries(posting_id);
CREATE INDEX idx_entries_merchant ON ledger_entries(merchant_id);
CREATE INDEX idx_entries_transaction ON ledger_entries(transaction_id);
CREATE INDEX idx_entries_account ON ledger_entries(account_id);

CREATE TABLE balance_reservations (
  id             TEXT PRIMARY KEY,
  merchant_id    TEXT NOT NULL REFERENCES merchants(id),
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
  currency       TEXT NOT NULL CHECK (currency = 'ETB'),
  status         TEXT NOT NULL CHECK (status IN ('HELD','UNDER_REVIEW','RELEASED','SETTLED')),
  correlation_id TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  released_at    TEXT
) STRICT;

CREATE UNIQUE INDEX idx_reservations_transaction ON balance_reservations(transaction_id);
CREATE INDEX idx_reservations_merchant ON balance_reservations(merchant_id);

CREATE TABLE audit_events (
  id             TEXT PRIMARY KEY,
  actor_type     TEXT NOT NULL,
  actor_id       TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT,
  merchant_id    TEXT,
  correlation_id TEXT NOT NULL,
  metadata       TEXT,
  created_at     TEXT NOT NULL
) STRICT;

CREATE INDEX idx_audit_merchant ON audit_events(merchant_id);
CREATE INDEX idx_audit_entity ON audit_events(entity_type, entity_id);
CREATE INDEX idx_audit_correlation ON audit_events(correlation_id);
`,
};
