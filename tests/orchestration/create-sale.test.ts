/**
 * createSale — the three immediate outcomes.
 *
 * Success, confirmed failure and timeout. Each asserts the state path, the
 * ledger effect, the audit trail and the merchant-facing next action.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { fromBirr, transactionId } from '@telga/domain';
import { createSale } from '@telga/api';
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

describe('immediate success', () => {
  it('walks CREATED to SUCCESSFUL and debits exactly once', async () => {
    const { deps, driver } = harness('success', { behaviour: 'SUCCESS' });
    const result = await createSale(deps, saleRequest());

    expect(result.kind).toBe('SUCCESSFUL');
    expect(result.simulated).toBe(true);

    const txId = transactionId((result as { transactionId: string }).transactionId);
    const row = driver.findTransaction(txId, MERCHANT_A);
    expect(row?.state).toBe('SUCCESSFUL');

    const view = driver.balanceFor(MERCHANT_A);
    expect(view.available.minor).toBe(7500);
    expect(view.reserved.minor).toBe(0);
    expect(view.underReview.minor).toBe(0);
    expect(view.total.minor).toBe(7500);
    expect(driver.ledgerResidualMinor()).toBe(0);
  });

  it('finalizes the reservation exactly once', async () => {
    const { deps, driver } = harness('success-res', { behaviour: 'SUCCESS' });
    const result = await createSale(deps, saleRequest());
    const txId = transactionId((result as { transactionId: string }).transactionId);

    expect(driver.findReservation(txId, MERCHANT_A)?.status).toBe('SETTLED');
    const debits = driver
      .readEntriesByTransaction(txId)
      .filter((e) => e.direction === 'DEBIT' && e.account_type === 'MERCHANT_RESERVED');
    expect(debits).toHaveLength(1);
  });

  it('writes no commission entry, because no rate is configured', async () => {
    const { deps, driver } = harness('success-commission', { behaviour: 'SUCCESS' });
    await createSale(deps, saleRequest());

    const entries = driver.readEntries();
    expect(entries.some((e) => e.entry_type === 'COMMISSION_CREDIT')).toBe(false);
    expect(entries.some((e) => e.entry_type === 'FEE_DEBIT')).toBe(false);
  });

  it('writes audit events for creation and every transition', async () => {
    const { deps, driver } = harness('success-audit', { behaviour: 'SUCCESS' });
    await createSale(deps, saleRequest());

    const events = driver.readAuditEvents(MERCHANT_A);
    const types = events.map((e) => e.event_type);
    expect(types).toContain('TRANSACTION_CREATED');
    expect(types).toContain('BALANCE_RESERVED');
    expect(types).toContain('PROVIDER_SUBMITTED');
    expect(types).toContain('TRANSACTION_TRANSITIONED');
    expect(events.every((e) => e.correlation_id.length > 0)).toBe(true);
  });

  it('offers the receipt as the next action', async () => {
    const { deps } = harness('success-action', { behaviour: 'SUCCESS' });
    const result = await createSale(deps, saleRequest());
    expect(result.nextAction).toBe('DISPLAY_RESULT_AND_OFFER_RECEIPT');
    expect(result.messageKey).toBe('status.successful');
  });
});

describe('confirmed failure', () => {
  it('releases the reservation and restores available exactly once', async () => {
    const { deps, driver } = harness('failure', { behaviour: 'FAILURE' });
    const result = await createSale(deps, saleRequest());

    expect(result.kind).toBe('FAILED');
    const txId = transactionId((result as { transactionId: string }).transactionId);
    expect(driver.findTransaction(txId, MERCHANT_A)?.state).toBe('FAILED');
    expect(driver.findReservation(txId, MERCHANT_A)?.status).toBe('RELEASED');

    const view = driver.balanceFor(MERCHANT_A);
    expect(view.available.minor).toBe(10000);
    expect(view.reserved.minor).toBe(0);
    expect(driver.ledgerResidualMinor()).toBe(0);
  });

  it('tells the merchant no sale completed and funds were released', async () => {
    const { deps } = harness('failure-action', { behaviour: 'FAILURE' });
    const result = await createSale(deps, saleRequest());
    expect(result.nextAction).toBe('EXPLAIN_NO_SALE_FUNDS_RELEASED');
    expect(result.messageKey).toBe('status.failed.message');
  });

  it('creates no commission', async () => {
    const { deps, driver } = harness('failure-commission', { behaviour: 'FAILURE' });
    await createSale(deps, saleRequest());
    expect(driver.readEntries().some((e) => e.entry_type === 'COMMISSION_CREDIT')).toBe(false);
  });
});

describe('timeout', () => {
  it('becomes PENDING with the reservation still held', async () => {
    const { deps, driver } = harness('timeout', { behaviour: 'TIMEOUT' });
    const result = await createSale(deps, saleRequest());

    expect(result.kind).toBe('PENDING');
    const txId = transactionId((result as { transactionId: string }).transactionId);
    expect(driver.findTransaction(txId, MERCHANT_A)?.state).toBe('PENDING');
    expect(driver.findReservation(txId, MERCHANT_A)?.status).toBe('HELD');

    const view = driver.balanceFor(MERCHANT_A);
    expect(view.available.minor).toBe(7500);
    expect(view.reserved.minor).toBe(2500);
    expect(view.total.minor).toBe(10000);
  });

  it('performs no final debit', async () => {
    const { deps, driver } = harness('timeout-nodebit', { behaviour: 'TIMEOUT' });
    const result = await createSale(deps, saleRequest());
    const txId = transactionId((result as { transactionId: string }).transactionId);

    const settlement = driver.readEntriesByTransaction(txId).filter(
      (e) => e.account_type === 'PROVIDER_SETTLEMENT',
    );
    expect(settlement).toHaveLength(0);
  });

  it('tells the merchant not to retry', async () => {
    const { deps } = harness('timeout-action', { behaviour: 'TIMEOUT' });
    const result = await createSale(deps, saleRequest());
    expect(result.nextAction).toBe('DO_NOT_RETRY_YET');
    expect(result.messageKey).toBe('status.pending.message');
  });

  it('creates a pending resolution job carrying the escalation deadline', async () => {
    const { deps, driver } = harness('timeout-job', { behaviour: 'TIMEOUT' });
    const result = await createSale(deps, saleRequest());
    const txId = transactionId((result as { transactionId: string }).transactionId);

    const job = driver.findPendingResolution(txId);
    expect(job?.status).toBe('AWAITING');
    expect(job?.attempts).toBe(0);
    expect(new Date(job?.deadline_at ?? 0).getTime()).toBeGreaterThan(
      new Date(job?.first_pending_at ?? 0).getTime(),
    );
    expect(driver.awaitingResolutions(MERCHANT_A)).toHaveLength(1);
  });

  it('a malformed provider response is pending, never a false success', async () => {
    const { deps, driver } = harness('malformed', { behaviour: 'MALFORMED_RESPONSE' });
    const result = await createSale(deps, saleRequest());

    expect(result.kind).toBe('PENDING');
    expect(result.kind).not.toBe('SUCCESSFUL');
    expect(driver.balanceFor(MERCHANT_A).reserved.minor).toBe(2500);
  });
});

describe('rejections', () => {
  it('provider outage blocks before anything is created or charged', async () => {
    const { deps, driver } = harness('outage', { behaviour: 'OUTAGE' });
    const result = await createSale(deps, saleRequest());

    expect(result.kind).toBe('PROVIDER_UNAVAILABLE');
    expect(result.nextAction).toBe('SHOW_PROVIDER_UNAVAILABLE_NO_CHARGE');
    expect(driver.findTransactionsByMerchant(MERCHANT_A)).toHaveLength(0);
    expect(driver.balanceFor(MERCHANT_A).available.minor).toBe(10000);
    expect(driver.balanceFor(MERCHANT_A).reserved.minor).toBe(0);
  });

  it('insufficient balance leaves no transaction and no reservation', async () => {
    const { deps, driver } = harness('insufficient', { behaviour: 'SUCCESS', fundBirr: 10 });
    const result = await createSale(deps, saleRequest({ amount: fromBirr(500) }));

    expect(result.kind).toBe('INSUFFICIENT_BALANCE');
    expect(driver.findTransactionsByMerchant(MERCHANT_A)).toHaveLength(0);
    expect(driver.readEntries().filter((e) => e.entry_type === 'SALE_DEBIT')).toHaveLength(0);
    expect(driver.balanceFor(MERCHANT_A).available.minor).toBe(1000);
  });

  it('an unknown device is refused', async () => {
    const { deps } = harness('device', { behaviour: 'SUCCESS' });
    const result = await createSale(deps, saleRequest({ deviceId: 'device_not_registered' as never }));
    expect(result.kind).toBe('UNAUTHORIZED');
    expect(result.nextAction).toBe('SHOW_PERMISSION_ERROR');
  });

  it("another merchant's device is refused", async () => {
    const { deps } = harness('device-cross', { behaviour: 'SUCCESS', seedSecondMerchant: true });
    const result = await createSale(deps, saleRequest({ deviceId: 'device_beta_1' as never }));
    expect(result.kind).toBe('UNAUTHORIZED');
    expect((result as { reasonCode: string }).reasonCode).toBe('DEVICE_NOT_OWNED_BY_MERCHANT');
  });

  it('an unavailable product is refused with no charge', async () => {
    const { deps, driver } = harness('product', { behaviour: 'SUCCESS', productAvailable: false });
    const result = await createSale(deps, saleRequest());
    expect(result.kind).toBe('PRODUCT_UNAVAILABLE');
    expect(driver.findTransactionsByMerchant(MERCHANT_A)).toHaveLength(0);
  });

  it('a non-training mode is refused at the door', async () => {
    const { deps, driver } = harness('live', { behaviour: 'SUCCESS', mode: 'LIVE' });
    const result = await createSale(deps, saleRequest());
    expect(result.kind).toBe('SIMULATED_ONLY');
    expect(driver.findTransactionsByMerchant(MERCHANT_A)).toHaveLength(0);
  });

  it('an invalid recipient is refused', async () => {
    const { deps } = harness('recipient', { behaviour: 'SUCCESS' });
    const result = await createSale(deps, saleRequest({ recipient: '09' }));
    expect(result.kind).toBe('INVALID_REQUEST');
    expect(result.nextAction).toBe('SHOW_VALIDATION_ERROR');
  });

  it('never exposes a raw error to the merchant', async () => {
    const { deps } = harness('safe-errors', { behaviour: 'SUCCESS', fundBirr: 1 });
    const result = await createSale(deps, saleRequest({ amount: fromBirr(500) }));

    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/SQLITE|at Object|\.ts:|Error:/);
    expect((result as { reasonCode: string }).reasonCode).toBe('INSUFFICIENT_AVAILABLE_BALANCE');
  });
});

describe('privacy', () => {
  it('never stores the full recipient number', async () => {
    const { deps, driver } = harness('privacy', { behaviour: 'SUCCESS' });
    const result = await createSale(deps, saleRequest({ recipient: '0911223344' }));
    const txId = transactionId((result as { transactionId: string }).transactionId);

    const row = driver.findTransaction(txId, MERCHANT_A);
    expect(row?.recipient_masked).toBe('09******44');
    expect(row?.recipient_hash).toHaveLength(64);

    const dump = JSON.stringify(driver.readEntries()) + JSON.stringify(driver.readAuditEvents());
    expect(dump).not.toContain('0911223344');
  });
});
