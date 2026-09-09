/**
 * The operations screens: transactions, operators, and provider health.
 *
 * ## Why these exist
 *
 * An audit on 2026-09-09 compared the console's routes against
 * `ADMIN_PERMISSIONS` and found **fourteen of thirty permissions with no button
 * anywhere** — the console could create shops and devices and then had nothing
 * to say about what they did afterwards.
 *
 * The three built here are the ones an operations desk cannot work without:
 *
 * - **Shop activity.** Per-shop counts and volumes, and nothing finer. A
 *   transaction list and detail page were built here and **removed the same
 *   day** by founder decision D144: Telga staff see aggregates, never a shop's
 *   individual sales. The cost — `CLAUDE.md` §17's search by transaction id is
 *   not possible from this console — is recorded as R44 rather than absorbed.
 * - **Operators.** A shop's staff are who actually sign in. Suspending one, or
 *   resetting a forgotten PIN, is routine work that had to be done by CLI.
 * - **Provider health.** §16 requires outage isolation and §26 asks for outage
 *   duration as a pilot metric. The events were being recorded and never read.
 *
 * ## What they deliberately do not show
 *
 * A recipient's full phone number. `transactions.recipient_masked` is what a
 * screen may render; the hash exists for matching and is never displayed.
 * §22's *"no unnecessary personal data"* applies to an internal console as much
 * as to a receipt — an ops screen that lists customer numbers turns every
 * person with console access into a holder of them.
 */

import { NAV, h, page } from './page';
import type { ConsoleChrome, El } from './page';

export interface Allowed {
  has(permission: string): boolean;
}

const money = (minor: number): string =>
  `${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} ETB`;

/** A state's tone, so a failure is not read as a success at a glance. */
const stateTone = (state: string): string => {
  if (state === 'SUCCESSFUL') return 'good';
  if (state === 'FAILED' || state === 'REJECTED' || state === 'REVERSED') return 'bad';
  if (state === 'PENDING' || state === 'UNDER_REVIEW' || state === 'REVERSAL_REQUIRED') {
    return 'warn';
  }
  return 'plain';
};

// ---------------------------------------------------------------------------
// Shop activity — aggregates only
// ---------------------------------------------------------------------------

/**
 * What a shop traded, without what it sold to whom.
 *
 * ## Why there is no transaction list here, and no detail page
 *
 * There was, for about an hour on 2026-09-09, and the founder removed it —
 * [[Decision Log]] **D144**. The rule is theirs and it is stated plainly: *"the
 * Admin Panel sees aggregates and performance, not individual transactions."*
 * A Telga employee browsing a shop's line-by-line trade is a privacy boundary
 * the founder chose to draw, and a screen that renders one row per sale cannot
 * be made to respect it.
 *
 * ## What that costs, stated here rather than discovered later
 *
 * `CLAUDE.md` §17 — the "paid but no airtime" procedure — begins *"search by
 * transaction ID, receipt, time, amount, or reference"* and requires a final
 * answer within 24 hours. **That search is not possible from this console**,
 * by design, and no replacement mechanism exists yet. The founder was shown
 * this consequence and confirmed the choice. It is recorded as R44 and as an
 * open gap in [[Support and Disputes]], not quietly absorbed.
 *
 * ## What is safe to show, and why these numbers in particular
 *
 * Counts and totals per shop, plus counts by state. A **pending** or
 * **under-review** count is the one thing an operations desk genuinely needs
 * from this screen: it says *a shop has a problem* without saying *whose money
 * it was*. That is the boundary — the existence of trouble is a platform fact,
 * the individual sale is the shop's business.
 *
 * No recipient in any form, no transaction id, no amount of any single sale.
 */

export interface ShopActivityRow {
  readonly merchantId: string;
  readonly status: string;
  readonly sales: number;
  readonly volumeMinor: number;
  readonly successful: number;
  readonly pending: number;
  readonly underReview: number;
  readonly failed: number;
  readonly lastSaleAt: string | null;
}

export interface ActivityProps {
  readonly chrome: ConsoleChrome;
  readonly rows: readonly ShopActivityRow[];
  readonly totals: {
    readonly shops: number;
    readonly sales: number;
    readonly volumeMinor: number;
    readonly pending: number;
    readonly underReview: number;
  };
}

export function activityScreen(props: ActivityProps): El {
  const { chrome, totals } = props;

  const stat = (label: string, value: string, id: string, tone?: string): El =>
    h(
      'div',
      { class: 'console__stat', 'data-tone': tone },
      h('span', { class: 'console__stat-label' }, label),
      h('span', { class: 'console__stat-value', 'data-testid': id }, value),
    );

  return page(
    { ...chrome, section: 'activity' },
    'Shop activity',
    h(
      'p',
      { class: 'console__note', 'data-testid': 'activity-privacy-note' },
      'Aggregates only. Telga staff do not see a shop’s individual transactions, recipients or ' +
        'sale amounts — see Decision Log D144.',
    ),

    h(
      'section',
      { class: 'console__stats', 'data-testid': 'activity-totals' },
      stat('Shops trading', String(totals.shops), 'activity-total-shops'),
      stat('Sales', String(totals.sales), 'activity-total-sales'),
      stat('Volume', money(totals.volumeMinor), 'activity-total-volume'),
      // Surfaced at platform level because these are the two states that mean
      // somebody is waiting for an answer.
      stat('Pending', String(totals.pending), 'activity-total-pending', totals.pending > 0 ? 'warn' : undefined),
      stat(
        'Under review',
        String(totals.underReview),
        'activity-total-under-review',
        totals.underReview > 0 ? 'bad' : undefined,
      ),
    ),

    props.rows.length === 0
      ? h('p', { 'data-testid': 'activity-empty' }, 'No shop has traded yet.')
      : h(
          'table',
          { class: 'console__table', 'data-testid': 'activity-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', { scope: 'col' }, 'Shop'),
              h('th', { scope: 'col' }, 'Status'),
              h('th', { scope: 'col' }, 'Sales'),
              h('th', { scope: 'col' }, 'Volume'),
              h('th', { scope: 'col' }, 'Successful'),
              h('th', { scope: 'col' }, 'Pending'),
              h('th', { scope: 'col' }, 'Under review'),
              h('th', { scope: 'col' }, 'Failed'),
              h('th', { scope: 'col' }, 'Last sale'),
            ),
          ),
          h(
            'tbody',
            {},
            ...props.rows.map((row) =>
              h(
                'tr',
                { 'data-testid': `activity-${row.merchantId}` },
                h('td', {}, row.merchantId),
                h(
                  'td',
                  {},
                  h(
                    'span',
                    { class: 'console__pill', 'data-tone': row.status === 'ACTIVE' ? 'good' : 'bad' },
                    row.status,
                  ),
                ),
                h('td', {}, String(row.sales)),
                h('td', {}, money(row.volumeMinor)),
                h('td', {}, String(row.successful)),
                h(
                  'td',
                  { 'data-tone': row.pending > 0 ? 'warn' : undefined, 'data-testid': `activity-pending-${row.merchantId}` },
                  String(row.pending),
                ),
                h(
                  'td',
                  { 'data-tone': row.underReview > 0 ? 'bad' : undefined, 'data-testid': `activity-review-${row.merchantId}` },
                  String(row.underReview),
                ),
                h('td', {}, String(row.failed)),
                h('td', {}, row.lastSaleAt?.slice(0, 19).replace('T', ' ') ?? '—'),
              ),
            ),
          ),
        ),
  );
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

export interface OperatorRow {
  readonly id: string;
  readonly merchantId: string;
  readonly displayName: string;
  readonly role: string;
  readonly status: string;
  readonly lockedUntil: string | null;
  readonly lastLoginAt: string | null;
  readonly mustChangePin: boolean;
}

export interface OperatorsProps {
  readonly chrome: ConsoleChrome;
  readonly rows: readonly OperatorRow[];
  readonly allowed: Allowed;
  readonly error?: string;
  readonly notice?: string;
}

/**
 * The people who actually sign in at a counter.
 *
 * Two controls, and they are different acts. **Suspend** stops a person; the
 * shop keeps trading on its other operators — the same shape as stopping one
 * device rather than suspending a merchant. **Reset PIN** issues a temporary
 * one and forces a change at next sign-in, which is the only safe way to hand a
 * PIN over: one that Telga staff have read aloud is a shared secret with an
 * unknown number of holders.
 *
 * A locked-out operator is shown as locked with the time it lifts, because the
 * commonest support call about sign-in is somebody who has simply mistyped
 * their PIN four times and needs to be told to wait five minutes rather than
 * have anything reset.
 */
export function operatorsScreen(props: OperatorsProps): El {
  const { chrome, rows, allowed } = props;

  return page(
    { ...chrome, section: 'operators' },
    'Operators',
    props.error !== undefined &&
      h('p', { class: 'console__error', role: 'alert', 'data-testid': 'operators-error' }, props.error),
    props.notice !== undefined &&
      h('p', { class: 'console__note', role: 'status', 'data-testid': 'operators-notice' }, props.notice),
    rows.length === 0
      ? h('p', { 'data-testid': 'operators-empty' }, 'No operators yet. Issuing credentials to a shop creates one.')
      : h(
          'table',
          { class: 'console__table', 'data-testid': 'operators-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', { scope: 'col' }, 'Operator'),
              h('th', { scope: 'col' }, 'Merchant'),
              h('th', { scope: 'col' }, 'Role'),
              h('th', { scope: 'col' }, 'Status'),
              h('th', { scope: 'col' }, 'Last sign-in'),
              h('th', { scope: 'col' }, ''),
            ),
          ),
          h(
            'tbody',
            {},
            ...rows.map((row) =>
              h(
                'tr',
                { 'data-testid': `operator-${row.id}`, 'data-status': row.status },
                h(
                  'td',
                  {},
                  h('div', {}, row.displayName),
                  h('div', { class: 'console__muted' }, row.id),
                ),
                h('td', {}, row.merchantId),
                h('td', {}, row.role),
                h(
                  'td',
                  {},
                  h(
                    'span',
                    {
                      class: 'console__pill',
                      'data-tone': row.status === 'ACTIVE' ? 'good' : 'bad',
                      'data-testid': `operator-status-${row.id}`,
                    },
                    row.status,
                  ),
                  // Locked out is not suspended, and telling them apart saves a
                  // reset that was never needed.
                  row.lockedUntil !== null &&
                    h(
                      'span',
                      { class: 'console__pill', 'data-tone': 'warn', 'data-testid': `operator-locked-${row.id}` },
                      `locked until ${row.lockedUntil.slice(11, 19)}`,
                    ),
                  row.mustChangePin &&
                    h(
                      'span',
                      { class: 'console__pill', 'data-tone': 'warn', 'data-testid': `operator-must-change-${row.id}` },
                      'must change PIN',
                    ),
                ),
                h('td', {}, row.lastLoginAt?.slice(0, 19).replace('T', ' ') ?? 'never'),
                h(
                  'td',
                  { class: 'console__actions' },
                  allowed.has('ADMIN_SUSPEND_OPERATOR') &&
                    h(
                      'form',
                      {
                        method: 'post',
                        action: `/operators/${encodeURIComponent(row.id)}/${row.status === 'ACTIVE' ? 'suspend' : 'reinstate'}`,
                      },
                      h('input', { type: 'hidden', name: 'csrfToken', value: chrome.csrfToken ?? '' }),
                      h(
                        'button',
                        {
                          type: 'submit',
                          class: 'console__button',
                          'data-testid': `operator-toggle-${row.id}`,
                        },
                        row.status === 'ACTIVE' ? 'Suspend' : 'Reinstate',
                      ),
                    ),
                  allowed.has('ADMIN_RESET_OPERATOR_PIN') &&
                    h(
                      'form',
                      { method: 'post', action: `/operators/${encodeURIComponent(row.id)}/reset-pin` },
                      h('input', { type: 'hidden', name: 'csrfToken', value: chrome.csrfToken ?? '' }),
                      h(
                        'button',
                        {
                          type: 'submit',
                          class: 'console__button',
                          // A reset invalidates the PIN the shop is using right
                          // now, so it asks first. An accidental click here
                          // means a counter that cannot sell until somebody is
                          // reached by phone.
                          'data-confirm': 'Reset this PIN? The operator cannot sign in until they are given the new one.',
                          'data-testid': `operator-reset-${row.id}`,
                        },
                        'Reset PIN',
                      ),
                    ),
                ),
              ),
            ),
          ),
        ),
  );
}

export interface IssuedPinProps {
  readonly chrome: ConsoleChrome;
  readonly operatorId: string;
  readonly pin: string;
}

/**
 * A temporary PIN, shown once.
 *
 * Reached only by `POST`, like the credentials screen and for the same reason:
 * a `GET` would put it in browser history and bring it back on a press of the
 * back button.
 */
export function issuedPinScreen(props: IssuedPinProps): El {
  return page(
    { ...props.chrome, section: 'operators' },
    'Temporary PIN',
    h(
      'section',
      { class: 'console__handover', role: 'alert', 'data-testid': 'issued-pin' },
      h('h2', {}, 'Shown once'),
      h('p', { 'data-testid': 'issued-pin-operator' }, `Operator: ${props.operatorId}`),
      h('p', { class: 'console__secret', 'data-testid': 'issued-pin-value' }, props.pin),
      h(
        'p',
        {},
        'Telga stores only a hash and cannot show this again. The operator must change it at ' +
          'next sign-in — a PIN that staff have read aloud belongs to everyone who heard it.',
      ),
    ),
    h('p', {}, h('a', { href: '/operators', 'data-testid': 'issued-pin-back' }, 'Back to operators')),
  );
}

// ---------------------------------------------------------------------------
// Provider health
// ---------------------------------------------------------------------------

export interface ProviderHealthRow {
  readonly providerId: string;
  readonly status: string;
  readonly previousStatus: string | null;
  readonly at: string;
  readonly detail: string | null;
}

export interface ProviderHealthProps {
  readonly chrome: ConsoleChrome;
  /** The latest state per provider. */
  readonly current: readonly ProviderHealthRow[];
  /** Recent transitions, newest first. */
  readonly history: readonly ProviderHealthRow[];
}

/**
 * What each provider is doing, and what it has been doing.
 *
 * §16 requires outage isolation and §26 asks for outage duration as a pilot
 * metric. `provider_health_events` was being written and never read by anything
 * a person could open, so *"how long was that network down yesterday"* had no
 * answer despite the data existing.
 *
 * Current state first, because that is the question during an incident. History
 * second, because that is the question after one.
 */
export function providerHealthScreen(props: ProviderHealthProps): El {
  const { chrome } = props;
  const tone = (status: string): string =>
    status === 'HEALTHY' ? 'good' : status === 'DEGRADED' ? 'warn' : 'bad';

  return page(
    { ...chrome, section: 'provider-health' },
    'Provider health',
    h(
      'p',
      { class: 'console__note' },
      'A provider outage blocks only that provider’s products. Other approved services stay ' +
        'sellable, and no merchant can override a block.',
    ),
    h('h2', {}, 'Now'),
    props.current.length === 0
      ? h(
          'p',
          { 'data-testid': 'provider-health-empty' },
          'No provider health has been recorded yet. Events appear here the first time a provider ' +
            'changes state.',
        )
      : h(
          'table',
          { class: 'console__table', 'data-testid': 'provider-health-current' },
          h(
            'thead',
            {},
            h('tr', {}, h('th', { scope: 'col' }, 'Provider'), h('th', { scope: 'col' }, 'Status'), h('th', { scope: 'col' }, 'Since'), h('th', { scope: 'col' }, 'Detail')),
          ),
          h(
            'tbody',
            {},
            ...props.current.map((row) =>
              h(
                'tr',
                { 'data-testid': `provider-${row.providerId}`, 'data-status': row.status },
                h('td', {}, row.providerId),
                h('td', {}, h('span', { class: 'console__pill', 'data-tone': tone(row.status) }, row.status)),
                h('td', {}, row.at.slice(0, 19).replace('T', ' ')),
                h('td', {}, row.detail ?? '—'),
              ),
            ),
          ),
        ),
    h('h2', {}, 'Recent changes'),
    props.history.length === 0
      ? h('p', { 'data-testid': 'provider-history-empty' }, 'No transitions recorded.')
      : h(
          'table',
          { class: 'console__table', 'data-testid': 'provider-health-history' },
          h(
            'thead',
            {},
            h('tr', {}, h('th', { scope: 'col' }, 'When'), h('th', { scope: 'col' }, 'Provider'), h('th', { scope: 'col' }, 'Change'), h('th', { scope: 'col' }, 'Detail')),
          ),
          h(
            'tbody',
            {},
            ...props.history.map((row) =>
              h(
                'tr',
                {},
                h('td', {}, row.at.slice(0, 19).replace('T', ' ')),
                h('td', {}, row.providerId),
                h('td', {}, `${row.previousStatus ?? 'first seen'} → ${row.status}`),
                h('td', {}, row.detail ?? '—'),
              ),
            ),
          ),
        ),
  );
}

/** Re-exported so the server can render nav-aware screens without another import. */
export { NAV };
