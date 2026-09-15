/**
 * The monthly software fee.
 *
 * Founder instruction, 2026-09-14: *"Add monthly fee for software update, 1250
 * fee must [be charged] every month end regardless of whether Telga [hardware]
 * was bought by the shop owner or Telga provided. Must be minused from existing
 * shop balance without any notice, but it must show [on the] transaction
 * statement of Telga Vending."*
 *
 * Four things must hold, and all four are ways money goes wrong rather than
 * ways a feature looks wrong:
 *
 *   1. The fee is taken. 1,250 birr, from the selling balance, with no prompt.
 *   2. It is taken **once** a month, whatever happens to the runner.
 *   3. It never overdraws a shop — section 20, *"No overdraft"*.
 *   4. What was taken is visible afterwards.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MIGRATIONS,
  SqliteLedgerDriver,
  chargeSoftwareFee,
  periodEnd,
  periodOf,
} from '@telga/persistence';
import { previousPeriod, runDueSoftwareFees, runSoftwareFeeCharges } from '@telga/worker';

const FEE = 125_000; // ETB 1,250 in santim
const AT = '2026-09-30T23:59:00.000Z';

let dir: string;
let db: Database.Database;
let driver: SqliteLedgerDriver;
let ids = 0;
const newId = (p: string) => `${p}_${String(++ids)}`;

/** Put money in a shop's available balance the way a verified deposit would. */
function fund(merchantId: string, minor: number): void {
  driver.ensureAccount({
    id: `acct_${merchantId}_merchant_available` as never,
    merchantId: merchantId as never,
    accountType: 'MERCHANT_AVAILABLE',
    at: AT as never,
  });
  driver.ensureAccount({
    id: 'acct_platform_bank_clearing' as never,
    accountType: 'BANK_CLEARING',
    at: AT as never,
  });
  driver.appendEntries({
    postingId: newId('post') as never,
    correlationId: 'test-funding',
    at: AT as never,
    mode: 'TRAINING',
    entries: [
      {
        accountId: `acct_${merchantId}_merchant_available` as never,
        accountKind: 'MERCHANT_AVAILABLE',
        merchantId: merchantId as never,
        direction: 'CREDIT',
        amount: { minor, currency: 'ETB' },
        reason: 'FUNDING_CREDIT',
      },
      {
        accountId: 'acct_platform_bank_clearing' as never,
        accountKind: 'BANK_CLEARING',
        direction: 'DEBIT',
        amount: { minor, currency: 'ETB' },
        reason: 'FUNDING_CREDIT',
      },
    ],
  });
}

const addShop = (id: string, status = 'ACTIVE'): void => {
  db
    .prepare(
      `INSERT INTO merchants (id, status, mode, created_at, updated_at)
       VALUES (?, ?, 'TRAINING', ?, ?)`,
    )
    .run(id, status, AT, AT);
};

const available = (merchantId: string): number =>
  driver.balanceFor(merchantId as never).available.minor;

const charge = (merchantId: string, period = '2026-09') =>
  chargeSoftwareFee(driver, {
    id: newId('sfee'),
    merchantId: merchantId as never,
    period,
    amountMinor: FEE,
    postingId: newId('post') as never,
    at: AT as never,
  });

beforeEach(() => {
  ids = 0;
  dir = mkdtempSync(join(tmpdir(), 'telga-sfee-'));
  db = new Database(join(dir, 'telga.sqlite'));
  db.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS) db.exec(`BEGIN; ${migration.sql} COMMIT;`);
  driver = new SqliteLedgerDriver({ connection: db as never } as never);
  addShop('shop_a');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the period', () => {
  it('is the month a timestamp falls in', () => {
    expect(periodOf('2026-09-30T23:59:00.000Z')).toBe('2026-09');
    expect(periodOf('2026-01-01T00:00:00.000Z')).toBe('2026-01');
  });

  it('ends on the real last day, February and leap years included', () => {
    expect(periodEnd('2026-09')).toBe('2026-09-30');
    expect(periodEnd('2026-01')).toBe('2026-01-31');
    expect(periodEnd('2026-02')).toBe('2026-02-28');
    expect(periodEnd('2028-02')).toBe('2028-02-29');
    expect(periodEnd('2026-12')).toBe('2026-12-31');
  });
});

describe('which month is charged', () => {
  it('bills the month that has finished, not the one still running', () => {
    // A shop is charged for software it has already had. It also settles what
    // "month end" means on a UTC server serving shops in Addis Ababa: September
    // is charged once September is unambiguously over, everywhere.
    expect(previousPeriod('2026-10-01T00:05:00.000Z')).toBe('2026-09');
    expect(previousPeriod('2026-09-30T23:59:00.000Z')).toBe('2026-08');
  });

  it('crosses a year boundary', () => {
    expect(previousPeriod('2027-01-01T00:00:00.000Z')).toBe('2026-12');
  });

  it('pads a single-digit month, so the period sorts and matches', () => {
    // '2026-9' would never equal '2026-09' in the unique index, and a shop
    // would be charged twice for September.
    expect(previousPeriod('2026-10-15T00:00:00.000Z')).toBe('2026-09');
    expect(previousPeriod('2026-03-15T00:00:00.000Z')).toBe('2026-02');
  });
});

describe('it never bills a month that ended before it existed', () => {
  /**
   * Found by testing the upgrade path against a realistic live database.
   *
   * Deployed on 2026-09-15, the first sweep would have charged every active
   * shop 1,250 birr for AUGUST — a month in which nobody had been told of a
   * fee, nothing announced one, and the code implementing it did not exist.
   * A shop's float would have dropped with nothing able to explain it.
   */
  const deps = (now: string) => ({ driver, now: () => now as never, newId });

  it('charges nothing on its very first run, and records where it starts', () => {
    fund('shop_a', 500_000);

    const first = runDueSoftwareFees(deps('2026-09-15T03:00:00.000Z'));
    expect(first.charged).toBe(0);
    expect(first.arrears, 'and nothing is recorded as owed either').toBe(0);
    expect(available('shop_a')).toBe(500_000);

    // It remembers the month it started in, so a restart does not reset it.
    expect(driver.readPlatformFeeSettings().softwareFeeFirstPeriod).toBe('2026-09');
  });

  it('still charges nothing on a later sweep in the same month', () => {
    fund('shop_a', 500_000);
    runDueSoftwareFees(deps('2026-09-15T03:00:00.000Z'));
    runDueSoftwareFees(deps('2026-09-28T03:00:00.000Z'));
    expect(available('shop_a')).toBe(500_000);
  });

  it('charges the first full month once it has ended', () => {
    // September is the month it started in. October's first sweep bills for
    // September — the first month a shop can honestly be said to have had the
    // software under this policy.
    fund('shop_a', 500_000);
    runDueSoftwareFees(deps('2026-09-15T03:00:00.000Z'));

    const october = runDueSoftwareFees(deps('2026-10-01T03:00:00.000Z'));
    expect(october.period).toBe('2026-09');
    expect(october.charged).toBe(1);
    expect(available('shop_a')).toBe(500_000 - FEE);
  });

  it('does not reach back to August even months later', () => {
    fund('shop_a', 5_000_000);
    runDueSoftwareFees(deps('2026-09-15T03:00:00.000Z'));
    runDueSoftwareFees(deps('2026-10-01T03:00:00.000Z'));
    runDueSoftwareFees(deps('2026-11-01T03:00:00.000Z'));

    const periods = driver.softwareFeeChargesFor('shop_a' as never).map((c) => c.period);
    expect(periods.sort()).toEqual(['2026-09', '2026-10']);
    expect(periods, 'August ended before the fee existed').not.toContain('2026-08');
  });
});

describe('running on every sweep', () => {
  it('charges the finished month once, however many times it is called', () => {
    // This is how it is wired: called on every worker sweep rather than by a
    // cron. A cron that does not fire is a month nobody is charged for and
    // nothing that notices.
    fund('shop_a', 500_000);

    // A sweep inside September establishes where the fee starts and charges
    // nothing — see "it never bills a month that ended before it existed".
    runDueSoftwareFees({ driver, now: () => '2026-09-20T02:00:00.000Z' as never, newId });

    const deps = { driver, now: () => '2026-10-01T02:00:00.000Z' as never, newId };
    const first = runDueSoftwareFees(deps);
    expect(first.period).toBe('2026-09');
    expect(first.charged).toBe(1);

    for (let i = 0; i < 4; i += 1) runDueSoftwareFees(deps);
    expect(available('shop_a')).toBe(500_000 - FEE);
  });
});

describe('charging a shop', () => {
  it('takes 1,250 birr from the selling balance', () => {
    fund('shop_a', 500_000);
    const outcome = charge('shop_a');

    expect(outcome.kind).toBe('CHARGED');
    expect(available('shop_a')).toBe(500_000 - FEE);
  });

  it('asks nobody — no approval, no pending state', () => {
    // "Without any notice" means the charge completes on its own. It is a
    // single call that returns CHARGED; there is no queue it waits in.
    fund('shop_a', 500_000);
    expect(charge('shop_a').kind).toBe('CHARGED');
  });

  it('posts a balanced FEE_DEBIT pair', () => {
    fund('shop_a', 500_000);
    charge('shop_a');

    const entries = db
      .prepare(`SELECT * FROM ledger_entries WHERE entry_type = 'FEE_DEBIT' ORDER BY direction`)
      .all() as {
      direction: string;
      amount_minor: number;
      account_type: string;
      merchant_id: string | null;
    }[];

    expect(entries).toHaveLength(2);
    // A posting that does not sum to zero is money created or destroyed.
    const signed = entries.reduce(
      (acc, e) => acc + (e.direction === 'CREDIT' ? e.amount_minor : -e.amount_minor),
      0,
    );
    expect(signed).toBe(0);
    expect(entries.map((e) => e.account_type).sort()).toEqual([
      'MERCHANT_AVAILABLE',
      'TELGA_REVENUE',
    ]);

    // The revenue leg names no merchant. This is the single line that keeps a
    // platform fee out of the two queries a shop's earnings are read from.
    const revenue = entries.find((e) => e.account_type === 'TELGA_REVENUE');
    expect(revenue?.merchant_id, 'the revenue leg must not be attributed').toBeNull();
    // The debit is attributed, because it really is this shop's money leaving.
    const debit = entries.find((e) => e.account_type === 'MERCHANT_AVAILABLE');
    expect(debit?.merchant_id).toBe('shop_a');
  });
});

describe('it is charged once a month, whatever happens to the runner', () => {
  it('refuses a second charge for the same month', () => {
    fund('shop_a', 500_000);
    expect(charge('shop_a').kind).toBe('CHARGED');

    const second = charge('shop_a');
    expect(second.kind).toBe('ALREADY_CHARGED');
    // The balance is the proof. A second CHARGED would be 1,250 birr gone.
    expect(available('shop_a')).toBe(500_000 - FEE);
  });

  it('survives being run five times', () => {
    fund('shop_a', 500_000);
    for (let i = 0; i < 5; i += 1) charge('shop_a');
    expect(available('shop_a')).toBe(500_000 - FEE);
  });

  it('charges the next month as a separate fee', () => {
    fund('shop_a', 500_000);
    charge('shop_a', '2026-09');
    charge('shop_a', '2026-10');
    expect(available('shop_a')).toBe(500_000 - FEE * 2);
  });
});

describe('it never overdraws a shop', () => {
  it('takes nothing when the balance is short', () => {
    fund('shop_a', 40_000); // 400 birr against a 1,250 birr fee
    const outcome = charge('shop_a');

    expect(outcome.kind).toBe('ARREARS');
    // Section 20: "No overdraft." Not 1,250 taken, and not 400 either —
    // partial collection would leave a shop unable to trade and still in debt.
    expect(available('shop_a')).toBe(40_000);
  });

  it('records the debt rather than skipping the month', () => {
    fund('shop_a', 40_000);
    charge('shop_a');

    const owed = driver.outstandingSoftwareFees();
    expect(owed).toHaveLength(1);
    expect(owed[0].period).toBe('2026-09');
    expect(owed[0].amountMinor).toBe(FEE);
    expect(owed[0].postingId, 'an unpaid charge moved no money').toBeNull();
  });

  it('collects the debt once the shop has balance', () => {
    fund('shop_a', 40_000);
    charge('shop_a');
    fund('shop_a', 500_000);

    expect(charge('shop_a').kind).toBe('CHARGED');
    expect(available('shop_a')).toBe(540_000 - FEE);
    expect(driver.outstandingSoftwareFees()).toHaveLength(0);
  });

  it('takes a shop with exactly the fee to zero and no further', () => {
    fund('shop_a', FEE);
    expect(charge('shop_a').kind).toBe('CHARGED');
    expect(available('shop_a')).toBe(0);
  });

  it('charges a shop with nothing at all no money', () => {
    expect(charge('shop_a').kind).toBe('ARREARS');
    expect(available('shop_a')).toBe(0);
  });
});

describe('the month-end run', () => {
  const run = (period?: string) =>
    runSoftwareFeeCharges(
      { driver, now: () => AT as never, newId },
      period,
    );

  it('charges every active shop, whoever owns the hardware', () => {
    // "Regardless" is the rule: no exemption for a shop that bought its own
    // terminal, so there is no hardware condition anywhere in the run.
    addShop('shop_b');
    addShop('shop_c');
    fund('shop_a', 500_000);
    fund('shop_b', 500_000);
    fund('shop_c', 500_000);

    const result = run();
    expect(result.charged).toBe(3);
    expect(result.chargedMinor).toBe(FEE * 3);
    for (const shop of ['shop_a', 'shop_b', 'shop_c']) {
      expect(available(shop)).toBe(500_000 - FEE);
    }
  });

  it('does not charge a suspended shop', () => {
    // Not an exemption: a suspended shop cannot trade, so charging it drains a
    // balance it can neither spend nor replenish.
    addShop('shop_susp', 'SUSPENDED');
    fund('shop_a', 500_000);
    fund('shop_susp', 500_000);

    run();
    expect(available('shop_susp')).toBe(500_000);
  });

  it('is safe to run twice', () => {
    fund('shop_a', 500_000);
    run();
    const second = run();

    expect(second.charged).toBe(0);
    expect(second.alreadyCharged).toBe(1);
    expect(available('shop_a')).toBe(500_000 - FEE);
  });

  it('separates what it charged from what it could not', () => {
    addShop('shop_poor');
    fund('shop_a', 500_000);
    fund('shop_poor', 10_000);

    const result = run();
    expect(result.charged).toBe(1);
    expect(result.arrears).toBe(1);
    expect(result.arrearsMinor).toBe(FEE);
  });

  it('recovers an older month once the shop can pay', () => {
    fund('shop_a', 10_000);
    run('2026-08'); // falls into arrears
    fund('shop_a', 500_000);

    const result = run('2026-09');
    expect(result.charged, 'September itself').toBe(1);
    expect(result.recovered, 'August, recovered').toBe(1);
    expect(available('shop_a')).toBe(510_000 - FEE * 2);
  });

  it('charges nothing while the fee is switched off', () => {
    fund('shop_a', 500_000);
    driver.writePlatformFeeSettings({
      softwareFeeEnabled: false,
      adminId: 'adm_1',
      at: AT as never,
    });

    const result = run();
    expect(result.charged).toBe(0);
    // And nothing is recorded as owed: a month the fee was off is a month it
    // was not due, not a debt that accrues quietly.
    expect(driver.outstandingSoftwareFees()).toHaveLength(0);
    expect(available('shop_a')).toBe(500_000);
  });

  it('charges the amount an administrator configured', () => {
    fund('shop_a', 500_000);
    driver.writePlatformFeeSettings({
      softwareFeeMinor: 90_000,
      adminId: 'adm_1',
      at: AT as never,
    });

    run();
    expect(available('shop_a')).toBe(500_000 - 90_000);
  });
});

describe('a fee is not earnings', () => {
  it('does not raise the profit the shop is shown', () => {
    // `profitForDay` sums TELGA_REVENUE *for this merchant*. The fee's revenue
    // leg deliberately names no merchant, so it cannot land in this figure —
    // if it did, taking 1,250 birr would make the dashboard show 1,250 birr
    // *earned* on the day it was taken.
    fund('shop_a', 500_000);
    const before = driver.profitForDay('shop_a' as never, AT.slice(0, 10));
    charge('shop_a');
    expect(driver.profitForDay('shop_a' as never, AT.slice(0, 10))).toBe(before);
  });

  it('does not become profit the owner can transfer to their balance', () => {
    // The worse half of the same defect: `profitAvailableMinor` is what a
    // profit transfer draws on, so a counted fee would be money invented.
    fund('shop_a', 500_000);
    const before = driver.profitAvailableMinor('shop_a' as never);
    charge('shop_a');
    expect(driver.profitAvailableMinor('shop_a' as never)).toBe(before);
  });
});

describe('what the shop can see afterwards', () => {
  it('lists the charge against its month', () => {
    fund('shop_a', 500_000);
    charge('shop_a');

    const charges = driver.softwareFeeChargesFor('shop_a' as never);
    expect(charges).toHaveLength(1);
    expect(charges[0].status).toBe('PAID');
    expect(charges[0].amountMinor).toBe(FEE);
    expect(charges[0].chargedAt).toBe(AT);
  });

  it('shows an unpaid month as owed rather than hiding it', () => {
    charge('shop_a');
    const charges = driver.softwareFeeChargesFor('shop_a' as never);
    expect(charges).toHaveLength(1);
    expect(charges[0].status).toBe('ARREARS');
  });
});

describe('waiving a charge', () => {
  it('cancels an unpaid fee with a reason', () => {
    charge('shop_a');
    const waived = driver.waiveSoftwareFee({
      merchantId: 'shop_a' as never,
      period: '2026-09',
      reason: 'Device was with Telga for repair all month',
      adminId: 'adm_1',
    });
    expect(waived).toBe(true);
    expect(driver.outstandingSoftwareFees()).toHaveLength(0);
  });

  it('refuses a waiver with no reason', () => {
    // A fee that vanished with no reason is indistinguishable from a bug.
    charge('shop_a');
    expect(
      driver.waiveSoftwareFee({
        merchantId: 'shop_a' as never,
        period: '2026-09',
        reason: '   ',
        adminId: 'adm_1',
      }),
    ).toBe(false);
    expect(driver.outstandingSoftwareFees()).toHaveLength(1);
  });

  it('will not waive a fee that was already paid', () => {
    // Money that moved is corrected by an adjustment entry, never by editing
    // the record of it — section 13, invariant 8.
    fund('shop_a', 500_000);
    charge('shop_a');
    expect(
      driver.waiveSoftwareFee({
        merchantId: 'shop_a' as never,
        period: '2026-09',
        reason: 'changed my mind',
        adminId: 'adm_1',
      }),
    ).toBe(false);
    expect(available('shop_a')).toBe(500_000 - FEE);
  });
});
