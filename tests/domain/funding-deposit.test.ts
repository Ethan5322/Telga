/**
 * Deposit references and the funding decision.
 *
 * Two things are being proved here, and the second is the important one.
 *
 *   1. A deposit reference survives being written on a bank slip and read back:
 *      it is case- and grouping-insensitive, and a single mistyped character is
 *      caught rather than silently resolving to somebody else's shop.
 *
 *   2. **No input produces a credit without a bank record.** CLAUDE.md says
 *      *"Never credit a balance from a screenshot alone"* (L128) and *"No
 *      screenshot-only credit"* (L402). The founder's interim flow is a WhatsApp
 *      photograph of a CBE slip, which makes that rule the one most likely to be
 *      bent in a hurry — so it is asserted directly, including an exhaustive
 *      sweep over the other inputs to show that none of them opens a way round.
 */

import { describe, expect, it } from 'vitest';
import {
  DEPOSIT_REFERENCE_ALPHABET,
  DEPOSIT_REFERENCE_LENGTH,
  assertFundingTransition,
  canTransitionFunding,
  depositReferenceCheckCharacter,
  depositReferenceRejection,
  formatDepositReference,
  isTerminalFundingStatus,
  isValidDepositReference,
  newDepositReference,
  normalizeDepositReference,
  statusAfterVerification,
  verifyDeposit,
} from '@telga/domain';
import type {
  BankRecord,
  FundingStatus,
  MerchantId,
  VerificationInput,
} from '@telga/domain';

const MERCHANT = 'merchant_alpha' as MerchantId;
const ACCOUNT = '1000123456789';

const bankRecord = (over: Partial<BankRecord> = {}): BankRecord => ({
  bankReference: 'FT26090812345',
  amountMinor: 50_000,
  creditedAccount: ACCOUNT,
  ...over,
});

const input = (over: Partial<VerificationInput> = {}): VerificationInput => ({
  claim: { depositReference: newDepositReference(), bankReference: 'FT26090812345' },
  bankRecord: bankRecord(),
  merchantForReference: MERCHANT,
  alreadyCredited: false,
  expectedAccount: ACCOUNT,
  autoCreditCapMinor: 5_000_000,
  ...over,
});

// ---------------------------------------------------------------------------
// The reference code
// ---------------------------------------------------------------------------

describe('a deposit reference survives a bank counter', () => {
  it('generates a valid, correctly shaped reference', () => {
    for (let i = 0; i < 200; i += 1) {
      const reference = newDepositReference();
      expect(isValidDepositReference(reference), reference).toBe(true);
      expect(normalizeDepositReference(reference)).toHaveLength(DEPOSIT_REFERENCE_LENGTH);
      // Grouped in threes so a person does not lose their place.
      expect(reference).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    }
  });

  it('accepts the same code however it was written down', () => {
    const reference = newDepositReference();
    const bare = normalizeDepositReference(reference);
    for (const written of [bare, bare.toLowerCase(), reference, ` ${reference} `, bare.split('').join(' ')]) {
      expect(isValidDepositReference(written), written).toBe(true);
      expect(normalizeDepositReference(written)).toBe(bare);
    }
  });

  it('excludes the four characters people mistype', () => {
    // I/1 and O/0 are the pairs that get confused on a handwritten slip.
    for (const forbidden of ['I', 'O', '0', '1']) {
      expect(DEPOSIT_REFERENCE_ALPHABET).not.toContain(forbidden);
    }
    for (let i = 0; i < 50; i += 1) {
      expect(newDepositReference()).not.toMatch(/[IO01]/);
    }
  });

  it('catches every single mistyped character', () => {
    // The teller's actual error. Every substitution at every position must be
    // refused, or a typo silently becomes a different — possibly real — code.
    const bare = normalizeDepositReference(newDepositReference());
    let checked = 0;
    for (let position = 0; position < bare.length; position += 1) {
      for (const symbol of DEPOSIT_REFERENCE_ALPHABET) {
        if (symbol === bare[position]) continue;
        const typo = bare.slice(0, position) + symbol + bare.slice(position + 1);
        expect(isValidDepositReference(typo), typo).toBe(false);
        checked += 1;
      }
    }
    expect(checked).toBe(bare.length * (DEPOSIT_REFERENCE_ALPHABET.length - 1));
  });

  it('refuses a character outside the alphabet rather than repairing it', () => {
    // A `0` is not quietly read as `O`. Neither is in the alphabet, and a
    // reference repaired into validity might belong to a different shop.
    const bare = normalizeDepositReference(newDepositReference());
    const withZero = `0${bare.slice(1)}`;
    expect(depositReferenceRejection(withZero)).toBe('REFERENCE_BAD_CHARACTER');
  });

  it('names why a reference is unusable, so the shop can be told', () => {
    expect(depositReferenceRejection('')).toBe('REFERENCE_EMPTY');
    expect(depositReferenceRejection('   ')).toBe('REFERENCE_EMPTY');
    expect(depositReferenceRejection('ABC-DEF')).toBe('REFERENCE_WRONG_LENGTH');
    const bare = normalizeDepositReference(newDepositReference());
    const wrongCheck = bare.slice(0, -1) + (bare.endsWith('A') ? 'B' : 'A');
    expect(depositReferenceRejection(wrongCheck)).toBe('REFERENCE_CHECK_FAILED');
  });

  it('is a check character over the data, and is stable', () => {
    expect(depositReferenceCheckCharacter('ABCDEFGH')).toBe(
      depositReferenceCheckCharacter('ABCDEFGH'),
    );
    expect(depositReferenceCheckCharacter('ABCDEF0H')).toBeUndefined();
    expect(formatDepositReference('abcdefghj')).toBe('ABC-DEF-GHJ');
  });

  it('does not repeat itself', () => {
    // Uniqueness is enforced by the store, but a generator that collided often
    // would make that constraint a source of retries rather than a backstop.
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i += 1) seen.add(newDepositReference());
    expect(seen.size).toBe(2_000);
  });
});

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

describe('no credit without a bank record', () => {
  it('refuses when the bank has no such transaction', () => {
    const decision = verifyDeposit(input({ bankRecord: undefined }));
    expect(decision.kind).toBe('REJECT');
    expect(decision).toMatchObject({ reason: 'NO_BANK_RECORD' });
  });

  it('cannot be talked into a credit by any other input', () => {
    // The exhaustive form of the rule. A claim is varied every way a shop or an
    // attacker could vary it — a huge amount, a matching amount, a cap raised to
    // infinity, an approving-looking reference — and with no bank record none of
    // them yields value.
    const variations: Partial<VerificationInput>[] = [
      {},
      { claim: { depositReference: 'ABC-DEF-GHJ', bankReference: 'FT1', claimedAmountMinor: 1 } },
      {
        claim: {
          depositReference: newDepositReference(),
          bankReference: 'FT99999',
          claimedAmountMinor: 100_000_000,
        },
      },
      { autoCreditCapMinor: Number.MAX_SAFE_INTEGER },
      { autoCreditCapMinor: 0 },
      { expectedAccount: ACCOUNT },
    ];
    for (const variation of variations) {
      const decision = verifyDeposit(input({ ...variation, bankRecord: undefined }));
      expect(decision.kind, JSON.stringify(variation)).not.toBe('CREDIT');
      expect(decision.kind, JSON.stringify(variation)).not.toBe('NEEDS_APPROVAL');
    }
  });

  it('credits the bank amount, never the claimed one', () => {
    // Whichever way the two differ. A shop that typed 10,000 having paid 100 is
    // credited 100; a shop that typed 100 having paid 10,000 is credited 10,000.
    const claimed = verifyDeposit(
      input({
        claim: {
          depositReference: 'ABC-DEF-GHJ',
          bankReference: 'FT26090812345',
          claimedAmountMinor: 999_999,
        },
        bankRecord: bankRecord({ amountMinor: 50_000 }),
      }),
    );
    expect(claimed).toMatchObject({
      kind: 'CREDIT',
      amountMinor: 50_000,
      claimedAmountDiffered: true,
    });
  });

  it('does not flag a discrepancy when there is none', () => {
    const decision = verifyDeposit(
      input({
        claim: {
          depositReference: 'ABC-DEF-GHJ',
          bankReference: 'FT26090812345',
          claimedAmountMinor: 50_000,
        },
      }),
    );
    expect(decision).toMatchObject({ kind: 'CREDIT', amountMinor: 50_000 });
    expect(decision).not.toHaveProperty('claimedAmountDiffered');
  });
});

describe('the refusals that protect somebody else', () => {
  it('refuses a genuine slip for a deposit into another account', () => {
    const decision = verifyDeposit(
      input({ bankRecord: bankRecord({ creditedAccount: '9999999999' }) }),
    );
    expect(decision).toMatchObject({ kind: 'REJECT', reason: 'WRONG_ACCOUNT' });
  });

  it('refuses a record fetched for a different transaction', () => {
    const decision = verifyDeposit(
      input({ bankRecord: bankRecord({ bankReference: 'FT-SOMETHING-ELSE' }) }),
    );
    expect(decision).toMatchObject({ kind: 'REJECT', reason: 'BANK_REFERENCE_MISMATCH' });
  });

  it('refuses a zero, negative or non-integer amount', () => {
    for (const amountMinor of [0, -5_000, 1.5, Number.NaN, Number.MAX_VALUE]) {
      const decision = verifyDeposit(input({ bankRecord: bankRecord({ amountMinor }) }));
      expect(decision, String(amountMinor)).toMatchObject({
        kind: 'REJECT',
        reason: 'AMOUNT_NOT_POSITIVE',
      });
    }
  });

  it('never guesses which shop an unknown reference belongs to', () => {
    // The failure this prevents is one shop credited with another's money.
    const decision = verifyDeposit(input({ merchantForReference: undefined }));
    expect(decision).toMatchObject({
      kind: 'MANUAL_REVIEW',
      reason: 'REFERENCE_NOT_ASSIGNED',
    });
  });

  it('separates an unreadable reference from an unassigned one', () => {
    // Different conversations with the shop: "read it to me again" versus
    // "that code is not yours".
    const decision = verifyDeposit(
      input({
        claim: { depositReference: '   ', bankReference: 'FT1' },
        merchantForReference: undefined,
      }),
    );
    expect(decision).toMatchObject({ kind: 'MANUAL_REVIEW', reason: 'REFERENCE_UNREADABLE' });
  });

  it('sends a claim with no bank reference to a person', () => {
    const decision = verifyDeposit(
      input({ claim: { depositReference: 'ABC-DEF-GHJ', bankReference: '  ' } }),
    );
    expect(decision).toMatchObject({
      kind: 'MANUAL_REVIEW',
      reason: 'BANK_REFERENCE_MISSING',
    });
  });
});

describe('the same slip, sent twice', () => {
  it('credits once and reports the second as a duplicate', () => {
    const decision = verifyDeposit(input({ alreadyCredited: true }));
    expect(decision).toMatchObject({ kind: 'DUPLICATE', bankReference: 'FT26090812345' });
  });

  it('checks for a duplicate before consulting the bank at all', () => {
    // Ordering matters: a replayed slip must not be able to race a first-time
    // one, and must not depend on the bank lookup succeeding to be caught.
    const decision = verifyDeposit(input({ alreadyCredited: true, bankRecord: undefined }));
    expect(decision.kind).toBe('DUPLICATE');
  });
});

describe('high-value deposits need a second pair of eyes', () => {
  it('credits automatically at or below the cap', () => {
    const decision = verifyDeposit(
      input({ bankRecord: bankRecord({ amountMinor: 5_000_000 }), autoCreditCapMinor: 5_000_000 }),
    );
    expect(decision.kind).toBe('CREDIT');
  });

  it('holds for approval above it — CLAUDE.md §20', () => {
    const decision = verifyDeposit(
      input({ bankRecord: bankRecord({ amountMinor: 5_000_001 }), autoCreditCapMinor: 5_000_000 }),
    );
    expect(decision).toMatchObject({
      kind: 'NEEDS_APPROVAL',
      merchantId: MERCHANT,
      amountMinor: 5_000_001,
    });
  });

  it('a cap of zero sends everything to a human, and still refuses a bad one', () => {
    expect(verifyDeposit(input({ autoCreditCapMinor: 0 })).kind).toBe('NEEDS_APPROVAL');
    expect(verifyDeposit(input({ autoCreditCapMinor: 0, bankRecord: undefined })).kind).toBe(
      'REJECT',
    );
  });
});

describe('the status flow', () => {
  it('maps every decision to a status', () => {
    expect(statusAfterVerification(verifyDeposit(input()))).toBe('CREDITED');
    expect(statusAfterVerification(verifyDeposit(input({ alreadyCredited: true })))).toBe(
      'DUPLICATE',
    );
    expect(statusAfterVerification(verifyDeposit(input({ bankRecord: undefined })))).toBe(
      'REJECTED',
    );
    expect(
      statusAfterVerification(verifyDeposit(input({ autoCreditCapMinor: 0 }))),
    ).toBe('MATCHED');
    expect(
      statusAfterVerification(verifyDeposit(input({ merchantForReference: undefined }))),
    ).toBe('MANUAL_REVIEW');
  });

  it('never re-opens a terminal submission', () => {
    // A credited deposit that could be re-opened could be credited twice. A
    // correction is an authorised adjustment entry, not a status edit — §13.8.
    const all: FundingStatus[] = [
      'SUBMITTED',
      'AWAITING_VERIFICATION',
      'MATCHED',
      'CREDITED',
      'REJECTED',
      'DUPLICATE',
      'MANUAL_REVIEW',
    ];
    for (const terminal of ['CREDITED', 'REJECTED', 'DUPLICATE'] as const) {
      expect(isTerminalFundingStatus(terminal)).toBe(true);
      for (const to of all) {
        expect(canTransitionFunding(terminal, to), `${terminal} -> ${to}`).toBe(false);
      }
    }
  });

  it('allows the path a real deposit takes', () => {
    expect(canTransitionFunding('SUBMITTED', 'AWAITING_VERIFICATION')).toBe(true);
    expect(canTransitionFunding('AWAITING_VERIFICATION', 'MATCHED')).toBe(true);
    expect(canTransitionFunding('MATCHED', 'CREDITED')).toBe(true);
    expect(canTransitionFunding('MANUAL_REVIEW', 'CREDITED')).toBe(true);
    // A declined second approval goes back to a person, not to a rejection:
    // the money is at the bank either way.
    expect(canTransitionFunding('MATCHED', 'CREDITED')).toBe(true);
    expect(canTransitionFunding('MATCHED', 'MANUAL_REVIEW')).toBe(true);
    expect(canTransitionFunding('MATCHED', 'REJECTED')).toBe(false);
  });

  it('refuses a jump straight to credited', () => {
    expect(canTransitionFunding('SUBMITTED', 'CREDITED')).toBe(false);
    expect(() => {
      assertFundingTransition('SUBMITTED', 'CREDITED');
    }).toThrow(/cannot move from SUBMITTED to CREDITED/);
  });
});
