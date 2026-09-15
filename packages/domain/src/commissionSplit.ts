/**
 * The commission split — founder fee policy, 2026-09-14.
 *
 * ## The model, and what it replaced
 *
 * A provider pays Telga a commission on a sale. That commission is split: the
 * shop keeps most of it, Telga keeps the rest.
 *
 * ```
 * providerCommission = transactionAmount × providerCommissionRate
 * shopShare          = providerCommission × 70%
 * telgaShare         = providerCommission − shopShare
 * ```
 *
 * **Two steps, not one.** The founder's policy is explicit: *"do not calculate
 * shop profit from the full transaction amount unless the contract explicitly
 * allows it."* The training model it replaces (`trainingProfitMinor`, D69) did
 * exactly that — 4% of face value — and the difference is not cosmetic: on a
 * 100 birr sale at a 3% provider rate a shop earns **2.10** here where it
 * earned **4.00** there. The founder was told that plainly and chose this
 * model.
 *
 * ## Why Telga's share is subtracted rather than calculated
 *
 * Rounding both shares independently loses or invents a santim on **2,000 of
 * the first 19,999 amounts** — one in ten. Deriving the second share as the
 * remainder makes `shop + telga === commission` an identity rather than
 * something a test has to keep catching, which is what §13's append-only
 * double-entry ledger needs: a split that does not sum is money created or
 * destroyed at the point of sale.
 *
 * The shop is rounded first and Telga takes the remainder, deliberately. When
 * a half-santim has to fall somewhere it falls to the shop.
 *
 * ## What is confirmed and what is not
 *
 * The **split** (70/30) and Telga's **default rate** (3%) are founder
 * decisions and live here. A **provider's actual commission rate is not**:
 * the policy says *"do not assume every Ethiopian operator provides 3%"*, and
 * §30 forbids inventing a provider term. So the rate is always passed in, from
 * a per-provider, per-product setting an administrator configured — never
 * defaulted silently inside a calculation.
 */

import { InvalidProfitRateError } from './commission';

/** Basis points in one whole. 10,000 bps = 100%. */
const BPS_PER_WHOLE = 10_000;

/**
 * Telga's default commission rate, in basis points. 300 bps = 3%.
 *
 * A **default for the configuration screen**, not a fallback for a
 * calculation. Nothing computes money from this without an administrator
 * having seen it.
 */
export const DEFAULT_GLOBAL_COMMISSION_BPS = 300;

/** The shop's share of a provider commission. 7,000 bps = 70%. */
export const SHOP_COMMISSION_SHARE_BPS = 7_000;

/** Telga's share. Stated for documentation; the value used is the remainder. */
export const TELGA_COMMISSION_SHARE_BPS = BPS_PER_WHOLE - SHOP_COMMISSION_SHARE_BPS;

/** Policy bounds on any configurable rate: 0% to 100%. */
export const MIN_COMMISSION_BPS = 0;
export const MAX_COMMISSION_BPS = BPS_PER_WHOLE;

export interface CommissionSplit {
  /** What the provider pays on this sale, in minor units. */
  readonly providerCommissionMinor: number;
  /** The shop's share. Rounded. */
  readonly shopShareMinor: number;
  /** Telga's share. The remainder, so the two always sum. */
  readonly telgaShareMinor: number;
  /** The rate used, recorded so a past sale can be explained later. */
  readonly providerCommissionBps: number;
  /** The share used, recorded for the same reason. */
  readonly shopShareBps: number;
}

const assertBps = (bps: number): void => {
  if (!Number.isSafeInteger(bps) || bps < MIN_COMMISSION_BPS || bps > MAX_COMMISSION_BPS) {
    throw new InvalidProfitRateError(bps);
  }
};

/**
 * Split a sale's provider commission between the shop and Telga.
 *
 * `providerCommissionBps` has no default on purpose — see the note above. A
 * caller that does not know the provider's rate must not be able to get a
 * plausible number out of this function.
 *
 * A negative or non-integer amount yields a zero split rather than throwing:
 * money that was never taken produces no commission, and a sale is not the
 * place to discover a type error.
 */
export function splitCommission(
  transactionAmountMinor: number,
  providerCommissionBps: number,
  shopShareBps: number = SHOP_COMMISSION_SHARE_BPS,
): CommissionSplit {
  assertBps(providerCommissionBps);
  assertBps(shopShareBps);

  if (!Number.isSafeInteger(transactionAmountMinor) || transactionAmountMinor <= 0) {
    return {
      providerCommissionMinor: 0,
      shopShareMinor: 0,
      telgaShareMinor: 0,
      providerCommissionBps,
      shopShareBps,
    };
  }

  const providerCommissionMinor = Math.round(
    (transactionAmountMinor * providerCommissionBps) / BPS_PER_WHOLE,
  );
  const shopShareMinor = Math.round((providerCommissionMinor * shopShareBps) / BPS_PER_WHOLE);

  return {
    providerCommissionMinor,
    shopShareMinor,
    // Subtracted, never computed. This is the line that makes the split sum.
    telgaShareMinor: providerCommissionMinor - shopShareMinor,
    providerCommissionBps,
    shopShareBps,
  };
}

/**
 * Parse a stored basis-point setting, refusing anything outside the bounds.
 *
 * **An empty string is absence, not zero.** `Number('')` is `0` — a safe
 * integer, inside the bounds, and therefore accepted by every check below. A
 * blank or whitespace-only setting would have configured a 0% commission rate
 * and paid every shop nothing, with no error anywhere. `profitBpsFrom` in
 * `commission.ts` had the same hole and is corrected alongside this.
 *
 * A stored `'0'` is still taken, because a provider that pays nothing on a
 * product is a real commercial fact.
 */
export function commissionBpsFrom(stored: string | undefined, fallback: number): number {
  if (stored === undefined || stored.trim() === '') return fallback;
  const parsed = Number(stored);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_COMMISSION_BPS || parsed > MAX_COMMISSION_BPS) {
    return fallback;
  }
  return parsed;
}
