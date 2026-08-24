/**
 * Recovery under injected failure, and the gauges and alerts.
 *
 * The assertion after every injected failure is the same: the ledger balances,
 * the four views reconcile, and no half-finished recovery is left behind.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { transactionId } from '@telga/domain';
import { createSale, evaluateAlerts, recoverInFlight, recoveryGauges } from '@telga/api';
import type { AlertThresholds } from '@telga/api';
import {
  fixedStatusProvider,
  makeRecoveryHarness,
  MERCHANT_A,
  saleRequest,
  withProvider,
} from './helpers';
import type { RecoveryHarness } from './helpers';
import { failAt, withDriver } from '../orchestration/helpers';
import type { SqliteLedgerDriver } from '@telga/persistence';

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
  return transactionId(row?.id ?? '');
}

function invariants(h: RecoveryHarness): void {
  const view = h.driver.balanceFor(MERCHANT_A);
  expect(view.available.minor + view.reserved.minor + view.underReview.minor).toBe(view.total.minor);
  expect(h.driver.ledgerResidualMinor()).toBe(0);
  expect(h.driver.health().healthy).toBe(true);
}

/** Swap in a driver whose Nth call to `method` throws. */
const brokenAt = (
  h: RecoveryHarness,
  method: keyof SqliteLedgerDriver,
  occurrence: number,
  provider = fixedStatusProvider('SUCCESS'),
) => ({
  ...withProvider(h.recoveryDeps, provider),
  driver: failAt(h.driver, method, occurrence),
});

describe('failure during claim', () => {
  it('is reported, not hidden, and leaves nothing changed', async () => {
    const h = harness('rb-claim', { behaviour: 'SUCCESS' });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);
    const before = h.driver.balanceFor(MERCHANT_A);

    // The sweep itself throws when the claim fails — a broken claim means we
    // cannot guarantee single ownership, so continuing would be unsafe.
    await expect(recoverInFlight(brokenAt(h, 'claimTransaction', 1))).rejects.toThrow();

    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('PROCESSING');
    expect(h.driver.balanceFor(MERCHANT_A)).toEqual(before);
    invariants(h);
  });
});

describe('failure during status-lookup handling', () => {
  it('records a recovery failure and holds the funds', async () => {
    const h = harness('rb-lookup', { behaviour: 'SUCCESS' });
    await stuckProcessing(h);
    h.clock.advance(120_000);

    const report = await recoverInFlight(
      brokenAt(h, 'recordResolutionAttempt', 1, fixedStatusProvider('STILL_PENDING')),
    );

    expect(report.recoveryFailures).toBe(1);
    expect(report.results[0]?.operationalAlert).toBe(true);
    expect(h.driver.balanceFor(MERCHANT_A).reserved.minor).toBe(2500);
    invariants(h);
  });
});

describe('failure during finalization', () => {
  it('rolls the settlement back and leaves the value reserved', async () => {
    const h = harness('rb-finalize', { behaviour: 'SUCCESS' });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);

    // appendEntries call 1 during recovery is the finalize posting.
    const report = await recoverInFlight(brokenAt(h, 'appendEntries', 1));

    expect(report.recoveryFailures).toBe(1);
    expect(h.driver.readEntriesByTransaction(txId).filter((e) => e.account_type === 'PROVIDER_SETTLEMENT')).toHaveLength(0);
    expect(h.driver.balanceFor(MERCHANT_A).reserved.minor).toBe(2500);
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('PROCESSING');
    invariants(h);
  });
});

describe('failure during release', () => {
  it('rolls back and keeps the reservation held', async () => {
    const h = harness('rb-release', { behaviour: 'SUCCESS' });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);

    const report = await recoverInFlight(brokenAt(h, 'appendEntries', 1, fixedStatusProvider('FAILURE')));

    expect(report.recoveryFailures).toBe(1);
    expect(h.driver.findReservation(txId, MERCHANT_A)?.status).toBe('HELD');
    expect(h.driver.balanceFor(MERCHANT_A).reserved.minor).toBe(2500);
    invariants(h);
  });
});

describe('failure during under-review posting', () => {
  it('rolls back and leaves the value where it was', async () => {
    const h = harness('rb-under-review', {
      behaviour: 'SUCCESS',
      recovery: { pendingMaximumMs: 1 },
    });
    await stuckProcessing(h);
    h.clock.advance(120_000);

    const report = await recoverInFlight(
      brokenAt(h, 'appendEntries', 1, fixedStatusProvider('STILL_PENDING')),
    );

    expect(report.recoveryFailures).toBe(1);
    expect(h.driver.balanceFor(MERCHANT_A).underReview.minor).toBe(0);
    expect(h.driver.balanceFor(MERCHANT_A).reserved.minor).toBe(2500);
    invariants(h);
  });
});

describe('failure during support-case creation', () => {
  it('rolls back the escalation with it', async () => {
    const h = harness('rb-case', { behaviour: 'SUCCESS', recovery: { pendingMaximumMs: 1 } });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);

    const report = await recoverInFlight(
      brokenAt(h, 'createSupportCase', 1, fixedStatusProvider('STILL_PENDING')),
    );

    expect(report.recoveryFailures).toBe(1);
    expect(h.driver.findSupportCasesByMerchant(MERCHANT_A)).toHaveLength(0);
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).not.toBe('UNDER_REVIEW');
    expect(h.driver.balanceFor(MERCHANT_A).underReview.minor).toBe(0);
    invariants(h);
  });
});

describe('failure during audit creation', () => {
  it('rolls back whatever it accompanied', async () => {
    const h = harness('rb-audit', { behaviour: 'SUCCESS' });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);
    const before = h.driver.balanceFor(MERCHANT_A);

    // Audit call 1 in the sweep is RECOVERY_SCAN_STARTED.
    await expect(recoverInFlight(brokenAt(h, 'saveAuditEvent', 1))).rejects.toThrow();

    expect(h.driver.balanceFor(MERCHANT_A)).toEqual(before);
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('PROCESSING');
    invariants(h);
  });

  it('a later audit failure leaves no partial settlement', async () => {
    const h = harness('rb-audit-late', { behaviour: 'SUCCESS' });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);

    const report = await recoverInFlight(brokenAt(h, 'saveAuditEvent', 5));

    expect(report.recoveryFailures).toBe(1);
    expect(h.driver.readEntriesByTransaction(txId).filter((e) => e.account_type === 'PROVIDER_SETTLEMENT')).toHaveLength(0);
    expect(h.driver.balanceFor(MERCHANT_A).reserved.minor).toBe(2500);
    invariants(h);
  });
});

describe('the invariant that survives every injected failure', () => {
  it('holds at each injection point', async () => {
    const points: [keyof SqliteLedgerDriver, number][] = [
      ['recordResolutionAttempt', 1],
      ['appendEntries', 1],
      ['createSupportCase', 1],
      ['saveAuditEvent', 5],
      ['saveTransaction', 1],
      ['updatePendingMetadata', 1],
      ['closePendingResolution', 1],
    ];

    for (const [method, occurrence] of points) {
      const h = harness(`rb-inv-${String(method)}`, {
        behaviour: 'SUCCESS',
        recovery: { pendingMaximumMs: 1 },
      });
      await stuckProcessing(h);
      h.clock.advance(120_000);

      try {
        await recoverInFlight(brokenAt(h, method, occurrence, fixedStatusProvider('STILL_PENDING')));
      } catch {
        // Some injection points abort the sweep. Both paths must stay consistent.
      }
      invariants(h);
    }
  });
});

describe('gauges', () => {
  it('counts transactions by state and finds the oldest unresolved', async () => {
    const h = harness('metrics-gauges', { behaviour: 'SUCCESS' });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);

    const gauges = recoveryGauges(h.driver, h.clock.now());

    expect(gauges.processing).toBe(1);
    expect(gauges.reserved).toBe(0);
    expect(gauges.underReview).toBe(0);
    expect(gauges.oldestUnresolvedId).toBe(txId);
    expect(gauges.oldestUnresolvedAgeMs).toBeGreaterThanOrEqual(120_000);
    expect(gauges.ledgerResidualMinor).toBe(0);
    expect(gauges.healthy).toBe(true);
  });

  it('tracks the manual-review queue and awaiting resolutions', async () => {
    const h = harness('metrics-queue', { behaviour: 'SUCCESS', recovery: { pendingMaximumMs: 1 } });
    await stuckProcessing(h);
    h.clock.advance(120_000);
    await recoverInFlight(withProvider(h.recoveryDeps, fixedStatusProvider('STILL_PENDING')));

    const gauges = recoveryGauges(h.driver, h.clock.now());
    expect(gauges.underReview).toBe(1);
    expect(gauges.openManualReviews).toBe(1);
    expect(gauges.processing).toBe(0);
  });

  it('reports zero on an untouched system', () => {
    const h = harness('metrics-empty', { behaviour: 'SUCCESS' });
    const gauges = recoveryGauges(h.driver, h.clock.now());

    expect(gauges.processing).toBe(0);
    expect(gauges.oldestUnresolvedAgeMs).toBe(0);
    expect(gauges.oldestUnresolvedId).toBeUndefined();
    expect(gauges.ledgerResidualMinor).toBe(0);
  });
});

describe('alerts', () => {
  const thresholds: AlertThresholds = {
    maxSafeUnresolvedMs: 60_000,
    maxManualReviewQueue: 0,
    maxRecoveryFailures: 0,
  };

  it('is silent on a healthy, empty system', () => {
    const h = harness('alerts-quiet', { behaviour: 'SUCCESS' });
    const alerts = evaluateAlerts(recoveryGauges(h.driver, h.clock.now()), {
      ...thresholds,
      maxManualReviewQueue: 10,
    });
    expect(alerts).toHaveLength(0);
  });

  it('raises when a transaction is stuck beyond the safe period', async () => {
    const h = harness('alerts-stuck', { behaviour: 'SUCCESS' });
    await stuckProcessing(h);
    h.clock.advance(600_000);

    const alerts = evaluateAlerts(recoveryGauges(h.driver, h.clock.now()), thresholds);
    expect(alerts.map((a) => a.code)).toContain('TRANSACTION_STUCK_BEYOND_SAFE_PERIOD');
  });

  it('raises on a growing manual-review queue', async () => {
    const h = harness('alerts-queue', { behaviour: 'SUCCESS', recovery: { pendingMaximumMs: 1 } });
    await stuckProcessing(h);
    h.clock.advance(120_000);
    await recoverInFlight(withProvider(h.recoveryDeps, fixedStatusProvider('STILL_PENDING')));

    const alerts = evaluateAlerts(recoveryGauges(h.driver, h.clock.now()), thresholds);
    expect(alerts.map((a) => a.code)).toContain('MANUAL_REVIEW_QUEUE_GROWING');
  });

  it('raises on provider configuration failures and duplicate workers', () => {
    const h = harness('alerts-sweep', { behaviour: 'SUCCESS' });
    const alerts = evaluateAlerts(
      recoveryGauges(h.driver, h.clock.now()),
      { ...thresholds, maxManualReviewQueue: 10 },
      { recoveryFailures: 2, duplicateWorkersPrevented: 1, operationalAlerts: 1 },
    );

    const codes = alerts.map((a) => a.code);
    expect(codes).toContain('RECOVERY_WORKER_FAILURES');
    expect(codes).toContain('PROVIDER_LOOKUP_FAILURE_SPIKE');
    expect(codes).toContain('MULTIPLE_RECOVERY_ATTEMPTS');
  });

  it('treats a non-zero ledger residual as critical', () => {
    const h = harness('alerts-residual', { behaviour: 'SUCCESS' });
    const gauges = { ...recoveryGauges(h.driver, h.clock.now()), ledgerResidualMinor: 25 };
    const alerts = evaluateAlerts(gauges, { ...thresholds, maxManualReviewQueue: 10 });

    const critical = alerts.find((a) => a.code === 'LEDGER_RESIDUAL_NON_ZERO');
    expect(critical?.severity).toBe('CRITICAL');
  });
});
