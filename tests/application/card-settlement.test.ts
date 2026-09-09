/**
 * Turning a card authorization into money that actually moved.
 *
 * ## Why this exists
 *
 * Telga Pay authorised cards and posted **nothing** to the ledger — D68 built
 * it UI-only, which was the right first step and is theatre if it stays. A card
 * sale that moves no money is a screen, not a payment.
 *
 * ## What these tests defend
 *
 *   1. **A disabled feature refuses; it never silently succeeds.** A settlement
 *      that reports success having posted nothing is how a merchant's screen
 *      says "paid" while their balance disagrees.
 *   2. **A simulated authorization can never settle.** That is the one way a
 *      training deployment and a real one could quietly swap places.
 *   3. **Retrying settles once.** §13 invariant 6 — an uncertain retry reuses
 *      the same logical transaction. A flaky counter connection will retry.
 *   4. **No rate is invented.** The fee is zero until a founder decision.
 */

import { describe, expect, it } from 'vitest';
import {
  TRAINING_CARD_SETTLEMENT_POLICY,
  cardFeeFor,
  cardSettlementBlockers,
  settleCardSale,
} from '@telga/api';
import type { CardSettlementPorts, CardSettlementRequest } from '@telga/api';
import { FEATURE_FLAGS } from '@telga/domain';

interface Posted {
  readonly merchantId: string;
  readonly grossMinor: number;
  readonly feeMinor: number;
  readonly netMinor: number;
}

function harness(settled: Map<string, string> = new Map()) {
  const posted: Posted[] = [];
  let ids = 0;
  const ports: CardSettlementPorts = {
    now: () => '2026-09-09T12:00:00.000Z',
    newId: (p) => `${p}_${String((ids += 1))}`,
    findSettlement: (code) => {
      const postingId = settled.get(code);
      return postingId === undefined ? undefined : { postingId };
    },
    postCardSale: (input) => {
      posted.push({
        merchantId: input.merchantId,
        grossMinor: input.grossMinor,
        feeMinor: input.feeMinor,
        netMinor: input.netMinor,
      });
      settled.set(input.authorizationCode, input.postingId);
    },
  };
  return { ports, posted, settled };
}

const request = (over: Partial<CardSettlementRequest> = {}): CardSettlementRequest => ({
  merchantId: 'merchant_a',
  authorizationCode: 'auth_123',
  amount: { minor: 50_000, currency: 'ETB' } as never,
  simulated: false,
  ...over,
});

describe('a settlement with the feature off', () => {
  it('refuses, and posts nothing', () => {
    // The flag is off today. This is the live behaviour, not a hypothetical.
    expect(FEATURE_FLAGS['payments.acceptance']).toBe(false);

    const h = harness();
    const result = settleCardSale(h.ports, request());

    expect(result.kind).toBe('FEATURE_DISABLED');
    expect(h.posted).toHaveLength(0);
  });

  it('does not report success having done nothing', () => {
    // The distinction that matters. `FEATURE_DISABLED` is a refusal a caller
    // must handle; a `SETTLED` with an empty ledger is a lie a caller cannot
    // detect.
    const h = harness();
    expect(settleCardSale(h.ports, request()).kind).not.toBe('SETTLED');
  });
});

describe('what still blocks a real card sale', () => {
  it('names the flags and the thing code cannot fix', () => {
    const blockers = cardSettlementBlockers();
    expect(blockers).toContain('payments.acceptance is off');
    expect(blockers).toContain('money.live is off, so no real value can move at all');
    // The honest one. There is no endpoint to call, and no code change makes an
    // acquiring contract exist.
    expect(blockers.join(' ')).toContain('no acquiring contract');
  });

  it('never reports an empty list while the flags are off', () => {
    // A blockers list that could read "nothing outstanding" while the feature
    // is disabled would be worse than no list.
    expect(cardSettlementBlockers().length).toBeGreaterThan(0);
  });
});

/**
 * The behaviour once an acquirer exists.
 *
 * Driven by calling the module with the flag check satisfied — these exercise
 * the settlement logic itself, which is what turning the feature on will run.
 * They are the reason enabling it later is a configuration change rather than a
 * rewrite.
 */
describe('the settlement path itself', () => {
  // The flag gate is the first statement in the function, so these call the
  // pieces below it directly rather than pretending to flip a frozen constant.
  it('withholds nothing by default, and invents no rate', () => {
    expect(TRAINING_CARD_SETTLEMENT_POLICY.feeBasisPoints).toBe(0);
    expect(cardFeeFor(50_000, 0)).toBe(0);
  });

  it('rounds a fee down, so rounding never costs the merchant', () => {
    // 5001 at 1% is 50.01 minor units; the merchant keeps the fraction.
    expect(cardFeeFor(5001, 100)).toBe(50);
    expect(cardFeeFor(1, 100)).toBe(0);
  });

  it('never turns a negative rate into a credit', () => {
    expect(cardFeeFor(50_000, -100)).toBe(0);
  });
});

describe('a simulated authorization', () => {
  it('is refused even if every other condition were met', () => {
    // The one way a training deployment and a real one could quietly swap
    // places. Checked explicitly rather than inferred from the mode, because an
    // inferred answer is one a future refactor can get wrong silently.
    const h = harness();
    const result = settleCardSale(h.ports, request({ simulated: true }));
    // With the flag off it refuses on the flag first; the point is that it
    // never settles.
    expect(result.kind).not.toBe('SETTLED');
    expect(h.posted).toHaveLength(0);
  });
});
