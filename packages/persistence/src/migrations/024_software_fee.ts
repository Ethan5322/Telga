import type { Migration } from './index';

/**
 * The monthly software fee — founder instruction, 2026-09-14.
 *
 * > *"Add monthly fee for software update, 1250 fee must [be charged] every
 * > month end regardless of whether Telga [hardware] was bought by the shop
 * > owner or Telga provided. Must be minused from existing shop balance
 * > without any notice, but it must show [on the] transaction statement of
 * > Telga Vending."*
 *
 * ## One charge per shop per month, enforced by the database
 *
 * The danger with a scheduled charge is not that it fails — a failure is
 * visible and can be re-run. It is that it succeeds **twice**: a worker
 * restarted mid-run, a month-end job triggered by two instances, an operator
 * running it by hand after it already ran. Each of those takes 1,250 birr from
 * a shop that owes 1,250 birr.
 *
 * So the period is part of the primary key. A second attempt at the same
 * month is refused by the database, not by a check the caller has to remember
 * to perform.
 *
 * ## Why an unpaid charge is a row and not a missing row
 *
 * A shop whose balance is below the fee cannot be debited: section 20 says
 * **"No overdraft"**, and a negative selling balance is Telga extending credit,
 * which section 2 lists among the regulated activities that stay switched off.
 *
 * Skipping the charge silently would mean the fee is simply not collected that
 * month and nothing anywhere records that it was due. So the charge is always
 * written; `status` says whether it was taken. `ARREARS` is a debt Telga can
 * see, report on, and collect when the shop next has balance — which is what
 * the founder's "must be minused from existing shop balance" needs in the case
 * where there is not enough of it.
 *
 * ## What "without any notice" means here, and what it cannot mean
 *
 * No confirmation, no approval, no prompt: the charge happens on its own. It
 * is still **recorded** — a `FEE_DEBIT` ledger entry and a statement line —
 * because the founder asked for exactly that in the same sentence, and because
 * a debit with no record is unreconcilable by anybody, Telga included.
 */
export const m024SoftwareFee: Migration = {
  version: '024',
  name: 'software_fee',
  sql: `
    -- The amount, alongside the other platform-level fee configuration. It is
    -- an administrator's figure, not a shop's: no shop negotiates it, and
    -- nothing here is keyed by merchant.
    --
    -- 125000 santim = ETB 1,250, the founder's figure.
    ALTER TABLE platform_fee_settings
      ADD COLUMN software_fee_minor INTEGER NOT NULL DEFAULT 125000
        CHECK (software_fee_minor >= 0);

    -- Whether the month-end charge runs at all. On by default, because the
    -- founder asked for the fee; the switch exists so it can be stopped
    -- without a deployment if it is ever charging wrongly.
    ALTER TABLE platform_fee_settings
      ADD COLUMN software_fee_enabled INTEGER NOT NULL DEFAULT 1
        CHECK (software_fee_enabled IN (0, 1));

    -- The first month this fee may be charged for, as 'YYYY-MM'.
    --
    -- NULL means it has never run here. The first sweep writes the month it
    -- runs in and charges nothing, so the fee begins with the month it was
    -- switched on and never reaches back past it.
    --
    -- Without this, deploying on 2026-09-15 would have billed every active
    -- shop for AUGUST on the first sweep — a month in which nobody had been
    -- told of a fee and the code implementing it did not exist. A shop's float
    -- would simply have dropped by 1,250 birr with nothing able to explain it.
    --
    -- Not a constant, because a constant is wrong the moment this ships late,
    -- is restored from a backup, or is switched off and on again.
    ALTER TABLE platform_fee_settings ADD COLUMN software_fee_first_period TEXT;

    CREATE TABLE software_fee_charges (
      id                  TEXT PRIMARY KEY,
      merchant_id         TEXT NOT NULL REFERENCES merchants(id),

      -- The month charged, as 'YYYY-MM'. A period, not a timestamp: the charge
      -- is for January, whenever it was actually taken.
      period              TEXT NOT NULL CHECK (length(period) = 7),

      amount_minor        INTEGER NOT NULL CHECK (amount_minor > 0),

      -- PAID: the balance covered it and a ledger entry exists.
      -- ARREARS: it was due and could not be taken. A debt, not a skip.
      -- WAIVED: an administrator cancelled it, with a reason.
      status              TEXT NOT NULL DEFAULT 'ARREARS'
                            CHECK (status IN ('PAID', 'ARREARS', 'WAIVED')),

      -- The ledger posting that took the money. NULL while unpaid — which is
      -- also the check that an ARREARS row moved no money.
      posting_id          TEXT,
      charged_at          TEXT,

      -- Why it was waived. Required by the application, not by SQL, because a
      -- CHECK here would refuse the ordinary NULL on every unwaived row.
      waived_reason       TEXT,
      waived_by_admin_id  TEXT,

      created_at          TEXT NOT NULL
    ) STRICT;

    -- One charge per shop per month. The whole protection against charging
    -- twice: a re-run inserts nothing rather than taking the fee again.
    CREATE UNIQUE INDEX idx_software_fee_period
      ON software_fee_charges(merchant_id, period);

    -- "What is owed" — the collection query, and the one an operations desk
    -- runs to see which shops are behind.
    CREATE INDEX idx_software_fee_status ON software_fee_charges(status, period);

    -- Append-only in the same sense as the commission ledger: a charge that
    -- happened is history. Status may move forward (ARREARS to PAID when the
    -- shop has balance, or to WAIVED when an administrator cancels it), but
    -- the period, the amount and the shop never change, and a PAID charge
    -- cannot quietly become unpaid.
    CREATE TRIGGER software_fee_no_delete
    BEFORE DELETE ON software_fee_charges
    BEGIN
      SELECT RAISE(ABORT, 'software_fee_charges is append-only');
    END;

    CREATE TRIGGER software_fee_no_rewrite
    BEFORE UPDATE ON software_fee_charges
    WHEN OLD.merchant_id  IS NOT NEW.merchant_id
      OR OLD.period       IS NOT NEW.period
      OR OLD.amount_minor IS NOT NEW.amount_minor
      OR OLD.created_at   IS NOT NEW.created_at
    BEGIN
      SELECT RAISE(ABORT, 'a software fee charge is history and cannot be rewritten');
    END;

    CREATE TRIGGER software_fee_paid_is_final
    BEFORE UPDATE OF status ON software_fee_charges
    WHEN OLD.status = 'PAID' AND NEW.status <> 'PAID'
    BEGIN
      SELECT RAISE(ABORT, 'a paid fee cannot be un-paid; post an adjustment');
    END;
  `,
};
