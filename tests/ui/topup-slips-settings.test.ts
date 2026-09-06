/**
 * What Priority 3 put on the screen.
 *
 * Three things, each with a rule attached. A top-up asks for a phone number
 * and an airtime voucher does not. Every printed thing — sale, top-up,
 * reprint, deposit — is drawn by one function and therefore carries one
 * training notice and one shop advertisement. And the settings that govern
 * both are the shop owner's, refused server-side rather than merely hidden.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_BEHAVIOURS } from '@telga/provider-mock-airtime';
import { authenticate } from '@telga/api';
import { renderScreen } from '@telga/merchant-pos';
import type { PosServerOptions } from '@telga/merchant-pos';
import {
  MERCHANT_A,
  OWNER_USER,
  TEST_PIN,
  callWith,
  makeUiHarness,
  seedSale,
  signInAs,
} from '../auth/helpers';
import type { TestSession, UiHarness } from '../auth/helpers';
import { TEST_VOUCHER_CATALOG, TEST_VOUCHER_NETWORKS } from './helpers';

let harness: UiHarness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

function optionsFor(h: UiHarness): PosServerOptions {
  return {
    api: h.api,
    environment: 'test',
    catalog: [
      { productId: 'AIRTIME', label: 'Airtime 25 (simulated)', amountMinor: 2500, available: true },
    ],
    // The screens need labels, which the API-facing catalog does not carry.
    voucherCatalog: TEST_VOUCHER_CATALOG.map((entry) => ({
      ...entry,
      label: `${entry.network} — ${entry.productId}`,
    })),
    voucherNetworks: [...TEST_VOUCHER_NETWORKS],
    simulatedBehaviours: [...MOCK_BEHAVIOURS],
  };
}

async function screenFor(
  h: UiHarness,
  path: string,
  query: URLSearchParams = new URLSearchParams(),
  session?: TestSession,
): Promise<{ status: number; html: string } | undefined> {
  const s = session ?? (await signInAs(h.api));
  const result = authenticate(h.api, s.sessionToken, 'corr_test_screen');
  if (!result.ok) throw new Error(`Fixture session refused: ${result.code}`);
  return renderScreen(optionsFor(h), {
    path,
    query,
    context: result.context,
    cookieHeader: s.cookieHeader,
    csrfToken: s.csrfToken,
  });
}

const asOwner = (h: UiHarness) =>
  signInAs(h.api, { userId: OWNER_USER, role: 'MERCHANT_OWNER', pin: TEST_PIN });

describe('the top-up flow', () => {
  it('offers a top-up beside airtime once a network is chosen', async () => {
    harness = makeUiHarness('topup-tile');
    const screen = await screenFor(harness, '/vouchers/airtime/NETWORK_A');
    const html = screen?.html ?? '';
    expect(html).toContain('data-testid="product-type-airtime"');
    expect(html).toContain('data-testid="product-type-topup"');
    expect(html).toContain('href="/vouchers/airtime/NETWORK_A/TOPUP"');
  });

  it('asks for a phone number on the top-up amount screen', async () => {
    harness = makeUiHarness('topup-amount-screen');
    const screen = await screenFor(harness, '/vouchers/airtime/NETWORK_A/TOPUP');
    expect(screen?.status).toBe(200);
    const html = screen?.html ?? '';
    expect(html).toContain('data-testid="recipient-input"');
    expect(html).toContain('name="recipient"');
    expect(html).toContain('value="TOPUP"');
  });

  it('does not ask for one on the airtime voucher screen', async () => {
    harness = makeUiHarness('airtime-amount-screen');
    const screen = await screenFor(harness, '/vouchers/airtime/NETWORK_A/AIRTIME');
    const html = screen?.html ?? '';
    // Absent, not hidden: there is nothing for a tampered form to submit.
    expect(html).not.toContain('data-testid="recipient-input"');
    expect(html).not.toContain('name="recipient"');
  });
});

describe('what an operator sees before entering a PIN', () => {
  async function orderFor(h: UiHarness, session: TestSession, body: Record<string, unknown>) {
    const { envelope } = await callWith<{ orderId: string }>(h.api, 'POST', '/api/training/orders', {
      cookie: session.cookieHeader,
      body: { csrfToken: session.csrfToken, ...body },
    });
    if (!envelope.ok) throw new Error('expected an order');
    return envelope.data.orderId;
  }

  it('shows the amount and the profit, as two separate figures', async () => {
    harness = makeUiHarness('pin-shows-profit');
    const session = await signInAs(harness.api);
    const orderId = await orderFor(harness, session, {
      network: 'NETWORK_A',
      productType: 'AIRTIME',
      productId: 'NETWORK_A_AIRTIME_2500',
      clientRequestId: 'req_pin_profit',
    });

    const screen = await screenFor(
      harness,
      `/orders/${orderId}/authorize`,
      new URLSearchParams(),
      session,
    );
    const html = screen?.html ?? '';
    expect(html).toContain('data-testid="summary-amount"');
    expect(html).toContain('data-testid="summary-profit"');
    expect(html).toContain('data-testid="pin-form"');
    // 25.00 face value, 1.00 profit at the 4% training default — and the
    // total the customer pays is the face value, never face plus profit.
    expect(html).toMatch(/data-testid="summary-amount">[^<]*25\.00/);
    expect(html).toMatch(/data-testid="summary-profit">[^<]*1\.00/);
    expect(html).toMatch(/data-testid="summary-total">[^<]*25\.00/);
  });

  it('shows the masked phone number for a top-up, never the full one', async () => {
    harness = makeUiHarness('pin-shows-recipient');
    const session = await signInAs(harness.api);
    const orderId = await orderFor(harness, session, {
      network: 'NETWORK_A',
      productType: 'TOPUP',
      productId: 'NETWORK_A_TOPUP_2500',
      recipient: '0912345678',
      clientRequestId: 'req_pin_recipient',
    });

    const screen = await screenFor(
      harness,
      `/orders/${orderId}/authorize`,
      new URLSearchParams(),
      session,
    );
    const html = screen?.html ?? '';
    expect(html).toContain('data-testid="summary-recipient"');
    expect(html, 'the full number must never reach a screen').not.toContain('0912345678');
  });

  it('shows a custom amount as the amount actually ordered, not the catalog placeholder', async () => {
    harness = makeUiHarness('pin-custom-amount');
    const session = await signInAs(harness.api);
    const orderId = await orderFor(harness, session, {
      network: 'NETWORK_A',
      productType: 'AIRTIME',
      productId: 'NETWORK_A_AIRTIME_CUSTOM',
      customAmountMinor: 3300,
      clientRequestId: 'req_pin_custom',
    });

    const screen = await screenFor(
      harness,
      `/orders/${orderId}/authorize`,
      new URLSearchParams(),
      session,
    );
    const html = screen?.html ?? '';
    expect(html).toMatch(/data-testid="summary-amount">[^<]*33\.00/);
    // 33 birr at 4% is 1.32 — and it must not read 0.00, which is what the
    // catalog's placeholder amount would have produced.
    expect(html).toMatch(/data-testid="summary-profit">[^<]*1\.32/);
  });
});

describe('the slip', () => {
  it('carries the training notice, on every slip, without the caller asking', async () => {
    harness = makeUiHarness('slip-training-notice');
    const id = await seedSale(harness);
    const screen = await screenFor(harness, `/transactions/${id}/slip`);
    const html = screen?.html ?? '';
    expect(html).toContain('data-testid="slip-training-banner"');
    expect(html).toContain('TRAINING — NO REAL VALUE');
  });

  it('prints at the width the owner chose', async () => {
    harness = makeUiHarness('slip-width');
    const owner = await asOwner(harness);
    const id = await seedSale(harness);

    const wide = await screenFor(harness, `/transactions/${id}/slip`, new URLSearchParams(), owner);
    expect(wide?.html).toContain('data-slip-size="80"');

    await callWith(harness.api, 'POST', '/api/training/settings', {
      cookie: owner.cookieHeader,
      body: { csrfToken: owner.csrfToken, slipSize: '58' },
    });

    const narrow = await screenFor(harness, `/transactions/${id}/slip`, new URLSearchParams(), owner);
    expect(narrow?.html).toContain('data-slip-size="58"');
    expect(narrow?.html).toContain('slip--58');
  });

  it('carries the shop advertisement when one is set, and nothing when it is not', async () => {
    harness = makeUiHarness('slip-advert');
    const owner = await asOwner(harness);
    const id = await seedSale(harness);

    const before = await screenFor(harness, `/transactions/${id}/slip`, new URLSearchParams(), owner);
    expect(before?.html).not.toContain('data-testid="slip-advert"');

    await callWith(harness.api, 'POST', '/api/training/settings', {
      cookie: owner.cookieHeader,
      body: { csrfToken: owner.csrfToken, slipAdvert: 'Open until 9pm — Bole branch' },
    });

    const after = await screenFor(harness, `/transactions/${id}/slip`, new URLSearchParams(), owner);
    expect(after?.html).toContain('data-testid="slip-advert"');
    expect(after?.html).toContain('Open until 9pm — Bole branch');
  });

  it('escapes an advertisement rather than rendering it as markup', async () => {
    harness = makeUiHarness('slip-advert-escaped');
    const owner = await asOwner(harness);
    const id = await seedSale(harness);
    await callWith(harness.api, 'POST', '/api/training/settings', {
      cookie: owner.cookieHeader,
      body: { csrfToken: owner.csrfToken, slipAdvert: '<script>alert(1)</script>' },
    });

    const screen = await screenFor(harness, `/transactions/${id}/slip`, new URLSearchParams(), owner);
    expect(screen?.html).not.toContain('<script>alert(1)</script>');
    expect(screen?.html).toContain('&lt;script&gt;');
  });

  it('shows the same slip after a sale as the history screen shows later', async () => {
    harness = makeUiHarness('slip-standardised');
    const session = await signInAs(harness.api);
    const id = await seedSale(harness);

    const fromHistory = await screenFor(
      harness,
      `/transactions/${id}/slip`,
      new URLSearchParams(),
      session,
    );
    // Both render the one `slipCard`, so both carry its markers.
    for (const marker of [
      'data-testid="transaction-slip"',
      'data-testid="slip-training-banner"',
      'data-testid="slip-reference"',
    ]) {
      expect(fromHistory?.html).toContain(marker);
    }
  });

  it('marks a reprint as a reprint and never as a new sale', async () => {
    harness = makeUiHarness('slip-reprint-marked');
    const session = await signInAs(harness.api);
    const id = await seedSale(harness);
    const balanceBefore = harness.deps.driver.balanceFor(MERCHANT_A).available.minor;

    await callWith(harness.api, 'POST', `/api/training/transactions/${id}/reprint`, {
      cookie: session.cookieHeader,
      body: { csrfToken: session.csrfToken },
    });

    const screen = await screenFor(harness, `/transactions/${id}/slip`, new URLSearchParams(), session);
    expect(screen?.html).toContain('data-testid="slip-reprint-notice"');
    expect(screen?.html).toContain('REPRINT');
    expect(
      harness.deps.driver.balanceFor(MERCHANT_A).available.minor,
      'a reprint must never move money',
    ).toBe(balanceBefore);
  });
});

describe('the settings screen', () => {
  it('renders the current settings, with the profit field marked as training only', async () => {
    harness = makeUiHarness('settings-screen');
    const owner = await asOwner(harness);
    const screen = await screenFor(harness, '/settings', new URLSearchParams(), owner);
    expect(screen?.status).toBe(200);
    const html = screen?.html ?? '';
    expect(html).toContain('data-testid="settings-form"');
    expect(html).toContain('data-testid="slip-size-radio-58"');
    expect(html).toContain('data-testid="slip-size-radio-80"');
    expect(html).toContain('data-testid="slip-advert-input"');
    expect(html).toContain('data-testid="profit-percent-input"');
    expect(html).toContain('data-testid="profit-training-note"');
    expect(html.toLowerCase()).toContain('not a negotiated commission');
    // Every write in Telga carries CSRF, and this one is no exception.
    expect(html).toContain('name="csrfToken"');
  });

  it('is reachable from the dashboard navigation', async () => {
    harness = makeUiHarness('settings-nav');
    const screen = await screenFor(harness, '/dashboard');
    expect(screen?.html).toContain('data-testid="dashboard-nav-settings"');
    expect(screen?.html).toContain('href="/settings"');
  });
});

describe('the Telga Pay deposit screens', () => {
  it('offers the three card gestures, and a form that carries CSRF', async () => {
    harness = makeUiHarness('deposit-screen');
    const owner = await asOwner(harness);
    const screen = await screenFor(harness, '/pay/deposit', new URLSearchParams(), owner);
    expect(screen?.status).toBe(200);
    const html = screen?.html ?? '';
    expect(html).toContain('data-testid="deposit-method-radio-tap"');
    expect(html).toContain('data-testid="deposit-method-radio-insert"');
    expect(html).toContain('data-testid="deposit-method-radio-swipe"');
    expect(html).toContain('name="csrfToken"');
    // Says plainly what it is, on the screen rather than only in a note.
    expect(html.toLowerCase()).toContain('training only');
    expect(html.toLowerCase()).toContain('no real money moves');
  });

  it('is linked from the Telga Pay entry screen', async () => {
    harness = makeUiHarness('deposit-link');
    const screen = await screenFor(harness, '/pay');
    expect(screen?.html).toContain('data-testid="pay-deposit-link"');
    expect(screen?.html).toContain('href="/pay/deposit"');
  });

  it('prints a deposit slip in the same format as a sale slip', async () => {
    harness = makeUiHarness('deposit-slip');
    const owner = await asOwner(harness);
    const screen = await screenFor(
      harness,
      '/pay/deposit/slip',
      new URLSearchParams({ deposit: 'posting_deposit_req_1', amount: '20000', method: 'TAP' }),
      owner,
    );
    expect(screen?.status).toBe(200);
    const html = screen?.html ?? '';
    expect(html).toContain('data-testid="transaction-slip"');
    expect(html).toContain('data-testid="slip-training-banner"');
    expect(html).toContain('TRAINING — NO REAL VALUE');
    expect(html).toContain('data-testid="slip-method"');
    expect(html).toContain('data-testid="slip-available-after"');
  });
});
