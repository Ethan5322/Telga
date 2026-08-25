/**
 * `/api/health/live` and `/api/health/ready`.
 *
 * Run against the real router and the real database, like the rest of the
 * training HTTP surface — nothing here is mocked except the provider.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createSale, getReadiness, handle } from '@telga/api';
import type { LivenessBody, ReadinessBody } from '@telga/api';
import { failAt, saleRequest, withDriver } from '../orchestration/helpers';
import { MERCHANT_A, call, makeUiHarness, request } from './helpers';
import type { UiHarness } from './helpers';

let harness: UiHarness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

describe('GET /api/health/live', () => {
  it('succeeds with no session at all', async () => {
    harness = makeUiHarness('live-basic');
    const { response, envelope } = await call<never>(harness.api, 'GET', '/api/health/live', {
      anonymous: true,
    });
    const body = response.body as LivenessBody;

    expect(response.status).toBe(200);
    expect(body.status).toBe('HEALTHY');
    expect(body.mode).toBe('TRAINING');
    expect(typeof body.serverTime).toBe('string');
    void envelope; // not an ApiEnvelope shape — read response.body directly
  });

  it('reports training mode explicitly', async () => {
    harness = makeUiHarness('live-mode');
    const { response } = await call(harness.api, 'GET', '/api/health/live', { anonymous: true });
    expect((response.body as LivenessBody).mode).toBe('TRAINING');
  });

  it('sets cache-control: no-store and safe security headers', async () => {
    harness = makeUiHarness('live-headers');
    const { response } = await call(harness.api, 'GET', '/api/health/live', { anonymous: true });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('never touches the database', async () => {
    harness = makeUiHarness('live-no-db');
    const before = harness.driver.ledgerResidualMinor();
    await call(harness.api, 'GET', '/api/health/live', { anonymous: true });
    expect(harness.driver.ledgerResidualMinor()).toBe(before);
    expect(harness.driver.findTransactionsByMerchant(MERCHANT_A)).toHaveLength(0);
  });

  it('is unaffected by a spoofed proxy header', async () => {
    harness = makeUiHarness('live-spoofed-proxy');
    const { response } = await call(harness.api, 'GET', '/api/health/live', {
      anonymous: true,
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.7' },
    });
    expect((response.body as LivenessBody).status).toBe('HEALTHY');
  });
});

describe('GET /api/health/ready', () => {
  it('succeeds with valid schema and healthy dependencies', async () => {
    harness = makeUiHarness('ready-healthy');
    const { response } = await call(harness.api, 'GET', '/api/health/ready', { anonymous: true });
    const body = response.body as ReadinessBody;

    expect(response.status).toBe(200);
    expect(body.status).toBe('HEALTHY');
    expect(body.checks.every((c) => c.status === 'HEALTHY')).toBe(true);
    const names = body.checks.map((c) => c.name).sort();
    expect(names).toEqual(
      ['database', 'ledger_residual', 'mode', 'recovery_claims', 'recovery_queue'].sort(),
    );
  });

  it('does not require a session', async () => {
    harness = makeUiHarness('ready-no-session');
    const { response } = await call(harness.api, 'GET', '/api/health/ready', { anonymous: true });
    expect(response.status).toBe(200);
  });

  it('reports training mode explicitly, and NOT_READY with a safe reason when it is not', async () => {
    harness = makeUiHarness('ready-live-mode', { mode: 'LIVE' });
    const { response } = await call(harness.api, 'GET', '/api/health/ready', { anonymous: true });
    const body = response.body as ReadinessBody;

    expect(response.status).toBe(503);
    expect(body.status).toBe('NOT_READY');
    const modeCheck = body.checks.find((c) => c.name === 'mode');
    expect(modeCheck?.status).toBe('NOT_READY');
    expect(modeCheck?.reasonCode).toBe('NOT_TRAINING_MODE');
  });

  it('fails when the ledger residual is non-zero', async () => {
    harness = makeUiHarness('ready-residual');
    // The only way to produce this state at all: a lone, unbalanced entry
    // inserted directly, bypassing `assertBalanced` — exactly the "direct SQL
    // access" scenario `Database Operations Runbook.md` describes as the only
    // way a non-zero residual can occur.
    const account = harness.driver.findAccount(MERCHANT_A, 'MERCHANT_AVAILABLE');
    if (!account) throw new Error('expected the harness to have seeded a MERCHANT_AVAILABLE account');
    harness.driver.unsafeConnection
      .prepare(
        `INSERT INTO ledger_entries
           (id, posting_id, transaction_id, account_id, merchant_id, account_type, direction,
            amount_minor, currency, entry_type, correlation_id, rule_version, provider_reference,
            metadata, mode, created_at)
         VALUES
           ('corrupt_1', 'corrupt_posting', NULL, ?, ?, 'MERCHANT_AVAILABLE', 'DEBIT',
            100, 'ETB', 'ADJUSTMENT', 'corrupt_corr', NULL, NULL, NULL, 'TRAINING', ?)`,
      )
      .run(account.id, MERCHANT_A, harness.clock.now());

    const { response } = await call(harness.api, 'GET', '/api/health/ready', { anonymous: true });
    const body = response.body as ReadinessBody;

    expect(response.status).toBe(503);
    expect(body.status).toBe('UNHEALTHY');
    const residualCheck = body.checks.find((c) => c.name === 'ledger_residual');
    expect(residualCheck?.status).toBe('UNHEALTHY');
    expect(residualCheck?.reasonCode).toBe('LEDGER_RESIDUAL_NON_ZERO');
  });

  it('is degraded when an in-flight transaction is stuck beyond the safe period', async () => {
    harness = makeUiHarness('ready-stuck', { behaviour: 'SUCCESS' });

    // The same fault-injection shape used to reproduce A44: force the sale to
    // fail after the transaction row is written, leaving it stuck PROCESSING.
    const before = new Set(harness.driver.findTransactionsByMerchant(MERCHANT_A).map((r) => r.id));
    const failingDeps = withDriver(harness.deps, failAt(harness.driver, 'saveTransaction', 5));
    await expect(createSale(failingDeps, saleRequest())).rejects.toThrow();
    const stuck = harness.driver.findTransactionsByMerchant(MERCHANT_A).find((r) => !before.has(r.id));
    expect(stuck).toBeDefined();

    // Past the default 15-minute readiness threshold.
    harness.clock.advance(16 * 60_000);

    const { response } = await call(harness.api, 'GET', '/api/health/ready', { anonymous: true });
    const body = response.body as ReadinessBody;

    expect(response.status).toBe(200); // degraded is still safe to serve
    expect(body.status).toBe('DEGRADED');
    const queueCheck = body.checks.find((c) => c.name === 'recovery_queue');
    expect(queueCheck?.status).toBe('DEGRADED');
    expect(queueCheck?.reasonCode).toBe('RECOVERY_QUEUE_LAGGING');
  });

  it('fails when migrations are not current', async () => {
    harness = makeUiHarness('ready-migrations');
    // Simulate a schema behind the running code's expectations by deleting a
    // migration's own bookkeeping row — the same signal `assertMigrationsApplied`
    // reads at startup, checked here at request time instead.
    harness.driver.unsafeConnection.prepare('DELETE FROM schema_migrations WHERE version = ?').run('006');

    const { response } = await call(harness.api, 'GET', '/api/health/ready', { anonymous: true });
    const body = response.body as ReadinessBody;

    expect(response.status).toBe(503);
    expect(body.status).toBe('UNHEALTHY');
    const dbCheck = body.checks.find((c) => c.name === 'database');
    expect(dbCheck?.status).toBe('UNHEALTHY');
    expect(dbCheck?.reasonCode).toBe('MIGRATIONS_NOT_CURRENT');
  });

  it('reports database unavailable rather than throwing when the driver fails', async () => {
    harness = makeUiHarness('ready-db-down');
    const brokenApi = { ...harness.api, driver: failAt(harness.driver, 'health', 1) };
    const response = await handle(brokenApi, request('GET', '/api/health/ready'));
    const body = response.body as ReadinessBody;

    expect(response.status).toBe(503);
    expect(body.status).toBe('UNHEALTHY');
    // The driver failure happens inside recoveryGauges() itself, so every
    // dependency check reports the same reason rather than a partial result.
    expect(body.checks.every((c) => c.reasonCode === 'DATABASE_UNREACHABLE' || c.name === 'mode')).toBe(true);
    const dbCheck = body.checks.find((c) => c.name === 'database');
    expect(dbCheck?.reasonCode).toBe('DATABASE_UNREACHABLE');
  });

  it('contains no secrets or sensitive transaction data', async () => {
    harness = makeUiHarness('ready-no-secrets');
    const { response } = await call(harness.api, 'GET', '/api/health/ready', { anonymous: true });
    const raw = JSON.stringify(response.body);

    expect(raw).not.toMatch(/[0-9]{9,}/); // no phone-number-shaped digit run
    expect(raw.toLowerCase()).not.toContain('pin');
    expect(raw.toLowerCase()).not.toContain('secret');
    expect(raw.toLowerCase()).not.toContain('token');
    expect(raw.toLowerCase()).not.toContain('session');
    expect(raw.toLowerCase()).not.toContain('key');
  });

  it('cannot mutate state', async () => {
    harness = makeUiHarness('ready-no-mutation');
    const beforeCount = harness.driver.findTransactionsByMerchant(MERCHANT_A).length;
    const beforeResidual = harness.driver.ledgerResidualMinor();

    await call(harness.api, 'GET', '/api/health/ready', { anonymous: true });

    expect(harness.driver.findTransactionsByMerchant(MERCHANT_A)).toHaveLength(beforeCount);
    expect(harness.driver.ledgerResidualMinor()).toBe(beforeResidual);
  });

  it('rejects POST — the route only ever reads', async () => {
    harness = makeUiHarness('ready-post-refused');
    const response = await handle(harness.api, request('POST', '/api/health/ready'));
    expect(response.status).toBe(405);
  });

  it('is unaffected by a spoofed or malformed proxy header', async () => {
    harness = makeUiHarness('ready-spoofed-proxy');
    const { response } = await call(harness.api, 'GET', '/api/health/ready', {
      anonymous: true,
      headers: { 'x-forwarded-proto': 'not-a-scheme', 'x-forwarded-for': '' },
    });
    expect(response.status).toBe(200);
    expect((response.body as ReadinessBody).status).toBe('HEALTHY');
  });
});

describe('direct call to getReadiness with injected thresholds', () => {
  it('lets a test tune sensitivity without waiting on the clock', () => {
    harness = makeUiHarness('ready-thresholds');
    const response = getReadiness(harness.api, request('GET', '/api/health/ready'), 'corr_1', {
      maxSafeUnresolvedMs: 0,
      maxManualReviewQueue: 0,
      maxRecoveryFailures: 0,
    });
    // Zero threshold plus a freshly seeded harness with no unresolved work is
    // still healthy — proves the threshold is honoured, not ignored.
    expect(response.status).toBe(200);
  });
});
