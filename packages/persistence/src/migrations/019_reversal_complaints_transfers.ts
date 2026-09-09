import type { Migration } from './index';

/**
 * Three features that all move money, and the rows they need.
 *
 * `CLAUDE.md` §17.1 (merchant-initiated reversal), §17.2 (complaint
 * verification) and §19.1 (shop-to-shop transfer). One migration rather than
 * three because they share a spine: a merchant asks for something, Telga
 * decides, and the decision is answerable afterwards.
 *
 * ## What is deliberately not here
 *
 * **A balance column.** None of these tables holds an amount that a balance is
 * read from. Money lives in `ledger_entries` and nowhere else — §13's ledger is
 * append-only and every debit has a matching credit. A `reversal_requests.
 * amount_minor` is the *asked-for* figure, evidence of what a merchant claimed;
 * the settled figure is whatever the ledger says. Storing a balance here would
 * create a second answer to "how much does this shop have", and the two would
 * eventually disagree.
 *
 * **A verdict that settles itself.** `complaint_reviews` records a human's
 * decision. Nothing in this schema causes money to move; the ledger write is a
 * separate, authorised act.
 */
export const m019ReversalComplaintsTransfers: Migration = {
  version: '019',
  name: 'reversal_complaints_transfers',
  sql: `
    -- ---------------------------------------------------------------------
    -- §17.1 — a merchant asking for a sale to be reversed
    -- ---------------------------------------------------------------------
    --
    -- A request, not a reversal. The transaction moves to REVERSAL_REQUIRED and
    -- a supervisor completes it; §13 invariant 8 — "corrections are authorized
    -- adjustment entries, never silent edits".
    CREATE TABLE reversal_requests (
      id                TEXT PRIMARY KEY,
      transaction_id    TEXT NOT NULL REFERENCES transactions(id),
      merchant_id       TEXT NOT NULL REFERENCES merchants(id),
      -- Who at the counter asked. A reversal is a claim about what happened in
      -- a shop, and the person making it is part of the record.
      requested_by      TEXT NOT NULL,
      device_id         TEXT NOT NULL REFERENCES devices(id),
      -- The merchant's own words. Shown to whoever reviews it.
      reason            TEXT NOT NULL,
      -- What the merchant asked for. NOT the settled figure — see the note
      -- above. The ledger is the only place a settled amount exists.
      amount_minor      INTEGER NOT NULL CHECK (amount_minor > 0),
      -- Read at the moment of asking, never inferred later. UNKNOWN is a real
      -- answer: §17 forbids auto-refunding an unknown outcome.
      redemption        TEXT NOT NULL CHECK (redemption IN ('REDEEMED','UNREDEEMED','UNKNOWN')),
      status            TEXT NOT NULL CHECK (status IN (
                          'REQUESTED','NEEDS_APPROVAL','APPROVED','REFUSED','SETTLED'
                        )),
      -- Set when a supervisor decides. Both, or neither.
      decided_by        TEXT,
      decided_at        TEXT,
      decision_reason   TEXT,
      -- The reversal transaction this produced, once it settles.
      reversal_entry_id TEXT,
      correlation_id    TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    ) STRICT;

    -- One open request per transaction. A merchant filing twice does not make
    -- it move faster, and two open requests is two people deciding separately.
    CREATE UNIQUE INDEX idx_reversal_open_per_transaction
      ON reversal_requests(transaction_id)
      WHERE status IN ('REQUESTED','NEEDS_APPROVAL','APPROVED');

    CREATE INDEX idx_reversal_requests_queue ON reversal_requests(status, created_at);

    -- ---------------------------------------------------------------------
    -- §17.2 — verifying a complaint
    -- ---------------------------------------------------------------------
    --
    -- Extends support_cases rather than replacing it. A second case system
    -- would mean two places to look for the same complaint, and the one nobody
    -- checked would be the one that mattered.
    CREATE TABLE complaint_reviews (
      id               TEXT PRIMARY KEY,
      support_case_id  TEXT NOT NULL REFERENCES support_cases(id),
      merchant_id      TEXT NOT NULL REFERENCES merchants(id),
      -- What the shop said happened, in their words.
      description      TEXT NOT NULL,
      -- The evidence, each read at review time and recorded as read. Nullable
      -- because "we could not tell" is the honest answer often enough to need
      -- representing, and is what sends a case to UNCERTAIN.
      telga_state      TEXT,
      provider_state   TEXT,
      redemption       TEXT CHECK (redemption IS NULL OR redemption IN
                         ('REDEEMED','UNREDEEMED','UNKNOWN')),
      verdict          TEXT CHECK (verdict IS NULL OR verdict IN
                         ('LEGITIMATE','SCAM','UNCERTAIN')),
      -- Who decided, and why. A verdict without a reason is not a review.
      reviewed_by      TEXT,
      reviewed_at      TEXT,
      verdict_reason   TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    ) STRICT;

    CREATE INDEX idx_complaint_reviews_case ON complaint_reviews(support_case_id);
    CREATE INDEX idx_complaint_reviews_queue ON complaint_reviews(verdict, created_at);

    -- ---------------------------------------------------------------------
    -- §19.1 — balance moving between two shops
    -- ---------------------------------------------------------------------
    --
    -- TRAINING ONLY. Real money is blocked by money.live, which is false and
    -- asserted at startup — not by this table and not by the feature flag.
    CREATE TABLE shop_transfers (
      id                  TEXT PRIMARY KEY,
      sender_merchant_id  TEXT NOT NULL REFERENCES merchants(id),
      -- The device that authorised it. A transfer is an act by a machine and an
      -- operator, and the ledger records which.
      sender_device_id    TEXT NOT NULL REFERENCES devices(id),
      sender_operator_id  TEXT NOT NULL,
      -- Named by the recipient's DEVICE ID at the counter, resolved to a
      -- merchant here. §18.2: a device key is a credential and must never be
      -- read aloud from one shop to another.
      recipient_device_id TEXT NOT NULL REFERENCES devices(id),
      recipient_merchant_id TEXT NOT NULL REFERENCES merchants(id),
      -- What the recipient receives. The fee is charged on top, to the sender,
      -- so both parties agree on this one number.
      amount_minor        INTEGER NOT NULL CHECK (amount_minor > 0),
      fee_minor           INTEGER NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
      status              TEXT NOT NULL CHECK (status IN (
                            'REQUESTED','NEEDS_APPROVAL','SETTLED','REFUSED'
                          )),
      refusal_reason      TEXT,
      approved_by         TEXT,
      approved_at         TEXT,
      posting_id          TEXT,
      correlation_id      TEXT NOT NULL,
      mode                TEXT NOT NULL CHECK (mode = 'TRAINING'),
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      -- A shop cannot send to itself. Enforced here as well as in the domain
      -- rule, because a constraint the database holds survives a caller that
      -- forgets to ask.
      CHECK (sender_merchant_id <> recipient_merchant_id)
    ) STRICT;

    CREATE INDEX idx_shop_transfers_sender ON shop_transfers(sender_merchant_id, created_at);
    CREATE INDEX idx_shop_transfers_recipient ON shop_transfers(recipient_merchant_id, created_at);
    CREATE INDEX idx_shop_transfers_queue ON shop_transfers(status, created_at);
  `,
};
