import type { Migration } from './index';

/**
 * Deposits: what a shop claims it paid in, and what Telga did about it.
 *
 * `05 Operations/Funding Verification` designed this state flow and
 * `packages/domain/src/fundingSubmission.ts` implements the decision (D119).
 * Neither had anywhere to write, so a deposit could be decided and not recorded.
 *
 * ## The unique index is the idempotency guarantee
 *
 * `bank_reference` is unique. The same bank transaction **cannot** be credited
 * twice, whoever records it, however many times a slip is photographed or a
 * statement re-imported. That is a database constraint rather than a check in
 * application code, because a check can be forgotten on the second code path
 * and a constraint cannot.
 *
 * ## Why `deposit_lookup` exists on `device_enrollments`
 *
 * The founder decided the shop quotes its **Device Key** as the bank reference
 * (D125, R38). Implementing that exposed a problem no security argument had
 * reached: `device_enrollments` stores a **salted scrypt hash**, which is
 * deliberately slow and cannot be searched. Finding the shop for a quoted key
 * would mean running scrypt against every enrolment in the system -- at the
 * 10,000 shops the founder is planning for, that is minutes of CPU per deposit.
 *
 * So a **searchable** derivation is stored alongside: a plain SHA-256 of the
 * key. That is safe here specifically because the key is 256 bits from
 * `randomBytes` -- there is no dictionary to run against it and nothing to
 * guess -- which is exactly why scrypt is required for a *PIN* and unnecessary
 * for this. The scrypt hash still does the authenticating; this column only
 * answers "whose is it".
 *
 * ## What is deliberately not here
 *
 * No bank credentials, no statement files, and no account numbers beyond the
 * one being paid into. A deposit row names a shop, an amount, and the bank's
 * own reference for the transaction.
 */
export const m016FundingSubmissions: Migration = {
  version: '016',
  name: 'funding_submissions',
  sql: `
    CREATE TABLE funding_submissions (
      id                    TEXT PRIMARY KEY,
      -- Null until the quoted reference resolves to a shop. An unmatched
      -- deposit is a real state that a person has to settle -- it is never
      -- guessed at.
      merchant_id           TEXT REFERENCES merchants(id),
      -- What the shop wrote on the deposit. Stored as typed, so a mistyped
      -- reference can be read back and corrected by a person.
      quoted_reference      TEXT NOT NULL,
      -- The bank's own transaction reference. The idempotency key.
      bank_reference        TEXT NOT NULL,
      -- What the shop said they paid, when they said anything. Informational:
      -- the bank's figure is the one credited, whichever way the two differ.
      claimed_amount_minor  INTEGER CHECK (claimed_amount_minor IS NULL OR claimed_amount_minor > 0),
      -- What the bank recorded, and therefore what was credited.
      bank_amount_minor     INTEGER CHECK (bank_amount_minor IS NULL OR bank_amount_minor > 0),
      status                TEXT NOT NULL CHECK (status IN (
                              'SUBMITTED', 'AWAITING_VERIFICATION', 'MATCHED',
                              'CREDITED', 'REJECTED', 'DUPLICATE', 'MANUAL_REVIEW'
                            )),
      -- Why it was refused or sent to a person. A rejection without a reason is
      -- not a decision.
      outcome_reason        TEXT,
      -- The ledger posting, once credited. The link between this record and the
      -- money, so a credit can be traced to the deposit that caused it.
      posting_id            TEXT,
      -- ETB throughout, as everywhere else in this schema. Recorded rather than
      -- assumed because Funding Verification's record list names it, and a
      -- deposit whose currency is implicit is one nobody can reconcile against
      -- a bank statement that states it.
      currency              TEXT NOT NULL DEFAULT 'ETB' CHECK (currency = 'ETB'),
      -- What the verifier was looking at: a slip reference, a statement line, a
      -- wallet notification id. Free text, because the answer differs per rail.
      evidence              TEXT,
      recorded_by           TEXT REFERENCES admin_users(id),
      -- The verifier who decided. CLAUDE.md §20's "designated operations
      -- verifier".
      decided_by            TEXT REFERENCES admin_users(id),
      decided_at            TEXT,
      -- The **second** approver, for a high-value or exceptional deposit.
      --
      -- Its own column rather than a flag on decided_by, because CLAUDE.md
      -- section 20 and Funding Verification both require a *different person*,
      -- and two names in one column cannot express "different". The application
      -- refuses an approval by the admin who decided; this is what lets it check.
      approved_by           TEXT REFERENCES admin_users(id),
      approved_at           TEXT,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL,
      -- Separation of duties, in the schema rather than only in the code that
      -- writes it. A row where one person did both is refused by the database.
      CHECK (approved_by IS NULL OR decided_by IS NULL OR approved_by <> decided_by)
    ) STRICT;

    -- One bank transaction, one **credit**.
    --
    -- Partial, on CREDITED rows only, and the distinction is the whole point.
    -- An unconditional index would say "one row per bank transaction", which
    -- sounds like the same rule and is not: it would make it impossible to
    -- *record* that a slip was submitted twice. A replayed deposit is a thing
    -- that happened, an operator may be asked about it, and refusing to write it
    -- down loses the evidence while protecting nothing.
    --
    -- What must never happen is a second credit, and that is exactly what this
    -- refuses -- in the database, so a code path that forgot its duplicate check
    -- still cannot move the money twice.
    CREATE UNIQUE INDEX idx_funding_credited_once
      ON funding_submissions(bank_reference) WHERE status = 'CREDITED';

    -- Finding every record of one bank reference, credited or not.
    CREATE INDEX idx_funding_bank_reference ON funding_submissions(bank_reference);

    CREATE INDEX idx_funding_status ON funding_submissions(status, created_at);
    CREATE INDEX idx_funding_merchant ON funding_submissions(merchant_id, created_at);

    -- A searchable derivation of the device key, so a quoted reference resolves
    -- to a shop in one indexed lookup instead of a scrypt over every enrolment.
    -- Safe because the key is 256 bits of randomness; see the note above.
    ALTER TABLE device_enrollments ADD COLUMN deposit_lookup TEXT;

    CREATE UNIQUE INDEX idx_device_deposit_lookup
      ON device_enrollments(deposit_lookup) WHERE deposit_lookup IS NOT NULL;
  `,
};
