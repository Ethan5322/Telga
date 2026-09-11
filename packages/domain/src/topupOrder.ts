/**
 * Top-up orders — the rules behind the **Deposit money** button, `CLAUDE.md` §20.1.
 *
 * A shop presses one button and gets a printed slip telling it where to pay and
 * what to quote. This module decides whether that slip may be printed at all.
 *
 * ## What this module is careful not to do
 *
 * **It never credits anything.** Ordering a top-up is a statement of intent; a
 * balance appears only when a bank record is confirmed (`verifyDeposit`). The
 * separation is the whole safety of the feature — §20.1: *"the slip creates an
 * expectation, never a balance."*
 *
 * **It never chooses the reference.** `newDepositReference()` draws one and the
 * `UNIQUE` column decides whether it stands. A rule module that also minted
 * identifiers would be the natural place for somebody to later add "reuse the
 * shop's last code", which is exactly what must not happen.
 */

import type { Money } from './money';

/** Where an order stands. `PAID` is set by settlement, never by this module. */
export type TopupOrderStatus = 'OPEN' | 'PAID' | 'EXPIRED' | 'CANCELLED';

/**
 * Why a shop cannot print a slip right now.
 *
 * Each is a different sentence to a shopkeeper, which is why they are separate
 * values rather than one refusal with a message attached.
 */
export type TopupOrderRefusal =
  /** The shop is suspended, closed, or not yet activated. */
  | 'SHOP_NOT_ACTIVE'
  /** Zero, negative, or not a whole number of minor units. */
  | 'AMOUNT_INVALID'
  | 'AMOUNT_BELOW_MINIMUM'
  | 'AMOUNT_ABOVE_MAXIMUM'
  /** A slip is already out. §20.1 allows one at a time. */
  | 'ORDER_ALREADY_OPEN'
  /** Deposits are switched off entirely. */
  | 'DEPOSITS_DISABLED';

/**
 * The limits, all configurable and none invented.
 *
 * §19 and §31: nothing here may present a commercial figure as decided. The
 * training values exist so the flow can be exercised, and they are marked as
 * what they are.
 */
export interface TopupOrderPolicy {
  /** Smallest slip worth printing. `NOT YET CONFIRMED`. */
  readonly minimumMinor: number;
  /** Largest single order. `NOT YET CONFIRMED`. */
  readonly maximumMinor: number;
  /**
   * How long a slip is good for.
   *
   * Not a commercial term — an operational one. A slip that never expires is a
   * reference that must be honoured forever, and a shop that finds a
   * six-month-old slip in a drawer should be told to print a fresh one rather
   * than have Telga guess whether the payment was meant for today.
   */
  readonly validForMs: number;
}

/**
 * Training limits. **Not prices, not commercial terms.**
 *
 * 50 birr to 50,000 birr, valid for a day. The ceiling matches the training
 * deposit ceiling the console already uses for `autoCreditCapMinor`, so a slip
 * cannot be printed for more than the amount that would then require a second
 * approval — the two limits agreeing is less confusing than one silently
 * overriding the other.
 */
export const TRAINING_TOPUP_POLICY: TopupOrderPolicy = Object.freeze({
  minimumMinor: 5_000,
  maximumMinor: 5_000_000,
  validForMs: 24 * 60 * 60 * 1000,
});

export interface TopupOrderRequest {
  /** `ACTIVE` is the only value that may print a slip. */
  readonly shopStatus: string;
  readonly amount: Money;
  /** True when this shop already has an unexpired, unpaid slip out. */
  readonly hasOpenOrder: boolean;
  readonly depositsEnabled: boolean;
}

/**
 * May this shop print a deposit slip?
 *
 * Order matters and is deliberate. Identity and capability are settled before
 * the amount is even read: telling a suspended shop that its amount is too
 * small would be answering the wrong question, and it would leak that the
 * amount was the only problem.
 */
export function decideTopupOrder(
  request: TopupOrderRequest,
  policy: TopupOrderPolicy = TRAINING_TOPUP_POLICY,
): TopupOrderRefusal | undefined {
  if (!request.depositsEnabled) return 'DEPOSITS_DISABLED';

  // A suspended shop neither sells nor takes money in. Same rule as §19.1.
  if (request.shopStatus !== 'ACTIVE') return 'SHOP_NOT_ACTIVE';

  // One slip at a time — §20.1. Two live slips is a shopkeeper at a bank
  // counter deciding which reference to write, and a wrong guess is a payment
  // that resolves to an order for a different amount.
  if (request.hasOpenOrder) return 'ORDER_ALREADY_OPEN';

  const minor = request.amount.minor;
  if (!Number.isSafeInteger(minor) || minor <= 0) return 'AMOUNT_INVALID';
  if (minor < policy.minimumMinor) return 'AMOUNT_BELOW_MINIMUM';
  if (minor > policy.maximumMinor) return 'AMOUNT_ABOVE_MAXIMUM';

  return undefined;
}

/**
 * When a slip printed now stops being valid.
 *
 * Returned as an ISO string because that is what the row stores and what the
 * slip prints; keeping the arithmetic here means the expiry on paper and the
 * expiry in the database cannot drift apart.
 */
export const topupOrderExpiry = (
  now: Date,
  policy: TopupOrderPolicy = TRAINING_TOPUP_POLICY,
): string => new Date(now.getTime() + policy.validForMs).toISOString();

/**
 * Has this order run out?
 *
 * Expiry is read from the row rather than recomputed from `created_at`, so
 * changing the policy never retroactively expires a slip somebody is holding.
 */
export const isTopupOrderExpired = (order: { expiresAt: string }, now: Date): boolean =>
  Date.parse(order.expiresAt) <= now.getTime();
