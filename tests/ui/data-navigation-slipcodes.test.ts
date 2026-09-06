/**
 * Data bundles, navigation, and what a slip prints as a redemption code.
 *
 * The three fixes from the founder's Stage 1–2 retest, plus the data flow
 * they approved alongside it. The assertions that matter most here are the
 * negative ones: a simulated code must be unmistakably simulated, and no
 * real carrier name may reach a screen or a slip.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_BEHAVIOURS } from '@telga/provider-mock-airtime';
import { authenticate } from '@telga/api';
import {
  TRAINING_DATA_BUNDLES,
  TRAINING_DATA_CATEGORIES,
  renderScreen,
} from '@telga/merchant-pos';
import type { PosServerOptions } from '@telga/merchant-pos';
import {
  SIMULATED_DIAL_PREFIX,
  SIMULATED_PIN_PREFIX,
  isSimulatedVoucherCode,
  simulatedVoucherCode,
} from '@telga/domain';
import { callWith, makeUiHarness, seedSale, signInAs } from '../auth/helpers';
import type { TestSession, UiHarness } from '../auth/helpers';
import { TEST_VOUCHER_CATALOG, TEST_VOUCHER_NETWORKS } from './helpers';

let harness: UiHarness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

/** The test catalog plus data bundles, mirroring what `cli.ts` builds. */
const TEST_DATA_CATALOG = TEST_VOUCHER_NETWORKS.flatMap((network) =>
  TRAINING_DATA_BUNDLES.map((bundle) => ({
    productId: `${network.id}_DATA_${bundle.category}_${bundle.code}`,
    network: network.id,
    productType: 'DATA' as const,
    label: `${network.label} — ${bundle.volumeLabel} ${bundle.validityLabel} (simulated)`,
    amountMinor: bundle.amountMinor,
    available: true,
    isCustom: false,
    dataCategory: bundle.category,
    volumeLabel: bundle.volumeLabel,
    validityDays: bundle.validityDays,
    validityLabel: bundle.validityLabel,
  })),
);

function optionsFor(h: UiHarness): PosServerOptions {
  return {
    api: h.api,
    environment: 'test',
    catalog: [
      { productId: 'AIRTIME', label: 'Airtime 25 (simulated)', amountMinor: 2500, available: true },
    ],
    voucherCatalog: [
      ...TEST_VOUCHER_CATALOG.map((entry) => ({
        ...entry,
        label: `${entry.network} — ${entry.productId}`,
      })),
      ...TEST_DATA_CATALOG,
    ],
    voucherNetworks: [...TEST_VOUCHER_NETWORKS],
    dataCategories: [...TRAINING_DATA_CATEGORIES],
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

describe('the data bundle flow', () => {
  it('no longer offers Data, which founder decision D112 switched off', async () => {
    // `product.data` is false. The category is not listed and the route is
    // refused — both, not just the first: a category removed from the list
    // while `/vouchers/data` still answered would be exactly the "hidden but
    // still served" failure CLAUDE.md §7 forbids.
    harness = makeUiHarness('data-category-tile');
    const screen = await screenFor(harness, '/vouchers');
    const html = screen?.html ?? '';
    expect(html).not.toContain('data-testid="category-data"');
    expect(html).not.toContain('href="/vouchers/data"');
  });

  // The HTTP refusal of `/vouchers/data` is proved in
  // `tests/ui/feature-disabled-routes.test.ts`, against a live server. It
  // cannot be proved here: `screenFor` calls `renderScreen` directly, and the
  // feature gate lives in `route()` — `routeBlockedBy` runs at server.ts:2106,
  // before the dispatch that reaches `renderScreen` at 3094. So this file
  // covers what the renderer draws, and that file covers what the server
  // serves. Asserting a 404 here would test the wrong layer and pass only by
  // accident if the renderer ever grew a gate of its own.

  it('walks network, then category, then package', async () => {
    harness = makeUiHarness('data-walk');
    const session = await signInAs(harness.api);

    const networks = await screenFor(harness, '/vouchers/data', new URLSearchParams(), session);
    expect(networks?.status).toBe(200);
    expect(networks?.html).toContain('href="/vouchers/data/NETWORK_A"');

    const categories = await screenFor(
      harness,
      '/vouchers/data/NETWORK_A',
      new URLSearchParams(),
      session,
    );
    expect(categories?.status).toBe(200);
    expect(categories?.html).toContain('data-testid="data-category-MONTHLY"');
    expect(categories?.html).toContain('data-testid="data-category-VOICE"');

    const packages = await screenFor(
      harness,
      '/vouchers/data/NETWORK_A/MONTHLY',
      new URLSearchParams(),
      session,
    );
    expect(packages?.status).toBe(200);
    const html = packages?.html ?? '';
    expect(html).toContain('data-testid="data-package-list"');
    // Volume, validity and price all visible before the operator commits.
    expect(html).toContain('1GB');
    expect(html).toContain('30 days');
    expect(html).toContain('data-testid="recipient-input"');
  });

  it('offers all nine approved categories', async () => {
    harness = makeUiHarness('data-categories');
    const screen = await screenFor(harness, '/vouchers/data/NETWORK_A');
    for (const category of TRAINING_DATA_CATEGORIES) {
      expect(screen?.html, `${category.id} should be offered`).toContain(
        `data-testid="data-category-${category.id}"`,
      );
    }
  });

  it('creates a data order and requires a phone number for it', async () => {
    harness = makeUiHarness('data-order', { fundBirr: 500 });
    const session = await signInAs(harness.api);
    // 125 birr, which is more than the harness's default 100 birr float.
    const productId = 'NETWORK_A_DATA_MONTHLY_1GB_30D';

    const without = await callWith(harness.api, 'POST', '/api/training/orders', {
      cookie: session.cookieHeader,
      body: {
        csrfToken: session.csrfToken,
        network: 'NETWORK_A',
        productType: 'DATA',
        productId,
        clientRequestId: 'req_data_1',
      },
    });
    expect(without.response.status, 'a bundle with nowhere to go must be refused').toBe(400);

    const withPhone = await callWith<{ productType: string; amountMinor: number }>(
      harness.api,
      'POST',
      '/api/training/orders',
      {
        cookie: session.cookieHeader,
        body: {
          csrfToken: session.csrfToken,
          network: 'NETWORK_A',
          productType: 'DATA',
          productId,
          recipient: '0912345678',
          clientRequestId: 'req_data_2',
        },
      },
    );
    expect(withPhone.response.status).toBe(201);
    if (!withPhone.envelope.ok) throw new Error('expected an order');
    expect(withPhone.envelope.data.productType).toBe('DATA');
    expect(withPhone.envelope.data.amountMinor).toBe(12_500);
  });

  it('names no real carrier and no trademark anywhere in the flow', async () => {
    harness = makeUiHarness('data-no-real-names');
    const session = await signInAs(harness.api);
    const paths = ['/vouchers', '/vouchers/data', '/vouchers/data/NETWORK_A', '/vouchers/data/NETWORK_A/MONTHLY'];
    // `FreeMe` is a Vodacom trademark; the rest are real operators Telga has
    // no agreement with. CLAUDE.md §10 and Decision Log D66.
    const forbidden = ['freeme', 'vodacom', 'ethio telecom', 'ethiotelecom', 'safaricom', 'mtn', 'cell c', 'telkom'];
    for (const path of paths) {
      const screen = await screenFor(harness, path, new URLSearchParams(), session);
      // The `<head>` is stripped before scanning.
      //
      // It carries a **random per-response CSP nonce**, and a base64 nonce
      // eventually contains any three-letter sequence you care to look for.
      // This test failed once on `nonce-rgo2ozbfj4umtnj1hqttwq` — which
      // contains "mtn" — and would have kept failing at random forever. The
      // question the test is asking is about what a merchant *reads*, so the
      // body is the right thing to read.
      const full = screen?.html ?? '';
      const bodyAt = full.indexOf('<body');
      const html = (bodyAt === -1 ? full : full.slice(bodyAt)).toLowerCase();
      for (const name of forbidden) {
        expect(html, `${path} must not name "${name}"`).not.toContain(name);
      }
    }
  });
});

describe('the simulated redemption code', () => {
  it('is unmistakably fake', () => {
    const code = simulatedVoucherCode('txn_example_1', 'NETWORK_A');
    expect(isSimulatedVoucherCode(code)).toBe(true);
    expect(code.voucherPin.startsWith(SIMULATED_PIN_PREFIX)).toBe(true);
    expect(code.dialString.startsWith(SIMULATED_DIAL_PREFIX)).toBe(true);
    // Never the real Ethio Telecom recharge string, whose shape it borrows.
    expect(code.dialString).not.toContain('*805*');
    expect(code.tokenReference).toContain('TRAIN');
  });

  it('is the same code every time, so a reprint matches the original', () => {
    const first = simulatedVoucherCode('txn_stable', 'NETWORK_A');
    const second = simulatedVoucherCode('txn_stable', 'NETWORK_A');
    expect(second).toEqual(first);
  });

  it('differs between transactions', () => {
    const a = simulatedVoucherCode('txn_one', 'NETWORK_A');
    const b = simulatedVoucherCode('txn_two', 'NETWORK_A');
    expect(a.voucherPin).not.toBe(b.voucherPin);
  });
});

describe('what the slip prints', () => {
  it('carries the network, PIN, token reference and dial string', async () => {
    harness = makeUiHarness('slip-codes');
    const session = await signInAs(harness.api);
    const id = await seedSale(harness, { productId: 'NETWORK_A_AIRTIME_2500' as never });

    const screen = await screenFor(
      harness,
      `/transactions/${id}/slip`,
      new URLSearchParams(),
      session,
    );
    const html = screen?.html ?? '';
    expect(html).toContain('data-testid="slip-network-code"');
    expect(html).toContain('data-testid="slip-redemption-code"');
    expect(html).toContain('data-testid="slip-redemption-reference"');
    expect(html).toContain('data-testid="slip-dial-string"');
    expect(html).toContain(SIMULATED_PIN_PREFIX);
  });

  it('warns beside the code that it will not load airtime', async () => {
    harness = makeUiHarness('slip-code-notice');
    const session = await signInAs(harness.api);
    const id = await seedSale(harness, { productId: 'NETWORK_A_AIRTIME_2500' as never });
    const screen = await screenFor(
      harness,
      `/transactions/${id}/slip`,
      new URLSearchParams(),
      session,
    );
    expect(screen?.html).toContain('data-testid="slip-simulated-code-notice"');
    expect(screen?.html).toContain('SIMULATED CODE');
    // The general training banner is still there too — they are two notices.
    expect(screen?.html).toContain('TRAINING — NO REAL VALUE');
  });

  it('prints the identical code on a reprint', async () => {
    harness = makeUiHarness('slip-code-reprint');
    const session = await signInAs(harness.api);
    const id = await seedSale(harness, { productId: 'NETWORK_A_AIRTIME_2500' as never });

    const pinOf = (html: string): string =>
      /data-testid="slip-redemption-code">([^<]*)</.exec(html)?.[1] ?? '';

    const first = await screenFor(harness, `/transactions/${id}/slip`, new URLSearchParams(), session);
    await callWith(harness.api, 'POST', `/api/training/transactions/${id}/reprint`, {
      cookie: session.cookieHeader,
      body: { csrfToken: session.csrfToken },
    });
    const second = await screenFor(harness, `/transactions/${id}/slip`, new URLSearchParams(), session);

    const original = pinOf(first?.html ?? '');
    expect(original).not.toBe('');
    expect(pinOf(second?.html ?? ''), 'a reprinted voucher must carry the same PIN').toBe(original);
  });

  it('prints no redemption code for a top-up, which has nowhere to redeem', async () => {
    harness = makeUiHarness('slip-topup-no-code');
    const session = await signInAs(harness.api);
    const id = await seedSale(harness, { productId: 'NETWORK_A_TOPUP_2500' as never });
    const screen = await screenFor(
      harness,
      `/transactions/${id}/slip`,
      new URLSearchParams(),
      session,
    );
    expect(screen?.html).not.toContain('data-testid="slip-redemption-code"');
    expect(screen?.html).not.toContain('data-testid="slip-simulated-code-notice"');
  });
});

describe('navigation', () => {
  // `/transactions` rather than a voucher screen: the shared bar is rendered
  // by the legacy screens, which is exactly where a merchant kept meeting it.
  it('the shared Home link goes to the vending dashboard, not the old sell page', async () => {
    harness = makeUiHarness('nav-home');
    const screen = await screenFor(harness, '/transactions');
    const html = screen?.html ?? '';
    expect(html).toContain('data-testid="nav-home"');
    expect(html).toMatch(/data-testid="nav-home"[^>]*href="\/dashboard"|href="\/dashboard"[^>]*data-testid="nav-home"/);
    // The legacy single-screen sale form is no longer a navigation entry.
    expect(html).not.toContain('data-testid="nav-sell"');
  });

  it('shows a Main button at every step of the sale flow', async () => {
    harness = makeUiHarness('nav-main-everywhere');
    const session = await signInAs(harness.api);
    const paths = [
      '/vouchers',
      '/vouchers/airtime/NETWORK_A',
      '/vouchers/airtime/NETWORK_A/AIRTIME',
      '/vouchers/data/NETWORK_A',
      '/vouchers/data/NETWORK_A/MONTHLY',
    ];
    for (const path of paths) {
      const screen = await screenFor(harness, path, new URLSearchParams(), session);
      expect(screen?.html, `${path} should offer a Main button`).toContain(
        'data-testid="main-button"',
      );
    }
  });

  it('shows a Main button on the order and PIN screens, as a form that cancels', async () => {
    harness = makeUiHarness('nav-main-order');
    const session = await signInAs(harness.api);
    const { envelope } = await callWith<{ orderId: string }>(harness.api, 'POST', '/api/training/orders', {
      cookie: session.cookieHeader,
      body: {
        csrfToken: session.csrfToken,
        network: 'NETWORK_A',
        productType: 'AIRTIME',
        productId: 'NETWORK_A_AIRTIME_2500',
        clientRequestId: 'req_main_order',
      },
    });
    if (!envelope.ok) throw new Error('expected an order');
    const orderId = envelope.data.orderId;

    for (const path of [`/orders/${orderId}`, `/orders/${orderId}/authorize`]) {
      const screen = await screenFor(harness, path, new URLSearchParams(), session);
      const html = screen?.html ?? '';
      expect(html, `${path} should offer Main`).toContain('data-testid="main-button"');
      // A write, so it carries CSRF and asks before abandoning the sale.
      expect(html).toContain('data-testid="main-form"');
      expect(html).toContain('name="returnTo"');
      expect(html).toContain('data-confirm=');
    }
  });

  it('shows a Main button on the slip, the screen an operator was stranded on', async () => {
    harness = makeUiHarness('nav-main-slip');
    const session = await signInAs(harness.api);
    const id = await seedSale(harness);
    const screen = await screenFor(harness, `/transactions/${id}/slip`, new URLSearchParams(), session);
    expect(screen?.html).toContain('data-testid="main-button"');
    expect(screen?.html).toContain('href="/dashboard"');
  });

  it('does not put a Main button on the dashboard itself', async () => {
    harness = makeUiHarness('nav-main-absent');
    const screen = await screenFor(harness, '/dashboard');
    expect(screen?.html).not.toContain('data-testid="main-button"');
  });
});

describe('leaving a sale through Main', () => {
  it('cancels the open order and lands on the dashboard', async () => {
    harness = makeUiHarness('main-cancels');
    const session = await signInAs(harness.api);
    const { envelope } = await callWith<{ orderId: string }>(harness.api, 'POST', '/api/training/orders', {
      cookie: session.cookieHeader,
      body: {
        csrfToken: session.csrfToken,
        network: 'NETWORK_A',
        productType: 'AIRTIME',
        productId: 'NETWORK_A_AIRTIME_2500',
        clientRequestId: 'req_main_cancel',
      },
    });
    if (!envelope.ok) throw new Error('expected an order');
    const orderId = envelope.data.orderId;

    await callWith(harness.api, 'POST', `/api/training/orders/${orderId}/cancel`, {
      cookie: session.cookieHeader,
      body: { csrfToken: session.csrfToken },
    });

    const order = harness.deps.driver.findPendingOrder(orderId);
    expect(order?.status, 'leaving through Main must not strand an OPEN order').toBe('CANCELLED');
    expect(order?.transaction_id, 'and must not have issued a voucher').toBeNull();
    expect(harness.deps.driver.ledgerResidualMinor()).toBe(0);
  });
});
