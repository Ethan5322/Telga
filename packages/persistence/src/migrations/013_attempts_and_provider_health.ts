import type { Migration } from './index';

/**
 * Provider attempts, and provider health over time.
 *
 * Two entities CLAUDE.md §12 names in the minimum domain model and that this
 * build had nowhere to put: `TransactionAttempt` and `ProviderHealthEvent`.
 *
 * ## 1. `transaction_attempts`
 *
 * One row per **submission to a provider**, not per transaction. CLAUDE.md §14
 * has a transaction that can be submitted, time out, become `PENDING`, be
 * polled, and resolve — and §30 forbids retrying an uncertain outcome as a new
 * transaction. So a single logical transaction legitimately produces several
 * provider round-trips, and until now the only trace of them was a counter on
 * the recovery claim.
 *
 * That counter answers "how many times have we asked". It cannot answer the
 * questions a dispute actually turns on: *when* did we ask, *what did the
 * provider say each time*, and *which attempt produced the reference the
 * customer is holding*. §17 gives a 24-hour target for a final answer on a
 * "paid but no airtime" complaint; this table is what makes that answerable
 * from the record rather than from a log file that may have rotated.
 *
 * `UNIQUE (transaction_id, attempt_no)` is the important constraint. It makes
 * a duplicate attempt number a write failure rather than a second row, so the
 * sequence cannot silently fork — which is the shape a duplicate-vending bug
 * would take in the record even when the ledger stayed correct.
 *
 * `outcome` is nullable on purpose: a row is written when an attempt *starts*,
 * and an attempt that never comes back is exactly the case worth having a row
 * for. A `NULL` outcome with a `NULL` finished_at is "we asked and never heard
 * back", which is the truth §15 requires the product to be able to state.
 *
 * ## 2. `provider_health_events`
 *
 * §16 requires outage isolation — block one product, keep the rest sellable —
 * and §26 asks for outage duration as a pilot metric. Both need the moments a
 * provider changed state, not just what it is now. Health is currently derived
 * in memory and lost on restart, so "how long was Network A down yesterday"
 * has no answer at all.
 *
 * Deliberately **not** keyed to a merchant: a provider outage is a platform
 * fact, the same for every shop. Attributing it per merchant would invite
 * per-merchant overrides, and §16 says plainly there is no merchant override.
 *
 * ## What this migration does not do
 *
 * Nothing writes to either table yet. This creates the shape; the orchestration
 * that fills it is separate work, and shipping an empty table is safer than
 * shipping a half-wired one. Neither table is read by any balance, ledger or
 * receipt path, so an empty one changes no behaviour.
 *
 * ## No data is touched
 *
 * Both tables are new. No existing table is altered, rebuilt, or read. Nothing
 * in `transactions`, `ledger_entries`, `audit_events` or `recovery_claims`
 * changes, and no CHECK constraint is widened.
 *
 * ## Rollback
 *
 * Forward-fix only, like every migration here. Because both tables are purely
 * additive and nothing reads them, the practical undo is `DROP TABLE` on each
 * in a later migration — no row moves, so no history is at risk. The migrator
 * wraps this in one transaction, so a failure leaves the database untouched
 * and unrecorded.
 */
export const m013AttemptsAndProviderHealth: Migration = {
  version: '013',
  name: 'attempts_and_provider_health',
  sql: `
    -- One row per provider round-trip. Several may belong to one transaction:
    -- CLAUDE.md §30 requires an uncertain retry to reuse the same logical
    -- transaction, so the attempts are what distinguish the tries.
    CREATE TABLE transaction_attempts (
      id                 TEXT PRIMARY KEY,
      transaction_id     TEXT NOT NULL REFERENCES transactions(id),
      -- 1 for the first submission. Unique per transaction, so the sequence
      -- cannot fork into two rows claiming to be the same attempt.
      attempt_no         INTEGER NOT NULL,
      started_at         TEXT NOT NULL,
      -- NULL while in flight, and NULL forever for an attempt that never came
      -- back. That is a real state, not missing data.
      finished_at        TEXT,
      -- NULL means "no answer yet". The named outcomes mirror the mock
      -- provider's behaviours so a contract test and a real adapter record
      -- the same vocabulary.
      outcome            TEXT CHECK (outcome IS NULL OR outcome IN (
                           'SUCCESS', 'FAILURE', 'TIMEOUT', 'MALFORMED', 'NOT_ANSWERED'
                         )),
      -- What the provider called it, when it said anything.
      provider_reference TEXT,
      provider_id        TEXT NOT NULL,
      -- Ties this attempt to the worker's own log lines. Carries no personal
      -- data, so it is safe to show a merchant on a support screen.
      correlation_id     TEXT NOT NULL,
      UNIQUE (transaction_id, attempt_no)
    ) STRICT;

    CREATE INDEX idx_attempts_transaction ON transaction_attempts(transaction_id, attempt_no);
    -- "What is still in flight" — the query the recovery sweep asks.
    CREATE INDEX idx_attempts_unfinished ON transaction_attempts(finished_at) WHERE finished_at IS NULL;

    -- A provider changing state. Platform-wide, never per merchant: an outage
    -- is the same fact for every shop, and §16 allows no merchant override.
    CREATE TABLE provider_health_events (
      id             TEXT PRIMARY KEY,
      provider_id    TEXT NOT NULL,
      at             TEXT NOT NULL,
      status         TEXT NOT NULL CHECK (status IN ('HEALTHY', 'DEGRADED', 'UNAVAILABLE')),
      -- The status this provider was in immediately before. NULL for the first
      -- event ever recorded for a provider. Storing it makes an outage's
      -- duration answerable from two adjacent rows without a window function.
      previous_status TEXT CHECK (previous_status IS NULL OR previous_status IN (
                        'HEALTHY', 'DEGRADED', 'UNAVAILABLE'
                      )),
      -- Plain text for an operator, never a provider error dump: whatever is
      -- written here can reach a support screen.
      detail         TEXT,
      correlation_id TEXT
    ) STRICT;

    -- "How was this provider between these two times" — the outage-duration
    -- query §26 asks for.
    CREATE INDEX idx_health_provider_at ON provider_health_events(provider_id, at);
  `,
};
