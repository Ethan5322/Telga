/**
 * CSRF, rate limits and request size.
 *
 * ## What CSRF protection is for here
 *
 * The session cookie is `SameSite=Strict`, which already stops a cross-origin
 * form post from carrying it. The CSRF token is the second lock, and it exists
 * because `SameSite` is a browser behaviour rather than a server guarantee: an
 * old browser, a misconfigured proxy or a same-site subdomain all weaken it,
 * and none of those weaken a token the server issued and stored a hash of.
 *
 * ## The invariant every failure here must hold
 *
 * A refused write creates **no transaction and no ledger entry**. Several tests
 * assert the residual is still zero afterwards, because "the request was
 * refused" and "nothing happened" are different claims and only the second one
 * protects a merchant's balance.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { newToken, revokeDevice as revokeDeviceService, tokenFingerprint } from '@telga/api';
import {
  DEVICE_A,
  MERCHANT_A,
  OPERATOR_A,
  TEST_PIN,
  WRONG_PIN,
  call,
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

const SALE_BODY = {
  productId: 'AIRTIME',
  amountMinor: 2500,
  recipient: '0900000000',
  clientRequestId: 'req_csrf',
};

describe('CSRF on browser writes', () => {
  it('accepts a valid token in the form body', async () => {
    harness = makeUiHarness('csrf-valid-body');
    const session = await signInAs(harness.api);

    const { response } = await callWith(harness.api, 'POST', '/api/training/sales', {
      cookie: cookieFor(session.sessionToken),
      body: { ...SALE_BODY, csrfToken: session.csrfToken },
    });
    expect(response.status).toBe(201);
  });

  it('accepts a valid token in the header', async () => {
    harness = makeUiHarness('csrf-valid-header');
    const session = await signInAs(harness.api);

    const { response } = await callWith(harness.api, 'POST', '/api/training/sales', {
      cookie: cookieFor(session.sessionToken),
      csrf: session.csrfToken,
      body: SALE_BODY,
    });
    expect(response.status).toBe(201);
  });

  it('refuses a missing token, and creates nothing', async () => {
    harness = makeUiHarness('csrf-missing');
    const session = await signInAs(harness.api);
    const before = harness.driver.findTransactionsByMerchant(MERCHANT_A).length;

    const { response, envelope } = await callWith(harness.api, 'POST', '/api/training/sales', {
      cookie: cookieFor(session.sessionToken),
      body: SALE_BODY,
    });

    expect(response.status).toBe(403);
    expect(reasonOf(envelope)).toBe('CSRF_TOKEN_MISSING');
    expect(harness.driver.findTransactionsByMerchant(MERCHANT_A).length).toBe(before);
    expect(harness.driver.ledgerResidualMinor()).toBe(0);
  });

  it('refuses a mismatched token, and creates nothing', async () => {
    harness = makeUiHarness('csrf-mismatch');
    const session = await signInAs(harness.api);
    const before = harness.driver.findTransactionsByMerchant(MERCHANT_A).length;

    const { response, envelope } = await callWith(harness.api, 'POST', '/api/training/sales', {
      cookie: cookieFor(session.sessionToken),
      csrf: newToken(),
      body: SALE_BODY,
    });

    expect(response.status).toBe(403);
    expect(reasonOf(envelope)).toBe('CSRF_TOKEN_INVALID');
    expect(harness.driver.findTransactionsByMerchant(MERCHANT_A).length).toBe(before);
    expect(harness.driver.ledgerResidualMinor()).toBe(0);
  });

  it('refuses another session token, so a token is bound to its own session', async () => {
    harness = makeUiHarness('csrf-cross-session');
    const first = await signInAs(harness.api);
    // A second sign-in for the same operator issues a different pair.
    const deviceSecret = await enrolTestDevice(harness.api);
    const second = await login(
      harness.api,
      { userId: OPERATOR_A, pin: TEST_PIN, deviceId: DEVICE_A, deviceSecret },
      'corr_2',
    );
    if (!second.ok) throw new Error('second sign-in should succeed');

    // The second sign-in re-enrolled the device, so the first session is gone —
    // use the second session's cookie with the *first* session's CSRF token.
    const { response, envelope } = await callWith(harness.api, 'POST', '/api/training/sales', {
      cookie: cookieFor(second.sessionToken),
      csrf: first.csrfToken,
      body: SALE_BODY,
    });
    expect(response.status).toBe(403);
    expect(reasonOf(envelope)).toBe('CSRF_TOKEN_INVALID');
  });

  it('refuses a token belonging to a session that has been revoked', async () => {
    harness = makeUiHarness('csrf-stale');
    const session = await signInAs(harness.api);
    harness.driver.revokeSession(
      tokenFingerprint(session.sessionToken),
      'TEST',
      harness.clock.now(),
    );

    const { response, envelope } = await callWith(harness.api, 'POST', '/api/training/sales', {
      cookie: cookieFor(session.sessionToken),
      csrf: session.csrfToken,
      body: SALE_BODY,
    });
    // Authentication fails first: a stale form is refused as a dead session
    // rather than as a token problem, which is the more useful answer.
    expect(response.status).toBe(401);
    expect(reasonOf(envelope)).toBe('SESSION_REVOKED');
  });

  it('does not require a token on a read', async () => {
    harness = makeUiHarness('csrf-not-on-reads');
    const session = await signInAs(harness.api);
    const { response } = await callWith(harness.api, 'GET', '/api/training/transactions', {
      cookie: cookieFor(session.sessionToken),
    });
    expect(response.status).toBe(200);
  });

  it('preserves idempotency: a CSRF failure then a retry is still one sale', async () => {
    harness = makeUiHarness('csrf-idempotency');
    const session = await signInAs(harness.api);
    const body = { ...SALE_BODY, clientRequestId: 'req_once' };

    // Refused: no token.
    const refused = await callWith(harness.api, 'POST', '/api/training/sales', {
      cookie: cookieFor(session.sessionToken),
      body,
    });
    expect(refused.response.status).toBe(403);

    // Accepted.
    const first = await callWith(harness.api, 'POST', '/api/training/sales', {
      cookie: cookieFor(session.sessionToken),
      csrf: session.csrfToken,
      body,
    });
    expect(first.response.status).toBe(201);

    // The same client request id again: still one sale.
    const second = await callWith<{ kind: string }>(harness.api, 'POST', '/api/training/sales', {
      cookie: cookieFor(session.sessionToken),
      csrf: session.csrfToken,
      body,
    });
    expect(second.response.status).toBe(201);
    if (!second.envelope.ok) throw new Error('should be a duplicate, not a refusal');
    expect(second.envelope.data.kind).toBe('DUPLICATE_REQUEST');

    expect(harness.driver.findTransactionsByMerchant(MERCHANT_A)).toHaveLength(1);
    expect(harness.driver.ledgerResidualMinor()).toBe(0);
  });
});

describe('login rate limiting', () => {
  it('refuses further attempts once the window limit is reached', async () => {
    harness = makeUiHarness('rate-login');
    await provisionOperator(harness.api);
    const deviceSecret = await enrolTestDevice(harness.api);
    const max = harness.api.authConfig.lockout.maxAttemptsPerWindow;

    let sawRateLimit = false;
    for (let i = 0; i <= max + 1; i += 1) {
      const result = await login(
        harness.api,
        { userId: OPERATOR_A, pin: WRONG_PIN, deviceId: DEVICE_A, deviceSecret },
        `corr_${String(i)}`,
      );
      if (!result.ok && result.code === 'RATE_LIMITED') {
        sawRateLimit = true;
        break;
      }
    }
    expect(sawRateLimit).toBe(true);
  });

  it('lets attempts through again once the window has passed', async () => {
    harness = makeUiHarness('rate-login-window');
    await provisionOperator(harness.api);
    const deviceSecret = await enrolTestDevice(harness.api);
    const config = harness.api.authConfig.lockout;

    for (let i = 0; i <= config.maxAttemptsPerWindow + 1; i += 1) {
      await login(
        harness.api,
        { userId: OPERATOR_A, pin: WRONG_PIN, deviceId: DEVICE_A, deviceSecret },
        `corr_${String(i)}`,
      );
    }

    // Past the rate window *and* past the lockout, so the correct PIN works.
    advance(harness, Math.max(config.rateWindowMs, config.lockoutMs) + 1000);
    const result = await login(
      harness.api,
      { userId: OPERATOR_A, pin: TEST_PIN, deviceId: DEVICE_A, deviceSecret },
      'corr_after',
    );
    if (!result.ok) throw new Error(`should sign in, got ${result.code}`);
    expect(result.context.userId).toBe(OPERATOR_A);
  });
});

describe('sale rate limiting', () => {
  it('refuses further sales once the session limit is reached, and posts nothing', async () => {
    harness = makeUiHarness('rate-sale', { fundBirr: 100_000 });
    const session = await signInAs(harness.api);
    const max = harness.api.authConfig.session.maxSalesPerWindow;

    let refusedAt = -1;
    for (let i = 0; i <= max + 1; i += 1) {
      const { response, envelope } = await callWith(harness.api, 'POST', '/api/training/sales', {
        cookie: cookieFor(session.sessionToken),
        csrf: session.csrfToken,
        body: { ...SALE_BODY, clientRequestId: `req_rate_${String(i)}` },
      });
      if (response.status === 429) {
        expect(reasonOf(envelope)).toBe('RATE_LIMITED');
        refusedAt = i;
        break;
      }
    }

    expect(refusedAt).toBeGreaterThan(0);
    // The limit bit, and the ledger is still balanced.
    expect(harness.driver.ledgerResidualMinor()).toBe(0);
    expect(harness.driver.findTransactionsByMerchant(MERCHANT_A).length).toBe(refusedAt);
  });

  it('allows sales again once the window has passed', async () => {
    harness = makeUiHarness('rate-sale-window', { fundBirr: 100_000 });
    const session = await signInAs(harness.api);
    const max = harness.api.authConfig.session.maxSalesPerWindow;

    for (let i = 0; i <= max + 1; i += 1) {
      await callWith(harness.api, 'POST', '/api/training/sales', {
        cookie: cookieFor(session.sessionToken),
        csrf: session.csrfToken,
        body: { ...SALE_BODY, clientRequestId: `req_w_${String(i)}` },
      });
    }

    advance(harness, harness.api.authConfig.session.saleRateWindowMs + 1000);

    const { response } = await callWith(harness.api, 'POST', '/api/training/sales', {
      cookie: cookieFor(session.sessionToken),
      csrf: session.csrfToken,
      body: { ...SALE_BODY, clientRequestId: 'req_after_window' },
    });
    expect(response.status).toBe(201);
  });
});

describe('request size', () => {
  it('refuses an oversized body with 413 and creates nothing', async () => {
    harness = makeUiHarness('size-limit');
    const session = await signInAs(harness.api);
    const before = harness.driver.findTransactionsByMerchant(MERCHANT_A).length;

    const { response, envelope } = await callWith(harness.api, 'POST', '/api/training/sales', {
      cookie: cookieFor(session.sessionToken),
      csrf: session.csrfToken,
      body: {
        ...SALE_BODY,
        clientRequestId: 'req_big',
        // Comfortably over the training limit.
        padding: 'x'.repeat(harness.api.authConfig.session.maxRequestBytes + 1000),
      },
    });

    expect(response.status).toBe(413);
    expect(reasonOf(envelope)).toBe('REQUEST_TOO_LARGE');
    expect(harness.driver.findTransactionsByMerchant(MERCHANT_A).length).toBe(before);
    expect(harness.driver.ledgerResidualMinor()).toBe(0);
  });

  it('refuses an oversized credential before it reaches the hash function', async () => {
    harness = makeUiHarness('size-credentials');
    await provisionOperator(harness.api);
    await enrolTestDevice(harness.api);

    const { response } = await call(harness.api, 'POST', '/api/training/auth/login', {
      anonymous: true,
      body: {
        userId: OPERATOR_A,
        pin: 'x'.repeat(2000),
        deviceId: DEVICE_A,
        deviceSecret: 'y'.repeat(2000),
      },
    });
    // Either the size gate or the credential-length gate; both refuse, and
    // neither spends a scrypt derivation on it.
    expect([401, 413]).toContain(response.status);
  });
});

describe('the audit trail', () => {
  it('records a refused sign-in without recording the PIN', async () => {
    harness = makeUiHarness('audit-login-failed');
    await provisionOperator(harness.api);
    const deviceSecret = await enrolTestDevice(harness.api);

    await login(
      harness.api,
      { userId: OPERATOR_A, pin: WRONG_PIN, deviceId: DEVICE_A, deviceSecret },
      'corr_1',
    );

    const events = harness.driver.readAuditEvents();
    const failed = events.filter((e) => e.event_type === 'AUTH_LOGIN_FAILED');
    expect(failed.length).toBeGreaterThan(0);

    // Nothing in the audit trail carries the PIN or the device key.
    for (const event of events) {
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain(WRONG_PIN);
      expect(serialized).not.toContain(TEST_PIN);
      expect(serialized).not.toContain(deviceSecret);
    }
  });

  it('records a successful sign-in and a sign-out', async () => {
    harness = makeUiHarness('audit-login-logout');
    const session = await signInAs(harness.api);
    await callWith(harness.api, 'POST', '/api/training/auth/logout', {
      cookie: cookieFor(session.sessionToken),
      csrf: session.csrfToken,
      body: {},
    });

    const types = harness.driver.readAuditEvents().map((e) => e.event_type);
    expect(types).toContain('AUTH_LOGIN_SUCCEEDED');
    expect(types).toContain('AUTH_LOGGED_OUT');
    expect(types).toContain('DEVICE_ENROLLED');
  });

  it('records a device rejection', async () => {
    harness = makeUiHarness('audit-device-rejected');
    const session = await signInAs(harness.api);
    harness.driver.revokeDevice(DEVICE_A, 'REPORTED_STOLEN', harness.clock.now());

    await callWith(harness.api, 'GET', '/api/training/transactions', {
      cookie: cookieFor(session.sessionToken),
    });

    // `DEVICE_REJECTED`, not `DEVICE_REVOKED`: the revocation here was a direct
    // repository call, and what is being audited is the *refusal* of a request
    // by an already-revoked device — which is the event worth having, because
    // it is the one that happens without anybody watching.
    const types = harness.driver.readAuditEvents().map((e) => e.event_type);
    expect(types).toContain('DEVICE_REJECTED');
  });

  it('records a device revocation performed through the service', async () => {
    harness = makeUiHarness('audit-device-revoked');
    await signInAs(harness.api);

    revokeDeviceService(harness.api, {
      deviceId: DEVICE_A,
      merchantId: MERCHANT_A,
      reason: 'REPORTED_STOLEN',
      actor: { userId: 'system', role: 'ADMIN' },
      correlationId: 'corr_revoke',
    });

    const types = harness.driver.readAuditEvents().map((e) => e.event_type);
    expect(types).toContain('DEVICE_REVOKED');
  });

  it('never writes a session token into the audit trail', async () => {
    harness = makeUiHarness('audit-no-token');
    const session = await signInAs(harness.api);
    await callWith(harness.api, 'GET', '/api/training/transactions', {
      cookie: cookieFor(session.sessionToken),
    });

    for (const event of harness.driver.readAuditEvents()) {
      expect(JSON.stringify(event)).not.toContain(session.sessionToken);
      expect(JSON.stringify(event)).not.toContain(session.csrfToken);
    }
  });
});
