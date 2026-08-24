/**
 * Resolving a PENDING transaction: delayed success, delayed failure, escalation
 * to under review, and the repeat-safety guards.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { transactionId } from '@telga/domain';
import { createSale, resolvePending, requireReversal } from '@telga/api';
import { makeHarness, MERCHANT_A, saleRequest } from './helpers';
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

async function pendingSale(h: Harness, behaviour: 'TIMEOUT' | 'DELAYED_SUCCESS' | 'DELAYED_FAILURE') {
  expect(behaviour).toBeDefined();
  const result = await createSale(h.deps, saleRequest());
  expect(result.kind).toBe('PENDING');
  return transactionId((result as { transactionId: string }).transactionId);
}

describe('delayed success', () => {
  it('PENDING to SUCCESSFUL finalizes exactly once', async () => {
    const h = harness('delayed-success', { behaviour: 'DELAYED_SUCCESS', delayTicks: 1 });
    const txId = await pendingSale(h, 'DELAYED_SUCCESS');

    expect(h.driver.balanceFor(MERCHANT_A).reserved.minor).toBe(2500);

    h.provider.advance(1);
    const resolved = await resolvePending(h.deps, txId, MERCHANT_A);

    expect(resolved.kind).toBe('SUCCESSFUL');
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('SUCCESSFUL');
    expect(h.driver.findReservation(txId, MERCHANT_A)?.status).toBe('SETTLED');

    const view = h.driver.balanceFor(MERCHANT_A);
    expect(view.available.minor).toBe(7500);
    expect(view.reserved.minor).toBe(0);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });

  it('never creates a second reservation, debit or sale', async () => {
    const h = harness('delayed-success-once', { behaviour: 'DELAYED_SUCCESS', delayTicks: 1 });
    const txId = await pendingSale(h, 'DELAYED_SUCCESS');
    h.provider.advance(1);
    await resolvePending(h.deps, txId, MERCHANT_A);

    expect(h.driver.findReservationsByMerchant(MERCHANT_A)).toHaveLength(1);
    expect(h.driver.findTransactionsByMerchant(MERCHANT_A)).toHaveLength(1);
    const settlement = h.driver
      .readEntriesByTransaction(txId)
      .filter((e) => e.account_type === 'PROVIDER_SETTLEMENT');
    expect(settlement).toHaveLength(1);
  });

  it('closes the pending job and audits the resolution', async () => {
    const h = harness('delayed-success-job', { behaviour: 'DELAYED_SUCCESS', delayTicks: 1 });
    const txId = await pendingSale(h, 'DELAYED_SUCCESS');
    h.provider.advance(1);
    await resolvePending(h.deps, txId, MERCHANT_A);

    expect(h.driver.findPendingResolution(txId)?.status).toBe('RESOLVED');
    expect(h.driver.findPendingResolution(txId)?.attempts).toBe(1);
    const events = h.driver.readAuditEvents(MERCHANT_A);
    expect(events.filter((e) => e.event_type === 'TRANSACTION_TRANSITIONED').length).toBeGreaterThan(1);
  });

  it('a repeated callback does not finalize twice', async () => {
    const h = harness('repeat-success', { behaviour: 'DELAYED_SUCCESS', delayTicks: 1 });
    const txId = await pendingSale(h, 'DELAYED_SUCCESS');
    h.provider.advance(1);

    const first = await resolvePending(h.deps, txId, MERCHANT_A);
    const second = await resolvePending(h.deps, txId, MERCHANT_A);
    const third = await resolvePending(h.deps, txId, MERCHANT_A);

    expect([first.kind, second.kind, third.kind]).toEqual(['SUCCESSFUL', 'SUCCESSFUL', 'SUCCESSFUL']);
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(7500);
    const settlement = h.driver
      .readEntriesByTransaction(txId)
      .filter((e) => e.account_type === 'PROVIDER_SETTLEMENT');
    expect(settlement).toHaveLength(1);
  });
});

describe('delayed failure', () => {
  it('PENDING to FAILED releases exactly once', async () => {
    const h = harness('delayed-failure', { behaviour: 'DELAYED_FAILURE', delayTicks: 1 });
    const txId = await pendingSale(h, 'DELAYED_FAILURE');
    h.provider.advance(1);

    const resolved = await resolvePending(h.deps, txId, MERCHANT_A);
    expect(resolved.kind).toBe('FAILED');
    expect(h.driver.findReservation(txId, MERCHANT_A)?.status).toBe('RELEASED');
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(10000);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });

  it('a repeated failure callback does not release twice', async () => {
    const h = harness('repeat-failure', { behaviour: 'DELAYED_FAILURE', delayTicks: 1 });
    const txId = await pendingSale(h, 'DELAYED_FAILURE');
    h.provider.advance(1);

    await resolvePending(h.deps, txId, MERCHANT_A);
    await resolvePending(h.deps, txId, MERCHANT_A);
    await resolvePending(h.deps, txId, MERCHANT_A);

    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(10000);
    const releases = h.driver
      .readEntriesByTransaction(txId)
      .filter((e) => e.entry_type === 'REVERSAL' && e.direction === 'CREDIT');
    expect(releases).toHaveLength(1);
  });
});

describe('still pending', () => {
  it('stays PENDING before the deadline and holds the value', async () => {
    const h = harness('still-pending', { behaviour: 'TIMEOUT', pendingMaximumMs: 300_000 });
    const txId = await pendingSale(h, 'TIMEOUT');

    h.clock.advance(60_000);
    const again = await resolvePending(h.deps, txId, MERCHANT_A);

    expect(again.kind).toBe('PENDING');
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('PENDING');
    expect(h.driver.balanceFor(MERCHANT_A).reserved.minor).toBe(2500);
  });

  it('a status lookup does not create a new transaction', async () => {
    const h = harness('lookup-no-tx', { behaviour: 'TIMEOUT', pendingMaximumMs: 300_000 });
    const txId = await pendingSale(h, 'TIMEOUT');

    h.clock.advance(30_000);
    await resolvePending(h.deps, txId, MERCHANT_A);
    await resolvePending(h.deps, txId, MERCHANT_A);

    expect(h.driver.findTransactionsByMerchant(MERCHANT_A)).toHaveLength(1);
    expect(h.driver.findPendingResolution(txId)?.attempts).toBe(2);
  });
});

describe('escalation to under review', () => {
  it('moves value to the under-review bucket past the deadline', async () => {
    const h = harness('escalate', { behaviour: 'TIMEOUT', pendingMaximumMs: 300_000 });
    const txId = await pendingSale(h, 'TIMEOUT');

    h.clock.advance(400_000);
    const escalated = await resolvePending(h.deps, txId, MERCHANT_A);

    expect(escalated.kind).toBe('UNDER_REVIEW');
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('UNDER_REVIEW');

    const view = h.driver.balanceFor(MERCHANT_A);
    expect(view.underReview.minor).toBe(2500);
    expect(view.reserved.minor).toBe(0);
    expect(view.available.minor).toBe(7500);
    expect(view.total.minor).toBe(10000);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });

  it('opens a support case with a reference the merchant can quote', async () => {
    const h = harness('escalate-case', { behaviour: 'TIMEOUT', pendingMaximumMs: 300_000 });
    const txId = await pendingSale(h, 'TIMEOUT');

    h.clock.advance(400_000);
    const escalated = await resolvePending(h.deps, txId, MERCHANT_A);

    const supportReference = (escalated as { supportReference: string }).supportReference;
    expect(supportReference.length).toBeGreaterThan(0);
    expect(escalated.nextAction).toBe('CONTACT_SUPPORT_WITH_REFERENCE');

    const openCase = h.driver.findSupportCaseByTransaction(txId, MERCHANT_A);
    expect(openCase?.reason).toBe('UNDER_REVIEW');
    expect(openCase?.status).toBe('OPEN');
  });

  it('preserves the transaction and provider references on every posting', async () => {
    const h = harness('escalate-refs', { behaviour: 'TIMEOUT', pendingMaximumMs: 300_000 });
    const txId = await pendingSale(h, 'TIMEOUT');
    h.clock.advance(400_000);
    await resolvePending(h.deps, txId, MERCHANT_A);

    const entries = h.driver.readEntriesByTransaction(txId, MERCHANT_A);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.transaction_id === txId)).toBe(true);
    expect(new Set(entries.map((e) => e.correlation_id)).size).toBe(1);
  });

  it('does not finalize, refund or release automatically', async () => {
    const h = harness('escalate-nofinal', { behaviour: 'TIMEOUT', pendingMaximumMs: 300_000 });
    const txId = await pendingSale(h, 'TIMEOUT');
    h.clock.advance(400_000);
    await resolvePending(h.deps, txId, MERCHANT_A);

    const entries = h.driver.readEntriesByTransaction(txId);
    expect(entries.some((e) => e.account_type === 'PROVIDER_SETTLEMENT')).toBe(false);
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(7500);
    expect(h.driver.findReservation(txId, MERCHANT_A)?.status).toBe('UNDER_REVIEW');
  });

  it('escalating twice changes nothing', async () => {
    const h = harness('escalate-twice', { behaviour: 'TIMEOUT', pendingMaximumMs: 300_000 });
    const txId = await pendingSale(h, 'TIMEOUT');
    h.clock.advance(400_000);

    await resolvePending(h.deps, txId, MERCHANT_A);
    const second = await resolvePending(h.deps, txId, MERCHANT_A);

    expect(second.kind).toBe('UNDER_REVIEW');
    expect(h.driver.balanceFor(MERCHANT_A).underReview.minor).toBe(2500);
    expect(h.driver.findSupportCasesByMerchant(MERCHANT_A)).toHaveLength(1);
  });
});

describe('scoping', () => {
  it('another merchant cannot resolve this transaction', async () => {
    const h = harness('resolve-scope', {
      behaviour: 'TIMEOUT',
      seedSecondMerchant: true,
      pendingMaximumMs: 300_000,
    });
    const txId = await pendingSale(h, 'TIMEOUT');

    const result = await resolvePending(h.deps, txId, 'merchant_beta' as never);
    expect(result.kind).toBe('UNAUTHORIZED');
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('PENDING');
  });

  it('a reversal can be required directly from PENDING', async () => {
    const h = harness('pending-reversal', { behaviour: 'TIMEOUT', pendingMaximumMs: 300_000 });
    const txId = await pendingSale(h, 'TIMEOUT');

    const required = requireReversal(h.deps, txId, MERCHANT_A, 'callback: value taken, not delivered');
    expect(required.kind).toBe('REVERSAL_REQUIRED');
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('REVERSAL_REQUIRED');
    expect(h.driver.findPendingResolution(txId)?.status).toBe('ESCALATED');
  });
});
