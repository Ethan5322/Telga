/**
 * The three-bar menu.
 *
 * ## Why it is a `<details>` and not a script
 *
 * Opening and closing is native browser behaviour here, so the menu works
 * with scripting off — which matters on a counter machine whose browser an
 * operator does not control. Nothing about *what the menu can reach* is
 * decided in the browser: every entry is a plain link or a CSRF-carrying
 * form, and the server re-checks permission on arrival. A menu entry is a
 * signpost, never an authorisation.
 *
 * ## One menu, one place
 *
 * Rendered by `page()` for every authenticated screen rather than pasted into
 * each one, so an entry cannot exist on the dashboard and be missing from
 * history. It carries the operator id at the top, which is the fastest way for
 * somebody at a counter to check who the machine currently thinks they are.
 */

import { t } from '@telga/localization';
import type { Locale } from '@telga/localization';
import { h } from './element';
import type { El } from './element';
import { telgaLogo } from './logo';

export interface MainMenuProps {
  readonly locale: Locale;
  readonly operatorId: string;
  readonly csrfToken?: string;
  /** Marks the entry for the screen being shown, so the menu says where you are. */
  readonly current?: string;
  /**
   * Which module the operator is inside. Telga Pay gets its own entries; the
   * default is Telga Vending, which is what every existing caller means.
   */
  readonly module?: MenuModule;
}

interface Entry {
  readonly id: string;
  readonly href: string;
  readonly labelKey: Parameters<typeof t>[1];
  readonly icon: string;
}

/**
 * The entries, in the founder's order.
 *
 * Logout is not here: it changes state, so it is a form rather than a link
 * and is appended separately below.
 */
const ENTRIES: readonly Entry[] = Object.freeze([
  { id: 'statements', href: '/transactions', labelKey: 'menu.statements', icon: '🧾' },
  // The day-by-day view. Separate from the transaction list because they answer
  // different questions: "what happened" and "what did each day come to".
  { id: 'statement', href: '/statements', labelKey: 'statements.title', icon: '📊' },
  { id: 'shift', href: '/shift/end', labelKey: 'menu.end_shift', icon: '⏹' },
  { id: 'customers', href: '/customers', labelKey: 'menu.customers', icon: '👥' },
  { id: 'learning', href: '/learning', labelKey: 'menu.learning', icon: '🎓' },
  { id: 'settings', href: '/settings', labelKey: 'menu.settings', icon: '⚙️' },
  { id: 'help', href: '/help', labelKey: 'menu.help', icon: '☎️' },
]);

/**
 * The menu inside **Telga Pay**.
 *
 * The list above is Telga Vending's, and it was being shown inside Telga Pay
 * as well — so an operator taking a card payment saw the vending shop's
 * statements, its shift controls, its customer list and its settings. Two
 * modules sharing one menu meant Pay had no settings of its own and Vending's
 * appeared to belong to it.
 *
 * What is genuinely shared stays shared: **Learning** and **Help** describe
 * Telga, not a module, and **Log out** ends the one session both run inside.
 * Everything module-specific is separate.
 */
const PAY_ENTRIES: readonly Entry[] = Object.freeze([
  { id: 'pay-transactions', href: '/pay/transactions', labelKey: 'menu.statements', icon: '🧾' },
  { id: 'pay-settings', href: '/pay/settings', labelKey: 'menu.settings', icon: '⚙️' },
  { id: 'learning', href: '/learning', labelKey: 'menu.learning', icon: '🎓' },
  { id: 'help', href: '/help', labelKey: 'menu.help', icon: '☎️' },
]);

/** Which module's menu to draw. */
export type MenuModule = 'vending' | 'pay';

export const entriesFor = (module: MenuModule): readonly Entry[] =>
  module === 'pay' ? PAY_ENTRIES : ENTRIES;

export function menu(props: MainMenuProps): El {
  const { locale } = props;
  return h(
    'details',
    { class: 'menu', 'data-testid': 'main-menu' },
    h(
      'summary',
      {
        class: 'menu__button',
        'aria-label': t(locale, 'menu.open'),
        'data-testid': 'menu-button',
      },
      // Three bars, drawn rather than typed, so the icon does not depend on a
      // font having the glyph.
      h('span', { class: 'menu__bars', 'aria-hidden': 'true' }, h('i', {}), h('i', {}), h('i', {})),
    ),
    h(
      'div',
      { class: 'menu__panel', role: 'menu' },
      // Who the machine thinks you are, first — the question most often asked
      // at a counter.
      h(
        'div',
        { class: 'menu__identity', 'data-testid': 'menu-identity' },
        telgaLogo({ height: 30, title: '' }),
        h('span', { class: 'menu__operator', 'data-testid': 'menu-operator' }, props.operatorId),
      ),
      ...entriesFor(props.module ?? 'vending').map((entry) =>
        h(
          'a',
          {
            href: entry.href,
            class: 'menu__item',
            role: 'menuitem',
            'aria-current': props.current === entry.id ? 'page' : undefined,
            'data-testid': `menu-${entry.id}`,
          },
          h('span', { class: 'menu__item-icon', 'aria-hidden': 'true' }, entry.icon),
          t(locale, entry.labelKey),
        ),
      ),
      // Lock, as a black pill at the foot of the sheet — the reference
      // terminal puts it there because it is the one thing an operator
      // reaches for when stepping away from the counter, and it must not be
      // confused with signing out. It locks the screen; the session lives.
      h(
        'form',
        { method: 'post', action: '/lock', class: 'menu__lock', 'data-testid': 'menu-lock-form' },
        h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken ?? '' }),
        h(
          'button',
          { type: 'submit', class: 'menu__lock-button', 'data-testid': 'menu-lock' },
          h('span', { class: 'menu__item-icon', 'aria-hidden': 'true' }, '🔒'),
          t(locale, 'menu.lock'),
        ),
      ),
      // A write, so it is a form and carries CSRF. It asks first: signing out
      // here clears the device and the operator as well as the session.
      h(
        'form',
        { method: 'post', action: '/logout', class: 'menu__logout', 'data-testid': 'menu-logout-form' },
        h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken ?? '' }),
        h(
          'button',
          {
            type: 'submit',
            class: 'menu__item menu__item--logout',
            role: 'menuitem',
            'data-confirm': t(locale, 'settings.signout.confirm'),
            'data-testid': 'menu-logout',
          },
          h('span', { class: 'menu__item-icon', 'aria-hidden': 'true' }, '🚪'),
          t(locale, 'menu.logout'),
        ),
      ),
    ),
  );
}
