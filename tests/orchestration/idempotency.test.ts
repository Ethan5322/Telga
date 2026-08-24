/**
 * Idempotency across the whole orchestration.
 *
 * The property that matters: one merchant intent produces exactly one logical
 * transaction, one reservation and one ledger effect, no matter how many times
 * the request, the retry or the callback arrives.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { fromBirr, transactionId } from '@telga/domain';
import { createSale, resolvePending } from '@telga/api';
import { makeHarness, MERCHANT_A, MERCHANT_B, DEVICE_B, saleRequest } from './helpers';
import type { Harness } from './helpers';

let harnesses: Harness[] = [];
const harness = (name: string, options: Parameters<typeof makeHarness>[1] = {}): Harness => {
  const h = makeHarness(name, options);
  harnesses.push(h);
  return h;
};

afterEach(() => {
  for (const h of harnesses) h.cleanup();
  harnesses = [];
});

describe('same identity, same payload', () => {
  it('returns the original transaction rather than selling again', async () => {
    const h = harness('idem-replay', { behaviour: 'SUCCESS' });
    const first = await createSale(h.deps, saleRequest());
    const second = await createSale(h.deps, saleRequest());

    expect(first.kind).toBe('SUCCESSFUL');
    expect(second.kind).toBe('DUPLICATE_REQUEST');
    expect((second as { originalTransactionId: string }).originalTransactionId).toBe(
      (first as { transactionId: string }).transactionId,
    );
    expect((second as { state: string }).state).toBe('SUCCESSFUL');
    expect(second.nextAction).toBe('SHOW_EXISTING_TRANSACTION_STATE');
  });

  it('debits only once across ten rapid presses', async () => {
    const h = harness('idem-ten', { behaviour: 'SUCCESS' });
    const results = [];
    for (let i = 0; i < 10; i += 1) {
      results.push(await createSale(h.deps, saleRequest()));
    }

    expect(results.filter((r) => r.kind === 'SUCCESSFUL')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'DUPLICATE_REQUEST')).toHaveLength(9);
    expect(h.driver.findTransactionsByMerchant(MERCHANT_A)).toHaveLength(1);
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(7500);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });

  it('concurrent duplicate requests produce one logical transaction', async () => {
    const h = harness('idem-concurrent', { behaviour: 'SUCCESS' });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => createSale(h.deps, saleRequest())),
    );

    const successes = results.filter((r) => r.kind === 'SUCCESSFUL');
    expect(successes.length).toBeLessThanOrEqual(1);
    expect(h.driver.findTransactionsByMerchant(MERCHANT_A)).toHaveLength(1);
    expect(h.driver.findReservationsByMerchant(MERCHANT_A)).toHaveLength(1);
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(7500);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });
});

describe('same identity, different payload', () => {
  it('rejects a changed amount', async () => {
    const h = harness('idem-amount', { behaviour: 'SUCCESS' });
    await createSale(h.deps, saleRequest());
    const tampered = await createSale(h.deps, saleRequest({ amount: fromBirr(50) }));

    expect(tampered.kind).toBe('PAYLOAD_MISMATCH');
    expect((tampered as { reasonCode: string }).reasonCode).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
    expect(h.driver.findTransactionsByMerchant(MERCHANT_A)).toHaveLength(1);
  });

  it('rejects a changed recipient', async () => {
    const h = harness('idem-recipient', { behaviour: 'SUCCESS' });
    await createSale(h.deps, saleRequest());
    const tampered = await createSale(h.deps, saleRequest({ recipient: '0911111111' }));

    expect(tampered.kind).toBe('PAYLOAD_MISMATCH');
    expect(h.driver.findTransactionsByMerchant(MERCHANT_A)).toHaveLength(1);
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(7500);
  });

  it('leaves the original transaction untouched after a rejected mismatch', async () => {
    const h = harness('idem-untouched', { behaviour: 'SUCCESS' });
    const first = await createSale(h.deps, saleRequest());
    const txId = transactionId((first as { transactionId: string }).transactionId);
    await createSale(h.deps, saleRequest({ amount: fromBirr(50) }));

    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('SUCCESSFUL');
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.amount_minor).toBe(2500);
  });
});

describe('scoping between merchants', () => {
  it('two merchants may use the same client request id independently', async () => {
    const h = harness('idem-scope', { behaviour: 'SUCCESS', seedSecondMerchant: true });

    const a = await createSale(h.deps, saleRequest());
    const b = await createSale(
      h.deps,
      saleRequest({ merchantId: MERCHANT_B, deviceId: DEVICE_B, clientRequestId: 'req_0001' }),
    );

    expect(a.kind).toBe('SUCCESSFUL');
    expect(b.kind).toBe('SUCCESSFUL');
    expect((a as { transactionId: string }).transactionId).not.toBe(
      (b as { transactionId: string }).transactionId,
    );
    expect(h.driver.findTransactionsByMerchant(MERCHANT_A)).toHaveLength(1);
    expect(h.driver.findTransactionsByMerchant(MERCHANT_B)).toHaveLength(1);
  });

  it("one merchant's sale never touches the other's balance", async () => {
    const h = harness('idem-scope-balance', { behaviour: 'SUCCESS', seedSecondMerchant: true });
    await createSale(h.deps, saleRequest());

    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(7500);
    expect(h.driver.balanceFor(MERCHANT_B).available.minor).toBe(10000);
  });
});

describe('retry after a timeout', () => {
  it('a retry does not create a new transaction', async () => {
    const h = harness('idem-timeout-retry', { behaviour: 'TIMEOUT', pendingMaximumMs: 300_000 });
    const first = await createSale(h.deps, saleRequest());
    expect(first.kind).toBe('PENDING');

    const retry = await createSale(h.deps, saleRequest());
    expect(retry.kind).toBe('DUPLICATE_REQUEST');
    expect((retry as { state: string }).state).toBe('PENDING');

    expect(h.driver.findTransactionsByMerchant(MERCHANT_A)).toHaveLength(1);
    expect(h.driver.findReservationsByMerchant(MERCHANT_A)).toHaveLength(1);
    expect(h.driver.balanceFor(MERCHANT_A).reserved.minor).toBe(2500);
  });

  it('a retry while pending does not create a second reservation or debit', async () => {
    const h = harness('idem-timeout-double', { behaviour: 'TIMEOUT', pendingMaximumMs: 300_000 });
    const first = await createSale(h.deps, saleRequest());
    const txId = transactionId((first as { transactionId: string }).transactionId);

    for (let i = 0; i < 5; i += 1) {
      await createSale(h.deps, saleRequest());
    }

    const entries = h.driver.readEntriesByTransaction(txId);
    const reserveCredits = entries.filter(
      (e) => e.account_type === 'MERCHANT_RESERVED' && e.direction === 'CREDIT',
    );
    expect(reserveCredits).toHaveLength(1);
    expect(h.driver.balanceFor(MERCHANT_A).total.minor).toBe(10000);
  });

  it('a status lookup after resolution does not re-run the sale', async () => {
    const h = harness('idem-lookup', { behaviour: 'DELAYED_SUCCESS', delayTicks: 1 });
    const first = await createSale(h.deps, saleRequest());
    const txId = transactionId((first as { transactionId: string }).transactionId);

    h.provider.advance(1);
    await resolvePending(h.deps, txId, MERCHANT_A);
    await resolvePending(h.deps, txId, MERCHANT_A);

    expect(h.driver.findTransactionsByMerchant(MERCHANT_A)).toHaveLength(1);
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(7500);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });
});
