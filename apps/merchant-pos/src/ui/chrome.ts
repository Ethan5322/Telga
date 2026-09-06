/**
 * Page chrome: the training banner, the environment indicator and the layout.
 *
 * The banner is not decoration and not a dismissible notice. Every screen this
 * app can render goes through `page()`, and `page()` always emits it — there is
 * no parameter that turns it off, which is why a test can assert its presence
 * on every screen rather than on the screens someone remembered to check.
 *
 * It states three things, because "training mode" alone is not enough for
 * somebody who has walked up to the counter mid-shift: the mode, that no real
 * value is involved, and which environment and merchant the screen belongs to.
 */

import { AMHARIC_REVIEW_WARNING, t } from '@telga/localization';
import type { Locale } from '@telga/localization';
import { h } from './element';
import { menu } from './menu';
import type { MenuModule } from './menu';
import type { El, Node } from './element';

export const TRAINING_BANNER_TEST_ID = 'training-banner';

export interface Chrome {
  readonly locale: Locale;
  /** Free-text environment name, e.g. "local", "pilot-sandbox". Never a URL or a secret. */
  readonly environment: string;
  /**
   * The **authenticated** merchant, taken from the session by the server.
   *
   * Rendering it is display, not authority: nothing downstream of this value
   * decides access, and a page that showed the wrong one would be a display bug
   * rather than a way into another merchant's data.
   */
  readonly merchantId: string;
  /** The transaction mode the server reported. Anything but TRAINING is refused. */
  readonly mode: string;
  readonly serverTime: string;
  /** The signed-in operator, for the identity indicator. */
  readonly operatorName?: string;
  readonly operatorId?: string;
  readonly deviceId?: string;
  /** Bound to this session; embedded in every form the page renders. */
  readonly csrfToken?: string;
  /**
   * Inactivity timeout, in milliseconds, for the client-side sign-out.
   *
   * Set only for authenticated screens — the sign-in page has no session to
   * time out, so it carries no watcher. The server expires the session on its
   * own clock regardless; this only makes the expiry visible.
   */
  readonly idleTimeoutMs?: number;
  /**
   * The shop's screen-lock window, in milliseconds — `Settings → Security →
   * "Lock the screen after (seconds)"`.
   *
   * **Not** {@link idleTimeoutMs}, which is the server's session expiry. Two
   * different things were being driven by one number: locking keeps the
   * session alive and asks for a PIN, signing out ends it. The shop's setting
   * saved correctly and was then ignored, because the page only ever emitted
   * the session window.
   *
   * Absent when the shop has not turned the lock on.
   */
  readonly lockAfterMs?: number;
  /**
   * Which module this screen belongs to. Drives the three-bar menu's entries.
   * Absent means Telga Vending, which is what every screen but Pay's is.
   */
  readonly module?: MenuModule;
}

export class RefusedNonTrainingModeError extends Error {
  readonly code = 'POS_REFUSES_NON_TRAINING_MODE';
  constructor(mode: string) {
    super(`The merchant POS renders training mode only; the server reported "${mode}"`);
    this.name = 'RefusedNonTrainingModeError';
  }
}

/**
 * The banner every screen carries.
 *
 * `role="status"` rather than `role="alert"`: it is a standing condition, not an
 * interruption, and an alert would be announced over whatever the operator is
 * doing every time a screen re-renders.
 */
export function trainingBanner(chrome: Chrome): El {
  return h(
    'div',
    {
      'data-testid': TRAINING_BANNER_TEST_ID,
      role: 'status',
      'aria-live': 'polite',
      'data-tone': 'CAUTION',
      class: 'banner banner--training',
    },
    h('strong', { class: 'banner__title' }, t(chrome.locale, 'mode.training')),
    h(
      'span',
      { class: 'banner__detail', 'data-testid': 'environment-indicator' },
      `Environment: ${chrome.environment} · Merchant: ${chrome.merchantId} · Mode: ${chrome.mode}`,
    ),
    chrome.locale === 'am' &&
      h('span', { class: 'banner__warning', 'data-testid': 'amharic-review-warning' }, AMHARIC_REVIEW_WARNING),
  );
}

/**
 * Wrap a screen.
 *
 * Refuses outright when the server reports anything but TRAINING. A banner that
 * merely *said* training while rendering live data would be worse than no
 * banner at all, so the refusal is a thrown error, not a styled warning.
 */
export function page(
  chrome: Chrome,
  title: string,
  ...content: ReadonlyArray<Node | false | null | undefined>
): El {
  if (chrome.mode !== 'TRAINING') throw new RefusedNonTrainingModeError(chrome.mode);

  return h(
    'div',
    { class: 'pos', lang: chrome.locale, 'data-mode': chrome.mode },
    trainingBanner(chrome),
    // The three-bar menu, drawn here rather than by each screen — so an entry
    // cannot exist on the dashboard and be missing from history, and so it is
    // reachable from every authenticated screen without exception.
    h(
      'div',
      { class: 'pos__topbar' },
      menu({
        locale: chrome.locale,
        operatorId: chrome.operatorId ?? chrome.merchantId,
        csrfToken: chrome.csrfToken,
        // Telga Pay gets its own entries. Sharing one menu meant an operator
        // taking a card payment saw the vending shop's statements, shift and
        // settings — and Pay appeared to have none of its own.
        module: chrome.module,
      }),
    ),
    h(
      'main',
      { 'data-testid': 'screen', 'data-screen-title': title },
      h('h1', { class: 'screen__title' }, title),
      ...content,
    ),
    identityBar(chrome),
    h(
      'footer',
      { class: 'pos__footer' },
      h('span', { 'data-testid': 'server-time' }, `Last updated from Telga: ${chrome.serverTime}`),
    ),
  );
}

/**
 * Who is signed in, on which device, and the way out.
 *
 * The logout control is a **form**, not a link: signing out changes server
 * state, and a link would be followed by anything that prefetches. It carries
 * the session's CSRF token like every other write.
 */
export function identityBar(chrome: Chrome): El {
  return h(
    'section',
    { class: 'pos__identity', 'data-testid': 'identity-bar', 'aria-label': 'Signed in as' },
    h(
      'span',
      { 'data-testid': 'identity-operator' },
      `${chrome.operatorName ?? 'Unknown operator'} · ${chrome.merchantId}`,
    ),
    chrome.deviceId !== undefined &&
      h('span', { 'data-testid': 'identity-device' }, ` · Device ${chrome.deviceId}`),
    chrome.csrfToken !== undefined &&
      h(
        'form',
        { method: 'post', action: '/logout', 'data-testid': 'logout-form' },
        h('input', { type: 'hidden', name: 'csrfToken', value: chrome.csrfToken }),
        h('button', { type: 'submit', 'data-testid': 'logout-button' }, 'Sign out'),
      ),
  );
}

/** A labelled navigation bar. Every destination is a real link, reachable by keyboard. */
export function nav(
  locale: Locale,
  merchantId: string,
  current: string,
): El {
  // No merchant id in the href. The session decides the scope, so putting one
  // in a link would be a value that looks authoritative and is not.
  void merchantId;
  const link = (href: string, label: string, id: string): El =>
    h(
      'a',
      {
        href,
        'data-testid': `nav-${id}`,
        'aria-current': current === id ? 'page' : undefined,
      },
      label,
    );

  return h(
    'nav',
    { 'aria-label': 'Main', class: 'pos__nav' },
    // `/dashboard`, not `/`. `/` is the legacy POS home whose primary action
    // opens the old single-screen `/sell` form — so a merchant pressing
    // "Home" from anywhere in the voucher flow used to land on the old
    // airtime-selling page. The Telga vending dashboard is the home now.
    link('/dashboard', t(locale, 'nav.main'), 'home'),
    link('/transactions', t(locale, 'screen.search'), 'transactions'),
    link('/queue', t(locale, 'screen.admin_queue'), 'queue'),
  );
}
