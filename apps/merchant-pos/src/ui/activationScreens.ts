/**
 * Activating a device with the code somebody carried to the shop.
 *
 * `CLAUDE.md` §18.2 and [[Device Registration]] describe this exchange and, until
 * now, nothing served it: `redeemEnrollmentToken` was written, tested, and had
 * **no HTTP caller**, so a shop could be read a code down the phone and had
 * nowhere to type it. The live `/enrol` route was a different thing entirely —
 * it mints a key for an operator who is *already signed in*, which a brand-new
 * device cannot be.
 *
 * ## Why this screen has no session and must not
 *
 * A device that has never activated has no key, so it cannot sign in, so it
 * cannot reach an authenticated screen. Putting activation behind a session
 * would make it reachable only by devices that no longer need it.
 *
 * ## What it is safe to say out loud
 *
 * An unknown device and a wrong code get the **identical** refusal, so this
 * cannot be used to discover which device ids exist. Expiry is told apart,
 * because an operator whose code has aged out needs to know to ask for another —
 * and by then they have proved they hold a code that was genuinely issued.
 */

import { t } from '@telga/localization';
import { authPage } from './authScreens';
import type { AuthChrome } from './authScreens';
import { h } from './element';
import type { El } from './element';

const REFUSAL_TEXT: Readonly<Record<string, string>> = Object.freeze({
  // Deliberately identical for "no such device" and "wrong code". See above.
  ACTIVATION_REFUSED:
    'That device ID and activation code were not accepted. Check both and try again, or ask Telga for a new code.',
  ACTIVATION_EXPIRED:
    'That activation code has expired. Ask Telga for a new one — codes last one hour.',
  ACTIVATION_NOT_PENDING:
    'This device cannot be activated. Contact Telga.',
  ACTIVATION_TOO_MANY:
    'Too many activation attempts from this connection. Wait a while and try again.',
  REQUEST_TOO_LARGE: 'That request was too large. Try again.',
});

export interface ActivationProps {
  readonly chrome: AuthChrome;
  readonly refusal?: string;
  /** Kept so a mistyped code does not cost the device id as well. */
  readonly deviceId?: string;
}

/** The form a new machine sees on first open. */
export function deviceActivationScreen(props: ActivationProps): El {
  const { chrome } = props;
  const locale = chrome.locale;

  return authPage(
    chrome,
    t(locale, 'screen.activate'),
    h('h2', { 'data-testid': 'activate-heading' }, t(locale, 'activate.heading')),
    h('p', { 'data-testid': 'activate-intro' }, t(locale, 'activate.intro')),
    props.refusal !== undefined &&
      h(
        'p',
        { 'data-testid': 'activate-refusal', role: 'alert', 'data-reason-code': props.refusal },
        REFUSAL_TEXT[props.refusal] ?? REFUSAL_TEXT['ACTIVATION_REFUSED'],
      ),
    h(
      'form',
      {
        method: 'post',
        action: '/activate',
        'data-testid': 'activate-form',
        'aria-label': t(locale, 'screen.activate'),
        autocomplete: 'off',
      },
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'deviceId' }, t(locale, 'activate.device')),
        h('input', {
          id: 'deviceId',
          name: 'deviceId',
          type: 'text',
          required: true,
          value: props.deviceId,
          'data-testid': 'activate-device',
        }),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'token' }, t(locale, 'activate.code')),
        h('input', {
          id: 'token',
          name: 'token',
          type: 'text',
          required: true,
          // Never remembered and never echoed back on a refusal: it is a
          // credential, however short its life.
          autocomplete: 'off',
          // The code is grouped in fives and excludes I, O, 0 and 1 because
          // those are the characters people mishear. Uppercase display matches
          // how it was written down; `normalizeEnrollmentToken` accepts any
          // case and any grouping.
          spellcheck: 'false',
          'data-testid': 'activate-code',
          'aria-describedby': 'token-hint',
        }),
        h('p', { id: 'token-hint', class: 'field__hint' }, t(locale, 'activate.code.hint')),
      ),
      h(
        'button',
        { type: 'submit', 'data-testid': 'activate-submit' },
        t(locale, 'activate.submit'),
      ),
    ),
    h(
      'p',
      { class: 'login__back' },
      h('a', { href: '/login', 'data-testid': 'activate-to-login' }, t(locale, 'screen.login')),
    ),
  );
}

export interface ActivatedProps {
  readonly chrome: AuthChrome;
  readonly deviceId: string;
  /** Shown once. Telga stores only a hash and cannot show it again. */
  readonly deviceSecret: string;
}

/**
 * The key, displayed once.
 *
 * Reached only by a `POST`, so it is not in browser history and pressing back
 * does not bring a device key onto the screen again. The warning is not
 * decoration: the key exists in this response and nowhere else in recoverable
 * form, and a device that loses it needs a **new activation code**, not a
 * lookup.
 */
export function deviceActivatedScreen(props: ActivatedProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return authPage(
    chrome,
    t(locale, 'screen.activate'),
    h(
      'section',
      { 'data-testid': 'activated', role: 'alert' },
      h('h2', {}, t(locale, 'activate.done.heading')),
      h('p', { 'data-testid': 'activated-device' }, `${t(locale, 'activate.device')}: ${props.deviceId}`),
      h('p', { 'data-testid': 'activated-key-label' }, t(locale, 'activate.done.key')),
      h('p', { 'data-testid': 'activated-key', class: 'register__reference' }, props.deviceSecret),
      h('p', { 'data-testid': 'activated-warning' }, t(locale, 'activate.done.warning')),
    ),
    h(
      'p',
      { class: 'login__back' },
      h('a', { href: '/login', 'data-testid': 'activated-to-login' }, t(locale, 'screen.login')),
    ),
  );
}
