/**
 * The month-end software fee run.
 *
 * Founder instruction, 2026-09-14: *"1250 fee must [be charged] every month
 * end regardless of whether Telga [hardware] was bought by the shop owner or
 * Telga provided."*
 *
 * ## "Regardless" is the whole rule, so there is no exemption clause
 *
 * Every `ACTIVE` shop is charged. Not shops with Telga hardware, not shops
 * above a volume, not shops past a trial — the founder's word was
 * *regardless*, and a condition added here would be a commercial term nobody
 * agreed (section 30).
 *
 * A **suspended** shop is not charged, and that is not an exemption: a
 * suspended shop cannot trade, so charging it for software it cannot use would
 * drain a balance the shop cannot replenish or spend.
 *
 * ## Arrears are retried, because a debt that is never collected is not a debt
 *
 * The run does two things in order: it charges the period that just ended, and
 * it retries every earlier month a shop could not pay. Oldest first, so a shop
 * that falls behind clears its debt in the order it was incurred rather than
 * having the newest month taken while an older one ages indefinitely.
 *
 * ## It is safe to run twice
 *
 * Deliberately, because it will be. A worker restart, a cron that fires on two
 * instances, an administrator running it by hand after it already ran — each
 * of those is ordinary. `chargeSoftwareFee` finds the existing row and returns
 * `ALREADY_CHARGED` having moved nothing.
 */

import { chargeSoftwareFee, periodOf } from '@telga/persistence';
import type { SqliteLedgerDriver } from '@telga/persistence';
import type { MerchantId, Timestamp } from '@telga/domain';

export interface SoftwareFeeRunResult {
  readonly period: string;
  readonly charged: number;
  readonly chargedMinor: number;
  readonly arrears: number;
  readonly arrearsMinor: number;
  readonly alreadyCharged: number;
  /** Older months recovered in this run, counted separately from the period's own. */
  readonly recovered: number;
  readonly recoveredMinor: number;
}

export interface SoftwareFeeRunDeps {
  readonly driver: SqliteLedgerDriver;
  readonly now: () => Timestamp;
  readonly newId: (prefix: string) => string;
}

/**
 * Charge every active shop for a period, then retry what is owed from before.
 *
 * `period` defaults to the month containing `now`. Passing it explicitly is
 * what lets a missed month be run later — a month-end job that did not fire is
 * recovered by naming the month, not by pretending it is still that month.
 */
export function runSoftwareFeeCharges(
  deps: SoftwareFeeRunDeps,
  period?: string,
): SoftwareFeeRunResult {
  const at = deps.now();
  const forPeriod = period ?? periodOf(at);
  const fees = deps.driver.readPlatformFeeSettings();

  const result = {
    period: forPeriod,
    charged: 0,
    chargedMinor: 0,
    arrears: 0,
    arrearsMinor: 0,
    alreadyCharged: 0,
    recovered: 0,
    recoveredMinor: 0,
  };

  // The switch exists so a fee that is charging wrongly can be stopped without
  // a deployment. Off means nothing is charged and nothing is recorded as due:
  // a month the fee was switched off is a month it was not owed.
  if (!fees.softwareFeeEnabled) return result;

  const amountMinor = fees.softwareFeeMinor;
  if (amountMinor <= 0) return result;

  // --- the period that just ended -------------------------------------------
  for (const merchantId of deps.driver.activeMerchantIds()) {
    const outcome = chargeSoftwareFee(deps.driver, {
      id: deps.newId('sfee'),
      merchantId,
      period: forPeriod,
      amountMinor,
      postingId: deps.newId('post') as never,
      at,
    });

    if (outcome.kind === 'CHARGED') {
      result.charged += 1;
      result.chargedMinor += outcome.amountMinor;
    } else if (outcome.kind === 'ARREARS') {
      result.arrears += 1;
      result.arrearsMinor += outcome.amountMinor;
    } else {
      result.alreadyCharged += 1;
    }
  }

  // --- what was owed from before --------------------------------------------
  //
  // Read after the charging loop, so a shop that just fell into arrears this
  // period is not immediately retried with the same balance that failed a
  // moment ago.
  for (const owed of deps.driver.outstandingSoftwareFees()) {
    if (owed.period === forPeriod) continue;

    const outcome = chargeSoftwareFee(deps.driver, {
      id: owed.id,
      merchantId: owed.merchantId as MerchantId,
      period: owed.period,
      amountMinor: owed.amountMinor,
      postingId: deps.newId('post') as never,
      at,
    });

    if (outcome.kind === 'CHARGED') {
      result.recovered += 1;
      result.recoveredMinor += outcome.amountMinor;
    }
  }

  return result;
}

/**
 * The month before the one containing `at`.
 *
 * The fee is for a month that has **finished**. Charging on the last evening of
 * a month and charging on the first morning of the next are a few hours apart
 * and only one of them is defensible: a shop is billed for software it has
 * already had, not for a month still running. It also removes the question of
 * what "month end" means on a server whose clock is UTC and whose shops are in
 * Addis Ababa — the answer is that September's fee is taken once September is
 * unambiguously over, everywhere.
 */
export function previousPeriod(at: Timestamp | string): string {
  const [year, month] = periodOf(at).split('-').map(Number);
  const previous = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
  return `${String(previous.y)}-${String(previous.m).padStart(2, '0')}`;
}

/**
 * Charge whatever is due, and nothing that is not.
 *
 * Safe to call on **every** worker sweep, which is how it is wired: the charge
 * is idempotent per shop per month, so the first sweep after a month ends does
 * the work and every sweep after that finds the rows already there and moves
 * nothing.
 *
 * That is deliberately simpler than a cron entry. A cron that does not fire is
 * a month nobody is charged for and nothing that notices; this recovers on its
 * own the next time the worker runs at all, whether that is an hour later or a
 * week.
 */
export function runDueSoftwareFees(deps: SoftwareFeeRunDeps): SoftwareFeeRunResult {
  return runSoftwareFeeCharges(deps, previousPeriod(deps.now()));
}
