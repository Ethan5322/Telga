/**
 * The authentication screens.
 *
 * Login, session expired, access denied, and device enrolment.
 *
 * ## Why these do not use `page()`
 *
 * `page()` takes a `Chrome`, which carries a merchant id — and none of these
 * screens has an authenticated merchant to name. They render their own shell
 * with the same training banner, so the banner is still unconditional, but they
 * cannot accidentally display a merchant identity nobody proved.
 *
 * ## What a failure screen never says
 *
 * Not whether the operator id exists. Not whether the PIN was wrong as opposed
 * to the device being unenrolled. The screen says the attempt was refused and
 * offers the correlation id for support. Anything more precise is a probe for
 * someone holding a stolen device.
 */

import { AMHARIC_REVIEW_WARNING, t } from '@telga/localization';
import type { Locale } from '@telga/localization';
import { h } from './element';
import type { El, Node } from './element';

export interface AuthChrome {
  readonly locale: Locale;
  readonly environment: string;
  readonly mode: string;
  readonly serverTime: string;
}

export class RefusedNonTrainingAuthError extends Error {
  readonly code = 'POS_AUTH_REFUSES_NON_TRAINING_MODE';
  constructor(mode: string) {
    super(`The POS renders training-mode sign-in only; configured mode is "${mode}"`);
    this.name = 'RefusedNonTrainingAuthError';
  }
}

/** The unauthenticated shell. Same banner, no merchant identity. */
export function authPage(
  chrome: AuthChrome,
  title: string,
  ...content: ReadonlyArray<Node | false | null | undefined>
): El {
  if (chrome.mode !== 'TRAINING') throw new RefusedNonTrainingAuthError(chrome.mode);
  return h(
    'div',
    { class: 'pos', lang: chrome.locale, 'data-mode': chrome.mode },
    h(
      'div',
      {
        'data-testid': 'training-banner',
        role: 'status',
        'aria-live': 'polite',
        'data-tone': 'CAUTION',
        class: 'banner banner--training',
      },
      h('strong', { class: 'banner__title' }, t(chrome.locale, 'mode.training')),
      h(
        'span',
        { class: 'banner__detail', 'data-testid': 'environment-indicator' },
        `Environment: ${chrome.environment} · Mode: ${chrome.mode}`,
      ),
      h(
        'span',
        { class: 'banner__warning', 'data-testid': 'training-only-notice' },
        'Internal training only. Not for merchant or customer use.',
      ),
      chrome.locale === 'am' &&
        h('span', { class: 'banner__warning', 'data-testid': 'amharic-review-warning' }, AMHARIC_REVIEW_WARNING),
    ),
    h(
      'main',
      { 'data-testid': 'screen', 'data-screen-title': title },
      h('h1', { class: 'screen__title' }, title),
      ...content,
    ),
    h(
      'footer',
      { class: 'pos__footer' },
      h('span', { 'data-testid': 'server-time' }, `Telga time: ${chrome.serverTime}`),
    ),
  );
}

export interface LoginProps {
  readonly chrome: AuthChrome;
  /**
   * A safe refusal code from a previous attempt, or undefined.
   * Never says which field was wrong.
   */
  readonly refusal?: string;
  /** Prefilled only from a previous submission, never from a cookie. */
  readonly deviceId?: string;
  /** Where to go after signing in. Same-origin path only; validated by the server. */
  readonly returnTo?: string;
}

const REFUSAL_TEXT: Readonly<Record<string, string>> = Object.freeze({
  INVALID_CREDENTIALS: 'Sign-in was refused. Check the operator, PIN and device, then try again.',
  USER_LOCKED_OUT:
    'This operator is locked out after repeated failed attempts. Wait, or ask Telga to unlock it.',
  USER_SUSPENDED: 'This operator cannot sign in. Contact Telga.',
  RATE_LIMITED: 'Too many sign-in attempts. Wait a moment and try again.',
  DEVICE_NOT_ENROLLED: 'This device is not enrolled for Telga training. Contact Telga.',
  DEVICE_REVOKED: 'This device has been withdrawn. Contact Telga.',
  DEVICE_ENROLLMENT_EXPIRED: 'This device enrolment has expired. Contact Telga.',
  DEVICE_NOT_ASSIGNED_TO_MERCHANT: 'This device is not enrolled for Telga training. Contact Telga.',
});

/**
 * The sign-in screen.
 *
 * The device secret is a password field, `autocomplete="off"`, and is never
 * echoed back into the form on a failed attempt — a refused sign-in clears both
 * secrets and keeps only the identifiers.
 */
export function loginScreen(props: LoginProps): El {
  const { chrome } = props;
  const locale = chrome.locale;

  const field = (id: string, label: string, control: El, hint?: string): El =>
    h(
      'div',
      { class: 'field' },
      h('label', { for: id }, label),
      control,
      hint !== undefined && h('p', { id: `${id}-hint`, class: 'field__hint' }, hint),
    );

  return authPage(
    chrome,
    t(locale, 'screen.login'),
    props.refusal !== undefined &&
      h(
        'p',
        { 'data-testid': 'login-refusal', role: 'alert', 'data-reason-code': props.refusal },
        REFUSAL_TEXT[props.refusal] ?? REFUSAL_TEXT['INVALID_CREDENTIALS'],
      ),
    h(
      'form',
      {
        method: 'post',
        action: '/login',
        'data-testid': 'login-form',
        'aria-label': t(locale, 'screen.login'),
        autocomplete: 'off',
      },
      props.returnTo !== undefined &&
        h('input', { type: 'hidden', name: 'returnTo', value: props.returnTo }),
      field(
        'userId',
        'Operator',
        h('input', {
          id: 'userId',
          name: 'userId',
          type: 'text',
          required: true,
          autocomplete: 'username',
          'data-testid': 'login-user',
        }),
      ),
      field(
        'pin',
        'PIN',
        h('input', {
          id: 'pin',
          name: 'pin',
          type: 'password',
          required: true,
          inputmode: 'numeric',
          autocomplete: 'off',
          'data-testid': 'login-pin',
          'aria-describedby': 'pin-hint',
        }),
        'Six digits. Never share it, and never write it on the machine.',
      ),
      field(
        'deviceId',
        'Device',
        h('input', {
          id: 'deviceId',
          name: 'deviceId',
          type: 'text',
          required: true,
          value: props.deviceId,
          'data-testid': 'login-device',
        }),
      ),
      field(
        'deviceSecret',
        'Device key',
        h('input', {
          id: 'deviceSecret',
          name: 'deviceSecret',
          type: 'password',
          required: true,
          autocomplete: 'off',
          'data-testid': 'login-device-secret',
          'aria-describedby': 'deviceSecret-hint',
        }),
        'Issued by Telga when this device was enrolled.',
      ),
      h('button', { type: 'submit', 'data-testid': 'login-submit' }, t(locale, 'screen.login')),
    ),
  );
}

/** Shown when a session ran out. Says nothing was lost, because nothing was. */
export function sessionExpiredScreen(chrome: AuthChrome, reasonCode: string): El {
  return authPage(
    chrome,
    'Session ended',
    h(
      'p',
      { 'data-testid': 'session-expired', role: 'alert', 'data-reason-code': reasonCode },
      t(chrome.locale, 'error.session.expired'),
    ),
    h(
      'p',
      { 'data-testid': 'session-expired-detail' },
      'No sale was affected. Any transaction you started is still recorded and can be found after you sign in.',
    ),
    h('p', {}, h('a', { href: '/login', 'data-testid': 'to-login' }, t(chrome.locale, 'screen.login'))),
  );
}

/**
 * Shown when the caller is authenticated but not allowed.
 *
 * Deliberately not a sign-in prompt: a revoked device or a missing permission
 * is not fixed by signing in again, and sending an operator round that loop
 * teaches them to keep retrying something that cannot work.
 */
export function accessDeniedScreen(chrome: AuthChrome, reasonCode: string, correlationId: string): El {
  return authPage(
    chrome,
    'Not allowed',
    h(
      'p',
      { 'data-testid': 'access-denied', role: 'alert', 'data-reason-code': reasonCode },
      t(chrome.locale, 'error.permission.denied'),
    ),
    h(
      'p',
      { 'data-testid': 'access-denied-detail' },
      'Signing in again will not change this. Contact Telga support and quote the code below.',
    ),
    h('p', { 'data-testid': 'access-denied-correlation' }, `Support code: ${correlationId}`),
    h('p', {}, h('a', { href: '/login', 'data-testid': 'to-login' }, t(chrome.locale, 'screen.login'))),
  );
}

/** A generic failure. Says what it does not know, rather than guessing. */
export function safeErrorScreen(chrome: AuthChrome, correlationId: string): El {
  return authPage(
    chrome,
    'Something went wrong',
    h(
      'p',
      { 'data-testid': 'safe-error', role: 'alert' },
      t(chrome.locale, 'status.sales_unavailable'),
    ),
    h(
      'p',
      { 'data-testid': 'safe-error-detail' },
      'This message is about the screen, not about a sale. Check the transaction list before selling again.',
    ),
    h('p', { 'data-testid': 'safe-error-correlation' }, `Support code: ${correlationId}`),
  );
}

export interface EnrolmentProps {
  readonly chrome: AuthChrome;
  readonly merchantId: string;
  readonly csrfToken: string;
  /** Present immediately after an enrolment. Shown once and never again. */
  readonly issuedSecret?: { deviceId: string; deviceSecret: string };
  readonly refusal?: string;
}

/**
 * Device enrolment.
 *
 * The issued key is displayed once, with the reason stated plainly: it is not
 * stored in a recoverable form, so an operator who does not write it down needs
 * a new enrolment rather than a lookup.
 */
export function deviceEnrolmentScreen(props: EnrolmentProps): El {
  const { chrome } = props;
  return authPage(
    chrome,
    'Enrol a device',
    h(
      'p',
      { 'data-testid': 'enrolment-scope' },
      `Enrolling for merchant ${props.merchantId}. A device belongs to one merchant only.`,
    ),
    props.refusal !== undefined &&
      h('p', { 'data-testid': 'enrolment-refusal', role: 'alert' }, props.refusal),
    props.issuedSecret !== undefined &&
      h(
        'section',
        { 'data-testid': 'issued-secret', role: 'alert' },
        h('h2', {}, 'Device key — shown once'),
        h('p', { 'data-testid': 'issued-device-id' }, `Device: ${props.issuedSecret.deviceId}`),
        h('p', { 'data-testid': 'issued-device-secret' }, props.issuedSecret.deviceSecret),
        h(
          'p',
          { 'data-testid': 'issued-secret-warning' },
          'Telga stores only a hash of this key and cannot show it again. If it is lost, enrol the device once more.',
        ),
      ),
    h(
      'form',
      { method: 'post', action: '/enrol', 'data-testid': 'enrolment-form', 'aria-label': 'Enrol a device' },
      h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'enrolDeviceId' }, 'Device identifier'),
        h('input', {
          id: 'enrolDeviceId',
          name: 'deviceId',
          type: 'text',
          required: true,
          'data-testid': 'enrol-device-id',
          'aria-describedby': 'enrol-hint',
        }),
      ),
      h(
        'p',
        { id: 'enrol-hint', 'data-testid': 'enrol-hint' },
        'Training-grade binding: this identifier is supplied by the device, not proved by hardware. It is paired with a Telga-issued key and a server-side enrolment record.',
      ),
      h('button', { type: 'submit', 'data-testid': 'enrol-submit' }, 'Enrol device'),
    ),
  );
}
