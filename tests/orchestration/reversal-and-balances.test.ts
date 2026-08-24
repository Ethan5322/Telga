/**
 * The reversal workflow, and the balance and ledger properties that must hold
 * across every orchestration path.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { fromBirr, transactionId } from '@telga/domain';
import { completeReversal, createSale, requireReversal, resolvePending } from '@telga/api';
import type { ReversalApproval } from '@telga/api';
import { DEVICE_B, makeHarness, MERCHANT_A, MERCHANT_B, saleRequest } from './helpers';
import type { Harness } from './helpers';

/** A reversal moves money, so it needs a supervisor. */
const SUPERVISOR: ReversalApproval = { approvedBy: 'ops_approver_1', role: 'OPS_APPROVER' };

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

async function underReviewSale(h: Harness) {
  const result = await createSale(h.deps, saleRequest());
  const txId = transactionId((result as { transactionId: string }).transactionId);
  h.clock.advance(400_000);
  await resolvePending(h.deps, txId, MERCHANT_A);
  return txId;
}

describe('reversal from under review', () => {
  it('UNDER_REVIEW to REVERSAL_REQUIRED to REVERSED returns the value', async () => {
    const h = harness('reversal', { behaviour: 'TIMEOUT', pendingMaximumMs: 300_000 });
    const txId = await underReviewSale(h);

    expect(h.driver.balanceFor(MERCHANT_A).underReview.minor).toBe(2500);

    const required = requireReversal(h.deps, txId, MERCHANT_A, 'operations: value taken, not delivered');
    expect(required.kind).toBe('REVERSAL_REQUIRED');
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('REVERSAL_REQUIRED');

    const reversed = await completeReversal(h.deps, txId, MERCHANT_A, SUPERVISOR);
    expect(reversed.kind).toBe('REVERSED');
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('REVERSED');

    const view = h.driver.balanceFor(MERCHANT_A);
    expect(view.available.minor).toBe(10000);
    expect(view.underReview.minor).toBe(0);
    expect(view.reserved.minor).toBe(0);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });

  it('posts the return as new append-only entries, never an edit', async () => {
    const h = harness('reversal-append', { behaviour: 'TIMEOUT', pendingMaximumMs: 300_000 });
    const txId = await underReviewSale(h);
    const before = h.driver.readEntriesByTransaction(txId);

    requireReversal(h.deps, txId, MERCHANT_A, 'determined undelivered');
    await completeReversal(h.deps, txId, MERCHANT_A, SUPERVISOR);

    const after = h.driver.readEntriesByTransaction(txId);
    expect(after.length).toBeGreaterThan(before.length);
    for (const original of before) {
      expect(after).toContainEqual(original);
    }
  });

  it('a repeated reversal callback does not reverse twice', async () => {
    const h = harness('reversal-twice', { behaviour: 'TIMEOUT', pendingMaximumMs: 300_000 });
    const txId = await underReviewSale(h);

    requireReversal(h.deps, txId, MERCHANT_A, 'determined undelivered');
    const first = await completeReversal(h.deps, txId, MERCHANT_A, SUPERVISOR);
    const second = await completeReversal(h.deps, txId, MERCHANT_A, SUPERVISOR);
    const third = await completeReversal(h.deps, txId, MERCHANT_A, SUPERVISOR);

    expect([first.kind, second.kind, third.kind]).toEqual(['REVERSED', 'REVERSED', 'REVERSED']);
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(10000);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });

  it('requiring a reversal twice is idempotent', async () => {
    const h = harness('reversal-require-twice', { behaviour: 'TIMEOUT', pendingMaximumMs: 300_000 });
    const txId = await underReviewSale(h);

    const first = requireReversal(h.deps, txId, MERCHANT_A, 'reason');
    const second = requireReversal(h.deps, txId, MERCHANT_A, 'reason');

    expect(first.kind).toBe('REVERSAL_REQUIRED');
    expect(second.kind).toBe('REVERSAL_REQUIRED');
    expect(h.driver.findSupportCasesByMerchant(MERCHANT_A)).toHaveLength(1);
  });

  it('carries a support reference the merchant can quote', async () => {
    const h = harness('reversal-reference', { behaviour: 'TIMEOUT', pendingMaximumMs: 300_000 });
    const txId = await underReviewSale(h);

    const required = requireReversal(h.deps, txId, MERCHANT_A, 'reason');
    expect((required as { supportReference: string }).supportReference.length).toBeGreaterThan(0);
    expect(required.nextAction).toBe('CONTACT_SUPPORT_WITH_REFERENCE');
  });

  it('refuses a reversal from a state the domain does not allow', async () => {
    const h = harness('reversal-illegal', { behaviour: 'SUCCESS' });
    const sale = await createSale(h.deps, saleRequest());
    const txId = transactionId((sale as { transactionId: string }).transactionId);

    const result = requireReversal(h.deps, txId, MERCHANT_A, 'should not be allowed');
    expect(result.kind).toBe('INVALID_REQUEST');
    expect((result as { reasonCode: string }).reasonCode).toBe('REVERSAL_NOT_LEGAL_FROM_SUCCESSFUL');
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('SUCCESSFUL');
  });

  it('refuses a reversal without supervisor approval', async () => {
    const h = harness('reversal-approval', { behaviour: 'TIMEOUT', pendingMaximumMs: 300_000 });
    const txId = await underReviewSale(h);
    requireReversal(h.deps, txId, MERCHANT_A, 'determined undelivered');

    const refused = await completeReversal(h.deps, txId, MERCHANT_A, {
      approvedBy: 'operator_alpha_1',
      role: 'MERCHANT_OPERATOR',
    });

    expect(refused.kind).toBe('UNAUTHORIZED');
    // Nothing moved: the value is still held under review.
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('REVERSAL_REQUIRED');
    expect(h.driver.balanceFor(MERCHANT_A).underReview.minor).toBe(2500);
  });

  it('records the approving supervisor on the support case', async () => {
    const h = harness('reversal-approver', { behaviour: 'TIMEOUT', pendingMaximumMs: 300_000 });
    const txId = await underReviewSale(h);
    requireReversal(h.deps, txId, MERCHANT_A, 'determined undelivered');
    await completeReversal(h.deps, txId, MERCHANT_A, SUPERVISOR);

    expect(h.driver.findSupportCaseByTransaction(txId, MERCHANT_A)?.approved_by).toBe('ops_approver_1');
  });

  it('another merchant cannot reverse this transaction', async () => {
    const h = harness('reversal-scope', {
      behaviour: 'TIMEOUT',
      pendingMaximumMs: 300_000,
      seedSecondMerchant: true,
    });
    const txId = await underReviewSale(h);

    const result = requireReversal(h.deps, txId, MERCHANT_B, 'not yours');
    expect(result.kind).toBe('UNAUTHORIZED');
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('UNDER_REVIEW');
  });
});

describe('balance properties across the orchestration', () => {
  it('available decreases and reserved increases on reservation', async () => {
    const h = harness('bal-reserve', { behaviour: 'TIMEOUT', pendingMaximumMs: 300_000 });
    const before = h.driver.balanceFor(MERCHANT_A);
    await createSale(h.deps, saleRequest());
    const after = h.driver.balanceFor(MERCHANT_A);

    expect(after.available.minor).toBe(before.available.minor - 2500);
    expect(after.reserved.minor).toBe(before.reserved.minor + 2500);
    expect(after.total.minor).toBe(before.total.minor);
  });

  it('under-review value is excluded from available', async () => {
    const h = harness('bal-review', { behaviour: 'TIMEOUT', pendingMaximumMs: 300_000 });
    await underReviewSale(h);
    const view = h.driver.balanceFor(MERCHANT_A);

    expect(view.underReview.minor).toBe(2500);
    expect(view.available.minor).toBe(7500);
    expect(view.available.minor + view.reserved.minor + view.underReview.minor).toBe(view.total.minor);
  });

  it('BANK_CLEARING never appears in a merchant-facing view', async () => {
    const h = harness('bal-clearing', { behaviour: 'SUCCESS' });
    await createSale(h.deps, saleRequest());

    const clearing = h.driver.readEntriesByAccount('acct_platform_bank_clearing');
    expect(clearing.length).toBeGreaterThan(0);
    expect(clearing.every((e) => e.merchant_id === null)).toBe(true);

    const view = h.driver.balanceFor(MERCHANT_A);
    expect(view.available.minor + view.reserved.minor + view.underReview.minor).toBe(view.total.minor);
    expect(view.total.minor).toBe(7500);
  });

  it('every posting stays balanced across a mixed sequence of sales', async () => {
    const h = harness('bal-mixed', { behaviour: 'SUCCESS', fundBirr: 1000, seedSecondMerchant: true });

    for (let i = 0; i < 12; i += 1) {
      await createSale(
        h.deps,
        saleRequest({ clientRequestId: `req_${String(i)}`, amount: fromBirr(1, i) }),
      );
    }
    await createSale(h.deps, saleRequest({ merchantId: MERCHANT_B, deviceId: DEVICE_B, clientRequestId: 'req_b' }));

    expect(h.driver.ledgerResidualMinor()).toBe(0);
    for (const merchant of [MERCHANT_A, MERCHANT_B]) {
      const view = h.driver.balanceFor(merchant);
      expect(view.available.minor + view.reserved.minor + view.underReview.minor).toBe(view.total.minor);
    }
    expect(h.driver.health().healthy).toBe(true);
  });

  it('merchant A cannot read or affect merchant B balances through a sale', async () => {
    const h = harness('bal-isolation', { behaviour: 'SUCCESS', seedSecondMerchant: true });
    await createSale(h.deps, saleRequest());

    expect(h.driver.balanceFor(MERCHANT_B).total.minor).toBe(10000);
    expect(h.driver.readEntriesByMerchant(MERCHANT_B).every((e) => e.merchant_id === MERCHANT_B)).toBe(true);
    expect(h.driver.findTransactionsByMerchant(MERCHANT_B)).toHaveLength(0);
  });

  it('the ledger remains append-only after a full lifecycle', async () => {
    const h = harness('bal-append-only', { behaviour: 'TIMEOUT', pendingMaximumMs: 300_000 });
    const txId = await underReviewSale(h);
    requireReversal(h.deps, txId, MERCHANT_A, 'determined undelivered');
    await completeReversal(h.deps, txId, MERCHANT_A, SUPERVISOR);

    expect(() => {
      h.driver.unsafeConnection.prepare('UPDATE ledger_entries SET amount_minor = 1').run();
    }).toThrow(/append-only/i);
    expect(() => {
      h.driver.unsafeConnection.prepare('DELETE FROM ledger_entries').run();
    }).toThrow(/append-only/i);
  });
});
