import type { Migration } from './index';

/**
 * How a shop chose to pay money in — `CLAUDE.md` §20.2.
 *
 * A top-up order already records **what** a shop intends to pay and **which**
 * reference identifies it. This adds **how**: carried to a bank counter, or paid
 * through Chapa.
 *
 * ## Why a column on the order, and not a second table
 *
 * The order is the same thing either way — an amount, a shop, a unique
 * reference, an expiry, and a status that ends in `PAID`. Only the settlement
 * path differs. A second table would duplicate every one of those fields and
 * give the console two places to look for "what is this shop waiting to pay",
 * which is how a queue develops a blind spot.
 *
 * The founder's framing, and it is the right one: *"it's one kind of bank
 * deposit method — keep the Chapa button inside bank deposit, another bank or
 * provider I will find."* More methods are expected. They are rows in this
 * column, not new tables.
 *
 * ## What `provider_reference` is, and what it is not
 *
 * Chapa's own id for the payment, learned at verification. It is **evidence for
 * the audit trail**, never a key: nothing resolves a payment by it. The
 * reference the shop quoted is what identifies the order, on every method, and
 * keeping that single answer is what stops two lookups disagreeing.
 *
 * `provider_status` is the last thing the provider said, kept so an operations
 * desk can see *why* an order is still open without calling the gateway again.
 * It is a record of a conversation, not an authority: §20.2 credits only on a
 * fresh server-to-server verification, never on a stored status.
 */
export const m022DepositMethod: Migration = {
  version: '022',
  name: 'deposit_method',
  sql: `
    -- Defaults to the counter, because every order that exists today is one.
    -- A CHECK rather than free text: an unrecognised method is a bug, and the
    -- screens that render one would have to guess.
    ALTER TABLE topup_orders
      ADD COLUMN method TEXT NOT NULL DEFAULT 'BANK_COUNTER'
      CHECK (method IN ('BANK_COUNTER', 'CHAPA'));

    -- The provider's own id for the payment. Evidence, never a key.
    ALTER TABLE topup_orders ADD COLUMN provider_reference TEXT;

    -- The last thing the provider said. Not an authority — see the note above.
    ALTER TABLE topup_orders ADD COLUMN provider_status TEXT;

    -- "What is waiting, and by which method" — the query the deposits desk runs.
    CREATE INDEX idx_topup_method_status ON topup_orders(method, status);
  `,
};
