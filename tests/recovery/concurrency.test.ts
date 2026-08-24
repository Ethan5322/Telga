/**
 * Concurrency and idempotency of the recovery sweep.
 *
 * The property under test throughout: however many workers, retries and
 * callbacks arrive, a merchant is debited once, released once, and reviewed once.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { transactionId } from '@telga/domain';
import { createSale, recoverInFlight, resolvePending } from '@telga/api';
import {
  fixedStatusProvider,
  makeRecoveryHarness,
  MERCHANT_A,
  saleRequest,
  secondWorker,
  withProvider,
} from './helpers';
import type { RecoveryHarness } from './helpers';
import { failAt, withDriver } from '../orchestration/helpers';

let harnesses: RecoveryHarness[] = [];
const harness = (name: string, options: Parameters<typeof makeRecoveryHarness>[1] = {}): RecoveryHarness => {
  const h = makeRecoveryHarness(name, options);
  harnesses.push(h);
  return h;
};

afterEach(() => {
  for (const h of harnesses) h.cleanup();
  harnesses = [];
});

async function stuckProcessing(h: RecoveryHarness) {
  const deps = withDriver(h.deps, failAt(h.driver, 'saveTransaction', 5));
  await expect(createSale(deps, saleRequest())).rejects.toThrow();
  const row = h.driver.findTransactionsByMerchant(MERCHANT_A)[0];
  expect(row?.state).toBe('PROCESSING');
  return transactionId(row?.id ?? '');
}

describe('two workers', () => {
  it('only one claims a transaction; the other is refused and records it', async () => {
    const h = harness('conc-two-workers', { behaviour: 'SUCCESS' });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);

    const provider = fixedStatusProvider('SUCCESS');
    const workerA = withProvider(h.recoveryDeps, provider);
    const workerB = withProvider(secondWorker(h), provider);

    const [a, b] = await Promise.all([recoverInFlight(workerA), recoverInFlight(workerB)]);

    const claimedTotal = a.claimed + b.claimed;
    const preventedTotal = a.duplicateWorkersPrevented + b.duplicateWorkersPrevented;

    expect(claimedTotal).toBe(1);
    expect(preventedTotal).toBe(1);
    expect(a.recoveredSuccessful + b.recoveredSuccessful).toBe(1);

    // Exactly one settlement posting, whichever worker won.
    const settlement = h.driver
      .readEntriesByTransaction(txId)
      .filter((e) => e.account_type === 'PROVIDER_SETTLEMENT');
    expect(settlement).toHaveLength(1);
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(7500);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });

  it('audits the prevented duplicate', async () => {
    const h = harness('conc-audit-prevented', { behaviour: 'SUCCESS' });
    await stuckProcessing(h);
    h.clock.advance(120_000);

    const provider = fixedStatusProvider('STILL_PENDING');
    await Promise.all([
      recoverInFlight(withProvider(h.recoveryDeps, provider)),
      recoverInFlight(withProvider(secondWorker(h), provider)),
    ]);

    const events = h.driver.readAuditEvents(MERCHANT_A);
    expect(events.some((e) => e.event_type === 'RECOVERY_DUPLICATE_WORKER_PREVENTED')).toBe(true);
    expect(events.some((e) => e.event_type === 'RECOVERY_CLAIMED')).toBe(true);
  });

  it('releases the claim so a later sweep can proceed', async () => {
    const h = harness('conc-release', { behaviour: 'SUCCESS' });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);

    await recoverInFlight(withProvider(h.recoveryDeps, fixedStatusProvider('STILL_PENDING')));
    expect(h.driver.findClaim(txId)?.status).toBe('RELEASED');

    h.clock.advance(120_000);
    const second = await recoverInFlight(withProvider(h.recoveryDeps, fixedStatusProvider('SUCCESS')));
    expect(second.claimed).toBe(1);
  });

  it('an expired lease can be reclaimed by another worker', async () => {
    const h = harness('conc-expired', { behaviour: 'SUCCESS', recovery: { claimLeaseMs: 1_000 } });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);

    // Worker one claims and never releases (simulating a dead worker).
    const claim = h.driver.claimTransaction({
      transactionId: txId,
      workerId: 'dead_worker',
      scanId: 'scan_dead',
      now: h.clock.now(),
      expiresAt: new Date(new Date(h.clock.now()).getTime() + 1_000).toISOString(),
    });
    expect(claim.claimed).toBe(true);

    // Before expiry, nobody else may take it.
    const blocked = await recoverInFlight(withProvider(h.recoveryDeps, fixedStatusProvider('SUCCESS')));
    expect(blocked.duplicateWorkersPrevented).toBe(1);

    // After expiry, it is reclaimable.
    h.clock.advance(5_000);
    const reclaimed = await recoverInFlight(withProvider(h.recoveryDeps, fixedStatusProvider('SUCCESS')));
    expect(reclaimed.claimed).toBe(1);
    expect(reclaimed.recoveredSuccessful).toBe(1);
  });
});

describe('repeated sweeps', () => {
  it('do not duplicate ledger postings', async () => {
    const h = harness('conc-no-dup-postings', { behaviour: 'SUCCESS' });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);

    const deps = withProvider(h.recoveryDeps, fixedStatusProvider('SUCCESS'));
    await recoverInFlight(deps);
    const entriesAfterFirst = h.driver.readEntriesByTransaction(txId).length;

    h.clock.advance(120_000);
    await recoverInFlight(deps);
    await recoverInFlight(deps);

    expect(h.driver.readEntriesByTransaction(txId)).toHaveLength(entriesAfterFirst);
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(7500);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });

  it('do not duplicate support cases', async () => {
    const h = harness('conc-no-dup-cases', { behaviour: 'SUCCESS', recovery: { pendingMaximumMs: 1 } });
    await stuckProcessing(h);
    const deps = withProvider(h.recoveryDeps, fixedStatusProvider('STILL_PENDING'));

    for (let i = 0; i < 4; i += 1) {
      h.clock.advance(120_000);
      await recoverInFlight(deps);
    }

    expect(h.driver.findSupportCasesByMerchant(MERCHANT_A)).toHaveLength(1);
  });

  it('do not change a terminal state', async () => {
    const h = harness('conc-terminal', { behaviour: 'SUCCESS' });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);

    const deps = withProvider(h.recoveryDeps, fixedStatusProvider('SUCCESS'));
    await recoverInFlight(deps);
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('SUCCESSFUL');

    h.clock.advance(600_000);
    const second = await recoverInFlight(withProvider(h.recoveryDeps, fixedStatusProvider('FAILURE')));

    expect(second.found).toBe(0);
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('SUCCESSFUL');
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(7500);
  });
});

describe('recovery alongside merchant and provider activity', () => {
  it('recovery and a merchant retry cannot create two sales', async () => {
    const h = harness('conc-retry', { behaviour: 'SUCCESS' });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);

    // The merchant presses again while the transaction is stuck.
    const retry = await createSale(h.deps, saleRequest());
    expect(retry.kind).toBe('DUPLICATE_REQUEST');

    await recoverInFlight(withProvider(h.recoveryDeps, fixedStatusProvider('SUCCESS')));

    expect(h.driver.findTransactionsByMerchant(MERCHANT_A)).toHaveLength(1);
    expect(h.driver.findReservationsByMerchant(MERCHANT_A)).toHaveLength(1);
    const settlement = h.driver
      .readEntriesByTransaction(txId)
      .filter((e) => e.account_type === 'PROVIDER_SETTLEMENT');
    expect(settlement).toHaveLength(1);
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(7500);
  });

  it('recovery and a duplicate provider callback cannot finalize twice', async () => {
    const h = harness('conc-callback', { behaviour: 'SUCCESS' });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);

    const deps = withProvider(h.recoveryDeps, fixedStatusProvider('SUCCESS'));
    await recoverInFlight(deps);

    // A late callback arrives for a transaction recovery already settled.
    const callback = await resolvePending(deps, txId, MERCHANT_A);
    expect(callback.kind).toBe('SUCCESSFUL');

    const settlement = h.driver
      .readEntriesByTransaction(txId)
      .filter((e) => e.account_type === 'PROVIDER_SETTLEMENT');
    expect(settlement).toHaveLength(1);
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(7500);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });

  it('a callback against a PROCESSING transaction is a no-op, and the sweep still resolves it once', async () => {
    const h = harness('conc-race-callback', { behaviour: 'SUCCESS' });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);

    const deps = withProvider(h.recoveryDeps, fixedStatusProvider('SUCCESS'));

    // resolvePending only acts on PENDING. A callback arriving while the
    // transaction is still PROCESSING changes nothing — it reports the
    // in-flight state and tells the merchant not to retry.
    const callback = await resolvePending(deps, txId, MERCHANT_A);
    expect(callback.nextAction).toBe('DO_NOT_RETRY_YET');
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('PROCESSING');
    expect(h.driver.readEntriesByTransaction(txId).filter((e) => e.account_type === 'PROVIDER_SETTLEMENT')).toHaveLength(0);

    // The sweep is what recovers it, and it does so exactly once.
    const report = await recoverInFlight(deps);
    expect(report.recoveredSuccessful).toBe(1);

    const settlement = h.driver
      .readEntriesByTransaction(txId)
      .filter((e) => e.account_type === 'PROVIDER_SETTLEMENT');
    expect(settlement).toHaveLength(1);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });
});
