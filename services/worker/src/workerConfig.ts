/**
 * Worker configuration.
 *
 * Three named policies, and a hard rule between them: **production never falls
 * back to development values.** `productionPolicyFrom` reads explicit
 * configuration and throws for anything missing, so a deployment that forgot a
 * setting fails at startup rather than quietly running a developer's numbers
 * against a merchant's money.
 */

export interface RecoveryWorkerPolicy {
  /** The worker does nothing unless this is explicitly true. */
  readonly recoveryWorkerEnabled: boolean;
  readonly recoveryIntervalMs: number;
  readonly recoveryJitterMs: number;
  readonly recoveryBatchLimit: number;
  readonly recoveryAgeMs: number;
  readonly pendingMaximumMs: number;
  readonly maxStatusAttempts: number;
  readonly claimLeaseMs: number;
  readonly statusCheckIntervalMs: number;
  readonly failureBackoffInitialMs: number;
  readonly failureBackoffMaximumMs: number;
  readonly failureBackoffMultiplier: number;
  readonly gracefulShutdownTimeoutMs: number;
  /** Whether to sweep immediately on start, or wait one interval first. */
  readonly runInitialSweepOnStart: boolean;
  /**
   * Set only with a documented reason. A pending maximum shorter than the
   * recovery age escalates transactions the sweep has not even looked at yet.
   */
  readonly allowPendingMaximumBelowRecoveryAge?: boolean;
}

/** A sweep that takes longer than its own lease would let a second worker in. */
export const MINIMUM_CLAIM_LEASE_MS = 1_000;

/** Below this, a worker is hammering the database rather than sweeping it. */
export const MINIMUM_RECOVERY_INTERVAL_MS = 1_000;

export type WorkerConfigErrorCode =
  | 'MISSING_SETTING'
  | 'NOT_A_NUMBER'
  | 'NOT_POSITIVE'
  | 'NEGATIVE'
  | 'BATCH_LIMIT_TOO_SMALL'
  | 'BACKOFF_MAXIMUM_BELOW_INITIAL'
  | 'BACKOFF_MULTIPLIER_TOO_SMALL'
  | 'CLAIM_LEASE_TOO_SHORT'
  | 'INTERVAL_TOO_SHORT'
  | 'PENDING_MAXIMUM_BELOW_RECOVERY_AGE'
  | 'PRODUCTION_FALLBACK_REFUSED';

export class WorkerConfigurationError extends Error {
  readonly code: WorkerConfigErrorCode;
  readonly setting: string;

  constructor(code: WorkerConfigErrorCode, setting: string, message: string) {
    super(message);
    this.name = 'WorkerConfigurationError';
    this.code = code;
    this.setting = setting;
  }
}

/** Development defaults. Fast intervals so a developer sees the loop work. */
export const DEVELOPMENT_RECOVERY_WORKER_POLICY: RecoveryWorkerPolicy = Object.freeze({
  recoveryWorkerEnabled: true,
  recoveryIntervalMs: 30_000,
  recoveryJitterMs: 5_000,
  recoveryBatchLimit: 50,
  recoveryAgeMs: 60_000,
  pendingMaximumMs: 300_000,
  maxStatusAttempts: 5,
  claimLeaseMs: 30_000,
  statusCheckIntervalMs: 30_000,
  failureBackoffInitialMs: 1_000,
  failureBackoffMaximumMs: 60_000,
  failureBackoffMultiplier: 2,
  gracefulShutdownTimeoutMs: 10_000,
  runInitialSweepOnStart: true,
});

/** Test defaults. Everything short and deterministic. */
export const TEST_RECOVERY_WORKER_POLICY: RecoveryWorkerPolicy = Object.freeze({
  recoveryWorkerEnabled: true,
  recoveryIntervalMs: 1_000,
  recoveryJitterMs: 0,
  recoveryBatchLimit: 10,
  recoveryAgeMs: 60_000,
  pendingMaximumMs: 300_000,
  maxStatusAttempts: 3,
  claimLeaseMs: 30_000,
  statusCheckIntervalMs: 30_000,
  failureBackoffInitialMs: 1_000,
  failureBackoffMaximumMs: 8_000,
  failureBackoffMultiplier: 2,
  gracefulShutdownTimeoutMs: 5_000,
  runInitialSweepOnStart: true,
});

export const NOT_YET_CONFIRMED = 'NOT_YET_CONFIRMED' as const;

/**
 * The production policy.
 *
 * Deliberately **not** a set of numbers. Every value depends on provider timeout
 * semantics ([[Contract Checklist]] terms 7 and 9) and on real connectivity data
 * from the pilot baseline, neither of which exists. Shipping a plausible number
 * here would be inventing an operating parameter for a system that handles
 * merchant money.
 */
export const PRODUCTION_RECOVERY_WORKER_POLICY: Readonly<
  Record<keyof Omit<RecoveryWorkerPolicy, 'allowPendingMaximumBelowRecoveryAge'>, typeof NOT_YET_CONFIRMED>
> = Object.freeze({
  recoveryWorkerEnabled: NOT_YET_CONFIRMED,
  recoveryIntervalMs: NOT_YET_CONFIRMED,
  recoveryJitterMs: NOT_YET_CONFIRMED,
  recoveryBatchLimit: NOT_YET_CONFIRMED,
  recoveryAgeMs: NOT_YET_CONFIRMED,
  pendingMaximumMs: NOT_YET_CONFIRMED,
  maxStatusAttempts: NOT_YET_CONFIRMED,
  claimLeaseMs: NOT_YET_CONFIRMED,
  statusCheckIntervalMs: NOT_YET_CONFIRMED,
  failureBackoffInitialMs: NOT_YET_CONFIRMED,
  failureBackoffMaximumMs: NOT_YET_CONFIRMED,
  failureBackoffMultiplier: NOT_YET_CONFIRMED,
  gracefulShutdownTimeoutMs: NOT_YET_CONFIRMED,
  runInitialSweepOnStart: NOT_YET_CONFIRMED,
});

export type ConfigSource = Readonly<Record<string, string | undefined>>;

const NUMERIC_SETTINGS = [
  'recoveryIntervalMs',
  'recoveryJitterMs',
  'recoveryBatchLimit',
  'recoveryAgeMs',
  'pendingMaximumMs',
  'maxStatusAttempts',
  'claimLeaseMs',
  'statusCheckIntervalMs',
  'failureBackoffInitialMs',
  'failureBackoffMaximumMs',
  'failureBackoffMultiplier',
  'gracefulShutdownTimeoutMs',
] as const;

const envKey = (setting: string): string =>
  `TELGA_${setting.replace(/([A-Z])/g, '_$1').toUpperCase()}`;

function requireNumber(source: ConfigSource, setting: string): number {
  const key = envKey(setting);
  const raw = source[key];
  if (raw === undefined || raw.trim() === '') {
    throw new WorkerConfigurationError(
      'MISSING_SETTING',
      setting,
      `${key} is not set. Production configuration must be explicit; there is no fallback.`,
    );
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new WorkerConfigurationError('NOT_A_NUMBER', setting, `${key} is not a number: ${raw}`);
  }
  return value;
}

function requireBoolean(source: ConfigSource, setting: string): boolean {
  const key = envKey(setting);
  const raw = source[key];
  if (raw === undefined || raw.trim() === '') {
    throw new WorkerConfigurationError(
      'MISSING_SETTING',
      setting,
      `${key} is not set. Production configuration must be explicit; there is no fallback.`,
    );
  }
  return raw.trim().toLowerCase() === 'true';
}

/**
 * Build a production policy from explicit configuration.
 *
 * Throws for any missing setting. There is no merge with a default policy, by
 * design — see `PRODUCTION_FALLBACK_REFUSED`.
 */
export function productionPolicyFrom(source: ConfigSource): RecoveryWorkerPolicy {
  const numbers = Object.fromEntries(
    NUMERIC_SETTINGS.map((setting) => [setting, requireNumber(source, setting)]),
  ) as Record<(typeof NUMERIC_SETTINGS)[number], number>;

  const policy: RecoveryWorkerPolicy = {
    ...numbers,
    recoveryWorkerEnabled: requireBoolean(source, 'recoveryWorkerEnabled'),
    runInitialSweepOnStart: requireBoolean(source, 'runInitialSweepOnStart'),
    allowPendingMaximumBelowRecoveryAge:
      source[envKey('allowPendingMaximumBelowRecoveryAge')]?.trim().toLowerCase() === 'true',
  };

  return validateWorkerPolicy(policy);
}

/**
 * Load the policy for an environment.
 *
 * Production reads explicit configuration and refuses to fall back. Development
 * and test use their named policies.
 */
export function loadWorkerPolicy(
  environment: 'development' | 'test' | 'production',
  source: ConfigSource = {},
): RecoveryWorkerPolicy {
  switch (environment) {
    case 'development':
      return validateWorkerPolicy(DEVELOPMENT_RECOVERY_WORKER_POLICY);
    case 'test':
      return validateWorkerPolicy(TEST_RECOVERY_WORKER_POLICY);
    case 'production':
      return productionPolicyFrom(source);
    default: {
      const exhaustive: never = environment;
      return exhaustive;
    }
  }
}

/** Refuse a development or test policy in production, explicitly. */
export function assertNotDevelopmentPolicyInProduction(
  environment: string,
  policy: RecoveryWorkerPolicy,
): void {
  if (environment !== 'production') return;
  if (policy === DEVELOPMENT_RECOVERY_WORKER_POLICY || policy === TEST_RECOVERY_WORKER_POLICY) {
    throw new WorkerConfigurationError(
      'PRODUCTION_FALLBACK_REFUSED',
      'policy',
      'Refusing to run a development or test policy in production. Provide explicit configuration.',
    );
  }
}

/** Validate a policy, throwing a typed error on the first problem found. */
export function validateWorkerPolicy(policy: RecoveryWorkerPolicy): RecoveryWorkerPolicy {
  const positive: (keyof RecoveryWorkerPolicy)[] = [
    'recoveryIntervalMs',
    'recoveryAgeMs',
    'pendingMaximumMs',
    'maxStatusAttempts',
    'claimLeaseMs',
    'statusCheckIntervalMs',
    'failureBackoffInitialMs',
    'failureBackoffMaximumMs',
    'gracefulShutdownTimeoutMs',
  ];

  for (const setting of positive) {
    const value = policy[setting] as number;
    if (!(value > 0)) {
      throw new WorkerConfigurationError('NOT_POSITIVE', String(setting), `${String(setting)} must be greater than zero`);
    }
  }

  if (policy.recoveryJitterMs < 0) {
    throw new WorkerConfigurationError('NEGATIVE', 'recoveryJitterMs', 'recoveryJitterMs must not be negative');
  }

  if (policy.recoveryBatchLimit < 1) {
    throw new WorkerConfigurationError(
      'BATCH_LIMIT_TOO_SMALL',
      'recoveryBatchLimit',
      'recoveryBatchLimit must be at least 1',
    );
  }

  if (policy.failureBackoffMaximumMs < policy.failureBackoffInitialMs) {
    throw new WorkerConfigurationError(
      'BACKOFF_MAXIMUM_BELOW_INITIAL',
      'failureBackoffMaximumMs',
      'failureBackoffMaximumMs must be greater than or equal to failureBackoffInitialMs',
    );
  }

  if (policy.failureBackoffMultiplier < 1) {
    throw new WorkerConfigurationError(
      'BACKOFF_MULTIPLIER_TOO_SMALL',
      'failureBackoffMultiplier',
      'failureBackoffMultiplier must be at least 1, otherwise backoff shrinks under failure',
    );
  }

  if (policy.recoveryIntervalMs < MINIMUM_RECOVERY_INTERVAL_MS) {
    throw new WorkerConfigurationError(
      'INTERVAL_TOO_SHORT',
      'recoveryIntervalMs',
      `recoveryIntervalMs must be at least ${String(MINIMUM_RECOVERY_INTERVAL_MS)}ms`,
    );
  }

  // A lease shorter than the gap between status checks cannot outlive a single
  // recovery operation, which would let a second worker in mid-flight.
  if (policy.claimLeaseMs < MINIMUM_CLAIM_LEASE_MS || policy.claimLeaseMs <= policy.statusCheckIntervalMs / 2) {
    throw new WorkerConfigurationError(
      'CLAIM_LEASE_TOO_SHORT',
      'claimLeaseMs',
      'claimLeaseMs must comfortably exceed the time one recovery operation takes',
    );
  }

  if (
    policy.pendingMaximumMs < policy.recoveryAgeMs &&
    policy.allowPendingMaximumBelowRecoveryAge !== true
  ) {
    throw new WorkerConfigurationError(
      'PENDING_MAXIMUM_BELOW_RECOVERY_AGE',
      'pendingMaximumMs',
      'pendingMaximumMs below recoveryAgeMs escalates transactions the sweep has not examined yet. Set allowPendingMaximumBelowRecoveryAge to override deliberately.',
    );
  }

  return policy;
}
