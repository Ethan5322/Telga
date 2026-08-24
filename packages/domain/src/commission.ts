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
