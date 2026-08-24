/**
 * Unit-of-work consistency under injected failure.
 *
 * A failure is injected at each stage of a sale, and the assertion is always
 * the same shape: **nothing is half-done**. Either the whole unit of work
 * committed or none of it did, and the ledger still balances either way.
 *
 * Failures are injected by wrapping the driver in a proxy that throws on the
 * Nth call of a method, so there are no test-only hooks in the services.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { transactionId } from '@telga/domain';
import { createSale } from '@telga/api';
import { failAt, makeHarness, MERCHANT_A, saleRequest, withDriver } from './helpers';
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

/** Balance, reservations and ledger residual, for a before/after comparison. */
function snapshot(h: Harness) {
  const view = h.driver.balanceFor(MERCHANT_A);
  return {
    available: view.available.minor,
    reserved: view.reserved.minor,
    underReview: view.underReview.minor,
    total: view.total.minor,
    entries: h.driver.readEntries().length,
    transactions: h.driver.findTransactionsByMerchant(MERCHANT_A).length,
    reservations: h.driver.findReservationsByMerchant(MERCHANT_A).length,
    residual: h.driver.ledgerResidualMinor(),
  };
}

describe('failure before reservation', () => {
  it('leaves no transaction, no reservation and no entries', async () => {
    const h = harness('fail-before-reserve', { behaviour: 'SUCCESS' });
    const before = snapshot(h);

    const deps = withDriver(h.deps, failAt(h.driver, 'saveTransaction', 1));
    const result = await createSale(deps, saleRequest());

    expect(result.kind).toBe('PERSISTENCE_FAILURE');
    expect(snapshot(h)).toEqual(before);
  });

  it('reports a safe reason code, not the raw error', async () => {
    const h = harness('fail-before-reserve-safe', { behaviour: 'SUCCESS' });
    const deps = withDriver(h.deps, failAt(h.driver, 'saveTransaction', 1, new Error('SQLITE_BUSY: raw detail')));
    const result = await createSale(deps, saleRequest());

    expect(JSON.stringify(result)).not.toContain('raw detail');
    expect((result as { reasonCode: string }).reasonCode).toBe('UNEXPECTED_PERSISTENCE_ERROR');
  });
});

describe('failure after reservation, before provider submission', () => {
  it('rolls back the reservation with it', async () => {
    const h = harness('fail-after-reserve', { behaviour: 'SUCCESS' });
    const before = snapshot(h);

    // saveIdempotencyRecord runs after reserve() and before submit().
    const deps = withDriver(h.deps, failAt(h.driver, 'saveIdempotencyRecord', 1));
    const result = await createSale(deps, saleRequest());

    expect(result.kind).toBe('PERSISTENCE_FAILURE');
    expect(snapshot(h)).toEqual(before);
    expect(h.driver.balanceFor(MERCHANT_A).reserved.minor).toBe(0);
  });

  it('does not submit to the provider at all', async () => {
    const h = harness('fail-no-submit', { behaviour: 'SUCCESS' });
    const deps = withDriver(h.deps, failAt(h.driver, 'saveIdempotencyRecord', 1));
    await createSale(deps, saleRequest());

    expect(h.provider.peekCallbacks()).toHaveLength(0);
  });
});

describe('failure after provider success, before finalization', () => {
  it('propagates rather than reporting success', async () => {
    const h = harness('fail-before-final', { behaviour: 'SUCCESS' });
    // saveTransaction calls: CREATED, VALIDATED, RESERVED, PROCESSING, SUCCESSFUL.
    const deps = withDriver(h.deps, failAt(h.driver, 'saveTransaction', 5));

    await expect(createSale(deps, saleRequest())).rejects.toThrow(/injected failure/);
  });

  it('leaves the value reserved rather than debited, and the ledger balanced', async () => {
    const h = harness('fail-before-final-state', { behaviour: 'SUCCESS' });
    const deps = withDriver(h.deps, failAt(h.driver, 'saveTransaction', 5));

    await expect(createSale(deps, saleRequest())).rejects.toThrow();

    const view = h.driver.balanceFor(MERCHANT_A);
    expect(view.reserved.minor).toBe(2500);
    expect(view.available.minor).toBe(7500);
    expect(view.total.minor).toBe(10000);
    expect(h.driver.ledgerResidualMinor()).toBe(0);

    const settlement = h.driver.readEntries().filter((e) => e.account_type === 'PROVIDER_SETTLEMENT');
    expect(settlement).toHaveLength(0);
  });

  it('the transaction stays recoverable at PROCESSING with its reservation HELD', async () => {
    const h = harness('fail-recoverable', { behaviour: 'SUCCESS' });
    const deps = withDriver(h.deps, failAt(h.driver, 'saveTransaction', 5));
    await expect(createSale(deps, saleRequest())).rejects.toThrow();

    const rows = h.driver.findTransactionsByMerchant(MERCHANT_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('PROCESSING');

    const txId = transactionId(rows[0]?.id ?? '');
    expect(h.driver.findReservation(txId, MERCHANT_A)?.status).toBe('HELD');
  });
});

describe('failure during ledger posting', () => {
  it('rolls back the whole outcome unit of work', async () => {
    const h = harness('fail-posting', { behaviour: 'SUCCESS' });
    // appendEntries calls: 1 = reserve posting, 2 = finalize posting.
    const deps = withDriver(h.deps, failAt(h.driver, 'appendEntries', 2));

    await expect(createSale(deps, saleRequest())).rejects.toThrow();

    const view = h.driver.balanceFor(MERCHANT_A);
    expect(view.reserved.minor).toBe(2500);
    expect(view.total.minor).toBe(10000);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
    expect(h.driver.findTransactionsByMerchant(MERCHANT_A)[0]?.state).toBe('PROCESSING');
  });

  it('a failure on the first posting undoes the reservation entirely', async () => {
    const h = harness('fail-posting-first', { behaviour: 'SUCCESS' });
    const before = snapshot(h);
    const deps = withDriver(h.deps, failAt(h.driver, 'appendEntries', 1));

    const result = await createSale(deps, saleRequest());
    expect(result.kind).toBe('PERSISTENCE_FAILURE');
    expect(snapshot(h)).toEqual(before);
  });
});

describe('failure during audit creation', () => {
  it('rolls back the balance change it accompanied', async () => {
    const h = harness('fail-audit', { behaviour: 'SUCCESS' });
    const before = snapshot(h);

    // The first audit event is written immediately after the CREATED row.
    const deps = withDriver(h.deps, failAt(h.driver, 'saveAuditEvent', 1));
    const result = await createSale(deps, saleRequest());

    expect(result.kind).toBe('PERSISTENCE_FAILURE');
    expect(snapshot(h)).toEqual(before);
  });

  it('a later audit failure leaves no partial debit', async () => {
    const h = harness('fail-audit-late', { behaviour: 'SUCCESS' });
    // Audit calls: 1 created, 2 reserve op, 3 reserved transition, 4 submitted, 5 finalize op...
    const deps = withDriver(h.deps, failAt(h.driver, 'saveAuditEvent', 5));

    await expect(createSale(deps, saleRequest())).rejects.toThrow();

    const view = h.driver.balanceFor(MERCHANT_A);
    expect(view.total.minor).toBe(10000);
    expect(view.reserved.minor).toBe(2500);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });
});

describe('failure during idempotency result storage', () => {
  it('rolls back the finalization with it', async () => {
    const h = harness('fail-idem-result', { behaviour: 'SUCCESS' });
    const deps = withDriver(h.deps, failAt(h.driver, 'recordIdempotencyResult', 1));

    await expect(createSale(deps, saleRequest())).rejects.toThrow();

    // The debit is rolled back along with the result write.
    const view = h.driver.balanceFor(MERCHANT_A);
    expect(view.reserved.minor).toBe(2500);
    expect(view.available.minor).toBe(7500);
    expect(view.total.minor).toBe(10000);
    expect(h.driver.readEntries().filter((e) => e.account_type === 'PROVIDER_SETTLEMENT')).toHaveLength(0);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });
});

describe('the invariant that survives every injected failure', () => {
  it('the ledger always balances and the four views always reconcile', async () => {
    const points: [Parameters<typeof failAt>[1], number][] = [
      ['saveTransaction', 1],
      ['saveTransaction', 5],
      ['saveIdempotencyRecord', 1],
      ['appendEntries', 1],
      ['appendEntries', 2],
      ['saveAuditEvent', 1],
      ['saveAuditEvent', 5],
      ['recordIdempotencyResult', 1],
    ];

    for (const [method, occurrence] of points) {
      const h = harness(`invariant-${String(method)}-${String(occurrence)}`, { behaviour: 'SUCCESS' });
      const deps = withDriver(h.deps, failAt(h.driver, method, occurrence));

      try {
        await createSale(deps, saleRequest());
      } catch {
        // Expected for the points that propagate.
      }

      const view = h.driver.balanceFor(MERCHANT_A);
      expect(view.available.minor + view.reserved.minor + view.underReview.minor).toBe(view.total.minor);
      expect(h.driver.ledgerResidualMinor()).toBe(0);
      expect(h.driver.health().healthy).toBe(true);
    }
  });
});
