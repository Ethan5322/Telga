/**
 * Resolve a PENDING transaction by asking the provider what happened.
 *
 * This is the other half of the timeout story. `createSale` leaves value held
 * and schedules a resolution; this runs later — from a worker, a callback, or a
 * support action — and drives the transaction to a determinate end.
 *
 * Three properties matter more than anything else here, and each is tested:
 *
 *  1. **Repeat safety.** A duplicate callback, a re-run worker and a support
 *     click all land on the same guards: the pending row moves out of
 *     `AWAITING` once, and the reservation moves out of `HELD` once. A second
 *     attempt finds nothing to move and changes nothing.
 *  2. **No guessing.** `STILL_PENDING` and `UNKNOWN_REFERENCE` both mean the
 *     same thing — we do not know — and neither finalizes nor releases.
 *  3. **Escalation is time-based, not mood-based.** Past the deadline the value
 *     moves to under review and a support case is opened automatically.
 */

import { postingId, auditEventId, createAuditEvent, transitionTo } from '@telga/domain';
import type { MerchantId, TransactionId, TransactionState } from '@telga/domain';
import { finalizeSuccess, moveToUnderReview, release } from '@telga/persistence';
import type { SaleDeps } from './context';
import { isAfter } from './context';
import { persistRehydrated, rehydrate } from './rehydrate';
import type { SaleResult } from './results';
import { MESSAGE_KEYS } from './results';

function terminalResult(
  state: TransactionState,
  txId: string,
  correlationId: string,
  idempotencyKey: string,
  providerReference: string | undefined,
  supportReference?: string,
): SaleResult {
  switch (state) {
    case 'SUCCESSFUL':
      return {
        kind: 'SUCCESSFUL',
        transactionId: txId,
        state: 'SUCCESSFUL',
        correlationId,
        idempotencyKey,
        providerReference,
        simulated: true,
        messageKey: MESSAGE_KEYS.SUCCESSFUL,
        nextAction: 'DISPLAY_RESULT_AND_OFFER_RECEIPT',
        providerErrorCategory: 'NONE',
      };
    case 'FAILED':
      return {
        kind: 'FAILED',
        transactionId: txId,
        state: 'FAILED',
        correlationId,
        idempotencyKey,
        providerReference,
        simulated: true,
        messageKey: MESSAGE_KEYS.FAILED,
        nextAction: 'EXPLAIN_NO_SALE_FUNDS_RELEASED',
        providerErrorCategory: 'PROVIDER_CONFIRMED_FAILURE',
      };
    case 'UNDER_REVIEW':
      return {
        kind: 'UNDER_REVIEW',
        transactionId: txId,
        state: 'UNDER_REVIEW',
        correlationId,
        idempotencyKey,
        providerReference,
        simulated: true,
        messageKey: MESSAGE_KEYS.UNDER_REVIEW,
        nextAction: 'CONTACT_SUPPORT_WITH_REFERENCE',
        providerErrorCategory: 'PROVIDER_INDETERMINATE',
        supportReference: supportReference ?? '',
      };
    default:
      return {
        kind: 'PENDING',
        transactionId: txId,
        state: 'PENDING',
        correlationId,
        idempotencyKey,
        providerReference,
        simulated: true,
        messageKey: MESSAGE_KEYS.PENDING,
        nextAction: 'DO_NOT_RETRY_YET',
        providerErrorCategory: 'PROVIDER_INDETERMINATE',
        deadlineAt: '',
      };
  }
}

export async function resolvePending(
  deps: SaleDeps,
  txId: TransactionId,
  merchant: MerchantId,
): Promise<SaleResult> {
  const row = deps.driver.findTransaction(txId, merchant);
  if (!row) {
    return {
      kind: 'UNAUTHORIZED',
      correlationId: deps.newId('corr'),
      simulated: true,
      messageKey: MESSAGE_KEYS.UNAUTHORIZED,
      nextAction: 'SHOW_PERMISSION_ERROR',
      reasonCode: 'TRANSACTION_NOT_FOUND_FOR_MERCHANT',
    };
  }

  const job = deps.driver.findPendingResolution(txId);
  const correlationId = job?.correlation_id ?? deps.newId('corr');

  // Already resolved by an earlier callback or worker pass. Report, change nothing.
  if (row.state !== 'PENDING') {
    const support = deps.driver.findSupportCaseByTransaction(txId, merchant);
    return terminalResult(
      row.state,
      txId,
      correlationId,
      row.idempotency_key,
      row.provider_reference ?? undefined,
      support?.reference,
    );
  }

  deps.driver.recordResolutionAttempt(txId, deps.now());

  const status = await deps.provider.getStatus({
    transactionId: txId,
    providerReference: row.provider_reference ?? undefined,
    idempotencyKey: row.idempotency_key,
  });

  return deps.driver.transaction((): SaleResult => {
    const at = deps.now();
    const current = deps.driver.findTransaction(txId, merchant);
    if (!current || current.state !== 'PENDING') {
      // Another writer resolved it between the lookup and here.
      return terminalResult(
        current?.state ?? row.state,
        txId,
        correlationId,
        row.idempotency_key,
        row.provider_reference ?? undefined,
      );
    }

    const transaction = rehydrate(current);
    const actor = {
      userId: transaction.operatorId,
      role: 'MERCHANT_OPERATOR' as const,
      deviceId: transaction.deviceId,
    };

    const writeAudit = (after: TransactionState): void => {
      deps.driver.saveAuditEvent({
        event: createAuditEvent({
          id: auditEventId(deps.newId('audit')),
          at,
          action: 'TRANSACTION_TRANSITIONED',
          actor,
          merchantId: merchant,
          transactionId: txId,
          before: 'PENDING',
          after,
        }),
        correlationId,
        entityType: 'transaction',
        entityId: txId,
      });
    };

    if (status.outcome === 'SUCCESS') {
      // The pending job closes exactly once; a duplicate callback stops here.
      if (!deps.driver.closePendingResolution(txId, 'RESOLVED', at)) {
        return terminalResult(current.state, txId, correlationId, current.idempotency_key, current.provider_reference ?? undefined);
      }
      const next = transitionTo(transaction, 'SUCCESSFUL', {
        at,
        reason: 'status lookup confirmed delivery',
        providerReference: status.providerReference,
      });
      persistRehydrated(deps.driver, next, current);
      finalizeSuccess(deps.driver, {
        merchantId: merchant,
        transactionId: txId,
        amount: transaction.amount,
        at,
        correlationId,
        actor,
        postingId: postingId(deps.newId('post')),
        auditId: deps.newId('audit'),
      });
      writeAudit('SUCCESSFUL');
      deps.driver.recordIdempotencyResult(merchant, current.idempotency_key, 'SUCCESSFUL', at);
      return terminalResult('SUCCESSFUL', txId, correlationId, current.idempotency_key, status.providerReference);
    }

    if (status.outcome === 'FAILURE') {
      if (!deps.driver.closePendingResolution(txId, 'RESOLVED', at)) {
        return terminalResult(current.state, txId, correlationId, current.idempotency_key, current.provider_reference ?? undefined);
      }
      const next = transitionTo(transaction, 'FAILED', {
        at,
        reason: 'status lookup confirmed failure',
        providerReference: status.providerReference,
      });
      persistRehydrated(deps.driver, next, current);
      release(deps.driver, {
        merchantId: merchant,
        transactionId: txId,
        amount: transaction.amount,
        at,
        correlationId,
        actor,
        postingId: postingId(deps.newId('post')),
        auditId: deps.newId('audit'),
      });
      writeAudit('FAILED');
      deps.driver.recordIdempotencyResult(merchant, current.idempotency_key, 'FAILED', at);
      return terminalResult('FAILED', txId, correlationId, current.idempotency_key, status.providerReference);
    }

    // STILL_PENDING or UNKNOWN_REFERENCE — we do not know.
    const deadline = job?.deadline_at ?? at;
    if (!isAfter(at, deadline)) {
      return {
        kind: 'PENDING',
        transactionId: txId,
        state: 'PENDING',
        correlationId,
        idempotencyKey: current.idempotency_key,
        providerReference: current.provider_reference ?? undefined,
        simulated: true,
        messageKey: MESSAGE_KEYS.PENDING,
        nextAction: 'DO_NOT_RETRY_YET',
        providerErrorCategory: 'PROVIDER_INDETERMINATE',
        deadlineAt: deadline,
      };
    }

    // Past the deadline: escalate. No refund, no release, no guess.
    if (!deps.driver.closePendingResolution(txId, 'ESCALATED', at)) {
      return terminalResult(current.state, txId, correlationId, current.idempotency_key, current.provider_reference ?? undefined);
    }
    const escalated = transitionTo(transaction, 'UNDER_REVIEW', {
      at,
      reason: 'pending exceeded provider maximum',
    });
    persistRehydrated(deps.driver, escalated, current);
    moveToUnderReview(deps.driver, {
      merchantId: merchant,
      transactionId: txId,
      amount: transaction.amount,
      at,
      correlationId,
      actor,
      postingId: postingId(deps.newId('post')),
      auditId: deps.newId('audit'),
    });
    const reference = `TG-${txId.toUpperCase()}`;
    deps.driver.createSupportCase({
      id: deps.newId('case'),
      merchantId: merchant,
      transactionId: txId,
      reason: 'UNDER_REVIEW',
      reference,
      correlationId,
      at,
    });
    writeAudit('UNDER_REVIEW');

    return terminalResult('UNDER_REVIEW', txId, correlationId, current.idempotency_key, current.provider_reference ?? undefined, reference);
  });
}
