/**
 * One-time device enrollment tokens.
 *
 * The owner brief §7 is specific, and each requirement is here for a reason
 * somebody learned the hard way:
 *
 * | Requirement | Why |
 * |---|---|
 * | Cryptographically random | A guessable token enrols an attacker's device |
 * | Shown once, to the admin | A token in a log or a ticket is a token anyone can use |
 * | Short expiry | A token found in a drawer next year must be worthless |
 * | Single use | Two devices must never activate from one issue |
 * | Stored hashed | A database read must not hand over working tokens |
 * | Never derived from a name, phone or sequential id | All three are guessable |
 * | Never logged in plaintext | The commonest way a secret escapes |
 * | Never a permanent secret in the APK | An APK is a public file |
 *
 * ## Why the token is not the device's long-term credential
 *
 * It activates a device once and then dies. What the device keeps afterwards is
 * a separate credential — see [[Device Binding]] — and conflating the two would
 * mean the thing typed by a person at a counter is also the thing that
 * authenticates every later request.
 */

import { randomBytes } from 'node:crypto';

/**
 * How long a token is worth anything.
 *
 * One hour, because the honest flow is an admin issuing it and reading it to a
 * shop within minutes. A day would mean a token sitting in a message overnight;
 * a minute would mean re-issuing during a phone call.
 */
export const ENROLLMENT_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Human-readable but not human-guessable.
 *
 * Base32 without `I`, `O`, `0` or `1`: this gets read down a phone line, and
 * those four are the pairs people mishear and mistype. 20 characters of a
 * 32-symbol alphabet is 100 bits.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TOKEN_LENGTH = 20;

export function newEnrollmentToken(): string {
  // `randomBytes`, not `Math.random()`: a token predictable from earlier ones
  // is not a secret. Rejection sampling keeps the distribution even — taking
  // a byte modulo 32 would make the first 8 symbols slightly likelier.
  const out: string[] = [];
  while (out.length < TOKEN_LENGTH) {
    for (const byte of randomBytes(TOKEN_LENGTH)) {
      if (out.length === TOKEN_LENGTH) break;
      if (byte >= 256 - (256 % ALPHABET.length)) continue;
      out.push(ALPHABET[byte % ALPHABET.length]);
    }
  }
  // Grouped in fives, which is how somebody reads it aloud without losing
  // their place. The groups are cosmetic and stripped before comparison.
  return (out.join('').match(/.{1,5}/g) ?? []).join('-');
}

/** Strip the cosmetic grouping and case so a typed token compares equal. */
export const normalizeEnrollmentToken = (token: string): string =>
  token.replace(/[\s-]/g, '').toUpperCase();

export type EnrollmentRefusal =
  | 'TOKEN_UNKNOWN'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_ALREADY_USED'
  | 'TOKEN_REVOKED'
  | 'DEVICE_NOT_PENDING'
  | 'MERCHANT_NOT_APPROVED';

export interface EnrollmentTokenState {
  readonly expiresAt: string;
  readonly usedAt: string | null;
  readonly revokedAt: string | null;
}

/**
 * Whether a token may be redeemed.
 *
 * Order matters: **used** is checked before **expired** so that redeeming a
 * spent token says so plainly. An attacker replaying a token they saw once
 * should be told it is spent, not left guessing whether they were merely late.
 * Both refuse, so nothing leaks either way — this is about the operator on the
 * phone who needs to know whether to wait or to ask for a new one.
 */
export function enrollmentRefusal(
  state: EnrollmentTokenState | undefined,
  now: string,
): EnrollmentRefusal | undefined {
  if (state === undefined) return 'TOKEN_UNKNOWN';
  if (state.revokedAt !== null) return 'TOKEN_REVOKED';
  if (state.usedAt !== null) return 'TOKEN_ALREADY_USED';
  if (Date.parse(state.expiresAt) <= Date.parse(now)) return 'TOKEN_EXPIRED';
  return undefined;
}

/** When a token issued now stops working. */
export const enrollmentExpiryFrom = (now: string): string =>
  new Date(Date.parse(now) + ENROLLMENT_TOKEN_TTL_MS).toISOString();

/**
 * What is shown to the admin, once.
 *
 * The plaintext token appears in exactly this object and nowhere else: it is
 * never stored, never returned by a later read, and never written to a log.
 * Only the hash goes to the database.
 */
export interface IssuedEnrollment {
  readonly deviceId: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly notice: string;
}

export const ENROLLMENT_NOTICE =
  'Shown once. Telga stores only a hash and cannot show it again. ' +
  'Give it to the shop directly, never by message, and issue a new one if in doubt.';
