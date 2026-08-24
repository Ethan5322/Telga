/**
 * Balance model — available, reserved, under review, total.
 * See `03 Domain/Balance Model.md`.
 */

import { describe, expect, it } from 'vitest';
import {
  AppendOnlyLedger,
  assertSufficientAvailable,
  computeBalance,
  createReservation,
  CrossMerchantAccessError,
  fromBirr,
  InsufficientAvailableBalanceError,
  moveToUnderReview,
  releaseReservation,
  settleReservation,
  transactionId,
  assertSameMerchant,
} from '@telga/domain';
import type { BalanceReservation } from '@telga/domain';
import {
  ACC_MERCHANT_A,
  ACC_MERCHANT_B,
  at,
  fundingEntries,
  MERCHANT_A,
  MERCHANT_B,
  posting,
  reservation,
  saleEntries,
} from '../helpers';

const TX = transactionId('txn_bal_1');

function fundedLedger(): AppendOnlyLedger {
  const ledger = new AppendOnlyLedger();
  ledger.post(posting('fund_a'), fundingEntries(MERCHANT_A, ACC_MERCHANT_A, fromBirr(100)), at(), 'TRAINING');
  return ledger;
}

const held = (): BalanceReservation =>
  createReservation({
    id: reservation('res_1'),
    merchantId: MERCHANT_A,
    transactionId: TX,
    amount: fromBirr(25),
    at: at(),
  });

describe('reservation and release', () => {
  it('funding makes value available', () => {
    const view = computeBalance(MERCHANT_A, fundedLedger().entries(), []);
    expect(view.available.minor).toBe(10000);
    expect(view.reserved.minor).toBe(0);
    expect(view.underReview.minor).toBe(0);
    expect(view.total.minor).toBe(10000);
  });

  it('a reservation moves value out of available without changing total', () => {
    const view = computeBalance(MERCHANT_A, fundedLedger().entries(), [held()]);
    expect(view.available.minor).toBe(7500);
    expect(view.reserved.minor).toBe(2500);
    expect(view.total.minor).toBe(10000);
  });

  it('releasing restores available exactly', () => {
    const ledger = fundedLedger();
    const before = computeBalance(MERCHANT_A, ledger.entries(), []);
    const reserved = computeBalance(MERCHANT_A, ledger.entries(), [held()]);
    const after = computeBalance(MERCHANT_A, ledger.entries(), [releaseReservation(held(), at())]);

    expect(reserved.available.minor).toBe(7500);
    expect(after.available.minor).toBe(before.available.minor);
    expect(after.reserved.minor).toBe(0);
  });

  it('reserve then release leaves no residue after many cycles', () => {
    const ledger = fundedLedger();
    for (let i = 0; i < 50; i += 1) {
      const r = createReservation({
        id: reservation(`res_${String(i)}`),
        merchantId: MERCHANT_A,
        transactionId: transactionId(`txn_${String(i)}`),
        amount: fromBirr(1, 37),
        at: at(),
      });
      const view = computeBalance(MERCHANT_A, ledger.entries(), [releaseReservation(r, at())]);
      expect(view.available.minor).toBe(10000);
    }
  });

  it('refuses a reservation larger than available', () => {
    const view = computeBalance(MERCHANT_A, fundedLedger().entries(), []);
    expect(() => {
      assertSufficientAvailable(view, fromBirr(500));
    }).toThrow(InsufficientAvailableBalanceError);
  });

  it('allows a reservation exactly equal to available', () => {
    const view = computeBalance(MERCHANT_A, fundedLedger().entries(), []);
    expect(() => {
      assertSufficientAvailable(view, fromBirr(100));
    }).not.toThrow();
  });

  it('refuses a second reservation that would overdraw', () => {
    const ledger = fundedLedger();
    const first = createReservation({
      id: reservation('res_big'),
      merchantId: MERCHANT_A,
      transactionId: TX,
      amount: fromBirr(90),
      at: at(),
    });
    const view = computeBalance(MERCHANT_A, ledger.entries(), [first]);
    expect(view.available.minor).toBe(1000);
    expect(() => {
      assertSufficientAvailable(view, fromBirr(25));
    }).toThrow(InsufficientAvailableBalanceError);
  });
});

describe('successful final debit', () => {
  it('debits the merchant and clears the reservation', () => {
    const ledger = fundedLedger();
    ledger.post(posting('sale_1'), saleEntries(MERCHANT_A, ACC_MERCHANT_A, TX, fromBirr(25)), at(), 'TRAINING');

    const view = computeBalance(MERCHANT_A, ledger.entries(), [settleReservation(held(), at())]);

    expect(view.total.minor).toBe(7500);
    expect(view.available.minor).toBe(7500);
    expect(view.reserved.minor).toBe(0);
    expect(view.underReview.minor).toBe(0);
  });

  it('never double-counts: the reservation and the debit do not both reduce available', () => {
    const ledger = fundedLedger();
    ledger.post(posting('sale_1'), saleEntries(MERCHANT_A, ACC_MERCHANT_A, TX, fromBirr(25)), at(), 'TRAINING');
    const settled = computeBalance(MERCHANT_A, ledger.entries(), [settleReservation(held(), at())]);
    // 100 − 25 = 75, not 50.
    expect(settled.available.minor).toBe(7500);
  });
});

describe('under-review funds', () => {
  it('are excluded from available balance', () => {
    const view = computeBalance(MERCHANT_A, fundedLedger().entries(), [moveToUnderReview(held(), at())]);
    expect(view.underReview.minor).toBe(2500);
    expect(view.available.minor).toBe(7500);
  });

  it('are not counted as reserved', () => {
    const view = computeBalance(MERCHANT_A, fundedLedger().entries(), [moveToUnderReview(held(), at())]);
    expect(view.reserved.minor).toBe(0);
  });

  it('remain part of total — the value has not left the merchant', () => {
    const view = computeBalance(MERCHANT_A, fundedLedger().entries(), [moveToUnderReview(held(), at())]);
    expect(view.total.minor).toBe(10000);
    expect(view.available.minor + view.reserved.minor + view.underReview.minor).toBe(view.total.minor);
  });

  it('the four views always reconcile', () => {
    const ledger = fundedLedger();
    const reservations = [
      held(),
      moveToUnderReview(
        createReservation({
          id: reservation('res_2'),
          merchantId: MERCHANT_A,
          transactionId: transactionId('txn_bal_2'),
          amount: fromBirr(10),
          at: at(),
        }),
        at(),
      ),
    ];
    const view = computeBalance(MERCHANT_A, ledger.entries(), reservations);
    expect(view.available.minor).toBe(6500);
    expect(view.reserved.minor).toBe(2500);
    expect(view.underReview.minor).toBe(1000);
    expect(view.available.minor + view.reserved.minor + view.underReview.minor).toBe(view.total.minor);
  });
});

describe('merchant isolation', () => {
  it('one merchant balance is unaffected by another activity', () => {
    const ledger = new AppendOnlyLedger();
    ledger.post(posting('fund_a'), fundingEntries(MERCHANT_A, ACC_MERCHANT_A, fromBirr(100)), at(), 'TRAINING');
    ledger.post(posting('fund_b'), fundingEntries(MERCHANT_B, ACC_MERCHANT_B, fromBirr(900)), at(), 'TRAINING');
    ledger.post(
      posting('sale_b'),
      saleEntries(MERCHANT_B, ACC_MERCHANT_B, transactionId('txn_b'), fromBirr(400)),
      at(),
      'TRAINING',
    );

    const a = computeBalance(MERCHANT_A, ledger.entries(), []);
    const b = computeBalance(MERCHANT_B, ledger.entries(), []);

    expect(a.total.minor).toBe(10000);
    expect(b.total.minor).toBe(50000);
  });

  it("another merchant reservations never reduce this merchant available balance", () => {
    const ledger = fundedLedger();
    const foreign = createReservation({
      id: reservation('res_foreign'),
      merchantId: MERCHANT_B,
      transactionId: transactionId('txn_foreign'),
      amount: fromBirr(80),
      at: at(),
    });
    const view = computeBalance(MERCHANT_A, ledger.entries(), [foreign]);
    expect(view.available.minor).toBe(10000);
    expect(view.reserved.minor).toBe(0);
  });

  it('passing a mixed set gives the same answer as passing a filtered one', () => {
    const ledger = new AppendOnlyLedger();
    ledger.post(posting('fund_a'), fundingEntries(MERCHANT_A, ACC_MERCHANT_A, fromBirr(100)), at(), 'TRAINING');
    ledger.post(posting('fund_b'), fundingEntries(MERCHANT_B, ACC_MERCHANT_B, fromBirr(900)), at(), 'TRAINING');

    const mixed = computeBalance(MERCHANT_A, ledger.entries(), []);
    const filtered = computeBalance(MERCHANT_A, ledger.forMerchant(MERCHANT_A), []);
    expect(mixed).toEqual(filtered);
  });

  it('a cross-merchant action is refused outright', () => {
    expect(() => {
      assertSameMerchant(MERCHANT_A, MERCHANT_B);
    }).toThrow(CrossMerchantAccessError);
  });
});
