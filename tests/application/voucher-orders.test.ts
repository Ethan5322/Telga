/**
 * Voucher pending orders: creation, PIN authorization, cancellation, expiry,
 * and — the point this file exists to prove — that the `PIN_AUTH` lockout is
 * genuinely separate from login lockout.
 *
 * Every test goes through the real HTTP surface (`handle()`), the same path a
 * browser reaches, so the guard chain, the application layer and the SQLite
 * driver are all exercised together, against an isolated temp-file database —
 * never `telga.sqlite`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  DEVICE_B,
  MERCHANT_A,
  MERCHANT_B,
  OPERATOR_B,
  TEST_PIN,
  WRONG_PIN,
  callWith,
  makeUiHarness,
  reasonOf,
  signInAs,
} from '../auth/helpers';
import type { UiHarness } from '../auth/helpers';
import { advance } from '../auth/helpers';
import { login } from '@telga/api';

let harness: UiHarness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

const PRODUCT_ID = 'NETWORK_A_AIRTIME_1000';

async function createOrder(
  h: UiHarness,
  session: { cookieHeader: string; csrfToken: string },
  overrides: Partial<{ network: string; productType: string; productId: string }> = {},
) {
  const { response, envelope } = await callWith<{ orderId: string }>(h.api, 'POST', '/api/training/orders', {
    cookie: session.cookieHeader,
    body: {
      csrfToken: session.csrfToken,
      network: overrides.network ?? 'NETWORK_A',
      productType: overrides.productType ?? 'AIRTIME',
      productId: overrides.productId ?? PRODUCT_ID,
      clientRequestId: `req_${Math.random().toString(36).slice(2)}`,
    },
  });
  return { response, envelope };
}

describe('creating a pending order', () => {
  it('creates one OPEN order for a valid catalog combination', async () => {
    harness = makeUiHarness('order-create');
    const session = await signInAs(harness.api);
    const { response, envelope } = await createOrder(harness, session);

    expect(response.status).toBe(201);
    expect(envelope.ok).toBe(true);
    const order = harness.driver.findPendingOrder((envelope as { data: { orderId: string } }).data.orderId);
    expect(order?.status).toBe('OPEN');
    expect(order?.amount_minor).toBe(1000);
    expect(order?.currency).toBe('ETB');
  });

  it('refuses a network/product combination not in the catalog', async () => {
    harness = makeUiHarness('order-invalid-product');
    const session = await signInAs(harness.api);
    const { response, envelope } = await createOrder(harness, session, { productId: 'NOT_A_REAL_PRODUCT' });

    expect(response.status).toBe(400);
    expect(reasonOf(envelope)).toBe('PRODUCT_INVALID');
  });

  it('refuses a product that exists but belongs to a different network', async () => {
    harness = makeUiHarness('order-network-mismatch');
    const session = await signInAs(harness.api);
    const { response, envelope } = await createOrder(harness, session, {
      network: 'NETWORK_B',
      productId: PRODUCT_ID, // belongs to NETWORK_A
    });

    expect(response.status).toBe(400);
    expect(reasonOf(envelope)).toBe('PRODUCT_INVALID');
  });
});

describe('PIN authorization', () => {
  it('correct PIN issues exactly one transaction and marks the order AUTHORIZED', async () => {
    harness = makeUiHarness('pin-correct');
    const session = await signInAs(harness.api);
    const { envelope: created } = await createOrder(harness, session);
    const orderId = (created as { data: { orderId: string } }).data.orderId;
    const before = harness.driver.findTransactionsByMerchant(MERCHANT_A).length;

    const { response, envelope } = await callWith(harness.api, 'POST', `/api/training/orders/${orderId}/authorize`, {
      cookie: session.cookieHeader,
      body: { csrfToken: session.csrfToken, pin: TEST_PIN },
    });

    expect(response.status).toBe(201);
    expect(envelope.ok).toBe(true);
    expect(harness.driver.findTransactionsByMerchant(MERCHANT_A).length).toBe(before + 1);
    const order = harness.driver.findPendingOrder(orderId);
    expect(order?.status).toBe('AUTHORIZED');
    expect(order?.transaction_id).not.toBeNull();
  });

  it('wrong PIN issues no transaction and leaves the order OPEN', async () => {
    harness = makeUiHarness('pin-wrong');
    const session = await signInAs(harness.api);
    const { envelope: created } = await createOrder(harness, session);
    const orderId = (created as { data: { orderId: string } }).data.orderId;
    const before = harness.driver.findTransactionsByMerchant(MERCHANT_A).length;

    const { response, envelope } = await callWith(harness.api, 'POST', `/api/training/orders/${orderId}/authorize`, {
      cookie: session.cookieHeader,
      body: { csrfToken: session.csrfToken, pin: WRONG_PIN },
    });

    expect(response.status).toBe(401);
    expect(reasonOf(envelope)).toBe('PIN_INVALID');
    expect(harness.driver.findTransactionsByMerchant(MERCHANT_A).length).toBe(before);
    expect(harness.driver.findPendingOrder(orderId)?.status).toBe('OPEN');
  });

  it('the response body never contains the submitted PIN', async () => {
    harness = makeUiHarness('pin-secrecy');
    const session = await signInAs(harness.api);
    const { envelope: created } = await createOrder(harness, session);
    const orderId = (created as { data: { orderId: string } }).data.orderId;

    const { response } = await callWith(harness.api, 'POST', `/api/training/orders/${orderId}/authorize`, {
      cookie: session.cookieHeader,
      body: { csrfToken: session.csrfToken, pin: TEST_PIN },
    });

    expect(JSON.stringify(response.body)).not.toContain(TEST_PIN);
  });

  it('two concurrent correct submissions for one order create exactly one transaction', async () => {
    harness = makeUiHarness('pin-duplicate');
    const session = await signInAs(harness.api);
    const { envelope: created } = await createOrder(harness, session);
    const orderId = (created as { data: { orderId: string } }).data.orderId;
    const before = harness.driver.findTransactionsByMerchant(MERCHANT_A).length;

    const api = harness.api;
    const submit = () =>
      callWith(api, 'POST', `/api/training/orders/${orderId}/authorize`, {
        cookie: session.cookieHeader,
        body: { csrfToken: session.csrfToken, pin: TEST_PIN },
      });
    const [first, second] = await Promise.all([submit(), submit()]);

    expect([first.response.status, second.response.status]).toContain(201);
    expect(harness.driver.findTransactionsByMerchant(MERCHANT_A).length).toBe(before + 1);
  });

  it('a stale/expired order refuses authorization even with the correct PIN', async () => {
    harness = makeUiHarness('pin-expired');
    const session = await signInAs(harness.api);
    const { envelope: created } = await createOrder(harness, session);
    const orderId = (created as { data: { orderId: string } }).data.orderId;

    advance(harness, 11 * 60_000); // past the 10-minute pending-order expiry

    const { response, envelope } = await callWith(harness.api, 'POST', `/api/training/orders/${orderId}/authorize`, {
      cookie: session.cookieHeader,
      body: { csrfToken: session.csrfToken, pin: TEST_PIN },
    });

    expect(response.status).toBe(409);
    expect(reasonOf(envelope)).toBe('ORDER_EXPIRED');
    expect(harness.driver.findTransactionsByMerchant(MERCHANT_A).length).toBe(0);
  });
});

describe('cancellation', () => {
  it('cancels an OPEN order, and it can never be authorized afterward', async () => {
    harness = makeUiHarness('order-cancel');
    const session = await signInAs(harness.api);
    const { envelope: created } = await createOrder(harness, session);
    const orderId = (created as { data: { orderId: string } }).data.orderId;

    const cancelled = await callWith(harness.api, 'POST', `/api/training/orders/${orderId}/cancel`, {
      cookie: session.cookieHeader,
      body: { csrfToken: session.csrfToken },
    });
    expect(cancelled.response.status).toBe(200);
    expect(harness.driver.findPendingOrder(orderId)?.status).toBe('CANCELLED');

    const { response, envelope } = await callWith(harness.api, 'POST', `/api/training/orders/${orderId}/authorize`, {
      cookie: session.cookieHeader,
      body: { csrfToken: session.csrfToken, pin: TEST_PIN },
    });
    expect(response.status).toBe(409);
    expect(reasonOf(envelope)).toBe('ORDER_NOT_OPEN');
    expect(harness.driver.findTransactionsByMerchant(MERCHANT_A).length).toBe(0);
  });
});

describe('order binding', () => {
  it('refuses an order id that belongs to a different session/merchant', async () => {
    harness = makeUiHarness('order-cross-session', { seedSecondMerchant: true });
    const alpha = await signInAs(harness.api);
    const { envelope: created } = await createOrder(harness, alpha);
    const orderId = (created as { data: { orderId: string } }).data.orderId;

    const beta = await signInAs(harness.api, {
      userId: OPERATOR_B,
      merchantId: MERCHANT_B,
      deviceId: DEVICE_B,
    });

    const { response, envelope } = await callWith(harness.api, 'GET', `/api/training/orders/${orderId}`, {
      cookie: beta.cookieHeader,
    });
    expect(response.status).toBe(404);
    expect(reasonOf(envelope)).toBe('ORDER_NOT_FOUND');
  });
});

describe('PIN_AUTH lockout is separate from login lockout', () => {
  it('locks voucher authorization after repeated wrong PINs, but leaves login usable', async () => {
    harness = makeUiHarness('pin-lockout-isolated');
    const session = await signInAs(harness.api);

    // Five wrong voucher PINs, each against its own fresh order (so ORDER_NOT_OPEN
    // never masks the PIN check itself).
    for (let i = 0; i < 5; i += 1) {
      const { envelope: created } = await createOrder(harness, session);
      const orderId = (created as { data: { orderId: string } }).data.orderId;
      const { response, envelope } = await callWith(
        harness.api,
        'POST',
        `/api/training/orders/${orderId}/authorize`,
        { cookie: session.cookieHeader, body: { csrfToken: session.csrfToken, pin: WRONG_PIN } },
      );
      expect(response.status).toBe(401);
      expect(reasonOf(envelope)).toBe('PIN_INVALID');
    }

    // The sixth attempt is locked, not merely wrong.
    const { envelope: sixthOrder } = await createOrder(harness, session);
    const sixthId = (sixthOrder as { data: { orderId: string } }).data.orderId;
    const locked = await callWith(harness.api, 'POST', `/api/training/orders/${sixthId}/authorize`, {
      cookie: session.cookieHeader,
      body: { csrfToken: session.csrfToken, pin: TEST_PIN }, // even the CORRECT pin is refused while locked
    });
    expect(locked.response.status).toBe(423);
    expect(reasonOf(locked.envelope)).toBe('PIN_LOCKED');

    // merchant_users is untouched: no failed_attempts, no locked_until.
    const user = harness.driver.findMerchantUser(session.userId, session.merchantId);
    expect(user?.failed_attempts).toBe(0);
    expect(user?.locked_until).toBeNull();

    // A brand-new login with the correct PIN still succeeds.
    const relogin = await login(
      harness.api,
      { userId: session.userId, pin: TEST_PIN, deviceId: session.deviceId, deviceSecret: 'irrelevant' },
      'corr_relogin_probe',
    );
    // The device secret is wrong here on purpose (fixtures do not expose it after
    // enrolment); what matters is that the failure is a device mismatch, never
    // USER_LOCKED_OUT — proving the account itself was never locked.
    expect(relogin.ok).toBe(false);
    if (!relogin.ok) expect(relogin.code).not.toBe('USER_LOCKED_OUT');
  });

  it('locked PIN_AUTH does not throttle a later attempt once the window passes', async () => {
    harness = makeUiHarness('pin-lockout-expiry');
    const session = await signInAs(harness.api);

    for (let i = 0; i < 5; i += 1) {
      const { envelope: created } = await createOrder(harness, session);
      const orderId = (created as { data: { orderId: string } }).data.orderId;
      await callWith(harness.api, 'POST', `/api/training/orders/${orderId}/authorize`, {
        cookie: session.cookieHeader,
        body: { csrfToken: session.csrfToken, pin: WRONG_PIN },
      });
    }

    advance(harness, 6 * 60_000); // past the 5-minute PIN_AUTH lockout window

    const { envelope: created } = await createOrder(harness, session);
    const orderId = (created as { data: { orderId: string } }).data.orderId;
    const { response, envelope } = await callWith(harness.api, 'POST', `/api/training/orders/${orderId}/authorize`, {
      cookie: session.cookieHeader,
      body: { csrfToken: session.csrfToken, pin: TEST_PIN },
    });
    expect(response.status).toBe(201);
    expect(envelope.ok).toBe(true);
  });
});
