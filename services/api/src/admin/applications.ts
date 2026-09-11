/**
 * Shop registration: the lifecycle from a public form to a working device.
 *
 * ## The rule that shapes everything here
 *
 * **An applicant has no account, no credentials, no device and no database
 * until an admin approves** (Decision Log **D104**). So a submission cannot
 * write to `merchants` — there is nothing to write yet. It is its own record,
 * and approving one is what creates a shop.
 *
 * The alternative was creating a locked account immediately. Rejected: that
 * means real credentials exist for unvetted people, and every route then needs
 * a not-yet-approved guard where one missed guard is a way in. Nothing to
 * attack beats a guard that must never be forgotten.
 *
 * ## The reference an applicant gets back
 *
 * It is the only thing they receive, so it has to be unguessable. A sequential
 * number would let anyone enumerate every application and learn how many shops
 * Telga has and when each applied.
 */

import { randomInt } from 'node:crypto';

export type ApplicationStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'PROVISIONING'
  | 'DEVICE_PENDING'
  | 'READY_FOR_TRAINING'
  | 'ACTIVE_TRAINING'
  | 'LIVE_ELIGIBLE'
  | 'SUSPENDED'
  | 'CLOSED';

/**
 * Which moves are legal.
 *
 * A state machine rather than a status field anyone may set, for the same
 * reason `states.ts` governs transactions: the illegal moves are the point.
 * An application cannot jump from `SUBMITTED` straight to `ACTIVE_TRAINING`,
 * and a `CLOSED` one cannot come back without an explicit reopen.
 */
const ALLOWED: Readonly<Record<ApplicationStatus, readonly ApplicationStatus[]>> = Object.freeze({
  DRAFT: ['SUBMITTED', 'CLOSED'],
  SUBMITTED: ['UNDER_REVIEW', 'CLOSED'],
  // Returned for correction goes back to DRAFT; rejected goes to CLOSED.
  UNDER_REVIEW: ['APPROVED', 'DRAFT', 'CLOSED'],
  APPROVED: ['PROVISIONING', 'SUSPENDED'],
  PROVISIONING: ['DEVICE_PENDING', 'SUSPENDED'],
  DEVICE_PENDING: ['READY_FOR_TRAINING', 'SUSPENDED'],
  READY_FOR_TRAINING: ['ACTIVE_TRAINING', 'SUSPENDED'],
  ACTIVE_TRAINING: ['LIVE_ELIGIBLE', 'SUSPENDED'],
  // Eligibility, not permission: `money.live` still needs its ten gates and
  // two approvers. No lifecycle state enables a regulated feature.
  LIVE_ELIGIBLE: ['SUSPENDED'],
  SUSPENDED: ['ACTIVE_TRAINING', 'CLOSED'],
  // Terminal. Records are retained, never deleted.
  CLOSED: [],
});

export const canTransition = (from: ApplicationStatus, to: ApplicationStatus): boolean =>
  ALLOWED[from].includes(to);

export class IllegalApplicationTransitionError extends Error {
  readonly code = 'ILLEGAL_APPLICATION_TRANSITION';
  constructor(
    readonly from: ApplicationStatus,
    readonly to: ApplicationStatus,
  ) {
    super(`Refusing ${from} → ${to}: not a legal move.`);
    this.name = 'IllegalApplicationTransitionError';
  }
}

export function assertTransition(from: ApplicationStatus, to: ApplicationStatus): void {
  if (!canTransition(from, to)) throw new IllegalApplicationTransitionError(from, to);
}

/** Terminal states, where nothing further happens. */
export const isTerminalApplication = (status: ApplicationStatus): boolean => status === 'CLOSED';

/**
 * A reference for the applicant.
 *
 * `TG-` and six digits from a cryptographically secure source. Sequential
 * would leak the shop count and let anyone walk the list; `Math.random()`
 * would let them predict the next one.
 */
export const newApplicationReference = (): string =>
  `TG-${String(randomInt(100_000, 1_000_000))}`;

export interface ApplicationInput {
  readonly legalName: string;
  readonly tradingName?: string;
  readonly ownerName: string;
  readonly phone: string;
  readonly email?: string;
  readonly address: string;
  readonly locality: string;
}

export type ApplicationRejection =
  | 'LEGAL_NAME_REQUIRED'
  | 'OWNER_NAME_REQUIRED'
  | 'PHONE_REQUIRED'
  | 'PHONE_INVALID'
  | 'ADDRESS_REQUIRED'
  | 'LOCALITY_REQUIRED'
  | 'EMAIL_INVALID';

/**
 * Check a submission.
 *
 * Deliberately shallow. Telga verifies **none** of this — it is what an
 * applicant typed, and collecting it proves nothing about who they are.
 * CLAUDE.md §30 forbids claiming otherwise, so this checks that the fields are
 * present and shaped like what they claim to be, and stops there. Identity
 * verification is a launch gate, not a form validator.
 */
export function applicationRejection(input: ApplicationInput): ApplicationRejection | undefined {
  if (input.legalName.trim().length === 0) return 'LEGAL_NAME_REQUIRED';
  if (input.ownerName.trim().length === 0) return 'OWNER_NAME_REQUIRED';
  const phone = input.phone.trim();
  if (phone.length === 0) return 'PHONE_REQUIRED';
  // Digits, spaces and a leading plus. Not a claim that the number is real or
  // that it belongs to the applicant.
  if (!/^\+?[\d\s-]{7,20}$/.test(phone)) return 'PHONE_INVALID';
  if (input.address.trim().length === 0) return 'ADDRESS_REQUIRED';
  if (input.locality.trim().length === 0) return 'LOCALITY_REQUIRED';
  if (input.email !== undefined && input.email.trim().length > 0) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) return 'EMAIL_INVALID';
  }
  return undefined;
}

/**
 * What an applicant is told after submitting.
 *
 * The reference and nothing else. No account exists, so there is nothing to
 * sign in to, and saying "we will contact you" is the whole truthful answer.
 */
export interface SubmissionReceipt {
  readonly reference: string;
  readonly status: 'SUBMITTED';
}

/**
 * A decision on an application.
 *
 * A rejection **requires a reason**. A review that records no reason is not a
 * review, and the applicant and the next admin both need to know why.
 */
export type ReviewOutcome = 'APPROVE' | 'REJECT' | 'RETURN_FOR_CORRECTION';

/**
 * The three things a reviewer can decide. Exported as a value, not only a type,
 * because the type vanishes at runtime and the runtime is where a form posts.
 */
export const REVIEW_OUTCOMES: readonly ReviewOutcome[] = Object.freeze([
  'APPROVE',
  'REJECT',
  'RETURN_FOR_CORRECTION',
]);

/**
 * Read an outcome off a form, or refuse to guess.
 *
 * ## Why this exists
 *
 * The console used to cast whatever arrived — `form['outcome'] ?? 'REJECT'` with
 * an `as` — straight onto {@link ReviewDecision}. A cast is a promise to the
 * compiler, not a check, so any string at all reached the decision, and
 * `statusAfterReview` sends everything that is not `APPROVE` or
 * `RETURN_FOR_CORRECTION` to `CLOSED`.
 *
 * **So `APPROVED` — one letter from the value that approves — silently rejected
 * the shop**, recorded `outcome: 'APPROVED'` in the audit trail as though such
 * an outcome existed, and showed the reviewer no error. Found by posting the
 * wrong value by hand; the console's own buttons send the right ones, which is
 * why no test and no click ever hit it.
 *
 * An unreadable outcome now refuses. It does **not** fall back to `REJECT`:
 * defaulting a decision nobody made to the destructive one is how an applicant
 * loses a shop to a typo.
 */
export function parseReviewOutcome(raw: string | undefined): ReviewOutcome | undefined {
  if (raw === undefined) return undefined;
  return REVIEW_OUTCOMES.find((outcome) => outcome === raw);
}

export interface ReviewDecision {
  readonly outcome: ReviewOutcome;
  readonly reason: string;
  readonly reviewedBy: string;
}

export type ReviewRefusal =
  | 'REASON_REQUIRED'
  | 'NOT_UNDER_REVIEW'
  | 'ILLEGAL_TRANSITION'
  /** The form carried no outcome, or one this domain does not define. */
  | 'UNKNOWN_OUTCOME';

export function reviewRefusal(
  current: ApplicationStatus,
  decision: ReviewDecision,
): ReviewRefusal | undefined {
  if (current !== 'UNDER_REVIEW') return 'NOT_UNDER_REVIEW';
  // Approving with no reason is acceptable — the approval is the reason.
  // Rejecting or returning without one is not.
  if (decision.outcome !== 'APPROVE' && decision.reason.trim().length === 0) {
    return 'REASON_REQUIRED';
  }
  const next: ApplicationStatus =
    decision.outcome === 'APPROVE'
      ? 'APPROVED'
      : decision.outcome === 'RETURN_FOR_CORRECTION'
        ? 'DRAFT'
        : 'CLOSED';
  return canTransition(current, next) ? undefined : 'ILLEGAL_TRANSITION';
}

/** Where a decision lands. */
export const statusAfterReview = (decision: ReviewDecision): ApplicationStatus =>
  decision.outcome === 'APPROVE'
    ? 'APPROVED'
    : decision.outcome === 'RETURN_FOR_CORRECTION'
      ? 'DRAFT'
      : 'CLOSED';
