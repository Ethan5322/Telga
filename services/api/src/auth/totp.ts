/**
 * Time-based one-time passwords, RFC 6238.
 *
 * ## What this replaces, and why it had to
 *
 * The console's first second factor was a code Telga generated and then
 * **displayed on the same screen that asked for it**. It exercised the gate,
 * the session flag and the hashing, but as a security control it proved
 * nothing: anyone who could reach the screen could read the answer off it.
 *
 * A real TOTP is different in the one way that matters. The secret is shared
 * **once**, at enrolment, and after that the code is derived independently on
 * both sides from the secret and the clock. Nothing is transmitted, so there
 * is nothing to intercept and nothing to display.
 *
 * ## Why TOTP and not WebAuthn first
 *
 * Decision Log **D105** chose a device passkey as the eventual answer and said
 * password + MFA ships first. There is also a concrete blocker: WebAuthn is a
 * JavaScript API, and the console serves `script-src 'none'` — it has no
 * script at all, deliberately. Adding a passkey means giving the console a
 * script surface, which is a real trade to make on purpose rather than in
 * passing. TOTP needs none: it is a six-digit field on a form.
 *
 * ## What TOTP does not defend against
 *
 * Real-time phishing. Somebody who persuades an admin to read a live code to
 * them can use it inside its window. A passkey is bound to the origin and
 * cannot be replayed that way, which is why D105 still stands as the
 * destination. TOTP closes the "the code is on the screen" hole; it does not
 * close every hole.
 *
 * Implemented here rather than pulled in: it is forty lines of HMAC over
 * `node:crypto`, and a dependency in the authentication path is a supply-chain
 * surface for something the standard library already does.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 4648 base32, which is what every authenticator app expects. */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function toBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(secret: string): Buffer {
  const clean = secret.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    // A character outside the alphabet means the secret was mistyped or
    // corrupted. Skipping it silently would derive a different key and produce
    // a confusing "wrong code" instead of "wrong secret".
    if (index === -1) throw new Error('Invalid base32 in TOTP secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 20 bytes — the RFC 6238 recommendation for HMAC-SHA1. */
export const newTotpSecret = (): string => toBase32(randomBytes(20));

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/**
 * The code for one time step.
 *
 * Standard HOTP dynamic truncation: HMAC the counter, take the low nibble of
 * the last byte as an offset, read four bytes from there, mask the sign bit,
 * and take the last six digits.
 */
export function totpAt(secret: string, atMs: number, step = TOTP_STEP_SECONDS): string {
  const counter = Math.floor(atMs / 1000 / step);
  const buffer = Buffer.alloc(8);
  // Big-endian 64-bit counter. `writeBigUInt64BE` keeps it exact past 2^32.
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', fromBase32(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * Verify a supplied code.
 *
 * ## The window
 *
 * One step either side of now, by default. A phone's clock drifts and a person
 * types slowly, and a factor that rejects a correct code because the operator
 * was two seconds late trains people to hate it. Wider than ±1 starts to
 * matter: each extra step is another 30 seconds in which an observed code
 * still works.
 *
 * ## Constant time
 *
 * Compared with `timingSafeEqual` on equal-length buffers. A `===` on the
 * string leaks, through timing, how many leading digits were right — which
 * turns 10^6 guesses into about 60.
 */
export function verifyTotp(
  secret: string,
  supplied: string,
  atMs: number,
  window = 1,
  step = TOTP_STEP_SECONDS,
): boolean {
  const candidate = supplied.replace(/\s/g, '');
  if (!/^\d{6}$/.test(candidate)) return false;
  const given = Buffer.from(candidate, 'utf8');

  let matched = false;
  for (let drift = -window; drift <= window; drift += 1) {
    const expected = Buffer.from(totpAt(secret, atMs + drift * step * 1000, step), 'utf8');
    // No early return: checking every step regardless keeps the time taken
    // independent of *which* step matched.
    if (expected.length === given.length && timingSafeEqual(expected, given)) matched = true;
  }
  return matched;
}

/**
 * The `otpauth://` URI an authenticator app imports.
 *
 * The label carries the issuer and the account so an admin with several
 * accounts can tell them apart in the app — a list of six identical "Telga"
 * entries is how somebody types the wrong code three times.
 */
export function totpUri(secret: string, account: string, issuer = 'Telga'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * The secret grouped in fours, for typing in by hand.
 *
 * Some authenticator apps cannot scan a QR code, and the console has no
 * script to draw one anyway. A 32-character string typed from a screen needs
 * grouping or it gets mistyped.
 */
export const formatSecretForEntry = (secret: string): string =>
  (secret.match(/.{1,4}/g) ?? []).join(' ');
