/**
 * Balance moving from one shop to another.
 *
 * `CLAUDE.md` §19.1, behind the flag `transfer.shop_to_shop`, which is **off**.
 *
 * > **This is money transfer between two legal entities**, which is a regulated
 * > activity. §2 and §7 list `remittance`, `cash.in_out` and
 * > `payments.acceptance` as disabled until legal review and an
 * > authorized-partner structure exist. What is built here is a **training
 * > simulation** on the precedent of the Telga Pay card simulator (D87/D124)
 * > and training deposits (D70): a training ledger, no counterparty, no bank,
 * > no network. Turning the flag on needs legal advice, not a config edit.
 *
 * ## What this module is
 *
 * The rules, and only the rules. It decides whether a transfer may proceed and
 * what it costs. It moves nothing: the ledger pair is written elsewhere, in one
 * transaction, because a transfer that debited without crediting is money
 * destroyed rather than money moved.
 *
 * ## The recipient is a device **id**, never a device key
 *
 * §18.2: the key authenticates every request that device makes for the life of
 * the device. Asking a shop to read one aloud to another shop — which is what
 * "send to their device key" means in practice — teaches precisely the habit
 * that makes a device key worthless. The id is public by design and is the
 * right thing to quote.
 */

/**
 * A shop's lifecycle status, named here rather than imported.
 *
 * `MerchantStatus` lives in `@telga/persistence`, and the domain package does
 * not depend on persistence — the dependency runs the other way, so that a rule
 * can be reasoned about without a database in scope. Restating the four values
 * is the smaller cost; the union is checked against the schema by
 * `tests/domain/transfer-rules.test.ts`.
 */
type ShopStatus = 'ONBOARDING' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

export type { ShopStatus };

export type TransferOutcome =
  | 'ACCEPTED'
  /** Within limits and well-formed, but large enough to need Telga's approval. */
  | 'ACCEPTED_NEEDS_APPROVAL'
  | 'REFUSED';

export type TransferRefusal =
  /** No such device, or a device id that belongs to nobody. */
  | 'RECIPIENT_NOT_FOUND'
  /** A shop cannot send to itself. It is not a transfer; it is a no-op with a fee. */
  | 'RECIPIENT_IS_SENDER'
  /** Either side suspended or closed. A suspended shop neither sends nor receives. */
  | 'SENDER_NOT_ACTIVE'
  | 'RECIPIENT_NOT_ACTIVE'
  | 'AMOUNT_NOT_POSITIVE'
  /** Above the per-transfer ceiling. */
  | 'ABOVE_TRANSFER_LIMIT'
  /** Would take the sender past their daily total. */
  | 'ABOVE_DAILY_LIMIT'
  /** Sender cannot cover amount **and** fee. */
  | 'INSUFFICIENT_BALANCE';

/**
 * Limits and pricing, every one **NOT YET CONFIRMED**.
 *
 * No default object exists, deliberately. A default limit or fee is an invented
 * commercial term and §30 forbids inventing those; requiring the caller to
 * state them keeps the numbers visible in configuration.
 */
export interface TransferPolicy {
  /** Largest single transfer, minor units. */
  readonly maxPerTransferMinor: number;
  /** Largest total a shop may send in a day, minor units. */
  readonly maxPerDayMinor: number;
  /** Above this, Telga must approve before it settles. */
  readonly approvalThresholdMinor: number;
  /** Basis points charged to the **sender**. Defaults to zero; no rate is invented. */
  readonly feeBasisPoints: number;
}

export interface TransferRequest {
  readonly senderMerchantId: string;
  readonly senderStatus: ShopStatus;
  /** The sender's spendable balance, minor units. */
  readonly senderAvailableMinor: number;
  /** What the sender has already sent today, minor units. */
  readonly sentTodayMinor: number;
  /** Resolved from the recipient **device id**; absent when no such device. */
  readonly recipient?: {
    readonly merchantId: string;
    readonly status: ShopStatus;
  };
  readonly amountMinor: number;
}

export interface TransferDecision {
  readonly outcome: TransferOutcome;
  readonly refusal?: TransferRefusal;
  /** Charged to the sender, on top of the amount. */
  readonly feeMinor: number;
  /** What leaves the sender: amount + fee. */
  readonly totalDebitMinor: number;
  /** What reaches the recipient: the amount, never less. */
  readonly creditMinor: number;
}

/** Rounded **up**, so a fee is never silently absorbed by Telga. */
export const transferFeeFor = (amountMinor: number, basisPoints: number): number =>
  basisPoints <= 0 ? 0 : Math.ceil((amountMinor * basisPoints) / 10_000);

/**
 * May this transfer proceed?
 *
 * ## Why the recipient receives the full amount
 *
 * The fee is charged **on top**, to the sender. A transfer where the recipient
 * gets less than the number both parties agreed is a transfer that will be
 * disputed: the sender says they sent 500, the recipient says they got 495, and
 * both are right. Telga would then be arbitrating its own fee.
 *
 * ## Order of checks
 *
 * Identity, then status, then shape, then limits, then money. A shop that is
 * suspended should be told that, not told its balance is insufficient — and a
 * balance check on a recipient that does not exist is a check on nothing.
 */
export function decideTransfer(
  request: TransferRequest,
  policy: TransferPolicy,
): TransferDecision {
  const refuse = (refusal: TransferRefusal): TransferDecision => ({
    outcome: 'REFUSED',
    refusal,
    feeMinor: 0,
    totalDebitMinor: 0,
    creditMinor: 0,
  });

  if (request.recipient === undefined) return refuse('RECIPIENT_NOT_FOUND');
  if (request.recipient.merchantId === request.senderMerchantId) {
    return refuse('RECIPIENT_IS_SENDER');
  }
  if (request.senderStatus !== 'ACTIVE') return refuse('SENDER_NOT_ACTIVE');
  if (request.recipient.status !== 'ACTIVE') return refuse('RECIPIENT_NOT_ACTIVE');

  // Integer minor units, positive. §13 invariant 9 — never binary floating point,
  // and a zero or negative transfer is not a transfer.
  if (!Number.isInteger(request.amountMinor) || request.amountMinor <= 0) {
    return refuse('AMOUNT_NOT_POSITIVE');
  }

  if (request.amountMinor > policy.maxPerTransferMinor) return refuse('ABOVE_TRANSFER_LIMIT');
  if (request.sentTodayMinor + request.amountMinor > policy.maxPerDayMinor) {
    return refuse('ABOVE_DAILY_LIMIT');
  }

  const feeMinor = transferFeeFor(request.amountMinor, policy.feeBasisPoints);
  const totalDebitMinor = request.amountMinor + feeMinor;
  // Checked against amount **plus** fee. Checking the amount alone is how a
  // transfer settles a merchant into a negative balance — and §20 says plainly:
  // no overdraft.
  if (totalDebitMinor > request.senderAvailableMinor) return refuse('INSUFFICIENT_BALANCE');

  return {
    outcome:
      request.amountMinor > policy.approvalThresholdMinor ? 'ACCEPTED_NEEDS_APPROVAL' : 'ACCEPTED',
    feeMinor,
    totalDebitMinor,
    creditMinor: request.amountMinor,
  };
}

/**
 * The training policy.
 *
 * **Not commercial terms.** Placeholders for a training deployment, recorded in
 * `ASSUMPTIONS` as NOT YET CONFIRMED. The fee is **zero**; setting it needs a
 * founder decision, not an edit here.
 */
export const TRAINING_TRANSFER_POLICY: TransferPolicy = Object.freeze({
  maxPerTransferMinor: 1_000_000,
  maxPerDayMinor: 5_000_000,
  approvalThresholdMinor: 1_000_000,
  feeBasisPoints: 0,
});
