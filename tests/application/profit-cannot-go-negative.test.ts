/**
 * Profit can never be moved below zero — reported from the counter, 2026-08-29.
 *
 * The report: *"when i want to deposit profit it allow more than existing
 * profit and make it negative and later on it allow more to transfer."*
 *
 * `profit-transfer-and-pin.test.ts` already proves a single over-sized request
 * is refused. So if the report is real, the hole is somewhere those tests do
 * not look: repeated transfers, fractional birr, or an amount that is not the
 * plain integer the existing tests always send.
 *
 * These tests are written to **find** it rather than to confirm the code. Each
 * one ends with the same two invariants, because those are what a shop owner
 * actually cares about:
 *
 *   - profit is never negative;
 *   - the whole ledger still balances (CLAUDE.md §13.2).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MERCHANT_A, OWNER_USER, TEST_PIN, callWith, makeUiHarness, signInAs } from '../auth/helpers';
import type { UiHarness } from '../auth/helpers';

let harness: UiHarness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

async function earnProfit(h: UiHarness, quantity: number, requestId: string): Promise<void> {
  const session = await signInAs(h.api);
  const order = await callWith<{ orderId: string }>(h.api, 'POST', '/api/training/orders', {
    cookie: session.cookieHeader,
    body: {
      csrfToken: session.csrfToken,
      network: 'NETWORK_A',
      productType: 'AIRTIME',
      productId: 'NETWORK_A_AIRTIME_2500',
      quantity,
      clientRequestId: requestId,
    },
  });
  if (!order.envelope.ok) throw new Error('fixture could not create the order');
  await callWith(h.api, 'POST', `/api/training/orders/${order.envelope.data.orderId}/authorize`, {
    cookie: session.cookieHeader,
    body: { csrfToken: session.csrfToken, pin: TEST_PIN },
  });
}

const asOwner = (h: UiHarness) => signInAs(h.api, { userId: OWNER_USER, role: 'MERCHANT_OWNER' });

/** Ask to move `amountBirr`, whatever type the form would actually send. */
async function move(
  h: UiHarness,
  cookie: string,
  csrfToken: string,
  amountBirr: unknown,
): Promise<{ ok: boolean; reason: string }> {
  const { envelope } = await callWith(h.api, 'POST', '/api/training/profit/transfers', {
    cookie,
    body: { csrfToken, amountBirr },
  });
  return envelope.ok
    ? { ok: true, reason: '' }
    : { ok: false, reason: (envelope as { error: { reasonCode: string } }).error.reasonCode };
}

/** The two things that must hold after any sequence of transfers. */
function assertSound(h: UiHarness): void {
  expect(h.deps.driver.profitAvailableMinor(MERCHANT_A), 'profit must never go negative').toBeGreaterThanOrEqual(0);
  expect(h.deps.driver.ledgerResidualMinor(), 'the ledger must still balance').toBe(0);
}

describe('repeated transfers', () => {
  it('cannot drain more than was earned, however many times it is asked', async () => {
    // The exact shape of the report: move, then move again, then again.
    harness = makeUiHarness('profit-repeat', { fundBirr: 900 });
    await earnProfit(harness, 4, 'req_earn'); // 4 birr of profit
    const owner = await asOwner(harness);
    expect(harness.deps.driver.profitAvailableMinor(MERCHANT_A)).toBe(400);

    const first = await move(harness, owner.cookieHeader, owner.csrfToken, 4);
    expect(first.ok).toBe(true);
    expect(harness.deps.driver.profitAvailableMinor(MERCHANT_A)).toBe(0);

    // Nothing is left. Every further attempt must be refused.
    for (const attempt of [1, 2, 4]) {
      const again = await move(harness, owner.cookieHeader, owner.csrfToken, attempt);
      expect(again.ok, `moving ${attempt} birr from an empty profit must be refused`).toBe(false);
      expect(again.reason).toContain('EXCEEDS_PROFIT');
    }
    assertSound(harness);
  });

  it('cannot be walked below zero one birr at a time', async () => {
    harness = makeUiHarness('profit-walk', { fundBirr: 900 });
    await earnProfit(harness, 4, 'req_earn');
    const owner = await asOwner(harness);

    // Six attempts at 1 birr against 4 birr of profit: four succeed, two fail.
    let moved = 0;
    for (let i = 0; i < 6; i += 1) {
      const result = await move(harness, owner.cookieHeader, owner.csrfToken, 1);
      if (result.ok) moved += 1;
      assertSound(harness);
    }
    expect(moved).toBe(4);
    expect(harness.deps.driver.profitAvailableMinor(MERCHANT_A)).toBe(0);
  });
});

describe('amounts that are not plain whole birr', () => {
  it('refuses a fraction that would round above the profit', async () => {
    // 4.005 birr rounds to 401 minor against 400 available. Rounding must not
    // be a way to take one more unit than was earned.
    harness = makeUiHarness('profit-fraction', { fundBirr: 900 });
    await earnProfit(harness, 4, 'req_earn');
    const owner = await asOwner(harness);

    const result = await move(harness, owner.cookieHeader, owner.csrfToken, 4.005);
    expect(result.ok).toBe(false);
    assertSound(harness);
  });

  it('refuses a negative amount rather than crediting profit', async () => {
    // A negative transfer would run the posting backwards: profit *up*,
    // balance *down*. It must be refused, not inverted.
    harness = makeUiHarness('profit-negative', { fundBirr: 900 });
    await earnProfit(harness, 4, 'req_earn');
    const owner = await asOwner(harness);
    const before = harness.deps.driver.balanceFor(MERCHANT_A).available.minor;

    for (const amount of [-1, -100, -0.5]) {
      const result = await move(harness, owner.cookieHeader, owner.csrfToken, amount);
      expect(result.ok, `${amount} must be refused`).toBe(false);
    }
    expect(harness.deps.driver.balanceFor(MERCHANT_A).available.minor).toBe(before);
    expect(harness.deps.driver.profitAvailableMinor(MERCHANT_A)).toBe(400);
    assertSound(harness);
  });

  it('refuses values that are not numbers at all', async () => {
    harness = makeUiHarness('profit-nonsense', { fundBirr: 900 });
    await earnProfit(harness, 4, 'req_earn');
    const owner = await asOwner(harness);

    // `'1,200'` is what a formatted figure looks like if it is ever fed back
    // into the form; `Infinity` and `''` are what a broken client sends.
    for (const amount of ['1,200', 'abc', '', null, Infinity, NaN, '4e3']) {
      const result = await move(harness, owner.cookieHeader, owner.csrfToken, amount);
      expect(result.ok, `${String(amount)} must be refused`).toBe(false);
    }
    expect(harness.deps.driver.profitAvailableMinor(MERCHANT_A)).toBe(400);
    assertSound(harness);
  });

  it('refuses an amount so large it would overflow safe integers', async () => {
    harness = makeUiHarness('profit-huge', { fundBirr: 900 });
    await earnProfit(harness, 4, 'req_earn');
    const owner = await asOwner(harness);

    for (const amount of [Number.MAX_SAFE_INTEGER, 1e15, 9e18]) {
      const result = await move(harness, owner.cookieHeader, owner.csrfToken, amount);
      expect(result.ok, `${String(amount)} must be refused`).toBe(false);
    }
    assertSound(harness);
  });
});

describe('the exact boundary', () => {
  it('allows exactly the profit and not one minor unit more', async () => {
    harness = makeUiHarness('profit-boundary', { fundBirr: 900 });
    await earnProfit(harness, 4, 'req_earn');
    const owner = await asOwner(harness);

    // One unit over, first — so a refusal cannot be mistaken for "already empty".
    const over = await move(harness, owner.cookieHeader, owner.csrfToken, 4.01);
    expect(over.ok).toBe(false);
    expect(harness.deps.driver.profitAvailableMinor(MERCHANT_A)).toBe(400);

    const exact = await move(harness, owner.cookieHeader, owner.csrfToken, 4);
    expect(exact.ok).toBe(true);
    expect(harness.deps.driver.profitAvailableMinor(MERCHANT_A)).toBe(0);
    assertSound(harness);
  });
});
