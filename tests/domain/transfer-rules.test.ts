/**
 * Balance moving from one shop to another — `CLAUDE.md` §19.1.
 *
 * > **On for training** by founder decision D146, and what sits behind it is a
 * > simulation. The flag was never what blocks real money — `money.live` is,
 * > and it is false. These tests pin both: the rules of a transfer, and the
 * > distinction that keeps a training deployment from moving real value.
 *
 * ## What they defend
 *
 *   1. **The recipient always receives the full amount.** The fee is charged on
 *      top, to the sender. Otherwise the sender says they sent 500, the
 *      recipient says they got 495, both are right, and Telga is arbitrating
 *      its own fee.
 *   2. **The balance check includes the fee.** §20: *no overdraft*. Checking the
 *      amount alone is how a transfer settles a shop into a negative balance.
 *   3. **A suspended shop neither sends nor receives**, and is told which.
 *   4. **No rate is invented** — the training fee is zero.
 */

import { describe, expect, it } from 'vitest';
import {
  FEATURE_FLAGS,
  MOVES_REAL_MONEY,
  TRAINING_TRANSFER_POLICY,
  decideTransfer,
  transferFeeFor,
} from '@telga/domain';
import type { ShopStatus, TransferPolicy, TransferRequest } from '@telga/domain';
import { MIGRATIONS } from '@telga/persistence';

const request = (over: Partial<TransferRequest> = {}): TransferRequest => ({
  senderMerchantId: 'merchant_a',
  senderStatus: 'ACTIVE',
  senderAvailableMinor: 100_000,
  sentTodayMinor: 0,
  recipient: { merchantId: 'merchant_b', status: 'ACTIVE' },
  amountMinor: 50_000,
  ...over,
});

const decide = (over: Partial<TransferRequest> = {}, policy: TransferPolicy = TRAINING_TRANSFER_POLICY) =>
  decideTransfer(request(over), policy);

describe('what actually keeps this safe', () => {
  it('is on for training, by founder decision D146', () => {
    // Was off. The founder was shown that moving value between two legal
    // entities is regulated (§2, §7) and instructed that it proceed, to be
    // revoked if it causes a problem.
    expect(FEATURE_FLAGS['transfer.shop_to_shop']).toBe(true);
  });

  it('is not the flag that blocks real money — money.live is', () => {
    // The distinction this whole feature rests on. `transfer.shop_to_shop`
    // gates the *simulation*; `money.live` gates whether anything can leave the
    // building, and `assertSafeStartup` refuses to boot if it or any other
    // MOVES_REAL_MONEY flag is on. If this ever inverts, a training deployment
    // could move real value between shops.
    expect(FEATURE_FLAGS['money.live']).toBe(false);
    expect(FEATURE_FLAGS['training.mode']).toBe(true);
  });

  it('stays out of MOVES_REAL_MONEY, because what it moves is simulated', () => {
    // Adding it would make that list mean "features we are nervous about"
    // rather than "features that move real money" — and the startup assertion
    // is only useful while it means the second thing.
    expect(MOVES_REAL_MONEY).not.toContain('transfer.shop_to_shop');
    // The list still names the ones that would.
    expect(MOVES_REAL_MONEY).toContain('remittance');
    expect(MOVES_REAL_MONEY).toContain('money.live');
  });
});

describe('who may send and receive', () => {
  it('accepts a transfer between two active shops', () => {
    const decision = decide();
    expect(decision.outcome).toBe('ACCEPTED');
    expect(decision.creditMinor).toBe(50_000);
  });

  it('refuses an unknown recipient before checking anything else', () => {
    // A balance check against a recipient that does not exist is a check on
    // nothing, and the refusal must name the real problem.
    expect(decide({ recipient: undefined, amountMinor: 999_999_999 }).refusal).toBe(
      'RECIPIENT_NOT_FOUND',
    );
  });

  it('refuses a shop sending to itself', () => {
    // Not a transfer. With a fee configured it would be a way to burn balance.
    const decision = decide({ recipient: { merchantId: 'merchant_a', status: 'ACTIVE' } });
    expect(decision.refusal).toBe('RECIPIENT_IS_SENDER');
  });

  it('refuses a suspended sender and a suspended recipient, distinctly', () => {
    // Two different conversations: one shop needs reinstating, the other needs
    // telling that the shop they are paying is not open.
    for (const status of ['SUSPENDED', 'CLOSED', 'ONBOARDING'] as ShopStatus[]) {
      expect(decide({ senderStatus: status }).refusal, `sender ${status}`).toBe('SENDER_NOT_ACTIVE');
      expect(
        decide({ recipient: { merchantId: 'merchant_b', status } }).refusal,
        `recipient ${status}`,
      ).toBe('RECIPIENT_NOT_ACTIVE');
    }
  });
});

describe('the amount', () => {
  it('refuses zero, negative and fractional minor units', () => {
    // §13 invariant 9: integer minor units, never binary floating point.
    for (const amountMinor of [0, -1, 10.5]) {
      expect(decide({ amountMinor }).refusal, `${amountMinor}`).toBe('AMOUNT_NOT_POSITIVE');
    }
  });

  it('refuses above the per-transfer ceiling', () => {
    expect(
      decide({
        amountMinor: TRAINING_TRANSFER_POLICY.maxPerTransferMinor + 1,
        senderAvailableMinor: 99_999_999,
      }).refusal,
    ).toBe('ABOVE_TRANSFER_LIMIT');
  });

  it('counts what has already been sent today', () => {
    // The daily limit is a total, not a per-transfer one. A shop just under it
    // may still send; one just over may not.
    const policy = TRAINING_TRANSFER_POLICY;
    expect(
      decide({
        sentTodayMinor: policy.maxPerDayMinor - 50_000,
        amountMinor: 50_000,
        senderAvailableMinor: 99_999_999,
      }).outcome,
    ).not.toBe('REFUSED');
    expect(
      decide({
        sentTodayMinor: policy.maxPerDayMinor - 50_000 + 1,
        amountMinor: 50_000,
        senderAvailableMinor: 99_999_999,
      }).refusal,
    ).toBe('ABOVE_DAILY_LIMIT');
  });
});

describe('money, and the no-overdraft rule', () => {
  it('lets a shop send exactly its balance when there is no fee', () => {
    expect(decide({ amountMinor: 100_000, senderAvailableMinor: 100_000 }).outcome).not.toBe(
      'REFUSED',
    );
  });

  it('refuses when the fee would take the sender past their balance', () => {
    // The case a naive check misses: the amount fits, the amount plus fee does
    // not. §20 says no overdraft, and this is where one would appear.
    const withFee: TransferPolicy = { ...TRAINING_TRANSFER_POLICY, feeBasisPoints: 100 };
    const decision = decideTransfer(
      request({ amountMinor: 100_000, senderAvailableMinor: 100_000 }),
      withFee,
    );
    expect(decision.refusal).toBe('INSUFFICIENT_BALANCE');
  });

  it('charges the fee on top, so the recipient gets the full amount', () => {
    const withFee: TransferPolicy = { ...TRAINING_TRANSFER_POLICY, feeBasisPoints: 100 };
    const decision = decideTransfer(
      request({ amountMinor: 50_000, senderAvailableMinor: 100_000 }),
      withFee,
    );
    expect(decision.creditMinor).toBe(50_000);
    expect(decision.feeMinor).toBe(500);
    expect(decision.totalDebitMinor).toBe(50_500);
    // The pair balances: what leaves the sender equals what reaches the
    // recipient plus what Telga takes. A transfer that does not is money
    // created or destroyed.
    expect(decision.totalDebitMinor).toBe(decision.creditMinor + decision.feeMinor);
  });

  it('invents no rate: the training fee is zero', () => {
    expect(TRAINING_TRANSFER_POLICY.feeBasisPoints).toBe(0);
    expect(decide().feeMinor).toBe(0);
    expect(decide().totalDebitMinor).toBe(decide().creditMinor);
  });

  it('rounds a fee up, so Telga never silently absorbs a fraction', () => {
    // The opposite rounding to a reversal fee, and deliberately: there the
    // merchant keeps the fraction because it is their money coming back.
    expect(transferFeeFor(1, 100)).toBe(1);
    expect(transferFeeFor(5001, 100)).toBe(51);
    expect(transferFeeFor(5000, 0)).toBe(0);
  });
});

describe('large transfers need a person', () => {
  it('sends one above the threshold for approval rather than settling it', () => {
    const policy: TransferPolicy = {
      ...TRAINING_TRANSFER_POLICY,
      approvalThresholdMinor: 10_000,
      maxPerTransferMinor: 1_000_000,
    };
    const decision = decideTransfer(
      request({ amountMinor: 10_001, senderAvailableMinor: 999_999 }),
      policy,
    );
    expect(decision.outcome).toBe('ACCEPTED_NEEDS_APPROVAL');
    // Still a well-formed transfer — the amounts are computed, not blanked.
    expect(decision.creditMinor).toBe(10_001);
  });
});

describe('the local ShopStatus union matches the schema', () => {
  it('names exactly the statuses the merchants table allows', () => {
    // `transfer.ts` restates this union rather than importing MerchantStatus,
    // because the domain package must not depend on persistence. That is a
    // deliberate duplication, and this is the guard that stops it drifting: if
    // a migration ever adds a merchant status, this fails.
    const schema = MIGRATIONS.map((m) => m.sql).join('\n');
    const match = /status\s+TEXT NOT NULL CHECK \(status IN \(([^)]*)\)\)[^;]*?\n\) STRICT/.exec(
      schema.slice(schema.indexOf('CREATE TABLE merchants')),
    );
    const inSchema = (match?.[1] ?? '')
      .split(',')
      .map((v) => v.trim().replace(/'/g, ''))
      .filter((v) => v.length > 0)
      .sort();
    expect(inSchema).toEqual(['ACTIVE', 'CLOSED', 'ONBOARDING', 'SUSPENDED']);
  });
});
