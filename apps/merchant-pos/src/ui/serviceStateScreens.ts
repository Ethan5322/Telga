/**
 * Provider outage, and Telga being unreachable.
 *
 * CLAUDE.md §16 specifies both, and they behave differently on purpose.
 *
 * ## Outage: block one product, keep the rest
 *
 * When a provider is down, **only that provider's product stops.** Everything
 * else stays sellable — a shop losing one network should not lose its whole
 * counter. The screen says which product and in plain language, in English
 * and Amharic, and it makes clear that nothing was charged: no debit, no
 * commission, no customer transaction for a blocked request.
 *
 * There is **no merchant override**. §16 is explicit, and the reason is that
 * an override is a way to take a customer's money for something that cannot
 * be delivered.
 *
 * ## Offline: stop selling, keep everything else
 *
 * When Telga itself is unreachable, no new sale may start — the balance and
 * the ledger live on the server, and a client that guesses at them is how a
 * float goes wrong. History, settings and support stay open, because those
 * are exactly what an operator needs while waiting.
 *
 * **No offline vending in the pilot** (§16). This screen is what "no" looks
 * like: an explanation and the things that still work, not a queue of sales
 * waiting to be reconciled later.
 */

import { t } from '@telga/localization';
import { page } from './chrome';
import type { Chrome } from './chrome';
import { h } from './element';
import type { El } from './element';

export interface OutageScreenProps {
  readonly chrome: Chrome;
  /** The product that is unavailable, already translated. */
  readonly productLabel: string;
  /** What is still sellable, so the operator can carry on. */
  readonly stillAvailable: readonly { readonly label: string; readonly href: string }[];
  /** When Telga last heard from the provider, for support to quote. */
  readonly lastCheckedAt?: string;
}

export function outageScreen(props: OutageScreenProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'outage.heading'),
    h(
      'div',
      { class: 'service-state service-state--outage', 'data-testid': 'outage-screen' },
      h('p', { class: 'service-state__icon', 'aria-hidden': 'true' }, '⚠'),
      h(
        'p',
        { class: 'service-state__headline', 'data-testid': 'outage-product' },
        `${props.productLabel}: ${t(locale, 'outage.unavailable')}`,
      ),
      // The thing a merchant most needs to know, and the thing they will be
      // asked by the customer standing there.
      h(
        'p',
        { class: 'service-state__reassure', 'data-testid': 'outage-no-charge' },
        t(locale, 'outage.no_charge'),
      ),
      props.lastCheckedAt !== undefined &&
        h(
          'p',
          { class: 'service-state__detail', 'data-testid': 'outage-checked-at' },
          `${t(locale, 'outage.last_checked')} ${props.lastCheckedAt.replace('T', ' ').slice(0, 19)}`,
        ),
    ),
    // Everything else still works. Listed rather than described, so the
    // operator's next tap is on the screen.
    props.stillAvailable.length > 0 &&
      h(
        'div',
        { 'data-testid': 'outage-still-available' },
        h('h2', { class: 'settings__section' }, t(locale, 'outage.still_available')),
        h(
          'div',
          { class: 'topup__options' },
          ...props.stillAvailable.map((item) =>
            h(
              'a',
              { href: item.href, class: 'topup__option', 'data-testid': `outage-alt-${item.href}` },
              h('span', { class: 'topup__label' }, item.label),
            ),
          ),
        ),
      ),
    h(
      'p',
      { class: 'voucher__actions' },
      h(
        'a',
        { href: '/dashboard', class: 'voucher__button voucher__button--main', 'data-testid': 'main-button' },
        t(locale, 'voucher.action.main'),
      ),
    ),
  );
}

export interface OfflineScreenProps {
  readonly chrome: Chrome;
  readonly lastSeenAt?: string;
}

export function offlineScreen(props: OfflineScreenProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'offline.heading'),
    h(
      'div',
      { class: 'service-state service-state--offline', 'data-testid': 'offline-screen' },
      h('p', { class: 'service-state__icon', 'aria-hidden': 'true' }, '⊘'),
      h('p', { class: 'service-state__headline' }, t(locale, 'offline.no_sales')),
      // Said plainly, because the alternative an operator will reach for is
      // selling anyway and reconciling later — which the pilot does not allow.
      h(
        'p',
        { class: 'service-state__reassure', 'data-testid': 'offline-no-vending' },
        t(locale, 'offline.no_offline_vending'),
      ),
      props.lastSeenAt !== undefined &&
        h(
          'p',
          { class: 'service-state__detail', 'data-testid': 'offline-last-seen' },
          `${t(locale, 'offline.last_seen')} ${props.lastSeenAt.replace('T', ' ').slice(0, 19)}`,
        ),
    ),
    // What still works while waiting. History, settings and support are all
    // local reads or local screens.
    h('h2', { class: 'settings__section' }, t(locale, 'offline.still_available')),
    h(
      'div',
      { class: 'topup__options', 'data-testid': 'offline-still-available' },
      h(
        'a',
        { href: '/transactions', class: 'topup__option', 'data-testid': 'offline-history' },
        h('span', { class: 'topup__label' }, t(locale, 'menu.statements')),
      ),
      h(
        'a',
        { href: '/settings', class: 'topup__option', 'data-testid': 'offline-settings' },
        h('span', { class: 'topup__label' }, t(locale, 'menu.settings')),
      ),
      h(
        'a',
        { href: '/help', class: 'topup__option', 'data-testid': 'offline-help' },
        h('span', { class: 'topup__label' }, t(locale, 'menu.help')),
      ),
    ),
  );
}
