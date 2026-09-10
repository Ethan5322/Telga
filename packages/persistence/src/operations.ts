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
/**
 * Move earned profit into the merchant's selling balance.
 *
 * A balanced pair: `TELGA_REVENUE` is debited and `MERCHANT_AVAILABLE`
 * credited, so nothing is created or destroyed — the money changes which
 * bucket it sits in, which is exactly what the owner is asking for.
 *
 * Posted as `ADJUSTMENT`, because that is what CLAUDE.md's eighth ledger
 * invariant requires of a correction: an authorized adjustment entry, never a
 * silent edit. The earlier `COMMISSION_CREDIT` entries are untouched, so the
 * history of what each sale earned is still readable after a transfer.
 *
 * Idempotent through `postingId`, like every other operation here: a double
 * press moves the money once.
 *
 * **The caller must check the amount against `profitAvailableMinor` first.**
 * This function posts what it is given; the bound belongs with the service
 * that can return a refusal an operator can read.
 */
export function transferProfitToBalance(
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
          reason: 'ADJUSTMENT',
        },
        {
          accountId: PLATFORM_ACCOUNTS.TELGA_REVENUE,
          accountKind: 'TELGA_REVENUE',
          merchantId: input.merchantId,
          direction: 'DEBIT',
          amount: input.amount,
          reason: 'ADJUSTMENT',
        },
      ],
    });
  });
}

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
 * Return the value of a **settled** sale to a merchant.
 *
 * ## Why this is not `release`
 *
 * The two reversal shapes move different money, and confusing them posts
 * nothing or posts twice:
 *
 * - A `PENDING` or `UNDER_REVIEW` sale still **holds a reservation**. Reversing
 *   it releases that hold — `release` and `releaseFromUnderReview` — and no new
 *   value is created.
 * - A `SUCCESSFUL` sale has already been **debited**. There is no reservation
 *   left to release, so returning the money means posting a **compensating
 *   credit**. Calling `release` on one would find no reservation and silently
 *   move nothing, leaving a transaction marked `REVERSED` and a balance that
 *   never changed.
 *
 * §13 invariant 8: this is an **authorised adjustment entry**, never an edit of
 * the original. The sale's own entries stay exactly as they were — the ledger
 * is append-only, and the history of what happened must remain readable after
 * the correction.
 *
 * The counterparty is `PROVIDER_SETTLEMENT`, because that is who the value was
 * paid to and who Telga recovers from where the contract allows (§17). It is
 * not `TELGA_REVENUE`: Telga did not keep this money, and posting it there
 * would overstate revenue by every reversal.
 */
export function postReversalAdjustment(
  driver: SqliteLedgerDriver,
  input: {
    merchantId: MerchantId;
    amount: Money;
    at: Timestamp;
    correlationId: string;
    postingId: PostingId;
    transactionId?: TransactionId;
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
          // Carried on the entries, not the posting: `ledger_entries` is what
          // holds the link, so a later reader asking "what moved for this sale"
          // finds the adjustment beside the original debit.
          transactionId: input.transactionId,
          direction: 'CREDIT',
          amount: input.amount,
          reason: 'REVERSAL',
        },
        {
          accountId: PLATFORM_ACCOUNTS.PROVIDER_SETTLEMENT,
          accountKind: 'PROVIDER_SETTLEMENT',
          transactionId: input.transactionId,
          direction: 'DEBIT',
          amount: input.amount,
          reason: 'REVERSAL',
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
 * Value leaves the reserved bucket for provider settlement.
 *
 * ## The training profit leg
 *
 * When `profitMinor` is supplied and non-zero, the posting has three legs
 * rather than two:
 *
 *   DEBIT  merchant reserved      face value
 *   CREDIT provider settlement    face value − profit
 *   CREDIT Telga revenue          profit
 *
 * which still sums to zero. The merchant's float drops by the **face value**
 * and the customer pays exactly that; the profit is the margin between what
 * the merchant paid and what the provider is owed. It is a shop-side credit,
 * never a surcharge — see Decision Log D69.
 *
 * **This is a training rate, not a commission.** `CommissionRule` and
 * `FeeRule` remain `NOT_YET_CONFIRMED` and `computeCommission` still throws:
 * a real provider commission has not been negotiated, and this leg does not
 * pretend otherwise. When a signed agreement exists, the commission posting
 * is added here and nowhere else.
 *
 * Omitting `profitMinor` keeps the original two-leg posting exactly.
 */
export function finalizeSuccess(
  driver: SqliteLedgerDriver,
  context: OperationContext & { readonly profitMinor?: number; readonly profitBps?: number },
): void {
  driver.transaction(() => {
    const row = driver.findReservation(context.transactionId, context.merchantId);
    if (!row) throw new PersistenceError('ACCOUNT_NOT_FOUND', `No reservation for ${context.transactionId}`);

    guardedTransition(driver, row.id, 'HELD', 'SETTLED', context.at, 'Finalize');

    // Clamped so a misconfigured rate can never invert the provider leg into
    // a debit, which would silently move value the wrong way.
    const profitMinor = Math.max(0, Math.min(context.profitMinor ?? 0, context.amount.minor));
    const providerMinor = context.amount.minor - profitMinor;

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
          amount: { minor: providerMinor, currency: context.amount.currency },
          reason: 'SALE_DEBIT',
        },
        ...(profitMinor > 0
          ? [
              {
                accountId: PLATFORM_ACCOUNTS.TELGA_REVENUE,
                accountKind: 'TELGA_REVENUE' as const,
                // The account is a platform account; `merchantId` here is the
                // *attribution* — which shop's sale produced this — which is
                // what ledger invariant 7 asks for and what lets a merchant
                // be shown their own day's profit. `TELGA_REVENUE` is in no
                // balance bucket (`balanceFor` sums only the merchant account
                // kinds), so attributing it cannot move a merchant balance.
                merchantId: context.merchantId,
                transactionId: context.transactionId,
                direction: 'CREDIT' as const,
                amount: { minor: profitMinor, currency: context.amount.currency },
                // `COMMISSION_CREDIT` is the closest existing reason, and
                // `ledger_entries.entry_type` is CHECK-constrained on an
                // **append-only** table — widening it would mean rebuilding
                // ledger history, which is a far worse trade than reusing a
                // reason. What keeps this honest is `ruleVersion`: it names
                // the training rate explicitly, so no reader can mistake this
                // entry for a real negotiated commission.
                reason: 'COMMISSION_CREDIT' as const,
                ruleVersion: `training-profit-${String(context.profitBps ?? 0)}bps`,
              },
            ]
          : []),
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
