import type { Migration } from './index';

/**
 * Recovery claim leases, and the pending metadata the sweep needs.
 *
 * `recovery_claims` is the concurrency control. A worker claims a transaction by
 * inserting or taking over a row whose lease has expired; the `WHERE` clause on
 * the upsert makes that atomic, so two workers racing for the same transaction
 * produce exactly one winner. The loser is told it lost rather than silently
 * doing the work twice.
 *
 * The lease is time-bounded on purpose: a worker that dies mid-recovery must not
 * hold a transaction hostage forever, so an expired lease is reclaimable.
 */
export const m005RecoveryClaims: Migration = {
  version: '005',
  name: 'recovery_claims',
  sql: `
CREATE TABLE recovery_claims (
  transaction_id TEXT PRIMARY KEY REFERENCES transactions(id),
  worker_id      TEXT NOT NULL,
  scan_id        TEXT NOT NULL,
  attempt_no     INTEGER NOT NULL CHECK (attempt_no >= 0),
  claimed_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  released_at    TEXT,
  status         TEXT NOT NULL CHECK (status IN ('ACTIVE','RELEASED')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;

CREATE INDEX idx_recovery_claims_status ON recovery_claims(status, expires_at);

ALTER TABLE pending_resolutions ADD COLUMN next_check_at TEXT;
ALTER TABLE pending_resolutions ADD COLUMN last_outcome_category TEXT;
ALTER TABLE pending_resolutions ADD COLUMN current_state TEXT;
ALTER TABLE pending_resolutions ADD COLUMN manual_review_status TEXT NOT NULL DEFAULT 'NONE';

ALTER TABLE support_cases ADD COLUMN approved_by TEXT;
ALTER TABLE support_cases ADD COLUMN approved_at TEXT;
`,
};
