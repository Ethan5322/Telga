/**
 * The cover screen, the mark, and what a slip prints for each product.
 *
 * Most of this exists because a retest reported failures that turned out to
 * be one bug wearing several disguises: voucher sales written before the
 * recipient fix stored the *mask of a placeholder*, which printed as a row of
 * twenty-one stars where a phone number goes — and was read as a masked
 * voucher PIN. The tests below pin both halves: the PIN prints in full, and
 * the placeholder never prints at all.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_BEHAVIOURS } from '@telga/provider-mock-airtime';
import { authenticate } from '@telga/api';
import {
  renderScreen,
  telgaLogo,
  TRAINING_DATA_CATEGORIES,
} from '@telga/merchant-pos';
import type { PosServerOptions } from '@telga/merchant-pos';
import { renderToHtml } from '@telga/merchant-pos';
import { SIMULATED_PIN_PREFIX } from '@telga/domain';
import { MERCHANT_A, callWith, makeUiHarness, signInAs, TEST_PIN } from '../auth/helpers';
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
    catalog: [],
    voucherCatalog: TEST_VOUCHER_CATALOG.map((e) => ({ ...e, label: e.productId })),
    voucherNetworks: [...TEST_VOUCHER_NETWORKS],
    dataCategories: [...TRAINING_DATA_CATEGORIES],
    simulatedBehaviours: [...MOCK_BEHAVIOURS],
  };
}

async function screenFor(h: UiHarness, path: string, session: TestSession): Promise<string> {
  const auth = authenticate(h.api, session.sessionToken, 'corr_screen');
  if (!auth.ok) throw new Error(`fixture session refused: ${auth.code}`);
  const rendered = await renderScreen(optionsFor(h), {
    path,
    query: new URLSearchParams(),
    context: auth.context,
    cookieHeader: session.cookieHeader,
    csrfToken: session.csrfToken,
  });
  return rendered?.html ?? '';
}

/** Run one voucher sale through the real order → PIN → slip path. */
async function sell(
  h: UiHarness,
  session: TestSession,
  productType: string,
  productId: string,
  recipient?: string,
): Promise<string> {
  const order = await callWith<{ orderId: string }>(h.api, 'POST', '/api/training/orders', {
    cookie: session.cookieHeader,
    body: {
      csrfToken: session.csrfToken,
      network: 'NETWORK_A',
      productType,
      productId,
      recipient,
      clientRequestId: `rq_${productId}`,
    },
  });
  if (!order.envelope.ok) throw new Error(`order refused: ${order.envelope.error.reasonCode}`);
  const authorized = await callWith<{ transactionId: string }>(
    h.api,
    'POST',
    `/api/training/orders/${order.envelope.data.orderId}/authorize`,
    { cookie: session.cookieHeader, body: { csrfToken: session.csrfToken, pin: TEST_PIN } },
  );
  if (!authorized.envelope.ok) throw new Error('authorize refused');
  return authorized.envelope.data.transactionId;
}

const valueOf = (html: string, id: string): string =>
  new RegExp(`data-testid="${id}">([^<]*)<`).exec(html)?.[1] ?? '';

describe('the Telga mark', () => {
  // These assertions changed shape when the mark stopped being hand-drawn
  // SVG. Two earlier attempts redrew it as paths and both were rejected for
  // not looking like the supplied render — so the real artwork is served
  // instead, and what is worth pinning is that it *is* the real file, served
  // from an origin the page's CSP allows.
  it('is the founder’s artwork, served from this origin', () => {
    const html = renderToHtml(telgaLogo());
    expect(html).toContain('<img');
    expect(html).toContain('src="/assets/telga-logo.png"');
    // Same-origin, because the page CSP is `img-src \'self\'` — a data: URI
    // would be refused outright.
    expect(html).not.toContain('data:image');
    expect(html).not.toContain('http://');
  });

  it('names itself for a screen reader, and goes quiet when set beside the word', () => {
    expect(renderToHtml(telgaLogo())).toContain('alt="Telga"');
    // An empty alt is what marks an image decorative — not aria-hidden on a
    // wrapper — and is used where TELGA is already spelled out beside it.
    expect(renderToHtml(telgaLogo({ title: '' }))).toContain('alt=""');
  });

  it('plays the fall → catch → stand sequence only where it is asked for', () => {
    // The supplied render is the middle of that sequence, so a still copy
    // reads as "still falling". The class drives a CSS animation that rests
    // upright; a slip never asks for it.
    expect(renderToHtml(telgaLogo({ animate: true }))).toContain('telga-logo--animate');
    expect(renderToHtml(telgaLogo())).not.toContain('telga-logo--animate');
  });

  it('carries a print treatment for thermal paper', () => {
    expect(renderToHtml(telgaLogo({ variant: 'mono' }))).toContain('telga-logo--mono');
  });
});

describe('what each slip prints', () => {
  it('prints the voucher PIN in full, never masked', async () => {
    harness = makeUiHarness('slip-pin-full', { fundBirr: 500 });
    const session = await signInAs(harness.api);
    const id = await sell(harness, session, 'AIRTIME', 'NETWORK_A_AIRTIME_2500');
    const html = await screenFor(harness, `/transactions/${id}/slip`, session);

    const pin = valueOf(html, 'slip-redemption-code');
    expect(pin).toMatch(new RegExp(`^${SIMULATED_PIN_PREFIX}\\d{8}$`));
    expect(pin, 'a PIN a customer cannot read is not a voucher').not.toContain('*');
    // And the dial string carries that same PIN, ready to be read aloud.
    expect(valueOf(html, 'slip-dial-string')).toContain(pin);
  });

  it('omits the phone line on a counter voucher, rather than printing stars', async () => {
    harness = makeUiHarness('slip-no-phone', { fundBirr: 500 });
    const session = await signInAs(harness.api);
    const id = await sell(harness, session, 'AIRTIME', 'NETWORK_A_AIRTIME_2500');
    const html = await screenFor(harness, `/transactions/${id}/slip`, session);

    expect(html).not.toContain('data-testid="slip-recipient"');
    // The old placeholder mask: `VOUCHER-SALE-NO-RECIPIENT` masked down to
    // `VO*********************NT`. It must never reach paper again.
    expect(html).not.toMatch(/VO\*+NT/);
  });

  it('prints the customer’s masked number on a top-up, and no redemption code', async () => {
    harness = makeUiHarness('slip-topup', { fundBirr: 500 });
    const session = await signInAs(harness.api);
    const id = await sell(harness, session, 'TOPUP', 'NETWORK_A_TOPUP_2500', '0912345678');
    const html = await screenFor(harness, `/transactions/${id}/slip`, session);

    expect(valueOf(html, 'slip-recipient')).toBe('09******78');
    // Nowhere to redeem — printing a code would invite somebody to try.
    expect(html).not.toContain('data-testid="slip-redemption-code"');
    expect(html).not.toContain('data-testid="slip-dial-string"');
  });

  it('prints both a number and a code on a data bundle', async () => {
    harness = makeUiHarness('slip-data', { fundBirr: 500 });
    const session = await signInAs(harness.api);
    const id = await sell(
      harness,
      session,
      'DATA',
      'NETWORK_A_DATA_MONTHLY_1GB_30D',
      '0912345678',
    );
    const html = await screenFor(harness, `/transactions/${id}/slip`, session);

    expect(valueOf(html, 'slip-recipient')).toBe('09******78');
    expect(valueOf(html, 'slip-redemption-code')).toContain(SIMULATED_PIN_PREFIX);
  });

  it('carries the mark on every product’s slip', async () => {
    harness = makeUiHarness('slip-logo-all', { fundBirr: 900 });
    const session = await signInAs(harness.api);
    for (const [type, product, recipient] of [
      ['AIRTIME', 'NETWORK_A_AIRTIME_2500', undefined],
      ['TOPUP', 'NETWORK_A_TOPUP_2500', '0912345678'],
      ['DATA', 'NETWORK_A_DATA_MONTHLY_1GB_30D', '0912345678'],
    ] as const) {
      const id = await sell(harness, session, type, product, recipient);
      const html = await screenFor(harness, `/transactions/${id}/slip`, session);
      expect(html, `${type} slip should carry the mark`).toContain('data-testid="slip-logo"');
    }
  });

  it('names the network in full, not a truncated id', async () => {
    harness = makeUiHarness('slip-network', { fundBirr: 500 });
    const session = await signInAs(harness.api);
    const id = await sell(harness, session, 'AIRTIME', 'NETWORK_A_AIRTIME_2500');
    const html = await screenFor(harness, `/transactions/${id}/slip`, session);

    // `split('_')[0]` used to cut `NETWORK_A` down to `NETWORK`.
    expect(valueOf(html, 'slip-network')).toBe('NETWORK_A');
    // And the service reads as a product, not a database key.
    expect(valueOf(html, 'slip-service')).toBe('Airtime');
  });
});

describe('a bulk print', () => {
  it('records every voucher as its own transaction with its own code', async () => {
    harness = makeUiHarness('bulk-ledger', { fundBirr: 900 });
    const session = await signInAs(harness.api);

    const order = await callWith<{ orderId: string }>(harness.api, 'POST', '/api/training/orders', {
      cookie: session.cookieHeader,
      body: {
        csrfToken: session.csrfToken,
        network: 'NETWORK_A',
        productType: 'AIRTIME',
        productId: 'NETWORK_A_AIRTIME_2500',
        quantity: 4,
        clientRequestId: 'rq_bulk',
      },
    });
    if (!order.envelope.ok) throw new Error('order refused');
    await callWith(
      harness.api,
      'POST',
      `/api/training/orders/${order.envelope.data.orderId}/authorize`,
      { cookie: session.cookieHeader, body: { csrfToken: session.csrfToken, pin: TEST_PIN } },
    );

    const transactions = harness.deps.driver.findTransactionsByMerchant(MERCHANT_A);
    expect(transactions, 'four vouchers is four transactions').toHaveLength(4);

    // Four distinct ids, four distinct redemption codes.
    expect(new Set(transactions.map((t) => t.id)).size).toBe(4);
    const codes = new Set<string>();
    for (const transaction of transactions) {
      const html = await screenFor(harness, `/transactions/${transaction.id}/slip`, session);
      codes.add(valueOf(html, 'slip-redemption-code'));
    }
    expect(codes.size, 'each voucher needs its own PIN to be worth anything').toBe(4);

    // And the money adds up: four sales of 25 birr, and the ledger balances.
    expect(transactions.every((t) => t.amount_minor === 2500)).toBe(true);
    expect(harness.deps.driver.profitAvailableMinor(MERCHANT_A)).toBe(400);
    expect(harness.deps.driver.ledgerResidualMinor()).toBe(0);
  });
});
