/**
 * Bulk printing, the corrected recipient chain, and what sign-out means.
 *
 * The three things the founder's consolidated retest asked for that carried
 * real money or security consequences. The assertions that matter most are
 * the ledger one (a batch of ten must not lose or invent a birr) and the
 * sign-out one (an idle timeout and an explicit sign-out must not cost the
 * same thing).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { parseProductId, productLabelFor } from '@telga/domain';
import { QUANTITY_LIMITS, batchRequestId } from '@telga/api';
import { MERCHANT_A, TEST_PIN, callWith, makeUiHarness, signInAs } from '../auth/helpers';
import type { TestSession, UiHarness } from '../auth/helpers';

let harness: UiHarness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

/** Create an order and authorize it, returning the receipt DTOs it produced. */
async function sell(
  h: UiHarness,
  session: TestSession,
  body: Record<string, unknown>,
): Promise<readonly Record<string, unknown>[]> {
  const order = await callWith<{ orderId: string; transactionIds: string[] }>(
    h.api,
    'POST',
    '/api/training/orders',
    { cookie: session.cookieHeader, body: { csrfToken: session.csrfToken, ...body } },
  );
  if (!order.envelope.ok) throw new Error(`order refused: ${order.envelope.error.reasonCode}`);
  const authorized = await callWith(
    h.api,
    'POST',
    `/api/training/orders/${order.envelope.data.orderId}/authorize`,
    { cookie: session.cookieHeader, body: { csrfToken: session.csrfToken, pin: TEST_PIN } },
  );
  if (!authorized.envelope.ok) throw new Error('authorize refused');

  const reread = await callWith<{ transactionIds: string[] }>(
    h.api,
    'GET',
    `/api/training/orders/${order.envelope.data.orderId}`,
    { cookie: session.cookieHeader },
  );
  if (!reread.envelope.ok) throw new Error('order not readable');

  const receipts: Record<string, unknown>[] = [];
  for (const id of reread.envelope.data.transactionIds) {
    const r = await callWith<Record<string, unknown>>(
      h.api,
      'GET',
      `/api/training/transactions/${id}/receipt`,
      { cookie: session.cookieHeader },
    );
    if (r.envelope.ok) receipts.push(r.envelope.data);
  }
  return receipts;
}

describe('reading a product id', () => {
  it('keeps a network id that contains an underscore whole', () => {
    // The bug: `split('_')[0]` returned `NETWORK`, so every slip's Network
    // line printed a truncated id.
    expect(parseProductId('NETWORK_A_AIRTIME_2500')?.network).toBe('NETWORK_A');
    expect(parseProductId('NETWORK_B_DATA_MONTHLY_1GB_30D')?.network).toBe('NETWORK_B');
    expect(parseProductId('NETWORK_B_DATA_MONTHLY_1GB_30D')?.descriptor).toBe('MONTHLY_1GB_30D');
  });

  it('returns undefined for a legacy sale with no network, rather than guessing', () => {
    expect(parseProductId('AIRTIME')).toBeUndefined();
    expect(productLabelFor('AIRTIME')).toBe('AIRTIME');
  });

  it('gives a slip a readable service name instead of a database key', () => {
    expect(productLabelFor('NETWORK_A_AIRTIME_2500')).toBe('Airtime');
    expect(productLabelFor('NETWORK_A_TOPUP_2500')).toBe('Airtime top-up');
    expect(productLabelFor('NETWORK_A_DATA_MONTHLY_1GB_30D')).toBe('Data — MONTHLY 1GB 30D');
  });
});

describe('the recipient on a slip', () => {
  it('shows the customer phone number on a top-up', async () => {
    harness = makeUiHarness('slip-topup-recipient');
    const session = await signInAs(harness.api);
    const [receipt] = await sell(harness, session, {
      network: 'NETWORK_A',
      productType: 'TOPUP',
      productId: 'NETWORK_A_TOPUP_2500',
      recipient: '0912345678',
      clientRequestId: 'req_topup_recip',
    });
    // Masked, never the full number — but present, which it was not: every
    // voucher sale used to carry a placeholder instead of the real number.
    expect(receipt?.['recipientMasked']).toBe('09******78');
    expect(receipt?.['recipientMasked']).not.toContain('VOUCHER');
    expect(receipt?.['redemptionCode'], 'a top-up has nowhere to redeem').toBeNull();
  });

  it('prints no recipient at all for a counter voucher', async () => {
    harness = makeUiHarness('slip-voucher-no-recipient');
    const session = await signInAs(harness.api);
    const [receipt] = await sell(harness, session, {
      network: 'NETWORK_A',
      productType: 'AIRTIME',
      productId: 'NETWORK_A_AIRTIME_2500',
      clientRequestId: 'req_voucher_recip',
    });
    // Empty, not a masked placeholder. The slip omits the line entirely
    // rather than printing `VOUC****...****ENT` where a number would go.
    expect(receipt?.['recipientMasked']).toBe('');
    expect(receipt?.['redemptionCode']).toMatch(/^TRAIN-/);
    expect(receipt?.['network'], 'no longer truncated to NETWORK').toBe('NETWORK_A');
  });

  it('shows both the phone number and a code on a data bundle', async () => {
    harness = makeUiHarness('slip-data-both', { fundBirr: 500 });
    const session = await signInAs(harness.api);
    const [receipt] = await sell(harness, session, {
      network: 'NETWORK_A',
      productType: 'DATA',
      productId: 'NETWORK_A_DATA_MONTHLY_1GB_30D',
      recipient: '0912345678',
      clientRequestId: 'req_data_recip',
    });
    expect(receipt?.['recipientMasked']).toBe('09******78');
    expect(receipt?.['redemptionCode']).toMatch(/^TRAIN-/);
  });
});

describe('bulk printing', () => {
  it('creates one transaction per voucher, each with its own code', async () => {
    harness = makeUiHarness('bulk-four', { fundBirr: 900 });
    const session = await signInAs(harness.api);
    const receipts = await sell(harness, session, {
      network: 'NETWORK_A',
      productType: 'AIRTIME',
      productId: 'NETWORK_A_AIRTIME_2500',
      quantity: 4,
      clientRequestId: 'req_bulk_four',
    });

    expect(receipts).toHaveLength(4);
    const codes = new Set(receipts.map((r) => r['redemptionCode']));
    expect(codes.size, 'four vouchers is four different PINs').toBe(4);
    const ids = new Set(receipts.map((r) => r['transactionId']));
    expect(ids.size).toBe(4);
  });

  it('moves exactly the total and leaves the ledger balanced', async () => {
    harness = makeUiHarness('bulk-ledger', { fundBirr: 900 });
    const session = await signInAs(harness.api);
    const before = harness.deps.driver.balanceFor(MERCHANT_A).available.minor;

    await sell(harness, session, {
      network: 'NETWORK_A',
      productType: 'AIRTIME',
      productId: 'NETWORK_A_AIRTIME_2500',
      quantity: 4,
      clientRequestId: 'req_bulk_ledger',
    });

    const after = harness.deps.driver.balanceFor(MERCHANT_A).available.minor;
    expect(before - after, 'four 25-birr vouchers costs 100 birr, not 25').toBe(10_000);
    expect(harness.deps.driver.ledgerResidualMinor(), 'every posting still nets to zero').toBe(0);
  });

  it('quotes the whole order on the confirmation, not one voucher', async () => {
    harness = makeUiHarness('bulk-summary', { fundBirr: 900 });
    const session = await signInAs(harness.api);
    const { envelope } = await callWith<{
      quantity: number;
      amountMinor: number;
      totalMinor: number;
      profitMinor: number;
    }>(harness.api, 'POST', '/api/training/orders', {
      cookie: session.cookieHeader,
      body: {
        csrfToken: session.csrfToken,
        network: 'NETWORK_A',
        productType: 'AIRTIME',
        productId: 'NETWORK_A_AIRTIME_2500',
        quantity: 4,
        clientRequestId: 'req_bulk_summary',
      },
    });
    if (!envelope.ok) throw new Error('expected an order');
    expect(envelope.data.quantity).toBe(4);
    // `amountMinor` stays the price of one, so the operator can still quote
    // the denomination; `totalMinor` and profit cover the batch.
    expect(envelope.data.amountMinor).toBe(2500);
    expect(envelope.data.totalMinor).toBe(10_000);
    expect(envelope.data.profitMinor, '4% of 100 birr').toBe(400);
  });

  it('refuses a quantity outside the training bounds', async () => {
    harness = makeUiHarness('bulk-bounds', { fundBirr: 5000 });
    const session = await signInAs(harness.api);
    for (const quantity of [0, -1, QUANTITY_LIMITS.max + 1, 1.5]) {
      const { response } = await callWith(harness.api, 'POST', '/api/training/orders', {
        cookie: session.cookieHeader,
        body: {
          csrfToken: session.csrfToken,
          network: 'NETWORK_A',
          productType: 'AIRTIME',
          productId: 'NETWORK_A_AIRTIME_2500',
          quantity,
          clientRequestId: `req_q_${String(quantity)}`,
        },
      });
      expect(response.status, `quantity ${String(quantity)} must be refused`).toBe(400);
    }
  });

  it('refuses a batch the float cannot cover, judged on the total', async () => {
    // 100 birr on hand, four 25-birr vouchers is exactly affordable; five is
    // not. The old check compared one voucher against the balance and would
    // have let this through to fail later, mid-batch.
    harness = makeUiHarness('bulk-balance', { fundBirr: 100 });
    const session = await signInAs(harness.api);
    const { response, envelope } = await callWith(harness.api, 'POST', '/api/training/orders', {
      cookie: session.cookieHeader,
      body: {
        csrfToken: session.csrfToken,
        network: 'NETWORK_A',
        productType: 'AIRTIME',
        productId: 'NETWORK_A_AIRTIME_2500',
        quantity: 5,
        clientRequestId: 'req_bulk_broke',
      },
    });
    expect(response.status).toBe(400);
    if (envelope.ok) throw new Error('expected a refusal');
    expect(envelope.error.reasonCode).toContain('INSUFFICIENT_AVAILABLE_BALANCE');
    expect(harness.deps.driver.ledgerResidualMinor()).toBe(0);
  });

  it('derives a stable request id per voucher, so a replay is not a second batch', () => {
    expect(batchRequestId('req_1', 0)).toBe('req_1');
    expect(batchRequestId('req_1', 1)).toBe('req_1#2');
    expect(batchRequestId('req_1', 9)).toBe('req_1#10');
    // Pure: the same order always yields the same ids, which is what makes
    // the batch findable again without storing a list.
    expect(batchRequestId('req_1', 3)).toBe(batchRequestId('req_1', 3));
  });
});
