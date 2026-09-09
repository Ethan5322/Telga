/**
 * When a merchant may ask for a sale to be reversed, and what it is worth.
 *
 * `CLAUDE.md` §17.1. This module decides **whether a request may be filed** and
 * **how much would come back**. It does not move money and cannot: completing a
 * reversal is a supervisor's act in `services/api/src/application/reversal.ts`,
 * and keeping the two apart is the point.
 *
 * ## The founder's case
 *
 * A customer is handed an airtime or data token, cannot use it, and hands it
 * back. The sale is `SUCCESSFUL` — Telga issued a token — and yet no value has
 * reached anybody. §14.1 adds the one transition out of `SUCCESSFUL` for
 * exactly this, gated on the token being **proven** unredeemed.
 *
 * ## What this module refuses to guess
 *
 * Redemption. If the caller cannot say whether the token was used, the answer
 * is `UNKNOWN` and the request goes to review. It never defaults to "unused"
 * — that would let a merchant reclaim money for value a customer already spent
 * — and never to "used", which would refuse an honest merchant.
 */

import type { TransactionState } from './states';

/**
 * Whether the value has reached the customer.
 *
 * Three states, not two. `UNKNOWN` is the one that matters: §17 forbids
 * auto-refunding an unknown outcome, so a redemption Telga cannot read is a
 * reason to involve a person, not a reason to decide.
 */
export type TokenRedemption = 'REDEEMED' | 'UNREDEEMED' | 'UNKNOWN';

/**
 * How a reversal request may be answered.
 *
 * `ACCEPTED_FOR_REVIEW` rather than `APPROVED`: nothing this module returns
 * moves a birr. It says the request is well-formed and a supervisor should look.
 */
export type ReversalRequestOutcome =
  | 'ACCEPTED_FOR_REVIEW'
  /** Above the configured threshold. Still filed; simply cannot be auto-approved. */
  | 'ACCEPTED_NEEDS_APPROVAL'
  | 'REFUSED';

export type ReversalRefusal =
  /** Already reversed. Saying so plainly stops a merchant filing again. */
  | 'ALREADY_REVERSED'
  /** `FAILED` and `REJECTED` land here: nothing was taken, so nothing returns. */
  | 'NOT_A_REVERSIBLE_STATE'
  /** The customer has the value. §17: wrong details and misuse need evidence. */
  | 'TOKEN_ALREADY_REDEEMED'
  /** Past the window. A number, not a judgement — see {@link ReversalPolicy}. */
  | 'OUTSIDE_REVERSAL_WINDOW'
  /** A request is already open. Filing twice does not make it move faster. */
  | 'REVERSAL_ALREADY_REQUESTED';

/**
 * The tunable parts, all of which are **NOT YET CONFIRMED** commercially.
 *
 * Every field is required. There is no default object and there deliberately
 * cannot be one: a default window or a default fee is an invented commercial
 * term, and §30 forbids inventing those. A caller must state what it is using,
 * which means the number is visible in configuration rather than buried here.
 */
export interface ReversalPolicy {
  /**
   * How long after a sale a merchant may still ask.
   *
   * A window exists so a shop cannot reclaim last month's takings on a token
   * nobody can now check. Its length is a commercial and operational decision.
   */
  readonly windowMs: number;
  /**
   * Above this, a supervisor must approve before settlement even if everything
   * else checks out. Minor units.
   */
  readonly approvalThresholdMinor: number;
  /**
   * Basis points withheld from a reversal. **Must be 0 unless a founder
   * decision says otherwise.**
   *
   * §19: *"No ordinary fee for blocked, rejected, failed, pending, duplicate,
   * or normally reversed requests."* The field exists so the mechanism is
   * built and tested; using it contradicts §19 and needs a recorded decision.
   */
  readonly feeBasisPoints: number;
}

export interface ReversalRequest {
  readonly state: TransactionState;
  readonly amountMinor: number;
  readonly soldAt: string;
  readonly now: string;
  readonly redemption: TokenRedemption;
  /** True when a request is already open for this transaction. */
  readonly alreadyRequested: boolean;
}

export interface ReversalDecision {
  readonly outcome: ReversalRequestOutcome;
  readonly refusal?: ReversalRefusal;
  /** What would return to the merchant, after any configured fee. */
  readonly returnableMinor: number;
  /** What the fee would withhold. Zero unless a fee is configured. */
  readonly feeMinor: number;
  /**
   * True when redemption could not be read and a person must look.
   *
   * Separate from the outcome because such a request **is** accepted — it is
   * accepted *into review* rather than refused. §17: never auto-refund an
   * unknown outcome, and never reject one either.
   */
  readonly needsRedemptionCheck: boolean;
}

/**
 * States a reversal may be requested from.
 *
 * `SUCCESSFUL` is here only because §14.1 added it, and only ever reaches
 * settlement with `UNREDEEMED`. `PENDING` and `UNDER_REVIEW` were always
 * reversible — value may have been taken and not delivered.
 *
 * `FAILED` and `REJECTED` are absent on purpose: the reservation was released,
 * so the money never left. A merchant asking to reverse a failed sale has
 * misread their balance, and the refusal should say so rather than silently
 * succeed and post a second credit.
 */
export const REVERSIBLE_FROM: readonly TransactionState[] = Object.freeze([
  'SUCCESSFUL',
  'PENDING',
  'UNDER_REVIEW',
  'REVERSAL_REQUIRED',
]);

/** Withheld amount, rounded **down**, so rounding never costs the merchant. */
export const feeFor = (amountMinor: number, basisPoints: number): number =>
  basisPoints <= 0 ? 0 : Math.floor((amountMinor * basisPoints) / 10_000);

/**
 * May this reversal be requested, and for how much?
 *
 * Order matters and is not arbitrary. Cheap, certain refusals come first, so a
 * merchant learns the real reason: telling somebody their request is "outside
 * the window" when it was already reversed sends them to look at the wrong
 * thing.
 */
export function decideReversal(
  request: ReversalRequest,
  policy: ReversalPolicy,
): ReversalDecision {
  const feeMinor = feeFor(request.amountMinor, policy.feeBasisPoints);
  const returnableMinor = request.amountMinor - feeMinor;
  const refuse = (refusal: ReversalRefusal): ReversalDecision => ({
    outcome: 'REFUSED',
    refusal,
    returnableMinor: 0,
    feeMinor: 0,
    needsRedemptionCheck: false,
  });

  if (request.state === 'REVERSED') return refuse('ALREADY_REVERSED');
  if (!REVERSIBLE_FROM.includes(request.state)) return refuse('NOT_A_REVERSIBLE_STATE');
  if (request.alreadyRequested && request.state !== 'REVERSAL_REQUIRED') {
    return refuse('REVERSAL_ALREADY_REQUESTED');
  }

  // The customer has the value. Checked before the window, because a redeemed
  // token is a permanent answer and an expired window is a timing one — and a
  // merchant told "too late" would reasonably ask to be let through just once.
  if (request.redemption === 'REDEEMED') return refuse('TOKEN_ALREADY_REDEEMED');

  const elapsed = Date.parse(request.now) - Date.parse(request.soldAt);
  // An unparseable timestamp is treated as outside the window rather than
  // inside it. The safe direction: a refusal a person can override, not a
  // settlement nobody meant.
  if (!Number.isFinite(elapsed) || elapsed > policy.windowMs) {
    return refuse('OUTSIDE_REVERSAL_WINDOW');
  }

  const needsRedemptionCheck = request.redemption === 'UNKNOWN';
  // Above the threshold, or unreadable redemption — either way a person looks.
  const needsApproval =
    needsRedemptionCheck || request.amountMinor > policy.approvalThresholdMinor;

  return {
    outcome: needsApproval ? 'ACCEPTED_NEEDS_APPROVAL' : 'ACCEPTED_FOR_REVIEW',
    returnableMinor,
    feeMinor,
    needsRedemptionCheck,
  };
}

/**
 * The training policy.
 *
 * **Not a commercial term.** A 24-hour window and a 1,000-birr threshold are
 * placeholders for a training deployment, recorded in `ASSUMPTIONS` as
 * NOT YET CONFIRMED. The fee is **zero**, which is what §19 requires; changing
 * it needs a founder decision, not an edit here.
 */
export const TRAINING_REVERSAL_POLICY: ReversalPolicy = Object.freeze({
  windowMs: 24 * 60 * 60 * 1000,
  approvalThresholdMinor: 100_000,
  feeBasisPoints: 0,
});
