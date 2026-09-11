/**
 * May this Chapa payment credit a shop? — `CLAUDE.md` §20.2.
 *
 * Deliberately separate from the HTTP client, and deliberately pure. The rule
 * that decides whether money moves should be readable in one screen, testable
 * without a network, and impossible to change by editing a request.
 *
 * ## What it is checking against
 *
 * A Chapa payment is only creditable when **four** things agree: Chapa says it
 * succeeded, it is the currency we asked for, it is the order we started, and
 * the amount matches what that order was for. Any one of them disagreeing is a
 * payment a person should look at, not one the system should act on.
 *
 * §20.1 already says the general form of this for bank deposits: *"a reference
 * that does not resolve goes to a person — it is never rounded to the nearest
 * shop."*
 */

import type { ChapaPaymentStatus } from './client';

export type CreditRefusal =
  /** Chapa did not say the payment succeeded. */
  | 'NOT_SUCCESSFUL'
  /** Not ETB. Telga's ledger holds one currency. */
  | 'WRONG_CURRENCY'
  /** The reference is not one we issued, or belongs to a different order. */
  | 'REFERENCE_MISMATCH'
  /** Paid less than the order was for. */
  | 'UNDERPAID'
  /** Paid more than the order was for. */
  | 'OVERPAID'
  /** This order has already been credited. */
  | 'ALREADY_CREDITED'
  /** The order was cancelled or expired before the money arrived. */
  | 'ORDER_NOT_OPEN';

export interface ChapaPaymentFacts {
  readonly status: ChapaPaymentStatus;
  readonly currency: string;
  readonly txRef: string;
  readonly amountMinor: number;
}

export interface TopupOrderFacts {
  readonly reference: string;
  readonly amountMinor: number;
  /** `OPEN`, `PAID`, `EXPIRED`, `CANCELLED`. */
  readonly status: string;
}

export type CreditDecision =
  | { readonly kind: 'CREDIT'; readonly amountMinor: number }
  | { readonly kind: 'REFUSE'; readonly reason: CreditRefusal };

/**
 * The decision.
 *
 * Order matters. Identity is settled before amount: telling somebody their
 * amount is wrong on a payment that is not theirs answers the wrong question
 * and leaks that the reference exists.
 *
 * **The order's amount is the authority, not Chapa's.** Chapa reports what was
 * paid; the order records what was asked for. Crediting Chapa's figure when the
 * two differ would let the paying side choose the amount, so a mismatch refuses
 * rather than reconciling — and a person decides.
 *
 * This is the opposite of the bank-deposit rule, where §20.1 credits *the
 * bank's* figure, and the difference is deliberate: a bank statement is a record
 * of money that indisputably arrived, whereas this is a live negotiation with a
 * gateway about an amount we specified up front.
 */
export function decideChapaCredit(
  payment: ChapaPaymentFacts,
  order: TopupOrderFacts,
): CreditDecision {
  if (payment.status !== 'SUCCESS') return { kind: 'REFUSE', reason: 'NOT_SUCCESSFUL' };

  // Normalised before comparing: the same reference may come back cased or
  // grouped differently from how it was sent.
  const paid = payment.txRef.replace(/[\s-]/g, '').toUpperCase();
  const expected = order.reference.replace(/[\s-]/g, '').toUpperCase();
  if (paid !== expected) return { kind: 'REFUSE', reason: 'REFERENCE_MISMATCH' };

  // An order that is not open has already been answered — by this payment on an
  // earlier delivery of the same webhook, or by a cancellation. Either way this
  // must not add a second credit. Webhooks are retried; that is normal.
  if (order.status === 'PAID') return { kind: 'REFUSE', reason: 'ALREADY_CREDITED' };
  if (order.status !== 'OPEN') return { kind: 'REFUSE', reason: 'ORDER_NOT_OPEN' };

  if (payment.currency !== 'ETB') return { kind: 'REFUSE', reason: 'WRONG_CURRENCY' };

  if (payment.amountMinor < order.amountMinor) return { kind: 'REFUSE', reason: 'UNDERPAID' };
  if (payment.amountMinor > order.amountMinor) return { kind: 'REFUSE', reason: 'OVERPAID' };

  return { kind: 'CREDIT', amountMinor: order.amountMinor };
}

/** What a shopkeeper is told. Never the internal reason code. */
export const REFUSAL_MESSAGE: Readonly<Record<CreditRefusal, string>> = Object.freeze({
  NOT_SUCCESSFUL: 'Chapa has not confirmed this payment. Your balance has not changed.',
  WRONG_CURRENCY: 'That payment was not in birr. Telga has told support.',
  REFERENCE_MISMATCH: 'That payment does not match this deposit. Telga has told support.',
  UNDERPAID: 'Less was paid than this deposit was for. Telga has told support.',
  OVERPAID: 'More was paid than this deposit was for. Telga has told support.',
  ALREADY_CREDITED: 'This deposit has already been added to your balance.',
  ORDER_NOT_OPEN: 'This deposit is no longer open. Start a new one.',
});
