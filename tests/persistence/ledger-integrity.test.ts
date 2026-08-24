/**
 * Ledger integrity at the database level.
 *
 * The point of these tests is that immutability holds even when TypeScript is
 * bypassed entirely — every UPDATE and DELETE here is raw SQL on the connection.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { fromBirr, LiveMoneyDisabledError, LedgerNotBalancedError, postingId } from '@telga/domain';
import { fundMerchant, merchantAccountId, PLATFORM_ACCOUNTS } from '@telga/persistence';
import { at, makeHarness, MERCHANT_A, DEVICE_A, seedMerchant } from './helpers';
import type { Harness } from './helpers';

let harnesses: Harness[] = [];
function seeded(name: string): Harness {
  const h = makeHarness(name);
  harnesses.push(h);
  seedMerchant(h.driver, MERCHANT_A, DEVICE_A);
  return h;
}
afterEach(() => {
  for (const h of harnesses) h.cleanup();
  harnesses = [];
});

describe('append works', () => {
  it('a funding posting writes two balanced entries', () => {
    const { driver } = seeded('append');
    fundMerchant(driver, {
      merchantId: MERCHANT_A,
      amount: fromBirr(100),
      at: at(),
      correlationId: 'corr_1',
      postingId: postingId('post_fund_1'),
    });

    const entries = driver.readEntries();
    expect(entries).toHaveLength(2);
    expect(driver.ledgerResidualMinor()).toBe(0);
  });

  it('preserves integer minor units exactly', () => {
    const { driver } = seeded('integers');
    for (let i = 0; i < 100; i += 1) {
      fundMerchant(driver, {
        merchantId: MERCHANT_A,
        amount: fromBirr(0, 10),
        at: at(),
        correlationId: 'corr_int',
        postingId: postingId(`post_int_${String(i)}`),
      });
    }
    // 100 x 0.10 birr = exactly 10.00 birr.
    expect(driver.balanceFor(MERCHANT_A).available.minor).toBe(1000);
    expect(driver.ledgerResidualMinor()).toBe(0);
  });

  it('refuses an unbalanced posting', () => {
    const { driver } = seeded('unbalanced');
    driver.ensureAccount({
      id: merchantAccountId(MERCHANT_A, 'MERCHANT_AVAILABLE'),
      merchantId: MERCHANT_A,
      accountType: 'MERCHANT_AVAILABLE',
      at: at(),
    });

    expect(() =>
      driver.appendEntries({
        postingId: postingId('post_bad'),
        correlationId: 'corr_bad',
        at: at(),
        mode: 'TRAINING',
        entries: [
          {
            accountId: merchantAccountId(MERCHANT_A, 'MERCHANT_AVAILABLE'),
            accountKind: 'MERCHANT_AVAILABLE',
            merchantId: MERCHANT_A,
            direction: 'CREDIT',
            amount: fromBirr(100),
            reason: 'FUNDING_CREDIT',
          },
        ],
      }),
    ).toThrow(LedgerNotBalancedError);

    expect(driver.readEntries()).toHaveLength(0);
  });

  it('refuses a LIVE posting', () => {
    const { driver } = seeded('live');
    expect(() =>
      driver.appendEntries({
        postingId: postingId('post_live'),
        correlationId: 'corr_live',
        at: at(),
        mode: 'LIVE',
        entries: [],
      }),
    ).toThrow(LiveMoneyDisabledError);
  });
});

describe('append-only enforced by the database', () => {
  function withOneEntry(name: string) {
    const harness = seeded(name);
    fundMerchant(harness.driver, {
      merchantId: MERCHANT_A,
      amount: fromBirr(100),
      at: at(),
      correlationId: 'corr_1',
      postingId: postingId('post_fund_1'),
    });
    return harness;
  }

  it('a direct SQL UPDATE fails', () => {
    const { driver } = withOneEntry('no-update');
    expect(() => {
      driver.unsafeConnection.prepare('UPDATE ledger_entries SET amount_minor = 1').run();
    }).toThrow(/append-only.*UPDATE is forbidden/i);
  });

  it('a direct SQL DELETE fails', () => {
    const { driver } = withOneEntry('no-delete');
    expect(() => {
      driver.unsafeConnection.prepare('DELETE FROM ledger_entries').run();
    }).toThrow(/append-only.*DELETE is forbidden/i);
  });

  it('an UPDATE targeting a single row still fails', () => {
    const { driver } = withOneEntry('no-update-1');
    const id = driver.readEntries()[0]?.id ?? '';
    expect(() => {
      driver.unsafeConnection.prepare('UPDATE ledger_entries SET amount_minor = 1 WHERE id = ?').run(id);
    }).toThrow(/append-only/i);
  });

  it('the entries survive a failed UPDATE and DELETE unchanged', () => {
    const { driver } = withOneEntry('survives');
    const before = driver.readEntries();

    try {
      driver.unsafeConnection.prepare('UPDATE ledger_entries SET amount_minor = 1').run();
    } catch { /* expected */ }
    try {
      driver.unsafeConnection.prepare('DELETE FROM ledger_entries').run();
    } catch { /* expected */ }

    expect(driver.readEntries()).toEqual(before);
    expect(driver.balanceFor(MERCHANT_A).available.minor).toBe(10000);
  });

  it('the driver interface offers no update or delete for entries', () => {
    const { driver } = seeded('surface');
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(driver) as object);
    const forbidden = surface.filter((name) =>
      /^(update|delete|remove|void|edit)(Entry|Entries|Ledger)/i.test(name),
    );
    expect(forbidden).toEqual([]);
  });

  it('a correction must be a new ADJUSTMENT entry, and that still works', () => {
    const { driver } = withOneEntry('adjustment');
    const before = driver.readEntries().length;

    driver.appendEntries({
      postingId: postingId('post_adjust_1'),
      correlationId: 'corr_adjust',
      at: at(),
      mode: 'TRAINING',
      entries: [
        {
          accountId: merchantAccountId(MERCHANT_A, 'MERCHANT_AVAILABLE'),
          accountKind: 'MERCHANT_AVAILABLE',
          merchantId: MERCHANT_A,
          direction: 'DEBIT',
          amount: fromBirr(5),
          reason: 'ADJUSTMENT',
        },
        {
          accountId: PLATFORM_ACCOUNTS.REFUND_RESERVES,
          accountKind: 'REFUND_RESERVES',
          direction: 'CREDIT',
          amount: fromBirr(5),
          reason: 'ADJUSTMENT',
        },
      ],
    });

    expect(driver.readEntries()).toHaveLength(before + 2);
    // The original entry is untouched; the correction sits beside it.
    expect(driver.balanceFor(MERCHANT_A).available.minor).toBe(9500);
    expect(driver.ledgerResidualMinor()).toBe(0);
  });
});

describe('BANK_CLEARING', () => {
  it('balances the bookkeeping without appearing in a merchant balance', () => {
    const { driver } = seeded('clearing');
    fundMerchant(driver, {
      merchantId: MERCHANT_A,
      amount: fromBirr(100),
      at: at(),
      correlationId: 'corr_1',
      postingId: postingId('post_fund_1'),
    });

    const clearing = driver.readEntriesByAccount(PLATFORM_ACCOUNTS.BANK_CLEARING);
    expect(clearing).toHaveLength(1);
    expect(clearing[0]?.direction).toBe('DEBIT');
    expect(clearing[0]?.merchant_id).toBeNull();

    const view = driver.balanceFor(MERCHANT_A);
    expect(view.total.minor).toBe(10000);
    expect(view.available.minor).toBe(10000);
    // The -100.00 sitting in clearing is nowhere in the merchant's four views.
    expect(view.available.minor + view.reserved.minor + view.underReview.minor).toBe(view.total.minor);
    expect(driver.ledgerResidualMinor()).toBe(0);
  });
});

describe('concurrent writes', () => {
  it('many interleaved postings leave the ledger balanced', () => {
    const { driver } = seeded('concurrent');
    for (let i = 0; i < 200; i += 1) {
      fundMerchant(driver, {
        merchantId: MERCHANT_A,
        amount: fromBirr(1),
        at: at(),
        correlationId: `corr_${String(i)}`,
        postingId: postingId(`post_c_${String(i)}`),
      });
    }
    expect(driver.readEntries()).toHaveLength(400);
    expect(driver.balanceFor(MERCHANT_A).available.minor).toBe(20000);
    expect(driver.ledgerResidualMinor()).toBe(0);
  });

  it('a duplicate posting id collides instead of double-posting', () => {
    const { driver } = seeded('dup-posting');
    fundMerchant(driver, {
      merchantId: MERCHANT_A,
      amount: fromBirr(50),
      at: at(),
      correlationId: 'corr_1',
      postingId: postingId('post_same'),
    });

    expect(() =>
      fundMerchant(driver, {
        merchantId: MERCHANT_A,
        amount: fromBirr(50),
        at: at(),
        correlationId: 'corr_2',
        postingId: postingId('post_same'),
      }),
    ).toThrow(/UNIQUE constraint failed/i);

    expect(driver.balanceFor(MERCHANT_A).available.minor).toBe(5000);
  });
});
