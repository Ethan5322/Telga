/**
 * Device binding.
 *
 * ## What these tests do and do not prove
 *
 * They prove that a session is refused unless the device is enrolled, active,
 * unexpired and assigned to the session's merchant — and that the check happens
 * on **every request**, not only at sign-in. That is what makes a revoked POS
 * stop working immediately rather than whenever its session happened to lapse.
 *
 * They do **not** prove the device is who it says it is. The identifier is a
 * string the client sends. Pairing it with a server-issued key and a
 * server-side enrolment record raises the cost of impersonation from "know the
 * id" to "hold the key", which is worth having — but a key can be copied to
 * another machine, and nothing here would notice. That is why the binding is
 * classified **training-grade**, and why `A50` stays open. See
 * `09 Engineering/Device Binding.md`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { deviceRejection } from '@telga/domain';
import { tokenFingerprint } from '@telga/api';
import {
  DEVICE_A,
  DEVICE_B,
  MERCHANT_A,
  MERCHANT_B,
  OPERATOR_A,
  OPERATOR_B,
  TEST_PIN,
  authenticate,
  callWith,
  cookieFor,
  enrolTestDevice,
  login,
  makeUiHarness,
  provisionOperator,
  reasonOf,
  signInAs,
  advance,
} from './helpers';
import type { UiHarness } from './helpers';

let harness: UiHarness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

describe('the enrolment decision, as pure domain logic', () => {
  const at = '2026-08-20T09:00:00.000Z' as never;
  const base = {
    deviceId: DEVICE_A,
    merchantId: MERCHANT_A,
    state: 'ENROLLED' as const,
    enrolledAt: at,
  };

  it('accepts an enrolled device assigned to the merchant', () => {
    expect(deviceRejection(base, MERCHANT_A, at)).toBeUndefined();
  });

  it('refuses an absent enrolment', () => {
    expect(deviceRejection(undefined, MERCHANT_A, at)).toBe('DEVICE_NOT_ENROLLED');
  });

  it('refuses a pending, revoked or expired enrolment', () => {
    expect(deviceRejection({ ...base, state: 'PENDING' }, MERCHANT_A, at)).toBe('DEVICE_NOT_ENROLLED');
    expect(deviceRejection({ ...base, state: 'REVOKED' }, MERCHANT_A, at)).toBe('DEVICE_REVOKED');
    expect(deviceRejection({ ...base, state: 'EXPIRED' }, MERCHANT_A, at)).toBe(
      'DEVICE_ENROLLMENT_EXPIRED',
    );
  });

  it('refuses an enrolment whose expiry has passed', () => {
    const expired = { ...base, expiresAt: '2026-08-20T08:59:59.000Z' as never };
    expect(deviceRejection(expired, MERCHANT_A, at)).toBe('DEVICE_ENROLLMENT_EXPIRED');
  });

  it('refuses a device enrolled to a different merchant', () => {
    expect(deviceRejection(base, MERCHANT_B, at)).toBe('DEVICE_NOT_ASSIGNED_TO_MERCHANT');
  });
});

describe('signing in with a device', () => {
  it('succeeds on an enrolled active device', async () => {
    harness = makeUiHarness('device-ok');
    const session = await signInAs(harness.api);
    expect(session.deviceId).toBe(DEVICE_A);
  });

  it('refuses an unknown device', async () => {
    harness = makeUiHarness('device-unknown');
    await provisionOperator(harness.api);
    const result = await login(
      harness.api,
      {
        userId: OPERATOR_A,
        pin: TEST_PIN,
        deviceId: 'device_never_enrolled' as typeof DEVICE_A,
        deviceSecret: 'anything',
      },
      'corr_1',
    );
    if (result.ok) throw new Error('should refuse');
    expect(result.code).toBe('DEVICE_NOT_ENROLLED');
  });

  it('refuses a revoked device', async () => {
    harness = makeUiHarness('device-revoked-login');
    await provisionOperator(harness.api);
    const deviceSecret = await enrolTestDevice(harness.api);
    harness.driver.revokeDevice(DEVICE_A, 'LOST_AT_THE_COUNTER', harness.clock.now());

    const result = await login(
      harness.api,
      { userId: OPERATOR_A, pin: TEST_PIN, deviceId: DEVICE_A, deviceSecret },
      'corr_1',
    );
    if (result.ok) throw new Error('should refuse');
    expect(result.code).toBe('DEVICE_REVOKED');
  });

  it('refuses a device enrolled to another merchant', async () => {
    harness = makeUiHarness('device-wrong-merchant', { seedSecondMerchant: true });
    await provisionOperator(harness.api, { userId: OPERATOR_A, merchantId: MERCHANT_A });
    // Enrolled to beta, used by alpha's operator.
    const deviceSecret = await enrolTestDevice(harness.api, {
      deviceId: DEVICE_B,
      merchantId: MERCHANT_B,
    });

    const result = await login(
      harness.api,
      { userId: OPERATOR_A, pin: TEST_PIN, deviceId: DEVICE_B, deviceSecret },
      'corr_1',
    );
    if (result.ok) throw new Error('should refuse');
    expect(result.code).toBe('DEVICE_NOT_ASSIGNED_TO_MERCHANT');
  });
});

describe('the binding is checked on every request', () => {
  it('stops a live session the moment its device is revoked', async () => {
    harness = makeUiHarness('device-revoked-midsession');
    const session = await signInAs(harness.api);

    // The session works.
    const before = await callWith(harness.api, 'GET', '/api/training/transactions', {
      cookie: cookieFor(session.sessionToken),
    });
    expect(before.response.status).toBe(200);

    harness.driver.revokeDevice(DEVICE_A, 'REPORTED_STOLEN', harness.clock.now());

    // And now it does not — without waiting for the session to expire.
    const after = await callWith(harness.api, 'GET', '/api/training/transactions', {
      cookie: cookieFor(session.sessionToken),
    });
    expect(after.response.status).toBe(403);
    expect(reasonOf(after.envelope)).toBe('DEVICE_REVOKED');
  });

  it('revokes the sessions a revoked device was carrying', async () => {
    harness = makeUiHarness('device-revoke-sessions');
    const session = await signInAs(harness.api);

    const result = harness.driver.revokeDevice(DEVICE_A, 'REPORTED_STOLEN', harness.clock.now());
    expect(result.revoked).toBe(true);
    expect(result.sessionsRevoked).toBe(1);

    const row = harness.driver.findSession(tokenFingerprint(session.sessionToken));
    expect(row?.status).toBe('REVOKED');
  });

  it('stops a live session when its device enrolment expires', async () => {
    harness = makeUiHarness('device-expiry-midsession');
    await provisionOperator(harness.api);
    const deviceSecret = await enrolTestDevice(harness.api);

    // Give the enrolment a short life, then sign in under it.
    const soon = new Date(new Date(harness.clock.now()).getTime() + 60_000).toISOString();
    harness.driver.saveDeviceEnrollment({
      deviceId: DEVICE_A,
      merchantId: MERCHANT_A,
      state: 'ENROLLED',
      secretHash: harness.driver.findDeviceEnrollment(DEVICE_A)!.secret_hash,
      secretSalt: harness.driver.findDeviceEnrollment(DEVICE_A)!.secret_salt,
      expiresAt: soon as never,
      at: harness.clock.now(),
    });

    const result = await login(
      harness.api,
      { userId: OPERATOR_A, pin: TEST_PIN, deviceId: DEVICE_A, deviceSecret },
      'corr_1',
    );
    if (!result.ok) throw new Error(`should sign in, got ${result.code}`);

    advance(harness, 61_000);
    const after = authenticate(harness.api, result.sessionToken, 'corr_2');
    if (after.ok) throw new Error('should refuse');
    expect(after.code).toBe('DEVICE_ENROLLMENT_EXPIRED');
  });
});

describe('reassignment and re-enrolment', () => {
  it('invalidates existing sessions when a device is re-enrolled', async () => {
    harness = makeUiHarness('device-reenrol');
    const session = await signInAs(harness.api);

    // A new enrolment means a new key, so anything still holding the old one
    // must stop working.
    const newSecret = await enrolTestDevice(harness.api);
    expect(newSecret.length).toBeGreaterThan(20);

    const result = authenticate(harness.api, session.sessionToken, 'corr_1');
    if (result.ok) throw new Error('the old session should be gone');
    expect(result.code).toBe('SESSION_REVOKED');
  });

  it('invalidates sessions when a device is reassigned to another merchant', async () => {
    harness = makeUiHarness('device-reassign', { seedSecondMerchant: true });
    const session = await signInAs(harness.api);

    // Reassignment is a revocation followed by a new enrolment. Doing it as a
    // quiet change of owner is exactly what the domain refuses.
    harness.driver.revokeDevice(DEVICE_A, 'REASSIGNED', harness.clock.now());
    await enrolTestDevice(harness.api, { deviceId: DEVICE_A, merchantId: MERCHANT_B });

    const result = authenticate(harness.api, session.sessionToken, 'corr_1');
    if (result.ok) throw new Error('the old session should be gone');
    // The session says alpha; the enrolment now says beta.
    expect(['SESSION_REVOKED', 'DEVICE_NOT_ASSIGNED_TO_MERCHANT']).toContain(result.code);
  });

  it('does not let a session issued for one device be replayed on another', async () => {
    harness = makeUiHarness('device-replay', { seedSecondMerchant: true });
    const alpha = await signInAs(harness.api);

    // The session row names device A. There is no field in a request that could
    // claim device B — the device is read from the session, not sent — so the
    // only replay available is to reuse the cookie, and that stays bound to A.
    const row = harness.driver.findSession(tokenFingerprint(alpha.sessionToken));
    expect(row?.device_id).toBe(DEVICE_A);

    const { response, envelope } = await callWith(
      harness.api,
      'GET',
      '/api/training/transactions',
      { cookie: cookieFor(alpha.sessionToken), query: { deviceId: DEVICE_B } },
    );
    // The query parameter is ignored entirely; the read is still device A's.
    expect(response.status).toBe(200);
    if (!envelope.ok) throw new Error('should be readable');
    const context = authenticate(harness.api, alpha.sessionToken, 'corr_1');
    if (!context.ok) throw new Error('should authenticate');
    expect(context.context.deviceId).toBe(DEVICE_A);
  });
});

describe('what enrolment stores', () => {
  it('never stores the device key in a recoverable form', async () => {
    harness = makeUiHarness('device-secret-storage');
    const secret = await enrolTestDevice(harness.api);
    const row = harness.driver.findDeviceEnrollment(DEVICE_A);
    if (!row) throw new Error('enrolment should exist');

    expect(row.secret_hash).not.toBe(secret);
    expect(row.secret_hash).not.toContain(secret);
    expect(row.secret_salt).not.toContain(secret);

    const rows = harness.driver.unsafeConnection
      .prepare('SELECT * FROM device_enrollments')
      .all() as Record<string, unknown>[];
    for (const r of rows) {
      for (const value of Object.values(r)) {
        if (typeof value === 'string') expect(value).not.toBe(secret);
      }
    }
  });

  it('records the last time a device was seen', async () => {
    harness = makeUiHarness('device-last-seen');
    const before = harness.driver.findDeviceEnrollment(DEVICE_A)?.last_seen_at ?? null;
    expect(before).toBeNull();

    await signInAs(harness.api);
    expect(harness.driver.findDeviceEnrollment(DEVICE_A)?.last_seen_at).not.toBeNull();
  });
});

describe('the training-grade limitation, stated as a test', () => {
  it('accepts a copied device key from anywhere, which is why this is not hardware attestation', async () => {
    harness = makeUiHarness('device-training-grade');
    await provisionOperator(harness.api);
    const deviceSecret = await enrolTestDevice(harness.api);

    // Nothing about the caller is checked beyond knowing the identifier and the
    // key. A second machine holding both is indistinguishable from the first.
    // This test exists so the limitation is visible in the suite rather than
    // only in a note — see A50 and `09 Engineering/Device Binding.md`.
    const first = await login(
      harness.api,
      { userId: OPERATOR_A, pin: TEST_PIN, deviceId: DEVICE_A, deviceSecret },
      'corr_1',
    );
    const second = await login(
      harness.api,
      { userId: OPERATOR_A, pin: TEST_PIN, deviceId: DEVICE_A, deviceSecret },
      'corr_2',
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });
});
