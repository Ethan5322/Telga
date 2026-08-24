/**
 * Merchant isolation at the persistence boundary.
 *
 * Every scoped read filters in SQL. These tests assert that a foreign row is
 * **not returned**, rather than returned and then hoped to be filtered by the
 * caller — that difference is what survives a forgotten check upstream.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { fromBirr, postingId, transactionId } from '@telga/domain';
import { fundMerchant, merchantAccountId, MerchantScopeViolationError, reserve } from '@telga/persistence';
import type { SqliteLedgerDriver } from '@telga/persistence';
import {
  actor,
  at,
  DEVICE_A,
  DEVICE_B,
  makeHarness,
  makeTransaction,
  MERCHANT_A,
  MERCHANT_B,
  seedMerchant,
  transactionInput,
} from './helpers';
import type { Harness } from './helpers';

const TX_A = transactionId('txn_a_1');
const TX_B = transactionId('txn_b_1');

let harnesses: Harness[] = [];

function twoMerchants(name: string): SqliteLedgerDriver {
  const h = makeHarness(name);
  harnesses.push(h);
  const { driver } = h;

  seedMerchant(driver, MERCHANT_A, DEVICE_A);
  seedMerchant(driver, MERCHANT_B, DEVICE_B);

  fundMerchant(driver, {
    merchantId: MERCHANT_A,
    amount: fromBirr(100),
    at: at(),
    correlationId: 'corr_a',
    postingId: postingId('post_fund_a'),
  });
  fundMerchant(driver, {
    merchantId: MERCHANT_B,
    amount: fromBirr(900),
    at: at(),
    correlationId: 'corr_b',
    postingId: postingId('post_fund_b'),
  });

  driver.saveTransaction(transactionInput(makeTransaction({ id: TX_A, merchant: MERCHANT_A, device: DEVICE_A })));
  driver.saveTransaction(
    transactionInput(
      makeTransaction({ id: TX_B, merchant: MERCHANT_B, device: DEVICE_B, key: 'idem_b_0001' }),
    ),
  );

  return driver;
}

afterEach(() => {
  for (const h of harnesses) h.cleanup();
  harnesses = [];
});

describe('transactions', () => {
  it("merchant A cannot read merchant B's transaction", () => {
    const driver = twoMerchants('iso-tx');
    expect(driver.findTransaction(TX_B, MERCHANT_A)).toBeUndefined();
    expect(driver.findTransaction(TX_B, MERCHANT_B)?.id).toBe(TX_B);
  });

  it('a merchant listing returns only its own transactions', () => {
    const driver = twoMerchants('iso-tx-list');
    const forA = driver.findTransactionsByMerchant(MERCHANT_A);
    expect(forA).toHaveLength(1);
    expect(forA.every((row) => row.merchant_id === MERCHANT_A)).toBe(true);
  });
});

describe('ledger', () => {
  it("merchant A cannot read merchant B's entries", () => {
    const driver = twoMerchants('iso-ledger');
    const forA = driver.readEntriesByMerchant(MERCHANT_A);
    expect(forA.length).toBeGreaterThan(0);
    expect(forA.every((row) => row.merchant_id === MERCHANT_A)).toBe(true);
  });

  it("a transaction-scoped read refuses another merchant's transaction", () => {
    const driver = twoMerchants('iso-ledger-tx');
    expect(driver.readEntriesByTransaction(TX_B, MERCHANT_A)).toHaveLength(0);
  });

  it("one merchant's balance is unaffected by the other's activity", () => {
    const driver = twoMerchants('iso-balance');
    expect(driver.balanceFor(MERCHANT_A).total.minor).toBe(10000);
    expect(driver.balanceFor(MERCHANT_B).total.minor).toBe(90000);
  });

  it("a reservation by B does not reduce A's available balance", () => {
    const driver = twoMerchants('iso-reserve');
    reserve(driver, {
      merchantId: MERCHANT_B,
      transactionId: TX_B,
      amount: fromBirr(400),
      at: at(),
      correlationId: 'corr_b',
      actor,
      postingId: postingId('post_res_b'),
      auditId: 'audit_res_b',
    });

    expect(driver.balanceFor(MERCHANT_A).available.minor).toBe(10000);
    expect(driver.balanceFor(MERCHANT_B).available.minor).toBe(50000);
    expect(driver.balanceFor(MERCHANT_B).reserved.minor).toBe(40000);
  });

  it('an entry may not claim a merchant that does not own the account', () => {
    const driver = twoMerchants('iso-entry');
    expect(() =>
      driver.appendEntries({
        postingId: postingId('post_cross'),
        correlationId: 'corr_cross',
        at: at(),
        mode: 'TRAINING',
        entries: [
          {
            accountId: merchantAccountId(MERCHANT_B, 'MERCHANT_AVAILABLE'),
            accountKind: 'MERCHANT_AVAILABLE',
            merchantId: MERCHANT_A,
            direction: 'CREDIT',
            amount: fromBirr(10),
            reason: 'ADJUSTMENT',
          },
          {
            accountId: merchantAccountId(MERCHANT_A, 'MERCHANT_AVAILABLE'),
            accountKind: 'MERCHANT_AVAILABLE',
            merchantId: MERCHANT_A,
            direction: 'DEBIT',
            amount: fromBirr(10),
            reason: 'ADJUSTMENT',
          },
        ],
      }),
    ).toThrow(MerchantScopeViolationError);
  });
});

describe('reservations', () => {
  it("merchant A cannot use merchant B's reservation", () => {
    const driver = twoMerchants('iso-res');
    reserve(driver, {
      merchantId: MERCHANT_B,
      transactionId: TX_B,
      amount: fromBirr(400),
      at: at(),
      correlationId: 'corr_b',
      actor,
      postingId: postingId('post_res_b'),
      auditId: 'audit_res_b',
    });

    expect(driver.findReservation(TX_B, MERCHANT_A)).toBeUndefined();
    expect(driver.findReservation(TX_B, MERCHANT_B)?.merchant_id).toBe(MERCHANT_B);
    expect(driver.findReservationsByMerchant(MERCHANT_A)).toHaveLength(0);
  });
});

describe('devices', () => {
  it("merchant A cannot read merchant B's device", () => {
    const driver = twoMerchants('iso-device');
    expect(driver.findDevice(DEVICE_B, MERCHANT_A)).toBeUndefined();
    expect(driver.findDevice(DEVICE_B, MERCHANT_B)?.id).toBe(DEVICE_B);
  });

  it('device ownership is enforced', () => {
    const driver = twoMerchants('iso-device-own');
    expect(() => {
      driver.assertDeviceOwnership(DEVICE_B, MERCHANT_A);
    }).toThrow(MerchantScopeViolationError);
    expect(() => {
      driver.assertDeviceOwnership(DEVICE_B, MERCHANT_B);
    }).not.toThrow();
  });
});

describe('audit', () => {
  it("merchant A cannot read merchant B's audit events", () => {
    const driver = twoMerchants('iso-audit');
    reserve(driver, {
      merchantId: MERCHANT_B,
      transactionId: TX_B,
      amount: fromBirr(400),
      at: at(),
      correlationId: 'corr_b',
      actor,
      postingId: postingId('post_res_b'),
      auditId: 'audit_res_b',
    });

    expect(driver.readAuditEvents(MERCHANT_A)).toHaveLength(0);
    expect(driver.readAuditEvents(MERCHANT_B).length).toBeGreaterThan(0);
  });
});
