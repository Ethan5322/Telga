/**
 * Funding submissions — a shop claims it paid money in, and Telga decides.
 *
 * This is `05 Operations/Funding Verification` expressed as code: the status
 * flow, and the decision that moves a claim through it.
 *
 * ## The rule this module exists to enforce
 *
 * CLAUDE.md says it twice, in these words:
 *
 * > L128 — *"Never credit a balance from a screenshot alone."*
 * > L402 — *"No overdraft. No personal account. **No screenshot-only credit.**"*
 *
 * The founder's interim design is a shop photographing a CBE slip and sending it
 * on WhatsApp. That is a perfectly good way to **raise a claim**; it is not
 * evidence. A slip can be edited in a minute, sent twice, sent by two people, or
 * be a genuine slip for a deposit into somebody else's account, and a person
 * comparing it against nothing cannot tell which.
 *
 * So the rule is enforced structurally rather than by convention:
 * {@link verifyDeposit} takes the bank record as an input and **every path that
 * returns a credit reads the amount from it**. There is no branch in which a
 * claim alone produces value, and no argument that could be passed to make one.
 * The photograph is never an input to this function at all.
 *
 * ## What is deliberately not here
 *
 * No I/O, no database, no HTTP, no mode check. Looking a transaction up at the
 * bank belongs to a rail adapter (`09 Engineering/Deposit Rail Options`), and
 * refusing a non-TRAINING mode belongs to the application layer, where
 * `application/deposits.ts` already does it before reading an amount.
 */

import type { MerchantId } from './ids';

// ---------------------------------------------------------------------------
// The status flow
// ---------------------------------------------------------------------------

/** The statuses in `Funding Verification`, transcribed. */
export type FundingStatus =
  | 'SUBMITTED'
  | 'AWAITING_VERIFICATION'
  | 'MATCHED'
  | 'CREDITED'
  | 'REJECTED'
  | 'DUPLICATE'
  | 'MANUAL_REVIEW';

/**
 * Where each status may go next.
 *
 * `CREDITED`, `REJECTED` and `DUPLICATE` are terminal and have no entry, which
 * is what stops a credited deposit being quietly re-opened and credited again.
 * A correction to a credited deposit is an **authorised adjustment entry**
 * (CLAUDE.md §13.8), never a status edit.
 */
const FUNDING_TRANSITIONS: Readonly<Record<FundingStatus, readonly FundingStatus[]>> = Object.freeze(
  {
    SUBMITTED: Object.freeze(['AWAITING_VERIFICATION', 'MANUAL_REVIEW'] as const),
    AWAITING_VERIFICATION: Object.freeze([
      'MATCHED',
      'REJECTED',
      'DUPLICATE',
      'MANUAL_REVIEW',
    ] as const),
    // A declined second approval sends it back to a human, never straight to a
    // rejection: somebody has money at the bank either way, and the question is
    // what happens to it rather than whether it exists.
    MATCHED: Object.freeze(['CREDITED', 'MANUAL_REVIEW'] as const),
    MANUAL_REVIEW: Object.freeze(['CREDITED', 'REJECTED', 'DUPLICATE'] as const),
    CREDITED: Object.freeze([] as const),
    REJECTED: Object.freeze([] as const),
    DUPLICATE: Object.freeze([] as const),
  },
);

export const TERMINAL_FUNDING_STATUSES: readonly FundingStatus[] = Object.freeze([
  'CREDITED',
  'REJECTED',
  'DUPLICATE',
]);

export const isTerminalFundingStatus = (status: FundingStatus): boolean =>
  TERMINAL_FUNDING_STATUSES.includes(status);

export const canTransitionFunding = (from: FundingStatus, to: FundingStatus): boolean =>
  FUNDING_TRANSITIONS[from].includes(to);

export class FundingTransitionError extends Error {
  readonly code = 'FUNDING_TRANSITION_REFUSED';
  constructor(
    readonly from: FundingStatus,
    readonly to: FundingStatus,
  ) {
    super(`A funding submission cannot move from ${from} to ${to}.`);
    this.name = 'FundingTransitionError';
  }
}

/** Throws rather than returning false, so a caller cannot ignore the answer. */
export function assertFundingTransition(from: FundingStatus, to: FundingStatus): void {
  if (!canTransitionFunding(from, to)) throw new FundingTransitionError(from, to);
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * What the bank says happened.
 *
 * Obtained from a rail — a statement feed, a wallet webhook, a transaction
 * lookup, or an operator reading internet banking. **Never from the shop.** The
 * shop supplies a reference to look up; it does not supply the answer.
 */
export interface BankRecord {
  /** The bank's own transaction reference. The idempotency key for the credit. */
  readonly bankReference: string;
  /** Integer minor units. What the bank actually received. */
  readonly amountMinor: number;
  /** The account the money landed in. Checked — a real slip for another account is not this deposit. */
  readonly creditedAccount: string;
}

/** What the shop asserts. Every field is untrusted. */
export interface DepositClaim {
  /** The shop's Deposit Reference Code, as written. Not a credential. */
  readonly depositReference: string;
  /** The bank transaction reference read off the slip. A lookup key, not proof. */
  readonly bankReference: string;
  /** Optional. Informational only — the bank's figure is the one credited. */
  readonly claimedAmountMinor?: number;
}

export interface VerificationInput {
  readonly claim: DepositClaim;
  /**
   * The bank's record of this transaction, or `undefined` when the bank has no
   * such transaction. **`undefined` can only produce a refusal.**
   */
  readonly bankRecord?: BankRecord;
  /** Which shop holds the quoted reference, or `undefined` when none does. */
  readonly merchantForReference?: MerchantId;
  /** True when this bank reference has already produced a credit. */
  readonly alreadyCredited: boolean;
  /** The account shops are told to pay into. */
  readonly expectedAccount: string;
  /**
   * Above this, a human approves. CLAUDE.md §20 already requires a second
   * approval for high-value deposits; this is where that threshold lives.
   */
  readonly autoCreditCapMinor: number;
}

export type FundingRejectReason =
  | 'NO_BANK_RECORD'
  | 'WRONG_ACCOUNT'
  | 'AMOUNT_NOT_POSITIVE'
  | 'BANK_REFERENCE_MISMATCH';

export type FundingReviewReason =
  | 'REFERENCE_UNREADABLE'
  | 'REFERENCE_NOT_ASSIGNED'
  | 'BANK_REFERENCE_MISSING';

/**
 * The outcome. A credit carries the amount **from the bank record**, never from
 * the claim, and the bank reference that makes it idempotent.
 */
export type VerificationDecision =
  | {
      readonly kind: 'CREDIT';
      readonly merchantId: MerchantId;
      readonly amountMinor: number;
      readonly bankReference: string;
      /** Set when the shop's figure disagreed with the bank's. Audit, not a block. */
      readonly claimedAmountDiffered?: true;
    }
  | {
      readonly kind: 'NEEDS_APPROVAL';
      readonly merchantId: MerchantId;
      readonly amountMinor: number;
      readonly bankReference: string;
    }
  | { readonly kind: 'DUPLICATE'; readonly bankReference: string }
  | { readonly kind: 'REJECT'; readonly reason: FundingRejectReason }
  | { readonly kind: 'MANUAL_REVIEW'; readonly reason: FundingReviewReason };

/**
 * Decide what happens to a claimed deposit.
 *
 * The order of the checks is the design. Identity is settled before money, and
 * the duplicate check runs before anything that could credit, so a replayed slip
 * cannot race a first-time one into a second posting.
 *
 * **An unresolvable reference is never rounded to the nearest shop.** It goes to
 * a person. Guessing which shop a deposit belongs to is how one shop is credited
 * with another's money, and no amount of string similarity makes that safe.
 */
export function verifyDeposit(input: VerificationInput): VerificationDecision {
  const { claim, bankRecord, merchantForReference } = input;

  // --- 1. Who is this for? -------------------------------------------------
  // Settled first: without a merchant there is nobody to credit, and every
  // later check would be work done for an unanswerable question.
  if (merchantForReference === undefined) {
    // The caller distinguishes "the code is malformed" from "the code is
    // well-formed but nobody holds it" — see `depositReferenceRejection`. Both
    // reach a person; they are different conversations with the shop.
    return {
      kind: 'MANUAL_REVIEW',
      reason:
        claim.depositReference.trim().length === 0
          ? 'REFERENCE_UNREADABLE'
          : 'REFERENCE_NOT_ASSIGNED',
    };
  }

  if (claim.bankReference.trim().length === 0) {
    return { kind: 'MANUAL_REVIEW', reason: 'BANK_REFERENCE_MISSING' };
  }

  // --- 2. Has this already been paid? --------------------------------------
  // Before the bank record is even consulted. The same slip photographed twice
  // produces two different images and one transaction, so the bank's reference
  // is the only thing that can make this idempotent.
  if (input.alreadyCredited) {
    return { kind: 'DUPLICATE', bankReference: claim.bankReference };
  }

  // --- 3. Did the bank actually receive it? --------------------------------
  // **This is the rule.** No bank record, no credit — and because the amount is
  // read from `bankRecord` below, there is no path from here to value.
  if (bankRecord === undefined) {
    return { kind: 'REJECT', reason: 'NO_BANK_RECORD' };
  }

  // A record fetched for a different transaction proves nothing about this one.
  if (bankRecord.bankReference !== claim.bankReference) {
    return { kind: 'REJECT', reason: 'BANK_REFERENCE_MISMATCH' };
  }

  // A genuine slip for a deposit into another account is still not this deposit.
  if (bankRecord.creditedAccount !== input.expectedAccount) {
    return { kind: 'REJECT', reason: 'WRONG_ACCOUNT' };
  }

  if (!Number.isSafeInteger(bankRecord.amountMinor) || bankRecord.amountMinor <= 0) {
    return { kind: 'REJECT', reason: 'AMOUNT_NOT_POSITIVE' };
  }

  // --- 4. How much, and who says so ----------------------------------------
  // The bank's figure, always. A shop that typed the wrong amount is credited
  // what it actually paid — which is right whichever way the two differ, and
  // means a mistyped claim is not an obstacle to a real deposit.
  const amountMinor = bankRecord.amountMinor;
  const claimedAmountDiffered =
    claim.claimedAmountMinor !== undefined && claim.claimedAmountMinor !== amountMinor;

  if (amountMinor > input.autoCreditCapMinor) {
    return {
      kind: 'NEEDS_APPROVAL',
      merchantId: merchantForReference,
      amountMinor,
      bankReference: bankRecord.bankReference,
    };
  }

  return {
    kind: 'CREDIT',
    merchantId: merchantForReference,
    amountMinor,
    bankReference: bankRecord.bankReference,
    ...(claimedAmountDiffered ? { claimedAmountDiffered: true as const } : {}),
  };
}

/** The status a decision produces, for the caller that persists it. */
export function statusAfterVerification(decision: VerificationDecision): FundingStatus {
  switch (decision.kind) {
    case 'CREDIT':
      return 'CREDITED';
    case 'NEEDS_APPROVAL':
      return 'MATCHED';
    case 'DUPLICATE':
      return 'DUPLICATE';
    case 'REJECT':
      return 'REJECTED';
    case 'MANUAL_REVIEW':
      return 'MANUAL_REVIEW';
  }
}
