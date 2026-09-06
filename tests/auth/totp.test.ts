/**
 * TOTP — RFC 6238.
 *
 * This replaced a "second factor" that was a code Telga generated and printed
 * on the screen that asked for it. That exercised the gate and proved nothing.
 *
 * The tests that matter here are the ones that show it is genuinely the
 * standard algorithm — a home-made lookalike would pass every test written
 * against itself, and then reject every code a real authenticator app
 * produces. So the first suite checks the published RFC 6238 vectors.
 */

import { describe, expect, it } from 'vitest';
import {
  TOTP_STEP_SECONDS,
  formatSecretForEntry,
  fromBase32,
  newTotpSecret,
  toBase32,
  totpAt,
  totpUri,
  verifyTotp,
} from '@telga/api';

/**
 * The RFC 6238 test key, `"12345678901234567890"`, base32-encoded.
 *
 * The RFC prints its vectors for SHA-1 with this ASCII key. If this file's
 * implementation disagrees with these numbers, it is not TOTP, whatever else it
 * is — and no authenticator app would interoperate with it.
 */
const RFC_SECRET = toBase32(Buffer.from('12345678901234567890', 'ascii'));

describe('the published RFC 6238 vectors', () => {
  it('matches the SHA-1 vectors exactly', () => {
    // Unix time → the RFC's expected 8-digit value; TOTP here is 6 digits, so
    // the last six are what this implementation must produce.
    const vectors: readonly [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, eightDigits] of vectors) {
      const expected = eightDigits.slice(-6);
      expect(totpAt(RFC_SECRET, seconds * 1000), `t=${String(seconds)}`).toBe(expected);
    }
  });
});

describe('base32', () => {
  it('round-trips', () => {
    for (const text of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', '12345678901234567890']) {
      expect(fromBase32(toBase32(Buffer.from(text, 'ascii'))).toString('ascii')).toBe(text);
    }
  });

  it('accepts a secret typed back with spaces, dashes or lower case', () => {
    // An admin types this off a screen. It has to survive being typed.
    const secret = newTotpSecret();
    const messy = formatSecretForEntry(secret).toLowerCase();
    expect(fromBase32(messy).equals(fromBase32(secret))).toBe(true);
  });

  it('refuses a character outside the alphabet rather than skipping it', () => {
    // Skipping would derive a *different* key and report "wrong code", sending
    // an admin to check their clock when the real fault is a mistyped key.
    expect(() => fromBase32('ABCD!EFG')).toThrow(/Invalid base32/);
  });
});

describe('secrets', () => {
  it('is 160 bits, as the RFC recommends for SHA-1', () => {
    const secret = newTotpSecret();
    expect(fromBase32(secret)).toHaveLength(20);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('is different every time', () => {
    const secrets = new Set(Array.from({ length: 200 }, () => newTotpSecret()));
    expect(secrets.size).toBe(200);
  });
});

describe('verifying', () => {
  const secret = newTotpSecret();
  const now = Date.parse('2026-08-30T12:00:00.000Z');

  it('accepts the current code', () => {
    expect(verifyTotp(secret, totpAt(secret, now), now)).toBe(true);
  });

  it('accepts one step either side, because clocks drift and people type slowly', () => {
    const step = TOTP_STEP_SECONDS * 1000;
    expect(verifyTotp(secret, totpAt(secret, now - step), now)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, now + step), now)).toBe(true);
  });

  it('refuses two steps away — an observed code must stop working', () => {
    const step = TOTP_STEP_SECONDS * 1000;
    expect(verifyTotp(secret, totpAt(secret, now - 2 * step), now)).toBe(false);
    expect(verifyTotp(secret, totpAt(secret, now + 2 * step), now)).toBe(false);
  });

  it('refuses a code from a different secret', () => {
    expect(verifyTotp(secret, totpAt(newTotpSecret(), now), now)).toBe(false);
  });

  it('refuses anything that is not six digits', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', '  ', '000000x']) {
      expect(verifyTotp(secret, bad, now), bad).toBe(false);
    }
  });

  it('tolerates a code typed with a space in the middle', () => {
    const code = totpAt(secret, now);
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(true);
  });

  it('changes every thirty seconds', () => {
    // If it did not, an observed code would work indefinitely.
    const step = TOTP_STEP_SECONDS * 1000;
    const seen = new Set(Array.from({ length: 20 }, (_, i) => totpAt(secret, now + i * step)));
    expect(seen.size).toBeGreaterThan(15);
  });

  it('is stable inside one step', () => {
    // Two codes derived a second apart within the same window must agree, or
    // an admin typing slowly would be refused for no reason.
    expect(totpAt(secret, now)).toBe(totpAt(secret, now + 1000));
  });
});

describe('the enrolment URI', () => {
  it('carries what an authenticator app needs', () => {
    const secret = newTotpSecret();
    const uri = totpUri(secret, 'owner@telga.example');
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('issuer=Telga');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });

  it('names the account, so an admin with several can tell them apart', () => {
    // A list of identical "Telga" entries is how somebody types the wrong code
    // three times and locks themselves out.
    const uri = totpUri(newTotpSecret(), 'finance@telga.example');
    expect(decodeURIComponent(uri)).toContain('Telga:finance@telga.example');
  });
});
