/**
 * The last gate before anything reaches a screen.
 *
 * `assertSafeForDisplay` runs on every successful API response. These tests
 * check it refuses the specific things that would be a leak, and — just as
 * important — that it does not refuse the things support genuinely needs.
 * A redaction rule that blocks the correlation id would make every support call
 * longer while protecting nothing.
 */

import { describe, expect, it } from 'vitest';
import {
  UnsafeForDisplayError,
  assertSafeForDisplay,
  displayCorrelationId,
  displayProviderReference,
} from '@telga/pos-view-model';

describe('what must never reach a screen', () => {
  const forbidden: ReadonlyArray<[string, unknown]> = [
    ['a recipient hash', { recipientHash: 'abc123' }],
    ['a snake-case recipient hash', { recipient_hash: 'abc123' }],
    ['a payload fingerprint', { payloadFingerprint: 'deadbeef' }],
    ['a bare recipient', { recipient: '0900000000' }],
    ['a phone field', { phone: '0900000000' }],
    ['an msisdn', { msisdn: '251900000000' }],
    ['a PIN', { pin: '1234' }],
    ['a password', { password: 'hunter2' }],
    ['a provider token', { providerToken: 'xyz' }],
    ['an api key', { apiKey: 'k' }],
    ['an authorization header', { authorization: 'Bearer x' }],
    ['a recipient salt', { recipientSalt: 's' }],
    ['a private key', { privateKey: 'p' }],
  ];

  for (const [name, value] of forbidden) {
    it(`refuses ${name}`, () => {
      expect(() => assertSafeForDisplay(value)).toThrow(UnsafeForDisplayError);
    });
  }

  it('finds it however deeply it is nested', () => {
    expect(() =>
      assertSafeForDisplay({ a: { b: [{ c: { recipient_hash: 'x' } }] } }),
    ).toThrow(/recipient_hash/);
  });

  it('names the path so the leak can be found', () => {
    try {
      assertSafeForDisplay({ transaction: { detail: { pin: '1' } } });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as UnsafeForDisplayError).path).toBe('$.transaction.detail.pin');
    }
  });
});

describe('what a screen legitimately needs', () => {
  const allowed: ReadonlyArray<[string, unknown]> = [
    ['a masked recipient', { recipientMasked: '09******00' }],
    ['a correlation id', { correlationId: 'corr_1' }],
    ['a provider reference', { providerReference: 'MOCKREF-1234' }],
    ['an idempotency key', { idempotencyKey: 'idem_1' }],
    ['a support reference', { supportReference: 'TG-TXN_1' }],
    ['a state', { state: 'PENDING' }],
    ['an amount', { amount: { amountMinor: 2500, currency: 'ETB' } }],
    ['nulls and undefined', { a: null, b: undefined }],
    ['an empty array', { items: [] }],
  ];

  for (const [name, value] of allowed) {
    it(`allows ${name}`, () => {
      expect(() => assertSafeForDisplay(value)).not.toThrow();
    });
  }
});

describe('display shortening', () => {
  it('shortens a long provider reference but keeps both ends', () => {
    expect(displayProviderReference('MOCKREF-0123456789ABCDEF')).toBe('MOCKRE…CDEF');
  });

  it('leaves a short reference alone', () => {
    expect(displayProviderReference('REF-12345')).toBe('REF-12345');
  });

  it('reports the absence of a reference rather than an empty string', () => {
    expect(displayProviderReference(null)).toBeNull();
    expect(displayProviderReference('   ')).toBeNull();
  });

  it('passes the correlation id through unchanged, because support quotes it', () => {
    expect(displayCorrelationId('corr_abc123')).toBe('corr_abc123');
  });
});
