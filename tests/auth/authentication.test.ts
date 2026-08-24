/**
 * Signing in, staying signed in, and stopping being signed in.
 *
 * The tests that matter most here are the negative ones. A sign-in that works
 * is easy; what protects a merchant's balance is that a wrong PIN, an expired
 * session, a revoked session and a token pasted into a URL all fail — and that
 * none of them leaves a raw PIN or a session token anywhere on disk.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { pinRejection } from '@telga/domain';
import { deriveSecret, tokenFingerprint, verifySecret } from '@telga/api';
import {
  DEVICE_A,
  OPERATOR_A,
  TEST_PIN,
  WRONG_PIN,
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

async function ready(name: string): Promise<{ h: UiHarness; deviceSecret: string }> {
  harness = makeUiHarness(name);
  await provisionOperator(harness.api);
  const deviceSecret = await enrolTestDevice(harness.api);
  return { h: harness, deviceSecret };
}

describe('signing in', () => {
  it('accepts the correct PIN on an enrolled device', async () => {
    const { h, deviceSecret } = await ready('login-ok');
    const result = await login(
      h.api,
      { userId: OPERATOR_A, pin: TEST_PIN, deviceId: DEVICE_A, deviceSecret },
      'corr_1',
    );
    if (!result.ok) throw new Error(`expected success, got ${result.code}`);
    expect(result.context.merchantId).toBe('merchant_alpha');
    expect(result.context.role).toBe('MERCHANT_OPERATOR');
    expect(result.sessionToken.length).toBeGreaterThan(20);
    expect(result.csrfToken).not.toBe(result.sessionToken);
  });

  it('refuses the wrong PIN', async () => {
    const { h, deviceSecret } = await ready('login-wrong-pin');
    const result = await login(
      h.api,
      { userId: OPERATOR_A, pin: WRONG_PIN, deviceId: DEVICE_A, deviceSecret },
      'corr_1',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_CREDENTIALS');
  });

  it('refuses an unknown operator with the same code as a wrong PIN', async () => {
    const { h, deviceSecret } = await ready('login-unknown-user');
    const unknown = await login(
      h.api,
      { userId: 'operator_nobody' as typeof OPERATOR_A, pin: TEST_PIN, deviceId: DEVICE_A, deviceSecret },
      'corr_1',
    );
    const wrongPin = await login(
      h.api,
      { userId: OPERATOR_A, pin: WRONG_PIN, deviceId: DEVICE_A, deviceSecret },
      'corr_2',
    );
    if (unknown.ok || wrongPin.ok) throw new Error('both should refuse');
    // Identical, so a caller cannot enumerate operator ids by reading codes.
    expect(unknown.code).toBe(wrongPin.code);
  });

  it('refuses the wrong device key even with the right PIN', async () => {
    const { h } = await ready('login-wrong-device-key');
    const result = await login(
      h.api,
      { userId: OPERATOR_A, pin: TEST_PIN, deviceId: DEVICE_A, deviceSecret: 'not-the-key' },
      'corr_1',
    );
    if (result.ok) throw new Error('should not sign in');
    expect(result.code).toBe('INVALID_CREDENTIALS');
  });

  it('refuses a suspended operator', async () => {
    harness = makeUiHarness('login-suspended');
    await provisionOperator(harness.api, { status: 'SUSPENDED' });
    const deviceSecret = await enrolTestDevice(harness.api);
    const result = await login(
      harness.api,
      { userId: OPERATOR_A, pin: TEST_PIN, deviceId: DEVICE_A, deviceSecret },
      'corr_1',
    );
    if (result.ok) throw new Error('should not sign in');
    expect(result.code).toBe('USER_SUSPENDED');
  });
});

describe('what reaches storage', () => {
  it('never stores the raw PIN, and the stored hash does not contain it', async () => {
    const { h } = await ready('no-raw-pin');
    const row = h.driver.findMerchantUser(OPERATOR_A);
    if (!row) throw new Error('operator should exist');

    expect(row.pin_hash).not.toContain(TEST_PIN);
    expect(row.pin_salt).not.toContain(TEST_PIN);
    expect(row.pin_hash).not.toBe(TEST_PIN);
    expect(row.pin_params).toMatch(/^scrypt\$N=\d+,r=\d+,p=\d+,len=\d+$/);

    // And no column anywhere in the row holds it.
    for (const value of Object.values(row)) {
      if (typeof value === 'string') expect(value).not.toBe(TEST_PIN);
    }
  });

  it('has no raw PIN anywhere in the database file', async () => {
    const { h } = await ready('no-pin-in-db');
    const tables = h.driver.unsafeConnection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];

    for (const { name } of tables) {
      const rows = h.driver.unsafeConnection.prepare(`SELECT * FROM "${name}"`).all() as Record<
        string,
        unknown
      >[];
      for (const row of rows) {
        for (const value of Object.values(row)) {
          if (typeof value === 'string') {
            expect(value.includes(TEST_PIN), `${name} carried the raw PIN`).toBe(false);
          }
        }
      }
    }
  });

  it('stores only a fingerprint of the session token, never the token', async () => {
    const { h, deviceSecret } = await ready('no-raw-token');
    const result = await login(
      h.api,
      { userId: OPERATOR_A, pin: TEST_PIN, deviceId: DEVICE_A, deviceSecret },
      'corr_1',
    );
    if (!result.ok) throw new Error('should sign in');

    const stored = h.driver.findSession(tokenFingerprint(result.sessionToken));
    expect(stored).toBeDefined();
    expect(stored?.id).not.toBe(result.sessionToken);

    // The raw token appears in no row of the sessions table.
    const rows = h.driver.unsafeConnection.prepare('SELECT * FROM sessions').all() as Record<
      string,
      unknown
    >[];
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (typeof value === 'string') expect(value).not.toBe(result.sessionToken);
      }
    }
  });

  it('derives a different hash for the same PIN each time it is set', async () => {
    const first = await deriveSecret(TEST_PIN);
    const second = await deriveSecret(TEST_PIN);
    // Per-user salt: two operators with the same PIN do not share a hash, so a
    // leaked table cannot be attacked once for everybody.
    expect(first.hash).not.toBe(second.hash);
    expect(first.salt).not.toBe(second.salt);
    expect(await verifySecret(TEST_PIN, first)).toBe(true);
    expect(await verifySecret(TEST_PIN, second)).toBe(true);
    expect(await verifySecret(WRONG_PIN, first)).toBe(false);
  });

  it('fails closed on a corrupted stored hash rather than throwing', async () => {
    expect(await verifySecret(TEST_PIN, { hash: '', salt: '', params: 'nonsense' })).toBe(false);
    expect(await verifySecret(TEST_PIN, { hash: 'zzzz', salt: 'zz', params: '' })).toBe(false);
  });
});

describe('the PIN policy', () => {
  it('refuses PINs that are too short, too long, repeated or sequential', () => {
    expect(pinRejection('12345')).toBe('PIN_TOO_SHORT');
    expect(pinRejection('1234567890123')).toBe('PIN_TOO_LONG');
    expect(pinRejection('111111')).toBe('PIN_TOO_SIMPLE');
    expect(pinRejection('123456')).toBe('PIN_TOO_SIMPLE');
    expect(pinRejection('654321')).toBe('PIN_TOO_SIMPLE');
    expect(pinRejection('12a456')).toBe('PIN_NOT_NUMERIC');
    expect(pinRejection(TEST_PIN)).toBeUndefined();
  });
});

describe('lockout', () => {
  it('locks the operator after the configured number of failures', async () => {
    const { h, deviceSecret } = await ready('lockout');
    const max = h.api.authConfig.lockout.maxFailedAttempts;

    for (let i = 0; i < max; i += 1) {
      const attempt = await login(
        h.api,
        { userId: OPERATOR_A, pin: WRONG_PIN, deviceId: DEVICE_A, deviceSecret },
        `corr_${String(i)}`,
      );
      if (attempt.ok) throw new Error('should not sign in');
      expect(attempt.code).toBe('INVALID_CREDENTIALS');
    }

    // Now even the correct PIN is refused, and with a different code — the
    // operator needs to know to wait rather than to keep trying.
    const locked = await login(
      h.api,
      { userId: OPERATOR_A, pin: TEST_PIN, deviceId: DEVICE_A, deviceSecret },
      'corr_locked',
    );
    if (locked.ok) throw new Error('should be locked out');
    expect(locked.code).toBe('USER_LOCKED_OUT');
  });

  it('lets the operator back in once the lockout has passed', async () => {
    const { h, deviceSecret } = await ready('lockout-expiry');
    const max = h.api.authConfig.lockout.maxFailedAttempts;
    for (let i = 0; i < max; i += 1) {
      await login(
        h.api,
        { userId: OPERATOR_A, pin: WRONG_PIN, deviceId: DEVICE_A, deviceSecret },
        `corr_${String(i)}`,
      );
    }

    // The injected clock moves; nothing sleeps.
    advance(h, h.api.authConfig.lockout.lockoutMs + 1000);

    const result = await login(
      h.api,
      { userId: OPERATOR_A, pin: TEST_PIN, deviceId: DEVICE_A, deviceSecret },
      'corr_after',
    );
    if (!result.ok) throw new Error(`should sign in, got ${result.code}`);
    expect(result.context.userId).toBe(OPERATOR_A);
  });

  it('clears the failure counter after a correct PIN', async () => {
    const { h, deviceSecret } = await ready('lockout-reset');
    await login(
      h.api,
      { userId: OPERATOR_A, pin: WRONG_PIN, deviceId: DEVICE_A, deviceSecret },
      'corr_1',
    );
    expect(h.driver.findMerchantUser(OPERATOR_A)?.failed_attempts).toBe(1);

    await login(
      h.api,
      { userId: OPERATOR_A, pin: TEST_PIN, deviceId: DEVICE_A, deviceSecret },
      'corr_2',
    );
    expect(h.driver.findMerchantUser(OPERATOR_A)?.failed_attempts).toBe(0);
    expect(h.driver.findMerchantUser(OPERATOR_A)?.locked_until).toBeNull();
  });
});

describe('a session over its lifetime', () => {
  it('authenticates while it is live', async () => {
    harness = makeUiHarness('session-live');
    const session = await signInAs(harness.api);
    const result = authenticate(harness.api, session.sessionToken, 'corr_1');
    if (!result.ok) throw new Error(`should authenticate, got ${result.code}`);
    expect(result.context.merchantId).toBe('merchant_alpha');
  });

  it('refuses an unknown token', async () => {
    harness = makeUiHarness('session-unknown');
    await signInAs(harness.api);
    const result = authenticate(harness.api, 'not-a-real-token', 'corr_1');
    if (result.ok) throw new Error('should refuse');
    expect(result.code).toBe('SESSION_UNKNOWN');
    expect(result.reauthenticate).toBe(true);
  });

  it('refuses a missing token', async () => {
    harness = makeUiHarness('session-missing');
    const result = authenticate(harness.api, undefined, 'corr_1');
    if (result.ok) throw new Error('should refuse');
    expect(result.code).toBe('SESSION_MISSING');
  });

  it('expires after the idle timeout', async () => {
    harness = makeUiHarness('session-idle');
    const session = await signInAs(harness.api);
    advance(harness, harness.api.authConfig.session.idleTimeoutMs + 1000);

    const result = authenticate(harness.api, session.sessionToken, 'corr_1');
    if (result.ok) throw new Error('should refuse');
    expect(result.code).toBe('SESSION_IDLE_EXPIRED');
    expect(result.reauthenticate).toBe(true);
  });

  it('slides the idle window while it is used', async () => {
    harness = makeUiHarness('session-slide');
    const session = await signInAs(harness.api);
    const idle = harness.api.authConfig.session.idleTimeoutMs;

    // Three quarters of the way, then use it, three times over. A session that
    // did not slide would be dead by the third.
    for (let i = 0; i < 3; i += 1) {
      advance(harness, Math.floor(idle * 0.75));
      const result = authenticate(harness.api, session.sessionToken, `corr_${String(i)}`);
      expect(result.ok, `use ${String(i)}`).toBe(true);
    }
  });

  it('ends at the absolute lifetime however active it has been', async () => {
    harness = makeUiHarness('session-absolute');
    const session = await signInAs(harness.api);
    const idle = harness.api.authConfig.session.idleTimeoutMs;
    const absolute = harness.api.authConfig.session.absoluteLifetimeMs;

    // Keep it alive right up to the absolute limit.
    let elapsed = 0;
    while (elapsed + idle / 2 < absolute) {
      advance(harness, Math.floor(idle / 2));
      elapsed += Math.floor(idle / 2);
      authenticate(harness.api, session.sessionToken, 'corr_keepalive');
    }
    advance(harness, absolute - elapsed + 1000);

    const result = authenticate(harness.api, session.sessionToken, 'corr_final');
    if (result.ok) throw new Error('should have reached its lifetime');
    expect(result.code).toBe('SESSION_LIFETIME_EXPIRED');
  });

  it('is refused after logout', async () => {
    harness = makeUiHarness('session-logout');
    const session = await signInAs(harness.api);

    const out = await callWith(harness.api, 'POST', '/api/training/auth/logout', {
      cookie: cookieFor(session.sessionToken),
      csrf: session.csrfToken,
      body: {},
    });
    expect(out.response.status).toBe(200);

    const result = authenticate(harness.api, session.sessionToken, 'corr_1');
    if (result.ok) throw new Error('should be revoked');
    expect(result.code).toBe('SESSION_REVOKED');
  });

  it('clears both cookies on logout', async () => {
    harness = makeUiHarness('session-logout-cookies');
    const session = await signInAs(harness.api);
    const out = await callWith(harness.api, 'POST', '/api/training/auth/logout', {
      cookie: cookieFor(session.sessionToken),
      csrf: session.csrfToken,
      body: {},
    });
    const setCookie = out.response.headers['set-cookie'] ?? '';
    expect(setCookie).toContain('telga_session=');
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('telga_csrf=');
  });

  it('is refused when the session is revoked directly', async () => {
    harness = makeUiHarness('session-revoked');
    const session = await signInAs(harness.api);
    harness.driver.revokeSession(
      tokenFingerprint(session.sessionToken),
      'TEST_REVOCATION',
      harness.clock.now(),
    );

    const result = authenticate(harness.api, session.sessionToken, 'corr_1');
    if (result.ok) throw new Error('should be revoked');
    expect(result.code).toBe('SESSION_REVOKED');
  });
});

describe('how a session may be presented', () => {
  it('is never accepted from a query parameter', async () => {
    harness = makeUiHarness('token-in-url');
    const session = await signInAs(harness.api);

    const { response, envelope } = await callWith(
      harness.api,
      'GET',
      '/api/training/transactions',
      // The token in the URL, and no cookie at all.
      { query: { sessionToken: session.sessionToken, token: session.sessionToken } },
    );
    expect(response.status).toBe(401);
    expect(reasonOf(envelope)).toBe('SESSION_MISSING');
  });

  it('is never accepted from a header the page could set', async () => {
    harness = makeUiHarness('token-in-header');
    const session = await signInAs(harness.api);

    const { response } = await callWith(harness.api, 'GET', '/api/training/transactions', {
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    expect(response.status).toBe(401);
  });

  it('is marked HttpOnly and SameSite=Strict, and not Secure over plain HTTP', async () => {
    harness = makeUiHarness('cookie-attributes');
    await provisionOperator(harness.api);
    const deviceSecret = await enrolTestDevice(harness.api);

    const { response } = await callWith(harness.api, 'POST', '/api/training/auth/login', {
      body: { userId: OPERATOR_A, pin: TEST_PIN, deviceId: DEVICE_A, deviceSecret },
    });
    const setCookie = response.headers['set-cookie'] ?? '';
    const sessionCookie = setCookie.split('\n').find((c) => c.startsWith('telga_session='));
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Strict');
    expect(sessionCookie).toContain('Path=/');
    // The training config says plain HTTP, so claiming Secure would make a
    // browser drop the cookie and break sign-in. Stated, not assumed.
    expect(sessionCookie).not.toContain('Secure');
    // No browser-side lifetime: the server-side row owns both expiries.
    expect(sessionCookie).not.toContain('Max-Age');
  });

  it('rotates the session identifier on every sign-in', async () => {
    const { h, deviceSecret } = await ready('session-fixation');

    const first = await login(
      h.api,
      { userId: OPERATOR_A, pin: TEST_PIN, deviceId: DEVICE_A, deviceSecret },
      'corr_1',
    );
    const second = await login(
      h.api,
      { userId: OPERATOR_A, pin: TEST_PIN, deviceId: DEVICE_A, deviceSecret },
      'corr_2',
    );
    if (!first.ok || !second.ok) throw new Error('both should sign in');

    // A token planted on the client before sign-in is not the one that ends up
    // authenticating anything — which is what defeats session fixation.
    expect(second.sessionToken).not.toBe(first.sessionToken);
    expect(second.csrfToken).not.toBe(first.csrfToken);
    expect(second.context.sessionId).not.toBe(first.context.sessionId);
  });
});
