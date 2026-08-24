/**
 * The Transaction aggregate.
 *
 * One logical sale. It survives retries — an uncertain outcome never produces a
 * second transaction, it re-enters this one. Every state change goes through
 * `transitionTo`, which consults the transition map, so no code path can write
 * a state directly.
 *
 * Transactions are immutable: a transition returns a new frozen object with the
 * move appended to `history`, which is what makes the whole lifecycle
 * reconstructible after the fact.
 */

import { assertSameMerchant } from './balance';
import type { AuditActor, AuditEvent } from './audit';
import { createAuditEvent } from './audit';
import type {
  AuditEventId,
  DeviceId,
  IdempotencyKey,
  MerchantId,
  MerchantUserId,
  ProductId,
  ProviderId,
  Timestamp,
  TransactionId,
} from './ids';
import type { OperatingMode } from './mode';
import { assertSimulated } from './mode';
import type { Money } from './money';
import { assertPositive } from './money';
import type { TransactionState } from './states';
import { assertTransition, INITIAL_STATE, isTerminal, VALUE_DISPOSITION } from './states';
import type { ValueDisposition } from './states';

export interface TransitionRecord {
  readonly from: TransactionState;
  readonly to: TransactionState;
  readonly at: Timestamp;
  readonly reason?: string;
}

export interface Transaction {
  readonly id: TransactionId;
  readonly merchantId: MerchantId;
  readonly deviceId: DeviceId;
  readonly operatorId: MerchantUserId;
  readonly productId: ProductId;
  readonly providerId?: ProviderId;
  readonly amount: Money;
  readonly recipient: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly providerReference?: string;
  readonly state: TransactionState;
  readonly mode: OperatingMode;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly history: readonly TransitionRecord[];
}

export function createTransaction(input: {
  id: TransactionId;
  merchantId: MerchantId;
  deviceId: DeviceId;
  operatorId: MerchantUserId;
  productId: ProductId;
  providerId?: ProviderId;
  amount: Money;
  recipient: string;
  idempotencyKey: IdempotencyKey;
  mode: OperatingMode;
  at: Timestamp;
}): Transaction {
  assertSimulated(input.mode);
  assertPositive(input.amount, 'A sale amount');

  return Object.freeze({
    id: input.id,
    merchantId: input.merchantId,
    deviceId: input.deviceId,
    operatorId: input.operatorId,
    productId: input.productId,
    providerId: input.providerId,
    amount: input.amount,
    recipient: input.recipient,
    idempotencyKey: input.idempotencyKey,
    state: INITIAL_STATE,
    mode: input.mode,
    createdAt: input.at,
    updatedAt: input.at,
    history: Object.freeze([]),
  });
}

/**
 * Move a transaction to a new state.
 *
 * Throws `IllegalTransitionError` — or `TerminalStateError` from a terminal
 * origin — when the map does not allow the move.
 */
export function transitionTo(
  transaction: Transaction,
  to: TransactionState,
  context: { at: Timestamp; reason?: string; providerReference?: string },
): Transaction {
  assertTransition(transaction.state, to);

  const record: TransitionRecord = Object.freeze({
    from: transaction.state,
    to,
    at: context.at,
    reason: context.reason,
  });

  return Object.freeze({
    ...transaction,
    state: to,
    providerReference: context.providerReference ?? transaction.providerReference,
    updatedAt: context.at,
    history: Object.freeze([...transaction.history, record]),
  });
}

/** Transition and produce the audit event for it in one step. */
export function transitionWithAudit(
  transaction: Transaction,
  to: TransactionState,
  context: {
    at: Timestamp;
    auditId: AuditEventId;
    actor: AuditActor;
    reason?: string;
    providerReference?: string;
  },
): { transaction: Transaction; audit: AuditEvent } {
  const before = transaction.state;
  const next = transitionTo(transaction, to, context);
  const audit = createAuditEvent({
    id: context.auditId,
    at: context.at,
    action: 'TRANSACTION_TRANSITIONED',
    actor: context.actor,
    merchantId: transaction.merchantId,
    transactionId: transaction.id,
    before,
    after: to,
    detail: context.reason,
  });
  return { transaction: next, audit };
}

/** Where this transaction's value currently sits. */
export function valueDisposition(transaction: Transaction): ValueDisposition {
  return VALUE_DISPOSITION[transaction.state];
}

export const isComplete = (transaction: Transaction): boolean => isTerminal(transaction.state);

/** True while a merchant-initiated retry must be refused. */
export const retryBlocked = (transaction: Transaction): boolean => !isTerminal(transaction.state);

/** Guard every read and write path that names a merchant. */
export function assertOwnedBy(transaction: Transaction, merchant: MerchantId): void {
  assertSameMerchant(transaction.merchantId, merchant);
}
