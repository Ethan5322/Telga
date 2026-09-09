/**
 * When a merchant may ask for a sale to be reversed.
 *
 * `CLAUDE.md` §17.1 and §14.1. These pin the four decisions that would be
 * expensive to get wrong, each of which costs somebody real money in one
 * direction or the other:
 *
 *   1. **A redeemed token is never reversible.** The customer has the value;
 *      returning the merchant's money too would pay for it twice.
 *   2. **An unknown redemption is neither refused nor settled.** §17 forbids
 *      auto-refunding an unknown outcome — and refusing one would lose an
 *      honest merchant a real claim.
 *   3. **`FAILED` is not reversible.** The reservation was released, so the
 *      money never left. Reversing it would credit a second time.
 *   4. **The fee is zero.** §19: *"No ordinary fee for … normally reversed
 *      requests."* The mechanism exists; using it needs a founder decision.
 */

import { describe, expect, it } from 'vitest';
import {
  REVERSIBLE_FROM,
  TRAINING_REVERSAL_POLICY,
  decideReversal,
  feeFor,
} from '@telga/domain';
import type { ReversalPolicy, ReversalRequest, TokenRedemption } from '@telga/domain';
import type { TransactionState } from '@telga/domain';

const SOLD = '2026-09-09T10:00:00.000Z';
const NOW = '2026-09-09T11:00:00.000Z';

const request = (over: Partial<ReversalRequest> = {}): ReversalRequest => ({
  state: 'SUCCESSFUL',
  amountMinor: 5000,
  soldAt: SOLD,
  now: NOW,
  redemption: 'UNREDEEMED',
  alreadyRequested: false,
  ...over,
});

const decide = (over: Partial<ReversalRequest> = {}, policy: ReversalPolicy = TRAINING_REVERSAL_POLICY) =>
  decideReversal(request(over), policy);

describe('the founder’s case: a token handed back unused', () => {
  it('accepts a SUCCESSFUL sale whose token was never redeemed', () => {
    // §14.1's one transition out of SUCCESSFUL. The sale succeeded because a
    // token was issued; no value reached anybody.
    const decision = decide();
    expect(decision.outcome).toBe('ACCEPTED_FOR_REVIEW');
    expect(decision.returnableMinor).toBe(5000);
  });

  it('refuses once the customer has redeemed it', () => {
    const decision = decide({ redemption: 'REDEEMED' });
    expect(decision.outcome).toBe('REFUSED');
    expect(decision.refusal).toBe('TOKEN_ALREADY_REDEEMED');
    // Nothing returnable is offered, so a caller cannot render an amount next
    // to a refusal and imply it is coming.
    expect(decision.returnableMinor).toBe(0);
  });

  it('sends an unreadable redemption to a person rather than deciding', () => {
    // §17: never auto-refund an unknown outcome. Refusing it would be just as
    // wrong — an honest merchant would lose a real claim to a lookup failure.
    const decision = decide({ redemption: 'UNKNOWN' });
    expect(decision.outcome).toBe('ACCEPTED_NEEDS_APPROVAL');
    expect(decision.needsRedemptionCheck).toBe(true);
    expect(decision.refusal).toBeUndefined();
  });

  it('checks redemption before the window, so the reason given is the real one', () => {
    // A redeemed token is a permanent answer; an expired window is a timing
    // one. Told "too late", a merchant would reasonably ask to be let through.
    const decision = decide({ redemption: 'REDEEMED', now: '2026-09-30T10:00:00.000Z' });
    expect(decision.refusal).toBe('TOKEN_ALREADY_REDEEMED');
  });
});

describe('states that may and may not be reversed', () => {
  it('allows the four the state machine permits', () => {
    expect([...REVERSIBLE_FROM].sort()).toEqual(
      ['PENDING', 'REVERSAL_REQUIRED', 'SUCCESSFUL', 'UNDER_REVIEW'].sort(),
    );
  });

  it('refuses FAILED and REJECTED, where the money never left', () => {
    // The reservation was released. Reversing would post a second credit for a
    // sale that already returned the funds.
    for (const state of ['FAILED', 'REJECTED'] as TransactionState[]) {
      const decision = decide({ state });
      expect(decision.outcome, `${state} must not be reversible`).toBe('REFUSED');
      expect(decision.refusal).toBe('NOT_A_REVERSIBLE_STATE');
    }
  });

  it('refuses one that is already reversed, and says so plainly', () => {
    // Named distinctly so a merchant stops filing rather than trying again.
    const decision = decide({ state: 'REVERSED' });
    expect(decision.refusal).toBe('ALREADY_REVERSED');
  });

  it('refuses a second request while one is open', () => {
    expect(decide({ alreadyRequested: true }).refusal).toBe('REVERSAL_ALREADY_REQUESTED');
  });

  it('lets an existing REVERSAL_REQUIRED through, so a duplicate is idempotent', () => {
    // Already in the state the request produces. Refusing here would make a
    // retry look like a failure when the request had in fact landed.
    const decision = decide({ state: 'REVERSAL_REQUIRED', alreadyRequested: true });
    expect(decision.outcome).not.toBe('REFUSED');
  });
});

describe('the window', () => {
  it('accepts inside it and refuses outside it', () => {
    expect(decide({ now: '2026-09-10T09:59:00.000Z' }).outcome).not.toBe('REFUSED');
    expect(decide({ now: '2026-09-10T10:00:01.000Z' }).refusal).toBe('OUTSIDE_REVERSAL_WINDOW');
  });

  it('treats an unreadable timestamp as outside, not inside', () => {
    // The safe direction: a refusal a person can override, never a settlement
    // nobody meant.
    expect(decide({ soldAt: 'not-a-date' }).refusal).toBe('OUTSIDE_REVERSAL_WINDOW');
  });
});

describe('the fee is zero, and §19 is why', () => {
  it('withholds nothing under the training policy', () => {
    expect(TRAINING_REVERSAL_POLICY.feeBasisPoints).toBe(0);
    const decision = decide({ amountMinor: 10_000 });
    expect(decision.feeMinor).toBe(0);
    expect(decision.returnableMinor).toBe(10_000);
  });

  it('computes one correctly if a founder decision ever sets it', () => {
    // The mechanism is built and tested so that turning it on is a decision
    // rather than a development task. 100bp = 1%.
    const withFee: ReversalPolicy = { ...TRAINING_REVERSAL_POLICY, feeBasisPoints: 100 };
    const decision = decideReversal(request({ amountMinor: 10_000 }), withFee);
    expect(decision.feeMinor).toBe(100);
    expect(decision.returnableMinor).toBe(9_900);
  });

  it('rounds a fee down, so rounding never costs the merchant', () => {
    // 5001 * 1% = 50.01 minor units. The merchant keeps the fraction.
    expect(feeFor(5001, 100)).toBe(50);
    expect(feeFor(1, 100)).toBe(0);
  });

  it('never turns a fee into a negative return', () => {
    expect(feeFor(5000, -100)).toBe(0);
  });
});

describe('the approval threshold', () => {
  it('sends a large reversal for approval even when everything else is clean', () => {
    const decision = decide({
      amountMinor: TRAINING_REVERSAL_POLICY.approvalThresholdMinor + 1,
    });
    expect(decision.outcome).toBe('ACCEPTED_NEEDS_APPROVAL');
  });

  it('lets one exactly at the threshold through', () => {
    // `>` not `>=`: the threshold is the largest amount that does not need a
    // second pair of eyes, which is how a limit is normally read.
    const decision = decide({ amountMinor: TRAINING_REVERSAL_POLICY.approvalThresholdMinor });
    expect(decision.outcome).toBe('ACCEPTED_FOR_REVIEW');
  });
});

describe('the policy states its own numbers rather than defaulting', () => {
  it('has no default export a caller could pick up by accident', () => {
    // Every field is required and there is no default policy object: a default
    // window or fee is an invented commercial term, and §30 forbids those.
    const policy: ReversalPolicy = TRAINING_REVERSAL_POLICY;
    expect(policy.windowMs).toBeGreaterThan(0);
    expect(policy.approvalThresholdMinor).toBeGreaterThan(0);
    expect(Object.isFrozen(TRAINING_REVERSAL_POLICY)).toBe(true);
  });

  it('treats every redemption value explicitly', () => {
    const seen = new Set<string>();
    for (const redemption of ['REDEEMED', 'UNREDEEMED', 'UNKNOWN'] as TokenRedemption[]) {
      seen.add(decide({ redemption }).outcome);
    }
    // Three inputs, three distinct handlings — none falls through to another.
    expect(seen.size).toBe(3);
  });
});
