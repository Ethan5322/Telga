/**
 * Recipient handling.
 *
 * A full recipient number is never stored. Support needs enough to identify a
 * transaction with the merchant present; it does not need the subscriber's
 * whole number sitting in a database for years.
 *
 * `maskRecipient` keeps the leading and trailing digits so a merchant can
 * recognise the sale; `hashRecipient` gives an exact-match lookup key without
 * storing the number itself. The hash is salted per deployment so the hash set
 * is not a rainbow-table lookup of every phone number in the country.
 */

import { createHash } from 'node:crypto';

export const DEFAULT_MASK_VISIBLE_PREFIX = 2;
export const DEFAULT_MASK_VISIBLE_SUFFIX = 2;

export function maskRecipient(
  recipient: string,
  prefix = DEFAULT_MASK_VISIBLE_PREFIX,
  suffix = DEFAULT_MASK_VISIBLE_SUFFIX,
): string {
  const trimmed = recipient.trim();
  if (trimmed.length <= prefix + suffix) {
    return '*'.repeat(trimmed.length);
  }
  const head = trimmed.slice(0, prefix);
  const tail = trimmed.slice(trimmed.length - suffix);
  return `${head}${'*'.repeat(trimmed.length - prefix - suffix)}${tail}`;
}

/**
 * Salted SHA-256 of the recipient.
 *
 * The salt is a deployment secret in production. It is **not** stored beside the
 * hash, and it never appears in a log or a receipt.
 */
export function hashRecipient(recipient: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${recipient.trim()}`).digest('hex');
}

/** Keys that must never reach the metadata column of any row. */
const FORBIDDEN_METADATA_KEYS = [
  'pin',
  'password',
  'secret',
  'token',
  'credential',
  'apikey',
  'api_key',
  'authorization',
  'recipient',
  'phone',
  'msisdn',
];

/**
 * Reject metadata that carries something it should not.
 *
 * Cheap and blunt on purpose: metadata columns are where sensitive values leak
 * into a database by accident, and a loud failure in a test is better than a
 * quiet secret in a row.
 */
export function assertSafeMetadata(metadata: Readonly<Record<string, unknown>> | undefined): void {
  if (!metadata) return;
  for (const key of Object.keys(metadata)) {
    const normalized = key.toLowerCase().replace(/[^a-z_]/g, '');
    if (FORBIDDEN_METADATA_KEYS.some((forbidden) => normalized.includes(forbidden))) {
      throw new Error(`Refusing to persist metadata key "${key}": it may carry sensitive data`);
    }
  }
}

export function serializeMetadata(
  metadata: Readonly<Record<string, string | number | boolean>> | undefined,
): string | null {
  if (!metadata) return null;
  assertSafeMetadata(metadata);
  return JSON.stringify(metadata);
}
