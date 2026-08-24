/**
 * A44 reproduction harness.
 *
 * Runs the escalation-to-manual-review scenario many times over, each iteration
 * on a fresh database, capturing the full safe state on the first failure.
 *
 * The scenario is the one that failed once in a full-suite run:
 *   a transaction stuck at PROCESSING, past its pending deadline, swept with an
 *   indeterminate provider outcome — which must escalate to UNDER_REVIEW and
 *   mark the pending row's manual review OPEN.
 *
 * Iterations are configurable so the same file serves a quick check and a long
 * soak: `TELGA_STRESS_ITERATIONS=500 npm run test:recovery:stress`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { transactionId } from '@telga/domain';
import { createSale, recoverInFlight } from '@telga/api';
import type { SqliteLedgerDriver } from '@telga/persistence';
import { fixedStatusProvider, makeRecoveryHarness, MERCHANT_A, saleRequest, withProvider } from '../recovery/helpers';
import type { RecoveryHarness } from '../recovery/helpers';
import { failAt, withDriver } from '../orchestration/helpers';

const ITERATIONS = Number(process.env.TELGA_STRESS_ITERATIONS ?? '120');

let harnesses: RecoveryHarness[] = [];

afterEach(() => {
  for (const h of harnesses) h.cleanup();
  harnesses = [];
});

/** Safe diagnostic snapshot. No secrets, no recipient data. */
function snapshot(driver: SqliteLedgerDriver, txId: ReturnType<typeof transactionId>) {
  const tx = driver.findTransaction(txId, MERCHANT_A);
  const job = driver.findPendingResolution(txId);
  const claim = driver.findClaim(txId);
  const reservation = driver.findReservation(txId, MERCHANT_A);
  const supportCase = driver.findSupportCaseByTransaction(txId, MERCHANT_A);
  const view = driver.balanceFor(MERCHANT_A);

  return {
    transactionId: txId,
    merchantId: MERCHANT_A,
    transactionState: tx?.state,
    transactionUpdatedAt: tx?.updated_at,
    providerReference: tx?.provider_reference,
    pendingStatus: job?.status,
    pendingAttempts: job?.attempts,
    pendingFirstAt: job?.first_pending_at,
    pendingDeadlineAt: job?.deadline_at,
    pendingNextCheckAt: job?.next_check_at,
    pendingCurrentState: job?.current_state,
    manualReviewStatus: job?.manual_review_status,
    lastOutcomeCategory: job?.last_outcome_category,
    correlationId: job?.correlation_id,
    claimWorkerId: claim?.worker_id,
    claimStatus: claim?.status,
    claimAttemptNo: claim?.attempt_no,
    reservationStatus: reservation?.status,
    supportCaseId: supportCase?.id,
    supportCaseReason: supportCase?.reason,
    available: view.available.minor,
    reserved: view.reserved.minor,
    underReview: view.underReview.minor,
    total: view.total.minor,
    residual: driver.ledgerResidualMinor(),
    pid: process.pid,
  };
}

async function runIteration(iteration: number) {
  const h = makeRecoveryHarness(`stress-${String(iteration)}`, {
    behaviour: 'SUCCESS',
    recovery: { pendingMaximumMs: 1 },
  });
  harnesses.push(h);

  const before = new Set(h.driver.findTransactionsByMerchant(MERCHANT_A).map((r) => r.id));
  const deps = withDriver(h.deps, failAt(h.driver, 'saveTransaction', 5));
  await expect(createSale(deps, saleRequest())).rejects.toThrow();

  const row = h.driver.findTransactionsByMerchant(MERCHANT_A).find((r) => !before.has(r.id));
  const txId = transactionId(row?.id ?? '');
  const stateAfterSeed = row?.state;

  const clockBefore = h.clock.now();
  h.clock.advance(120_000);
  const clockAtSweep = h.clock.now();

  const report = await recoverInFlight(withProvider(h.recoveryDeps, fixedStatusProvider('STILL_PENDING')));
  const after = snapshot(h.driver, txId);

  return { iteration, txId, stateAfterSeed, clockBefore, clockAtSweep, report, after, harness: h };
}

describe('A44 — escalation to manual review', () => {
  it(
    `marks manual review OPEN on every one of ${String(ITERATIONS)} iterations`,
    async () => {
      const failures: unknown[] = [];

      for (let i = 0; i < ITERATIONS; i += 1) {
        const result = await runIteration(i);

        const ok =
          result.after.manualReviewStatus === 'OPEN' &&
          result.after.pendingStatus === 'ESCALATED' &&
          result.after.transactionState === 'UNDER_REVIEW' &&
          result.after.residual === 0;

        if (!ok) {
          failures.push({
            iteration: i,
            seedState: result.stateAfterSeed,
            clockBefore: result.clockBefore,
            clockAtSweep: result.clockAtSweep,
            reportKinds: result.report.results.map((r) => r.kind),
            reportEscalated: result.report.escalatedUnderReview,
            reportFound: result.report.found,
            reportClaimed: result.report.claimed,
            state: result.after,
          });
          // Keep the failing database for inspection.
          break;
        }

        result.harness.cleanup();
        harnesses = harnesses.filter((h) => h !== result.harness);
      }

      if (failures.length > 0) {
        // Printed so the stress runner captures it even when the assertion
        // message is truncated.
        console.error('A44 REPRODUCED:', JSON.stringify(failures, null, 2));
      }

      expect(failures).toEqual([]);
    },
    600_000,
  );

  it(
    'stays idempotent across repeated sweeps of the same transaction',
    async () => {
      const h = makeRecoveryHarness('stress-idempotent', {
        behaviour: 'SUCCESS',
        recovery: { pendingMaximumMs: 1 },
      });
      harnesses.push(h);

      const before = new Set(h.driver.findTransactionsByMerchant(MERCHANT_A).map((r) => r.id));
      const deps = withDriver(h.deps, failAt(h.driver, 'saveTransaction', 5));
      await expect(createSale(deps, saleRequest())).rejects.toThrow();
      const row = h.driver.findTransactionsByMerchant(MERCHANT_A).find((r) => !before.has(r.id));
      const txId = transactionId(row?.id ?? '');

      const sweeper = withProvider(h.recoveryDeps, fixedStatusProvider('STILL_PENDING'));

      for (let i = 0; i < 25; i += 1) {
        h.clock.advance(120_000);
        await recoverInFlight(sweeper);

        const state = snapshot(h.driver, txId);
        expect(state.manualReviewStatus).toBe('OPEN');
        expect(state.transactionState).toBe('UNDER_REVIEW');
        expect(state.residual).toBe(0);
        expect(h.driver.findSupportCasesByMerchant(MERCHANT_A)).toHaveLength(1);
      }
    },
    300_000,
  );
});
