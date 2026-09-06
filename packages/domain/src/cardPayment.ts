/**
 * Card payments: the reader, the processor, and what a card transaction is.
 *
 * ## Why this is two ports, not one feature
 *
 * A smart-POS taking a card does two separate things, and they fail in
 * different ways:
 *
 *   1. **Reading the card.** Tap, insert or swipe; get the card's public
 *      details and, for chip, the cryptogram. This is the *hardware's* job —
 *      on a real terminal it comes from the vendor's SDK (Telpo, Sunmi, PAX,
 *      Wizarpos and so on). A browser has no card-reader API at all, so on a
 *      web build this port is served by a simulator and on a device build it
 *      is served by the vendor driver. **Nothing above this interface changes
 *      between the two.**
 *
 *   2. **Authorising the money.** Send the read to an acquirer, get an
 *      approval or a decline, and act on the decline reason. This is the
 *      *acquirer's* job and needs a contract, credentials and certification.
 *
 * Splitting them means the entire flow above — prompt, read, PIN, authorise,
 * approve or decline, print — is written once and is real. Connecting a
 * certified reader and a live acquirer is then implementing two interfaces,
 * not rebuilding the product. It is the same shape `AirtimeProvider` already
 * uses, for the same reason.
 *
 * ## What must never be stored
 *
 * The full PAN, the magnetic stripe track data, the chip cryptogram, and the
 * **CVV/CVC — never, in any form, encrypted or not.** PCI DSS forbids
 * retaining the verification code after authorisation outright. `CardRead`
 * below therefore carries a *masked* PAN and nothing else that identifies the
 * card: there is no field to put a CVV in, so no code can accidentally
 * persist one. The cardholder PIN is entered on the reader's own secure pad
 * on real hardware and never reaches this software at all.
 */

import type { Money } from './money';

/** How the card was presented. */
export type CardEntryMode = 'TAP' | 'INSERT' | 'SWIPE';

/** What the reader gives back. Deliberately the least it can be. */
export interface CardRead {
  readonly entryMode: CardEntryMode;
  /** Last four only, already masked: `•••• •••• •••• 4242`. */
  readonly maskedPan: string;
  /** `VISA`, `MASTERCARD`, … — the scheme, never the number. */
  readonly scheme: string;
  /** Expiry as `MM/YY`, for the slip. Not a secret, and not a credential. */
  readonly expiry: string;
  /**
   * True when the read carries a chip cryptogram the acquirer will verify.
   * The cryptogram itself never leaves the reader.
   */
  readonly chipVerified: boolean;
  /** Always true in this build. A real reader sets it false. */
  readonly simulated: boolean;
}

export type CardReadOutcome =
  | { readonly kind: 'READ'; readonly card: CardRead }
  /** The customer removed the card, or the tap did not complete. */
  | { readonly kind: 'ABORTED' }
  /** The reader could not read it — damaged stripe, unreadable chip. */
  | { readonly kind: 'UNREADABLE' }
  /** No reader present. A web build with no device attached. */
  | { readonly kind: 'NO_READER' };

/**
 * The card reader.
 *
 * Implemented by the vendor SDK on a real terminal and by the simulator here.
 * `waitForCard` is what the "Tap, insert or swipe" screen is waiting on.
 */
export interface CardReader {
  /** Which presentation modes this reader physically supports. */
  capabilities(): readonly CardEntryMode[];
  /** Wait for a card, up to `timeoutMs`. Resolves `ABORTED` on timeout. */
  waitForCard(amount: Money, timeoutMs: number): Promise<CardReadOutcome>;
  /** True when a reader is attached and healthy. */
  isPresent(): Promise<boolean>;
}

/** Why an authorisation was declined. Each one is a different thing to tell the customer. */
export type DeclineReason =
  | 'INSUFFICIENT_FUNDS'
  | 'WRONG_PIN'
  | 'CARD_EXPIRED'
  | 'CARD_BLOCKED'
  | 'LIMIT_EXCEEDED'
  | 'ISSUER_UNAVAILABLE'
  | 'DECLINED';

export type AuthorizationOutcome =
  | {
      readonly kind: 'APPROVED';
      /** The acquirer's reference, for the slip and for any dispute. */
      readonly authorizationCode: string;
      readonly simulated: boolean;
    }
  | { readonly kind: 'DECLINED'; readonly reason: DeclineReason; readonly simulated: boolean }
  /** No answer. Treated like a pending airtime sale: never assume either way. */
  | { readonly kind: 'NO_RESPONSE' };

export interface AuthorizationRequest {
  readonly card: CardRead;
  readonly amount: Money;
  /** Purchase, or purchase with cash back. */
  readonly kind: 'PURCHASE' | 'CASHBACK';
  /** Cash handed over, when `CASHBACK`. Zero otherwise. */
  readonly cashOut: Money;
  /** Ties the authorisation to one merchant intent; a retry reuses it. */
  readonly clientRequestId: string;
}

/**
 * The acquirer.
 *
 * `authorize` is the only method that moves money. `reverse` exists because
 * an approved authorisation that then fails to print or complete **must** be
 * reversible — the same rule the airtime ledger follows: never leave value
 * taken and not delivered.
 */
export interface PaymentProcessor {
  authorize(request: AuthorizationRequest): Promise<AuthorizationOutcome>;
  reverse(authorizationCode: string): Promise<{ readonly reversed: boolean }>;
  healthCheck(): Promise<{ readonly healthy: boolean; readonly simulated: boolean }>;
}

/**
 * What a merchant should be told for each decline.
 *
 * A decline reason is a machine token; `INSUFFICIENT_FUNDS` means nothing
 * across a counter. These map to the localisation keys the screen renders, so
 * an unmapped reason still produces a sentence rather than a blank.
 */
export const DECLINE_MESSAGE_KEYS = Object.freeze({
  INSUFFICIENT_FUNDS: 'card.decline.insufficient_funds',
  WRONG_PIN: 'card.decline.wrong_pin',
  CARD_EXPIRED: 'card.decline.expired',
  CARD_BLOCKED: 'card.decline.blocked',
  LIMIT_EXCEEDED: 'card.decline.limit',
  ISSUER_UNAVAILABLE: 'card.decline.issuer',
  DECLINED: 'card.decline.generic',
} as const);

/** Whether a decline is worth another attempt with the same card. */
export function isRetryable(reason: DeclineReason): boolean {
  // A wrong PIN and an unreachable issuer are worth retrying; a blocked or
  // expired card and an empty account are not, and telling a merchant to try
  // again would waste a queue's time.
  return reason === 'WRONG_PIN' || reason === 'ISSUER_UNAVAILABLE';
}
