/**
 * The code emailed to an administrator after email and password.
 *
 * The founder's sign-in design: email and password get a code, a biometric
 * passkey does not — a passkey is already device plus person, and adding a
 * code to it would be a third factor on the strong path and a second on the
 * weak one.
 *
 * A six-digit code is a million possibilities, which is a small number if a
 * caller may guess indefinitely. Three bounds hold it — hashed at rest,
 * attempt-limited, short-lived — and the tests below are mostly about what
 * happens when each is pushed.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_OTP_ATTEMPTS,
  OTP_LENGTH,
  OTP_TTL_MS,
  codesEqual,
  issueEmailOtp,
  newOtpCode,
  noSenderConfigured,
  resendRefused,
  verifyEmailOtp,
} from '@telga/api';
import type { OtpRecord } from '@telga/api';

const NOW = '2026-09-08T09:00:00.000Z';
const later = (ms: number): string => new Date(Date.parse(NOW) + ms).toISOString();

const recordFor = async (over: Partial<OtpRecord> = {}): Promise<{ code: string; record: OtpRecord }> => {
  const issued = await issueEmailOtp(NOW);
  return {
    code: issued.code,
    record: {
      hash: issued.hash,
      salt: issued.salt,
      expiresAt: issued.expiresAt,
      attempts: 0,
      ...over,
    },
  };
};

describe('the code itself', () => {
  it('is six digits, and keeps its leading zeros', () => {
    // Dropping a leading zero would quietly shrink the space by a tenth.
    let sawLeadingZero = false;
    for (let i = 0; i < 2_000; i += 1) {
      const code = newOtpCode();
      expect(code).toMatch(/^\d{6}$/);
      expect(code).toHaveLength(OTP_LENGTH);
      if (code.startsWith('0')) sawLeadingZero = true;
    }
    expect(sawLeadingZero, 'leading zeros must be possible').toBe(true);
  });

  it('is not predictable from the codes before it', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i += 1) seen.add(newOtpCode());
    // Collisions are expected in 2,000 draws from a million; a generator with a
    // short period would show far fewer distinct values than this.
    expect(seen.size).toBeGreaterThan(1_950);
  });

  it('never returns the plaintext from storage', async () => {
    // The stored form is a hash. Nothing in the module reads a code back out.
    const { code, record } = await recordFor();
    expect(JSON.stringify(record)).not.toContain(code);
  });

  it('expires ten minutes after issue', async () => {
    const issued = await issueEmailOtp(NOW);
    expect(Date.parse(issued.expiresAt) - Date.parse(NOW)).toBe(OTP_TTL_MS);
  });
});

describe('verifying a code', () => {
  it('accepts the right one', async () => {
    const { code, record } = await recordFor();
    await expect(verifyEmailOtp(code, record, NOW)).resolves.toEqual({ ok: true });
  });

  it('refuses the wrong one', async () => {
    const { code, record } = await recordFor();
    const wrong = code === '000000' ? '111111' : '000000';
    await expect(verifyEmailOtp(wrong, record, NOW)).resolves.toEqual({
      ok: false,
      refusal: 'CODE_INCORRECT',
    });
  });

  it('refuses when there is no code outstanding', async () => {
    await expect(verifyEmailOtp('123456', undefined, NOW)).resolves.toEqual({
      ok: false,
      refusal: 'NO_CODE_OUTSTANDING',
    });
  });

  it('refuses an expired code, even the correct one', async () => {
    const { code, record } = await recordFor();
    const afterExpiry = later(OTP_TTL_MS + 1);
    await expect(verifyEmailOtp(code, record, afterExpiry)).resolves.toEqual({
      ok: false,
      refusal: 'CODE_EXPIRED',
    });
  });

  it('accepts right up to the expiry and not one moment after', async () => {
    const { code, record } = await recordFor();
    await expect(verifyEmailOtp(code, record, later(OTP_TTL_MS - 1))).resolves.toEqual({ ok: true });
    await expect(verifyEmailOtp(code, record, later(OTP_TTL_MS))).resolves.toMatchObject({
      ok: false,
      refusal: 'CODE_EXPIRED',
    });
  });

  it('stops accepting after five wrong guesses, correct code included', async () => {
    // The bound that actually stops a million guesses. Five wrong attempts kill
    // **the code**, not the account — locking the account would hand anybody who
    // knows an administrator's email a denial-of-service button.
    const { code, record } = await recordFor({ attempts: MAX_OTP_ATTEMPTS });
    await expect(verifyEmailOtp(code, record, NOW)).resolves.toEqual({
      ok: false,
      refusal: 'TOO_MANY_ATTEMPTS',
    });
  });

  it('checks the cheap refusals before the expensive one', async () => {
    // Expiry and the attempt limit are settled before any scrypt derivation, so
    // a dead code costs nothing to refuse and cannot be used to keep the
    // comparison warm.
    const { code, record } = await recordFor({ attempts: MAX_OTP_ATTEMPTS });
    const started = Date.now();
    await verifyEmailOtp(code, { ...record, expiresAt: NOW }, later(1));
    // A scrypt derivation at these parameters is tens of milliseconds; a
    // short-circuit is sub-millisecond. The margin is generous so this does not
    // become a timing-sensitive flake on a loaded machine.
    expect(Date.now() - started).toBeLessThan(25);
  });

  it('refuses anything that is not six digits without hashing it', async () => {
    const { record } = await recordFor();
    for (const junk of ['', '12345', '1234567', 'abcdef', '12 34 56', '١٢٣٤٥٦']) {
      await expect(verifyEmailOtp(junk, record, NOW), junk).resolves.toEqual({
        ok: false,
        refusal: 'CODE_INCORRECT',
      });
    }
  });
});

describe('resending', () => {
  it('refuses a second send within thirty seconds', async () => {
    // Otherwise a caller who knows an address can make Telga mail it as fast as
    // they can press a button.
    expect(resendRefused(NOW, later(1_000))).toBe(true);
    expect(resendRefused(NOW, later(29_999))).toBe(true);
    expect(resendRefused(NOW, later(30_000))).toBe(false);
  });

  it('allows the first send, when nothing has been sent yet', () => {
    expect(resendRefused(undefined, NOW)).toBe(false);
  });
});

describe('delivery', () => {
  it('refuses to pretend a code was sent when no sender is configured', async () => {
    // A console that issues codes nobody receives locks every administrator out
    // while looking like a working system. The failure is loud and names what
    // is missing.
    await expect(
      noSenderConfigured.send({ to: 'a@b.example', code: '123456', expiresAt: NOW }),
    ).rejects.toThrow(/No email sender is configured/);
  });

  it('points at the path that still works', async () => {
    // A passkey needs no code, so an administrator is not locked out by a
    // missing sender — and the error says so rather than leaving them stuck.
    await expect(
      noSenderConfigured.send({ to: 'a@b.example', code: '123456', expiresAt: NOW }),
    ).rejects.toThrow(/passkey/);
  });
});

describe('comparing two plaintext codes', () => {
  it('is length-safe and value-correct', () => {
    expect(codesEqual('123456', '123456')).toBe(true);
    expect(codesEqual('123456', '123457')).toBe(false);
    expect(codesEqual('123456', '12345')).toBe(false);
    expect(codesEqual('', '')).toBe(true);
  });
});
