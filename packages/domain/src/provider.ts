/**
 * Provider adapter contract.
 *
 * The interface is taken verbatim from `CLAUDE.md` §23. The only implementation
 * that exists in this repository is the deterministic mock in
 * `services/provider-adapters/mock-airtime` — there is no HTTP client anywhere
 * in the tree, so live integration is *absent*, not merely disabled.
 *
 * The critical design point is `ProviderSubmissionOutcome`: it can express
 * "I do not know". A boolean success flag would force a timeout to be read as
 * a failure, which is the one thing the platform must never do.
 */

import type { DeviceId, MerchantId, ProductId, ProviderId, TransactionId } from './ids';
import type { OperatingMode } from './mode';
import type { Money } from './money';

export interface AirtimeRequest {
  readonly transactionId: TransactionId;
  readonly merchantId: MerchantId;
  readonly productId: ProductId;
  readonly amount: Money;
  readonly recipient: string;
  /** Reused across every retry of the same logical sale. */
  readonly idempotencyKey: string;
}

export interface ProviderContext {
  readonly providerId: ProviderId;
  readonly deviceId: DeviceId;
  /** Always TRAINING in this build; adapters must refuse anything else. */
  readonly mode: OperatingMode;
  /** Milliseconds the caller is willing to wait before treating silence as pending. */
  readonly timeoutMs: number;
}

/**
 * What a submission tells us.
 *
 * INDETERMINATE covers timeout, malformed response and unreachable provider —
 * all three mean the same thing operationally: we do not know, hold the
 * reservation, resolve by status lookup.
 */
export type ProviderSubmissionOutcome =
  | 'CONFIRMED_SUCCESS'
  | 'CONFIRMED_FAILURE'
  | 'INDETERMINATE'
  | 'DUPLICATE'
  | 'REJECTED';

export interface ProviderSubmissionResult {
  readonly outcome: ProviderSubmissionOutcome;
  readonly providerReference?: string;
  readonly message?: string;
  /** Always true in this build — every mock result is simulated. */
  readonly simulated: boolean;
}

export interface ProviderStatusQuery {
  readonly transactionId: TransactionId;
  readonly providerReference?: string;
  readonly idempotencyKey: string;
}

export type ProviderStatusOutcome = 'SUCCESS' | 'FAILURE' | 'STILL_PENDING' | 'UNKNOWN_REFERENCE';

export interface ProviderStatus {
  readonly outcome: ProviderStatusOutcome;
  readonly providerReference?: string;
  readonly message?: string;
  readonly simulated: boolean;
}

export interface ProviderReversalRequest {
  readonly transactionId: TransactionId;
  readonly providerReference: string;
  readonly reason: string;
}

export interface ProviderReversalResult {
  readonly accepted: boolean;
  readonly providerReference?: string;
  readonly message?: string;
  readonly simulated: boolean;
}

export interface ProviderHealth {
  readonly healthy: boolean;
  readonly providerId: ProviderId;
  readonly message?: string;
  readonly simulated: boolean;
}

/**
 * Every provider implementation satisfies this.
 *
 * `reverse` is optional because provider reversal capability is NOT YET
 * CONFIRMED. `getStatus` is not optional: a provider that cannot answer
 * "what happened to reference X?" cannot be integrated at all, because a
 * pending transaction would never resolve.
 */
export interface AirtimeProvider {
  submit(request: AirtimeRequest, context: ProviderContext): Promise<ProviderSubmissionResult>;
  getStatus(query: ProviderStatusQuery): Promise<ProviderStatus>;
  reverse?(request: ProviderReversalRequest): Promise<ProviderReversalResult>;
  healthCheck(): Promise<ProviderHealth>;
}

/** Map a submission outcome onto the state the transaction must move to. */
export function stateForSubmission(outcome: ProviderSubmissionOutcome): 'SUCCESSFUL' | 'FAILED' | 'PENDING' {
  switch (outcome) {
    case 'CONFIRMED_SUCCESS':
      return 'SUCCESSFUL';
    case 'CONFIRMED_FAILURE':
    case 'REJECTED':
      return 'FAILED';
    case 'INDETERMINATE':
    case 'DUPLICATE':
      // A duplicate is resolved by status lookup, never by assuming an outcome.
      return 'PENDING';
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}
