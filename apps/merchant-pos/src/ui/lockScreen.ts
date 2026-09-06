/**
 * The screen lock.
 *
 * When "Require PIN to unlock" is on, a machine left alone for longer than the
 * configured lock time demands the operator's PIN before showing anything
 * again. Turning it off means it never asks — that is the whole behaviour, and
 * it is now the switch in Settings that decides it rather than a setting that
 * saved and did nothing.
 *
 * ## Lock is not sign-out
 *
 * The session survives. Unlocking costs a PIN and nothing else: the operator
 * stays signed in, the device stays enrolled, and no work in progress is lost.
 * That is the difference between this and the idle timeout, which ends the
 * session — a shop wants the counter covered when somebody steps away, not to
 * be signed out every few minutes.
 *
 * ## The PIN is the same PIN
 *
 * It authorizes sales, so it is the credential the shop already protects.
 * Failures are recorded under `PIN_AUTH`, which means guessing at the lock is
 * bounded by the same trailing-window lockout a wrong voucher PIN is — and,
 * like that one, it can never contribute to a *login* lockout.
 */

import { t } from '@telga/localization';
import { authPage } from './authScreens';
import type { AuthChrome } from './authScreens';
import { h } from './element';
import type { El } from './element';
import { telgaLogo } from './logo';

export interface LockScreenProps {
  readonly chrome: AuthChrome;
  readonly operatorId: string;
  readonly csrfToken: string;
  /** Where the operator was headed, so unlocking puts them back there. */
  readonly returnTo: string;
  readonly errorMessage?: string;
}

export function lockScreen(props: LockScreenProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return authPage(
    chrome,
    t(locale, 'lock.heading'),
    h(
      'div',
      { class: 'lock', 'data-testid': 'lock-screen' },
      h('div', { class: 'lock__mark' }, telgaLogo({ height: 92, title: '' })),
      h('p', { class: 'lock__title' }, t(locale, 'lock.heading')),
      // Who is signed in, so the operator knows whose PIN is being asked for —
      // and so somebody else knows to sign out rather than guess.
      h('p', { class: 'lock__operator', 'data-testid': 'lock-operator' }, props.operatorId),
      props.errorMessage !== undefined &&
        h(
          'p',
          { role: 'alert', 'data-tone': 'NEGATIVE', 'data-testid': 'lock-error' },
          props.errorMessage,
        ),
      h(
        'form',
        { method: 'post', action: '/unlock', 'data-testid': 'lock-form' },
        h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
        h('input', { type: 'hidden', name: 'returnTo', value: props.returnTo }),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'pin' }, t(locale, 'lock.pin_label')),
          h('input', {
            id: 'pin',
            name: 'pin',
            type: 'password',
            inputmode: 'numeric',
            autocomplete: 'off',
            required: true,
            autofocus: true,
            'data-testid': 'lock-pin',
          }),
        ),
        h(
          'button',
          { type: 'submit', class: 'voucher__button voucher__button--primary', 'data-testid': 'lock-submit' },
          t(locale, 'lock.unlock'),
        ),
      ),
      // The way out for somebody who is not the signed-in operator.
      h(
        'form',
        { method: 'post', action: '/logout', class: 'lock__signout', 'data-testid': 'lock-signout-form' },
        h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
        h(
          'button',
          { type: 'submit', class: 'voucher__button voucher__button--cancel', 'data-testid': 'lock-signout' },
          t(locale, 'settings.signout'),
        ),
      ),
    ),
  );
}
