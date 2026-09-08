/**
 * The Deposit Reference Code — what a shop quotes when it pays money in.
 *
 * ## Why this exists rather than reusing something we already have
 *
 * The founder's first design used the **device key** as the bank reference. That
 * key is one of the four credentials `credentialsOf()` requires to sign in
 * (`userId`, `pin`, `deviceId`, `deviceSecret`), so writing it on a deposit slip
 * would hand a password to a bank teller, print it on two paper copies, key it
 * into CBE's core system, and put it on every statement thereafter. `Device
 * Binding` records that a copied key is indistinguishable from the original
 * (A52), so nothing would ever notice.
 *
 * This code is the opposite of a credential **by construction**: it identifies
 * a shop and authorises nothing. The worst thing an attacker can do holding
 * somebody else's deposit reference is *give them money*.
 *
 * ## Why it is not derived from the merchant id
 *
 * It could be — `merchantIdFor()` derives ids elsewhere in this system. It is
 * generated and stored instead, for one reason: a reference that is a function
 * of the merchant id cannot be **rotated**. A code that has been mis-printed on
 * a thousand flyers, or written into the wrong shop's paperwork, needs to be
 * replaceable without the shop's identity changing.
 *
 * ## Shape
 *
 * Eight data characters plus one check character, from the same 32-symbol
 * alphabet the enrollment token uses — `I`, `O`, `0` and `1` are excluded
 * because this gets read down a phone line and copied by hand at a bank counter,
 * and those four are the pairs people mishear and mistype.
 *
 * Eight characters of 32 symbols is 40 bits, about 1.1 × 10¹². The sparseness
 * matters more than the check digit: with a few thousand shops issued, a
 * mistyped code has a vanishing chance of landing on a *different real* shop,
 * and the lookup answers "no such reference" rather than guessing. **A reference
 * that does not resolve goes to manual review — it is never rounded to the
 * nearest shop.**
 */

import { randomBytes } from 'node:crypto';

/**
 * 32 symbols, chosen for a human reading aloud and a teller writing down.
 *
 * Deliberately identical to the enrollment token's alphabet: two codes in the
 * same system that look different but are transcribed by the same people, under
 * the same conditions, should have the same rules.
 */
export const DEPOSIT_REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Data characters, before the check character is appended. */
export const DEPOSIT_REFERENCE_DATA_LENGTH = 8;

/** Total length once the check character is on the end. */
export const DEPOSIT_REFERENCE_LENGTH = DEPOSIT_REFERENCE_DATA_LENGTH + 1;

const N = DEPOSIT_REFERENCE_ALPHABET.length;

/**
 * The generalised Luhn sum.
 *
 * `startFactor` is 2 when generating a check character over data alone, and 1
 * when validating a string that already carries one — the alternation has to
 * land on the same characters in both directions or a valid code fails its own
 * check.
 *
 * Returns `undefined` if any character is outside the alphabet, so a caller
 * cannot mistake "contains a `0`" for "checksum failed". They need different
 * messages: one is a typo the shop can fix, the other may be a fabricated code.
 */
function luhnSum(input: string, startFactor: 1 | 2): number | undefined {
  let factor = startFactor;
  let sum = 0;
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const value = DEPOSIT_REFERENCE_ALPHABET.indexOf(input[i]);
    if (value === -1) return undefined;
    const addend = factor * value;
    factor = factor === 2 ? 1 : 2;
    // Fold the overflow back in, which is what makes a single-character change
    // always alter the sum.
    sum += Math.floor(addend / N) + (addend % N);
  }
  return sum;
}

/**
 * The check character for eight data characters.
 *
 * Catches every single-character substitution, which is the error a teller
 * copying from a screen actually makes.
 */
export function depositReferenceCheckCharacter(data: string): string | undefined {
  const sum = luhnSum(data, 2);
  if (sum === undefined) return undefined;
  return DEPOSIT_REFERENCE_ALPHABET[(N - (sum % N)) % N];
}

/**
 * Strip the cosmetic grouping so a written code compares equal to a stored one.
 *
 * Spaces and hyphens go, and lowercase is folded up. **Nothing else is
 * corrected.** A `0` is not silently read as `O`: neither is in the alphabet,
 * so a code containing one is refused rather than repaired into a code that
 * might belong to a different shop.
 */
export const normalizeDepositReference = (input: string): string =>
  input.replace(/[\s-]/g, '').toUpperCase();

export type DepositReferenceRejection =
  | 'REFERENCE_EMPTY'
  | 'REFERENCE_WRONG_LENGTH'
  | 'REFERENCE_BAD_CHARACTER'
  | 'REFERENCE_CHECK_FAILED';

/**
 * Why a reference is not usable, or `undefined` when it is well-formed.
 *
 * Well-formed is not the same as **known**: this proves the code was typed
 * correctly, not that a shop holds it. The store answers that, and answers it
 * with a refusal rather than a near match.
 */
export function depositReferenceRejection(input: string): DepositReferenceRejection | undefined {
  const normalized = normalizeDepositReference(input);
  if (normalized.length === 0) return 'REFERENCE_EMPTY';
  if (normalized.length !== DEPOSIT_REFERENCE_LENGTH) return 'REFERENCE_WRONG_LENGTH';
  const sum = luhnSum(normalized, 1);
  if (sum === undefined) return 'REFERENCE_BAD_CHARACTER';
  if (sum % N !== 0) return 'REFERENCE_CHECK_FAILED';
  return undefined;
}

export const isValidDepositReference = (input: string): boolean =>
  depositReferenceRejection(input) === undefined;

/**
 * Grouped in threes: `ABC-DEF-GHJ`.
 *
 * Nine characters read as one run is where a person loses their place. The
 * grouping is cosmetic and stripped before any comparison.
 */
export function formatDepositReference(reference: string): string {
  const normalized = normalizeDepositReference(reference);
  return (normalized.match(/.{1,3}/g) ?? []).join('-');
}

/**
 * A fresh reference, formatted for display.
 *
 * `randomBytes`, not `Math.random`: these are handed out one per shop and must
 * not be predictable from each other. Rejection sampling keeps the distribution
 * even — taking a byte modulo 32 would make the first eight symbols slightly
 * likelier, which narrows the space for no reason.
 *
 * **Uniqueness is the store's job, not this function's.** A generator cannot
 * know what has been issued; the column carries the constraint, and a collision
 * is a retry rather than a duplicate.
 */
export function newDepositReference(): string {
  const data: string[] = [];
  while (data.length < DEPOSIT_REFERENCE_DATA_LENGTH) {
    for (const byte of randomBytes(DEPOSIT_REFERENCE_DATA_LENGTH)) {
      if (data.length === DEPOSIT_REFERENCE_DATA_LENGTH) break;
      if (byte >= 256 - (256 % N)) continue;
      data.push(DEPOSIT_REFERENCE_ALPHABET[byte % N]);
    }
  }
  const joined = data.join('');
  const check = depositReferenceCheckCharacter(joined) as string;
  return formatDepositReference(joined + check);
}
