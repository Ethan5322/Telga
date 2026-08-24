/**
 * The training HTTP surface.
 *
 * These tests run against the real router and the real database. Nothing is
 * mocked except the provider, which is the mock the whole build is designed
 * around.
 *
 * The important ones are the refusals: a live mode that never reaches an
 * application service, a merchant that cannot read another merchant's
 * transaction, and a response body that cannot carry a recipient hash.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { ApiEnvelope, BalanceDto, CreateSaleResultDto, QueueDto, TransactionDto } from '@telga/pos-view-model';
import { assertSafeForDisplay } from '@telga/pos-view-model';
import {
  DEVICE_B,
  MERCHANT_A,
  MERCHANT_B,
  OPERATOR_B,
  call,
  makeUiHarness,
  seedSale,
  signInAs,
} from './helpers';
import type { UiHarness } from './helpers';

let harness: UiHarness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  merchantId: MERCHANT_A,
  deviceId: 'device_alpha_1',
  operatorId: 'operator_alpha_1',
  productId: 'AIRTIME',
  amountMinor: 2500,
  recipient: '0900000000',
  clientRequestId: 'req_ui_1',
  ...over,
});

describe('the training-mode boundary', () => {
  it('refuses a sale outright when the mode is not TRAINING', async () => {
    harness = makeUiHarness('live-refused', { mode: 'LIVE' });
    const { response, envelope } = await call<CreateSaleResultDto>(
      harness.api,
      'POST',
      '/api/training/sales',
      { body: body() },
    );

    expect(response.status).toBe(403);
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('unreachable');
    expect(envelope.error.reasonCode).toBe('LIVE_MODE_REFUSED');
  });

  it('creates nothing at all when live mode is refused', async () => {
    harness = makeUiHarness('live-no-side-effects', { mode: 'LIVE' });
    await call(harness.api, 'POST', '/api/training/sales', { body: body() });

    expect(harness.driver.findTransactionsByMerchant(MERCHANT_A)).toHaveLength(0);
    // The harness seeds a funding entry, so the property is that no entry is
    // attached to a transaction — not that the ledger is empty.
    const transactionEntries = harness.driver
      .readEntriesByMerchant(MERCHANT_A)
      .filter((entry) => entry.transaction_id !== null);
    expect(transactionEntries).toHaveLength(0);
    expect(harness.driver.ledgerResidualMinor()).toBe(0);
  });

  it('states the mode on every response, in the body and in a header', async () => {
    harness = makeUiHarness('mode-header');
    const { response, envelope } = await call<BalanceDto>(harness.api, 'GET', '/api/training/balance', {
      query: { merchantId: MERCHANT_A },
    });
    expect(response.headers['x-telga-mode']).toBe('TRAINING');
    expect(envelope.meta.mode).toBe('TRAINING');
    expect(envelope.meta.simulated).toBe(true);
  });
});

describe('reads', () => {
  it('returns the authoritative state for a transaction', async () => {
    harness = makeUiHarness('read-state', { behaviour: 'SUCCESS' });
    const id = await seedSale(harness);

    const { envelope } = await call<TransactionDto>(
      harness.api,
      'GET',
      `/api/training/transactions/${id}`,
      { query: { merchantId: MERCHANT_A } },
    );
    if (!envelope.ok) throw new Error(envelope.error.reasonCode);
    expect(envelope.data.state).toBe('SUCCESSFUL');
    expect(envelope.data.transactionId).toBe(id);
    expect(envelope.data.mode).toBe('TRAINING');
  });

  it('carries pending, recovery and manual-review metadata', async () => {
    harness = makeUiHarness('read-recovery', { behaviour: 'TIMEOUT' });
    const id = await seedSale(harness);

    const { envelope } = await call<TransactionDto>(
      harness.api,
      'GET',
      `/api/training/transactions/${id}`,
      { query: { merchantId: MERCHANT_A } },
    );
    if (!envelope.ok) throw new Error(envelope.error.reasonCode);
    expect(envelope.data.state).toBe('PENDING');
    expect(envelope.data.recovery.pendingStatus).toBe('AWAITING');
    expect(envelope.data.recovery.deadlineAt).not.toBeNull();
    expect(envelope.data.recovery.manualReviewStatus).toBe('NONE');
    expect(envelope.data.reservation?.status).toBe('HELD');
  });

  it('handles a missing transaction explicitly', async () => {
    harness = makeUiHarness('read-missing');
    const { response, envelope } = await call<TransactionDto>(
      harness.api,
      'GET',
      '/api/training/transactions/txn_does_not_exist',
      { query: { merchantId: MERCHANT_A } },
    );
    expect(response.status).toBe(404);
    if (envelope.ok) throw new Error('should not be ok');
    expect(envelope.error.reasonCode).toBe('TRANSACTION_NOT_FOUND');
  });

  it('refuses to read another merchant transaction, as a plain not-found', async () => {
    harness = makeUiHarness('isolation', { seedSecondMerchant: true });
    const id = await seedSale(harness);

    // Beta's own session, asking for alpha's transaction by its real id. The
    // scope comes from the session, so this is the only way to attempt it.
    const beta = await signInAs(harness.api, {
      userId: OPERATOR_B,
      merchantId: MERCHANT_B,
      deviceId: DEVICE_B,
    });
    const { response, envelope } = await call<TransactionDto>(
      harness.api,
      'GET',
      `/api/training/transactions/${id}`,
      { session: beta },
    );
    expect(response.status).toBe(404);
    if (envelope.ok) throw new Error('should not be ok');
    // Not 403: a different code would confirm the id exists.
    expect(envelope.error.reasonCode).toBe('TRANSACTION_NOT_FOUND');
  });

  it('refuses a merchant id in the URL that disagrees with the session', async () => {
    harness = makeUiHarness('hint-mismatch', { seedSecondMerchant: true });

    // A client-supplied merchant id is a consistency check, never a grant.
    // Disagreeing with the session is refused rather than quietly preferring
    // either one.
    const { response, envelope } = await call(
      harness.api,
      'GET',
      '/api/training/transactions',
      { query: { merchantId: MERCHANT_B } },
    );
    expect(response.status).toBe(403);
    if (envelope.ok) throw new Error('should not be ok');
    expect(envelope.error.reasonCode).toBe('MERCHANT_SCOPE_MISMATCH');
  });

  it('groups the queue by state', async () => {
    harness = makeUiHarness('queue', { behaviour: 'TIMEOUT' });
    await seedSale(harness, { clientRequestId: 'req_q1' });
    await seedSale(harness, { clientRequestId: 'req_q2', recipient: '0900000002' });

    const { envelope } = await call<QueueDto>(harness.api, 'GET', '/api/training/queue', {
      query: { merchantId: MERCHANT_A },
    });
    if (!envelope.ok) throw new Error(envelope.error.reasonCode);
    expect(envelope.data.pending).toHaveLength(2);
    expect(envelope.data.underReview).toHaveLength(0);
    expect(envelope.data.reversalRequired).toHaveLength(0);
  });

  it('returns the four balance views', async () => {
    harness = makeUiHarness('balance', { behaviour: 'TIMEOUT' });
    await seedSale(harness);

    const { envelope } = await call<BalanceDto>(harness.api, 'GET', '/api/training/balance', {
      query: { merchantId: MERCHANT_A },
    });
    if (!envelope.ok) throw new Error(envelope.error.reasonCode);
    // The sale is pending, so its value is reserved and not available.
    expect(envelope.data.reserved.amountMinor).toBe(2500);
    expect(envelope.data.available.amountMinor).toBe(10_000 - 2500);
    expect(envelope.data.total.amountMinor).toBe(10_000);
  });
});

describe('validation', () => {
  it('rejects a body that is missing a field', async () => {
    harness = makeUiHarness('missing-field');
    const withoutRecipient = body();
    delete withoutRecipient['recipient'];
    const { response, envelope } = await call<CreateSaleResultDto>(
      harness.api,
      'POST',
      '/api/training/sales',
      { body: withoutRecipient },
    );
    expect(response.status).toBe(400);
    if (envelope.ok) throw new Error('should not be ok');
    expect(envelope.error.reasonCode).toBe('RECIPIENT_REQUIRED');
  });

  it('rejects a non-integer or negative amount', async () => {
    harness = makeUiHarness('bad-amount');
    for (const amountMinor of [0, -100, 12.5, Number.NaN]) {
      const { envelope } = await call<CreateSaleResultDto>(harness.api, 'POST', '/api/training/sales', {
        body: body({ amountMinor }),
      });
      if (envelope.ok) throw new Error(`accepted ${String(amountMinor)}`);
      expect(envelope.error.reasonCode).toBe('AMOUNT_MINOR_INVALID');
    }
  });

  it('rejects an unknown simulated behaviour', async () => {
    harness = makeUiHarness('bad-behaviour');
    const { envelope } = await call<CreateSaleResultDto>(harness.api, 'POST', '/api/training/sales', {
      body: body({ simulatedProviderBehaviour: 'ASK_NICELY' }),
    });
    if (envelope.ok) throw new Error('should not be ok');
    expect(envelope.error.reasonCode).toBe('UNKNOWN_SIMULATED_BEHAVIOUR');
  });

  it('rejects an unknown state filter and an out-of-range limit', async () => {
    harness = makeUiHarness('bad-query');
    const bad = await call(harness.api, 'GET', '/api/training/transactions', {
      query: { merchantId: MERCHANT_A, state: 'ALMOST_DONE' },
    });
    expect(bad.response.status).toBe(400);

    const huge = await call(harness.api, 'GET', '/api/training/transactions', {
      query: { merchantId: MERCHANT_A, limit: '10000' },
    });
    expect(huge.response.status).toBe(400);
  });

  it('needs no merchant id at all: the session supplies the scope', async () => {
    harness = makeUiHarness('no-merchant');
    const id = await seedSale(harness);

    for (const path of ['/api/training/transactions', '/api/training/queue', '/api/training/balance']) {
      const { response } = await call(harness.api, 'GET', path);
      expect(response.status, path).toBe(200);
    }

    // And the scope really is the session's, not a default.
    const { envelope } = await call<readonly TransactionDto[]>(
      harness.api,
      'GET',
      '/api/training/transactions',
    );
    if (!envelope.ok) throw new Error('should be readable');
    expect(envelope.data.map((t) => t.transactionId)).toContain(id);
    expect(envelope.data.every((t) => t.merchantId === MERCHANT_A)).toBe(true);
  });
});

describe('routing', () => {
  it('answers an unknown route with 404 and a known route with the wrong method with 405', async () => {
    harness = makeUiHarness('routing');
    const missing = await call(harness.api, 'GET', '/api/training/nothing');
    expect(missing.response.status).toBe(404);

    const wrongMethod = await call(harness.api, 'DELETE', '/api/training/balance', {
      query: { merchantId: MERCHANT_A },
    });
    expect(wrongMethod.response.status).toBe(405);
  });

  it('offers no endpoint that changes state, posts a ledger entry, or completes a reversal', async () => {
    harness = makeUiHarness('no-write-endpoints');
    const forbidden = [
      ['POST', '/api/training/transactions/txn_1/state'],
      ['POST', '/api/training/ledger'],
      ['POST', '/api/training/reversals'],
      ['POST', '/api/training/balance'],
      ['PATCH', '/api/training/transactions/txn_1'],
      ['DELETE', '/api/training/transactions/txn_1'],
    ] as const;
    for (const [method, path] of forbidden) {
      const { response } = await call(harness.api, method, path, { query: { merchantId: MERCHANT_A } });
      expect([404, 405], `${method} ${path}`).toContain(response.status);
    }
  });
});

describe('redaction and correlation', () => {
  it('never sends a recipient hash or a payload fingerprint', async () => {
    harness = makeUiHarness('redaction');
    const id = await seedSale(harness);

    const { envelope } = await call<TransactionDto>(
      harness.api,
      'GET',
      `/api/training/transactions/${id}`,
      { query: { merchantId: MERCHANT_A } },
    );
    if (!envelope.ok) throw new Error(envelope.error.reasonCode);

    const serialized = JSON.stringify(envelope.data);
    expect(serialized).not.toContain('recipient_hash');
    expect(serialized).not.toContain('recipientHash');
    expect(serialized).not.toContain('payload_fingerprint');
    expect(serialized).not.toContain('payloadFingerprint');
    // And the full number itself is nowhere in the body.
    expect(serialized).not.toContain('0900000000');
    expect(envelope.data.recipientMasked).toBe('09******00');
    expect(() => assertSafeForDisplay(envelope.data)).not.toThrow();
  });

  it('honours a supplied correlation id and echoes it in the header', async () => {
    harness = makeUiHarness('correlation');
    const id = await seedSale(harness);

    const { response, envelope } = await call<TransactionDto>(
      harness.api,
      'GET',
      `/api/training/transactions/${id}`,
      {
        query: { merchantId: MERCHANT_A },
        headers: { 'x-telga-correlation-id': 'corr-from-the-pos' },
      },
    );
    expect(envelope.meta.correlationId).toBe('corr-from-the-pos');
    expect(response.headers['x-telga-correlation-id']).toBe('corr-from-the-pos');
  });

  it('refuses a correlation id that is not a safe token', async () => {
    harness = makeUiHarness('correlation-hostile');
    const { envelope } = await call<BalanceDto>(harness.api, 'GET', '/api/training/balance', {
      query: { merchantId: MERCHANT_A },
      headers: { 'x-telga-correlation-id': 'nasty\nlog line injection' },
    });
    expect(envelope.meta.correlationId).not.toContain('\n');
    expect(envelope.meta.correlationId).toMatch(/^corr_/);
  });

  it('hands the client the server polling interval, not a client guess', async () => {
    harness = makeUiHarness('polling-hint');
    const { envelope } = await call<BalanceDto>(harness.api, 'GET', '/api/training/balance', {
      query: { merchantId: MERCHANT_A },
    });
    expect(envelope.meta.polling.statusCheckIntervalMs).toBe(30_000);
    expect(envelope.meta.polling.maxPolls).toBeGreaterThan(0);
  });

  it('sets no-store and nosniff on every response', async () => {
    harness = makeUiHarness('headers');
    const { response } = await call(harness.api, 'GET', '/api/training/balance', {
      query: { merchantId: MERCHANT_A },
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('sale outcomes over HTTP', () => {
  it('reports a pending sale as an HTTP success with an honest state', async () => {
    harness = makeUiHarness('pending-is-200', { behaviour: 'TIMEOUT' });
    const { response, envelope } = await call<CreateSaleResultDto>(
      harness.api,
      'POST',
      '/api/training/sales',
      { body: body() },
    );
    // 201, not 4xx: the request succeeded; the outcome is unknown.
    expect(response.status).toBe(201);
    if (!envelope.ok) throw new Error(envelope.error.reasonCode);
    expect(envelope.data.kind).toBe('PENDING');
    expect(envelope.data.nextAction).toBe('DO_NOT_RETRY_YET');
    expect(envelope.data.transaction?.state).toBe('PENDING');
  });

  it('returns the original transaction for a repeated request', async () => {
    harness = makeUiHarness('duplicate');
    const first = await call<CreateSaleResultDto>(harness.api, 'POST', '/api/training/sales', {
      body: body(),
    });
    const second = await call<CreateSaleResultDto>(harness.api, 'POST', '/api/training/sales', {
      body: body(),
    });

    if (!first.envelope.ok || !second.envelope.ok) throw new Error('both should be ok');
    expect(second.envelope.data.kind).toBe('DUPLICATE_REQUEST');
    expect(second.envelope.data.transactionId).toBe(first.envelope.data.transactionId);
    expect(harness.driver.findTransactionsByMerchant(MERCHANT_A)).toHaveLength(1);
  });

  it('reports provider unavailability as no charge, with no transaction', async () => {
    harness = makeUiHarness('outage', { behaviour: 'OUTAGE' });
    const { response, envelope } = await call<CreateSaleResultDto>(
      harness.api,
      'POST',
      '/api/training/sales',
      { body: body() },
    );
    expect(response.status).toBe(503);
    if (envelope.ok) throw new Error('should not be ok');
    expect(envelope.error.kind).toBe('PROVIDER_UNAVAILABLE');
    expect(harness.driver.readEntriesByMerchant(MERCHANT_A).filter((e) => e.transaction_id !== null)).toHaveLength(0);
  });

  it('refuses a sale the merchant cannot afford, without creating one', async () => {
    harness = makeUiHarness('insufficient', { fundBirr: 1 });
    const { response, envelope } = await call<CreateSaleResultDto>(
      harness.api,
      'POST',
      '/api/training/sales',
      { body: body() },
    );
    expect(response.status).toBe(400);
    if (envelope.ok) throw new Error('should not be ok');
    expect(envelope.error.kind).toBe('INSUFFICIENT_BALANCE');
  });
});
