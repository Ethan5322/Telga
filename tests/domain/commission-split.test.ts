/**
 * The commission split — founder fee policy, 2026-09-14.
 *
 * The policy replaced a one-step model (a percentage of the whole sale) with a
 * two-step one (a percentage of the *provider's commission*). These tests hold
 * the two properties that make it safe to post to an append-only ledger:
 *
 *   1. The two shares always sum to the provider commission. No sale creates
 *      or destroys a santim.
 *   2. Nothing produces a commission figure without being told the provider's
 *      rate, because §30 forbids inventing a provider term.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GLOBAL_COMMISSION_BPS,
  InvalidProfitRateError,
  SHOP_COMMISSION_SHARE_BPS,
  TELGA_COMMISSION_SHARE_BPS,
  commissionBpsFrom,
  splitCommission,
} from '@telga/domain';

describe('the two-step calculation', () => {
  it('takes the shop’s share of the commission, not of the sale', () => {
    // 100 birr at a 3% provider rate: commission 3.00, shop 2.10, Telga 0.90.
    const split = splitCommission(10_000, 300);
    expect(split.providerCommissionMinor).toBe(300);
    expect(split.shopShareMinor).toBe(210);
    expect(split.telgaShareMinor).toBe(90);
  });

  it('is not the model it replaced', () => {
    // The training model paid 4% of face value — 4.00 on the same sale. The
    // difference is the whole point of the policy, so it is asserted rather
    // than left to be rediscovered as a regression.
    expect(splitCommission(10_000, 300).shopShareMinor).not.toBe(400);
  });

  it('splits 70/30 by the constants it publishes', () => {
    expect(SHOP_COMMISSION_SHARE_BPS + TELGA_COMMISSION_SHARE_BPS).toBe(10_000);
    const split = splitCommission(100_000, DEFAULT_GLOBAL_COMMISSION_BPS);
    expect(split.shopShareMinor).toBe(2_100);
    expect(split.telgaShareMinor).toBe(900);
  });
});

describe('money is conserved', () => {
  it('sums for every amount from 1 santim to 200 birr, at every plausible rate', () => {
    // The sweep that motivated deriving Telga's share: rounding both shares
    // independently loses or invents a santim on ~1 amount in 10.
    const offenders: string[] = [];
    for (let bps = 50; bps <= 1_000; bps += 25) {
      for (let amount = 1; amount <= 20_000; amount += 1) {
        const s = splitCommission(amount, bps);
        if (s.shopShareMinor + s.telgaShareMinor !== s.providerCommissionMinor) {
          offenders.push(`${String(amount)}@${String(bps)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never gives either side a negative share', () => {
    for (let amount = 1; amount <= 5_000; amount += 1) {
      const s = splitCommission(amount, 300);
      expect(s.shopShareMinor).toBeGreaterThanOrEqual(0);
      expect(s.telgaShareMinor).toBeGreaterThanOrEqual(0);
    }
  });

  it('gives the half-santim to the shop', () => {
    // 50 santim commission, split 70/30, is 35 exactly — so reach for a case
    // that genuinely rounds: commission 3 santim, shop 2.1 → 2, Telga 1.
    const s = splitCommission(100, 300);
    expect(s.providerCommissionMinor).toBe(3);
    expect(s.shopShareMinor).toBe(2);
    expect(s.telgaShareMinor).toBe(1);
  });
});

describe('a rate is never invented', () => {
  it('has no default for the provider rate', () => {
    // A caller that omits it does not get a plausible number — it does not
    // compile, and at runtime an undefined rate throws rather than defaulting.
    expect(() => splitCommission(10_000, undefined as unknown as number)).toThrow(
      InvalidProfitRateError,
    );
  });

  it('refuses a rate outside 0–100%', () => {
    expect(() => splitCommission(10_000, -1)).toThrow(InvalidProfitRateError);
    expect(() => splitCommission(10_000, 10_001)).toThrow(InvalidProfitRateError);
    expect(() => splitCommission(10_000, 12.5)).toThrow(InvalidProfitRateError);
  });

  it('refuses a share outside 0–100%', () => {
    expect(() => splitCommission(10_000, 300, 10_001)).toThrow(InvalidProfitRateError);
  });

  it('allows a zero rate, which is a real answer', () => {
    // A provider that pays nothing on a product is a commercial fact, not an
    // error. It must be expressible, or somebody will record 1 bps instead.
    const s = splitCommission(10_000, 0);
    expect(s.providerCommissionMinor).toBe(0);
    expect(s.shopShareMinor).toBe(0);
    expect(s.telgaShareMinor).toBe(0);
  });
});

describe('amounts that are not sales', () => {
  it('yields nothing for zero, negative and non-integer amounts', () => {
    for (const amount of [0, -1, -10_000, 12.5, Number.NaN]) {
      const s = splitCommission(amount, 300);
      expect(s.providerCommissionMinor).toBe(0);
      expect(s.shopShareMinor).toBe(0);
      expect(s.telgaShareMinor).toBe(0);
    }
  });
});

describe('the split records what produced it', () => {
  it('carries the rate and share used, so a past sale can be explained', () => {
    const s = splitCommission(10_000, 275, 6_500);
    expect(s.providerCommissionBps).toBe(275);
    expect(s.shopShareBps).toBe(6_500);
  });
});

describe('reading a stored setting', () => {
  it('takes a valid stored value', () => {
    expect(commissionBpsFrom('450', DEFAULT_GLOBAL_COMMISSION_BPS)).toBe(450);
  });

  it('falls back rather than trusting a corrupt one', () => {
    for (const stored of ['', 'abc', '-1', '10001', '2.5']) {
      expect(commissionBpsFrom(stored, DEFAULT_GLOBAL_COMMISSION_BPS)).toBe(
        DEFAULT_GLOBAL_COMMISSION_BPS,
      );
    }
  });

  it('takes a stored zero, which is not absence', () => {
    expect(commissionBpsFrom('0', DEFAULT_GLOBAL_COMMISSION_BPS)).toBe(0);
  });
});
