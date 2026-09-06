/**
 * A simulated card reader and acquirer.
 *
 * Implements the same two ports a real terminal will: `CardReader` and
 * `PaymentProcessor`. Everything above them — the tap/insert/swipe prompt,
 * the PIN, the approve and decline handling, the slip — is written once and
 * runs unchanged against this or against a certified reader.
 *
 * ## How the simulated card decides
 *
 * Deterministically, from the card number the operator picks. Test cards
 * behave like the real thing does for that scenario, so a shop can practise
 * the awkward cases — a declined card, an empty account, a wrong PIN — which
 * are exactly the ones staff handle badly when they meet them for the first
 * time at a counter.
 *
 * | Card ends | What happens |
 * |---|---|
 * | 4242 | approved |
 * | 0002 | declined — insufficient funds |
 * | 0069 | declined — expired |
 * | 0119 | declined — issuer unavailable |
 * | 9995 | declined — blocked |
 * | 0341 | no response (the pending case) |
 *
 * Every result carries `simulated: true`, and nothing here contacts anything.
 */

import type {
  AuthorizationOutcome,
  AuthorizationRequest,
  CardEntryMode,
  CardRead,
  CardReadOutcome,
  CardReader,
  DeclineReason,
  Money,
  PaymentProcessor,
} from '@telga/domain';

/** The test cards, keyed by their last four digits. */
const BEHAVIOUR: Readonly<Record<string, DeclineReason | 'APPROVE' | 'NO_RESPONSE'>> =
  Object.freeze({
    '4242': 'APPROVE',
    '0002': 'INSUFFICIENT_FUNDS',
    '0069': 'CARD_EXPIRED',
    '0119': 'ISSUER_UNAVAILABLE',
    '9995': 'CARD_BLOCKED',
    '0341': 'NO_RESPONSE',
    '0127': 'WRONG_PIN',
    '0051': 'LIMIT_EXCEEDED',
  });

/** Every card a training operator can present, in the order the screen lists them. */
export const SIMULATED_CARDS: readonly {
  readonly lastFour: string;
  readonly scheme: string;
  readonly label: string;
}[] = Object.freeze([
  { lastFour: '4242', scheme: 'VISA', label: 'Approves' },
  { lastFour: '0002', scheme: 'MASTERCARD', label: 'Not enough money' },
  { lastFour: '0127', scheme: 'VISA', label: 'Wrong PIN' },
  { lastFour: '0069', scheme: 'MASTERCARD', label: 'Expired card' },
  { lastFour: '9995', scheme: 'VISA', label: 'Blocked card' },
  { lastFour: '0051', scheme: 'MASTERCARD', label: 'Over the limit' },
  { lastFour: '0119', scheme: 'VISA', label: 'Bank not answering' },
  { lastFour: '0341', scheme: 'MASTERCARD', label: 'No answer at all' },
]);

export interface SimulatedCardOptions {
  /** Which card is presented next. Defaults to the approving one. */
  readonly lastFour?: string;
  readonly entryMode?: CardEntryMode;
  /** Set false to simulate a terminal with no reader attached. */
  readonly readerPresent?: boolean;
  /** Injected, so a test never waits on a real clock. */
  readonly now?: () => string;
}

/**
 * Build a masked PAN.
 *
 * The first twelve digits are never known to this software — a real read
 * gives a masked PAN and nothing more — so they are dots, not a number that
 * somebody might later mistake for a card.
 */
export function maskPan(lastFour: string): string {
  return `•••• •••• •••• ${lastFour}`;
}

export function createSimulatedCardReader(options: SimulatedCardOptions = {}): CardReader {
  const lastFour = options.lastFour ?? '4242';
  const entryMode = options.entryMode ?? 'INSERT';
  const present = options.readerPresent ?? true;

  return {
    capabilities(): readonly CardEntryMode[] {
      return ['TAP', 'INSERT', 'SWIPE'];
    },
    async isPresent(): Promise<boolean> {
      return Promise.resolve(present);
    },
    async waitForCard(_amount: Money, _timeoutMs: number): Promise<CardReadOutcome> {
      if (!present) return Promise.resolve({ kind: 'NO_READER' });
      const card = SIMULATED_CARDS.find((c) => c.lastFour === lastFour);
      if (card === undefined) return Promise.resolve({ kind: 'UNREADABLE' });

      const read: CardRead = {
        entryMode,
        maskedPan: maskPan(card.lastFour),
        scheme: card.scheme,
        // A fixed, obviously-future expiry. It is printed on the slip and is
        // not a credential.
        expiry: '12/30',
        // Tap and chip are cryptogram-verified; a swipe is not, which is why
        // a real acquirer treats it as higher risk.
        chipVerified: entryMode !== 'SWIPE',
        simulated: true,
      };
      return Promise.resolve({ kind: 'READ', card: read });
    },
  };
}

export function createSimulatedProcessor(): PaymentProcessor {
  // Reversals are recorded so a test can prove an approved-then-failed
  // payment was actually reversed rather than merely reported as reversed.
  const reversed = new Set<string>();

  return {
    async authorize(request: AuthorizationRequest): Promise<AuthorizationOutcome> {
      const lastFour = request.card.maskedPan.slice(-4);
      const behaviour = BEHAVIOUR[lastFour] ?? 'APPROVE';

      if (behaviour === 'NO_RESPONSE') return Promise.resolve({ kind: 'NO_RESPONSE' });
      if (behaviour !== 'APPROVE') {
        return Promise.resolve({ kind: 'DECLINED', reason: behaviour, simulated: true });
      }

      // Even an approving card is declined past a ceiling, so the
      // over-the-limit path is reachable with the ordinary test card.
      if (request.amount.minor > 5_000_000) {
        return Promise.resolve({ kind: 'DECLINED', reason: 'LIMIT_EXCEEDED', simulated: true });
      }

      return Promise.resolve({
        kind: 'APPROVED',
        // Derived from the request id, so a retry of the same intent reports
        // the same authorisation rather than looking like a second one.
        authorizationCode: `SIM-${request.clientRequestId.slice(-8).toUpperCase()}`,
        simulated: true,
      });
    },

    async reverse(authorizationCode: string): Promise<{ readonly reversed: boolean }> {
      reversed.add(authorizationCode);
      return Promise.resolve({ reversed: true });
    },

    async healthCheck(): Promise<{ readonly healthy: boolean; readonly simulated: boolean }> {
      return Promise.resolve({ healthy: true, simulated: true });
    },
  };
}
