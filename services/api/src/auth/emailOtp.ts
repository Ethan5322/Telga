/**
 * The code emailed to an administrator after email and password.
 *
 * The founder's sign-in design, 2026-09-08:
 *
 * | Path | Second factor |
 * |---|---|
 * | Email **and** password | this code, sent to that email |
 * | Biometric passkey | none — a passkey is already device plus person |
 *
 * ## Why sending is a port and not a function in here
 *
 * Telga has no email infrastructure, and inventing one would mean choosing a
 * provider on the founder's behalf. So this module produces and checks codes,
 * and something else delivers them. **A console configured for email codes with
 * no sender refuses to start**, rather than issuing codes nobody receives —
 * which would lock every administrator out while looking like a working system.
 * The document vault takes the same line about its encryption key.
 *
 * ## The three bounds, and why one of them is not enough
 *
 * A six-digit code is a million possibilities, which is a small number if a
 * caller may guess indefinitely.
 *
 *   - **Hashed at rest** (scrypt), so reading the table hands nobody a live
 *     code.
 *   - **Attempt-limited**, so guessing stops long before a million.
 *   - **Short-lived**, so a code read from an inbox months later is worthless.
 *
 * A hash without a limit is still brute-forceable at six digits. A limit
 * without a hash leaks every pending code to anyone who reads the database. An
 * expiry without either simply delays both problems. All three, or none of them
 * mean much.
 *
 * ## What this module deliberately does not do
 *
 * It does not decide whether an administrator *may* sign in — that is
 * `adminSessions.ts`. It does not send anything. And it never returns a code to
 * a caller that did not just create one: `verifyEmailOtp` takes a candidate and
 * answers yes or no, so there is no path that reads a code out of storage.
 */

import { randomInt, timingSafeEqual } from 'node:crypto';
import { deriveSecret, verifySecret } from './secrets';

/**
 * Six digits.
 *
 * Long enough that a million guesses stand between a caller and an account,
 * short enough to read off a phone and type without error. The bound that
 * actually stops guessing is {@link MAX_OTP_ATTEMPTS}, not the length — adding
 * digits would trade real usability for arithmetic that the attempt limit has
 * already settled.
 */
export const OTP_LENGTH = 6;

/**
 * **Sixty seconds** — founder instruction, 2026-09-11:
 * *"within 60 sec OTP number must be verified."*
 *
 * ## The trade this makes, stated plainly
 *
 * It was ten minutes. Sixty seconds is a deliberate, and tight, choice: a code
 * that dies in a minute is worthless to anyone who reaches the inbox later, and
 * that is the point.
 *
 * **The cost is delivery time.** Telga controls when the code is generated and
 * when it is checked; it controls nothing in between. Resend, the recipient's
 * mail provider, and greylisting between them commonly spend five to thirty
 * seconds, and occasionally minutes. Every one of those seconds is spent from
 * this budget, so a slow morning means a code that expires before it is read.
 *
 * **Two things make that survivable**, and both matter more here than they
 * would at ten minutes:
 *
 * - The clock starts when Resend **accepts** the email, not when the code is
 *   generated, so Telga's own work is not charged to the window.
 * - An expired code is not a failure. The screen says it expired and offers
 *   another, and {@link OTP_RESEND_INTERVAL_MS} is well inside the window.
 *
 * If sign-in proves unreliable in practice, this is the number to raise — not
 * the attempt limit, and not the code length.
 */
export const OTP_TTL_MS = 60 * 1000;

/**
 * Five wrong guesses, then this code is dead.
 *
 * Not the account — the **code**. Locking the account would hand anybody who
 * knows an administrator's email a denial-of-service button. Killing the code
 * costs the real administrator one more email and costs an attacker their
 * entire attempt budget.
 */
export const MAX_OTP_ATTEMPTS = 5;

/**
 * Thirty seconds between sends.
 *
 * Without it, a caller who knows an address can make Telga mail it as fast as
 * they can press a button — which is both a nuisance to the administrator and a
 * good way to get Telga's sending domain marked as spam.
 */
export const OTP_RESEND_INTERVAL_MS = 30 * 1000;

/**
 * The resend interval must stay **inside** the code's life.
 *
 * If a code expired before another could be requested, an administrator would
 * be left with a dead code and no way to replace it — locked out by the two
 * numbers rather than by either. Asserted rather than left to a comment,
 * because the TTL was changed once and will be again.
 */
if (OTP_RESEND_INTERVAL_MS >= OTP_TTL_MS) {
  throw new Error(
    `OTP_RESEND_INTERVAL_MS (${String(OTP_RESEND_INTERVAL_MS)}ms) must be shorter than ` +
      `OTP_TTL_MS (${String(OTP_TTL_MS)}ms), or an expired code cannot be replaced.`,
  );
}

export interface OtpRecord {
  readonly hash: string;
  readonly salt: string;
  readonly expiresAt: string;
  readonly attempts: number;
}

/**
 * A code, and what to store for it.
 *
 * The plaintext is returned **once**, for the sender to deliver. Nothing else
 * in this module ever produces it again.
 */
export interface IssuedOtp {
  readonly code: string;
  readonly hash: string;
  readonly salt: string;
  readonly expiresAt: string;
}

/**
 * A six-digit code.
 *
 * `randomInt`, not `Math.random`: a code predictable from the ones before it is
 * not a second factor. Leading zeros are kept — `042318` is a perfectly good
 * code, and dropping them would quietly shrink the space by a tenth.
 */
export function newOtpCode(): string {
  let code = '';
  for (let i = 0; i < OTP_LENGTH; i += 1) code += String(randomInt(10));
  return code;
}

/**
 * Generate a code and derive what the row should hold.
 *
 * `now` should be the moment the code is **handed to the mailer**, so the
 * sixty-second window is not spent on Telga's own hashing and database work.
 * With a ten-minute window that was a rounding error; at sixty seconds it is
 * several per cent of the budget.
 */
export async function issueEmailOtp(now: string, ttlMs: number = OTP_TTL_MS): Promise<IssuedOtp> {
  const code = newOtpCode();
  const derived = await deriveSecret(code);
  return {
    code,
    hash: derived.hash,
    salt: derived.salt,
    expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
  };
}

export type OtpRefusal =
  | 'NO_CODE_OUTSTANDING'
  | 'CODE_EXPIRED'
  | 'TOO_MANY_ATTEMPTS'
  | 'CODE_INCORRECT';

export type OtpVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: OtpRefusal };

/**
 * Check a typed code against the stored one.
 *
 * The order is deliberate. Expiry and the attempt limit are checked **before**
 * the hash comparison, so a dead code costs no scrypt derivation and cannot be
 * used to keep the comparison warm. Both refusals are also cheap to reach,
 * which matters when the thing being refused is somebody hammering the endpoint.
 *
 * A wrong guess returns `CODE_INCORRECT` and the caller increments the counter.
 * That split is on purpose: this module is pure, and the count belongs in the
 * same transaction as everything else the caller writes.
 */
export async function verifyEmailOtp(
  candidate: string,
  record: OtpRecord | undefined,
  now: string,
): Promise<OtpVerdict> {
  if (record === undefined) return { ok: false, refusal: 'NO_CODE_OUTSTANDING' };
  if (record.attempts >= MAX_OTP_ATTEMPTS) return { ok: false, refusal: 'TOO_MANY_ATTEMPTS' };
  if (record.expiresAt <= now) return { ok: false, refusal: 'CODE_EXPIRED' };

  // Shape-checked before scrypt: anything that is not six digits cannot be a
  // code, and refusing it here keeps a flood of junk from costing derivations.
  if (!new RegExp(`^\\d{${String(OTP_LENGTH)}}$`).test(candidate)) {
    return { ok: false, refusal: 'CODE_INCORRECT' };
  }

  const ok = await verifySecret(candidate, {
    hash: record.hash,
    salt: record.salt,
    params: 'scrypt$N=16384,r=8,p=1,len=64',
  });
  return ok ? { ok: true } : { ok: false, refusal: 'CODE_INCORRECT' };
}

/** Whether another code may be sent yet. */
export function resendRefused(lastSentAt: string | undefined, now: string): boolean {
  if (lastSentAt === undefined) return false;
  return Date.parse(now) - Date.parse(lastSentAt) < OTP_RESEND_INTERVAL_MS;
}

/**
 * Constant-time comparison of two codes.
 *
 * Not used by {@link verifyEmailOtp}, which compares hashes — exported for a
 * caller that has both plaintexts in hand and must not leak which prefix
 * matched through timing.
 */
export function codesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Delivering a code.
 *
 * Implemented by whatever Telga ends up using — SMTP, a transactional provider,
 * or Ethio Telecom if the founder later prefers SMS. Rejecting means the code
 * was not delivered, and the caller must not treat an undelivered code as
 * issued: an administrator waiting for mail that never comes cannot sign in,
 * and telling them a code was sent is worse than telling them it failed.
 */
export interface OtpSender {
  readonly send: (input: {
    readonly to: string;
    readonly code: string;
    readonly expiresAt: string;
  }) => Promise<void>;
}

/**
 * The sender used when none is configured.
 *
 * Rejects every send, with a message that names the missing configuration. It
 * exists so the failure is loud and specific rather than a console that appears
 * to work and silently mails nothing.
 */
export const noSenderConfigured: OtpSender = {
  send: () =>
    Promise.reject(
      new Error(
        'No email sender is configured, so no sign-in code can be delivered. ' +
          'Configure one, or sign in with a passkey, which needs no code.',
      ),
    ),
};
