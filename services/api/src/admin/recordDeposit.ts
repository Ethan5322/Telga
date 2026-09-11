/**
 * Recording a deposit an operator has verified against the bank.
 *
 * `packages/domain/src/fundingSubmission.ts` decides; this persists the decision
 * and, when it is a credit, moves the money. They are separate because the
 * decision is pure and exhaustively tested, and this is the part that touches
 * two stores and has to be ordered correctly.
 *
 * ## Where the bank record comes from
 *
 * An operator reading CBE internet banking or a statement. That **is** the
 * verification CLAUDE.md §20 requires — *"a designated operations verifier
 * handles normal funding"* — and it is why `verifyDeposit` takes the bank record
 * as an input rather than trusting the shop's claim. A slip photographed and
 * sent on WhatsApp is the *claim*; what the operator reads in the bank is the
 * *proof*. When a rail arrives (`09 Engineering/Deposit Rail Options`) it
 * supplies the same input and nothing here changes.
 *
 * ## The order, and why a failure lands where it does
 *
 * The row is written **before** the ledger posting, inside one transaction:
 *
 *   1. Insert the submission. The unique index on `bank_reference` is what makes
 *      a replayed deposit a `DUPLICATE` rather than a second credit — a
 *      constraint, not a check that can be forgotten on a second code path.
 *   2. Post the credit through `fundMerchant`, the same balanced append-only
 *      entry the CLI uses.
 *   3. Record the posting id on the row, so a credit can be traced back to the
 *      deposit that caused it.
 *
 * A failure anywhere rolls back the whole thing. **Money never moves without a
 * record of why**, and no record ever claims a credit that did not post.
 *
 * ## Separation of duties is not decorative
 *
 * A deposit over the cap returns `NEEDS_APPROVAL` and is stored `MATCHED`,
 * uncredited. Releasing it requires a **different** admin — refused here and
 * refused again by a `CHECK` in migration 016, because §20 and
 * `05 Operations/Funding Verification` both say the second approver is a second
 * person, and the owners are **NOT YET ASSIGNED**. Until they are, a high-value
 * deposit simply waits, which is the correct behaviour rather than a gap.
 */

import { createHash } from 'node:crypto';
import { statusAfterVerification, verifyDeposit } from '@telga/domain';
import type { BankRecord, MerchantId, VerificationDecision } from '@telga/domain';

/**
 * The searchable form of a device key.
 *
 * A plain SHA-256, deliberately: the key is 256 bits from `randomBytes`, so
 * there is no dictionary to run against it and nothing to guess. scrypt is
 * required for a *PIN*, which a person chose and an attacker can guess; it is
 * the wrong tool for looking something up, because being slow is the point of it.
 *
 * The scrypt hash in `device_enrollments.secret_hash` still does all the
 * authenticating. This only answers "whose is it" — see migration 016.
 */
export const depositLookupFor = (deviceKey: string): string =>
  createHash('sha256').update(deviceKey.trim(), 'utf8').digest('hex');

export interface DepositPorts {
  readonly now: () => string;
  readonly newId: (prefix: string) => string;
  /**
   * The shop that quoted this reference, or `undefined` when none did.
   *
   * Given **both** forms, because there are two kinds of reference and they
   * resolve differently:
   *
   * - `lookup` is the hash of the quote, which is how a **per-shop** code is
   *   stored (`device_enrollments.deposit_lookup`).
   * - `quoted` is the raw text, which is how a **per-order** code is stored
   *   (`topup_orders.reference`, normalised) — §20.1, the reference printed on
   *   a deposit slip.
   *
   * The caller decides which to try first. Passing only the hash, as this port
   * originally did, made a per-order reference unresolvable: hashing it finds
   * nothing, and there is no way back from a hash to the text.
   */
  readonly merchantForReference: (lookup: string, quoted: string) => string | undefined;
  /** True when this bank reference has already produced a credit. */
  readonly alreadyCredited: (bankReference: string) => boolean;
  readonly insertSubmission: (row: {
    id: string;
    merchantId: string | null;
    quotedReference: string;
    bankReference: string;
    claimedAmountMinor: number | null;
    bankAmountMinor: number | null;
    status: string;
    outcomeReason: string | null;
    evidence: string | null;
    recordedBy: string;
    decidedBy: string;
    at: string;
  }) => void;
  /** The balanced, append-only credit. Returns the posting id it wrote. */
  readonly creditMerchant: (input: {
    merchantId: string;
    amountMinor: number;
    correlationId: string;
    postingId: string;
    at: string;
  }) => void;
  readonly linkPosting: (submissionId: string, postingId: string, at: string) => void;
}

export interface DepositClaimInput {
  /** What the shop wrote on the deposit — the Device Key, per D125. */
  readonly quotedReference: string;
  readonly bankReference: string;
  /** What the operator read in the bank. `undefined` when the bank has no such transaction. */
  readonly bankRecord: BankRecord | undefined;
  readonly claimedAmountMinor?: number;
  readonly evidence?: string;
  readonly expectedAccount: string;
  readonly autoCreditCapMinor: number;
  readonly recordedBy: string;
}

export interface DepositOutcome {
  readonly submissionId: string;
  readonly decision: VerificationDecision;
  readonly status: string;
  /** Set only when money actually moved. */
  readonly postingId?: string;
}

/**
 * Decide, record, and credit if the decision says so.
 *
 * The caller wraps this in a transaction. It is not started here because the
 * ledger and the submission live behind the same connection and the caller owns
 * its lifetime — the same reason `provisionMerchant` does not open one.
 */
export function recordDeposit(ports: DepositPorts, input: DepositClaimInput): DepositOutcome {
  const at = ports.now();
  const lookup = depositLookupFor(input.quotedReference);
  const merchantId = ports.merchantForReference(lookup, input.quotedReference);

  const decision = verifyDeposit({
    claim: {
      depositReference: input.quotedReference,
      bankReference: input.bankReference,
      ...(input.claimedAmountMinor === undefined
        ? {}
        : { claimedAmountMinor: input.claimedAmountMinor }),
    },
    ...(input.bankRecord === undefined ? {} : { bankRecord: input.bankRecord }),
    ...(merchantId === undefined ? {} : { merchantForReference: merchantId as MerchantId }),
    alreadyCredited: ports.alreadyCredited(input.bankReference),
    expectedAccount: input.expectedAccount,
    autoCreditCapMinor: input.autoCreditCapMinor,
  });

  const status = statusAfterVerification(decision);
  const submissionId = ports.newId('fund');

  // Why a decision went the way it did. A rejection or a review with no reason
  // recorded is not a decision somebody can answer for later.
  const outcomeReason =
    decision.kind === 'REJECT'
      ? decision.reason
      : decision.kind === 'MANUAL_REVIEW'
        ? decision.reason
        : decision.kind === 'DUPLICATE'
          ? 'BANK_REFERENCE_ALREADY_CREDITED'
          : null;

  ports.insertSubmission({
    id: submissionId,
    // Never guessed. An unmatched deposit is stored with no merchant and waits
    // for a person; rounding it to the nearest shop is how one shop is credited
    // with another's money.
    merchantId: merchantId ?? null,
    quotedReference: input.quotedReference,
    bankReference: input.bankReference,
    claimedAmountMinor: input.claimedAmountMinor ?? null,
    // The bank's figure, and only when the bank had one.
    bankAmountMinor: input.bankRecord?.amountMinor ?? null,
    status,
    outcomeReason,
    evidence: input.evidence ?? null,
    recordedBy: input.recordedBy,
    decidedBy: input.recordedBy,
    at,
  });

  if (decision.kind !== 'CREDIT') {
    return { submissionId, decision, status };
  }

  // The posting id is derived from the submission, so a retry of the same
  // deposit resolves to the same posting and the ledger's primary key refuses a
  // second one — the guard `deposits.ts` already uses with `clientRequestId`.
  const postingId = `posting_${submissionId}`;
  ports.creditMerchant({
    merchantId: decision.merchantId,
    amountMinor: decision.amountMinor,
    correlationId: submissionId,
    postingId,
    at,
  });
  ports.linkPosting(submissionId, postingId, at);

  return { submissionId, decision, status, postingId };
}
