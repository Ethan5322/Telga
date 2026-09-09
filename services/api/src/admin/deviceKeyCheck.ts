/**
 * Identifying a device key without ever holding one.
 *
 * ## The request, and why the obvious reading is impossible
 *
 * The founder asked for the device list to show *"Device Key (masked)"*. Taken
 * literally that cannot be built, and the reason is the whole design: a device
 * key is generated at activation, shown once, and stored **only** as a scrypt
 * hash (`CLAUDE.md` §18.2). There is no ciphertext to decrypt and no plaintext
 * to mask. Masking implies a value exists to be partly hidden; none does.
 *
 * That refusal would be useless on its own, because the *need* behind the
 * request is real and answerable. An operations desk wants to settle one
 * question: **"is the key this shop is holding the right one?"** Two things
 * here answer it without Telga ever knowing a key.
 *
 * ## 1. A fingerprint — a stable, public name for a secret
 *
 * {@link deviceKeyFingerprint} derives six characters from the **stored hash**,
 * not from the key. It is safe to print on a screen, read down a phone line and
 * write in a support case, and it cannot be walked backwards: the hash is
 * already a one-way function of the key, and this is a second one on top.
 *
 * What it buys is comparison. Two devices with different fingerprints hold
 * different keys. A device re-enrolled last week has a different fingerprint
 * from the one in last month's case notes. That is most of what "see the key"
 * was ever for.
 *
 * **It is not a checksum of the key.** A shop cannot compute their own
 * fingerprint from their key to compare — they would need the salt. That is
 * deliberate: a value a shop could compute is a value an attacker who phished
 * one key could use to test others.
 *
 * ## 2. A verification — check a key the shop reads out
 *
 * {@link verifyDeviceKey} takes a key an operator has been read and answers
 * match or no-match against the stored hash. Telga learns nothing it did not
 * already have: the key is compared and discarded, never written, never logged.
 *
 * **The caller must audit the attempt.** This module deliberately does not,
 * because it has no actor: whoever calls it knows which admin asked and which
 * case they were working, and an audit line without those is decoration.
 */

import { createHash } from 'node:crypto';
import { verifySecret } from '../auth/secrets';

/**
 * Characters that survive being read down a phone line.
 *
 * The same alphabet the activation code uses, and for the same reason: `I`,
 * `O`, `0` and `1` are the ones people mishear. A fingerprint that is misread
 * is worse than none, because it produces a confident wrong answer.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** How many characters. Six of this alphabet is ~30 bits — ample to tell keys apart. */
const LENGTH = 6;

/**
 * A short, stable, public name for the key behind a stored hash.
 *
 * Derived from the hash with a domain-separated SHA-256, so it cannot collide
 * with any other digest this system computes from the same input. Formatted in
 * two groups of three, which is how a person reads six characters aloud without
 * losing their place.
 *
 * Returns `undefined` for a device with no enrolment — a device that has been
 * created but never activated has no key, and inventing a fingerprint for it
 * would be inventing a fact.
 */
export function deviceKeyFingerprint(secretHash: string | null | undefined): string | undefined {
  if (secretHash === null || secretHash === undefined || secretHash.length === 0) return undefined;
  const digest = createHash('sha256').update(`telga:device-key-fingerprint:${secretHash}`).digest();
  let out = '';
  for (let i = 0; i < LENGTH; i += 1) {
    // `% 32` over a byte is very slightly biased toward the first 8 symbols.
    // Accepted: this is an identifier, not a secret, and uniformity buys
    // nothing here — a fingerprint only ever has to differ from other
    // fingerprints, which 30 bits does comfortably.
    out += ALPHABET[(digest[i] as number) % ALPHABET.length];
  }
  return `${out.slice(0, 3)}-${out.slice(3)}`;
}

export type DeviceKeyCheck =
  /** The key matches what this device was issued. */
  | 'MATCH'
  /** It does not. Says nothing about what the right key is. */
  | 'NO_MATCH'
  /** No enrolment: the device exists but has never been activated. */
  | 'NOT_ENROLLED';

/**
 * Does this key belong to this device?
 *
 * The key is compared and thrown away. It is never stored, never logged, and
 * never echoed back to the caller — the answer is one of three words.
 *
 * `params` is supplied rather than read from the row for the same reason
 * `redeemEnrollment.ts` supplies it: `device_enrollments` stores a hash and a
 * salt and no parameters, and this must stay the literal `sessions.ts` uses to
 * verify a device secret at sign-in. A divergence would make every correct key
 * report `NO_MATCH`, with nothing on screen to suggest why.
 */
export async function verifyDeviceKey(
  enrolment: { readonly secret_hash: string; readonly secret_salt: string } | undefined,
  key: string,
): Promise<DeviceKeyCheck> {
  if (enrolment === undefined) return 'NOT_ENROLLED';
  const ok = await verifySecret(key.trim(), {
    hash: enrolment.secret_hash,
    salt: enrolment.secret_salt,
    params: 'scrypt$N=16384,r=8,p=1,len=64',
  });
  return ok ? 'MATCH' : 'NO_MATCH';
}
