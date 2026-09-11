/**
 * Proving a Chapa webhook actually came from Chapa.
 *
 * `CLAUDE.md` §24 — *"webhook signatures and replay protection"*. This is the
 * whole security boundary of an inbound payment notification: without it, the
 * callback URL is an endpoint on the public internet that credits shop balances
 * to whoever posts the right JSON.
 *
 * ## What Chapa sends
 *
 * Two headers, and they are **not** the same thing:
 *
 * | Header | What it is an HMAC of |
 * |---|---|
 * | `x-chapa-signature` | the **event payload** |
 * | `chapa-signature` | the **secret key itself** |
 *
 * Both use HMAC-SHA256 keyed with the merchant's secret key.
 *
 * **Only `x-chapa-signature` proves anything about *this* message.** The other
 * is the same constant value on every webhook Chapa ever sends to this account:
 * it proves the sender knows the secret, and says nothing about whether the body
 * was altered in transit or replayed from an earlier delivery. Chapa's
 * documentation accepts either — *"if both headers are present but one of the
 * headers is valid, it is sufficient to proceed"* — and this module
 * deliberately does not.
 *
 * Accepting the constant one would mean a body could be rewritten, the amount
 * changed, and the signature would still check out. `verifyChapaWebhook`
 * therefore requires the payload signature, and treats a request carrying only
 * the constant header as unsigned.
 *
 * ## Why the raw body, not the parsed object
 *
 * The signature is over the exact bytes Chapa hashed. Parsing and re-serialising
 * JSON reorders keys, changes number formatting and drops insignificant
 * whitespace — any of which produces a different hash and a valid message
 * rejected. The caller must hand over the body as received.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export type WebhookVerdict =
  /** Signed with the payload signature, and it matches. */
  | 'VALID'
  /** A payload signature was present and did not match. Discard. */
  | 'BAD_SIGNATURE'
  /** No payload signature at all. Discard — see the note on `chapa-signature`. */
  | 'UNSIGNED';

/** Header names, lower-cased as Node delivers them. */
export const PAYLOAD_SIGNATURE_HEADER = 'x-chapa-signature';
export const SECRET_SIGNATURE_HEADER = 'chapa-signature';

/**
 * Compare two hex digests without leaking where they differ.
 *
 * A plain `===` on a signature returns as soon as two bytes differ, and the
 * time it took is a measurement of how many leading bytes were right. That is
 * enough to reconstruct a signature one byte at a time over enough requests.
 */
function equalDigests(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // `timingSafeEqual` throws on unequal lengths, which would itself be a
  // timing signal — so the length check is done first and deliberately.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** The signature Chapa should have sent for this exact body. */
export const chapaPayloadSignature = (rawBody: string, secretKey: string): string =>
  createHmac('sha256', secretKey).update(rawBody, 'utf8').digest('hex');

/**
 * Did Chapa send this?
 *
 * `rawBody` must be the bytes as received — see the note above on why a parsed
 * object will not do.
 */
export function verifyChapaWebhook(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  rawBody: string,
  secretKey: string,
): WebhookVerdict {
  const raw = headers[PAYLOAD_SIGNATURE_HEADER];
  const provided = Array.isArray(raw) ? raw[0] : raw;

  // No payload signature: unsigned, whatever else was sent. A `chapa-signature`
  // on its own is a constant and proves nothing about this message.
  if (provided === undefined || provided.trim().length === 0) return 'UNSIGNED';

  return equalDigests(provided.trim(), chapaPayloadSignature(rawBody, secretKey))
    ? 'VALID'
    : 'BAD_SIGNATURE';
}
