/**
 * Simulated voucher redemption codes.
 *
 * A real airtime or data voucher carries a PIN the customer dials to redeem
 * it, a reference support can quote, and a dial string telling them how. A
 * merchant slip without those is not a voucher, so the training build has to
 * print something — and what it prints must be **unmistakably fake**.
 *
 * ## Why every code here is deliberately worthless
 *
 * Telga has no provider agreement (CLAUDE.md §10, §21). A code that merely
 * *looked* real would be a lie printed on paper and handed across a counter,
 * and the person holding it would have no way to know. So:
 *
 *   - every PIN begins `TRAIN-`, which no operator issues;
 *   - the digits are a fixed placeholder run, not random-looking;
 *   - the dial prefix is `*000*`, which belongs to no operator — in
 *     particular it is **not** Ethio Telecom's real recharge string, and no
 *     real operator name appears anywhere in this file;
 *   - the network code names the *simulated* network, never a real carrier.
 *
 * The slip prints the training notice beside all of it.
 *
 * ## Why it is derived rather than random
 *
 * The code is a pure function of the transaction id. That makes a reprint
 * print the same PIN as the original — a voucher whose PIN changed between
 * prints would be worthless to whoever holds the first slip — without
 * needing to read anything back, and it makes every test deterministic.
 */

import type { TransactionId } from './ids';

/** A dial prefix belonging to no operator. Never a real recharge string. */
export const SIMULATED_DIAL_PREFIX = '*000*';

/** Every simulated PIN starts here, so no reader can mistake one for real. */
export const SIMULATED_PIN_PREFIX = 'TRAIN-';

export interface VoucherCode {
  /** The simulated network's own code, e.g. `NETWORK_A`. Never a carrier name. */
  readonly networkCode: string;
  /** e.g. `TRAIN-12345678`. */
  readonly voucherPin: string;
  /** What support quotes. e.g. `TKN-TRAIN-4F2A91`. */
  readonly tokenReference: string;
  /** e.g. `*000*TRAIN-12345678#`. */
  readonly dialString: string;
}

/**
 * A small, stable hash. Not a security primitive and not used as one — it
 * only spreads transaction ids across the placeholder space so two slips in
 * the same day do not read identically.
 */
function digitsFrom(seed: string, length: number): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return String(hash).padStart(length, '0').slice(0, length);
}

function letters(seed: string, length: number): string {
  // Deliberately no `O`, `I` or `S`: a code read aloud across a counter
  // should not depend on telling them from `0`, `1` and `5`.
  const alphabet = 'ABCDEFGHJKLMNPQRTUVWXYZ';
  let hash = 5381;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (Math.imul(hash, 33) + seed.charCodeAt(index)) >>> 0;
  }
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += alphabet[hash % alphabet.length];
    hash = Math.floor(hash / alphabet.length) + index + 1;
  }
  return out;
}

/**
 * Build the simulated redemption details for one transaction.
 *
 * Pure: same transaction id and network in, same code out, forever.
 */
export function simulatedVoucherCode(
  transactionId: TransactionId | string,
  networkCode: string,
): VoucherCode {
  const seed = `${String(transactionId)}:${networkCode}`;
  const voucherPin = `${SIMULATED_PIN_PREFIX}${digitsFrom(seed, 8)}`;
  return {
    networkCode,
    voucherPin,
    tokenReference: `TKN-TRAIN-${letters(seed, 3)}${digitsFrom(`t:${seed}`, 3)}`,
    dialString: `${SIMULATED_DIAL_PREFIX}${voucherPin}#`,
  };
}

/**
 * True when a value is unmistakably one of ours.
 *
 * Exists so a test can assert the property directly rather than restating
 * the format, and so any future change to the generator has to keep it.
 */
export function isSimulatedVoucherCode(code: VoucherCode): boolean {
  return (
    code.voucherPin.startsWith(SIMULATED_PIN_PREFIX) &&
    code.dialString.startsWith(SIMULATED_DIAL_PREFIX) &&
    code.dialString.includes(SIMULATED_PIN_PREFIX) &&
    code.tokenReference.startsWith('TKN-TRAIN-')
  );
}
