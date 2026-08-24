/**
 * Reversal workflow.
 *
 * `PENDING → REVERSAL_REQUIRED` and `UNDER_REVIEW → REVERSAL_REQUIRED` mark a
 * transaction where value was taken and delivery did not happen.
 * `REVERSAL_REQUIRED → REVERSED` posts the authorized adjustment that returns
 * the value.
 *
 * The provider call is `reverse()` on the **mock** adapter, and its result is
 * marked `simulated`. No real reversal is requested of anyone, because there is
 * no provider agreement and therefore no contractual reversal path. Its
 * commercial terms are recorded outside this repository.
 *
 * Nothing here refunds an unknown outcome. A reversal is only ever posted after
 * a determination has been recorded.
 */

import { auditEventId, createAuditEvent, postingId, transitionTo } from '@telga/domain';
import type { ActorRole, MerchantId, TransactionId } from '@telga/domain';
import { release, releaseFromUnderReview } from '@telga/persistence';
import type { SaleDeps } from './context';
import { persistRehydrated, rehydrate } from './rehydrate';
import type { SaleResult } from './results';
import { MESSAGE_KEYS } from './results';

/** Who authorized a refund, reversal or exceptional balance action. */
export interface ReversalApproval {
  readonly approvedBy: string;
  readonly role: ActorRole;
}

/** Only these roles may authorize a reversal. See `09 Engineering/Security Model.md`. */
export const SUPERVISOR_ROLES: readonly ActorRole[] = ['OPS_APPROVER', 'ADMIN'];

function notFound(deps: SaleDeps, reason: string): SaleResult {
  return {
    kind: 'UNAUTHORIZED',
    correlationId: deps.newId('corr'),
    simulated: true,
    messageKey: MESSAGE_KEYS.UNAUTHORIZED,
    nextAction: 'SHOW_PERMISSION_ERROR',
    reasonCode: reason,
  };
}

/**
 * Record that a reversal is required.
 *
 * Legal from `PENDING` (a callback said value was taken and not delivered) and
 * from `UNDER_REVIEW` (operations determined the same thing).
 */
export function requireReversal(
  deps: SaleDeps,
  txId: TransactionId,
  merchant: MerchantId,
  reason: string,
): SaleResult {
  const row = deps.driver.findTransaction(txId, merchant);
  if (!row) return notFound(deps, 'TRANSACTION_NOT_FOUND_FOR_MERCHANT');

  if (row.state === 'REVERSAL_REQUIRED') {
    const existing = deps.driver.findSupportCaseByTransaction(txId, merchant);
    return reversalRequiredResult(txId, row.idempotency_key, row.provider_reference, existing?.reference ?? '');
  }

  if (row.state !== 'PENDING' && row.state !== 'UNDER_REVIEW') {
    return {
      kind: 'INVALID_REQUEST',
      correlationId: deps.newId('corr'),
      transactionId: txId,
      simulated: true,
      messageKey: MESSAGE_KEYS.INVALID_REQUEST,
      nextAction: 'SHOW_VALIDATION_ERROR',
      reasonCode: `REVERSAL_NOT_LEGAL_FROM_${row.state}`,
    };
  }

  return deps.driver.transaction((): SaleResult => {
    const at = deps.now();
    const transaction = rehydrate(row);
    const correlationId = deps.driver.findPendingResolution(txId)?.correlation_id ?? deps.newId('corr');

    // If it is still PENDING the resolution job must close, so no worker pass
    // can drive it somewhere else afterwards.
    if (row.state === 'PENDING') {
      deps.driver.closePendingResolution(txId, 'ESCALATED', at);
    }

    const next = transitionTo(transaction, 'REVERSAL_REQUIRED', { at, reason });
    persistRehydrated(deps.driver, next, row);

    const existing = deps.driver.findSupportCaseByTransaction(txId, merchant);
    const reference = existing?.reference ?? `TG-${txId.toUpperCase()}`;
    if (!existing) {
      deps.driver.createSupportCase({
        id: deps.newId('case'),
        merchantId: merchant,
        transactionId: txId,
        reason: 'REVERSAL_REQUIRED',
        reference,
        correlationId,
        at,
      });
    }

    deps.driver.saveAuditEvent({
      event: createAuditEvent({
        id: auditEventId(deps.newId('audit')),
        at,
        action: 'TRANSACTION_TRANSITIONED',
        actor: { userId: 'system', role: 'OPS_SUPPORT' },
        merchantId: merchant,
        transactionId: txId,
        before: row.state,
        after: 'REVERSAL_REQUIRED',
        detail: reason,
      }),
      correlationId,
      entityType: 'transaction',
      entityId: txId,
    });

    return reversalRequiredResult(txId, row.idempotency_key, row.provider_reference, reference);
  });
}

/**
 * Complete a reversal: post the adjustment and return the value.
 *
 * Calls the mock adapter's `reverse()` when it exists, purely so the workflow is
 * exercised end to end. The ledger movement does not depend on the provider's
 * answer — the determination was already made.
 */
export async function completeReversal(
  deps: SaleDeps,
  txId: TransactionId,
  merchant: MerchantId,
  approval: ReversalApproval,
): Promise<SaleResult> {
  // A reversal moves a merchant's money on the strength of a human judgement.
  // It requires a supervisor, and the supervisor is recorded on the case.
  if (!SUPERVISOR_ROLES.includes(approval.role)) {
    return {
      kind: 'UNAUTHORIZED',
      correlationId: deps.newId('corr'),
      transactionId: txId,
      simulated: true,
      messageKey: MESSAGE_KEYS.UNAUTHORIZED,
      nextAction: 'SHOW_PERMISSION_ERROR',
      reasonCode: `REVERSAL_REQUIRES_SUPERVISOR_APPROVAL_NOT_${approval.role}`,
    };
  }

  const row = deps.driver.findTransaction(txId, merchant);
  if (!row) return notFound(deps, 'TRANSACTION_NOT_FOUND_FOR_MERCHANT');

  const support = deps.driver.findSupportCaseByTransaction(txId, merchant);
  const reference = support?.reference ?? `TG-${txId.toUpperCase()}`;

  if (row.state === 'REVERSED') {
    // Already reversed. A repeated callback changes nothing.
    return reversedResult(txId, row.idempotency_key, row.provider_reference, reference);
  }

  if (row.state !== 'REVERSAL_REQUIRED') {
    return {
      kind: 'INVALID_REQUEST',
      correlationId: deps.newId('corr'),
      transactionId: txId,
      simulated: true,
      messageKey: MESSAGE_KEYS.INVALID_REQUEST,
      nextAction: 'SHOW_VALIDATION_ERROR',
      reasonCode: `REVERSED_NOT_LEGAL_FROM_${row.state}`,
    };
  }

  // Exercise the simulated provider reversal where the adapter offers one.
  if (deps.provider.reverse && row.provider_reference) {
    await deps.provider.reverse({
      transactionId: txId,
      providerReference: row.provider_reference,
      reason: 'Simulated reversal for a transaction determined undelivered',
    });
  }

  return deps.driver.transaction((): SaleResult => {
    const at = deps.now();
    const current = deps.driver.findTransaction(txId, merchant);
    if (!current || current.state !== 'REVERSAL_REQUIRED') {
      return reversedResult(txId, row.idempotency_key, row.provider_reference, reference);
    }

    const transaction = rehydrate(current);
    const reservation = deps.driver.findReservation(txId, merchant);
    const actor = { userId: 'system' as const, role: approval.role };
    const correlationId = support?.correlation_id ?? deps.newId('corr');

    const context = {
      merchantId: merchant,
      transactionId: txId,
      amount: transaction.amount,
      at,
      correlationId,
      actor,
      postingId: postingId(deps.newId('post')),
      auditId: deps.newId('audit'),
    };

    // The value may be sitting in either bucket depending on how it got here.
    if (reservation?.status === 'UNDER_REVIEW') {
      releaseFromUnderReview(deps.driver, context);
    } else {
      release(deps.driver, context);
    }

    const next = transitionTo(transaction, 'REVERSED', { at, reason: 'authorized adjustment posted' });
    persistRehydrated(deps.driver, next, current);

    deps.driver.saveAuditEvent({
      event: createAuditEvent({
        id: auditEventId(deps.newId('audit')),
        at,
        action: 'ADJUSTMENT_POSTED',
        actor,
        merchantId: merchant,
        transactionId: txId,
        before: 'REVERSAL_REQUIRED',
        after: 'REVERSED',
      }),
      correlationId,
      entityType: 'transaction',
      entityId: txId,
    });

    if (support) {
      deps.driver.approveSupportCase(support.id, approval.approvedBy, at);
    }
    deps.driver.recordIdempotencyResult(merchant, current.idempotency_key, 'REVERSED', at);
    return reversedResult(txId, current.idempotency_key, current.provider_reference, reference);
  });
}

function reversalRequiredResult(
  txId: string,
  idempotencyKey: string,
  providerReference: string | null,
  supportReference: string,
): SaleResult {
  return {
    kind: 'REVERSAL_REQUIRED',
    transactionId: txId,
    state: 'REVERSAL_REQUIRED',
    correlationId: supportReference,
    idempotencyKey,
    providerReference: providerReference ?? undefined,
    simulated: true,
    messageKey: MESSAGE_KEYS.REVERSAL_REQUIRED,
    nextAction: 'CONTACT_SUPPORT_WITH_REFERENCE',
    providerErrorCategory: 'PROVIDER_INDETERMINATE',
    supportReference,
  };
}

function reversedResult(
  txId: string,
  idempotencyKey: string,
  providerReference: string | null,
  supportReference: string,
): SaleResult {
  return {
    kind: 'REVERSED',
    transactionId: txId,
    state: 'REVERSED',
    correlationId: supportReference,
    idempotencyKey,
    providerReference: providerReference ?? undefined,
    simulated: true,
    messageKey: MESSAGE_KEYS.REVERSED,
    nextAction: 'EXPLAIN_NO_SALE_FUNDS_RELEASED',
    providerErrorCategory: 'PROVIDER_INDETERMINATE',
    supportReference,
  };
}
