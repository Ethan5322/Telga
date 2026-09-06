/**
 * The Telga vending dashboard and its service grid.
 *
 * ## The service-status rule
 *
 * A tile is `IMPLEMENTED` only if a real route, backend, validation and
 * result path already exist in this repository — verified by direct
 * inspection, not assumed because a service is common in Ethiopia. Today
 * that is exactly two services: Airtime (`/sell`) and Vouchers
 * (`/vouchers`). Every other tile this file renders is `COMING_SOON`, and
 * seven more (water, DStv, telecom, traffic, lottery, tickets, fuel) are
 * `HIDDEN` — not rendered at all, because none of them is named anywhere in
 * `CLAUDE.md` or the vault, and showing even an unavailable tile for a
 * product line nobody has approved would itself be an unapproved product
 * claim. See `04 UX UI/Telga Launcher and Dashboard.md`.
 *
 * ## No invented profit — yet
 *
 * The reference terminal shows Balance and Profit as two separate running
 * fields, and that model is confirmed: a sale moves the float by −face value
 * and credits a configurable percentage of it to `TELGA_REVENUE` as a
 * separate ledger entry. The customer always pays face value — profit is a
 * shop-side credit, never a surcharge. See Decision Log D69.
 *
 * **None of it is implemented yet.** No profit is calculated or posted
 * anywhere, so both pill *slots* are rendered for visual parity while the
 * Profit pill's value stays the literal, translated
 * `dashboard.profit.unavailable` text. Showing the slot is a layout
 * decision; showing a number before one is actually posted would be an
 * invented one, and this file does not do that.
 */

import { t } from '@telga/localization';
import type { Locale } from '@telga/localization';
import type { BalanceDto, RemoteData } from '@telga/pos-view-model';
import { page } from './chrome';
import type { Chrome } from './chrome';
import { h } from './element';
import type { El } from './element';
import { renderRemote } from './states';

export type ServiceStatus = 'IMPLEMENTED' | 'COMING_SOON';

export interface ServiceTile {
  readonly id: string;
  readonly labelKey: Parameters<typeof t>[1];
  readonly icon: string;
  readonly colour: string;
  readonly status: ServiceStatus;
  readonly href: string;
}

/**
 * Every tile this dashboard is allowed to render. Water, DStv, telecom
 * bill, traffic, lottery, tickets and fuel are deliberately absent — adding
 * a row here is the one place a hidden service would need to be listed, so
 * a reviewer can see exactly what is and is not shown by reading this array
 * alone.
 */
export const DASHBOARD_SERVICES: readonly ServiceTile[] = Object.freeze([
  // Airtime enters the approved voucher sequence, not the legacy single-screen
  // `/sell` form. `/sell` stays reachable and unchanged in behaviour, but it is
  // a direct airtime-to-cellphone flow and is no longer what this tile means.
  { id: 'vouchers', labelKey: 'screen.vouchers', icon: '🎟️', colour: 'red', status: 'IMPLEMENTED', href: '/vouchers' },
  { id: 'airtime', labelKey: 'voucher.product.airtime', icon: '📱', colour: 'blue', status: 'IMPLEMENTED', href: '/vouchers/airtime' },
  { id: 'data', labelKey: 'dashboard.service.data', icon: '📶', colour: 'purple', status: 'COMING_SOON', href: '/dashboard/data' },
  { id: 'electricity', labelKey: 'dashboard.service.electricity', icon: '⚡', colour: 'yellow', status: 'COMING_SOON', href: '/dashboard/electricity' },
  { id: 'water', labelKey: 'dashboard.service.water', icon: '💧', colour: 'cyan', status: 'COMING_SOON', href: '/dashboard/water' },
  { id: 'dstv', labelKey: 'dashboard.service.dstv', icon: '📺', colour: 'navy', status: 'COMING_SOON', href: '/dashboard/dstv' },
  { id: 'telecom', labelKey: 'dashboard.service.telecom', icon: '☎️', colour: 'green', status: 'COMING_SOON', href: '/dashboard/telecom' },
  { id: 'traffic', labelKey: 'dashboard.service.traffic', icon: '🚗', colour: 'orange', status: 'COMING_SOON', href: '/dashboard/traffic' },
  { id: 'lottery', labelKey: 'dashboard.service.lottery', icon: '🎰', colour: 'red', status: 'COMING_SOON', href: '/dashboard/lottery' },
  { id: 'tickets', labelKey: 'dashboard.service.tickets', icon: '🎫', colour: 'sky', status: 'COMING_SOON', href: '/dashboard/tickets' },
  { id: 'fuel', labelKey: 'dashboard.service.fuel', icon: '⛽', colour: 'charcoal', status: 'COMING_SOON', href: '/dashboard/fuel' },
  { id: 'account', labelKey: 'dashboard.service.account', icon: '💰', colour: 'green', status: 'COMING_SOON', href: '/dashboard/account' },

  // --- added 2026-08-29, from research rather than assumption ---------------
  //
  // Four more services that Ethiopian shops and their customers still settle
  // manually or through an agent. Each was checked against a source before it
  // was listed here, because §30 forbids inventing a product line and a
  // rendered tile is itself a product claim:
  //
  //   internet   — WEBSPRIX and other ISP bills are paid over the counter
  //                through Telebirr and CBE Birr agents.
  //   school     — school fees are still largely cash and paper; platforms
  //                like Adeyfee exist precisely because of that.
  //   insurance  — Community-Based Health Insurance premium collection is
  //                described in the sector's own literature as predominantly
  //                manual and cash-based.
  //   govfees    — government service fees are moving online under the
  //                National Digital Payments Strategy 2026–2030, which is
  //                itself the evidence that they are not there yet.
  //
  // All four are COMING_SOON, like every tile but Airtime and Vouchers. None
  // has a provider agreement, a price, or a commission behind it, and none may
  // become IMPLEMENTED until a real route, backend, validation and result path
  // exist — the rule at the top of this file.
  { id: 'internet', labelKey: 'dashboard.service.internet', icon: '🌐', colour: 'sky', status: 'COMING_SOON', href: '/dashboard/internet' },
  { id: 'school', labelKey: 'dashboard.service.school', icon: '🎓', colour: 'navy', status: 'COMING_SOON', href: '/dashboard/school' },
  { id: 'insurance', labelKey: 'dashboard.service.insurance', icon: '🛡️', colour: 'purple', status: 'COMING_SOON', href: '/dashboard/insurance' },
  { id: 'govfees', labelKey: 'dashboard.service.govfees', icon: '🏛️', colour: 'charcoal', status: 'COMING_SOON', href: '/dashboard/govfees' },
]);

export interface DashboardProps {
  readonly chrome: Chrome;
  readonly balance: RemoteData<BalanceDto>;
  /**
   * Replace the balance with dots until the operator asks to see it.
   *
   * A counter screen is read by whoever is standing at it. A shop that does
   * not want its float visible to a queue turns this on; the figure is one
   * tap away, not gone.
   */
  readonly hideBalance?: boolean;
  /** Warn when the float is running out, so a sale is not refused mid-queue. */
  readonly lowBalanceAlert?: boolean;
  /** Below this, the alert shows. Minor units. */
  readonly lowBalanceThresholdMinor?: number;
}

/** Where "running low" starts, when the shop has not said otherwise. */
export const DEFAULT_LOW_BALANCE_MINOR = 5_000;

function serviceTileEl(locale: Locale, tile: ServiceTile): El {
  const comingSoon = tile.status === 'COMING_SOON';
  return h(
    'a',
    {
      href: tile.href,
      class: `dashboard__tile dashboard__tile--${tile.colour}`,
      'data-testid': `service-tile-${tile.id}`,
      'data-status': tile.status,
    },
    h('span', { class: 'dashboard__tile-icon', 'aria-hidden': 'true' }, tile.icon),
    h('span', { class: 'dashboard__tile-label' }, t(locale, tile.labelKey)),
    comingSoon &&
      h(
        'span',
        { class: 'dashboard__tile-badge', 'data-testid': `service-tile-${tile.id}-badge` },
        `🕒 ${t(locale, 'screen.coming_soon')}`,
      ),
  );
}

function navItem(href: string, testId: string, icon: string, label: string, active: boolean): El {
  return h(
    'a',
    {
      href,
      'data-testid': testId,
      class: 'dashboard__bottom-nav-item',
      'aria-current': active ? 'page' : undefined,
    },
    h('span', { class: 'dashboard__bottom-nav-icon', 'aria-hidden': 'true' }, icon),
    h('span', { class: 'dashboard__bottom-nav-label' }, label),
  );
}

function bottomNav(locale: Locale): El {
  return h(
    'nav',
    { class: 'dashboard__bottom-nav', 'aria-label': 'Telga dashboard sections' },
    navItem('/dashboard', 'dashboard-nav-prepaid', '🛒', t(locale, 'dashboard.nav.prepaid'), true),
    navItem('/pay', 'dashboard-nav-payments', '💳', t(locale, 'dashboard.nav.payments'), false),
    // `/settings`, not `/`. `/` is the legacy POS home whose primary action
    // opens the old single-screen sale form, so this tile — sitting on the
    // dashboard itself — was a one-tap route straight back to the screen the
    // vending dashboard replaced. Settings is the only account-shaped
    // destination that actually exists.
    navItem('/settings', 'dashboard-nav-account', '👤', t(locale, 'settings.tile.label'), false),
    // Reprint now has a real backend — receipt lookup plus `recordReprint`
    // wiring — so this opens the transaction list, where each completed sale
    // carries its own Reprint action.
    navItem('/transactions', 'dashboard-nav-reprint', '🖨️', t(locale, 'dashboard.nav.reprint'), false),
    // Settings lives in the bottom navigation rather than the service grid:
    // the twelve-tile arrangement is the accepted visual design, and a
    // thirteenth tile would change it. It is also not a service a merchant
    // sells — it belongs beside the other places they *go*.
    navItem('/settings', 'dashboard-nav-settings', '⚙️', t(locale, 'settings.tile.label'), false),
  );
}

export function dashboardScreen(props: DashboardProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'screen.dashboard'),
    // No dedicated "shop name" field exists in the domain model (confirmed:
    // `MerchantRow` carries only an id). The merchant identifier is shown
    // plainly rather than inventing a friendly name the schema does not have.
    h('p', { class: 'dashboard__merchant', 'data-testid': 'dashboard-merchant' }, `${chrome.merchantId}`),
    // The service grid first, then the balance/profit pills, then the bottom
    // navigation — the order the reference terminal uses, so an operator
    // reads services first and their money second.
    h(
      'div',
      { class: 'dashboard__grid', 'data-testid': 'dashboard-service-grid' },
      ...DASHBOARD_SERVICES.map((tile) => serviceTileEl(locale, tile)),
    ),
    // Running low, when the shop asked to be told. Above the pills, because a
    // float about to run out should be met before the tiles, not after a sale
    // has already been refused mid-queue.
    props.lowBalanceAlert === true &&
      props.balance.status === 'READY' &&
      props.balance.data.available.amountMinor <
        (props.lowBalanceThresholdMinor ?? DEFAULT_LOW_BALANCE_MINOR) &&
      h(
        'p',
        {
          class: 'dashboard__alert',
          role: 'status',
          'data-tone': 'CAUTION',
          'data-testid': 'low-balance-alert',
        },
        t(locale, 'dashboard.low_balance'),
      ),
    h(
      'div',
      { class: 'dashboard__pills', 'data-testid': 'dashboard-pills' },
      renderRemote(props.balance, {
        what: 'balance',
        emptyMessage: 'No balance to show yet.',
        locale,
        // The balance, with a "+" beside it. The figure stays plain text —
        // it is a number to read, not a control — and the "+" is the one
        // thing here that goes somewhere.
        render: (balance) =>
          h(
            'p',
            { class: 'dashboard__pill dashboard__pill--balance', 'data-testid': 'dashboard-balance-pill' },
            h(
              'span',
              { class: 'dashboard__pill-text' },
              props.hideBalance === true
                ? // Hidden, not removed: `<details>` reveals it with no script,
                  // so the figure is one tap away on a machine whose browser
                  // the shop does not control.
                  h(
                    'span',
                    { class: 'dashboard__hidden' },
                    `${t(locale, 'dashboard.balance.pill')} `,
                    h(
                      'details',
                      { class: 'dashboard__reveal', 'data-testid': 'balance-hidden' },
                      h('summary', {}, '••••••'),
                      h('span', { 'data-testid': 'balance-revealed' }, balance.available.formatted),
                    ),
                  )
                : `${t(locale, 'dashboard.balance.pill')} ${balance.available.formatted}`,
            ),
            h(
              'a',
              {
                href: '/topup',
                class: 'dashboard__add',
                'aria-label': t(locale, 'balance.top_up.open'),
                'data-testid': 'dashboard-balance-add',
              },
              '+',
            ),
          ),
      }),
      // Today's profit, read from the ledger. Before the profit model existed
      // this pill could only say "unavailable"; now it has a real figure, and
      // it still says "unavailable" whenever the balance read failed rather
      // than showing a confident zero it cannot stand behind.
      renderRemote(props.balance, {
        what: 'profit',
        emptyMessage: 'No profit to show yet.',
        locale,
        // The pill is a link now, not a label: pressing Profit is how an
        // owner moves it into the selling balance. It stays a plain anchor —
        // the screen it opens is where the amount is typed and where the
        // server re-checks it, so nothing is decided by pressing this.
        render: (balance) =>
          h(
            'a',
            {
              href: '/profit/transfer',
              class: 'dashboard__pill dashboard__pill--profit',
              'data-testid': 'dashboard-profit-pill',
            },
            `${t(locale, 'dashboard.profit.pill')}: ${
              balance.todayProfit?.formatted ?? t(locale, 'dashboard.profit.unavailable')
            }`,
          ),
      }),
    ),
    bottomNav(locale),
    h(
      'p',
      { class: 'dashboard__launcher-link' },
      h('a', { href: '/launcher', 'data-testid': 'back-to-launcher' }, t(locale, 'dashboard.back_to_launcher')),
    ),
  );
}

export interface ComingSoonProps {
  readonly chrome: Chrome;
  readonly service: string;
}

/**
 * The one screen every `COMING_SOON` tile leads to. Creates nothing, calls
 * nothing, and never pretends to retrieve or pay anything — see the file
 * header.
 */
export function comingSoonScreen(props: ComingSoonProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'screen.coming_soon'),
    h('p', { 'data-testid': 'coming-soon-message', role: 'status' }, t(locale, 'dashboard.coming_soon.message')),
    h(
      'p',
      {},
      h('a', { href: '/dashboard', 'data-testid': 'coming-soon-back' }, t(locale, 'voucher.action.back')),
      ' · ',
      h('a', { href: '/launcher', 'data-testid': 'coming-soon-home' }, t(locale, 'dashboard.back_to_launcher')),
    ),
  );
}
