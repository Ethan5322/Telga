import type { Migration } from './index';

/**
 * Top-up orders — the row behind the **Deposit money** button, `CLAUDE.md` §20.1.
 *
 * A shop presses the button, Telga prints a slip, the shop pays a bank. This
 * table is what makes the slip answerable afterwards: it records what was
 * promised, so that when money arrives quoting a reference, Telga knows whose
 * it is and what it was for.
 *
 * ## The reference is the identity, and the amount is not
 *
 * The founder's requirement, stated plainly: **a thousand shops depositing the
 * same amount at the same moment produce a thousand different references.**
 * Nothing here matches on amount, and nothing may be added that does. Round
 * figures repeat all day — 2,500 birr from one shop is indistinguishable from
 * 2,500 birr from another, and a system that guessed between them would credit
 * the wrong shop with the right money, which is worse than crediting nobody.
 *
 * The amount is a **cross-check**, never a key. `verifyDeposit` compares it and
 * always credits the bank's figure, not the shop's claim.
 *
 * ## Uniqueness is enforced here, not hoped for
 *
 * `newDepositReference()` says so itself: *"uniqueness is the store's job, not
 * this function's — the column carries the constraint, and a collision is a
 * retry rather than a duplicate."* This is that column.
 *
 * The reference is 8 characters plus a check character over a 32-symbol
 * alphabet — about 1.1 × 10¹² codes. At any plausible number of open orders a
 * collision is vanishingly unlikely, and **unlikely is not a guarantee.** The
 * `UNIQUE` index makes a repeat impossible rather than improbable: the insert
 * fails, the caller draws another code, and no two orders can ever carry the
 * same reference. A probabilistic argument is the wrong kind of answer when the
 * consequence is one shop being credited with another's deposit.
 *
 * The stored form is **normalised** — no grouping hyphens, upper case — because
 * the code a teller writes on a slip and the code an admin types into the
 * console must compare equal. `ABC-DEF-GHJ` and `abcdefghj` are one reference.
 *
 * ## What is deliberately not here
 *
 * **No amount that a balance is read from.** `amount_minor` is what the shop
 * *asked* to deposit — evidence of an intention. Spendable balance comes from
 * `ledger_entries` and nowhere else (§13). A second place to read a balance is
 * a second answer that eventually disagrees with the first.
 *
 * **No status that means "paid" on its own.** `PAID` is set only when a funding
 * submission has actually credited, and `funding_submission_id` names it. The
 * slip never creates money; §20.1 — *"the slip creates an expectation, never a
 * balance."*
 *
 * **No customer or owner personal data.** §22 allows a receipt no unnecessary
 * personal data, and this slip is handled by bank staff and lives in statement
 * archives afterwards. The reference identifies the shop; nothing else has to.
 */
export const m020TopupOrders: Migration = {
  version: '020',
  name: 'topup_orders',
  sql: `
    CREATE TABLE topup_orders (
      id                    TEXT PRIMARY KEY,
      merchant_id           TEXT NOT NULL REFERENCES merchants(id),
      -- Which till printed the slip, and who was standing at it. Not identity
      -- for the payment — the merchant is that — but an operations desk asked
      -- "where did this slip come from" needs an answer.
      device_id             TEXT NOT NULL,
      operator_id           TEXT NOT NULL,

      -- Normalised: upper case, no grouping hyphens. UNIQUE is the whole point
      -- of this table; see the note above.
      reference             TEXT NOT NULL,

      -- What the shop said it would pay in. A cross-check, never a key, and
      -- never the figure credited.
      amount_minor          INTEGER NOT NULL CHECK (amount_minor > 0),
      currency              TEXT NOT NULL DEFAULT 'ETB' CHECK (currency = 'ETB'),

      -- OPEN     — printed, waiting for money
      -- PAID      — a funding submission credited against this reference
      -- EXPIRED   — the window passed; the shop prints a new slip
      -- CANCELLED — the shop abandoned it before paying
      --
      -- A reference is never reused, whatever the status. An expired order
      -- keeps its code so a payment arriving late still resolves to the shop
      -- that made it, rather than to nobody.
      status                TEXT NOT NULL
                              CHECK (status IN ('OPEN','PAID','EXPIRED','CANCELLED')),

      -- Set only when money actually credited. Null on every other status.
      funding_submission_id TEXT REFERENCES funding_submissions(id),

      correlation_id        TEXT NOT NULL,
      mode                  TEXT NOT NULL CHECK (mode IN ('TRAINING','LIVE')),

      created_at            TEXT NOT NULL,
      expires_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL
    );

    -- The constraint the whole design rests on. Two orders cannot share a
    -- reference, so a payment quoting one resolves to exactly one shop.
    CREATE UNIQUE INDEX idx_topup_reference ON topup_orders(reference);

    -- "Does this shop already have a slip out?" — §20.1 allows one open order
    -- at a time, so a shopkeeper is never holding two slips wondering which to
    -- pay.
    CREATE INDEX idx_topup_merchant_status ON topup_orders(merchant_id, status);

    -- The expiry sweep reads this.
    CREATE INDEX idx_topup_expiry ON topup_orders(status, expires_at);
  `,
};
