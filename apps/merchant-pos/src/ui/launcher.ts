/**
 * The Telga launcher, in two screens.
 *
 * ## The shape, and why it is two pages
 *
 *   sign in → **`/launcher`** (one Telga button) → **`/launcher/apps`**
 *   (Telga Vending · Telga Pay) → the module you chose
 *
 * One app called Telga. Opening it reveals what is inside — and "reveals" here
 * means **going to a page**, not expanding a panel. An earlier version put the
 * mark and both modules on one screen behind a `<details>`; that reads as two
 * things sitting beside a logo rather than as one product that opens, which was
 * the reported fault.
 *
 * ## Why the launcher is behind sign-in
 *
 * It used to be the public front door, before authentication. It is not any
 * more: **login is the first screen**. The launcher carries the shop's chrome —
 * merchant name, training banner, session — and a chooser shown to whoever
 * picks the machine up tells them what Telga does before proving who they are.
 *
 * ## The icons
 *
 * The Telga button carries **the real mark** — the same artwork printed on
 * every slip — so the button an operator opens Telga with and the logo on the
 * paper they hand a customer are the same thing. A drawn substitute was tried
 * and rejected: it read as a diagram of the logo rather than the logo.
 *
 * The two modules use plain emoji — 📱 and 💳 — and deliberately **not** the
 * mark: inside Telga, everything is Telga, so repeating the logo on both tiles
 * distinguishes nothing. What tells them apart is what each one does.
 *
 * This is **not** two applications: both modules live inside the same
 * authenticated session `page()` already requires, and neither signs in, signs
 * out, or starts a second authentication flow. The wording stays literal —
 * "module", never "installed app" — because this is a server-rendered page, not
 * a packaged build.
 */

import { t } from '@telga/localization';
import { page } from './chrome';
import type { Chrome } from './chrome';
import { h } from './element';
import type { El } from './element';
import { telgaLogo } from './logo';

export interface LauncherProps {
  readonly chrome: Chrome;
}

function tile(href: string, testId: string, icon: El | string, label: string, subtitle: string): El {
  return h(
    'a',
    { href, class: 'launcher__tile', 'data-testid': testId },
    h('span', { class: 'launcher__tile-icon', 'aria-hidden': 'true' }, icon),
    h('span', { class: 'launcher__tile-label' }, label),
    h('span', { class: 'launcher__tile-subtitle' }, subtitle),
  );
}

/**
 * Screen one: Telga, as a single button.
 *
 * Nothing else is offered here. The point of the screen is that Telga is one
 * thing you open, so a second choice on it would undo the idea.
 */
export function launcherScreen(props: LauncherProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'screen.launcher'),
    h(
      'div',
      { class: 'launcher__single', 'data-testid': 'launcher-single' },
      h(
        'a',
        {
          href: '/launcher/apps',
          class: 'launcher__telga',
          'data-testid': 'launcher-telga-button',
        },
        h(
          'span',
          { class: 'launcher__telga-icon', 'aria-hidden': 'true' },
          telgaLogo({ height: 132, title: '' }),
        ),
        h('span', { class: 'launcher__telga-label' }, t(locale, 'launcher.tile.telga.label')),
        h('span', { class: 'launcher__telga-cue' }, t(locale, 'launcher.open_telga')),
      ),
    ),
  );
}

/**
 * Screen two: what is inside Telga.
 *
 * The Telga button is **not** repeated here. Having opened it, an operator is
 * inside — showing the thing they just opened, beside the two things it
 * contains, is what made the single-page version confusing.
 *
 * The mark is absent too, for the same reason and one more: both modules are
 * Telga, so the logo cannot be what distinguishes them.
 */
export function launcherAppsScreen(props: LauncherProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'screen.launcher_apps'),
    h(
      'div',
      { class: 'launcher__tiles', 'data-testid': 'launcher-tiles' },
      tile(
        '/dashboard',
        'launcher-tile-telga',
        '📱',
        t(locale, 'launcher.tile.telga.label'),
        t(locale, 'launcher.tile.telga.subtitle'),
      ),
      tile(
        '/pay',
        'launcher-tile-telgapay',
        '💳',
        t(locale, 'launcher.tile.telgapay.label'),
        t(locale, 'launcher.tile.telgapay.subtitle'),
      ),
    ),
    h(
      'p',
      { class: 'launcher__back-row' },
      h(
        'a',
        { href: '/launcher', class: 'voucher__button', 'data-testid': 'launcher-apps-back' },
        t(locale, 'voucher.action.back'),
      ),
    ),
  );
}
