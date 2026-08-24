/**
 * Ledger invariants. See `03 Domain/Ledger Invariants.md`.
 */

import { describe, expect, it } from 'vitest';
import {
  AppendOnlyLedger,
  assertBalanced,
  fromBirr,
  LedgerImmutableError,
  LedgerNotBalancedError,
  LiveMoneyDisabledError,
  money,
  signedMinor,
  transactionId,
} from '@telga/domain';
import type { DraftEntry } from '@telga/domain';
import {
  ACC_CLEARING,
  ACC_MERCHANT_A,
  ACC_MERCHANT_B,
  ACC_PROVIDER,
  at,
  fundingEntries,
  MERCHANT_A,
  MERCHANT_B,
  posting,
  saleEntries,
} from '../helpers';

describe('invariant 1 — the ledger is append-only', () => {
  it('exposes no update, delete, or void operation', () => {
    const ledger = new AppendOnlyLedger();
    const surface = new Set([
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(ledger) as object),
    ]);
    for (const forbidden of ['update', 'delete', 'remove', 'void', 'edit', 'set']) {
      expect(surface.has(forbidden)).toBe(false);
    }
  });

  it('refuses to re-post an existing posting id', () => {
    const ledger = new AppendOnlyLedger();
    const entries = fundingEntries(MERCHANT_A, ACC_MERCHANT_A, fromBirr(100));
    ledger.post(posting('post_1'), entries, at(), 'TRAINING');
    expect(() => ledger.post(posting('post_1'), entries, at(), 'TRAINING')).toThrow(LedgerImmutableError);
  });

  it('returns frozen entries that cannot be mutated in place', () => {
    const ledger = new AppendOnlyLedger();
    const [entry] = ledger.post(
      posting('post_1'),
      fundingEntries(MERCHANT_A, ACC_MERCHANT_A, fromBirr(100)),
      at(),
      'TRAINING',
    );
    expect(Object.isFrozen(entry)).toBe(true);
  });
});

describe('invariant 2 — every posting balances', () => {
  it('accepts a balanced posting', () => {
    const ledger = new AppendOnlyLedger();
    const written = ledger.post(
      posting('post_1'),
      fundingEntries(MERCHANT_A, ACC_MERCHANT_A, fromBirr(100)),
      at(),
      'TRAINING',
    );
    expect(written).toHaveLength(2);
    expect(ledger.residual().minor).toBe(0);
  });

  it('rejects an unbalanced posting', () => {
    const ledger = new AppendOnlyLedger();
    const lopsided: DraftEntry[] = [
      {
        accountId: ACC_MERCHANT_A,
        accountKind: 'MERCHANT_FUNDS',
        merchantId: MERCHANT_A,
        direction: 'CREDIT',
        amount: fromBirr(100),
        reason: 'FUNDING_CREDIT',
      },
    ];
    expect(() => ledger.post(posting('post_bad'), lopsided, at(), 'TRAINING')).toThrow(
      LedgerNotBalancedError,
    );
    expect(ledger.size).toBe(0);
  });

  it('rejects an empty posting', () => {
    const ledger = new AppendOnlyLedger();
    expect(() => ledger.post(posting('post_empty'), [], at(), 'TRAINING')).toThrow(LedgerNotBalancedError);
  });

  it('property: a mixed sequence of postings always sums to zero', () => {
    const ledger = new AppendOnlyLedger();
    // Deterministic pseudo-random amounts — the sequence replays exactly.
    let seed = 12345;
    const next = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed % 5000) + 1;
    };

    for (let i = 0; i < 200; i += 1) {
      const amount = money(next());
      const merchant = i % 2 === 0 ? MERCHANT_A : MERCHANT_B;
      const account = i % 2 === 0 ? ACC_MERCHANT_A : ACC_MERCHANT_B;
      const entries =
        i % 3 === 0
          ? fundingEntries(merchant, account, amount)
          : saleEntries(merchant, account, transactionId(`txn_${String(i)}`), amount);
      ledger.post(posting(`post_${String(i)}`), entries, at(), 'TRAINING');
    }

    expect(ledger.size).toBe(400);
    expect(ledger.residual().minor).toBe(0);
  });

  it('signed entries: CREDIT is positive, DEBIT is negative', () => {
    expect(signedMinor({ direction: 'CREDIT', amount: money(500) })).toBe(500);
    expect(signedMinor({ direction: 'DEBIT', amount: money(500) })).toBe(-500);
  });

  it('assertBalanced reports the residual', () => {
    try {
      assertBalanced([
        { direction: 'CREDIT', amount: money(500) },
        { direction: 'DEBIT', amount: money(300) },
      ]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as LedgerNotBalancedError).residualMinor).toBe(200);
    }
  });
});

describe('invariant 7 — entries stay traceable', () => {
  it('carries merchant, transaction, provider reference and rule version', () => {
    const ledger = new AppendOnlyLedger();
    const txId = transactionId('txn_trace');
    ledger.post(
      posting('post_sale'),
      saleEntries(MERCHANT_A, ACC_MERCHANT_A, txId, fromBirr(25)),
      at(),
      'TRAINING',
    );
    const debit = ledger.forTransaction(txId).find((e) => e.direction === 'DEBIT');
    expect(debit?.merchantId).toBe(MERCHANT_A);
    expect(debit?.providerReference).toBe('MOCKREF-TEST');
    expect(debit?.ruleVersion).toBe('unconfirmed-0');
  });
});

describe('account segregation', () => {
  it('keeps merchant funds and provider settlement in separate account kinds', () => {
    const ledger = new AppendOnlyLedger();
    ledger.post(
      posting('post_sale'),
      saleEntries(MERCHANT_A, ACC_MERCHANT_A, transactionId('txn_seg'), fromBirr(25)),
      at(),
      'TRAINING',
    );
    expect(ledger.netOf('MERCHANT_FUNDS', MERCHANT_A).minor).toBe(-2500);
    expect(ledger.netOf('PROVIDER_SETTLEMENT').minor).toBe(2500);
    expect(ledger.forAccountKind('HARDWARE_DEPOSITS')).toHaveLength(0);
  });

  it('bank clearing holds no merchant value', () => {
    const ledger = new AppendOnlyLedger();
    ledger.post(
      posting('post_fund'),
      fundingEntries(MERCHANT_A, ACC_MERCHANT_A, fromBirr(100)),
      at(),
      'TRAINING',
    );
    const clearing = ledger.forAccountKind('BANK_CLEARING');
    expect(clearing).toHaveLength(1);
    expect(clearing[0]?.merchantId).toBeUndefined();
    expect(clearing[0]?.accountId).toBe(ACC_CLEARING);
  });
});

describe('training mode is structural', () => {
  it('refuses to post a LIVE entry', () => {
    const ledger = new AppendOnlyLedger();
    expect(() =>
      ledger.post(posting('post_live'), fundingEntries(MERCHANT_A, ACC_MERCHANT_A, fromBirr(100)), at(), 'LIVE'),
    ).toThrow(LiveMoneyDisabledError);
    expect(ledger.size).toBe(0);
  });

  it('marks every posted entry as simulated', () => {
    const ledger = new AppendOnlyLedger();
    ledger.post(posting('post_1'), fundingEntries(MERCHANT_A, ACC_MERCHANT_A, fromBirr(100)), at(), 'TRAINING');
    expect(ledger.entries().every((entry) => entry.mode === 'TRAINING')).toBe(true);
  });
});

describe('merchant isolation at the ledger', () => {
  it('never returns another merchant entries', () => {
    const ledger = new AppendOnlyLedger();
    ledger.post(posting('p_a'), fundingEntries(MERCHANT_A, ACC_MERCHANT_A, fromBirr(100)), at(), 'TRAINING');
    ledger.post(posting('p_b'), fundingEntries(MERCHANT_B, ACC_MERCHANT_B, fromBirr(700)), at(), 'TRAINING');

    const forA = ledger.forMerchant(MERCHANT_A);
    expect(forA).toHaveLength(1);
    expect(forA.every((entry) => entry.merchantId === MERCHANT_A)).toBe(true);
    expect(ledger.netOf('MERCHANT_FUNDS', MERCHANT_A).minor).toBe(10000);
    expect(ledger.netOf('MERCHANT_FUNDS', MERCHANT_B).minor).toBe(70000);
  });
});

describe('money is integer-only', () => {
  it('refuses a fractional minor amount', () => {
    expect(() => money(12.5)).toThrow();
  });

  it('refuses a fractional birr amount', () => {
    expect(() => fromBirr(12.5)).toThrow();
  });

  it('has no float rounding error across a hundred additions', () => {
    const ledger = new AppendOnlyLedger();
    for (let i = 0; i < 100; i += 1) {
      ledger.post(
        posting(`p_${String(i)}`),
        fundingEntries(MERCHANT_A, ACC_MERCHANT_A, fromBirr(0, 10)),
        at(),
        'TRAINING',
      );
    }
    // 100 × 0.10 birr = exactly 10.00 birr, with no 0.1 + 0.2 drift.
    expect(ledger.netOf('MERCHANT_FUNDS', MERCHANT_A).minor).toBe(1000);
  });
});

describe('provider settlement account', () => {
  it('accumulates the counter-side of every sale', () => {
    const ledger = new AppendOnlyLedger();
    ledger.post(
      posting('s1'),
      saleEntries(MERCHANT_A, ACC_MERCHANT_A, transactionId('t1'), fromBirr(25)),
      at(),
      'TRAINING',
    );
    ledger.post(
      posting('s2'),
      saleEntries(MERCHANT_B, ACC_MERCHANT_B, transactionId('t2'), fromBirr(50)),
      at(),
      'TRAINING',
    );
    expect(ledger.netOf('PROVIDER_SETTLEMENT').minor).toBe(7500);
    expect(ACC_PROVIDER).toBeDefined();
  });
});
