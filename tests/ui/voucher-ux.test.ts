/**
 * The airtime / voucher operator experience.
 *
 * These defend the three defects an operator actually hit:
 *
 *   1. A **correct** PIN was re-requested because a business-rule refusal
 *      (insufficient training balance) redirected back to the PIN screen.
 *   2. The dashboard's Airtime tile opened the legacy `/sell` form, whose
 *      recipient field read "Confirm number".
 *   3. `/sell`'s amount control pre-selected the first denomination, so an
 *      operator who never touched it still submitted an amount.
 *
 * The balance case is exercised **on purpose** against a merchant with no
 * float: that is the exact condition that produced the loop, so a fixture
 * that funded the merchant would test everything except the bug.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_BEHAVIOURS } from '@telga/provider-mock-airtime';
import { authenticate } from '@telga/api';
import { renderScreen } from '@telga/merchant-pos';
import type { PosServerOptions } from '@telga/merchant-pos';
import { DASHBOARD_SERVICES } from '@telga/merchant-pos';
import {
  MERCHANT_A,
  TEST_PIN,
  WRONG_PIN,
  callWith,
  makeUiHarness,
  reasonOf,
  signInAs,
} from '../auth/helpers';
import type { TestSession, UiHarness } from '../auth/helpers';
import { TEST_VOUCHER_CATALOG, TEST_VOUCHER_NETWORKS } from './helpers';

let harness: UiHarness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

const PRODUCT_ID = 'NETWORK_A_AIRTIME_2500';

function optionsFor(h: UiHarness): PosServerOptions {
  return {
    api: h.api,
    environment: 'test',
    catalog: [
      { productId: 'AIRTIME', label: 'Airtime 25 (simulated)', amountMinor: 2500, available: true },
      { productId: 'AIRTIME_10', label: 'Airtime 10 (simulated)', amountMinor: 1000, available: true },
    ],
    // `TEST_VOUCHER_CATALOG` is the API-shaped entry (no label); the screens
    // need the display label too.
    voucherCatalog: TEST_VOUCHER_CATALOG.map((p) => ({
      ...p,
      label: `${p.network} — Airtime ${p.amountMinor / 100} (simulated)`,
    })),
    voucherNetworks: [...TEST_VOUCHER_NETWORKS],
    simulatedBehaviours: [...MOCK_BEHAVIOURS],
  };
}

const q = (extra: Record<string, string> = {}): URLSearchParams => new URLSearchParams(extra);

async function contextOf(h: UiHarness, session: TestSession) {
  const result = authenticate(h.api, session.sessionToken, 'corr_voucher_ux');
  if (!result.ok) throw new Error(`Fixture session refused: ${result.code}`);
  return result.context;
}

async function screenFor(
  h: UiHarness,
  path: string,
  query: URLSearchParams = q(),
  session?: TestSession,
): Promise<{ status: number; html: string } | undefined> {
  const s = session ?? (await signInAs(h.api));
  return renderScreen(optionsFor(h), {
    path,
    query,
    context: await contextOf(h, s),
    cookieHeader: s.cookieHeader,
    csrfToken: s.csrfToken,
  });
}

/** Create an OPEN order through the real API and return its id. */
async function openOrder(h: UiHarness, session: TestSession): Promise<string> {
  const { envelope } = await callWith<{ orderId: string }>(h.api, 'POST', '/api/training/orders', {
    cookie: session.cookieHeader,
    body: {
      csrfToken: session.csrfToken,
      network: 'NETWORK_A',
      productType: 'AIRTIME',
      productId: PRODUCT_ID,
      clientRequestId: `req_${Math.random().toString(36).slice(2)}`,
    },
  });
  if (!envelope.ok) throw new Error('fixture could not create an order');
  return (envelope as { data: { orderId: string } }).data.orderId;
}

const txCount = (h: UiHarness): number => h.driver.findTransactionsByMerchant(MERCHANT_A).length;

// --- 1-3: routing and the legacy /sell form ---------------------------------

describe('flow separation', () => {
  it('the dashboard Airtime tile opens the voucher sequence, not /sell', () => {
    const airtime = DASHBOARD_SERVICES.find((s) => s.id === 'airtime');
    expect(airtime?.href).toBe('/vouchers/airtime');
    expect(airtime?.href).not.toBe('/sell');
  });

  it('/sell stays reachable and is labelled as a customer-cellphone flow', async () => {
    harness = makeUiHarness('sell-label');
    const screen = await screenFor(harness, '/sell');
    expect(screen?.status).toBe(200);
    expect(screen?.html).toContain('Customer cellphone number');
    expect(screen?.html).not.toContain('Confirm number');
  });

  it('/sell pre-selects no amount', async () => {
    harness = makeUiHarness('sell-placeholder');
    const screen = await screenFor(harness, '/sell');
    const html = screen?.html ?? '';
    expect(html).toContain('Select airtime amount');
    // The placeholder is the selected option, so no real product is.
    expect(/<option value=""[^>]*selected/.test(html) || /<option value=""[^>]*disabled/.test(html)).toBe(true);
    expect(html).not.toMatch(/<option value="AIRTIME_10"[^>]*selected/);
  });
});

// --- 4: voucher amount selection --------------------------------------------

describe('voucher amount selection', () => {
  it('offers denomination cards with none pre-selected', async () => {
    harness = makeUiHarness('amount-cards');
    const screen = await screenFor(harness, '/vouchers/airtime/NETWORK_A/AIRTIME');
    const html = screen?.html ?? '';
    expect(html).toContain('data-testid="amount-cards"');
    expect(html).toContain(`data-testid="amount-radio-${PRODUCT_ID}"`);
    // `required` on every radio is what blocks submission until one is chosen.
    expect(html).toMatch(/type="radio"[^>]*required/);
    // No radio carries `checked`. Scoped to the inputs themselves: the
    // stylesheet legitimately contains `:checked`, so a document-wide
    // substring check would pass or fail for the wrong reason.
    for (const input of html.match(/<input[^>]*type="radio"[^>]*>/g) ?? []) {
      expect(input).not.toMatch(/\bchecked\b/);
    }
  });

  it('shows the chosen amount on the order-details screen', async () => {
    harness = makeUiHarness('amount-in-order');
    const session = await signInAs(harness.api);
    const orderId = await openOrder(harness, session);
    const screen = await screenFor(harness, `/orders/${orderId}`, q(), session);
    expect(screen?.html).toContain('25.00');
  });

  it('never shows Confirm number anywhere in the voucher flow', async () => {
    harness = makeUiHarness('voucher-no-confirm-number');
    const session = await signInAs(harness.api);
    const orderId = await openOrder(harness, session);
    for (const path of [
      '/vouchers',
      '/vouchers/airtime',
      '/vouchers/airtime/NETWORK_A',
      '/vouchers/airtime/NETWORK_A/AIRTIME',
      `/orders/${orderId}`,
      `/orders/${orderId}/authorize`,
    ]) {
      const screen = await screenFor(harness, path, q(), session);
      expect(screen?.html, path).not.toContain('Confirm number');
      expect(screen?.html, path).not.toMatch(/name="recipient"/);
    }
  });
});

// --- custom amount -----------------------------------------------------------

describe('custom amount', () => {
  const CUSTOM_ID = 'NETWORK_A_AIRTIME_CUSTOM';

  async function createCustom(h: UiHarness, session: TestSession, birr: unknown) {
    return callWith<{ orderId: string }>(h.api, 'POST', '/api/training/orders', {
      cookie: session.cookieHeader,
      body: {
        csrfToken: session.csrfToken,
        network: 'NETWORK_A',
        productType: 'AIRTIME',
        productId: CUSTOM_ID,
        clientRequestId: `req_${String(Math.random()).slice(2)}`,
        customAmountMinor: birr,
      },
    });
  }

  it('renders fixed denominations in a horizontal row plus a custom entry', async () => {
    harness = makeUiHarness('custom-render');
    const screen = await screenFor(harness, '/vouchers/airtime/NETWORK_A/AIRTIME');
    const html = screen?.html ?? '';
    expect(html).toContain('voucher__amounts-row');
    expect(html).toContain('data-testid="custom-amount"');
    expect(html).toContain('data-testid="amount-radio-custom"');
    expect(html).toContain('data-testid="custom-amount-input"');
    // The typed field is bounded in the markup as a convenience...
    expect(html).toMatch(/min="5"/);
    expect(html).toMatch(/max="1000"/);
    // ...and no amount is pre-selected.
    for (const input of html.match(/<input[^>]*type="radio"[^>]*>/g) ?? []) {
      expect(input).not.toMatch(/\bchecked\b/);
    }
  });

  it('accepts a valid typed amount and stores exactly it', async () => {
    harness = makeUiHarness('custom-accepted', { fundBirr: 1000 });
    const session = await signInAs(harness.api);
    const { response, envelope } = await createCustom(harness, session, 7500);

    expect(response.status).toBe(201);
    if (envelope.ok) {
      const order = harness.driver.findPendingOrder(envelope.data.orderId);
      expect(order?.amount_minor, 'the typed amount, not the catalog placeholder').toBe(7500);
      expect(order?.total_minor).toBe(7500);
    }
  });

  it.each([
    ['below the minimum', 100, 'AMOUNT_BELOW_MINIMUM'],
    ['above the maximum', 200_000, 'AMOUNT_ABOVE_MAXIMUM'],
    ['not a whole birr', 550, 'AMOUNT_NOT_A_MULTIPLE'],
    ['zero', 0, 'AMOUNT_BELOW_MINIMUM'],
    ['negative', -5000, 'AMOUNT_BELOW_MINIMUM'],
    ['malformed', 'abc', 'AMOUNT_NOT_A_NUMBER'],
  ])('refuses an amount %s, creating nothing', async (_label, value, expected) => {
    harness = makeUiHarness('custom-rejected', { fundBirr: 1000 });
    const session = await signInAs(harness.api);
    const before = txCount(harness);

    const { response, envelope } = await createCustom(harness, session, value);
    expect(response.status).toBe(400);
    expect(reasonOf(envelope)).toBe(expected);
    expect(txCount(harness)).toBe(before);
    expect(harness.driver.findPendingOrder('any')).toBeUndefined();
  });

  it('refuses a typed amount above the available balance, naming the balance', async () => {
    harness = makeUiHarness('custom-unaffordable', { fundBirr: 50 });
    const session = await signInAs(harness.api);
    const { response, envelope } = await createCustom(harness, session, 20_000); // 200 birr

    expect(response.status).toBe(400);
    expect(reasonOf(envelope)).toBe('INSUFFICIENT_AVAILABLE_BALANCE:5000');
  });

  it('ignores a supplied amount on a fixed denomination, so a tampered field cannot change the price', async () => {
    harness = makeUiHarness('custom-ignored-on-fixed', { fundBirr: 1000 });
    const session = await signInAs(harness.api);

    const { response, envelope } = await callWith<{ orderId: string }>(
      harness.api,
      'POST',
      '/api/training/orders',
      {
        cookie: session.cookieHeader,
        body: {
          csrfToken: session.csrfToken,
          network: 'NETWORK_A',
          productType: 'AIRTIME',
          productId: PRODUCT_ID, // the fixed 25-birr product
          clientRequestId: 'req_tampered',
          customAmountMinor: 1, // an attempt to pay 1 santim
        },
      },
    );
    expect(response.status).toBe(201);
    if (envelope.ok) {
      expect(harness.driver.findPendingOrder(envelope.data.orderId)?.amount_minor).toBe(2500);
    }
  });
});

// --- 5-10: the PIN screen and the loop bug ----------------------------------

describe('PIN authorization', () => {
  it('PRINT opens the PIN screen, which says Confirm transaction PIN', async () => {
    harness = makeUiHarness('pin-heading');
    const session = await signInAs(harness.api);
    const orderId = await openOrder(harness, session);

    const details = await screenFor(harness, `/orders/${orderId}`, q(), session);
    expect(details?.html).toContain(`/orders/${orderId}/authorize`);

    const pin = await screenFor(harness, `/orders/${orderId}/authorize`, q(), session);
    expect(pin?.status).toBe(200);
    expect(pin?.html).toContain('Confirm transaction PIN');
  });

  it('a wrong PIN returns to the PIN screen with a translated message and creates nothing', async () => {
    harness = makeUiHarness('pin-wrong');
    const session = await signInAs(harness.api);
    const orderId = await openOrder(harness, session);
    const before = txCount(harness);

    const { response, envelope } = await callWith(harness.api, 'POST', `/api/training/orders/${orderId}/authorize`, {
      cookie: session.cookieHeader,
      body: { csrfToken: session.csrfToken, pin: WRONG_PIN },
    });
    expect(response.status).toBe(401);
    expect((envelope as { error: { reasonCode: string } }).error.reasonCode).toBe('PIN_INVALID');
    expect(txCount(harness)).toBe(before);

    const screen = await screenFor(harness, `/orders/${orderId}/authorize`, q({ error: 'PIN_INVALID' }), session);
    expect(screen?.html).toContain('Incorrect transaction PIN. No voucher was issued.');
    expect(screen?.html).not.toContain('PIN_INVALID<');
  });

  it('a correct PIN with sufficient balance reaches the result screen and creates exactly one transaction', async () => {
    // The positive counterpart to the loop bug: the funded path must land on
    // the result screen, render the success card, and never show the PIN
    // prompt again.
    harness = makeUiHarness('pin-success-funded', { fundBirr: 100 });
    const session = await signInAs(harness.api);
    const orderId = await openOrder(harness, session);
    const before = txCount(harness);

    const { response, envelope } = await callWith(harness.api, 'POST', `/api/training/orders/${orderId}/authorize`, {
      cookie: session.cookieHeader,
      body: { csrfToken: session.csrfToken, pin: TEST_PIN },
    });
    expect(response.status).toBe(201);
    expect(envelope.ok).toBe(true);
    expect(txCount(harness), 'exactly one transaction').toBe(before + 1);

    // The order now carries the transaction, and the result screen renders it.
    const screen = await screenFor(harness, `/orders/${orderId}/result`, q(), session);
    expect(screen?.status).toBe(200);
    // The card names the outcome it is actually showing. It used to be
    // `voucher-success` for every result, so this assertion passed even on a
    // pending sale — see `RESULT_CARD` in `screens.ts`.
    expect(screen?.html).toContain('data-testid="voucher-result-ok"');
    expect(screen?.html).toContain('data-certainty="CERTAIN_SUCCESS"');
    expect(screen?.html).toContain('no physical printer');
    // Never the PIN screen again.
    expect(screen?.html).not.toContain('data-testid="pin-input"');
    expect(screen?.html).not.toContain('Confirm transaction PIN');
    // And never the failure card.
    expect(screen?.html).not.toContain('data-testid="voucher-failure"');
  });

  it('refreshing the result screen does not create a second transaction', async () => {
    harness = makeUiHarness('result-refresh-safe', { fundBirr: 100 });
    const session = await signInAs(harness.api);
    const orderId = await openOrder(harness, session);

    await callWith(harness.api, 'POST', `/api/training/orders/${orderId}/authorize`, {
      cookie: session.cookieHeader,
      body: { csrfToken: session.csrfToken, pin: TEST_PIN },
    });
    const afterAuth = txCount(harness);

    // The result route is a pure read: rendering it repeatedly changes nothing.
    for (let i = 0; i < 3; i += 1) {
      const screen = await screenFor(harness, `/orders/${orderId}/result`, q(), session);
      expect(screen?.status).toBe(200);
    }
    expect(txCount(harness)).toBe(afterAuth);
  });

  it('refuses an unaffordable amount at order creation, before any PIN is asked for', async () => {
    // Insufficient balance is now caught when the order is created, so the
    // operator is told while still on the amount screen and never reaches a
    // PIN prompt they could not have completed. No order, no transaction.
    harness = makeUiHarness('insufficient-at-order', { fundBirr: 0 });
    const session = await signInAs(harness.api);
    const before = txCount(harness);

    const { response, envelope } = await callWith(harness.api, 'POST', '/api/training/orders', {
      cookie: session.cookieHeader,
      body: {
        csrfToken: session.csrfToken,
        network: 'NETWORK_A',
        productType: 'AIRTIME',
        productId: PRODUCT_ID,
        clientRequestId: 'req_unaffordable',
      },
    });
    expect(response.status).toBe(400);
    const code = (envelope as { error: { reasonCode: string } }).error.reasonCode;
    // The reason carries the figure the server saw, so the screen can state it.
    expect(code).toMatch(/^INSUFFICIENT_AVAILABLE_BALANCE:/);
    expect(txCount(harness), 'a refused purchase must create nothing').toBe(before);

    // And the amount screen states the actual available balance.
    const screen = await screenFor(
      harness,
      '/vouchers/airtime/NETWORK_A/AIRTIME',
      q({ error: code }),
      session,
    );
    expect(screen?.html).toContain('Insufficient simulated balance. Available balance:');
    // The operator stays on the amount screen — not a terminal failure card.
    expect(screen?.html).toContain('data-testid="amount-cards"');
    expect(screen?.html).not.toContain('data-testid="pin-input"');
  });

  it('a business refusal at PIN time renders the failure card, NOT the PIN screen', async () => {
    // The failure card still exists for refusals that can only be known at
    // authorization; this asserts its routing and wording directly.
    harness = makeUiHarness('business-refusal');
    const session = await signInAs(harness.api);
    const orderId = await openOrder(harness, session);

    const screen = await screenFor(
      harness,
      `/orders/${orderId}/result`,
      q({ error: 'INSUFFICIENT_AVAILABLE_BALANCE' }),
      session,
    );
    expect(screen?.status).toBe(200);
    expect(screen?.html).toContain('data-testid="voucher-failure"');
    expect(screen?.html).toContain('Insufficient training balance. No voucher was issued.');
    expect(screen?.html).not.toContain('data-testid="pin-input"');
    expect(screen?.html).not.toContain('Confirm transaction PIN');
  });

  it('never renders a raw machine code as visible text, for known or unknown reasons', async () => {
    harness = makeUiHarness('no-raw-codes');
    const session = await signInAs(harness.api);
    const orderId = await openOrder(harness, session);

    for (const code of ['INSUFFICIENT_AVAILABLE_BALANCE', 'ORDER_EXPIRED', 'ORDER_NOT_OPEN', 'SOMETHING_UNMAPPED']) {
      const screen = await screenFor(harness, `/orders/${orderId}/result`, q({ error: code }), session);
      const html = screen?.html ?? '';
      // The code may persist as a data attribute for support, but never as text.
      const visible = html.replace(/<[^>]*>/g, ' ');
      expect(visible, code).not.toContain(code);
      // And the message area is never blank.
      expect(html, code).toMatch(/data-testid="voucher-failure-message"[^>]*>[^<]+</);
    }
  });

  it('an unmapped code falls back to the translated generic sentence', async () => {
    harness = makeUiHarness('generic-fallback');
    const session = await signInAs(harness.api);
    const orderId = await openOrder(harness, session);
    const screen = await screenFor(harness, `/orders/${orderId}/result`, q({ error: 'TOTALLY_NEW_CODE' }), session);
    expect(screen?.html).toContain('The voucher could not be completed. No voucher was issued.');
  });
});

// --- 11-16: state safety -----------------------------------------------------

describe('order state safety', () => {
  it('a cancelled order cannot be authorized and creates nothing', async () => {
    harness = makeUiHarness('cancelled-order');
    const session = await signInAs(harness.api);
    const orderId = await openOrder(harness, session);
    const before = txCount(harness);

    await callWith(harness.api, 'POST', `/api/training/orders/${orderId}/cancel`, {
      cookie: session.cookieHeader,
      body: { csrfToken: session.csrfToken },
    });
    const { response, envelope } = await callWith(harness.api, 'POST', `/api/training/orders/${orderId}/authorize`, {
      cookie: session.cookieHeader,
      body: { csrfToken: session.csrfToken, pin: TEST_PIN },
    });
    expect(response.status).toBe(409);
    expect((envelope as { error: { reasonCode: string } }).error.reasonCode).toBe('ORDER_NOT_OPEN');
    expect(txCount(harness)).toBe(before);
  });

  it('no PIN appears in any rendered voucher page', async () => {
    harness = makeUiHarness('pin-never-rendered');
    const session = await signInAs(harness.api);
    const orderId = await openOrder(harness, session);
    for (const path of [`/orders/${orderId}`, `/orders/${orderId}/authorize`, `/orders/${orderId}/result`]) {
      const screen = await screenFor(harness, path, q({ error: 'INSUFFICIENT_AVAILABLE_BALANCE' }), session);
      expect(screen?.html, path).not.toContain(TEST_PIN);
      expect(screen?.html, path).not.toMatch(/value="\d{6}"/);
    }
  });

  it('every visible link on the failure card points at a real route', async () => {
    harness = makeUiHarness('failure-links');
    const session = await signInAs(harness.api);
    const orderId = await openOrder(harness, session);
    const screen = await screenFor(harness, `/orders/${orderId}/result`, q({ error: 'ORDER_EXPIRED' }), session);
    const html = screen?.html ?? '';
    // Home is the Telga dashboard now, not the app launcher: finishing or
    // cancelling a sale returns the operator to where sales start.
    for (const href of ['/vouchers/airtime', '/vouchers', '/dashboard']) {
      expect(html, href).toContain(`href="${href}"`);
      const target = await screenFor(harness, href, q(), session);
      expect(target?.status, href).toBe(200);
    }
  });
});

// --- 18: Telga Pay untouched -------------------------------------------------

describe('Telga Pay is unaffected', () => {
  it('still renders, still UI-only, still creates no transaction', async () => {
    harness = makeUiHarness('pay-untouched');
    const session = await signInAs(harness.api);
    const before = txCount(harness);
    for (const path of ['/pay', '/pay/purchase', '/pay/cashback']) {
      const screen = await screenFor(harness, path, q(), session);
      expect(screen?.status, path).toBe(200);
      // The mode banner is on every screen, via `page()`.
      expect(screen?.html, path).toContain('Training mode');
    }
    // The processor disclaimer lives on the Telga Pay entry screen. Recorded
    // as it actually is: this task must not change Telga Pay.
    const entry = await screenFor(harness, '/pay', q(), session);
    expect(entry?.html).toContain('no real processor connected');
    const result = await screenFor(
      harness,
      '/pay/result',
      q({ flow: 'purchase', amount: '10', note: '', outcome: 'approved' }),
      session,
    );
    expect(result?.html).toContain('Training simulation only');
    expect(txCount(harness)).toBe(before);
  });
});
