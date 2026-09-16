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
import { isEnabled } from '@telga/domain';

export interface LauncherProps {
  readonly chrome: Chrome;
}

/**
 * One of the two systems inside Telga.
 *
 * **One mark each, and only on these two cards.**
 *
 * This doc previously argued the opposite: that an emoji standing in for a
 * missing icon system is a placeholder that ships, and that two full-colour
 * glyphs were the loudest thing on a screen meant to look considered. That
 * reasoning is right for a catalogue of twelve services where a row of emoji
 * becomes noise — and wrong here, where there are exactly **two** cards a
 * shopkeeper chooses between all day. Two marks are an identifier; twelve are
 * a placeholder.
 *
 * The founder asked for them directly after using the plain version on
 * hardware. The mark is `aria-hidden`: the label beside it already says what
 * the card is.
 */
function tile(
  href: string,
  testId: string,
  label: string,
  subtitle: string,
  mark: string,
): El {
  return h(
    'a',
    { href, class: 'launcher__tile', 'data-testid': testId },
    // `aria-hidden`, because the label beside it already says what this is.
    // A screen reader announcing "mobile phone, Telga, vending and merchant
    // services" is worse than one announcing the name.
    h('span', { class: 'launcher__tile-mark', 'aria-hidden': 'true' }, mark),
    h(
      'span',
      { class: 'launcher__tile-text' },
      h('span', { class: 'launcher__tile-label' }, label),
      h('span', { class: 'launcher__tile-subtitle' }, subtitle),
    ),
    // A chevron. It says these are doors rather than labels — the thing the
    // founder meant by the cards looking unfinished.
    h('span', { class: 'launcher__tile-go', 'aria-hidden': 'true' }, '\u203A'),
  );
}

/**
 * Screen one used to be here: Telga as a single button, which opened the
 * screen below. Removed 2026-09-15 by the founder's device review (D168).
 *
 * It was built exactly as asked on 2026-09-14 — *"telga launcher is only seen
 * on app, it just says telga, so person click on it"* — and using it on real
 * hardware settled the question the other way: the extra tap earns nothing.
 *
 * The **function** goes with the route rather than being left exported. This
 * session has now removed three dead renderers on the same reasoning — the
 * training banner, the identity bar, and this — because a function that draws
 * a screen somebody asked to have removed is one import from bringing it back,
 * and a reader who finds it reasonably concludes it is still in use.
 */

/**
 * What is inside Telga — and now the first screen after sign-in.
 *
 * The Telga mark is **not** drawn here. Both modules are Telga, so the logo
 * cannot be what distinguishes them; the two marks and the two names do that.
 *
 * This was "screen two" until the founder's device review removed the card
 * that led to it. It is unchanged in what it offers — the change is that
 * nothing stands in front of it any more.
 */
export function launcherAppsScreen(props: LauncherProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return page(
    { ...chrome, bare: true },
    t(locale, 'screen.launcher_apps'),
    h(
      'div',
      { class: 'launcher__tiles', 'data-testid': 'launcher-tiles' },
      tile(
        '/dashboard',
        'launcher-tile-telga',
        t(locale, 'launcher.tile.telga.label'),
        t(locale, 'launcher.tile.telga.subtitle'),
        // A shop front. This module is the counter: selling airtime, data and
        // vouchers to somebody standing in front of you.
        '\u{1F3EA}',
      ),
      // Telga Pay appears only while `card.simulated` is on. With the flag off
      // the whole `/pay` tree answers 404, so a tile here would be a button
      // that leads nowhere — and CLAUDE.md §7 asks for a disabled feature to be
      // inaccessible in the UI, not merely refused after the tap.
      ...(isEnabled('card.simulated')
        ? [
            tile(
              '/pay',
              'launcher-tile-telgapay',
              t(locale, 'launcher.tile.telgapay.label'),
              t(locale, 'launcher.tile.telgapay.subtitle'),
              // A card. Telga Pay is the card-payment simulator, and the card
              // is the one object that says so without reading the label.
              '\u{1F4B3}',
            ),
          ]
        : []),
    ),
    // No BACK button. Founder device review, 2026-09-15: this screen is what
    // sign-in opens, so there is nothing behind it to return to — the button
    // led to the "Tap Telga to Open" card that the same review removed.
  );
}
