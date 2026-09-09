/**
 * Turning a card authorization into money that actually moved.
 *
 * ## The gap this closes
 *
 * Telga Pay authorised cards and **posted nothing to the ledger**. D68 built it
 * as *"UI-only … no new table, no migration, no persistence"*, which was the
 * right first step and is theatre if it stays: a card sale that moves no money
 * is a screen, not a payment. The founder's instruction was to remove the
 * pretence and build the real path.
 *
 * So this posts a balanced, append-only pair for a settled card sale, through
 * the same ledger every other movement uses. Nothing about it is special-cased
 * for being simulated.
 *
 * ## What is real here, and what is not — stated precisely
 *
 * **Real:** the double-entry, the accounts, the append-only ledger, the
 * idempotency, the fee split, the refusal rules, and the {@link PaymentProcessor}
 * port an acquirer implements. Turning this live is a **configuration and
 * contract** change, not a rewrite.
 *
 * **Not real, and not something code can make real:** the acquirer. There is no
 * merchant acquiring contract, no processor credentials and no certified
 * reader, so the only `PaymentProcessor` wired in is the simulator. That is not
 * a policy position — there is no endpoint to call. When an acquirer exists,
 * it implements the same three methods and this file does not change.
 *
 * ## Why settlement refuses rather than silently doing nothing
 *
 * `payments.acceptance` is off. A settlement call with the flag off returns
 * `FEATURE_DISABLED` — it does **not** return success having posted nothing.
 * A no-op that reports success is how a merchant's screen says "paid" while
 * their balance disagrees, and that is the exact failure §13's invariants
 * exist to prevent.
 */

import { FEATURE_FLAGS } from '@telga/domain';
import type { Money } from '@telga/domain';

export type CardSettlementResult =
  | {
      readonly kind: 'SETTLED';
      readonly postingId: string;
      /** Credited to the merchant. */
      readonly netMinor: number;
      /** Withheld by Telga. Zero unless configured. */
      readonly feeMinor: number;
    }
  /** The flag is off. Nothing was posted, and the caller must not claim otherwise. */
  | { readonly kind: 'FEATURE_DISABLED' }
  /** Already settled under this authorization. Returns the original posting. */
  | { readonly kind: 'ALREADY_SETTLED'; readonly postingId: string }
  | { readonly kind: 'REFUSED'; readonly reason: string };

/**
 * What Telga withholds from a card sale.
 *
 * **Zero unless a founder decision sets it**, like every other rate in this
 * system. §19: commercial pricing is NOT YET CONFIRMED, and §30 forbids
 * inventing one. The mechanism is built and tested so that setting it is a
 * decision rather than a development task.
 */
export interface CardSettlementPolicy {
  readonly feeBasisPoints: number;
}

export const TRAINING_CARD_SETTLEMENT_POLICY: CardSettlementPolicy = Object.freeze({
  feeBasisPoints: 0,
});

/** Rounded **down**, so rounding never costs the merchant. */
export const cardFeeFor = (amountMinor: number, basisPoints: number): number =>
  basisPoints <= 0 ? 0 : Math.floor((amountMinor * basisPoints) / 10_000);

export interface CardSettlementPorts {
  now(): string;
  newId(prefix: string): string;
  /** Has this authorization already been settled? Returns its posting if so. */
  findSettlement(authorizationCode: string): { readonly postingId: string } | undefined;
  /**
   * Post the pair, inside one transaction.
   *
   * The caller owns the transaction boundary for the same reason
   * `shopTransfer.ts` does: a credit that lands without its matching entry is
   * money created, and no ordering of two writes survives a process dying
   * between them.
   */
  postCardSale(input: {
    readonly postingId: string;
    readonly merchantId: string;
    readonly authorizationCode: string;
    readonly grossMinor: number;
    readonly feeMinor: number;
    readonly netMinor: number;
    readonly correlationId: string;
    readonly at: string;
  }): void;
}

export interface CardSettlementRequest {
  readonly merchantId: string;
  /** From the processor. The idempotency key for a card sale. */
  readonly authorizationCode: string;
  readonly amount: Money;
  /**
   * Whether the authorization came from a real acquirer or the simulator.
   *
   * Carried explicitly rather than inferred, and **refused when it disagrees
   * with the flag**: a simulated authorization must never settle while
   * `payments.acceptance` is on, and a live one must never settle while it is
   * off. Those are the two ways a training deployment and a real one could
   * quietly swap places.
   */
  readonly simulated: boolean;
}

/**
 * Settle an authorized card sale.
 *
 * ## Why the authorization code is the idempotency key
 *
 * It is the one identifier both sides of the transaction agree on, and a
 * processor guarantees it is unique per authorization. Retrying a settlement —
 * which a flaky counter connection will do — must credit the merchant once.
 * §13 invariant 6: an uncertain retry reuses the same logical transaction.
 */
export function settleCardSale(
  ports: CardSettlementPorts,
  request: CardSettlementRequest,
  policy: CardSettlementPolicy = TRAINING_CARD_SETTLEMENT_POLICY,
): CardSettlementResult {
  // Refuses; never a silent no-op. A settlement that reports success having
  // posted nothing is how a screen says "paid" while a balance disagrees.
  if (!FEATURE_FLAGS['payments.acceptance']) return { kind: 'FEATURE_DISABLED' };

  // The two ways training and production could quietly swap places.
  if (request.simulated) {
    return { kind: 'REFUSED', reason: 'SIMULATED_AUTHORIZATION_CANNOT_SETTLE' };
  }

  if (request.amount.minor <= 0 || !Number.isInteger(request.amount.minor)) {
    return { kind: 'REFUSED', reason: 'AMOUNT_NOT_POSITIVE' };
  }

  const existing = ports.findSettlement(request.authorizationCode);
  if (existing !== undefined) {
    return { kind: 'ALREADY_SETTLED', postingId: existing.postingId };
  }

  const feeMinor = cardFeeFor(request.amount.minor, policy.feeBasisPoints);
  const netMinor = request.amount.minor - feeMinor;
  const postingId = ports.newId('post');
  const at = ports.now();

  ports.postCardSale({
    postingId,
    merchantId: request.merchantId,
    authorizationCode: request.authorizationCode,
    grossMinor: request.amount.minor,
    feeMinor,
    netMinor,
    correlationId: ports.newId('corr'),
    at,
  });

  return { kind: 'SETTLED', postingId, netMinor, feeMinor };
}

/**
 * What still has to be true before a card sale settles real money.
 *
 * Exported so a start-up check, a launch-gate report or an operator screen can
 * render the same list rather than three drifting copies of it. Empty means
 * nothing here is outstanding — it does **not** mean the feature is safe to
 * enable, which is a legal question this file cannot answer.
 */
export function cardSettlementBlockers(): readonly string[] {
  const blockers: string[] = [];
  if (!FEATURE_FLAGS['payments.acceptance']) {
    blockers.push('payments.acceptance is off');
  }
  if (!FEATURE_FLAGS['money.live']) {
    blockers.push('money.live is off, so no real value can move at all');
  }
  // Not derivable from code, and the honest reason the above are off.
  blockers.push('no acquiring contract, processor credentials or certified reader exists');
  return blockers;
}
