/**
 * Inactivity sign-out.
 *
 * Two independent mechanisms, tested separately because either alone would be
 * insufficient:
 *
 *   1. **The server** expires the session on its own clock and refuses the
 *      next request. This is the authority — it holds even with scripting
 *      off, a hostile client, or a tab that never runs the watcher.
 *   2. **The client** watcher makes that expiry visible rather than leaving a
 *      dead screen showing a stale balance.
 *
 * The interesting case is background polling: a screen left open on a counter
 * polls a pending transaction, and if that renewed the idle window the
 * session would never expire while the tab was open — defeating the whole
 * feature.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  authenticate,
  logout,
  revokeDevice as revokeDeviceService,
  BACKGROUND_REQUEST_HEADER,
  TRAINING_SESSION_POLICY,
} from '@telga/api';
import { renderScreen } from '@telga/merchant-pos';
import type { PosServerOptions } from '@telga/merchant-pos';
import { MOCK_BEHAVIOURS } from '@telga/provider-mock-airtime';
import { advance, callWith, cookieFor, makeUiHarness, reasonOf, signInAs } from './helpers';
import type { UiHarness } from './helpers';

let harness: UiHarness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

const IDLE_MS = TRAINING_SESSION_POLICY.idleTimeoutMs;

function optionsFor(h: UiHarness): PosServerOptions {
  return {
    api: h.api,
    environment: 'test',
    catalog: [
      { productId: 'AIRTIME', label: 'Airtime 25 (simulated)', amountMinor: 2500, available: true },
    ],
    simulatedBehaviours: [...MOCK_BEHAVIOURS],
  };
}

describe('the training idle window', () => {
  it('is fifteen minutes', () => {
    expect(IDLE_MS).toBe(15 * 60_000);
  });

  it('expires the session once the window passes with no activity', async () => {
    harness = makeUiHarness('idle-expires', { sessionPolicy: TRAINING_SESSION_POLICY });
    const session = await signInAs(harness.api);

    // Still valid just inside the window. The probe must not renew, or it
    // would slide the deadline it is trying to observe.
    advance(harness, IDLE_MS - 1_000);
    expect(
      authenticate(harness.api, session.sessionToken, 'corr_a', { extendIdle: false }).ok,
    ).toBe(true);

    // Past it, refused.
    advance(harness, 2_000);
    const result = authenticate(harness.api, session.sessionToken, 'corr_b');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SESSION_IDLE_EXPIRED');
      // A merchant is sent to sign in again rather than shown access-denied.
      expect(result.reauthenticate).toBe(true);
    }
  });

  it('real activity resets the timer, so an active operator is never signed out', async () => {
    harness = makeUiHarness('idle-activity-resets', { sessionPolicy: TRAINING_SESSION_POLICY });
    const session = await signInAs(harness.api);

    // Four requests, each 40s apart. Total elapsed is 160s — well past a
    // single 60s window — but no gap ever reaches 60s.
    for (let i = 0; i < 4; i += 1) {
      advance(harness, 40_000);
      const { response } = await callWith(harness.api, 'GET', '/api/training/balance', {
        cookie: cookieFor(session.sessionToken),
      });
      expect(response.status, `request ${String(i)}`).toBe(200);
    }
  });

  it('an expired session is revoked, so the token stays dead afterwards', async () => {
    harness = makeUiHarness('idle-revokes', { sessionPolicy: TRAINING_SESSION_POLICY });
    const session = await signInAs(harness.api);

    advance(harness, IDLE_MS + 1_000);
    expect(authenticate(harness.api, session.sessionToken, 'corr_expire').ok).toBe(false);

    // Rolling the clock back would not help: the row itself is revoked.
    const result = authenticate(harness.api, session.sessionToken, 'corr_after');
    expect(result.ok).toBe(false);

    const { response, envelope } = await callWith(harness.api, 'GET', '/api/training/balance', {
      cookie: cookieFor(session.sessionToken),
    });
    expect(response.status).toBe(401);
    expect(reasonOf(envelope)).toMatch(/SESSION_/);
  });
});

describe('background polling does not count as activity', () => {
  it('a marked background request validates the session but does not renew it', async () => {
    harness = makeUiHarness('idle-background-poll', { sessionPolicy: TRAINING_SESSION_POLICY });
    const session = await signInAs(harness.api);

    // Poll right through the idle window. **Derived from the policy, not a
    // fixed 80 seconds**: the original hard-coded four polls of 20s, which
    // outlasted a one-minute window and stopped outlasting anything when the
    // window was raised to fifteen minutes — the test kept passing its own
    // arithmetic and stopped testing the property. Now it always polls past
    // whatever the window is.
    const step = 20_000;
    const polls = Math.ceil(IDLE_MS / step) + 1;
    for (let i = 0; i < polls; i += 1) {
      advance(harness, step);
      await callWith(harness.api, 'GET', '/api/training/balance', {
        cookie: cookieFor(session.sessionToken),
        headers: { [BACKGROUND_REQUEST_HEADER]: '1' },
      });
    }

    const result = authenticate(harness.api, session.sessionToken, 'corr_after_polls');
    expect(result.ok, 'polling must not keep an unattended screen signed in').toBe(false);
  });

  it('a background request still succeeds while the session is alive', async () => {
    harness = makeUiHarness('idle-background-valid', { sessionPolicy: TRAINING_SESSION_POLICY });
    const session = await signInAs(harness.api);
    advance(harness, 20_000);

    const { response } = await callWith(harness.api, 'GET', '/api/training/balance', {
      cookie: cookieFor(session.sessionToken),
      headers: { [BACKGROUND_REQUEST_HEADER]: '1' },
    });
    // Validated normally — only the sliding is suppressed.
    expect(response.status).toBe(200);
  });

  it('an unmarked request renews normally, so the marker is what matters', async () => {
    harness = makeUiHarness('idle-unmarked-renews', { sessionPolicy: TRAINING_SESSION_POLICY });
    const session = await signInAs(harness.api);

    for (let i = 0; i < 4; i += 1) {
      advance(harness, 20_000);
      await callWith(harness.api, 'GET', '/api/training/balance', {
        cookie: cookieFor(session.sessionToken),
      });
    }
    expect(authenticate(harness.api, session.sessionToken, 'corr_unmarked').ok).toBe(true);
  });
});

describe('an idle timeout signs out the operator, not the device', () => {
  it('revokes the session but leaves the device enrolled', async () => {
    harness = makeUiHarness('idle-device-survives', { sessionPolicy: TRAINING_SESSION_POLICY });
    const session = await signInAs(harness.api);

    const before = harness.driver.findDeviceEnrollment(session.deviceId);
    expect(before?.enrollment_state).toBe('ENROLLED');

    advance(harness, IDLE_MS + 1_000);
    expect(authenticate(harness.api, session.sessionToken, 'corr_idle').ok).toBe(false);

    // The enrolment row is untouched: same state, same enrolment time, no
    // revocation. An idle operator is not an untrusted device.
    const after = harness.driver.findDeviceEnrollment(session.deviceId);
    expect(after?.enrollment_state).toBe('ENROLLED');
    expect(after?.revoked_at ?? null).toBeNull();
    expect(after?.enrolled_at).toBe(before?.enrolled_at);
    expect(after?.secret_hash).toBe(before?.secret_hash);
  });

  it('lets the operator sign in again afterwards with no reprovisioning', async () => {
    harness = makeUiHarness('idle-relogin', { sessionPolicy: TRAINING_SESSION_POLICY });
    const first = await signInAs(harness.api);
    advance(harness, IDLE_MS + 1_000);
    expect(authenticate(harness.api, first.sessionToken, 'corr_dead').ok).toBe(false);

    // Same device, same operator, same PIN — a fresh session is issued.
    const second = await signInAs(harness.api);
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.sessionToken).not.toBe(first.sessionToken);
    expect(authenticate(harness.api, second.sessionToken, 'corr_alive').ok).toBe(true);
  });

  it('explicit logout also leaves the device enrolled', async () => {
    harness = makeUiHarness('logout-device-survives', { sessionPolicy: TRAINING_SESSION_POLICY });
    const session = await signInAs(harness.api);
    const auth = authenticate(harness.api, session.sessionToken, 'corr_pre_logout');
    if (!auth.ok) throw new Error('fixture session refused');

    logout(harness.api, auth.context, 'corr_logout');
    expect(authenticate(harness.api, session.sessionToken, 'corr_post_logout').ok).toBe(false);

    const enrolment = harness.driver.findDeviceEnrollment(session.deviceId);
    expect(enrolment?.enrollment_state).toBe('ENROLLED');
    expect(enrolment?.revoked_at ?? null).toBeNull();
  });

  it('device revocation stays a separate, explicit operation', async () => {
    harness = makeUiHarness('device-revoke-separate', { sessionPolicy: TRAINING_SESSION_POLICY });
    const session = await signInAs(harness.api);

    // Neither idling nor logging out revokes it...
    advance(harness, IDLE_MS + 1_000);
    expect(harness.driver.findDeviceEnrollment(session.deviceId)?.enrollment_state).toBe('ENROLLED');

    // ...only the explicit administrative call does.
    revokeDeviceService(harness.api, {
      deviceId: session.deviceId,
      merchantId: session.merchantId,
      reason: 'TEST_EXPLICIT_REVOKE',
      actor: { userId: 'system', role: 'ADMIN' },
      correlationId: 'corr_revoke',
    });
    expect(harness.driver.findDeviceEnrollment(session.deviceId)?.enrollment_state).toBe('REVOKED');
  });
});

describe('the client-side watcher', () => {
  it('is present on an authenticated screen, carrying the server timeout', async () => {
    harness = makeUiHarness('idle-watcher-present', { sessionPolicy: TRAINING_SESSION_POLICY });
    const session = await signInAs(harness.api);
    const auth = authenticate(harness.api, session.sessionToken, 'corr_render');
    if (!auth.ok) throw new Error('fixture session refused');

    const screen = await renderScreen(optionsFor(harness), {
      path: '/',
      query: new URLSearchParams(),
      context: auth.context,
      cookieHeader: session.cookieHeader,
      csrfToken: session.csrfToken,
    });

    // Seconds, not milliseconds — so the attribute can never be a six-digit
    // run that the PIN guard below has to tell apart from a real PIN.
    expect(screen?.html).toContain(`data-idle-timeout-s="${String(Math.round(IDLE_MS / 1000))}"`);
    expect(screen?.html).toContain('/login?error=SESSION_IDLE_EXPIRED');
    // The poll marks itself background so it cannot defeat the watcher.
    expect(screen?.html).toContain("'x-telga-background': '1'");
    // Reset happens on interaction, never on a timer or a load.
    expect(screen?.html).toContain('pointerdown');
    expect(screen?.html).toContain('keydown');
  });

  it('never leaks a PIN, device key, or session token into the page', async () => {
    harness = makeUiHarness('idle-watcher-no-secrets', { sessionPolicy: TRAINING_SESSION_POLICY });
    const session = await signInAs(harness.api);
    const auth = authenticate(harness.api, session.sessionToken, 'corr_secrets');
    if (!auth.ok) throw new Error('fixture session refused');

    const screen = await renderScreen(optionsFor(harness), {
      path: '/',
      query: new URLSearchParams(),
      context: auth.context,
      cookieHeader: session.cookieHeader,
      csrfToken: session.csrfToken,
    });
    expect(screen?.html).not.toContain(session.sessionToken);
    expect(screen?.html).not.toMatch(/\b\d{6}\b/);
  });
});
