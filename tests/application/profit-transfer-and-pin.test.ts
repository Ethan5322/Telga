/**
 * Moving profit into the selling balance, and changing a transaction PIN.
 *
 * The assertions that matter most are the refusals: an owner must not be able
 * to move more profit than they earned, and a PIN must not be changeable from
 * an open session alone.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { changePin, newPinRejection } from '@telga/api';
import { authenticate } from '@telga/api';
import {
  MERCHANT_A,
  OWNER_USER,
  TEST_PIN,
  callWith,
  makeUiHarness,
  signInAs,
} from '../auth/helpers';
import type { UiHarness } from '../auth/helpers';

let harness: UiHarness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

/** Sell `quantity` × 25 birr so the merchant has profit to move. */
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

describe('moving profit into the selling balance', () => {
  it('moves the money and leaves the ledger balanced', async () => {
    harness = makeUiHarness('profit-move', { fundBirr: 900 });
    await earnProfit(harness, 4, 'req_earn'); // 4 × 25 birr at 4% = 4 birr profit

    const before = harness.deps.driver.balanceFor(MERCHANT_A).available.minor;
    expect(harness.deps.driver.profitAvailableMinor(MERCHANT_A)).toBe(400);

    const owner = await asOwner(harness);
    const { response, envelope } = await callWith<{
      amountMinor: number;
      profitRemainingMinor: number;
      availableAfterMinor: number;
    }>(harness.api, 'POST', '/api/training/profit/transfers', {
      cookie: owner.cookieHeader,
      body: { csrfToken: owner.csrfToken, amountBirr: 3 },
    });

    expect(response.status).toBe(200);
    if (!envelope.ok) throw new Error('expected the transfer to succeed');
    expect(envelope.data.amountMinor).toBe(300);
    expect(envelope.data.profitRemainingMinor).toBe(100);

    // A move, not an increase: the balance goes up by exactly what the profit
    // went down by, and double entry still holds across the whole ledger.
    expect(harness.deps.driver.balanceFor(MERCHANT_A).available.minor).toBe(before + 300);
    expect(harness.deps.driver.profitAvailableMinor(MERCHANT_A)).toBe(100);
    expect(harness.deps.driver.ledgerResidualMinor()).toBe(0);
  });

  it('refuses more than the profit earned, and moves nothing', async () => {
    harness = makeUiHarness('profit-over', { fundBirr: 900 });
    await earnProfit(harness, 4, 'req_earn');
    const before = harness.deps.driver.balanceFor(MERCHANT_A).available.minor;

    const owner = await asOwner(harness);
    const { response, envelope } = await callWith(
      harness.api,
      'POST',
      '/api/training/profit/transfers',
      { cookie: owner.cookieHeader, body: { csrfToken: owner.csrfToken, amountBirr: 99 } },
    );

    expect(response.status).toBe(400);
    if (envelope.ok) throw new Error('expected a refusal');
    // The refusal carries the figure, so the screen can say what *is* movable.
    expect(envelope.error.reasonCode).toBe('EXCEEDS_PROFIT:400');
    expect(harness.deps.driver.balanceFor(MERCHANT_A).available.minor).toBe(before);
    expect(harness.deps.driver.profitAvailableMinor(MERCHANT_A)).toBe(400);
  });

  it('lets an owner move the whole profit, but nothing beyond it', async () => {
    harness = makeUiHarness('profit-exact', { fundBirr: 900 });
    await earnProfit(harness, 4, 'req_earn');
    const owner = await asOwner(harness);

    const exact = await callWith(harness.api, 'POST', '/api/training/profit/transfers', {
      cookie: owner.cookieHeader,
      body: { csrfToken: owner.csrfToken, amountBirr: 4 },
    });
    expect(exact.response.status, 'the full profit is movable').toBe(200);
    expect(harness.deps.driver.profitAvailableMinor(MERCHANT_A)).toBe(0);

    const again = await callWith(harness.api, 'POST', '/api/training/profit/transfers', {
      cookie: owner.cookieHeader,
      body: { csrfToken: owner.csrfToken, amountBirr: 1 },
    });
    expect(again.response.status, 'and there is nothing left to move twice').toBe(400);
  });

  it('is owner-only — an operator cannot move the shop’s profit', async () => {
    harness = makeUiHarness('profit-operator', { fundBirr: 900 });
    await earnProfit(harness, 4, 'req_earn');
    const operator = await signInAs(harness.api);

    const { response } = await callWith(harness.api, 'POST', '/api/training/profit/transfers', {
      cookie: operator.cookieHeader,
      body: { csrfToken: operator.csrfToken, amountBirr: 1 },
    });
    expect(response.status).toBe(403);
    expect(harness.deps.driver.profitAvailableMinor(MERCHANT_A)).toBe(400);
  });

  it('records an audit event naming the actor', async () => {
    harness = makeUiHarness('profit-audit', { fundBirr: 900 });
    await earnProfit(harness, 4, 'req_earn');
    const owner = await asOwner(harness);
    await callWith(harness.api, 'POST', '/api/training/profit/transfers', {
      cookie: owner.cookieHeader,
      body: { csrfToken: owner.csrfToken, amountBirr: 2 },
    });

    const events = harness.deps.driver.readAuditEvents(MERCHANT_A);
    const transfer = events.filter((e) => e.event_type === 'PROFIT_TRANSFERRED_TO_BALANCE');
    expect(transfer).toHaveLength(1);
    expect(transfer[0]?.actor_id).toBe(OWNER_USER);
  });
});

describe('changing a transaction PIN', () => {
  it('accepts the new PIN and authorizes a later sale with it', async () => {
    harness = makeUiHarness('pin-change', { fundBirr: 900 });
    const owner = await asOwner(harness);

    const changed = await callWith(harness.api, 'POST', '/api/training/operators/pin', {
      cookie: owner.cookieHeader,
      body: { csrfToken: owner.csrfToken, currentPin: TEST_PIN, newPin: '482913' },
    });
    expect(changed.response.status).toBe(200);

    // The new PIN is what now works — proven through the real sale path.
    const order = await callWith<{ orderId: string }>(harness.api, 'POST', '/api/training/orders', {
      cookie: owner.cookieHeader,
      body: {
        csrfToken: owner.csrfToken,
        network: 'NETWORK_A',
        productType: 'AIRTIME',
        productId: 'NETWORK_A_AIRTIME_2500',
        clientRequestId: 'req_after_pin',
      },
    });
    if (!order.envelope.ok) throw new Error('expected an order');
    const authorized = await callWith(
      harness.api,
      'POST',
      `/api/training/orders/${order.envelope.data.orderId}/authorize`,
      { cookie: owner.cookieHeader, body: { csrfToken: owner.csrfToken, pin: '482913' } },
    );
    // 200 or 201 — the sale succeeded either way; what this test is proving
    // is that the *new* PIN is the one that authorizes it.
    expect([200, 201]).toContain(authorized.response.status);
  });

  it('refuses without the current PIN, so an open session is not enough', async () => {
    harness = makeUiHarness('pin-needs-current');
    const owner = await asOwner(harness);
    const { response, envelope } = await callWith(
      harness.api,
      'POST',
      '/api/training/operators/pin',
      {
        cookie: owner.cookieHeader,
        body: { csrfToken: owner.csrfToken, currentPin: '000000', newPin: '482913' },
      },
    );
    expect(response.status).toBe(400);
    if (envelope.ok) throw new Error('expected a refusal');
    expect(envelope.error.reasonCode).toBe('CURRENT_PIN_WRONG');
  });

  it('never stores or returns the PIN itself', async () => {
    harness = makeUiHarness('pin-not-stored');
    const owner = await asOwner(harness);
    const result = await callWith(harness.api, 'POST', '/api/training/operators/pin', {
      cookie: owner.cookieHeader,
      body: { csrfToken: owner.csrfToken, currentPin: TEST_PIN, newPin: '482913' },
    });

    expect(JSON.stringify(result.envelope)).not.toContain('482913');
    for (const event of harness.deps.driver.readAuditEvents(MERCHANT_A)) {
      expect(JSON.stringify(event)).not.toContain('482913');
    }
    // Stored only as a derived key — the PIN itself appears nowhere.
    const user = harness.deps.driver.findMerchantUser(OWNER_USER, MERCHANT_A);
    expect(user?.pin_hash).not.toContain('482913');
  });

  it('is owner-only', async () => {
    harness = makeUiHarness('pin-owner-only');
    const operator = await signInAs(harness.api);
    const { response } = await callWith(harness.api, 'POST', '/api/training/operators/pin', {
      cookie: operator.cookieHeader,
      body: { csrfToken: operator.csrfToken, currentPin: TEST_PIN, newPin: '482913' },
    });
    expect(response.status).toBe(403);
  });

  it('refuses a guessable or unchanged PIN', () => {
    expect(newPinRejection('123456', '111111')).toBe('TOO_SIMPLE');
    expect(newPinRejection('654321', '111111')).toBe('TOO_SIMPLE');
    expect(newPinRejection('111111', '222222')).toBe('TOO_SIMPLE');
    expect(newPinRejection('482913', '482913')).toBe('NOT_DIFFERENT');
    expect(newPinRejection('4829', '111111')).toBe('WRONG_LENGTH');
    expect(newPinRejection('48a913', '111111')).toBe('NOT_DIGITS');
    expect(newPinRejection('482913', '111111')).toBeUndefined();
  });

  it('records a wrong current PIN as a PIN_AUTH failure, not a login failure', async () => {
    harness = makeUiHarness('pin-failure-scope');
    const owner = await asOwner(harness);
    const auth = authenticate(harness.api, owner.sessionToken, 'corr_pin');
    if (!auth.ok) throw new Error('no session');

    await changePin(harness.api, auth.context, {
      currentPin: '000000',
      newPin: '482913',
      correlationId: 'corr_pin',
    });

    // A failed PIN change must never contribute to a *login* lockout.
    const user = harness.deps.driver.findMerchantUser(OWNER_USER, MERCHANT_A);
    expect(user?.failed_attempts).toBe(0);
    expect(user?.locked_until).toBeNull();
  });
});
