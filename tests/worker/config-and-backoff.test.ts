/**
 * Worker configuration validation and backoff arithmetic.
 */

import { describe, expect, it } from 'vitest';
import {
  advanceBackoff,
  baseBackoffMs,
  DEVELOPMENT_RECOVERY_WORKER_POLICY,
  initialBackoffState,
  loadWorkerPolicy,
  MINIMUM_RECOVERY_INTERVAL_MS,
  nextDelayMs,
  NOT_YET_CONFIRMED,
  PRODUCTION_RECOVERY_WORKER_POLICY,
  productionPolicyFrom,
  resetBackoff,
  TEST_RECOVERY_WORKER_POLICY,
  validateWorkerPolicy,
  WorkerConfigurationError,
  assertNotDevelopmentPolicyInProduction,
} from '@telga/worker';
import { policy, productionSource } from './helpers';

describe('named policies', () => {
  it('development and test policies are valid', () => {
    expect(() => validateWorkerPolicy(DEVELOPMENT_RECOVERY_WORKER_POLICY)).not.toThrow();
    expect(() => validateWorkerPolicy(TEST_RECOVERY_WORKER_POLICY)).not.toThrow();
  });

  it('the production policy carries no numbers at all', () => {
    for (const value of Object.values(PRODUCTION_RECOVERY_WORKER_POLICY)) {
      expect(value).toBe(NOT_YET_CONFIRMED);
    }
  });

  it('production configuration must be explicit', () => {
    expect(() => productionPolicyFrom({})).toThrow(WorkerConfigurationError);
    try {
      productionPolicyFrom({});
    } catch (error) {
      expect((error as WorkerConfigurationError).code).toBe('MISSING_SETTING');
    }
  });

  it('production builds from a complete configuration source', () => {
    const built = productionPolicyFrom(productionSource());
    expect(built.recoveryIntervalMs).toBe(30_000);
    expect(built.recoveryWorkerEnabled).toBe(true);
  });

  it('a single missing production setting fails the whole load', () => {
    const source = productionSource();
    delete (source as Record<string, string | undefined>).TELGA_CLAIM_LEASE_MS;
    expect(() => productionPolicyFrom(source)).toThrow(/TELGA_CLAIM_LEASE_MS/);
  });

  it('a non-numeric production setting is rejected', () => {
    expect(() => productionPolicyFrom(productionSource({ TELGA_RECOVERY_INTERVAL_MS: 'soon' }))).toThrow(
      /not a number/i,
    );
  });

  it('production never silently falls back to development values', () => {
    expect(() => loadWorkerPolicy('production', {})).toThrow(WorkerConfigurationError);
    expect(() => {
      assertNotDevelopmentPolicyInProduction('production', DEVELOPMENT_RECOVERY_WORKER_POLICY);
    }).toThrow(/Refusing to run a development or test policy/);
    expect(() => {
      assertNotDevelopmentPolicyInProduction('development', DEVELOPMENT_RECOVERY_WORKER_POLICY);
    }).not.toThrow();
  });

  it('loads development and test policies by name', () => {
    expect(loadWorkerPolicy('development').recoveryIntervalMs).toBe(
      DEVELOPMENT_RECOVERY_WORKER_POLICY.recoveryIntervalMs,
    );
    expect(loadWorkerPolicy('test').recoveryIntervalMs).toBe(TEST_RECOVERY_WORKER_POLICY.recoveryIntervalMs);
  });
});

describe('validation', () => {
  const cases: [string, Parameters<typeof policy>[0], string][] = [
    ['a zero interval', { recoveryIntervalMs: 0 }, 'NOT_POSITIVE'],
    ['an interval below the safe minimum', { recoveryIntervalMs: 10 }, 'INTERVAL_TOO_SHORT'],
    ['negative jitter', { recoveryJitterMs: -1 }, 'NEGATIVE'],
    ['a zero batch limit', { recoveryBatchLimit: 0 }, 'BATCH_LIMIT_TOO_SMALL'],
    ['a zero shutdown timeout', { gracefulShutdownTimeoutMs: 0 }, 'NOT_POSITIVE'],
    [
      'a maximum backoff below the initial',
      { failureBackoffInitialMs: 10_000, failureBackoffMaximumMs: 1_000 },
      'BACKOFF_MAXIMUM_BELOW_INITIAL',
    ],
    ['a shrinking backoff multiplier', { failureBackoffMultiplier: 0.5 }, 'BACKOFF_MULTIPLIER_TOO_SMALL'],
    ['a lease shorter than one operation', { claimLeaseMs: 500 }, 'CLAIM_LEASE_TOO_SHORT'],
    [
      'a pending maximum below the recovery age',
      { pendingMaximumMs: 1_000, recoveryAgeMs: 60_000 },
      'PENDING_MAXIMUM_BELOW_RECOVERY_AGE',
    ],
  ];

  it.each(cases)('rejects %s', (_label, overrides, code) => {
    try {
      validateWorkerPolicy(policy(overrides));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerConfigurationError);
      expect((error as WorkerConfigurationError).code).toBe(code);
    }
  });

  it('allows a pending maximum below the recovery age with an explicit override', () => {
    expect(() =>
      validateWorkerPolicy(
        policy({
          pendingMaximumMs: 1_000,
          recoveryAgeMs: 60_000,
          allowPendingMaximumBelowRecoveryAge: true,
        }),
      ),
    ).not.toThrow();
  });

  it('names the offending setting on the error', () => {
    try {
      validateWorkerPolicy(policy({ recoveryBatchLimit: 0 }));
    } catch (error) {
      expect((error as WorkerConfigurationError).setting).toBe('recoveryBatchLimit');
    }
  });

  it('the minimum interval is a documented constant', () => {
    expect(MINIMUM_RECOVERY_INTERVAL_MS).toBeGreaterThan(0);
  });
});

describe('backoff', () => {
  const p = policy({
    failureBackoffInitialMs: 1_000,
    failureBackoffMaximumMs: 8_000,
    failureBackoffMultiplier: 2,
    recoveryJitterMs: 0,
  });

  it('starts at zero', () => {
    const state = initialBackoffState();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.currentDelayMs).toBe(0);
  });

  it('the first failure uses the initial backoff', () => {
    const state = advanceBackoff(p, initialBackoffState(), () => 0);
    expect(state.consecutiveFailures).toBe(1);
    expect(state.currentDelayMs).toBe(1_000);
  });

  it('repeated failures increase the backoff exponentially', () => {
    let state = initialBackoffState();
    const seen: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      state = advanceBackoff(p, state, () => 0);
      seen.push(state.currentDelayMs);
    }
    expect(seen).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it('is capped at the configured maximum', () => {
    let state = initialBackoffState();
    for (let i = 0; i < 20; i += 1) state = advanceBackoff(p, state, () => 0);
    expect(state.currentDelayMs).toBe(8_000);
    expect(baseBackoffMs(p, 50)).toBe(8_000);
  });

  it('applies jitter within the configured bound', () => {
    const jittered = policy({ ...p, recoveryJitterMs: 500 });
    const low = advanceBackoff(jittered, initialBackoffState(), () => 0);
    const high = advanceBackoff(jittered, initialBackoffState(), () => 0.999);

    expect(low.currentDelayMs).toBe(1_000);
    expect(high.currentDelayMs).toBeGreaterThan(1_000);
    expect(high.currentDelayMs).toBeLessThanOrEqual(1_000 + 500);
  });

  it('a successful sweep resets it', () => {
    let state = advanceBackoff(p, initialBackoffState(), () => 0);
    state = advanceBackoff(p, state, () => 0);
    expect(state.consecutiveFailures).toBe(2);

    const reset = resetBackoff();
    expect(reset.consecutiveFailures).toBe(0);
    expect(reset.currentDelayMs).toBe(0);
  });

  it('the delay is the interval when healthy and the backoff when failing', () => {
    const healthy = nextDelayMs(p, initialBackoffState(), () => 0);
    expect(healthy).toBe(p.recoveryIntervalMs);

    const failing = nextDelayMs(p, advanceBackoff(p, initialBackoffState(), () => 0), () => 0);
    expect(failing).toBe(1_000);
  });

  it('adds jitter to the healthy interval too, so workers desynchronize', () => {
    const jittered = policy({ recoveryIntervalMs: 10_000, recoveryJitterMs: 1_000 });
    const a = nextDelayMs(jittered, initialBackoffState(), () => 0);
    const b = nextDelayMs(jittered, initialBackoffState(), () => 0.9);

    expect(a).toBe(10_000);
    expect(b).toBeGreaterThan(10_000);
    expect(b).toBeLessThanOrEqual(11_000);
  });
});
