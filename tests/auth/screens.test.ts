/**
 * The authentication screens, and the identity indicator.
 *
 * Same approach as the POS screen tests: render the element tree and query it
 * by role, label and test id. No DOM emulator, no browser — so these prove the
 * structure and the wording, and prove nothing about CSS or a screen reader.
 * That gap is A48, and it stays open.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  accessDeniedScreen,
  byRole,
  byTestId,
  deviceEnrolmentScreen,
  focusOrder,
  loginScreen,
  renderToHtml,
  safeErrorScreen,
  sessionExpiredScreen,
  textOf,
  accessibleName,
  homeScreen,
  RefusedNonTrainingAuthError,
} from '@telga/merchant-pos';
import type { AuthChrome } from '@telga/merchant-pos';
import { MERCHANT_A, TEST_PIN, makeUiHarness, signInAs } from './helpers';
import { chromeFor } from '../ui/helpers';
import type { UiHarness } from './helpers';

let harness: UiHarness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

const authChrome = (overrides: Partial<AuthChrome> = {}): AuthChrome => ({
  locale: 'en',
  environment: 'test',
  mode: 'TRAINING',
  serverTime: '2026-08-20T09:00:00.000Z',
  ...overrides,
});

describe('every authentication screen', () => {
  const screens = () => [
    { name: 'login', el: loginScreen({ chrome: authChrome() }) },
    { name: 'session expired', el: sessionExpiredScreen(authChrome(), 'SESSION_IDLE_EXPIRED') },
    { name: 'access denied', el: accessDeniedScreen(authChrome(), 'DEVICE_REVOKED', 'corr_1') },
    { name: 'safe error', el: safeErrorScreen(authChrome(), 'corr_1') },
    {
      name: 'enrolment',
      el: deviceEnrolmentScreen({
        chrome: authChrome(),
        merchantId: MERCHANT_A,
        csrfToken: 'csrf_1',
      }),
    },
  ];

  it('carries the training banner', () => {
    for (const { name, el } of screens()) {
      expect(byTestId(el, 'training-banner'), name).toBeDefined();
    }
  });

  it('says it is internal training only', () => {
    for (const { name, el } of screens()) {
      const notice = byTestId(el, 'training-only-notice');
      expect(notice, name).toBeDefined();
      expect(textOf(notice!), name).toContain('Internal training only');
    }
  });

  it('shows no merchant identity, because none has been proved', () => {
    for (const { name, el } of screens()) {
      if (name === 'enrolment') continue; // authenticated already
      expect(byTestId(el, 'identity-bar'), name).toBeUndefined();
      expect(renderToHtml(el), name).not.toContain('merchant_alpha');
    }
  });

  it('has exactly one first-level heading', () => {
    for (const { name, el } of screens()) {
      const headings = byRole(el, 'heading').filter((h) => h.tag === 'h1');
      expect(headings, name).toHaveLength(1);
    }
  });

  it('refuses to render outside training mode', () => {
    expect(() => loginScreen({ chrome: authChrome({ mode: 'LIVE' }) })).toThrow(
      RefusedNonTrainingAuthError,
    );
    expect(() => sessionExpiredScreen(authChrome({ mode: 'LIVE' }), 'X')).toThrow(
      RefusedNonTrainingAuthError,
    );
  });
});

describe('the login screen', () => {
  it('offers labelled fields for operator, PIN, device and device key', () => {
    const el = loginScreen({ chrome: authChrome() });
    for (const id of ['login-user', 'login-pin', 'login-device', 'login-device-secret']) {
      expect(byTestId(el, id), id).toBeDefined();
    }
    // Every control has a label element pointing at it.
    const labels = el.children.length > 0 ? renderToHtml(el) : '';
    for (const id of ['userId', 'pin', 'deviceId', 'deviceSecret']) {
      expect(labels).toContain(`for="${id}"`);
      expect(labels).toContain(`id="${id}"`);
    }
  });

  it('masks both secrets and turns autocomplete off for them', () => {
    const el = loginScreen({ chrome: authChrome() });
    for (const id of ['login-pin', 'login-device-secret']) {
      const field = byTestId(el, id);
      expect(field?.attrs['type'], id).toBe('password');
      expect(field?.attrs['autocomplete'], id).toBe('off');
    }
  });

  it('never echoes a submitted PIN or device key back into the form', () => {
    // The screen has no parameter for either, by construction: a refused attempt
    // cannot repopulate them because there is nowhere to put them.
    const el = loginScreen({ chrome: authChrome(), refusal: 'INVALID_CREDENTIALS' });
    const html = renderToHtml(el);
    expect(html).not.toContain(TEST_PIN);
    expect(byTestId(el, 'login-pin')?.attrs['value']).toBeUndefined();
    expect(byTestId(el, 'login-device-secret')?.attrs['value']).toBeUndefined();
  });

  it('states a refusal without saying which field was wrong', () => {
    const el = loginScreen({ chrome: authChrome(), refusal: 'INVALID_CREDENTIALS' });
    const refusal = byTestId(el, 'login-refusal');
    expect(refusal).toBeDefined();
    expect(refusal?.attrs['role']).toBe('alert');

    const text = textOf(refusal!);
    expect(text).toContain('refused');
    // No hint about which of the four inputs failed.
    expect(text).not.toMatch(/\bPIN was\b|\bunknown operator\b|\bno such user\b/i);
  });

  it('gives a lockout its own message, so the operator waits rather than retries', () => {
    const el = loginScreen({ chrome: authChrome(), refusal: 'USER_LOCKED_OUT' });
    expect(textOf(byTestId(el, 'login-refusal')!)).toContain('locked out');
  });

  it('gives a revoked device its own message, pointing at Telga', () => {
    const el = loginScreen({ chrome: authChrome(), refusal: 'DEVICE_REVOKED' });
    expect(textOf(byTestId(el, 'login-refusal')!)).toContain('withdrawn');
  });

  it('reaches every field and the submit button by keyboard, in order', () => {
    const el = loginScreen({ chrome: authChrome() });
    const order = focusOrder(el).map((e) => e.attrs['data-testid'] ?? e.tag);
    expect(order).toEqual([
      'login-user',
      'login-pin',
      'login-device',
      'login-device-secret',
      'login-submit',
    ]);
  });

  it('carries a return path as a hidden field, not in a visible control', () => {
    const el = loginScreen({ chrome: authChrome(), returnTo: '/queue' });
    expect(renderToHtml(el)).toContain('name="returnTo"');
    expect(focusOrder(el).map((e) => e.attrs['name'])).not.toContain('returnTo');
  });
});

describe('the session-expired screen', () => {
  it('reassures that no sale was affected', () => {
    const el = sessionExpiredScreen(authChrome(), 'SESSION_IDLE_EXPIRED');
    expect(textOf(byTestId(el, 'session-expired-detail')!)).toContain('No sale was affected');
  });

  it('offers a way back to sign in', () => {
    const el = sessionExpiredScreen(authChrome(), 'SESSION_IDLE_EXPIRED');
    expect(byTestId(el, 'to-login')?.attrs['href']).toBe('/login');
  });

  it('announces itself', () => {
    const el = sessionExpiredScreen(authChrome(), 'SESSION_IDLE_EXPIRED');
    expect(byTestId(el, 'session-expired')?.attrs['role']).toBe('alert');
  });
});

describe('the access-denied screen', () => {
  it('says signing in again will not help', () => {
    const el = accessDeniedScreen(authChrome(), 'DEVICE_REVOKED', 'corr_1');
    expect(textOf(byTestId(el, 'access-denied-detail')!)).toContain(
      'Signing in again will not change this',
    );
  });

  it('gives a support code to quote', () => {
    const el = accessDeniedScreen(authChrome(), 'PERMISSION_DENIED', 'corr_abc');
    expect(textOf(byTestId(el, 'access-denied-correlation')!)).toContain('corr_abc');
  });

  it('carries the reason as a safe code, not a sentence about internals', () => {
    const el = accessDeniedScreen(authChrome(), 'MERCHANT_SCOPE_MISMATCH', 'corr_1');
    expect(byTestId(el, 'access-denied')?.attrs['data-reason-code']).toBe(
      'MERCHANT_SCOPE_MISMATCH',
    );
  });
});

describe('the enrolment screen', () => {
  it('states that the device binding is training-grade', () => {
    const el = deviceEnrolmentScreen({
      chrome: authChrome(),
      merchantId: MERCHANT_A,
      csrfToken: 'csrf_1',
    });
    const hint = textOf(byTestId(el, 'enrol-hint')!);
    expect(hint).toContain('Training-grade');
    expect(hint).toContain('not proved by hardware');
  });

  it('carries a CSRF token in the form', () => {
    const el = deviceEnrolmentScreen({
      chrome: authChrome(),
      merchantId: MERCHANT_A,
      csrfToken: 'csrf_value_1',
    });
    expect(renderToHtml(el)).toContain('name="csrfToken"');
    expect(renderToHtml(el)).toContain('csrf_value_1');
  });

  it('shows an issued key once, and says it cannot be shown again', () => {
    const el = deviceEnrolmentScreen({
      chrome: authChrome(),
      merchantId: MERCHANT_A,
      csrfToken: 'csrf_1',
      issuedSecret: { deviceId: 'device_alpha_1', deviceSecret: 'the-key' },
    });
    expect(textOf(byTestId(el, 'issued-device-secret')!)).toBe('the-key');
    expect(textOf(byTestId(el, 'issued-secret-warning')!)).toContain('cannot show it again');
    expect(byTestId(el, 'issued-secret')?.attrs['role']).toBe('alert');
  });

  it('names the merchant the enrolment is for', () => {
    const el = deviceEnrolmentScreen({
      chrome: authChrome(),
      merchantId: MERCHANT_A,
      csrfToken: 'csrf_1',
    });
    expect(textOf(byTestId(el, 'enrolment-scope')!)).toContain(MERCHANT_A);
  });
});

describe('the identity indicator on an authenticated screen', () => {
  it('shows the operator, the merchant and the device', async () => {
    harness = makeUiHarness('identity-bar');
    const session = await signInAs(harness.api);

    const el = homeScreen({
      chrome: {
        ...chromeFor(),
        operatorName: 'Training operator',
        operatorId: session.userId,
        deviceId: session.deviceId,
        csrfToken: session.csrfToken,
      },
      balance: { status: 'IDLE' },
      recent: { status: 'IDLE' },
      needsAttention: 0,
    });

    const bar = byTestId(el, 'identity-bar');
    expect(bar).toBeDefined();
    expect(textOf(byTestId(el, 'identity-operator')!)).toContain('Training operator');
    expect(textOf(byTestId(el, 'identity-operator')!)).toContain(MERCHANT_A);
    expect(textOf(byTestId(el, 'identity-device')!)).toContain(session.deviceId);
  });

  it('offers sign-out as a form, not a link, carrying the CSRF token', () => {
    const el = homeScreen({
      chrome: { ...chromeFor(), operatorName: 'Op', csrfToken: 'csrf_1' },
      balance: { status: 'IDLE' },
      recent: { status: 'IDLE' },
      needsAttention: 0,
    });

    const form = byTestId(el, 'logout-form');
    // A link would be followed by anything that prefetches; signing out changes
    // server state, so it must be a POST.
    expect(form?.tag).toBe('form');
    expect(form?.attrs['method']).toBe('post');
    expect(form?.attrs['action']).toBe('/logout');
    expect(renderToHtml(form!)).toContain('csrf_1');

    const button = byTestId(el, 'logout-button');
    expect(button?.tag).toBe('button');
    expect(accessibleName(button!)).toBe('Sign out');
  });

  it('omits the sign-out control when there is no CSRF token to carry', () => {
    const el = homeScreen({
      chrome: { ...chromeFor(), operatorName: 'Op' },
      balance: { status: 'IDLE' },
      recent: { status: 'IDLE' },
      needsAttention: 0,
    });
    // Better to omit it than to render a control that would be refused.
    expect(byTestId(el, 'logout-form')).toBeUndefined();
  });

  it('puts no merchant id into any navigation link', () => {
    const el = homeScreen({
      chrome: { ...chromeFor(), operatorName: 'Op', csrfToken: 'csrf_1' },
      balance: { status: 'IDLE' },
      recent: { status: 'IDLE' },
      needsAttention: 0,
    });
    for (const id of ['nav-home', 'nav-sell', 'nav-transactions', 'nav-queue']) {
      const href = byTestId(el, id)?.attrs['href'];
      expect(String(href), id).not.toContain('merchantId');
    }
  });
});
