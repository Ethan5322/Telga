/**
 * The screens the three-bar menu opens.
 *
 * Help, Learning, the customer list, ending a shift, and the policy texts.
 * They live together because they share a shape: a heading, some content, and
 * a Back link — none of them move money, and none of them are part of the
 * sale flow.
 */

import { t } from '@telga/localization';
import type { Locale } from '@telga/localization';
import { page } from './chrome';
import type { Chrome } from './chrome';
import { h } from './element';
import type { El } from './element';
import { telgaLogo } from './logo';
import { isEnabled } from '@telga/domain';

/** Back to wherever the operator came from, plus the dashboard. */
function footer(locale: Locale, backHref: string): El {
  return h(
    'p',
    { class: 'voucher__actions' },
    h('a', { href: backHref, class: 'voucher__button', 'data-testid': 'back' }, t(locale, 'settings.back')),
    h(
      'a',
      { href: '/dashboard', class: 'voucher__button voucher__button--main', 'data-testid': 'main-button' },
      t(locale, 'voucher.action.main'),
    ),
  );
}

// --- help ---------------------------------------------------------------------

export interface HelpScreenProps {
  readonly chrome: Chrome;
  readonly support: {
    /** Absent while no line is answered — see `content.ts`. */
    readonly phone?: string | undefined;
    readonly email: string;
    readonly hours: string;
    readonly address: string;
    /** Shown above the details whenever there is no staffed desk behind them. */
    readonly notice?: string | undefined;
  };
}

/**
 * Telga support, in every form a merchant might reach it by.
 *
 * The address is plain text so a shop with no data connection can read it off
 * the screen to somebody else's phone.
 *
 * **There is no phone row while there is no number.** It is not rendered blank
 * or as a placeholder: a `tel:` link an operator can tap, that rings nowhere,
 * is a worse answer than an absent row — and this screen's text is what the
 * receipt carries, so it is handed to customers on paper too. The notice takes
 * its place and says plainly that nobody is on call.
 */
export function helpScreen(props: HelpScreenProps): El {
  const { chrome, support } = props;
  const locale = chrome.locale;
  const row = (labelKey: Parameters<typeof t>[1], value: El | string, id: string): El =>
    h(
      'tr',
      {},
      h('th', { scope: 'row' }, t(locale, labelKey)),
      h('td', { 'data-testid': id }, value),
    );

  return page(
    chrome,
    t(locale, 'screen.help'),
    h('p', { class: 'voucher__notice' }, t(locale, 'help.intro')),
    support.notice !== undefined &&
      h(
        'p',
        { class: 'voucher__notice', role: 'alert', 'data-tone': 'CAUTION', 'data-testid': 'support-notice' },
        support.notice,
      ),
    h(
      'table',
      { class: 'voucher__summary-card', 'data-testid': 'support-details' },
      h(
        'tbody',
        {},
        support.phone !== undefined &&
          row(
            'help.phone',
            h('a', { href: `tel:${support.phone.replace(/\s/g, '')}` }, support.phone),
            'support-phone',
          ),
        row('help.email', h('a', { href: `mailto:${support.email}` }, support.email), 'support-email'),
        row('help.hours', support.hours, 'support-hours'),
        row('help.address', support.address, 'support-address'),
      ),
    ),
    h('p', { class: 'voucher__custom-hint' }, t(locale, 'help.reference_hint')),
    /**
     * Report a problem — §17.2.
     *
     * `/complaint` was built and linked from nowhere. Help is where a
     * shopkeeper looks when something has gone wrong, so it belongs here as
     * well as on the transaction itself: the transaction link is for "this
     * sale", this one is for "something happened and I do not know which sale".
     */
    h(
      'p',
      {},
      h(
        'a',
        { href: '/complaint', class: 'voucher__button', 'data-testid': 'help-report-problem' },
        t(locale, 'complaint.title'),
      ),
    ),
    footer(locale, '/dashboard'),
  );
}

// --- learning -----------------------------------------------------------------

export interface LearningStep {
  readonly title: string;
  readonly body: string;
  /** Where the step can actually be tried, when there is such a place. */
  readonly href?: string;
}

export interface LearningScreenProps {
  readonly chrome: Chrome;
  readonly steps: readonly LearningStep[];
}

/**
 * A step-by-step manual.
 *
 * Each step links to the screen it describes where one exists, so the manual
 * is something to work through on the machine rather than something to read
 * and then try to remember.
 */
export function learningScreen(props: LearningScreenProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'screen.learning'),
    h('p', { class: 'voucher__notice' }, t(locale, 'learning.intro')),
    h(
      'ol',
      { class: 'learning', 'data-testid': 'learning-steps' },
      ...props.steps.map((step, index) =>
        h(
          'li',
          { class: 'learning__step', 'data-testid': `learning-step-${String(index + 1)}` },
          h('h2', { class: 'learning__title' }, step.title),
          h('p', { class: 'learning__body' }, step.body),
          step.href !== undefined &&
            h('a', { href: step.href, class: 'learning__try' }, t(locale, 'voucher.action.continue')),
        ),
      ),
    ),
    footer(locale, '/dashboard'),
  );
}

// --- customers ----------------------------------------------------------------

export interface CustomerRow {
  readonly id: string;
  readonly displayName: string;
  readonly phoneMasked: string;
}

export interface CustomerScreenProps {
  readonly chrome: Chrome;
  readonly customers: readonly CustomerRow[];
  readonly csrfToken: string;
  readonly errorMessage?: string;
}

/**
 * Regulars a shop types in once.
 *
 * The number is stored **masked**, exactly as a slip prints it and as
 * `transactions.recipient_masked` already does. That is a real limitation and
 * a deliberate one: a customer list holding full numbers would be the largest
 * pool of personal data in the product, on a machine that sits on a counter,
 * in a build with no data-protection review behind it. The screen says so
 * rather than leaving an operator to discover it.
 */
export function customersScreen(props: CustomerScreenProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'screen.customers'),
    props.errorMessage !== undefined &&
      h('p', { role: 'alert', 'data-tone': 'NEGATIVE', 'data-testid': 'customers-error' }, props.errorMessage),
    props.customers.length === 0
      ? h('p', { class: 'voucher__notice', 'data-testid': 'customers-empty' }, t(locale, 'customers.empty'))
      : h(
          'table',
          { class: 'voucher__summary-card', 'data-testid': 'customers-list' },
          h(
            'tbody',
            {},
            ...props.customers.map((customer) =>
              h(
                'tr',
                { 'data-testid': `customer-${customer.id}` },
                h('th', { scope: 'row' }, customer.displayName),
                h('td', {}, customer.phoneMasked),
              ),
            ),
          ),
        ),
    h(
      'form',
      { method: 'post', action: '/customers', 'data-testid': 'customer-form' },
      h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'displayName' }, t(locale, 'customers.name')),
        h('input', {
          id: 'displayName',
          name: 'displayName',
          type: 'text',
          maxlength: '60',
          required: true,
          'data-testid': 'customer-name',
        }),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'phone' }, t(locale, 'customers.phone')),
        h('input', {
          id: 'phone',
          name: 'phone',
          type: 'tel',
          inputmode: 'tel',
          autocomplete: 'off',
          required: true,
          'data-testid': 'customer-phone',
        }),
      ),
      h(
        'button',
        { type: 'submit', class: 'voucher__button voucher__button--primary', 'data-testid': 'customer-save' },
        t(locale, 'customers.add'),
      ),
    ),
    h('p', { class: 'voucher__custom-hint' }, t(locale, 'customers.privacy')),
    footer(locale, '/dashboard'),
  );
}

// --- ending a shift -----------------------------------------------------------

export interface EndShiftScreenProps {
  readonly chrome: Chrome;
  readonly openedAt?: string;
  readonly csrfToken: string;
  readonly ended?: boolean;
}

/**
 * Close the shift.
 *
 * A shift carries no money of its own — the ledger is still the only place
 * value moves — so ending one records a time, nothing more. It asks first,
 * because an accidental end mid-counter-queue is annoying to undo.
 */
export function endShiftScreen(props: EndShiftScreenProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'screen.end_shift'),
    props.ended === true &&
      h('p', { role: 'status', 'data-tone': 'POSITIVE', 'data-testid': 'shift-ended' }, t(locale, 'shift.ended')),
    props.openedAt === undefined
      ? h('p', { class: 'voucher__notice', 'data-testid': 'shift-none' }, t(locale, 'shift.none_open'))
      : h(
          'table',
          { class: 'voucher__summary-card' },
          h(
            'tbody',
            {},
            h(
              'tr',
              {},
              h('th', { scope: 'row' }, t(locale, 'shift.open_since')),
              h('td', { 'data-testid': 'shift-opened-at' }, props.openedAt.replace('T', ' ').slice(0, 19)),
            ),
          ),
        ),
    props.openedAt !== undefined &&
      h(
        'form',
        { method: 'post', action: '/shift/end', 'data-testid': 'end-shift-form' },
        h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
        h(
          'button',
          {
            type: 'submit',
            class: 'voucher__button voucher__button--cancel',
            'data-confirm': t(locale, 'shift.end_confirm'),
            'data-testid': 'end-shift-confirm',
          },
          t(locale, 'shift.end'),
        ),
      ),
    footer(locale, '/dashboard'),
  );
}

// --- about and policies -------------------------------------------------------

export interface PolicyScreenProps {
  readonly chrome: Chrome;
  readonly title: string;
  readonly paragraphs: readonly string[];
}

/**
 * A scrollable text screen: About, Terms, Privacy, Cookies.
 *
 * The texts are **placeholders written for a training build** and say so in
 * their own first paragraph. They are not legal documents and have had no
 * legal review — CLAUDE.md §8 forbids claiming otherwise, and a plausible
 * fake privacy policy is worse than an obviously unfinished one.
 */
export function policyScreen(props: PolicyScreenProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    props.title,
    h('div', { class: 'policy', 'data-testid': 'policy-body' }, ...props.paragraphs.map((p) => h('p', {}, p))),
    footer(locale, '/settings'),
  );
}

// --- topping up the balance ---------------------------------------------------

export interface TopUpScreenProps {
  readonly chrome: Chrome;
  /** Absent when the operator may not deposit — the tile is then not shown. */
  readonly canDeposit: boolean;
}

/**
 * Where the balance "+" button leads.
 *
 * Three ways to add to the selling balance, stacked as full-width targets.
 * Bank deposit and Telga Pay both open the existing training deposit flow;
 * Profit opens the transfer screen. Nothing new moves money here — this
 * screen only routes to the flows that already do, each with its own
 * server-side permission check on arrival.
 */
export function topUpScreen(props: TopUpScreenProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  const option = (href: string, icon: string, labelKey: Parameters<typeof t>[1], id: string): El =>
    h(
      'a',
      { href, class: 'topup__option', 'data-testid': id },
      h('span', { class: 'topup__icon', 'aria-hidden': 'true' }, icon),
      h('span', { class: 'topup__label' }, t(locale, labelKey)),
    );

  return page(
    chrome,
    t(locale, 'balance.top_up'),
    h('div', { class: 'topup__mark' }, telgaLogo({ height: 72, title: '' })),
    h('p', { class: 'topup__heading', 'data-testid': 'topup-heading' }, t(locale, 'balance.top_up')),
    h(
      'div',
      { class: 'topup__options', 'data-testid': 'topup-options' },
      // Both bank-deposit and Telga Pay top-up live under `/pay`, which is
      // refused while `card.simulated` is off. `/topup` itself stays reachable
      // — moving earned profit into the selling float has nothing to do with
      // Telga Pay — so the two Pay options are dropped rather than the screen.
      /**
       * Two ways money comes **in**, and they are not related to each other.
       *
       * **Bank deposit** (§20.1): print a slip, pay it at a bank counter,
       * Telga credits the balance once it confirms the payment against its
       * statement. Slow, and a person verifies it.
       *
       * **Deposit with Telga Pay** (D87/D124): a card at the terminal —
       * insert, swipe or tap. Approved credits immediately; declined changes
       * nothing at all.
       *
       * They share only the balance they land in. The bank route is **not**
       * gated on `card.simulated`: a bank counter has nothing to do with a card
       * reader, and switching the card simulator off must not take the bank
       * slip with it.
       */
      option('/deposit', '🏦', 'bank_deposit.button', 'topup-bank-deposit'),
      /**
       * Chapa — §20.2, and the founder's framing: *"it's one kind of bank
       * deposit method."*
       *
       * Beside the counter slip rather than under Telga Pay, because it does
       * the same job by a different route: money in from outside, landing in
       * the shop's own balance. Telga Pay is a card simulator; this is a real
       * Ethiopian payment company. More methods are expected — *"another bank
       * or provider I will find"* — and they belong on this row.
       */
      ...(isEnabled('deposit.chapa')
        ? [option('/deposit/chapa', '📲', 'chapa.button', 'topup-chapa')]
        : []),
      ...(isEnabled('card.simulated')
        ? [option('/pay/deposit', '💳', 'pay.deposit.entry', 'topup-telga-pay')]
        : []),
      option('/profit/transfer', '📈', 'balance.top_up.profit', 'topup-profit'),
      // Balance moving **sideways**, not in. Listed here because this is where
      // a shopkeeper looks when thinking about balance, but it is not a
      // deposit and the screen says so.
      option('/transfer', '🔁', 'transfer.title', 'topup-shop-transfer'),
    ),
    !props.canDeposit &&
      h('p', { class: 'voucher__custom-hint', 'data-testid': 'topup-owner-note' }, t(locale, 'settings.permission_denied')),
    footer(locale, '/dashboard'),
  );
}
