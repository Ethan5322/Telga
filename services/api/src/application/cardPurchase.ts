/**
 * Taking a card payment.
 *
 * The whole flow, written once against the two ports in
 * `@telga/domain/cardPayment`: wait for the card, authorise it, and act on
 * what comes back. It runs unchanged against the simulator today and against
 * a certified reader and a live acquirer when those are connected — that is
 * the point of the ports.
 *
 * ## The three outcomes, and why the third is the important one
 *
 *   - **Approved.** The money is taken. A record is written and a slip is
 *     available.
 *   - **Declined.** Nothing is taken. The reason is turned into a sentence a
 *     merchant can say out loud — "not enough money on the card" — because
 *     `INSUFFICIENT_FUNDS` means nothing across a counter.
 *   - **No response.** The acquirer did not answer. This is the dangerous one
 *     and it is treated exactly as a pending airtime sale is: **never assumed
 *     either way.** The money may or may not have left the customer's
 *     account. Reporting it as failed would be a lie a shop then acts on.
 *
 * ## What is never stored
 *
 * The PAN, the track data, the cryptogram, and the CVV. `CardRead` has no
 * field for any of them beyond a masked PAN, so there is nothing here that
 * could persist one. See `cardPayment.ts`.
 *
 * ## Training only
 *
 * `deps.mode` is checked first. This build has no acquirer contract and no
 * certified reader, so the only processor wired in is the simulator, and
 * every result it returns is marked `simulated`.
 */

import type {
  AuthorizationOutcome,
  CardEntryMode,
  CardRead,
  CardReader,
  DeclineReason,
  Money,
  PaymentProcessor,
} from '@telga/domain';
import { DECLINE_MESSAGE_KEYS, isRetryable, money } from '@telga/domain';

/** How long the reader waits before giving up on a card. */
export const CARD_READ_TIMEOUT_MS = 60_000;

export interface CardPurchaseDeps {
  readonly reader: CardReader;
  readonly processor: PaymentProcessor;
  readonly mode: string;
  now(): string;
  newId(prefix: string): string;
}

export interface CardPurchaseRequest {
  readonly amountMinor: number;
  readonly kind: 'PURCHASE' | 'CASHBACK';
  /** Cash handed over, when `CASHBACK`. */
  readonly cashOutMinor?: number;
  readonly entryMode: CardEntryMode;
  readonly clientRequestId: string;
}

export type CardPurchaseResult =
  | {
      readonly kind: 'APPROVED';
      readonly authorizationCode: string;
      readonly card: CardRead;
      readonly amountMinor: number;
      readonly cashOutMinor: number;
      readonly simulated: boolean;
    }
  | {
      readonly kind: 'DECLINED';
      readonly reason: DeclineReason;
      readonly messageKey: string;
      readonly retryable: boolean;
      readonly card: CardRead;
    }
  /** The acquirer did not answer. Never reported as a failure. */
  | { readonly kind: 'NO_RESPONSE'; readonly card: CardRead }
  | { readonly kind: 'CARD_NOT_READ'; readonly why: 'ABORTED' | 'UNREADABLE' | 'NO_READER' }
  | { readonly kind: 'AMOUNT_INVALID' }
  | { readonly kind: 'SIMULATED_ONLY' };

export async function takeCardPayment(
  deps: CardPurchaseDeps,
  request: CardPurchaseRequest,
): Promise<CardPurchaseResult> {
  if (deps.mode !== 'TRAINING') return { kind: 'SIMULATED_ONLY' };

  const amountMinor = request.amountMinor;
  const cashOutMinor = request.cashOutMinor ?? 0;
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return { kind: 'AMOUNT_INVALID' };
  if (!Number.isSafeInteger(cashOutMinor) || cashOutMinor < 0) return { kind: 'AMOUNT_INVALID' };
  // Cash back is money handed over, so it cannot exceed what is authorised.
  if (cashOutMinor > amountMinor) return { kind: 'AMOUNT_INVALID' };

  const amount: Money = money(amountMinor);

  const read = await deps.reader.waitForCard(amount, CARD_READ_TIMEOUT_MS);
  if (read.kind !== 'READ') return { kind: 'CARD_NOT_READ', why: read.kind };

  const outcome: AuthorizationOutcome = await deps.processor.authorize({
    card: read.card,
    amount,
    kind: request.kind,
    cashOut: money(cashOutMinor),
    clientRequestId: request.clientRequestId,
  });

  if (outcome.kind === 'NO_RESPONSE') {
    // Deliberately not a failure. The money may or may not have moved, and a
    // shop told "declined" would hand the goods over for nothing — or refuse a
    // customer who has already been charged.
    return { kind: 'NO_RESPONSE', card: read.card };
  }

  if (outcome.kind === 'DECLINED') {
    return {
      kind: 'DECLINED',
      reason: outcome.reason,
      messageKey: DECLINE_MESSAGE_KEYS[outcome.reason],
      retryable: isRetryable(outcome.reason),
      card: read.card,
    };
  }

  return {
    kind: 'APPROVED',
    authorizationCode: outcome.authorizationCode,
    card: read.card,
    amountMinor,
    cashOutMinor,
    simulated: outcome.simulated,
  };
}
