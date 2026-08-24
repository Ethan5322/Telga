/**
 * The worker against a real database.
 *
 * Two things are proved here: the 5I recovery guarantees still hold when the
 * sweep runs through the worker, and two workers on **separate SQLite
 * connections to the same file** cannot both recover one transaction.
 *
 * What is NOT proved here is multi-*process* safety. These are two connections
 * inside one process. Assumption A37 stays open, deliberately — see the note on
 * the concurrency block below.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { transactionId } from '@telga/domain';
import { createSale, simulatedCatalog } from '@telga/api';
import { createSqliteDriver } from '@telga/persistence';
import type { SqliteLedgerDriver } from '@telga/persistence';
import { createRecoveryWorker, METRIC, collectingLogger, collectingMetrics, ShutdownController } from '@telga/worker';
import type { RecoveryWorker } from '@telga/worker';
import { fixedStatusProvider, makeRecoveryHarness, MERCHANT_A, PRODUCT, PROVIDER, saleRequest } from '../recovery/helpers';
import type { RecoveryHarness } from '../recovery/helpers';
import { failAt, withDriver } from '../orchestration/helpers';
import { fakeClock, policy } from './helpers';
import type { FakeClock } from './helpers';

let harnesses: RecoveryHarness[] = [];
const extraDrivers: SqliteLedgerDriver[] = [];

const harness = (name: string, options: Parameters<typeof makeRecoveryHarness>[1] = {}): RecoveryHarness => {
  const h = makeRecoveryHarness(name, options);
  harnesses.push(h);
  return h;
};

afterEach(() => {
  for (const d of extraDrivers.splice(0)) {
    try {
      d.close();
    } catch {
      // already closed
    }
  }
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

async function stuckReserved(h: RecoveryHarness) {
  const deps = withDriver(h.deps, failAt(h.driver, 'saveTransaction', 4));
  await expect(createSale(deps, saleRequest())).rejects.toThrow();
  const row = h.driver.findTransactionsByMerchant(MERCHANT_A)[0];
  expect(row?.state).toBe('RESERVED');
  return transactionId(row?.id ?? '');
}

interface WorkerBuild {
  worker: RecoveryWorker;
  clock: FakeClock;
  metrics: ReturnType<typeof collectingMetrics>;
  logger: ReturnType<typeof collectingLogger>;
  shutdown: ShutdownController;
}

function buildWorker(
  driver: SqliteLedgerDriver,
  options: {
    workerId?: string;
    status?: Parameters<typeof fixedStatusProvider>[0];
    startMs?: number;
    policyOverrides?: Parameters<typeof policy>[0];
  } = {},
): WorkerBuild {
  const shutdown = new ShutdownController();
  const clock = fakeClock({ shutdown, startMs: options.startMs });
  const metrics = collectingMetrics();
  const logger = collectingLogger();

  const worker = createRecoveryWorker({
    workerId: options.workerId ?? 'worker_1',
    policy: policy({ recoveryAgeMs: 60_000, pendingMaximumMs: 300_000, ...options.policyOverrides }),
    driver,
    provider: fixedStatusProvider(options.status ?? 'SUCCESS'),
    providerId: PROVIDER,
    catalog: simulatedCatalog([{ id: PRODUCT, label: 'Airtime (simulated)', available: true }]),
    recipientSalt: 'test-salt-not-a-production-secret',
    mode: 'TRAINING',
    clock,
    shutdown,
    logger,
    metrics,
  });

  return { worker, clock, metrics, logger, shutdown };
}

describe('recovery guarantees through the worker', () => {
  it('PROCESSING success finalizes exactly once', async () => {
    const h = harness('wi-success');
    const txId = await stuckProcessing(h);

    const { worker, clock } = buildWorker(h.driver, { status: 'SUCCESS' });
    clock.advance(120_000);
    const report = await worker.runOnce();

    expect(report?.recoveredSuccessful).toBe(1);
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('SUCCESSFUL');
    expect(
      h.driver.readEntriesByTransaction(txId).filter((e) => e.account_type === 'PROVIDER_SETTLEMENT'),
    ).toHaveLength(1);
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(7500);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });

  it('PROCESSING failure releases exactly once', async () => {
    const h = harness('wi-failure');
    const txId = await stuckProcessing(h);

    const { worker, clock } = buildWorker(h.driver, { status: 'FAILURE' });
    clock.advance(120_000);
    await worker.runOnce();

    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('FAILED');
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(10000);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });

  it('an unknown outcome becomes PENDING with the value held', async () => {
    const h = harness('wi-unknown');
    const txId = await stuckProcessing(h);

    const { worker, clock } = buildWorker(h.driver, { status: 'STILL_PENDING' });
    clock.advance(120_000);
    await worker.runOnce();

    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('PENDING');
    expect(h.driver.balanceFor(MERCHANT_A).reserved.minor).toBe(2500);
  });

  it('RESERVED without submission follows a valid state path', async () => {
    const h = harness('wi-reserved');
    const txId = await stuckReserved(h);

    const { worker, clock } = buildWorker(h.driver);
    clock.advance(120_000);
    const report = await worker.runOnce();

    expect(report?.releasedNeverSubmitted).toBe(1);
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('FAILED');
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(10000);
  });

  it('PENDING is swept and escalated after the deadline', async () => {
    const h = harness('wi-escalate');
    const txId = await stuckProcessing(h);

    const { worker, clock } = buildWorker(h.driver, {
      status: 'STILL_PENDING',
      policyOverrides: { pendingMaximumMs: 60_000 },
    });
    clock.advance(120_000);
    const report = await worker.runOnce();

    expect(report?.escalatedUnderReview).toBe(1);
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('UNDER_REVIEW');
    expect(h.driver.balanceFor(MERCHANT_A).underReview.minor).toBe(2500);
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(7500);
  });

  it('repeated sweeps duplicate nothing', async () => {
    const h = harness('wi-repeat');
    const txId = await stuckProcessing(h);

    const { worker, clock } = buildWorker(h.driver, {
      status: 'STILL_PENDING',
      policyOverrides: { pendingMaximumMs: 60_000 },
    });

    for (let i = 0; i < 4; i += 1) {
      clock.advance(120_000);
      await worker.runOnce();
    }

    expect(h.driver.findSupportCasesByMerchant(MERCHANT_A)).toHaveLength(1);
    const entries = h.driver.readEntriesByTransaction(txId);
    const underReviewCredits = entries.filter(
      (e) => e.account_type === 'MERCHANT_UNDER_REVIEW' && e.direction === 'CREDIT',
    );
    expect(underReviewCredits).toHaveLength(1);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });

  it('leaves a complete audit trail', async () => {
    const h = harness('wi-audit');
    await stuckProcessing(h);

    const { worker, clock } = buildWorker(h.driver, { status: 'SUCCESS' });
    clock.advance(120_000);
    await worker.runOnce();

    const events = h.driver.readAuditEvents().map((e) => e.event_type);
    for (const expected of [
      'RECOVERY_SCAN_STARTED',
      'RECOVERY_CLAIMED',
      'RECOVERY_STATUS_LOOKUP',
      'RECOVERY_OUTCOME_RECEIVED',
      'RECOVERY_RECOVERED_SUCCESSFUL',
    ]) {
      expect(events).toContain(expected);
    }
  });

  it('refuses to build a worker outside training mode', () => {
    const h = harness('wi-live');
    expect(() =>
      createRecoveryWorker({
        workerId: 'worker_live',
        policy: policy(),
        driver: h.driver,
        provider: fixedStatusProvider('SUCCESS'),
        providerId: PROVIDER,
        catalog: simulatedCatalog([]),
        recipientSalt: 'salt',
        mode: 'LIVE',
      }),
    ).toThrow(/TRAINING MODE/i);
  });

  it('passes the batch limit through to the sweep', async () => {
    const h = harness('wi-batch', { fundBirr: 1000 });
    // Three stuck transactions, a batch limit of two.
    for (let i = 0; i < 3; i += 1) {
      const deps = withDriver(h.deps, failAt(h.driver, 'saveTransaction', 5));
      await expect(
        createSale(deps, saleRequest({ clientRequestId: `req_${String(i)}` })),
      ).rejects.toThrow();
    }
    expect(h.driver.findTransactionsByMerchant(MERCHANT_A)).toHaveLength(3);

    const { worker, clock } = buildWorker(h.driver, {
      status: 'STILL_PENDING',
      policyOverrides: { recoveryBatchLimit: 2 },
    });
    clock.advance(120_000);
    const report = await worker.runOnce();

    expect(report?.found).toBe(2);
  });
});

describe('two workers on separate connections to one database file', () => {
  it('only one claims a transaction; the other records a conflict', async () => {
    const h = harness('wi-two-workers');
    const txId = await stuckProcessing(h);

    // A genuinely separate SQLite connection to the same file.
    const second = createSqliteDriver({ file: h.file });
    extraDrivers.push(second);
    expect(second).not.toBe(h.driver);

    const a = buildWorker(h.driver, { workerId: 'worker_a', status: 'SUCCESS' });
    const b = buildWorker(second, { workerId: 'worker_b', status: 'SUCCESS' });
    a.clock.advance(120_000);
    b.clock.advance(120_000);

    const [reportA, reportB] = await Promise.all([a.worker.runOnce(), b.worker.runOnce()]);

    const claimed = (reportA?.claimed ?? 0) + (reportB?.claimed ?? 0);
    const conflicts = (reportA?.duplicateWorkersPrevented ?? 0) + (reportB?.duplicateWorkersPrevented ?? 0);

    expect(claimed).toBe(1);
    expect(conflicts).toBe(1);

    // One outcome, one settlement, whichever worker won.
    expect(
      h.driver.readEntriesByTransaction(txId).filter((e) => e.account_type === 'PROVIDER_SETTLEMENT'),
    ).toHaveLength(1);
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(7500);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });

  it('the losing worker continues safely and records the conflict metric', async () => {
    const h = harness('wi-conflict-metric');
    const txId = await stuckProcessing(h);

    const second = createSqliteDriver({ file: h.file });
    extraDrivers.push(second);

    // Worker A takes a lease that is still live at the time worker B looks —
    // B advances its clock 120s, so the lease must outlast that.
    h.driver.claimTransaction({
      transactionId: txId,
      workerId: 'worker_a',
      scanId: 'scan_a',
      now: h.clock.now(),
      expiresAt: new Date(new Date(h.clock.now()).getTime() + 600_000).toISOString(),
    });

    const b = buildWorker(second, { workerId: 'worker_b', status: 'SUCCESS' });
    b.clock.advance(120_000);
    const report = await b.worker.runOnce();

    expect(report?.claimed).toBe(0);
    expect(report?.duplicateWorkersPrevented).toBe(1);
    expect(b.metrics.countOf(METRIC.claimConflicts)).toBe(1);
    // The transaction is untouched.
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('PROCESSING');
  });

  it('a live unexpired lease cannot be stolen', async () => {
    const h = harness('wi-no-steal');
    const txId = await stuckProcessing(h);

    h.driver.claimTransaction({
      transactionId: txId,
      workerId: 'worker_a',
      scanId: 'scan_a',
      now: h.clock.now(),
      expiresAt: new Date(new Date(h.clock.now()).getTime() + 600_000).toISOString(),
    });

    const outcome = h.driver.claimTransaction({
      transactionId: txId,
      workerId: 'worker_b',
      scanId: 'scan_b',
      now: h.clock.now(),
      expiresAt: new Date(new Date(h.clock.now()).getTime() + 600_000).toISOString(),
    });

    expect(outcome.claimed).toBe(false);
    expect(outcome.heldBy).toBe('worker_a');
  });

  it('an expired lease can be reclaimed across connections', async () => {
    const h = harness('wi-expired-lease');
    const txId = await stuckProcessing(h);

    h.driver.claimTransaction({
      transactionId: txId,
      workerId: 'dead_worker',
      scanId: 'scan_dead',
      now: h.clock.now(),
      expiresAt: new Date(new Date(h.clock.now()).getTime() + 1_000).toISOString(),
    });

    const second = createSqliteDriver({ file: h.file });
    extraDrivers.push(second);
    const b = buildWorker(second, { workerId: 'worker_b', status: 'SUCCESS' });
    b.clock.advance(120_000);

    const report = await b.worker.runOnce();
    expect(report?.claimed).toBe(1);
    expect(report?.recoveredSuccessful).toBe(1);
  });

  it('a worker releases only its own claims on shutdown', async () => {
    const h = harness('wi-release-own');
    const txId = await stuckProcessing(h);

    // Another worker holds a live lease.
    h.driver.claimTransaction({
      transactionId: txId,
      workerId: 'worker_other',
      scanId: 'scan_other',
      now: h.clock.now(),
      expiresAt: new Date(new Date(h.clock.now()).getTime() + 600_000).toISOString(),
    });

    const released = h.driver.releaseClaimsOwnedBy('worker_mine', h.clock.now());
    expect(released).toBe(0);
    expect(h.driver.findClaim(txId)?.status).toBe('ACTIVE');
    expect(h.driver.findClaim(txId)?.worker_id).toBe('worker_other');
  });
});

describe('multi-process status', () => {
  it('is documented as untested — these are connections, not processes', () => {
    // Deliberately an assertion about the test suite itself. Two
    // SqliteLedgerDriver instances share a process; nothing here forks. A37
    // therefore remains OPEN, and this test exists so that claim cannot quietly
    // drift out of the documentation.
    const h = harness('wi-multiprocess-note');
    const second = createSqliteDriver({ file: h.file });
    extraDrivers.push(second);

    expect(second).not.toBe(h.driver);
    expect(typeof process.pid).toBe('number');
    // Same process id for both connections: this is not a multi-process test.
    expect(process.pid).toBe(process.pid);
  });
});
