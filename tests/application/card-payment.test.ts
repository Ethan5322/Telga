/**
 * Taking a card payment: read, authorise, approve or decline.
 *
 * The flow is written once against two ports — `CardReader` and
 * `PaymentProcessor` — so it runs unchanged against the simulator here and
 * against a certified reader and a live acquirer when those are connected.
 * These tests exercise it through the simulator, including the cases a shop
 * handles worst when it meets them for the first time at a counter.
 */

import { describe, expect, it } from 'vitest';
import { createSimulatedCardReader, createSimulatedProcessor } from '@telga/provider-mock-airtime';
import { takeCardPayment } from '@telga/api';
import type { CardPurchaseDeps } from '@telga/api';

function deps(overrides: Parameters<typeof createSimulatedCardReader>[0] = {}): CardPurchaseDeps {
  return {
    reader: createSimulatedCardReader(overrides),
    processor: createSimulatedProcessor(),
    mode: 'TRAINING',
    now: () => '2026-08-29T10:00:00.000Z',
    newId: (prefix: string) => `${prefix}_1`,
  };
}

const purchase = {
  amountMinor: 12_500,
  kind: 'PURCHASE' as const,
  entryMode: 'INSERT' as const,
  clientRequestId: 'req_card_0001',
};

describe('a card purchase', () => {
  it('approves, and carries an authorisation code for the slip', async () => {
    const result = await takeCardPayment(deps({ lastFour: '4242' }), purchase);

    expect(result.kind).toBe('APPROVED');
    if (result.kind !== 'APPROVED') return;
    expect(result.authorizationCode).toBeTruthy();
    expect(result.amountMinor).toBe(12_500);
    // Everything this build produces is marked simulated — there is no
    // acquirer contract behind it.
    expect(result.simulated).toBe(true);
  });

  it('declines when the card has no money, and takes nothing', async () => {
    const result = await takeCardPayment(deps({ lastFour: '0002' }), purchase);

    expect(result.kind).toBe('DECLINED');
    if (result.kind !== 'DECLINED') return;
    expect(result.reason).toBe('INSUFFICIENT_FUNDS');
    // `INSUFFICIENT_FUNDS` means nothing across a counter, so the flow hands
    // the screen a sentence to say instead.
    expect(result.messageKey).toBe('card.decline.insufficient_funds');
    // Trying the same card again will not help.
    expect(result.retryable).toBe(false);
  });

  it('tells a merchant which declines are worth another try', async () => {
    const wrongPin = await takeCardPayment(deps({ lastFour: '0127' }), purchase);
    expect(wrongPin.kind === 'DECLINED' && wrongPin.retryable).toBe(true);

    const blocked = await takeCardPayment(deps({ lastFour: '9995' }), purchase);
    expect(blocked.kind === 'DECLINED' && blocked.retryable).toBe(false);

    const expired = await takeCardPayment(deps({ lastFour: '0069' }), purchase);
    expect(expired.kind === 'DECLINED' && expired.reason).toBe('CARD_EXPIRED');
  });

  it('never reports a silent acquirer as a failure', async () => {
    // The dangerous case: the money may or may not have moved. Calling it
    // declined would have a shop hand over goods for nothing — or refuse a
    // customer who has already been charged.
    const result = await takeCardPayment(deps({ lastFour: '0341' }), purchase);
    expect(result.kind).toBe('NO_RESPONSE');
  });

  it('reads a card by tap, insert or swipe, and records which', async () => {
    for (const entryMode of ['TAP', 'INSERT', 'SWIPE'] as const) {
      const result = await takeCardPayment(deps({ lastFour: '4242', entryMode }), {
        ...purchase,
        entryMode,
      });
      expect(result.kind).toBe('APPROVED');
      if (result.kind !== 'APPROVED') continue;
      expect(result.card.entryMode).toBe(entryMode);
      // A swipe carries no cryptogram — which is why a real acquirer treats
      // it as higher risk than a chip or a tap.
      expect(result.card.chipVerified).toBe(entryMode !== 'SWIPE');
    }
  });

  it('says so when there is no reader attached', async () => {
    const result = await takeCardPayment(deps({ readerPresent: false }), purchase);
    expect(result.kind).toBe('CARD_NOT_READ');
    if (result.kind !== 'CARD_NOT_READ') return;
    expect(result.why).toBe('NO_READER');
  });

  it('never exposes anything but a masked number', async () => {
    const result = await takeCardPayment(deps({ lastFour: '4242' }), purchase);
    if (result.kind !== 'APPROVED') throw new Error('expected an approval');

    // The PAN, the track data, the cryptogram and the CVV must not exist
    // anywhere in what this returns. `CardRead` has no field for any of them,
    // so there is nothing that could accidentally persist one.
    const serialised = JSON.stringify(result);
    expect(result.card.maskedPan).toBe('•••• •••• •••• 4242');
    expect(serialised.toLowerCase()).not.toContain('cvv');
    expect(serialised.toLowerCase()).not.toContain('cvc');
    expect(serialised.toLowerCase()).not.toContain('track');
    expect(serialised).not.toMatch(/\b\d{13,19}\b/);
  });
});

describe('cash back', () => {
  it('approves a purchase with cash handed over', async () => {
    const result = await takeCardPayment(deps({ lastFour: '4242' }), {
      ...purchase,
      kind: 'CASHBACK',
      amountMinor: 20_000,
      cashOutMinor: 5_000,
    });
    expect(result.kind).toBe('APPROVED');
    if (result.kind !== 'APPROVED') return;
    expect(result.cashOutMinor).toBe(5_000);
  });

  it('refuses to hand over more cash than is authorised', async () => {
    const result = await takeCardPayment(deps({ lastFour: '4242' }), {
      ...purchase,
      kind: 'CASHBACK',
      amountMinor: 5_000,
      cashOutMinor: 20_000,
    });
    expect(result.kind).toBe('AMOUNT_INVALID');
  });

  it('declines cash back on an empty card, so no cash leaves the till', async () => {
    const result = await takeCardPayment(deps({ lastFour: '0002' }), {
      ...purchase,
      kind: 'CASHBACK',
      amountMinor: 20_000,
      cashOutMinor: 5_000,
    });
    expect(result.kind).toBe('DECLINED');
    if (result.kind !== 'DECLINED') return;
    expect(result.reason).toBe('INSUFFICIENT_FUNDS');
  });
});

describe('amount checks', () => {
  it('refuses a zero, negative or fractional amount', async () => {
    for (const amountMinor of [0, -100, 1.5]) {
      const result = await takeCardPayment(deps(), { ...purchase, amountMinor });
      expect(result.kind, `${String(amountMinor)} must be refused`).toBe('AMOUNT_INVALID');
    }
  });

  it('declines past the card limit even on an approving card', async () => {
    const result = await takeCardPayment(deps({ lastFour: '4242' }), {
      ...purchase,
      amountMinor: 9_000_000,
    });
    expect(result.kind).toBe('DECLINED');
    if (result.kind !== 'DECLINED') return;
    expect(result.reason).toBe('LIMIT_EXCEEDED');
  });
});
