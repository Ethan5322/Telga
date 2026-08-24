import type { Migration } from './index';

/**
 * Pending resolution jobs and support cases.
 *
 * `pending_resolutions` is what makes a timeout resolvable rather than merely
 * survivable: a transaction that reaches PENDING gets a row here recording when
 * it first went pending, how many status lookups have been attempted, and the
 * deadline after which it must be escalated to UNDER_REVIEW. Without it, a
 * silent provider would leave merchant value held with nothing scheduled to
 * chase it.
 *
 * `support_cases` is created automatically when a transaction is escalated, so
 * a merchant whose funds are held always has a reference to quote.
 */
export const m004PendingAndSupport: Migration = {
  version: '004',
  name: 'pending_and_support',
  sql: `
CREATE TABLE pending_resolutions (
  transaction_id      TEXT PRIMARY KEY REFERENCES transactions(id),
  merchant_id         TEXT NOT NULL REFERENCES merchants(id),
  idempotency_key     TEXT NOT NULL,
  provider_reference  TEXT,
  correlation_id      TEXT NOT NULL,
  attempts            INTEGER NOT NULL CHECK (attempts >= 0),
  status              TEXT NOT NULL CHECK (status IN ('AWAITING','RESOLVED','ESCALATED')),
  first_pending_at    TEXT NOT NULL,
  last_attempt_at     TEXT,
  deadline_at         TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
) STRICT;

CREATE INDEX idx_pending_status ON pending_resolutions(status);
CREATE INDEX idx_pending_merchant ON pending_resolutions(merchant_id);

CREATE TABLE support_cases (
  id             TEXT PRIMARY KEY,
  merchant_id    TEXT NOT NULL REFERENCES merchants(id),
  transaction_id TEXT REFERENCES transactions(id),
  reason         TEXT NOT NULL CHECK (reason IN (
                   'UNDER_REVIEW','REVERSAL_REQUIRED','MERCHANT_REPORTED','PROVIDER_DISPUTE')),
  status         TEXT NOT NULL CHECK (status IN ('OPEN','AWAITING_PROVIDER','RESOLVED','CLOSED')),
  reference      TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX idx_support_reference ON support_cases(reference);
CREATE INDEX idx_support_merchant ON support_cases(merchant_id);
CREATE INDEX idx_support_transaction ON support_cases(transaction_id);
`,
};
