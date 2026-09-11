/**
 * Paying in through Chapa — `CLAUDE.md` §20.2.
 *
 * A shop presses **Deposit with Chapa**, pays on Chapa's checkout page, and the
 * money reaches its Telga selling balance **automatically**, once Telga has
 * confirmed the payment with Chapa itself.
 *
 * ## Three steps, and the order is the whole design
 *
 * 1. `startChapaDeposit` creates a top-up order and asks Chapa for a checkout
 *    URL. Nothing has moved. The order's own reference is Chapa's `tx_ref`, so
 *    one code identifies the payment in both systems.
 * 2. `settleChapaDeposit` runs when Chapa's webhook arrives — but it does not
 *    believe the webhook. It **re-queries Chapa** and decides on that answer.
 * 3. If Chapa's own record says the payment succeeded for the right amount
 *    against the right reference, the shop's balance goes up **automatically**.
 *
 * ## Why this credits without a person, when a bank deposit does not
 *
 * The founder asked for it — *"when money deposited on telga account it detect
 * automatically"* — and the evidence genuinely is stronger here, which is the
 * part worth writing down.
 *
 * A bank deposit needs a person because the evidence is a human reading a
 * statement and **retyping** an amount, a reference and an account into a form.
 * The typing is the weak step: §20's second approval exists to put a second pair
 * of eyes on a number somebody keyed in.
 *
 * Nothing is keyed in here. Telga asks Chapa directly, over an authenticated
 * channel, and Chapa answers with its own record of its own payment. There is no
 * transcription to get wrong and no judgement to make — the amount either equals
 * what the order was for or it does not, and `decideChapaCredit` refuses on any
 * disagreement. Adding a person would add a rubber stamp, not a check.
 *
 * **What does not change:** a webhook still credits nothing by itself, the
 * amount must match exactly, and an order that is not `OPEN` is refused. The
 * automation is in who confirms, not in what is confirmed.
 *
 * ## What may never credit
 *
 * A webhook body. Chapa's own documentation says so — *"before giving value to a
 * customer based on a webhook notification, always re-query our API"* — which is
 * §20.1's *"an SMS alert may be a hint that a payment arrived; it is not
 * evidence"*, reached independently by the people who run the network. A webhook
 * here is a **prompt to look**, and the looking is `verifyChapaPayment`.
 */

import {
  TRAINING_TOPUP_POLICY,
  decideTopupOrder,
  isEnabled,
  money,
  newDepositReference,
  normalizeDepositReference,
  postingId,
  timestamp,
  topupOrderExpiry,
} from '@telga/domain';
import type { TopupOrderPolicy, TopupOrderRefusal } from '@telga/domain';
import {
  decideChapaCredit,
  initializeChapaPayment,
  isTestKey,
  verifyChapaPayment,
} from '@telga/provider-chapa';
import type { ChapaConfig, CreditRefusal } from '@telga/provider-chapa';
import { fundMerchant } from '@telga/persistence';
import type { AuthContext } from '../auth/context';
import type { AuthedApiDeps } from '../http/deps';

export type ChapaStartResult =
  | { readonly kind: 'STARTED'; readonly reference: string; readonly checkoutUrl: string }
  | { readonly kind: 'REFUSED'; readonly reason: TopupOrderRefusal }
  | { readonly kind: 'DISABLED' }
  /** Chapa refused or could not be reached. The order is cancelled, not left open. */
  | { readonly kind: 'PROVIDER_UNAVAILABLE'; readonly detail: string };

export interface ChapaPorts {
  readonly config: ChapaConfig;
  /** Where Chapa posts the webhook, and where the shop's browser returns. */
  readonly callbackUrl?: string;
  readonly returnUrl?: string;
  /** The email Chapa requires. A shop record, never a customer's. */
  readonly merchantEmail: string;
}

/**
 * A live key is refused here, not merely discouraged.
 *
 * The feature flag is one edit away from being wrong, so the guard that matters
 * sits somewhere an edit cannot reach: this build talks to Chapa's sandbox or it
 * talks to nothing. Turning it into a live integration is a founder decision
 * that needs a contract (§21) and the removal of this function — deliberately
 * more work than flipping a boolean.
 */
export class LiveChapaKeyRefused extends Error {
  constructor() {
    super(
      'Refusing to use Chapa: the configured key is not a CHASECK_TEST- sandbox key. ' +
        'CLAUDE.md §20.2 — this build is sandbox-only, and a live integration needs a ' +
        'signed agreement and confirmed NBE authorisation (§21) before it may be enabled.',
    );
  }
}

export function assertChapaSandbox(config: ChapaConfig): void {
  if (!isTestKey(config.secretKey)) throw new LiveChapaKeyRefused();
}

/** Start a Chapa payment and return the URL to send the shop to. */
export async function startChapaDeposit(
  deps: AuthedApiDeps,
  context: AuthContext,
  ports: ChapaPorts,
  request: { readonly amountMinor: number; readonly correlationId: string },
  policy: TopupOrderPolicy = TRAINING_TOPUP_POLICY,
): Promise<ChapaStartResult> {
  if (!isEnabled('deposit.chapa')) return { kind: 'DISABLED' };
  assertChapaSandbox(ports.config);

  const at = deps.now();
  const merchant = deps.driver.findMerchant(context.merchantId);

  const refusal = decideTopupOrder(
    {
      shopStatus: merchant?.status ?? 'UNKNOWN',
      amount: money(request.amountMinor),
      hasOpenOrder: deps.driver.findOpenTopupOrder(context.merchantId, at) !== undefined,
      depositsEnabled: true,
    },
    policy,
  );
  if (refusal !== undefined) return { kind: 'REFUSED', reason: refusal };

  const orderId = `top_${request.correlationId}`;
  const reference = deps.driver.saveTopupOrder(
    {
      id: orderId,
      merchantId: context.merchantId,
      deviceId: context.deviceId,
      operatorId: context.userId,
      amountMinor: request.amountMinor,
      correlationId: request.correlationId,
      mode: 'TRAINING',
      at,
      expiresAt: topupOrderExpiry(new Date(at), policy),
      method: 'CHAPA',
    },
    newDepositReference,
    normalizeDepositReference,
  );

  const started = await initializeChapaPayment(ports.config, {
    // Chapa takes decimal birr as a string; the ledger keeps santim.
    amount: (request.amountMinor / 100).toFixed(2),
    currency: 'ETB',
    email: ports.merchantEmail,
    tx_ref: reference,
    ...(ports.callbackUrl === undefined ? {} : { callback_url: ports.callbackUrl }),
    ...(ports.returnUrl === undefined ? {} : { return_url: ports.returnUrl }),
  });

  if (started.kind !== 'STARTED') {
    /**
     * Chapa would not start it, so neither do we.
     *
     * The order is cancelled rather than left open. An order nobody can pay is
     * a slip that blocks the shop from printing another (§20.1, one at a time)
     * and a row that sits in the deposits queue meaning nothing. The reference
     * is never released — a payment that somehow arrives against it still
     * resolves to the shop that asked for it.
     */
    deps.driver.cancelTopupOrder(orderId, at);
    const detail = started.kind === 'REFUSED' ? started.message : started.detail;
    return { kind: 'PROVIDER_UNAVAILABLE', detail };
  }

  return { kind: 'STARTED', reference, checkoutUrl: started.checkoutUrl };
}

export type ChapaSettleResult =
  /** Verified against Chapa's own record, and credited. */
  | { readonly kind: 'CREDITED'; readonly submissionId: string; readonly amountMinor: number }
  | { readonly kind: 'REFUSED'; readonly reason: CreditRefusal }
  | { readonly kind: 'UNKNOWN_REFERENCE' }
  /** Chapa could not be asked. Deliberately not a failure — §30. */
  | { readonly kind: 'UNVERIFIABLE'; readonly detail: string };

/**
 * A webhook arrived. Find out what actually happened, and queue it for a person.
 *
 * Idempotent by construction: the decision refuses an order that is not `OPEN`,
 * and webhooks are retried as a matter of course. A second delivery of the same
 * event finds the order already answered and changes nothing.
 */
export async function settleChapaDeposit(
  deps: AuthedApiDeps,
  ports: ChapaPorts,
  txRef: string,
  newId: (prefix: string) => string,
): Promise<ChapaSettleResult> {
  assertChapaSandbox(ports.config);

  const reference = normalizeDepositReference(txRef);
  const order = deps.driver.findTopupOrderByReference(reference);
  // Never guessed at. §20.1: a reference that does not resolve goes to a person.
  if (order === undefined) return { kind: 'UNKNOWN_REFERENCE' };

  // The webhook said something. This is Telga asking Chapa directly, and it is
  // the only answer that counts.
  const verified = await verifyChapaPayment(ports.config, reference);
  if (verified.kind === 'UNREACHABLE') return { kind: 'UNVERIFIABLE', detail: verified.detail };
  if (verified.kind === 'NOT_FOUND') return { kind: 'REFUSED', reason: 'REFERENCE_MISMATCH' };

  const decision = decideChapaCredit(
    {
      status: verified.status,
      currency: verified.currency,
      txRef: verified.txRef,
      amountMinor: verified.amountMinor,
    },
    { reference: order.reference, amountMinor: order.amount_minor, status: order.status },
  );

  // Whatever the outcome, record what Chapa last said. An operations desk
  // asking "why is this still open" should not have to call the gateway.
  deps.driver.recordTopupProviderOutcome({
    reference,
    providerReference: verified.providerReference,
    providerStatus: verified.status,
    at: deps.now(),
  });

  if (decision.kind === 'REFUSE') return { kind: 'REFUSED', reason: decision.reason };

  /**
   * Credit it, and record why — in **one** transaction.
   *
   * Three writes that must not come apart: the balanced ledger pair, the order
   * marked `PAID`, and a `CREDITED` funding submission naming Chapa's reference.
   * A credited shop against an order still reading `OPEN` would be credited
   * again by the next webhook delivery, and webhooks are retried as a matter of
   * course.
   */
  const submissionId = newId('fund');
  const at = deps.now();

  /**
   * The posting id is **derived from the reference**, never drawn fresh.
   *
   * It was `newId('post')` — a new random id on every call, which made the
   * `postingExists` check beside it decorative: a fresh id never exists, so the
   * guard was always false and never stopped anything. `deposits.ts` had it
   * right all along with `posting_deposit_${clientRequestId}`.
   *
   * Derived, a replay of the same payment produces the same posting id, so the
   * ledger carries one identifiable credit for one payment rather than two
   * indistinguishable ones.
   */
  const posting = `posting_chapa_${reference}`;

  let credited = false;

  deps.driver.transaction(() => {
    /**
     * Claim the order **first**, and let the claim be the lock.
     *
     * `markTopupOrderPaid` is `UPDATE … WHERE status = 'OPEN'`, so exactly one
     * caller can ever see it change a row. Whoever does has won the right to
     * credit; whoever sees `0` has lost and must not.
     *
     * ## The race this closes
     *
     * Chapa retries webhooks, and two deliveries can arrive at once. Both would
     * read the order as `OPEN`, both would pass `decideChapaCredit`, and —
     * with the credit posted first — **both would credit the shop**.
     * `ledger_entries.posting_id` is a plain index, not a unique one, so
     * nothing downstream would have refused the second.
     *
     * Checking the status before opening the transaction cannot fix this: the
     * gap between reading and writing is exactly where the second caller fits.
     * The `UPDATE` is the only operation that reads and writes atomically, so
     * it has to be the thing that decides.
     */
    const claimed = deps.driver.claimTopupOrderForSettlement(reference, at);
    if (claimed !== 1) return;

    fundMerchant(deps.driver, {
      merchantId: order.merchant_id as never,
      amount: money(decision.amountMinor),
      at: timestamp(at),
      correlationId: reference,
      postingId: postingId(posting),
    });

    deps.driver.insertFundingSubmission({
      id: submissionId,
      merchantId: order.merchant_id,
      quotedReference: reference,
      // Chapa's own id for the payment, so the gateway's reference does the
      // work a bank reference does on the counter path.
      bankReference: verified.providerReference,
      claimedAmountMinor: order.amount_minor,
      bankAmountMinor: decision.amountMinor,
      status: 'CREDITED',
      currency: 'ETB',
      // Nobody keyed this in — that is the whole reason it needs no approver.
      recordedBy: null,
      evidence: `Chapa ${verified.providerReference}`,
      at,
    });

    // The link, now that the submission exists. Separate from the claim above
    // because `funding_submission_id` is a foreign key and the lock has to come
    // first — see `claimTopupOrderForSettlement`.
    deps.driver.linkTopupOrderSubmission(reference, submissionId, at);

    credited = true;
  });

  // Losing the race is not an error. The payment was credited — by the other
  // delivery of the same webhook — and Chapa is told the event was handled.
  if (!credited) return { kind: 'REFUSED', reason: 'ALREADY_CREDITED' };

  return { kind: 'CREDITED', submissionId, amountMinor: decision.amountMinor };
}
