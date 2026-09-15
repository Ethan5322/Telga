import type { Migration } from './index';

/**
 * The commission policy — founder fee policy, 2026-09-14.
 *
 * Three tables, because the policy asks three separate questions that were
 * previously one number in a per-shop settings row.
 *
 * ## Why none of this lives in `settings`
 *
 * `settings` is keyed `(merchant_id, key)`. Every row in it is a thing **one
 * shop decided for itself**, which is precisely what the founder ruled out:
 *
 * > *"Only the admin panel can decide the percent of commission the shop
 * > earns… shops can't decide."*
 * > *"All Telga shop owners [get] the same amount of commission from each
 * > sale, that decide by admin panel."*
 *
 * `PROFIT_PERCENT_BPS` is a per-shop row, so as long as the rate lives there,
 * "shops cannot set it" is a rule about which form fields are rendered — and a
 * rule enforced by a rendered field is one missed route away from being no rule
 * at all. Moving it to a platform-level table makes it unsettable per shop by
 * **shape**: there is no column to put a merchant id in.
 *
 * `PROFIT_PERCENT_BPS` is deliberately **not dropped**. Existing rows are
 * history — they explain what a past training sale paid — and §13 invariant 1
 * makes the historical record append-only. The sale path stops reading it; the
 * rows stay.
 *
 * ## One row, enforced
 *
 * `platform_fee_settings` holds exactly one row, pinned by `CHECK (id = 1)`. A
 * second row would be a second answer to "what does a shop earn", and the
 * first query to return them in a different order would change what shops are
 * paid without anything being edited.
 *
 * ## Why provider rates are a table and the global rate is a column
 *
 * The policy is explicit: *"Do not assume every Ethiopian operator provides
 * 3%."* A provider's commission is a term in **that provider's** contract, so
 * it is a row per provider and product, and §30 forbids inventing one. The
 * table starts **empty**. The 3% figure is Telga's own default for the
 * configuration screen — an administrator's starting point, never a rate a
 * calculation reaches for on its own.
 *
 * ## Why `commission_entries` keeps five figures and not one
 *
 * §13 requires customer funds, provider commission, shop earnings and Telga
 * revenue to stay traceable end to end, and the policy's own settlement
 * section says the same. A single "profit" column cannot answer "what did the
 * provider owe us, and what did we keep" after the rate has changed — and the
 * rate *will* change, since an administrator can edit it. So each entry
 * records the amount, the rates, and all three money figures **as they were at
 * the moment of the sale**.
 *
 * Settlement and reversal are separate columns rather than states of one,
 * because they are independent facts: a commission can be settled and later
 * reversed, and collapsing them loses which happened.
 */
export const m023CommissionPolicy: Migration = {
  version: '023',
  name: 'commission_policy',
  sql: `
    -- ---------------------------------------------------------------------
    -- The platform's own fee configuration. Exactly one row, no merchant id.
    -- ---------------------------------------------------------------------
    CREATE TABLE platform_fee_settings (
      id                       INTEGER PRIMARY KEY CHECK (id = 1),

      -- Telga's default provider commission rate, used where a provider has
      -- no configured rate of its own. Bounded 0-100%.
      default_commission_bps   INTEGER NOT NULL DEFAULT 300
                                 CHECK (default_commission_bps BETWEEN 0 AND 10000),

      -- The shop's share of whatever commission a provider pays. The founder's
      -- one global figure: every Telga shop earns this same share.
      shop_share_bps           INTEGER NOT NULL DEFAULT 7000
                                 CHECK (shop_share_bps BETWEEN 0 AND 10000),

      -- Card-payment cost, in basis points, applied where a sale was paid by
      -- card. Defaults to ZERO: no card fee has been agreed with anybody, and
      -- CLAUDE.md section 30 forbids inventing one. A non-zero value here is a
      -- founder decision that belongs in the Decision Log.
      card_fee_bps             INTEGER NOT NULL DEFAULT 0
                                 CHECK (card_fee_bps BETWEEN 0 AND 10000),

      -- Who last changed it. An admin id, not a merchant: a shop cannot reach
      -- this table, and the column says so.
      updated_by_admin_id      TEXT,
      updated_at               TEXT NOT NULL
    ) STRICT;

    -- ---------------------------------------------------------------------
    -- Per-provider, per-product commission. Starts empty, deliberately.
    -- ---------------------------------------------------------------------
    CREATE TABLE provider_commission_rates (
      id                  TEXT PRIMARY KEY,
      provider_id         TEXT NOT NULL,

      -- NULL means "every product from this provider". A product-specific row
      -- wins over it, so a provider can pay one rate on airtime and another on
      -- data without duplicating every other product.
      product_type        TEXT,

      commission_bps      INTEGER NOT NULL CHECK (commission_bps BETWEEN 0 AND 10000),

      -- What contract this rate came from. A rate with no source is a rate
      -- somebody invented, which is the thing section 30 forbids.
      source              TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'NOT_YET_CONFIRMED'
                            CHECK (status IN ('NOT_YET_CONFIRMED', 'CONFIRMED')),

      created_by_admin_id TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    ) STRICT;

    -- One rate per provider and product. The partial indexes are how "NULL
    -- means all products" stays unique: SQLite treats NULLs as distinct in a
    -- plain unique index, so a provider could otherwise collect several
    -- defaults and the one that won would depend on row order.
    CREATE UNIQUE INDEX idx_provider_rate_product
      ON provider_commission_rates(provider_id, product_type)
      WHERE product_type IS NOT NULL;
    CREATE UNIQUE INDEX idx_provider_rate_default
      ON provider_commission_rates(provider_id)
      WHERE product_type IS NULL;

    -- ---------------------------------------------------------------------
    -- The commission ledger. One row per sale that earned commission.
    -- ---------------------------------------------------------------------
    CREATE TABLE commission_entries (
      id                        TEXT PRIMARY KEY,

      -- One entry per transaction, enforced by the database rather than by a
      -- check before insert: a retry that reached here twice would otherwise
      -- pay a shop twice for one sale.
      transaction_id            TEXT NOT NULL UNIQUE REFERENCES transactions(id),
      merchant_id               TEXT NOT NULL REFERENCES merchants(id),
      provider_id               TEXT,
      product_type              TEXT NOT NULL,

      -- What the customer paid. Kept here so the entry explains itself without
      -- a join to a transaction whose row may have moved on.
      transaction_amount_minor  INTEGER NOT NULL CHECK (transaction_amount_minor > 0),

      -- The rates as they stood at the moment of the sale. An administrator
      -- can change both; a settled entry must still be explainable afterwards.
      provider_commission_bps   INTEGER NOT NULL CHECK (provider_commission_bps BETWEEN 0 AND 10000),
      shop_share_bps            INTEGER NOT NULL CHECK (shop_share_bps BETWEEN 0 AND 10000),

      -- The three money figures. Separate stored values, never derived on
      -- read: deriving them would recompute a past sale at today's rate.
      provider_commission_minor INTEGER NOT NULL CHECK (provider_commission_minor >= 0),
      shop_share_minor          INTEGER NOT NULL CHECK (shop_share_minor >= 0),
      telga_share_minor         INTEGER NOT NULL CHECK (telga_share_minor >= 0),

      -- Card cost on this sale, zero where the sale was not paid by card.
      card_fee_minor            INTEGER NOT NULL DEFAULT 0 CHECK (card_fee_minor >= 0),

      -- Has the provider actually paid it? A commission earned is not a
      -- commission received, and section 20 keeps provider settlement
      -- segregated from every other pot of money.
      settlement_status         TEXT NOT NULL DEFAULT 'UNSETTLED'
                                  CHECK (settlement_status IN ('UNSETTLED', 'SETTLED', 'DISPUTED')),
      settled_at                TEXT,
      settlement_reference      TEXT,

      -- Independent of settlement: a settled commission can still be reversed.
      reversal_status           TEXT NOT NULL DEFAULT 'NONE'
                                  CHECK (reversal_status IN ('NONE', 'REVERSED')),
      reversed_at               TEXT,
      reversal_transaction_id   TEXT,

      created_at                TEXT NOT NULL,

      -- The split must sum. Money created or destroyed at the point of sale is
      -- refused by the database, not merely by the function that wrote it.
      -- A table constraint, so it sits after every column it names — SQLite
      -- refuses one placed among the column definitions.
      CHECK (shop_share_minor + telga_share_minor = provider_commission_minor)
    ) STRICT;

    CREATE INDEX idx_commission_merchant ON commission_entries(merchant_id, created_at);
    CREATE INDEX idx_commission_settlement ON commission_entries(settlement_status, created_at);
    CREATE INDEX idx_commission_provider ON commission_entries(provider_id, settlement_status);

    -- ---------------------------------------------------------------------
    -- Append-only, on the same terms as the money ledger (section 13,
    -- invariant 1).
    --
    -- An entry's *figures* are history and never change. Its settlement and
    -- reversal columns are the only ones that may move, and only forwards:
    -- a settled entry cannot go back to unsettled, and a reversal cannot be
    -- un-recorded. Correcting one is a new adjustment entry (invariant 8),
    -- never an edit.
    -- ---------------------------------------------------------------------
    CREATE TRIGGER commission_entries_no_delete
    BEFORE DELETE ON commission_entries
    BEGIN
      SELECT RAISE(ABORT, 'commission_entries is append-only');
    END;

    CREATE TRIGGER commission_entries_no_figure_edit
    BEFORE UPDATE ON commission_entries
    WHEN OLD.transaction_id            IS NOT NEW.transaction_id
      OR OLD.merchant_id               IS NOT NEW.merchant_id
      OR OLD.transaction_amount_minor  IS NOT NEW.transaction_amount_minor
      OR OLD.provider_commission_bps   IS NOT NEW.provider_commission_bps
      OR OLD.shop_share_bps            IS NOT NEW.shop_share_bps
      OR OLD.provider_commission_minor IS NOT NEW.provider_commission_minor
      OR OLD.shop_share_minor          IS NOT NEW.shop_share_minor
      OR OLD.telga_share_minor         IS NOT NEW.telga_share_minor
      OR OLD.card_fee_minor            IS NOT NEW.card_fee_minor
      OR OLD.created_at                IS NOT NEW.created_at
    BEGIN
      SELECT RAISE(ABORT, 'commission figures are history and cannot be edited');
    END;

    CREATE TRIGGER commission_entries_settlement_forward_only
    BEFORE UPDATE OF settlement_status ON commission_entries
    WHEN OLD.settlement_status IN ('SETTLED', 'DISPUTED') AND NEW.settlement_status = 'UNSETTLED'
    BEGIN
      SELECT RAISE(ABORT, 'settlement cannot be undone; post an adjustment');
    END;

    CREATE TRIGGER commission_entries_reversal_forward_only
    BEFORE UPDATE OF reversal_status ON commission_entries
    WHEN OLD.reversal_status = 'REVERSED' AND NEW.reversal_status = 'NONE'
    BEGIN
      SELECT RAISE(ABORT, 'a reversal cannot be un-recorded');
    END;

    -- The single row. Defaults only: 3% is Telga's own starting figure and
    -- 70/30 is the founder's split. No provider rate is created, because none
    -- has been agreed.
    INSERT INTO platform_fee_settings (id, updated_at)
      VALUES (1, '1970-01-01T00:00:00.000Z');
  `,
};
