/**
 * Recovery configuration.
 *
 * Every threshold is injected. There is **no production default in the service
 * itself** — `DEVELOPMENT_RECOVERY_POLICY` exists only so tests and local runs
 * have something to start from, and it is named to make using it in production
 * an obvious mistake.
 *
 * Per-provider overrides exist because "how long before a silence means
 * something" is a property of the provider, not of Telga. Once a provider
 * agreement states its own timeout semantics, that number goes here rather than
 * into code.
 */

import type { ProviderId } from '@telga/domain';

export interface RecoveryPolicy {
  /** How old an in-flight transaction must be before the sweep touches it. */
  readonly recoveryAgeMs: number;
  /** How long a transaction may stay unresolved before escalation. */
  readonly pendingMaximumMs: number;
  /** Status lookups before escalating regardless of the clock. */
  readonly maxStatusAttempts: number;
  /** How long a worker owns a claimed transaction. */
  readonly claimLeaseMs: number;
  /** Gap between status lookups, written to `next_check_at`. */
  readonly statusCheckIntervalMs: number;
  /** Maximum transactions examined per sweep. */
  readonly batchLimit: number;
}

export interface RecoveryConfig extends RecoveryPolicy {
  /** Overrides keyed by provider id. Any omitted field falls back to the base policy. */
  readonly perProvider?: Readonly<Record<string, Partial<RecoveryPolicy>>>;
}

/**
 * A starting point for development and tests.
 *
 * **Not a production policy.** Real values depend on the provider's contracted
 * timeout and settlement behaviour, which is NOT YET CONFIRMED.
 */
export const DEVELOPMENT_RECOVERY_POLICY: RecoveryPolicy = Object.freeze({
  recoveryAgeMs: 60_000,
  pendingMaximumMs: 5 * 60_000,
  maxStatusAttempts: 5,
  claimLeaseMs: 30_000,
  statusCheckIntervalMs: 30_000,
  batchLimit: 100,
});

/** Resolve the effective policy for one provider. */
export function policyFor(config: RecoveryConfig, providerId: ProviderId | string | null): RecoveryPolicy {
  const override = providerId === null ? undefined : config.perProvider?.[providerId];
  if (!override) return config;
  return {
    recoveryAgeMs: override.recoveryAgeMs ?? config.recoveryAgeMs,
    pendingMaximumMs: override.pendingMaximumMs ?? config.pendingMaximumMs,
    maxStatusAttempts: override.maxStatusAttempts ?? config.maxStatusAttempts,
    claimLeaseMs: override.claimLeaseMs ?? config.claimLeaseMs,
    statusCheckIntervalMs: override.statusCheckIntervalMs ?? config.statusCheckIntervalMs,
    batchLimit: override.batchLimit ?? config.batchLimit,
  };
}

/**
 * The smallest recovery age across the base policy and every override.
 *
 * The candidate query uses this so a provider with a shorter threshold is not
 * filtered out before its own policy is consulted.
 */
export function minimumRecoveryAgeMs(config: RecoveryConfig): number {
  const overrides = Object.values(config.perProvider ?? {});
  return overrides.reduce<number>(
    (min, o) => Math.min(min, o.recoveryAgeMs ?? config.recoveryAgeMs),
    config.recoveryAgeMs,
  );
}
