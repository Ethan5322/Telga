/**
 * Redaction for anything that leaves the server for a screen.
 *
 * The persistence layer already refuses to *store* a full recipient number, and
 * `privacy.ts` already refuses unsafe metadata keys. This file is the third
 * check, at the last boundary before a value reaches a browser, a printer or a
 * support agent's screen.
 *
 * Three checks is not paranoia. Each one guards a different mistake: storing
 * the wrong thing, persisting the wrong metadata, and *serialising* something
 * safe-at-rest into a response. A new endpoint can reintroduce the third
 * without touching either of the first two.
 */

/** Substrings that must never appear in a key of anything sent to a screen. */
const FORBIDDEN_KEY_PARTS = [
  'pin',
  'password',
  'secret',
  'token',
  'credential',
  'apikey',
  'api_key',
  'authorization',
  'recipienthash',
  'recipient_hash',
  'payloadfingerprint',
  'payload_fingerprint',
  'salt',
  'privatekey',
  'private_key',
];

/**
 * Keys whose *value* must be a masked recipient rather than a full number.
 * `recipientMasked` is allowed; a bare `recipient` is not.
 */
const RECIPIENT_KEYS = ['recipient', 'phone', 'msisdn'];

export class UnsafeForDisplayError extends Error {
  readonly code = 'UNSAFE_FOR_DISPLAY';
  constructor(readonly path: string, reason: string) {
    super(`Refusing to send "${path}" to a screen: ${reason}`);
    this.name = 'UnsafeForDisplayError';
  }
}

const normalize = (key: string): string => key.toLowerCase().replace(/[^a-z_]/g, '');

/**
 * Walk a response body and throw on anything that must not be displayed.
 *
 * Deliberately blunt: a loud failure in a test beats a quiet leak in a receipt.
 */
export function assertSafeForDisplay(value: unknown, path = '$'): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeForDisplay(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalize(key);
    const childPath = `${path}.${key}`;

    if (FORBIDDEN_KEY_PARTS.some((part) => normalized.includes(normalize(part)))) {
      throw new UnsafeForDisplayError(childPath, 'the key names a secret or an internal digest');
    }

    // `recipientMasked` is fine. A bare recipient field is not.
    if (RECIPIENT_KEYS.includes(normalized) && !normalized.includes('masked')) {
      throw new UnsafeForDisplayError(childPath, 'a full recipient number must never be sent');
    }

    assertSafeForDisplay(child, childPath);
  }
}

/**
 * Shorten a provider reference for display.
 *
 * Support needs enough to quote it to the provider with the merchant present;
 * a shop screen visible across a counter does not need the whole string. The
 * full value stays in the transaction record and in the support case.
 */
export function displayProviderReference(reference: string | null): string | null {
  if (reference === null) return null;
  const trimmed = reference.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= 10) return trimmed;
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

/**
 * The correlation id a support agent quotes.
 *
 * Passed through unchanged: it identifies a request, carries no personal data
 * and is useless to anyone without database access. Redacting it would make
 * support harder for no gain.
 */
export function displayCorrelationId(correlationId: string): string {
  return correlationId;
}
