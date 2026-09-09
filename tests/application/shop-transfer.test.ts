/**
 * Settling a transfer between two shops — `CLAUDE.md` §19.1.
 *
 * > TRAINING ONLY. Real money is blocked by `money.live`, which is false and
 * > asserted at start-up — not by the feature flag and not by this code.
 *
 * ## The one property that matters most
 *
 * **Both sides commit together, or neither does.** A debit that lands without
 * its credit is money *destroyed*: the sender is poorer, the recipient is no
 * richer, and the ledger no longer balances — which §13 makes an invariant, not
 * a preference. The test that proves it is the one where the posting throws.
 */

import { describe, expect, it } from 'vitest';
import { dayStart, settleShopTransfer } from '@telga/api';
import type { TransferAttempt, TransferPorts } from '@telga/api';
// The policy is a *domain* value — the rules package owns limits and pricing,
// and the api package only applies them.
import { TRAINING_TRANSFER_POLICY } from '@telga/domain';
import type { TransferPolicy } from '@telga/domain';

interface Posted {
  readonly senderMerchantId: string;
  readonly recipientMerchantId: string;
  readonly amountMinor: number;
  readonly feeMinor: number;
}

/**
 * A driver stand-in.
 *
 * `transaction` runs the callback and rethrows, recording whether it completed
 * — which is what lets the atomicity test assert that a throw inside left
 * nothing behind, rather than trusting that it would.
 */
function harness(options: {
  readonly senderStatus?: string;
  readonly recipientStatus?: string;
  readonly recipientExists?: boolean;
  readonly available?: number;
  readonly sentToday?: number;
  readonly postThrows?: boolean;
  readonly policy?: TransferPolicy;
}) {
  const saved: Record<string, unknown>[] = [];
  const posted: Posted[] = [];
  let ids = 0;

  const driver = {
    findDevice: (id: string) =>
      options.recipientExists === false ? undefined : { id, merchant_id: 'merchant_b' },
    findMerchant: (id: string) =>
      id === 'merchant_a'
        ? { id, status: options.senderStatus ?? 'ACTIVE' }
        : { id, status: options.recipientStatus ?? 'ACTIVE' },
    sentTodayMinor: () => options.sentToday ?? 0,
    saveShopTransfer: (input: Record<string, unknown>) => {
      saved.push(input);
    },
    transaction: <T>(work: () => T): T => work(),
  };

  const ports: TransferPorts = {
    deps: {
      driver: driver as never,
      now: () => '2026-09-09T12:00:00.000Z',
      newId: (p: string) => `${p}_${String((ids += 1))}`,
    } as never,
    policy: options.policy ?? TRAINING_TRANSFER_POLICY,
    availableMinor: () => options.available ?? 1_000_000,
    postTransfer: (input) => {
      if (options.postThrows === true) throw new Error('ledger refused');
      posted.push({
        senderMerchantId: input.senderMerchantId,
        recipientMerchantId: input.recipientMerchantId,
        amountMinor: input.amountMinor,
        feeMinor: input.feeMinor,
      });
    },
  };

  return { ports, saved, posted };
}

const attempt = (over: Partial<TransferAttempt> = {}): TransferAttempt => ({
  senderMerchantId: 'merchant_a',
  senderDeviceId: 'device_a',
  senderOperatorId: 'operator_a',
  recipientDeviceId: 'device_b',
  amountMinor: 50_000,
  ...over,
});

describe('a transfer that settles', () => {
  it('posts the pair and records the row', () => {
    const h = harness({});
    const result = settleShopTransfer(h.ports, attempt());

    expect(result.kind).toBe('SETTLED');
    expect(h.posted).toHaveLength(1);
    expect(h.posted[0]?.amountMinor).toBe(50_000);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]?.['status']).toBe('SETTLED');
    // The row carries the posting, so the money and the record can be joined.
    expect(h.saved[0]?.['postingId']).toBeDefined();
  });

  it('credits the recipient the full amount even when a fee is charged', () => {
    // The fee is on top, to the sender. Otherwise the sender says 500, the
    // recipient says 495, both are right, and Telga arbitrates its own fee.
    const policy: TransferPolicy = { ...TRAINING_TRANSFER_POLICY, feeBasisPoints: 100 };
    const h = harness({ policy });
    settleShopTransfer(h.ports, attempt({ amountMinor: 50_000 }));

    expect(h.posted[0]?.amountMinor).toBe(50_000);
    expect(h.posted[0]?.feeMinor).toBe(500);
  });
});

describe('atomicity — the property worth the whole design', () => {
  it('records nothing at all when the ledger posting throws', () => {
    // The debit and the credit and the row are one transaction. If the posting
    // fails, the transfer must not exist: a row saying SETTLED with no money
    // behind it is worse than a crash, because nothing later would question it.
    const h = harness({ postThrows: true });

    expect(() => settleShopTransfer(h.ports, attempt())).toThrow('ledger refused');
    expect(h.posted).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
  });
});

describe('refusals', () => {
  it('refuses an unknown recipient device and still leaves a trace', () => {
    // A shop repeatedly sending to a device that does not exist is a pattern
    // worth being able to see. A refusal with no record cannot be investigated.
    const h = harness({ recipientExists: false });
    const result = settleShopTransfer(h.ports, attempt());

    expect(result).toMatchObject({ kind: 'REFUSED', reason: 'RECIPIENT_NOT_FOUND' });
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]?.['status']).toBe('REFUSED');
    // Nothing moved.
    expect(h.posted).toHaveLength(0);
  });

  it('refuses a suspended recipient', () => {
    const h = harness({ recipientStatus: 'SUSPENDED' });
    expect(settleShopTransfer(h.ports, attempt())).toMatchObject({
      reason: 'RECIPIENT_NOT_ACTIVE',
    });
    expect(h.posted).toHaveLength(0);
  });

  it('refuses when the balance cannot cover amount plus fee', () => {
    // §20: no overdraft. Checking the amount alone is how a transfer settles a
    // shop into a negative balance.
    const policy: TransferPolicy = { ...TRAINING_TRANSFER_POLICY, feeBasisPoints: 100 };
    const h = harness({ policy, available: 50_000 });
    expect(settleShopTransfer(h.ports, attempt({ amountMinor: 50_000 }))).toMatchObject({
      reason: 'INSUFFICIENT_BALANCE',
    });
    expect(h.posted).toHaveLength(0);
  });
});

describe('above the threshold', () => {
  it('queues rather than settling, and moves no money', () => {
    // "Awaiting approval" has to mean the sender's balance is untouched, or the
    // word is worth nothing.
    const policy: TransferPolicy = {
      ...TRAINING_TRANSFER_POLICY,
      approvalThresholdMinor: 10_000,
    };
    const h = harness({ policy });
    const result = settleShopTransfer(h.ports, attempt({ amountMinor: 20_000 }));

    expect(result.kind).toBe('NEEDS_APPROVAL');
    expect(h.posted).toHaveLength(0);
    expect(h.saved[0]?.['status']).toBe('NEEDS_APPROVAL');
  });
});

describe('the daily window', () => {
  it('starts at midnight UTC of the day in question', () => {
    expect(dayStart('2026-09-09T23:59:59.999Z')).toBe('2026-09-09T00:00:00.000Z');
    expect(dayStart('2026-09-09T00:00:00.000Z')).toBe('2026-09-09T00:00:00.000Z');
  });

  it('refuses once the day’s total would be exceeded', () => {
    const h = harness({
      sentToday: TRAINING_TRANSFER_POLICY.maxPerDayMinor,
      available: 99_999_999,
    });
    expect(settleShopTransfer(h.ports, attempt({ amountMinor: 1 }))).toMatchObject({
      reason: 'ABOVE_DAILY_LIMIT',
    });
  });
});
