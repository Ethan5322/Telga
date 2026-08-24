/**
 * What happens when a recovery **fails**.
 *
 * Written for A54. The failure path existed and was correct, but nothing
 * exercised it deliberately and nothing reported it usefully: a sweep that
 * claimed work and resolved none of it returned a row of zeroes and a `HEALTHY`
 * verdict. These tests pin down what a failure must do, so the safe behaviour is
 * a property somebody checks rather than one that happens to hold.
 *
 * The invariant across every case below: **a failed recovery changes nothing.**
 * No settlement, no state transition, no ledger movement, residual still zero,
 * and the transaction left exactly where the next sweep will find it. A recovery
 * that cannot complete must be indistinguishable, in the ledger, from one that
 * never started.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { transactionId as toTransactionId } from '@telga/domain';
import { createSale, recoverInFlight } from '@telga/api';
import { healthLevel, summarizeSweep, DEFAULT_HEALTH_THRESHOLDS } from '@telga/worker';
import type { SweepReport } from '@telga/api';
import {
  MERCHANT_A,
  fixedStatusProvider,
  makeRecoveryHarness,
  namedError,
  saleRequest,
  secondWorker,
  throwingProvider,
  withProvider,
} from './helpers';
import type { RecoveryHarness } from './helpers';
import { failAt, withDriver } from '../orchestration/helpers';
import type { RecoveryDeps } from '@telga/api';

let harnesses: RecoveryHarness[] = [];

afterEach(() => {
  for (const h of harnesses) h.cleanup();
  harnesses = [];
});

const harness = (name: string, options: Parameters<typeof makeRecoveryHarness>[1] = {}) => {
  const h = makeRecoveryHarness(name, options);
  harnesses.push(h);
  return h;
};

/** Seed a transaction stuck at PROCESSING and age it past the recovery threshold. */
async function stuck(h: RecoveryHarness, clientRequestId = 'req_fail_1'): Promise<string> {
  const before = new Set(h.driver.findTransactionsByMerchant(MERCHANT_A).map((r) => r.id));
  const deps = withDriver(h.deps, failAt(h.driver, 'saveTransaction', 5));
  await expect(createSale(deps, saleRequest({ clientRequestId }))).rejects.toThrow();
  const row = h.driver.findTransactionsByMerchant(MERCHANT_A).find((r) => !before.has(r.id));
  expect(row?.state).toBe('PROCESSING');
  h.clock.advance(10 * 60_000);
  return row?.id ?? '';
}

/**
 * Swap the driver while keeping the recovery configuration.
 *
 * `withDriver` from the orchestration helpers returns `SaleDeps` and drops
 * `workerId` and `recovery`, which a sweep needs.
 */
const withFailingDriver = (
  deps: RecoveryDeps,
  driver: Parameters<typeof failAt>[0],
  method: Parameters<typeof failAt>[1],
  occurrence = 1,
  error?: Error,
): RecoveryDeps => ({ ...deps, driver: failAt(driver, method, occurrence, error) });

const settlementsFor = (h: RecoveryHarness, txId: string): number =>
  h.driver
    .readEntriesByTransaction(toTransactionId(txId))
    .filter((e) => e.account_type === 'PROVIDER_SETTLEMENT').length;

describe('the successful path, for contrast', () => {
  it('claims and resolves, and says so', async () => {
    const h = harness('fp-success');
    const txId = await stuck(h);

    const report = await recoverInFlight(withProvider(h.recoveryDeps, fixedStatusProvider('SUCCESS')));

    expect(report.found).toBe(1);
    expect(report.claimed).toBe(1);
    expect(report.recoveredSuccessful).toBe(1);
    expect(report.recoveryFailures).toBe(0);
    expect(h.driver.findTransaction(toTransactionId(txId), MERCHANT_A)?.state).toBe('SUCCESSFUL');
    expect(settlementsFor(h, txId)).toBe(1);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });
});

describe('a transient provider failure', () => {
  it('does not resolve, and does not lose the transaction', async () => {
    const h = harness('fp-provider-throw');
    const txId = await stuck(h);

    // A provider that throws is an *unknown* outcome, never a failure.
    const report = await recoverInFlight(
      withProvider(h.recoveryDeps, throwingProvider(namedError('ECONNRESET'))),
    );

    expect(report.claimed).toBe(1);
    // Never resolved either way: a provider that throws says nothing about
    // whether it delivered.
    expect(report.recoveredSuccessful).toBe(0);
    expect(report.recoveredFailed).toBe(0);

    // It reaches a *holding* disposition instead. Which one depends on age:
    // this transaction is older than the pending maximum, so it escalates
    // straight to UNDER_REVIEW rather than waiting again.
    expect(report.movedToPending + report.escalatedUnderReview).toBe(1);
    const state = h.driver.findTransaction(toTransactionId(txId), MERCHANT_A)?.state;
    expect(['PENDING', 'UNDER_REVIEW']).toContain(state);

    // And the money is still held, not released and not taken.
    expect(settlementsFor(h, txId)).toBe(0);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });
});

describe('a database failure during the write', () => {
  it('leaves the transaction exactly where it was, and posts nothing', async () => {
    const h = harness('fp-db-write');
    const txId = await stuck(h);
    const before = h.driver.balanceFor(MERCHANT_A).available.minor;

    // Fail the state write inside the recovery unit of work. Everything in that
    // transaction rolls back together.
    const deps = withFailingDriver(
      withProvider(h.recoveryDeps, fixedStatusProvider('SUCCESS')),
      h.driver,
      'saveTransaction',
    );
    const report = await recoverInFlight(deps);

    expect(report.claimed).toBe(1);
    expect(report.recoveryFailures).toBe(1);
    expect(report.recoveredSuccessful).toBe(0);

    // Nothing moved.
    expect(h.driver.findTransaction(toTransactionId(txId), MERCHANT_A)?.state).toBe('PROCESSING');
    expect(settlementsFor(h, txId)).toBe(0);
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(before);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });

  it('reports the failure with a safe reason code, never a raw message', async () => {
    const h = harness('fp-db-reason');
    await stuck(h);

    const deps = withFailingDriver(
      withProvider(h.recoveryDeps, fixedStatusProvider('SUCCESS')),
      h.driver,
      'saveTransaction',
      1,
      namedError('SqliteError', 'SQLITE_BUSY_SNAPSHOT'),
    );
    const report = await recoverInFlight(deps);

    const failed = report.results.filter((r) => r.kind === 'RECOVERY_FAILED');
    expect(failed).toHaveLength(1);
    const code = failed[0]?.reasonCode ?? '';
    // A stable code, not an exception message.
    expect(code.length).toBeGreaterThan(0);
    expect(code).not.toContain(' ');
    expect(code.toUpperCase()).toBe(code);
  });

  it('lets the next sweep reclaim and finish the job', async () => {
    const h = harness('fp-retry-next-sweep');
    const txId = await stuck(h);

    const failing = withFailingDriver(
      withProvider(h.recoveryDeps, fixedStatusProvider('SUCCESS')),
      h.driver,
      'saveTransaction',
    );
    const first = await recoverInFlight(failing);
    expect(first.recoveryFailures).toBe(1);

    // The lease from the failed attempt has to lapse before anyone retries —
    // which is the point: a failure does not free the transaction instantly.
    h.clock.advance(60_000);

    const second = await recoverInFlight(withProvider(h.recoveryDeps, fixedStatusProvider('SUCCESS')));
    expect(second.recoveredSuccessful).toBe(1);
    expect(h.driver.findTransaction(toTransactionId(txId), MERCHANT_A)?.state).toBe('SUCCESSFUL');
    expect(settlementsFor(h, txId)).toBe(1);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });
});

describe('a claim held by another worker', () => {
  it('is skipped, and a skip is not a failure', async () => {
    const h = harness('fp-skipped');
    const txId = await stuck(h);

    // Worker one takes it and holds the lease.
    h.driver.claimTransaction({
      transactionId: toTransactionId(txId),
      workerId: 'worker_holding',
      scanId: 'scan_hold',
      now: h.clock.now(),
      expiresAt: new Date(new Date(h.clock.now()).getTime() + 600_000).toISOString(),
    });

    const report = await recoverInFlight(
      withProvider(secondWorker(h), fixedStatusProvider('SUCCESS')),
    );

    expect(report.duplicateWorkersPrevented).toBe(1);
    expect(report.claimed).toBe(0);
    // The distinction that matters: contested, not broken.
    expect(report.recoveryFailures).toBe(0);
    expect(report.skipped).toBeGreaterThanOrEqual(0);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });
});

describe('the health policy reads the sweep, not just the ledger', () => {
  const base = {
    workerId: 'worker_1',
    status: 'RUNNING' as const,
    startedAt: '2026-08-21T09:00:00.000Z',
    now: '2026-08-21T09:00:10.000Z',
    backoff: { consecutiveFailures: 0, currentDelayMs: 0 },
    ledgerResidualMinor: 0,
    databaseHealthy: true,
    oldestUnresolvedAgeMs: 0,
  };

  const sweep = (over: Partial<ReturnType<typeof summarizeSweep>>) => ({
    found: 0,
    claimed: 0,
    resolved: 0,
    skipped: 0,
    recoveryFailures: 0,
    duplicateWorkersPrevented: 0,
    ...over,
  });

  it('is healthy with no work', () => {
    expect(healthLevel({ ...base, lastSweep: sweep({}) }, DEFAULT_HEALTH_THRESHOLDS)).toBe('HEALTHY');
  });

  it('is healthy when work was found and resolved', () => {
    expect(
      healthLevel(
        { ...base, lastSweep: sweep({ found: 2, claimed: 2, resolved: 2 }) },
        DEFAULT_HEALTH_THRESHOLDS,
      ),
    ).toBe('HEALTHY');
  });

  it('is DEGRADED when a recovery failed, even with a zero residual', () => {
    // The A54 case exactly. A balanced ledger says the books are consistent; it
    // says nothing about whether recovery did its job.
    expect(
      healthLevel(
        {
          ...base,
          ledgerResidualMinor: 0,
          lastSweep: sweep({ found: 1, claimed: 1, resolved: 0, recoveryFailures: 1 }),
        },
        DEFAULT_HEALTH_THRESHOLDS,
      ),
    ).toBe('DEGRADED');
  });

  it('is DEGRADED when work was claimed and nothing was disposed of', () => {
    expect(
      healthLevel(
        { ...base, lastSweep: sweep({ found: 1, claimed: 1, resolved: 0 }) },
        DEFAULT_HEALTH_THRESHOLDS,
      ),
    ).toBe('DEGRADED');
  });

  it('stays healthy when work was only skipped, because another worker has it', () => {
    // A contested claim is normal operation, not a problem.
    expect(
      healthLevel(
        {
          ...base,
          lastSweep: sweep({ found: 1, claimed: 0, skipped: 1, duplicateWorkersPrevented: 1 }),
        },
        DEFAULT_HEALTH_THRESHOLDS,
      ),
    ).toBe('HEALTHY');
  });

  it('is UNHEALTHY when the residual is non-zero, whatever the sweep said', () => {
    expect(
      healthLevel(
        {
          ...base,
          ledgerResidualMinor: 1,
          lastSweep: sweep({ found: 1, claimed: 1, resolved: 1 }),
        },
        DEFAULT_HEALTH_THRESHOLDS,
      ),
    ).toBe('UNHEALTHY');
  });
});

describe('summarising a sweep', () => {
  it('counts every definite disposition as resolved', () => {
    const report = {
      found: 6,
      claimed: 6,
      duplicateWorkersPrevented: 0,
      recoveredSuccessful: 1,
      recoveredFailed: 1,
      releasedNeverSubmitted: 1,
      movedToPending: 1,
      escalatedUnderReview: 1,
      skipped: 1,
      recoveryFailures: 0,
    } as SweepReport;

    const outcome = summarizeSweep(report);
    // Pending and under-review are dispositions, not failures: the transaction
    // has been moved somewhere deliberate.
    expect(outcome.resolved).toBe(5);
    expect(outcome.skipped).toBe(1);
    expect(outcome.recoveryFailures).toBe(0);
  });
});
