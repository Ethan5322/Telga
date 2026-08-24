/**
 * The recovery sweep: basic recovery, thresholds, and provider outcomes.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { transactionId } from '@telga/domain';
import { createSale, recoverInFlight, classifyLookupFailure, policyFor, minimumRecoveryAgeMs } from '@telga/api';
import {
  diagnose,
  fixedStatusProvider,
  makeRecoveryHarness,
  MERCHANT_A,
  namedError,
  PROVIDER,
  saleRequest,
  TEST_RECOVERY_CONFIG,
  throwingProvider,
  withProvider,
} from './helpers';
import type { RecoveryHarness } from './helpers';

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

/** Leave a transaction stuck at PROCESSING by failing the outcome unit of work. */
async function stuckProcessing(h: RecoveryHarness) {
  const { failAt, withDriver } = await import('../orchestration/helpers');
  // Identify the new row by diffing. Ids sort lexicographically, so neither
  // the first nor the last row is reliably the newest.
  const before = new Set(h.driver.findTransactionsByMerchant(MERCHANT_A).map((r) => r.id));
  const deps = withDriver(h.deps, failAt(h.driver, 'saveTransaction', 5));
  await expect(createSale(deps, saleRequest())).rejects.toThrow();
  const row = h.driver.findTransactionsByMerchant(MERCHANT_A).find((r) => !before.has(r.id));
  expect(row?.state).toBe('PROCESSING');
  return transactionId(row?.id ?? '');
}

/** Leave a transaction stuck at RESERVED — the provider was never called. */
async function stuckReserved(h: RecoveryHarness) {
  const { failAt, withDriver } = await import('../orchestration/helpers');
  // Fail the PROCESSING persist, which happens after the reservation commits.
  const deps = withDriver(h.deps, failAt(h.driver, 'saveTransaction', 4));
  await expect(createSale(deps, saleRequest())).rejects.toThrow();
  const row = h.driver.findTransactionsByMerchant(MERCHANT_A)[0];
  expect(row?.state).toBe('RESERVED');
  return transactionId(row?.id ?? '');
}

describe('basic recovery', () => {
  it('old PROCESSING with provider success is recovered and finalized once', async () => {
    const h = harness('rec-success', { behaviour: 'SUCCESS' });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);

    const report = await recoverInFlight(withProvider(h.recoveryDeps, fixedStatusProvider('SUCCESS')));

    expect(report.found).toBe(1);
    expect(report.claimed).toBe(1);
    expect(report.recoveredSuccessful).toBe(1);
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('SUCCESSFUL');
    expect(h.driver.findReservation(txId, MERCHANT_A)?.status).toBe('SETTLED');

    const view = h.driver.balanceFor(MERCHANT_A);
    expect(view.available.minor).toBe(7500);
    expect(view.reserved.minor).toBe(0);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });

  it('old PROCESSING with provider failure releases exactly once', async () => {
    const h = harness('rec-failure', { behaviour: 'SUCCESS' });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);

    const report = await recoverInFlight(withProvider(h.recoveryDeps, fixedStatusProvider('FAILURE')));

    expect(report.recoveredFailed).toBe(1);
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('FAILED');
    expect(h.driver.findReservation(txId, MERCHANT_A)?.status).toBe('RELEASED');
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(10000);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });

  it('old PROCESSING with an unknown result holds the reservation', async () => {
    const h = harness('rec-unknown', { behaviour: 'SUCCESS' });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);

    const report = await recoverInFlight(
      withProvider(h.recoveryDeps, fixedStatusProvider('STILL_PENDING')),
    );

    expect(report.movedToPending).toBe(1);
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('PENDING');
    expect(h.driver.findReservation(txId, MERCHANT_A)?.status).toBe('HELD');

    const view = h.driver.balanceFor(MERCHANT_A);
    expect(view.reserved.minor).toBe(2500);
    expect(view.available.minor).toBe(7500);
    expect(view.total.minor).toBe(10000);
  });

  it('old RESERVED with proven no submission releases the funds', async () => {
    const h = harness('rec-reserved', { behaviour: 'SUCCESS' });
    const txId = await stuckReserved(h);
    h.clock.advance(120_000);

    const report = await recoverInFlight(h.recoveryDeps);

    expect(report.releasedNeverSubmitted).toBe(1);
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('FAILED');
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(10000);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });

  it('the never-submitted path takes only legal domain transitions', async () => {
    const h = harness('rec-reserved-legal', { behaviour: 'SUCCESS' });
    const txId = await stuckReserved(h);
    h.clock.advance(120_000);
    await recoverInFlight(h.recoveryDeps);

    // RESERVED -> FAILED is not a legal edge, so it went via PROCESSING.
    const events = h.driver.readAuditEvents(MERCHANT_A).filter((e) => e.entity_id === txId);
    expect(events.some((e) => e.event_type === 'RECOVERY_RECOVERED_FAILED')).toBe(true);
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('FAILED');
  });

  it('recent PROCESSING is ignored', async () => {
    const h = harness('rec-recent-processing', { behaviour: 'SUCCESS' });
    await stuckProcessing(h);
    h.clock.advance(1_000);

    const report = await recoverInFlight(h.recoveryDeps);
    expect(report.found).toBe(0);
    expect(report.claimed).toBe(0);
  });

  it('recent RESERVED is ignored', async () => {
    const h = harness('rec-recent-reserved', { behaviour: 'SUCCESS' });
    const txId = await stuckReserved(h);
    h.clock.advance(1_000);

    const report = await recoverInFlight(h.recoveryDeps);
    expect(report.found).toBe(0);
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('RESERVED');
  });

  it('terminal transactions are never touched', async () => {
    const h = harness('rec-terminal', { behaviour: 'SUCCESS' });
    const sale = await createSale(h.deps, saleRequest());
    expect(sale.kind).toBe('SUCCESSFUL');
    h.clock.advance(600_000);

    const report = await recoverInFlight(h.recoveryDeps);
    expect(report.found).toBe(0);
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(7500);
  });
});

describe('threshold and clock behaviour', () => {
  it('one second younger than the threshold is not recovered', async () => {
    const h = harness('rec-boundary-young', { behaviour: 'SUCCESS' });
    await stuckProcessing(h);
    h.clock.advance(TEST_RECOVERY_CONFIG.recoveryAgeMs - 1_000);

    expect((await recoverInFlight(h.recoveryDeps)).found).toBe(0);
  });

  it('exactly at the threshold is recovered', async () => {
    const h = harness('rec-boundary-exact', { behaviour: 'SUCCESS' });
    await stuckProcessing(h);
    h.clock.advance(TEST_RECOVERY_CONFIG.recoveryAgeMs);

    const report = await recoverInFlight(
      withProvider(h.recoveryDeps, fixedStatusProvider('STILL_PENDING')),
    );
    expect(report.found).toBe(1);
    expect(report.claimed).toBe(1);
  });

  it('older than the threshold is recovered', async () => {
    const h = harness('rec-boundary-old', { behaviour: 'SUCCESS' });
    await stuckProcessing(h);
    h.clock.advance(TEST_RECOVERY_CONFIG.recoveryAgeMs * 5);

    expect((await recoverInFlight(withProvider(h.recoveryDeps, fixedStatusProvider('STILL_PENDING')))).claimed).toBe(1);
  });

  it('a provider-specific threshold overrides the base policy', async () => {
    const h = harness('rec-provider-threshold', {
      behaviour: 'SUCCESS',
      recovery: { perProvider: { [PROVIDER]: { recoveryAgeMs: 600_000 } } },
    });
    await stuckProcessing(h);

    // Past the base threshold, but not past this provider's.
    h.clock.advance(120_000);
    const first = await recoverInFlight(h.recoveryDeps);
    expect(first.claimed).toBe(0);
    expect(first.results[0]?.kind).toBe('SKIPPED_TOO_RECENT');

    h.clock.advance(600_000);
    const second = await recoverInFlight(
      withProvider(h.recoveryDeps, fixedStatusProvider('STILL_PENDING')),
    );
    expect(second.claimed).toBe(1);
  });

  it('resolves per-provider policy and the minimum scan age', () => {
    const config = { ...TEST_RECOVERY_CONFIG, perProvider: { p1: { recoveryAgeMs: 5_000 } } };
    expect(policyFor(config, 'p1').recoveryAgeMs).toBe(5_000);
    expect(policyFor(config, 'p1').pendingMaximumMs).toBe(TEST_RECOVERY_CONFIG.pendingMaximumMs);
    expect(policyFor(config, 'other').recoveryAgeMs).toBe(TEST_RECOVERY_CONFIG.recoveryAgeMs);
    expect(minimumRecoveryAgeMs(config)).toBe(5_000);
  });

  it('the pending maximum is configuration, not code', async () => {
    const h = harness('rec-pending-config', {
      behaviour: 'SUCCESS',
      recovery: { pendingMaximumMs: 1 },
    });
    await stuckProcessing(h);
    h.clock.advance(120_000);

    // With a one-millisecond pending maximum, the first indeterminate lookup
    // escalates immediately.
    const report = await recoverInFlight(
      withProvider(h.recoveryDeps, fixedStatusProvider('STILL_PENDING')),
    );
    expect(report.escalatedUnderReview).toBe(1);
  });

  it('the service reads no wall clock of its own', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('../../services/api/src/application/recovery/recoverInFlight.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain('Date.now(');
    expect(source).not.toContain('new Date()');
  });
});

describe('provider outcome classification', () => {
  const cases: [string, string | undefined, string][] = [
    ['AuthError', undefined, 'AUTH_OR_CONFIG_FAILURE'],
    ['Error', 'EACCES', 'AUTH_OR_CONFIG_FAILURE'],
    ['ConfigurationError', undefined, 'AUTH_OR_CONFIG_FAILURE'],
    ['MalformedResponseError', undefined, 'MALFORMED_RESPONSE'],
    ['SyntaxError', undefined, 'MALFORMED_RESPONSE'],
    ['Error', 'ECONNREFUSED', 'PROVIDER_UNAVAILABLE'],
    ['TimeoutError', undefined, 'PROVIDER_UNAVAILABLE'],
    ['SomethingElse', undefined, 'UNKNOWN'],
  ];

  it.each(cases)('classifies %s / %s as %s', (name, code, expected) => {
    expect(classifyLookupFailure(namedError(name, code))).toBe(expected);
  });

  it('never releases funds on an unavailable provider', async () => {
    const h = harness('rec-unavailable', { behaviour: 'SUCCESS' });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);

    const report = await recoverInFlight(
      withProvider(h.recoveryDeps, throwingProvider(namedError('Error', 'ECONNREFUSED'))),
    );

    expect(report.results[0]?.providerOutcome).toBe('PROVIDER_UNAVAILABLE');
    expect(h.driver.balanceFor(MERCHANT_A).reserved.minor).toBe(2500);
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('PENDING');
  });

  it('never releases funds on a malformed response', async () => {
    const h = harness('rec-malformed', { behaviour: 'SUCCESS' });
    await stuckProcessing(h);
    h.clock.advance(120_000);

    const report = await recoverInFlight(
      withProvider(h.recoveryDeps, throwingProvider(namedError('MalformedResponseError'))),
    );

    expect(report.results[0]?.providerOutcome).toBe('MALFORMED_RESPONSE');
    expect(h.driver.balanceFor(MERCHANT_A).reserved.minor).toBe(2500);
  });

  it('an unknown reference holds funds and does not fail the sale', async () => {
    const h = harness('rec-unknown-ref', { behaviour: 'SUCCESS' });
    await stuckProcessing(h);
    h.clock.advance(120_000);

    const report = await recoverInFlight(
      withProvider(h.recoveryDeps, fixedStatusProvider('UNKNOWN_REFERENCE')),
    );

    expect(report.results[0]?.providerOutcome).toBe('UNKNOWN');
    expect(report.recoveredFailed).toBe(0);
    expect(h.driver.balanceFor(MERCHANT_A).reserved.minor).toBe(2500);
  });

  it('an authorization failure raises an operational alert, not a customer failure', async () => {
    const h = harness('rec-auth', { behaviour: 'SUCCESS' });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);

    const report = await recoverInFlight(
      withProvider(h.recoveryDeps, throwingProvider(namedError('AuthError'))),
    );

    expect(report.results[0]?.providerOutcome).toBe('AUTH_OR_CONFIG_FAILURE');
    expect(report.results[0]?.operationalAlert).toBe(true);
    expect(report.operationalAlerts).toBe(1);
    // Not disguised as a failed sale.
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).not.toBe('FAILED');
    expect(h.driver.balanceFor(MERCHANT_A).reserved.minor).toBe(2500);

    const events = h.driver.readAuditEvents(MERCHANT_A);
    expect(events.some((e) => e.event_type === 'RECOVERY_ATTEMPT_FAILED')).toBe(true);
  });

  it('records only a safe outcome category, never a provider body', async () => {
    const h = harness('rec-safe-category', { behaviour: 'SUCCESS' });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);
    await recoverInFlight(withProvider(h.recoveryDeps, throwingProvider(namedError('AuthError'))));

    const job = h.driver.findPendingResolution(txId);
    expect(job?.last_outcome_category).toBe('AUTH_OR_CONFIG_FAILURE');

    const dump = JSON.stringify(h.driver.readAuditEvents());
    expect(dump).not.toContain('stub failure');
  });
});

describe('escalation to manual review', () => {
  it('escalates past the pending deadline and opens exactly one case', async () => {
    const h = harness('rec-escalate', { behaviour: 'SUCCESS', recovery: { pendingMaximumMs: 60_000 } });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);

    const deps = withProvider(h.recoveryDeps, fixedStatusProvider('STILL_PENDING'));

    // The transaction has already been stuck 120s against a 60s pending maximum,
    // so it is past its deadline the first time the sweep reaches it.
    const first = await recoverInFlight(deps);
    expect(first.escalatedUnderReview).toBe(1);

    // A second sweep finds nothing left to do and changes nothing.
    h.clock.advance(120_000);
    const second = await recoverInFlight(deps);
    expect(second.escalatedUnderReview).toBe(0);
    expect(second.found).toBe(0);

    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('UNDER_REVIEW');

    const view = h.driver.balanceFor(MERCHANT_A);
    expect(view.underReview.minor).toBe(2500);
    expect(view.reserved.minor).toBe(0);
    expect(view.available.minor).toBe(7500);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
    expect(h.driver.findSupportCasesByMerchant(MERCHANT_A)).toHaveLength(1);
  });

  it('escalates once attempts are exhausted, even before the deadline', async () => {
    const h = harness('rec-attempts', {
      behaviour: 'SUCCESS',
      recovery: { pendingMaximumMs: 10_000_000, maxStatusAttempts: 2 },
    });
    const txId = await stuckProcessing(h);
    const deps = withProvider(h.recoveryDeps, fixedStatusProvider('STILL_PENDING'));

    for (let i = 0; i < 3; i += 1) {
      h.clock.advance(120_000);
      await recoverInFlight(deps);
    }

    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('UNDER_REVIEW');
    expect(h.driver.findSupportCasesByMerchant(MERCHANT_A)).toHaveLength(1);
  });

  it('does not refund an unknown outcome', async () => {
    const h = harness('rec-no-refund', { behaviour: 'SUCCESS', recovery: { pendingMaximumMs: 1 } });
    await stuckProcessing(h);
    h.clock.advance(120_000);

    await recoverInFlight(withProvider(h.recoveryDeps, fixedStatusProvider('STILL_PENDING')));

    // Value is held under review, not returned.
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(7500);
    expect(h.driver.balanceFor(MERCHANT_A).underReview.minor).toBe(2500);
  });

  it('marks manual review open on the pending row', async () => {
    const h = harness('rec-manual-flag', { behaviour: 'SUCCESS', recovery: { pendingMaximumMs: 1 } });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);
    const report = await recoverInFlight(withProvider(h.recoveryDeps, fixedStatusProvider('STILL_PENDING')));

    // Asserted first, so a recurrence of A44 immediately distinguishes "the
    // escalation did not happen" from "a swallowed per-transaction failure
    // prevented it".
    expect(report.recoveryFailures, JSON.stringify(report.results)).toBe(0);
    expect(report.escalatedUnderReview).toBe(1);

    const job = h.driver.findPendingResolution(txId);
    // On failure, report what the system actually looked like — see A44.
    const state = diagnose(h.driver, txId, MERCHANT_A);
    expect(job?.manual_review_status, JSON.stringify(state)).toBe('OPEN');
    expect(job?.status, JSON.stringify(state)).toBe('ESCALATED');
  });
});

describe('pending resolution metadata', () => {
  it('maintains references, attempts, next check and deadline', async () => {
    const h = harness('rec-metadata', { behaviour: 'SUCCESS' });
    const txId = await stuckProcessing(h);
    h.clock.advance(120_000);
    await recoverInFlight(withProvider(h.recoveryDeps, fixedStatusProvider('STILL_PENDING')));

    const job = h.driver.findPendingResolution(txId);
    expect(job?.transaction_id).toBe(txId);
    expect(job?.merchant_id).toBe(MERCHANT_A);
    expect(job?.idempotency_key.length).toBeGreaterThan(0);
    expect(job?.correlation_id.length).toBeGreaterThan(0);
    expect(job?.attempts).toBe(1);
    expect(job?.next_check_at).toBeTruthy();
    expect(job?.deadline_at).toBeTruthy();
    expect(job?.current_state).toBe('PENDING');
    expect(job?.first_pending_at).toBeTruthy();
    expect(job?.last_attempt_at).toBeTruthy();
  });

  it('never creates a duplicate pending row for one transaction', async () => {
    const h = harness('rec-no-dup-pending', { behaviour: 'SUCCESS' });
    const txId = await stuckProcessing(h);
    const deps = withProvider(h.recoveryDeps, fixedStatusProvider('STILL_PENDING'));

    for (let i = 0; i < 3; i += 1) {
      h.clock.advance(120_000);
      await recoverInFlight(deps);
    }

    const rows = h.driver.unsafeConnection
      .prepare('SELECT COUNT(*) AS n FROM pending_resolutions WHERE transaction_id = ?')
      .get(txId) as { n: number };
    expect(rows.n).toBe(1);
  });
});
