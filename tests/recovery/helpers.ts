/**
 * Recovery test fixtures.
 *
 * Builds on the orchestration harness and adds: a recovery config, a second
 * worker for concurrency tests, and a stub provider whose `getStatus` can be
 * made to throw a specific class of failure.
 */

import type { AirtimeProvider, ProviderHealth, ProviderStatus, ProviderId } from '@telga/domain';
import type { RecoveryConfig, RecoveryDeps } from '@telga/api';
import type { SqliteLedgerDriver } from '@telga/persistence';
import type { MerchantId, TransactionId } from '@telga/domain';
import { makeHarness, PROVIDER } from '../orchestration/helpers';
import type { Harness, HarnessOptions } from '../orchestration/helpers';

export {
  MERCHANT_A,
  MERCHANT_B,
  DEVICE_A,
  DEVICE_B,
  OPERATOR_A,
  PROVIDER,
  PRODUCT,
  saleRequest,
  failAt,
} from '../orchestration/helpers';
export type { Harness } from '../orchestration/helpers';

export const TEST_RECOVERY_CONFIG: RecoveryConfig = Object.freeze({
  recoveryAgeMs: 60_000,
  pendingMaximumMs: 300_000,
  maxStatusAttempts: 3,
  claimLeaseMs: 30_000,
  statusCheckIntervalMs: 30_000,
  batchLimit: 50,
});

export interface RecoveryHarness extends Harness {
  readonly recoveryDeps: RecoveryDeps;
}

export function makeRecoveryHarness(
  name: string,
  options: HarnessOptions & {
    recovery?: Partial<RecoveryConfig>;
    workerId?: string;
  } = {},
): RecoveryHarness {
  const base = makeHarness(name, options);
  const recoveryDeps: RecoveryDeps = {
    ...base.deps,
    workerId: options.workerId ?? 'worker_1',
    recovery: { ...TEST_RECOVERY_CONFIG, ...options.recovery },
  };
  return { ...base, recoveryDeps };
}

/** A second worker sharing the same database and clock. */
export function secondWorker(harness: RecoveryHarness, workerId = 'worker_2'): RecoveryDeps {
  return { ...harness.recoveryDeps, workerId };
}

/** Swap the provider on a recovery deps object. */
export const withProvider = (deps: RecoveryDeps, provider: AirtimeProvider): RecoveryDeps => ({
  ...deps,
  provider,
});

/**
 * A provider whose status lookup fails in a specific, classifiable way.
 *
 * The classifier reads only the error's `name` and `code`, never its message,
 * so these stubs carry the signal in those fields.
 */
export function throwingProvider(error: Error, providerId: ProviderId = PROVIDER): AirtimeProvider {
  return {
    submit: () => Promise.reject(error),
    getStatus: (): Promise<ProviderStatus> => Promise.reject(error),
    healthCheck: (): Promise<ProviderHealth> =>
      Promise.resolve({ healthy: true, providerId, simulated: true }),
  };
}

/** A provider returning a fixed status outcome. */
export function fixedStatusProvider(
  outcome: ProviderStatus['outcome'],
  providerId: ProviderId = PROVIDER,
): AirtimeProvider {
  return {
    submit: () =>
      Promise.resolve({ outcome: 'INDETERMINATE' as const, simulated: true as const }),
    getStatus: (): Promise<ProviderStatus> =>
      Promise.resolve({ outcome, providerReference: 'MOCKREF-STUB', simulated: true }),
    healthCheck: (): Promise<ProviderHealth> =>
      Promise.resolve({ healthy: true, providerId, simulated: true }),
  };
}

export function namedError(name: string, code?: string): Error {
  const error = new Error('stub failure');
  error.name = name;
  if (code !== undefined) Object.assign(error, { code });
  return error;
}

/**
 * A safe diagnostic snapshot for a transaction.
 *
 * Carries identifiers, states and clock values — never a recipient number, a
 * credential, or a provider body. Used when an assertion fails so the failure
 * report says what the system actually looked like.
 */
export function diagnose(driver: SqliteLedgerDriver, txId: TransactionId, merchant: MerchantId) {
  const tx = driver.findTransaction(txId, merchant);
  const job = driver.findPendingResolution(txId);
  const claim = driver.findClaim(txId);
  const reservation = driver.findReservation(txId, merchant);
  const supportCase = driver.findSupportCaseByTransaction(txId, merchant);
  const view = driver.balanceFor(merchant);

  return {
    transactionId: txId,
    merchantId: merchant,
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
    available: view.available.minor,
    reserved: view.reserved.minor,
    underReview: view.underReview.minor,
    residual: driver.ledgerResidualMinor(),
    pid: process.pid,
  };
}
