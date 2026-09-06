/**
 * Commission and fee rules — placeholders only.
 *
 * No rate exists. Commission and fee rates come from a provider agreement that
 * has not been negotiated, let alone signed; its commercial terms are recorded
 * outside this repository. Rather than ship a plausible-looking default that
 * could reach a merchant, the compute functions **throw**.
 *
 * What *is* fixed regardless of rate, from `03 Domain/Ledger Invariants.md`:
 *   - A fee applies only to a successful completed sale.
 *   - No ordinary fee on blocked, rejected, failed, pending, duplicate or
 *     normally reversed requests.
 *   - The merchant display shows net commission; the ledger stores gross,
 *     fee, net and the rule version that produced them.
 */

import { CommissionRateNotConfiguredError, FeeNotChargeableError } from './errors';
import type { Money } from './money';
import type { TransactionState } from './states';

export type RuleStatus = 'NOT_YET_CONFIRMED' | 'CONFIRMED';

// --- training profit ---------------------------------------------------------
//
// Distinct from commission above, and deliberately so. The functions below
// compute a **training** profit for the simulated float; the commission
// functions still throw, because a real provider commission remains
// NOT YET CONFIRMED and inventing one would fabricate a commercial term.
//
// The model, confirmed against the original POS screenshots (Decision Log
// D69): the customer pays the face value, the merchant float drops by the
// face value, and a percentage of the face value is credited separately as
// profit. Profit is a **shop-side credit, never a surcharge** — it never
// changes what the customer hands over.

/** Training profit rate, in basis points. 400 bps = 4%. */
export const DEFAULT_TRAINING_PROFIT_BPS = 400;

export class InvalidProfitRateError extends Error {
  readonly code = 'INVALID_PROFIT_RATE';
  constructor(bps: number) {
    super(`Training profit rate must be between 0 and 10000 bps; received ${String(bps)}`);
    this.name = 'InvalidProfitRateError';
  }
}

/**
 * Profit on a face value, in minor units.
 *
 * Integer arithmetic throughout — `Math.round` on a minor-unit product, never
 * a float multiplication of a major-unit amount — so 4% of 10 birr is exactly
 * 40 santim rather than 39.99999. Ledger invariant 9: money is integer minor
 * units, never binary floating point.
 *
 * At 400 bps: 10 birr → 0.40, 25 → 1.00, 50 → 2.00, 100 → 4.00,
 * 400 → 16.00, 1000 → 40.00.
 */
export function trainingProfitMinor(
  faceValueMinor: number,
  bps: number = DEFAULT_TRAINING_PROFIT_BPS,
): number {
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) {
    throw new InvalidProfitRateError(bps);
  }
  if (!Number.isSafeInteger(faceValueMinor) || faceValueMinor < 0) return 0;
  return Math.round((faceValueMinor * bps) / 10_000);
}

/** Parse a stored `PROFIT_PERCENT_BPS` setting, falling back to the default. */
export function profitBpsFrom(stored: string | undefined): number {
  if (stored === undefined) return DEFAULT_TRAINING_PROFIT_BPS;
  const parsed = Number(stored);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 10_000) {
    return DEFAULT_TRAINING_PROFIT_BPS;
  }
  return parsed;
}

export interface CommissionRule {
  readonly version: string;
  readonly status: RuleStatus;
  /** Where a confirmed rate would come from. */
  readonly source: string;
}

export interface FeeRule {
  readonly version: string;
  readonly status: RuleStatus;
  readonly source: string;
}

export const UNCONFIRMED_COMMISSION_RULE: CommissionRule = Object.freeze({
  version: 'unconfirmed-0',
  status: 'NOT_YET_CONFIRMED',
  source: 'Provider agreement — commercial terms recorded outside this repository',
});

export const UNCONFIRMED_FEE_RULE: FeeRule = Object.freeze({
  version: 'unconfirmed-0',
  status: 'NOT_YET_CONFIRMED',
  source: 'Pilot pricing — commercial terms recorded outside this repository',
});

/** What the ledger records for a completed sale, once rates exist. */
export interface CommissionBreakdown {
  readonly gross: Money;
  readonly telgaFee: Money;
  readonly net: Money;
  readonly commissionRuleVersion: string;
  readonly feeRuleVersion: string;
}

/** Only a successful completed sale may carry an ordinary fee. */
export function isFeeChargeable(state: TransactionState): boolean {
  return state === 'SUCCESSFUL';
}

export function assertFeeChargeable(state: TransactionState): void {
  if (!isFeeChargeable(state)) {
    throw new FeeNotChargeableError(state);
  }
}

/**
 * Gross commission for a sale.
 *
 * Throws while the rule is unconfirmed. This is the intended behaviour: a
 * caller that needs a commission figure today has made an assumption that no
 * signed agreement supports.
 */
export function computeGrossCommission(rule: CommissionRule, _amount: Money): Money {
  if (rule.status !== 'CONFIRMED') {
    throw new CommissionRateNotConfiguredError('Gross commission');
  }
  throw new CommissionRateNotConfiguredError(
    'Gross commission: no calculation is implemented because no rate structure has been agreed',
  );
}

export function computeTelgaFee(rule: FeeRule, _amount: Money): Money {
  if (rule.status !== 'CONFIRMED') {
    throw new CommissionRateNotConfiguredError('Telga fee');
  }
  throw new CommissionRateNotConfiguredError(
    'Telga fee: no calculation is implemented because no rate structure has been agreed',
  );
}
