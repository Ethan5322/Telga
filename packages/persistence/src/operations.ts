/**
 * Atomic ledger operations.
 *
 * Each of these is one unit of work: the reservation row and the postings that
 * accompany it commit together or not at all. A throw anywhere inside rolls the
 * whole thing back, which is what makes a failed reservation leave no partial
 * state.
 *
 * The **decisions** live in the domain — is there enough available balance, what
 * state may a transaction move to, may a fee be charged. This file supplies
 * atomicity and ordering, not policy.
 *
 * Ordering is deliberate everywhere: the reservation status update comes
 * **first**, because its `WHERE status = ...` clause is the concurrency guard.
 * If it changes no row, the operation has already happened and we refuse rather
 * than posting a second set of entries.
 */

import {
  assertSufficientAvailable,
  createAuditEvent,
  createReservation,
  auditEventId,
  ledgerAccountId,
  reservationId as makeReservationId,
} from '@telga/domain';
import type {
  AuditActor,
  DraftEntry,
  LedgerAccountId,
  MerchantId,
  Money,
  PostingId,
  Timestamp,
  TransactionId,
} from '@telga/domain';
import type { AccountType } from './schema/types';
import type { SqliteLedgerDriver } from './sqlite/driver';
import { PersistenceError } from './driver/errors';

/** Deterministic account ids, so a merchant's accounts are addressable by name. */
export const merchantAccountId = (merchantId: MerchantId, type: AccountType): LedgerAccountId =>
  ledgerAccountId(`acct_${merchantId}_${type.toLowerCase()}`);

export const PLATFORM_ACCOUNTS = Object.freeze({
  BANK_CLEARING: ledgerAccountId('acct_platform_bank_clearing'),
  PROVIDER_SETTLEMENT: ledgerAccountId('acct_platform_provider_settlement'),
  TELGA_REVENUE: ledgerAccountId('acct_platform_telga_revenue'),
  REFUND_RESERVES: ledgerAccountId('acct_platform_refund_reserves'),
  HARDWARE_DEPOSITS: ledgerAccountId('acct_platform_hardware_deposits'),
});

/** Create the three merchant buckets and the platform accounts if absent. */
export function ensureAccounts(driver: SqliteLedgerDriver, merchantId: MerchantId, at: Timestamp): void {
  for (const type of ['MERCHANT_AVAILABLE', 'MERCHANT_RESERVED', 'MERCHANT_UNDER_REVIEW'] as const) {
    driver.ensureAccount({ id: merchantAccountId(merchantId, type), merchantId, accountType: type, at });
  }
  for (const [type, id] of Object.entries(PLATFORM_ACCOUNTS)) {
    driver.ensureAccount({ id, accountType: type as AccountType, at });
  }
}

interface OperationContext {
  readonly merchantId: MerchantId;
  readonly transactionId: TransactionId;
  readonly amount: Money;
  readonly at: Timestamp;
  readonly correlationId: string;
  readonly actor: AuditActor;
  readonly postingId: PostingId;
  readonly auditId: string;
}

function bucketTransfer(
  merchantId: MerchantId,
  from: AccountType,
  to: AccountType,
  amount: Money,
  transactionId: TransactionId,
  reason: DraftEntry['reason'],
): DraftEntry[] {
  return [
    {
      accountId: merchantAccountId(merchantId, from),
      accountKind: from,
      merchantId,
      transactionId,
      direction: 'DEBIT',
      amount,
      reason,
    },
    {
      accountId: merchantAccountId(merchantId, to),
      accountKind: to,
      merchantId,
      transactionId,
      direction: 'CREDIT',
      amount,
      reason,
    },
  ];
}

function audit(
  driver: SqliteLedgerDriver,
  context: OperationContext,
  action: Parameters<typeof createAuditEvent>[0]['action'],
  entityType: string,
): void {
  driver.saveAuditEvent({
    event: createAuditEvent({
      id: auditEventId(context.auditId),
      at: context.at,
      action,
      actor: context.actor,
      merchantId: context.merchantId,
      transactionId: context.transactionId,
    }),
    correlationId: context.correlationId,
    entityType,
    entityId: context.transactionId,
  });
}

/**
 * Credit a merchant's available balance from a verified deposit.
 *
 * Simulated only: the driver refuses any non-TRAINING mode, and the schema
 * constrains `mode` to `'TRAINING'`.
 */
export function fundMerchant(
  driver: SqliteLedgerDriver,
  input: {
    merchantId: MerchantId;
    amount: Money;
    at: Timestamp;
    correlationId: string;
    postingId: PostingId;
  },
): void {
  driver.transaction(() => {
    ensureAccounts(driver, input.merchantId, input.at);
    driver.appendEntries({
      postingId: input.postingId,
      correlationId: input.correlationId,
      at: input.at,
      mode: 'TRAINING',
      entries: [
        {
          accountId: merchantAccountId(input.merchantId, 'MERCHANT_AVAILABLE'),
          accountKind: 'MERCHANT_AVAILABLE',
          merchantId: input.merchantId,
          direction: 'CREDIT',
          amount: input.amount,
          reason: 'FUNDING_CREDIT',
        },
        {
          accountId: PLATFORM_ACCOUNTS.BANK_CLEARING,
          accountKind: 'BANK_CLEARING',
          direction: 'DEBIT',
          amount: input.amount,
          reason: 'FUNDING_CREDIT',
        },
      ],
    });
  });
}

/**
 * Reserve value against a sale.
 *
 * Sufficiency is decided by the domain (`assertSufficientAvailable`); this
 * function only enforces that the check, the postings and the reservation row
 * happen together.
 */
export function reserve(
  driver: SqliteLedgerDriver,
  context: OperationContext & { reservationId?: string },
): void {
  driver.transaction(() => {
    ensureAccounts(driver, context.merchantId, context.at);

    const view = driver.balanceFor(context.merchantId);
    assertSufficientAvailable(view, context.amount);

    const reservation = createReservation({
      id: makeReservationId(context.reservationId ?? `res_${context.transactionId}`),
      merchantId: context.merchantId,
      transactionId: context.transactionId,
      amount: context.amount,
      at: context.at,
    });
    driver.saveReservation(reservation, context.correlationId);

    driver.appendEntries({
      postingId: context.postingId,
      correlationId: context.correlationId,
      at: context.at,
      mode: 'TRAINING',
      entries: bucketTransfer(
        context.merchantId,
        'MERCHANT_AVAILABLE',
        'MERCHANT_RESERVED',
        context.amount,
        context.transactionId,
        'SALE_DEBIT',
      ),
    });

    audit(driver, context, 'BALANCE_RESERVED', 'balance_reservation');
  });
}

function guardedTransition(
  driver: SqliteLedgerDriver,
  reservationRowId: string,
  from: 'HELD' | 'UNDER_REVIEW',
  to: 'RELEASED' | 'SETTLED' | 'UNDER_REVIEW',
  at: Timestamp,
  operation: string,
): void {
  const moved =
    from === 'HELD'
      ? driver.transitionHeldReservation(reservationRowId, to, at)
      : driver.transitionUnderReviewReservation(reservationRowId, to, at);

  if (!moved) {
    throw new PersistenceError(
      'MERCHANT_SCOPE_VIOLATION',
      `${operation} refused: reservation ${reservationRowId} is not in state ${from}. It has already been resolved.`,
    );
  }
}

/**
 * Release a held reservation back to available.
 *
 * The original entries are never touched — the release is a **new** balancing
 * posting in the opposite direction.
 */
export function release(driver: SqliteLedgerDriver, context: OperationContext): void {
  driver.transaction(() => {
    const row = driver.findReservation(context.transactionId, context.merchantId);
    if (!row) throw new PersistenceError('ACCOUNT_NOT_FOUND', `No reservation for ${context.transactionId}`);

    guardedTransition(driver, row.id, 'HELD', 'RELEASED', context.at, 'Release');

    driver.appendEntries({
      postingId: context.postingId,
      correlationId: context.correlationId,
      at: context.at,
      mode: 'TRAINING',
      entries: bucketTransfer(
        context.merchantId,
        'MERCHANT_RESERVED',
        'MERCHANT_AVAILABLE',
        context.amount,
        context.transactionId,
        'REVERSAL',
      ),
    });

    audit(driver, context, 'BALANCE_RELEASED', 'balance_reservation');
  });
}

/**
 * Finalize a successful sale.
 *
 * Value leaves the reserved bucket for provider settlement. **No commission or
 * fee entry is written**: `CommissionRule` and `FeeRule` are
 * `NOT_YET_CONFIRMED`, and inventing a rate here would fabricate a commercial
 * term. When a signed agreement exists, the commission posting is added here
 * and nowhere else.
 */
export function finalizeSuccess(driver: SqliteLedgerDriver, context: OperationContext): void {
  driver.transaction(() => {
    const row = driver.findReservation(context.transactionId, context.merchantId);
    if (!row) throw new PersistenceError('ACCOUNT_NOT_FOUND', `No reservation for ${context.transactionId}`);

    guardedTransition(driver, row.id, 'HELD', 'SETTLED', context.at, 'Finalize');

    driver.appendEntries({
      postingId: context.postingId,
      correlationId: context.correlationId,
      at: context.at,
      mode: 'TRAINING',
      entries: [
        {
          accountId: merchantAccountId(context.merchantId, 'MERCHANT_RESERVED'),
          accountKind: 'MERCHANT_RESERVED',
          merchantId: context.merchantId,
          transactionId: context.transactionId,
          direction: 'DEBIT',
          amount: context.amount,
          reason: 'SALE_DEBIT',
        },
        {
          accountId: PLATFORM_ACCOUNTS.PROVIDER_SETTLEMENT,
          accountKind: 'PROVIDER_SETTLEMENT',
          transactionId: context.transactionId,
          direction: 'CREDIT',
          amount: context.amount,
          reason: 'SALE_DEBIT',
        },
      ],
    });

    audit(driver, context, 'LEDGER_POSTED', 'transaction');
  });
}

/** Move held value into the under-review bucket. Still excluded from available. */
export function moveToUnderReview(driver: SqliteLedgerDriver, context: OperationContext): void {
  driver.transaction(() => {
    const row = driver.findReservation(context.transactionId, context.merchantId);
    if (!row) throw new PersistenceError('ACCOUNT_NOT_FOUND', `No reservation for ${context.transactionId}`);

    guardedTransition(driver, row.id, 'HELD', 'UNDER_REVIEW', context.at, 'Move to under review');

    driver.appendEntries({
      postingId: context.postingId,
      correlationId: context.correlationId,
      at: context.at,
      mode: 'TRAINING',
      entries: bucketTransfer(
        context.merchantId,
        'MERCHANT_RESERVED',
        'MERCHANT_UNDER_REVIEW',
        context.amount,
        context.transactionId,
        'ADJUSTMENT',
      ),
    });

    audit(driver, context, 'BALANCE_UNDER_REVIEW', 'balance_reservation');
  });
}

/** Resolve an under-review reservation back to available. */
export function releaseFromUnderReview(driver: SqliteLedgerDriver, context: OperationContext): void {
  driver.transaction(() => {
    const row = driver.findReservation(context.transactionId, context.merchantId);
    if (!row) throw new PersistenceError('ACCOUNT_NOT_FOUND', `No reservation for ${context.transactionId}`);

    guardedTransition(driver, row.id, 'UNDER_REVIEW', 'RELEASED', context.at, 'Release from under review');

    driver.appendEntries({
      postingId: context.postingId,
      correlationId: context.correlationId,
      at: context.at,
      mode: 'TRAINING',
      entries: bucketTransfer(
        context.merchantId,
        'MERCHANT_UNDER_REVIEW',
        'MERCHANT_AVAILABLE',
        context.amount,
        context.transactionId,
        'REVERSAL',
      ),
    });

    audit(driver, context, 'ADJUSTMENT_POSTED', 'balance_reservation');
  });
}
