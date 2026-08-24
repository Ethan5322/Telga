/**
 * createSale — the airtime sale orchestration.
 *
 * Implements the seventeen-step journey in `02 Product/User Journeys.md`.
 *
 * ## Why there are two units of work, not one
 *
 * The provider call sits **between** two database transactions, and it has to.
 * A SQLite transaction is synchronous; holding one open across a network call
 * would block every other writer for as long as the provider takes to answer,
 * and the provider is exactly the component that might not answer at all.
 *
 *   Unit of work 1  validate · create · reserve · record idempotency  (atomic)
 *   ── provider.submit ──                                             (async)
 *   Unit of work 2  transition · ledger operation · audit · result    (atomic)
 *
 * The gap between them is precisely why `PENDING` exists: if the process dies
 * mid-flight, the merchant's value is still held by unit of work 1, and the
 * pending resolution row scheduled in unit of work 2 — or, failing that, the
 * transaction's own `RESERVED` state — is what a recovery sweep finds.
 *
 * Nothing here catches an error and reports success. An unknown outcome becomes
 * `PENDING`, which is an honest answer, not a hopeful one.
 */

import {
  assertPositive,
  deriveIdempotencyKey,
  createTransaction,
  DomainError,
  InsufficientAvailableBalanceError,
  isPositive,
  LiveMoneyDisabledError,
  payloadFingerprint,
  canonicalKeySource,
  stateForSubmission,
  transitionTo,
  auditEventId,
  createAuditEvent,
  postingId,
  timestamp,
  transactionId as makeTransactionId,
} from '@telga/domain';
import type { SaleIntent, Timestamp, Transaction, TransactionState } from '@telga/domain';
import {
  finalizeSuccess,
  hashRecipient,
  maskRecipient,
  release,
  reserve,
} from '@telga/persistence';
import type { SaleDeps, SaleRequest } from './context';
import { addMs, pendingMaximum, providerTimeout } from './context';
import type { ProviderErrorCategory, SaleResult } from './results';
import { MESSAGE_KEYS } from './results';

const TRAINING_ONLY_REASON = 'LIVE_MODE_REFUSED';

function reject(
  kind: Extract<SaleResult, { reasonCode: string }>['kind'],
  correlationId: string,
  reasonCode: string,
  nextAction: Extract<SaleResult, { reasonCode: string }>['nextAction'],
  extra: { idempotencyKey?: string; transactionId?: string } = {},
): SaleResult {
  return {
    kind,
    correlationId,
    reasonCode,
    simulated: true,
    messageKey: MESSAGE_KEYS[kind],
    nextAction,
    ...extra,
  };
}

/** Persist the transaction row at its current state. */
function persist(deps: SaleDeps, transaction: Transaction, recipient: string, fingerprint: string): void {
  deps.driver.saveTransaction({
    transaction,
    recipientMasked: maskRecipient(recipient),
    recipientHash: hashRecipient(recipient, deps.recipientSalt),
    payloadFingerprint: fingerprint,
    productType: 'AIRTIME',
  });
}

function audit(
  deps: SaleDeps,
  transaction: Transaction,
  action: Parameters<typeof createAuditEvent>[0]['action'],
  correlationId: string,
  before?: TransactionState,
): void {
  deps.driver.saveAuditEvent({
    event: createAuditEvent({
      id: auditEventId(deps.newId('audit')),
      at: deps.now(),
      action,
      actor: { userId: transaction.operatorId, role: 'MERCHANT_OPERATOR', deviceId: transaction.deviceId },
      merchantId: transaction.merchantId,
      transactionId: transaction.id,
      before,
      after: transaction.state,
    }),
    correlationId,
    entityType: 'transaction',
    entityId: transaction.id,
  });
}

export async function createSale(deps: SaleDeps, request: SaleRequest): Promise<SaleResult> {
  const correlationId = request.correlationId ?? deps.newId('corr');

  // --- 1. Simulated-only guard, before anything is touched -------------------
  if (deps.mode !== 'TRAINING') {
    return reject('SIMULATED_ONLY', correlationId, TRAINING_ONLY_REASON, 'SHOW_SYSTEM_ERROR');
  }

  // --- 2. Validate merchant, device, operator, product, amount, recipient ----
  const merchant = deps.driver.findMerchant(request.merchantId);
  if (!merchant || merchant.status !== 'ACTIVE') {
    return reject('UNAUTHORIZED', correlationId, 'MERCHANT_NOT_ACTIVE', 'SHOW_PERMISSION_ERROR');
  }

  const device = deps.driver.findDevice(request.deviceId, request.merchantId);
  if (!device) {
    return reject('UNAUTHORIZED', correlationId, 'DEVICE_NOT_OWNED_BY_MERCHANT', 'SHOW_PERMISSION_ERROR');
  }
  if (device.status !== 'ACTIVE') {
    return reject('UNAUTHORIZED', correlationId, 'DEVICE_NOT_ACTIVE', 'SHOW_PERMISSION_ERROR');
  }

  const product = deps.catalog.find(request.productId);
  if (!product || !product.available) {
    return reject('PRODUCT_UNAVAILABLE', correlationId, 'PRODUCT_NOT_AVAILABLE', 'SHOW_PROVIDER_UNAVAILABLE_NO_CHARGE');
  }

  if (!isPositive(request.amount) || request.amount.currency !== 'ETB') {
    return reject('INVALID_REQUEST', correlationId, 'AMOUNT_INVALID', 'SHOW_VALIDATION_ERROR');
  }
  if (request.recipient.trim().length < 6) {
    return reject('INVALID_REQUEST', correlationId, 'RECIPIENT_INVALID', 'SHOW_VALIDATION_ERROR');
  }
  if (request.clientRequestId.trim().length === 0) {
    return reject('INVALID_REQUEST', correlationId, 'CLIENT_REQUEST_ID_MISSING', 'SHOW_VALIDATION_ERROR');
  }

  // --- 3-5. Idempotency scope and payload fingerprint ------------------------
  const intent: SaleIntent = {
    merchantId: request.merchantId,
    deviceId: request.deviceId,
    productId: request.productId,
    amount: request.amount,
    recipient: request.recipient,
    clientRequestId: request.clientRequestId,
  };
  const idempotencyKey = deriveIdempotencyKey(intent);
  const fingerprint = payloadFingerprint(intent);

  // --- 6-7. Duplicate or mismatch -------------------------------------------
  const existing = deps.driver.findIdempotencyRecord(request.merchantId, idempotencyKey);
  if (existing) {
    if (existing.payload_fingerprint !== fingerprint) {
      return reject('PAYLOAD_MISMATCH', correlationId, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'SHOW_VALIDATION_ERROR', {
        idempotencyKey,
      });
    }
    const original = deps.driver.findTransaction(
      makeTransactionId(existing.transaction_id),
      request.merchantId,
    );
    return {
      kind: 'DUPLICATE_REQUEST',
      originalTransactionId: existing.transaction_id,
      state: (original?.state ?? 'CREATED') as TransactionState,
      correlationId,
      idempotencyKey,
      simulated: true,
      messageKey: MESSAGE_KEYS.DUPLICATE_REQUEST,
      nextAction: 'SHOW_EXISTING_TRANSACTION_STATE',
    };
  }

  // --- Provider health: a blocked request is never charged -------------------
  const health = await deps.provider.healthCheck();
  if (!health.healthy) {
    // No transaction, no reservation, no ledger entry. Nothing to charge.
    return reject('PROVIDER_UNAVAILABLE', correlationId, 'PROVIDER_UNHEALTHY', 'SHOW_PROVIDER_UNAVAILABLE_NO_CHARGE', {
      idempotencyKey,
    });
  }

  const txId = makeTransactionId(deps.newId('txn'));
  const startedAt = deps.now();

  // --- 8-11. Unit of work 1: create, validate, reserve, record --------------
  let reserved: Transaction;
  try {
    reserved = deps.driver.transaction(() => {
      let transaction = createTransaction({
        id: txId,
        merchantId: request.merchantId,
        deviceId: request.deviceId,
        operatorId: request.operatorId,
        productId: request.productId,
        providerId: deps.providerId,
        amount: request.amount,
        recipient: request.recipient,
        idempotencyKey,
        mode: deps.mode,
        at: startedAt,
      });
      assertPositive(transaction.amount, 'A sale amount');
      persist(deps, transaction, request.recipient, fingerprint);
      audit(deps, transaction, 'TRANSACTION_CREATED', correlationId);

      transaction = transitionTo(transaction, 'VALIDATED', { at: deps.now(), reason: 'server validation passed' });
      persist(deps, transaction, request.recipient, fingerprint);

      // Reserve first, then move to RESERVED: if the reservation is refused the
      // state never advances, and the whole unit of work rolls back anyway.
      reserve(deps.driver, {
        merchantId: request.merchantId,
        transactionId: txId,
        amount: request.amount,
        at: deps.now(),
        correlationId,
        actor: { userId: request.operatorId, role: 'MERCHANT_OPERATOR', deviceId: request.deviceId },
        postingId: postingId(deps.newId('post')),
        auditId: deps.newId('audit'),
        reservationId: deps.newId('res'),
      });

      transaction = transitionTo(transaction, 'RESERVED', { at: deps.now(), reason: 'balance reserved' });
      persist(deps, transaction, request.recipient, fingerprint);
      audit(deps, transaction, 'TRANSACTION_TRANSITIONED', correlationId, 'VALIDATED');

      deps.driver.saveIdempotencyRecord({
        key: idempotencyKey,
        merchantId: request.merchantId,
        requestIdentity: canonicalKeySource(intent),
        payloadFingerprint: fingerprint,
        transactionId: txId,
        at: deps.now(),
      });

      return transaction;
    });
  } catch (error) {
    if (error instanceof InsufficientAvailableBalanceError) {
      return reject('INSUFFICIENT_BALANCE', correlationId, 'INSUFFICIENT_AVAILABLE_BALANCE', 'SHOW_VALIDATION_ERROR', {
        idempotencyKey,
      });
    }
    if (error instanceof LiveMoneyDisabledError) {
      return reject('SIMULATED_ONLY', correlationId, TRAINING_ONLY_REASON, 'SHOW_SYSTEM_ERROR', { idempotencyKey });
    }
    // Everything rolled back: no transaction row, no reservation, no entries.
    return reject('PERSISTENCE_FAILURE', correlationId, safeCode(error), 'SHOW_SYSTEM_ERROR', { idempotencyKey });
  }

  // --- 12. Submit, using the same logical transaction and key ---------------
  let processing = deps.driver.transaction(() => {
    const next = transitionTo(reserved, 'PROCESSING', { at: deps.now(), reason: 'submitted to provider' });
    persist(deps, next, request.recipient, fingerprint);
    audit(deps, next, 'PROVIDER_SUBMITTED', correlationId, 'RESERVED');
    return next;
  });

  let outcome: ReturnType<typeof stateForSubmission>;
  let providerReference: string | undefined;
  let category: ProviderErrorCategory;

  try {
    const submission = await deps.provider.submit(
      {
        transactionId: txId,
        merchantId: request.merchantId,
        productId: request.productId,
        amount: request.amount,
        recipient: request.recipient,
        idempotencyKey,
      },
      {
        providerId: deps.providerId,
        deviceId: request.deviceId,
        mode: deps.mode,
        timeoutMs: providerTimeout(deps),
      },
    );

    providerReference = submission.providerReference;
    outcome = stateForSubmission(submission.outcome);
    category =
      submission.outcome === 'CONFIRMED_FAILURE'
        ? 'PROVIDER_CONFIRMED_FAILURE'
        : submission.outcome === 'REJECTED'
          ? 'PROVIDER_REJECTED'
          : submission.outcome === 'DUPLICATE'
            ? 'PROVIDER_DUPLICATE'
            : submission.outcome === 'INDETERMINATE'
              ? 'PROVIDER_INDETERMINATE'
              : 'NONE';
  } catch (error) {
    if (error instanceof LiveMoneyDisabledError) {
      // Fail fast, and give the merchant their value back.
      releaseQuietly(deps, request, txId, processing, correlationId, fingerprint);
      return reject('SIMULATED_ONLY', correlationId, TRAINING_ONLY_REASON, 'SHOW_SYSTEM_ERROR', {
        idempotencyKey,
        transactionId: txId,
      });
    }
    // The provider threw. We do not know whether it delivered, so we say so.
    outcome = 'PENDING';
    category = 'PROVIDER_UNREACHABLE';
  }

  // --- 13-15. Unit of work 2: apply the outcome -----------------------------
  return deps.driver.transaction((): SaleResult => {
    const at = deps.now();

    if (outcome === 'SUCCESSFUL') {
      processing = transitionTo(processing, 'SUCCESSFUL', { at, reason: 'provider confirmed delivery', providerReference });
      persist(deps, processing, request.recipient, fingerprint);
      finalizeSuccess(deps.driver, {
        merchantId: request.merchantId,
        transactionId: txId,
        amount: request.amount,
        at,
        correlationId,
        actor: { userId: request.operatorId, role: 'MERCHANT_OPERATOR', deviceId: request.deviceId },
        postingId: postingId(deps.newId('post')),
        auditId: deps.newId('audit'),
      });
      audit(deps, processing, 'TRANSACTION_TRANSITIONED', correlationId, 'PROCESSING');
      deps.driver.recordIdempotencyResult(request.merchantId, idempotencyKey, 'SUCCESSFUL', at);

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
    }

    if (outcome === 'FAILED') {
      processing = transitionTo(processing, 'FAILED', { at, reason: 'provider confirmed failure', providerReference });
      persist(deps, processing, request.recipient, fingerprint);
      release(deps.driver, {
        merchantId: request.merchantId,
        transactionId: txId,
        amount: request.amount,
        at,
        correlationId,
        actor: { userId: request.operatorId, role: 'MERCHANT_OPERATOR', deviceId: request.deviceId },
        postingId: postingId(deps.newId('post')),
        auditId: deps.newId('audit'),
      });
      audit(deps, processing, 'TRANSACTION_TRANSITIONED', correlationId, 'PROCESSING');
      deps.driver.recordIdempotencyResult(request.merchantId, idempotencyKey, 'FAILED', at);

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
        providerErrorCategory: category,
      };
    }

    // PENDING. The reservation stays held; nothing is debited and nothing is
    // released. A resolution job carries the deadline for escalation.
    processing = transitionTo(processing, 'PENDING', { at, reason: 'no provider response', providerReference });
    persist(deps, processing, request.recipient, fingerprint);
    const deadlineAt = addMs(at, pendingMaximum(deps));
    deps.driver.upsertPendingResolution({
      transactionId: txId,
      merchantId: request.merchantId,
      idempotencyKey,
      providerReference,
      correlationId,
      firstPendingAt: at,
      deadlineAt,
    });
    audit(deps, processing, 'TRANSACTION_TRANSITIONED', correlationId, 'PROCESSING');

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
      providerErrorCategory: category,
      deadlineAt,
    };
  });
}

/** Release a reservation when the sale cannot proceed at all. Best effort, audited. */
function releaseQuietly(
  deps: SaleDeps,
  request: SaleRequest,
  txId: ReturnType<typeof makeTransactionId>,
  transaction: Transaction,
  correlationId: string,
  fingerprint: string,
): void {
  deps.driver.transaction(() => {
    const at = deps.now();
    const failed = transitionTo(transaction, 'FAILED', { at, reason: 'refused: live mode' });
    persist(deps, failed, request.recipient, fingerprint);
    release(deps.driver, {
      merchantId: request.merchantId,
      transactionId: txId,
      amount: request.amount,
      at,
      correlationId,
      actor: { userId: request.operatorId, role: 'MERCHANT_OPERATOR', deviceId: request.deviceId },
      postingId: postingId(deps.newId('post')),
      auditId: deps.newId('audit'),
    });
  });
}

/** A stable, safe code for an unexpected error. Never the message itself. */
function safeCode(error: unknown): string {
  if (error instanceof DomainError) return error.code;
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return `PERSISTENCE_${code}`;
  }
  return 'UNEXPECTED_PERSISTENCE_ERROR';
}

export { timestamp };
