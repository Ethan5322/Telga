/**
 * Reservation, release, finalization, under review — and the rollback that
 * makes a failed operation leave nothing behind.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  auditEventId,
  fromBirr,
  InsufficientAvailableBalanceError,
  postingId,
  transactionId,
} from '@telga/domain';
import {
  finalizeSuccess,
  fundMerchant,
  merchantAccountId,
  moveToUnderReview,
  release,
  releaseFromUnderReview,
  reserve,
} from '@telga/persistence';
import type { SqliteLedgerDriver } from '@telga/persistence';
import {
  actor,
  at,
  DEVICE_A,
  makeHarness,
  makeTransaction,
  MERCHANT_A,
  seedMerchant,
  transactionInput,
} from './helpers';
import type { Harness } from './helpers';

const TX = transactionId('txn_res_1');

let harnesses: Harness[] = [];

function funded(name: string, birr = 100): SqliteLedgerDriver {
  const h = makeHarness(name);
  harnesses.push(h);
  seedMerchant(h.driver, MERCHANT_A, DEVICE_A);
  fundMerchant(h.driver, {
    merchantId: MERCHANT_A,
    amount: fromBirr(birr),
    at: at(),
    correlationId: 'corr_fund',
    postingId: postingId('post_fund'),
  });
  h.driver.saveTransaction(transactionInput(makeTransaction({ id: TX })));
  return h.driver;
}

const ctx = (postId: string, auditNo: string, amount = fromBirr(25)) => ({
  merchantId: MERCHANT_A,
  transactionId: TX,
  amount,
  at: at(),
  correlationId: 'corr_sale',
  actor,
  postingId: postingId(postId),
  auditId: auditNo,
});

afterEach(() => {
  for (const h of harnesses) h.cleanup();
  harnesses = [];
});

describe('reservation', () => {
  it('moves value from available to reserved', () => {
    const driver = funded('reserve');
    reserve(driver, ctx('post_res', 'audit_res'));

    const view = driver.balanceFor(MERCHANT_A);
    expect(view.available.minor).toBe(7500);
    expect(view.reserved.minor).toBe(2500);
    expect(view.underReview.minor).toBe(0);
    expect(view.total.minor).toBe(10000);
    expect(driver.ledgerResidualMinor()).toBe(0);
  });

  it('creates the reservation row', () => {
    const driver = funded('reserve-row');
    reserve(driver, ctx('post_res', 'audit_res'));

    const row = driver.findReservation(TX, MERCHANT_A);
    expect(row?.status).toBe('HELD');
    expect(row?.amount_minor).toBe(2500);
  });

  it('rejects an amount above available balance', () => {
    const driver = funded('reserve-insufficient', 10);
    expect(() => {
      reserve(driver, ctx('post_res', 'audit_res', fromBirr(500)));
    }).toThrow(InsufficientAvailableBalanceError);
  });

  it('a rejected reservation leaves no partial state', () => {
    const driver = funded('reserve-atomic', 10);
    try {
      reserve(driver, ctx('post_res', 'audit_res', fromBirr(500)));
    } catch { /* expected */ }

    expect(driver.findReservation(TX, MERCHANT_A)).toBeUndefined();
    expect(driver.readEntriesByTransaction(TX)).toHaveLength(0);
    expect(driver.balanceFor(MERCHANT_A).available.minor).toBe(1000);
  });

  it('a throw inside a unit of work rolls back every write in it', () => {
    const driver = funded('rollback');
    const before = driver.readEntries().length;

    expect(() =>
      driver.transaction(() => {
        reserve(driver, ctx('post_res', 'audit_res'));
        throw new Error('simulated failure after reserving');
      }),
    ).toThrow(/simulated failure/);

    expect(driver.findReservation(TX, MERCHANT_A)).toBeUndefined();
    expect(driver.readEntries()).toHaveLength(before);
    expect(driver.balanceFor(MERCHANT_A).available.minor).toBe(10000);
  });
});

describe('release', () => {
  it('restores available value exactly', () => {
    const driver = funded('release');
    reserve(driver, ctx('post_res', 'audit_res'));
    release(driver, ctx('post_rel', 'audit_rel'));

    const view = driver.balanceFor(MERCHANT_A);
    expect(view.available.minor).toBe(10000);
    expect(view.reserved.minor).toBe(0);
    expect(driver.ledgerResidualMinor()).toBe(0);
  });

  it('never edits the original entries — it posts new balancing ones', () => {
    const driver = funded('release-append');
    reserve(driver, ctx('post_res', 'audit_res'));
    const afterReserve = driver.readEntriesByTransaction(TX);
    release(driver, ctx('post_rel', 'audit_rel'));
    const afterRelease = driver.readEntriesByTransaction(TX);

    expect(afterRelease).toHaveLength(afterReserve.length + 2);
    // Every original entry is still present, byte for byte.
    for (const original of afterReserve) {
      expect(afterRelease).toContainEqual(original);
    }
  });

  it('a repeated release cannot double-credit', () => {
    const driver = funded('release-twice');
    reserve(driver, ctx('post_res', 'audit_res'));
    release(driver, ctx('post_rel', 'audit_rel'));

    expect(() => {
      release(driver, ctx('post_rel_2', 'audit_rel_2'));
    }).toThrow(/already been resolved/i);

    expect(driver.balanceFor(MERCHANT_A).available.minor).toBe(10000);
  });
});

describe('final success', () => {
  it('debits the merchant and credits provider settlement', () => {
    const driver = funded('finalize');
    reserve(driver, ctx('post_res', 'audit_res'));
    finalizeSuccess(driver, ctx('post_fin', 'audit_fin'));

    const view = driver.balanceFor(MERCHANT_A);
    expect(view.available.minor).toBe(7500);
    expect(view.reserved.minor).toBe(0);
    expect(view.total.minor).toBe(7500);
    expect(driver.ledgerResidualMinor()).toBe(0);
  });

  it('closes the reservation', () => {
    const driver = funded('finalize-res');
    reserve(driver, ctx('post_res', 'audit_res'));
    finalizeSuccess(driver, ctx('post_fin', 'audit_fin'));
    expect(driver.findReservation(TX, MERCHANT_A)?.status).toBe('SETTLED');
  });

  it('a repeated finalization cannot double-debit', () => {
    const driver = funded('finalize-twice');
    reserve(driver, ctx('post_res', 'audit_res'));
    finalizeSuccess(driver, ctx('post_fin', 'audit_fin'));

    expect(() => {
      finalizeSuccess(driver, ctx('post_fin_2', 'audit_fin_2'));
    }).toThrow(/already been resolved/i);

    expect(driver.balanceFor(MERCHANT_A).available.minor).toBe(7500);
  });

  it('writes no commission entry, because no commission rate is confirmed', () => {
    const driver = funded('finalize-commission');
    reserve(driver, ctx('post_res', 'audit_res'));
    finalizeSuccess(driver, ctx('post_fin', 'audit_fin'));

    const entries = driver.readEntries();
    expect(entries.some((e) => e.entry_type === 'COMMISSION_CREDIT')).toBe(false);
    expect(entries.some((e) => e.entry_type === 'FEE_DEBIT')).toBe(false);
    expect(driver.readEntriesByAccount('acct_platform_telga_revenue')).toHaveLength(0);
  });
});

describe('under review', () => {
  it('moves value out of reserved and keeps it out of available', () => {
    const driver = funded('under-review');
    reserve(driver, ctx('post_res', 'audit_res'));
    moveToUnderReview(driver, ctx('post_ur', 'audit_ur'));

    const view = driver.balanceFor(MERCHANT_A);
    expect(view.underReview.minor).toBe(2500);
    expect(view.reserved.minor).toBe(0);
    expect(view.available.minor).toBe(7500);
    expect(view.total.minor).toBe(10000);
  });

  it('preserves the transaction reference on every posting', () => {
    const driver = funded('under-review-ref');
    reserve(driver, ctx('post_res', 'audit_res'));
    moveToUnderReview(driver, ctx('post_ur', 'audit_ur'));

    const entries = driver.readEntriesByTransaction(TX);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.transaction_id === TX)).toBe(true);
    expect(entries.every((e) => e.correlation_id === 'corr_sale')).toBe(true);
  });

  it('resolves back to available when operations clears it', () => {
    const driver = funded('under-review-release');
    reserve(driver, ctx('post_res', 'audit_res'));
    moveToUnderReview(driver, ctx('post_ur', 'audit_ur'));
    releaseFromUnderReview(driver, ctx('post_ur_rel', 'audit_ur_rel'));

    const view = driver.balanceFor(MERCHANT_A);
    expect(view.available.minor).toBe(10000);
    expect(view.underReview.minor).toBe(0);
    expect(driver.ledgerResidualMinor()).toBe(0);
  });

  it('cannot be released twice', () => {
    const driver = funded('under-review-twice');
    reserve(driver, ctx('post_res', 'audit_res'));
    moveToUnderReview(driver, ctx('post_ur', 'audit_ur'));
    releaseFromUnderReview(driver, ctx('post_ur_rel', 'audit_ur_rel'));

    expect(() => {
      releaseFromUnderReview(driver, ctx('post_ur_rel2', 'audit_ur_rel2'));
    }).toThrow(/already been resolved/i);
    expect(driver.balanceFor(MERCHANT_A).available.minor).toBe(10000);
  });

  it('the four views always reconcile through the whole lifecycle', () => {
    const driver = funded('reconcile');
    const check = () => {
      const v = driver.balanceFor(MERCHANT_A);
      expect(v.available.minor + v.reserved.minor + v.underReview.minor).toBe(v.total.minor);
      expect(driver.ledgerResidualMinor()).toBe(0);
    };

    check();
    reserve(driver, ctx('post_res', 'audit_res'));
    check();
    moveToUnderReview(driver, ctx('post_ur', 'audit_ur'));
    check();
    releaseFromUnderReview(driver, ctx('post_rel', 'audit_rel'));
    check();
  });
});

describe('accounts', () => {
  it('creates the three merchant buckets', () => {
    const driver = funded('buckets');
    for (const type of ['MERCHANT_AVAILABLE', 'MERCHANT_RESERVED', 'MERCHANT_UNDER_REVIEW'] as const) {
      expect(driver.findAccount(MERCHANT_A, type)?.id).toBe(merchantAccountId(MERCHANT_A, type));
    }
  });

  it('an audit event exists for the reservation', () => {
    const driver = funded('audit-res');
    reserve(driver, ctx('post_res', 'audit_res'));
    const events = driver.readAuditEvents(MERCHANT_A);
    expect(events.some((e) => e.event_type === 'BALANCE_RESERVED')).toBe(true);
    expect(auditEventId('audit_res')).toBeDefined();
  });
});
