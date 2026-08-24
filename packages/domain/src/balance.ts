/**
 * Balance reservations and the four balance views.
 *
 * From `03 Domain/Balance Model.md`: available, reserved, under review, total.
 * All four are **derived from the ledger and the live reservations** — none is
 * stored as a mutable field, so they cannot drift apart from the entries.
 *
 *   Total     = settled position of the merchant funds account
 *   Available = Total − Reserved − UnderReview
 */

import { CrossMerchantAccessError, InsufficientAvailableBalanceError } from './errors';
import type { MerchantId, ReservationId, Timestamp, TransactionId } from './ids';
import type { LedgerEntry } from './ledger';
import { isMerchantAccountKind, signedMinor } from './ledger';
import type { Money } from './money';
import { assertPositive, format, gte, money, subtract, zero } from './money';

export type ReservationState = 'HELD' | 'UNDER_REVIEW' | 'RELEASED' | 'SETTLED';

export interface BalanceReservation {
  readonly id: ReservationId;
  readonly merchantId: MerchantId;
  readonly transactionId: TransactionId;
  readonly amount: Money;
  readonly state: ReservationState;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/** The four numbers a merchant sees. */
export interface BalanceView {
  readonly available: Money;
  readonly reserved: Money;
  readonly underReview: Money;
  readonly total: Money;
}

export function createReservation(input: {
  id: ReservationId;
  merchantId: MerchantId;
  transactionId: TransactionId;
  amount: Money;
  at: Timestamp;
}): BalanceReservation {
  assertPositive(input.amount, 'A reservation');
  return Object.freeze({
    id: input.id,
    merchantId: input.merchantId,
    transactionId: input.transactionId,
    amount: input.amount,
    state: 'HELD' as const,
    createdAt: input.at,
    updatedAt: input.at,
  });
}

function moveReservation(
  reservation: BalanceReservation,
  state: ReservationState,
  at: Timestamp,
): BalanceReservation {
  return Object.freeze({ ...reservation, state, updatedAt: at });
}

/** Value moves from reserved into the under-review bucket. Still not available. */
export const moveToUnderReview = (r: BalanceReservation, at: Timestamp): BalanceReservation =>
  moveReservation(r, 'UNDER_REVIEW', at);

/** Value returns to available — a confirmed failure or a completed reversal. */
export const releaseReservation = (r: BalanceReservation, at: Timestamp): BalanceReservation =>
  moveReservation(r, 'RELEASED', at);

/** The sale completed; the held value is now covered by a debit entry. */
export const settleReservation = (r: BalanceReservation, at: Timestamp): BalanceReservation =>
  moveReservation(r, 'SETTLED', at);

/**
 * Settled position across every merchant-owned account for one merchant.
 *
 * Covers both the undivided `MERCHANT_FUNDS` account used by the in-memory
 * model and the three buckets the persistence layer posts between, so the two
 * representations produce the same total.
 */
export function settledBalance(
  merchant: MerchantId,
  entries: readonly LedgerEntry[],
): Money {
  const total = entries
    .filter((entry) => isMerchantAccountKind(entry.accountKind) && entry.merchantId === merchant)
    .reduce((acc, entry) => acc + signedMinor(entry), 0);
  return money(total);
}

/**
 * Compute the four views.
 *
 * Entries and reservations belonging to other merchants are ignored, not
 * merely hidden — passing a mixed set produces the same answer as passing a
 * pre-filtered one. That is the isolation property the tests assert.
 */
export function computeBalance(
  merchant: MerchantId,
  entries: readonly LedgerEntry[],
  reservations: readonly BalanceReservation[],
): BalanceView {
  const mine = reservations.filter((r) => r.merchantId === merchant);

  const reservedMinor = mine
    .filter((r) => r.state === 'HELD')
    .reduce((acc, r) => acc + r.amount.minor, 0);

  const underReviewMinor = mine
    .filter((r) => r.state === 'UNDER_REVIEW')
    .reduce((acc, r) => acc + r.amount.minor, 0);

  const total = settledBalance(merchant, entries);
  const reserved = money(reservedMinor);
  const underReview = money(underReviewMinor);
  const available = subtract(subtract(total, reserved), underReview);

  return Object.freeze({ available, reserved, underReview, total });
}

/** Throw unless the merchant has enough *available* balance to reserve `amount`. */
export function assertSufficientAvailable(view: BalanceView, amount: Money): void {
  if (!gte(view.available, amount)) {
    throw new InsufficientAvailableBalanceError(
      `Available balance ${format(view.available)} is below the required ${format(amount)}`,
    );
  }
}

/** Guard for any operation that names a merchant explicitly. */
export function assertSameMerchant(expected: MerchantId, actual: MerchantId): void {
  if (expected !== actual) {
    throw new CrossMerchantAccessError(expected, actual);
  }
}

export const emptyBalance = (): BalanceView =>
  Object.freeze({ available: zero(), reserved: zero(), underReview: zero(), total: zero() });
