/**
 * Telga Pay — a module inside Telga, not a second application.
 *
 * Every screen here is UI-only: nothing in this file writes to the database,
 * calls a provider, or reaches the ledger. There is no persistence layer for
 * Telga Pay in this version — state (the chosen flow, amount and note) is
 * carried forward only through the URL's query string between these GET
 * screens, the same way the training-voucher amount screen once was before
 * it gained real backend state. No PIN, card number, or other secret is ever
 * part of that state — there is no PIN entry anywhere in this module, and no
 * card data exists to leak, since none is ever collected.
 *
 * Currency stays ETB throughout, matching the rest of Telga. There is no
 * Rand field anywhere in this module.
 */

import { t } from '@telga/localization';
import { page } from './chrome';
import type { Chrome } from './chrome';
import { h } from './element';
import type { El } from './element';
import { slipCard } from './screens';
import type { SlipStyle } from './screens';

export type PayFlow = 'purchase' | 'cashback';
export type PayOutcome = 'approved' | 'declined' | 'read_error' | 'cancelled';

export interface PayEntryProps {
  readonly chrome: Chrome;
  /** Formatted, e.g. "120.00 ETB" — real data if present, otherwise unused. */
  readonly todaysSalesFormatted?: string;
  /** How many of today's transactions made up that sum. Only meaningful alongside the sum above. */
  readonly todaysSalesCount?: number;
}

function payTile(href: string, testId: string, icon: string, label: string): El {
  return h(
    'a',
    { href, class: 'pay__tile', 'data-testid': testId },
    h('span', { class: 'pay__tile-icon', 'aria-hidden': 'true' }, icon),
    h('span', { class: 'pay__tile-label' }, label),
  );
}

export function payEntryScreen(props: PayEntryProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'screen.pay_entry'),
    h('p', { 'data-testid': 'pay-banner', role: 'status', class: 'pay__banner' }, t(locale, 'pay.banner')),
    props.todaysSalesFormatted !== undefined
      ? h(
          'div',
          { 'data-testid': 'pay-todays-sales', class: 'pay__summary' },
          h('p', { class: 'pay__summary-label' }, t(locale, 'pay.todays_sales_label')),
          h('p', { class: 'pay__summary-amount' }, props.todaysSalesFormatted),
          props.todaysSalesCount !== undefined &&
            h(
              'p',
              { class: 'pay__summary-count' },
              `${props.todaysSalesCount} ${t(locale, 'pay.transactions_label')}`,
            ),
        )
      : h('p', { 'data-testid': 'pay-no-transactions', class: 'pay__summary' }, t(locale, 'pay.no_transactions')),
    h(
      'div',
      { class: 'pay__tiles', 'data-testid': 'pay-tiles' },
      payTile('/pay/purchase', 'pay-purchase-link', '🧾', t(locale, 'pay.purchase.label')),
      payTile('/pay/cashback', 'pay-cashback-link', '🪙', t(locale, 'pay.cashback.label')),
      // The only tile here that changes a balance. Owner-only server-side.
      payTile('/pay/deposit', 'pay-deposit-link', '➕', t(locale, 'pay.deposit.label')),
    ),
    h(
      'p',
      {},
      h('a', { href: '/launcher', 'data-testid': 'back-to-launcher' }, t(locale, 'dashboard.back_to_launcher')),
    ),
  );
}

export interface PayAmountProps {
  readonly chrome: Chrome;
  readonly flow: PayFlow;
}

/**
 * Amount + note entry, for both Purchase and Cashback.
 *
 * A plain GET form: nothing here writes anything, so there is nothing for a
 * CSRF token to protect. Amount and note are not secrets — they travel in
 * the query string exactly like `network`/`productType` already do on the
 * voucher amount screen.
 */
export function payAmountScreen(props: PayAmountProps): El {
  const { chrome, flow } = props;
  const locale = chrome.locale;
  const flowLabel = t(locale, flow === 'purchase' ? 'pay.purchase.label' : 'pay.cashback.label');
  return page(
    chrome,
    `${flowLabel} — ${t(locale, 'screen.pay_amount')}`,
    h(
      'form',
      // --- into the real card flow ------------------------------------
      //
      // This used to target `/pay/card`, a click-through mock: three method
      // links each carrying a pre-decided `outcome=approved|declined|...` in
      // the query string. The outcome was chosen by which link you pressed,
      // there was no PIN step, and only four outcomes existed.
      //
      // Meanwhile the real state machine — `takeCardPayment`, eight test
      // cards, and the three genuine outcomes including *no response* — sat at
      // `/pay/card/present` with **nothing linking to it**. It was reachable
      // only by typing the URL, which is why its tests passed while the flow a
      // merchant actually walks was a mock. That is the defect this fixes.
      //
      // `amountBirr` rather than `amount`: the operator types birr on a keypad
      // and `/pay/card/present` works in minor units, so the name says which
      // this is and the handler converts once.
      {
        method: 'get',
        action: '/pay/card/present',
        'data-testid': 'pay-amount-form',
        class: 'pay__amount-form',
      },
      // Cashback and purchase are the same flow with one extra field, so the
      // kind rides along rather than forking the screen.
      h('input', { type: 'hidden', name: 'kind', value: flow === 'cashback' ? 'CASHBACK' : 'PURCHASE' }),
      h(
        'div',
        { class: 'pay__amount-display' },
        h('label', { for: 'amount', class: 'pay__amount-currency' }, 'ETB'),
        h('input', {
          id: 'amount',
          name: 'amountBirr',
          type: 'number',
          inputmode: 'decimal',
          min: '0',
          step: '0.01',
          required: true,
          placeholder: '0',
          'aria-label': t(locale, 'pay.amount.label'),
          'data-testid': 'pay-amount-input',
        }),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'note' }, t(locale, 'pay.note.label')),
        h('input', { id: 'note', name: 'note', type: 'text', 'data-testid': 'pay-note-input' }),
      ),
      h(
        'p',
        { class: 'pay__actions' },
        h('button', { type: 'reset', 'data-testid': 'pay-amount-clear' }, t(locale, 'voucher.pin.clear')),
        h('button', { type: 'submit', class: 'pay__pill-button', 'data-testid': 'pay-now' }, t(locale, 'pay.pay_now')),
      ),
    ),
    h('p', {}, h('a', { href: '/pay', 'data-testid': 'pay-cancel' }, t(locale, 'voucher.action.cancel'))),
  );
}

export interface PayCardProps {
  readonly chrome: Chrome;
  readonly flow: PayFlow;
  readonly amount: string;
  readonly note: string;
}

/** Carries flow/amount/note forward as a query string — no secret among them. */
function payQuery(props: { flow: PayFlow; amount: string; note: string }, outcome?: PayOutcome): string {
  const params = new URLSearchParams({ flow: props.flow, amount: props.amount, note: props.note });
  if (outcome !== undefined) params.set('outcome', outcome);
  return params.toString();
}

export function payCardScreen(props: PayCardProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  const base = { flow: props.flow, amount: props.amount, note: props.note };
  const methodLink = (label: string, testId: string): El =>
    h('a', { href: `/pay/result?${payQuery(base, 'approved')}`, 'data-testid': testId }, label);
  const practiceLink = (label: string, testId: string, outcome: PayOutcome): El =>
    h('a', { href: `/pay/result?${payQuery(base, outcome)}`, 'data-testid': testId }, label);
  return page(
    chrome,
    t(locale, 'screen.pay_card'),
    h('p', { class: 'pay__card-amount', 'data-testid': 'pay-card-amount' }, `ETB ${props.amount}`),
    h('p', { class: 'pay__card-icon', 'aria-hidden': 'true' }, '🤝📶'),
    h('p', { 'data-testid': 'pay-card-prompt', class: 'pay__card-prompt' }, t(locale, 'pay.card.prompt')),
    h(
      'p',
      { 'data-testid': 'pay-card-methods', class: 'pay__card-methods' },
      methodLink(t(locale, 'pay.card.tap'), 'pay-card-tap'),
      methodLink(t(locale, 'pay.card.insert'), 'pay-card-insert'),
      methodLink(t(locale, 'pay.card.swipe'), 'pay-card-swipe'),
    ),
    h(
      'p',
      { class: 'pay__card-badges' },
      h('span', { class: 'pay__card-badge' }, 'VISA'),
      h('span', { class: 'pay__card-badge' }, 'Mastercard'),
    ),
    h('p', { 'data-testid': 'pay-card-example-notice' }, t(locale, 'pay.card.example_notice')),
    h(
      'div',
      { 'data-testid': 'pay-card-practice', class: 'pay__practice' },
      h('p', {}, t(locale, 'pay.card.practice_heading')),
      practiceLink(t(locale, 'pay.card.practice_declined'), 'pay-card-practice-declined', 'declined'),
      ' · ',
      practiceLink(t(locale, 'pay.card.practice_read_error'), 'pay-card-practice-read-error', 'read_error'),
      ' · ',
      practiceLink(t(locale, 'pay.card.practice_cancelled'), 'pay-card-practice-cancelled', 'cancelled'),
    ),
    h('p', {}, h('a', { href: '/pay', 'data-testid': 'pay-cancel' }, t(locale, 'voucher.action.cancel'))),
  );
}

export interface PayResultProps {
  readonly chrome: Chrome;
  readonly flow: PayFlow;
  readonly amount: string;
  readonly note: string;
  readonly outcome: PayOutcome;
}

const OUTCOME_KEY: Record<PayOutcome, Parameters<typeof t>[1]> = {
  approved: 'pay.outcome.approved',
  declined: 'pay.outcome.declined',
  read_error: 'pay.outcome.read_error',
  cancelled: 'pay.outcome.cancelled',
};

/**
 * The result. Every outcome — including `approved` — states plainly that
 * this is a training simulation, per the file header: nothing here has
 * created a database row, a ledger entry, or contacted anything.
 */
export function payResultScreen(props: PayResultProps): El {
  const { chrome, outcome } = props;
  const locale = chrome.locale;
  const failed = outcome === 'declined' || outcome === 'read_error';
  return page(
    chrome,
    t(locale, 'screen.pay_result'),
    h(
      'p',
      {
        'data-testid': 'pay-outcome-message',
        role: failed ? 'alert' : 'status',
        'data-outcome': outcome,
        // Reuses the existing tone vocabulary (`document.ts`'s `[data-tone]`
        // CSS) rather than inventing a new colour system for this module.
        'data-tone': failed ? 'NEGATIVE' : outcome === 'cancelled' ? 'CAUTION' : 'POSITIVE',
      },
      t(locale, OUTCOME_KEY[outcome]),
    ),
    h(
      'p',
      { 'data-testid': 'pay-result-summary' },
      `${t(locale, props.flow === 'purchase' ? 'pay.purchase.label' : 'pay.cashback.label')}: ${props.amount} ETB${props.note.length > 0 ? ` — ${props.note}` : ''}`,
    ),
    outcome === 'read_error' &&
      h(
        'p',
        {},
        h(
          'a',
          {
            href: `/pay/card?${payQuery({ flow: props.flow, amount: props.amount, note: props.note })}`,
            'data-testid': 'pay-retry',
          },
          t(locale, 'pay.retry'),
        ),
      ),
    h(
      'p',
      {},
      h('a', { href: '/pay', 'data-testid': 'pay-done' }, t(locale, 'screen.pay_entry')),
      ' · ',
      h('a', { href: '/launcher', 'data-testid': 'back-to-launcher' }, t(locale, 'dashboard.back_to_launcher')),
    ),
  );
}

// --- training deposits -------------------------------------------------------
//
// The one path in this module that is *not* UI-only. Everything above draws a
// card terminal and writes nothing; the two screens below add simulated
// balance to the merchant's training float through a real, balanced ledger
// posting, so that a sale can reserve against it and a day's practice adds up.
//
// That is a deliberate, recorded reversal of this file's original "no
// persistence anywhere in Telga Pay" rule, limited to this path and to
// TRAINING mode — see Decision Log D70. It is still not payment acceptance:
// no card is read, no processor is contacted, and nobody's real money is
// anywhere near it. The card gesture the operator picks is recorded only as a
// label on the slip.

export interface PayDepositProps {
  readonly chrome: Chrome;
  readonly csrfToken: string;
  /** Generated when the form is built, so a double press posts one credit. */
  readonly clientRequestId: string;
  readonly limits: { readonly minMinor: number; readonly maxMinor: number };
  readonly errorMessage?: string;
}

/**
 * Amount and card gesture, in one form.
 *
 * A POST, unlike the purchase and cashback screens above, because this one
 * changes a balance — so it carries CSRF like every other write in Telga.
 * The three gestures are radio buttons rather than three links: the operator
 * is choosing what to practise, not navigating.
 */
export function payDepositScreen(props: PayDepositProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  const method = (value: 'TAP' | 'INSERT' | 'SWIPE', label: string, icon: string): El =>
    h(
      'label',
      { class: 'voucher__amount-card', 'data-testid': `deposit-method-${value.toLowerCase()}` },
      h('input', {
        type: 'radio',
        name: 'method',
        value,
        required: true,
        checked: value === 'TAP',
        class: 'voucher__amount-radio',
        'data-testid': `deposit-method-radio-${value.toLowerCase()}`,
      }),
      h('span', { class: 'voucher__amount-value' }, `${icon} ${label}`),
    );

  return page(
    chrome,
    t(locale, 'pay.deposit.heading'),
    h('p', { 'data-testid': 'deposit-notice', role: 'status', class: 'pay__banner' }, t(locale, 'pay.deposit.notice')),
    props.errorMessage !== undefined &&
      h('p', { 'data-testid': 'deposit-error', role: 'alert', 'data-tone': 'NEGATIVE' }, props.errorMessage),
    h(
      'form',
      { method: 'post', action: '/pay/deposit', 'data-testid': 'deposit-form' },
      h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
      h('input', {
        type: 'hidden',
        name: 'clientRequestId',
        value: props.clientRequestId,
        'data-testid': 'client-request-id',
      }),
      h('p', { class: 'pay__card-prompt' }, t(locale, 'pay.deposit.prompt')),
      h(
        'div',
        { class: 'pay__amount-display' },
        h('label', { for: 'amountBirr', class: 'pay__amount-currency' }, 'ETB'),
        h('input', {
          id: 'amountBirr',
          name: 'amountBirr',
          type: 'number',
          inputmode: 'numeric',
          min: String(props.limits.minMinor / 100),
          max: String(props.limits.maxMinor / 100),
          step: '1',
          required: true,
          'aria-label': t(locale, 'pay.amount.label'),
          'data-testid': 'deposit-amount-input',
        }),
      ),
      h(
        'fieldset',
        { class: 'voucher__amounts', 'data-testid': 'deposit-methods' },
        h('legend', { class: 'voucher__amounts-legend' }, t(locale, 'pay.card.prompt')),
        h(
          'div',
          { class: 'voucher__amounts-row' },
          method('TAP', t(locale, 'pay.card.tap'), '📶'),
          method('INSERT', t(locale, 'pay.card.insert'), '💳'),
          method('SWIPE', t(locale, 'pay.card.swipe'), '↔️'),
        ),
      ),
      h(
        'button',
        {
          type: 'submit',
          class: 'pay__pill-button',
          'data-once': 'deposit',
          'data-testid': 'deposit-confirm',
        },
        t(locale, 'pay.deposit.confirm'),
      ),
    ),
    h('p', {}, h('a', { href: '/pay', 'data-testid': 'pay-cancel' }, t(locale, 'voucher.action.cancel'))),
  );
}

export interface PayDepositSlipProps {
  readonly chrome: Chrome;
  readonly receipt: {
    readonly depositId: string;
    readonly merchantId: string;
    readonly amountFormatted: string;
    readonly method: string;
    readonly issuedAt: string;
    readonly availableAfterFormatted: string;
    readonly supportContact: string;
  };
  readonly style: SlipStyle;
}

/**
 * The deposit slip.
 *
 * Drawn by the same `slipCard` a sale and a reprint use — same brand line,
 * same rules, same training notice, same shop advertisement — so a merchant
 * filing the day's paper sees one consistent format rather than one per
 * feature.
 */
export function payDepositSlipScreen(props: PayDepositSlipProps): El {
  const { chrome, receipt } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'pay.deposit.slip_title'),
    h(
      'p',
      { 'data-testid': 'deposit-outcome-message', role: 'status', 'data-tone': 'POSITIVE' },
      t(locale, 'pay.deposit.credited'),
    ),
    slipCard({
      locale,
      subtitle: t(locale, 'pay.deposit.slip_title'),
      lines: [
        { label: t(locale, 'voucher.summary.merchant'), value: receipt.merchantId, id: 'slip-merchant' },
        { label: t(locale, 'transactions.column.service'), value: t(locale, 'screen.pay_entry'), id: 'slip-service' },
        { label: t(locale, 'pay.deposit.method'), value: receipt.method, id: 'slip-method' },
        { label: t(locale, 'transactions.column.amount'), value: receipt.amountFormatted, id: 'slip-amount' },
        { label: 'Date', value: receipt.issuedAt.slice(0, 10), id: 'slip-date' },
        { label: 'Time', value: receipt.issuedAt.slice(11, 19), id: 'slip-time' },
        {
          label: t(locale, 'transactions.column.reference'),
          value: receipt.depositId,
          id: 'slip-reference',
        },
        {
          label: t(locale, 'balance.available'),
          value: receipt.availableAfterFormatted,
          id: 'slip-available-after',
        },
      ],
      style: props.style,
      supportContact: receipt.supportContact,
    }),
    h('p', { class: 'slip__notice', 'data-testid': 'no-printer-notice' }, t(locale, 'voucher.result.no_printer')),
    h(
      'p',
      {},
      h('a', { href: '/pay', 'data-testid': 'pay-done' }, t(locale, 'screen.pay_entry')),
      ' · ',
      h('a', { href: '/dashboard', 'data-testid': 'go-home' }, t(locale, 'voucher.action.home')),
    ),
  );
}

// --- Telga Pay settings --------------------------------------------------

export interface PaySettingsProps {
  readonly chrome: Chrome;
  /** The simulated cards, so the sheet lists what each one does. */
  readonly cards: readonly { readonly lastFour: string; readonly scheme: string; readonly label: string }[];
  /** Pay-relevant flags and their state, read from the register. */
  readonly flags: readonly { readonly name: string; readonly on: boolean; readonly note: string }[];
  /** Shared slip settings, shown here so an operator knows where they live. */
  readonly slipSize: string;
}

/**
 * Telga Pay's own settings.
 *
 * ## Why this exists
 *
 * Telga Vending's settings were being shown inside Telga Pay — same three-bar
 * menu, same entries — so Pay had no settings of its own and Vending's looked
 * like they belonged to it. The menu is now module-aware and this is the other
 * half of that: the screen Pay's own entry leads to.
 *
 * ## What it deliberately does not contain
 *
 * **No duplicate of the shop's slip settings.** Slip width, the advertisement
 * line and the business details are one shop's identity and print on every
 * piece of paper Telga produces, vending or card. Copying them here would
 * create two places to set one thing and a way for them to disagree. The
 * section says where they live and links there instead.
 *
 * **No toggle that changes nothing.** The test cards are fixed constants in
 * the simulator, not a preference, so they are listed as a reference sheet — a
 * thing to read at the counter — rather than dressed up as switches. A control
 * that saves and does nothing is the dead-control problem this codebase has
 * already been told off for once.
 */
export function paySettingsScreen(props: PaySettingsProps): El {
  const { chrome } = props;
  const locale = chrome.locale;

  const row = (label: string, value: string, id: string): El =>
    h('tr', {}, h('th', { scope: 'row' }, label), h('td', { 'data-testid': id }, value));

  return page(
    chrome,
    t(locale, 'screen.pay_settings'),
    h('p', { class: 'voucher__notice', 'data-testid': 'pay-settings-banner' }, t(locale, 'pay.settings.intro')),

    // --- what Pay records --------------------------------------------------
    h('h2', { class: 'settings__section' }, t(locale, 'pay.settings.records')),
    h(
      'div',
      { class: 'topup__options', 'data-testid': 'pay-settings-records' },
      h(
        'a',
        { href: '/pay/transactions', class: 'topup__option', 'data-testid': 'pay-settings-transactions' },
        h('span', { class: 'topup__label' }, t(locale, 'pay.settings.transactions')),
      ),
      h(
        'a',
        { href: '/pay/statements', class: 'topup__option', 'data-testid': 'pay-settings-statements' },
        h('span', { class: 'topup__label' }, t(locale, 'pay.settings.statements')),
      ),
    ),

    // --- the test cards ----------------------------------------------------
    h('h2', { class: 'settings__section' }, t(locale, 'pay.settings.cards')),
    h('p', { class: 'voucher__custom-hint' }, t(locale, 'pay.settings.cards_hint')),
    h(
      'table',
      { class: 'voucher__summary-card', 'data-testid': 'pay-settings-cards' },
      h(
        'tbody',
        {},
        ...props.cards.map((card) =>
          h(
            'tr',
            { 'data-testid': `pay-card-row-${card.lastFour}` },
            h('th', { scope: 'row' }, `•••• ${card.lastFour}`),
            h('td', {}, card.scheme),
            h('td', {}, card.label),
          ),
        ),
      ),
    ),

    // --- what is switched on ----------------------------------------------
    h('h2', { class: 'settings__section' }, t(locale, 'pay.settings.flags')),
    h(
      'table',
      { class: 'voucher__summary-card', 'data-testid': 'pay-settings-flags' },
      h(
        'tbody',
        {},
        ...props.flags.map((flag) =>
          h(
            'tr',
            { 'data-testid': `pay-flag-${flag.name}`, 'data-on': flag.on ? 'true' : 'false' },
            h('th', { scope: 'row' }, flag.name),
            h('td', {}, flag.on ? t(locale, 'pay.settings.flag_on') : t(locale, 'pay.settings.flag_off')),
            h('td', {}, flag.note),
          ),
        ),
      ),
    ),

    // --- slips, which are the shop's, not Pay's ---------------------------
    h('h2', { class: 'settings__section' }, t(locale, 'pay.settings.slips')),
    h(
      'table',
      { class: 'voucher__summary-card', 'data-testid': 'pay-settings-slip' },
      h('tbody', {}, row(t(locale, 'settings.slip_size'), `${props.slipSize} mm`, 'pay-slip-size')),
    ),
    h('p', { class: 'voucher__custom-hint', 'data-testid': 'pay-settings-slip-note' }, t(locale, 'pay.settings.slips_note')),

    // --- who is signed in --------------------------------------------------
    h('h2', { class: 'settings__section' }, t(locale, 'pay.settings.account')),
    h(
      'table',
      { class: 'voucher__summary-card', 'data-testid': 'pay-settings-account' },
      h(
        'tbody',
        {},
        row(t(locale, 'pay.settings.operator'), chrome.operatorId ?? '', 'pay-account-operator'),
        row(t(locale, 'pay.settings.device'), chrome.deviceId ?? '', 'pay-account-device'),
        row(t(locale, 'pay.settings.merchant'), chrome.merchantId, 'pay-account-merchant'),
      ),
    ),

    h(
      'p',
      { class: 'voucher__actions' },
      h('a', { href: '/pay', class: 'voucher__button', 'data-testid': 'pay-settings-back' }, t(locale, 'voucher.action.back')),
    ),
  );
}

// --- Telga Pay records ----------------------------------------------------

export interface PayRecordsProps {
  readonly chrome: Chrome;
  /** Deposits credited through Telga Pay, newest first. */
  readonly deposits: readonly {
    readonly at: string;
    readonly amountFormatted: string;
    readonly method: string;
    readonly reference: string;
  }[];
  /** Grouped by calendar day, for the statement view. */
  readonly byDay?: readonly {
    readonly day: string;
    readonly count: number;
    readonly totalFormatted: string;
  }[];
}

/**
 * What Telga Pay has actually recorded.
 *
 * ## The honest part
 *
 * **Card attempts are not stored.** The card flow decides an outcome, prints a
 * slip and ends; nothing is written to the ledger, because a simulated card
 * moves no value and writing a row for it would put fictitious money in the
 * one place that must stay true. Training **deposits** are different: they post
 * a real balanced entry against the training float, so they are here.
 *
 * That gap is stated on the screen rather than left for an operator to notice
 * an empty list and guess. It closes when a real acquirer exists — at which
 * point an authorisation is a fact worth recording.
 */
export function payTransactionsScreen(props: PayRecordsProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'pay.records.transactions_title'),
    h('p', { class: 'voucher__notice', 'data-testid': 'pay-records-note' }, t(locale, 'pay.records.cards_not_stored')),
    props.deposits.length === 0
      ? h('p', { 'data-testid': 'pay-records-empty' }, t(locale, 'pay.records.empty'))
      : h(
          'table',
          { class: 'history__table', 'data-testid': 'pay-records-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', { scope: 'col' }, t(locale, 'transactions.column.datetime')),
              h('th', { scope: 'col' }, t(locale, 'transactions.column.amount')),
              h('th', { scope: 'col' }, t(locale, 'card.entry_mode')),
              h('th', { scope: 'col' }, t(locale, 'transactions.column.reference')),
              h('th', { scope: 'col' }, t(locale, 'receipt.reprint')),
            ),
          ),
          h(
            'tbody',
            {},
            ...props.deposits.map((d) =>
              h(
                'tr',
                { 'data-testid': `pay-record-${d.reference}` },
                h('td', {}, d.at),
                h('td', {}, d.amountFormatted),
                h('td', {}, d.method),
                h('td', {}, d.reference),
                // Reprint is a link to the deposit's own slip, which is drawn
                // from the stored deposit — never re-decided here.
                // A reprint link only where there is an id to reprint from.
                // A row from before the id was recorded shows a dash rather
                // than a button that would rebuild the wrong slip.
                h(
                  'td',
                  {},
                  d.reference === '—'
                    ? '—'
                    : h(
                        'a',
                        {
                          href: `/pay/deposit/slip?deposit=${encodeURIComponent(d.reference)}`,
                          'data-testid': `pay-reprint-${d.reference}`,
                        },
                        t(locale, 'receipt.reprint'),
                      ),
                ),
              ),
            ),
          ),
        ),
    h(
      'p',
      { class: 'voucher__actions' },
      h('a', { href: '/pay/settings', class: 'voucher__button', 'data-testid': 'pay-records-back' }, t(locale, 'voucher.action.back')),
    ),
  );
}

/**
 * Telga Pay's statement: one row per day.
 *
 * Grouped by calendar day rather than summed into a single figure, because
 * "different days must be different" is the whole point of a statement — a
 * total with no days in it cannot be reconciled against anything.
 */
export function payStatementsScreen(props: PayRecordsProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  const days = props.byDay ?? [];
  return page(
    chrome,
    t(locale, 'pay.records.statements_title'),
    h('p', { class: 'voucher__notice', 'data-testid': 'pay-statement-note' }, t(locale, 'pay.records.cards_not_stored')),
    days.length === 0
      ? h('p', { 'data-testid': 'pay-statement-empty' }, t(locale, 'pay.records.empty'))
      : h(
          'table',
          { class: 'history__table', 'data-testid': 'pay-statement-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', { scope: 'col' }, t(locale, 'transactions.column.datetime')),
              h('th', { scope: 'col' }, t(locale, 'pay.records.count')),
              h('th', { scope: 'col' }, t(locale, 'transactions.column.amount')),
            ),
          ),
          h(
            'tbody',
            {},
            ...days.map((d) =>
              h(
                'tr',
                { 'data-testid': `pay-statement-day-${d.day}` },
                h('td', {}, d.day),
                h('td', {}, String(d.count)),
                h('td', {}, d.totalFormatted),
              ),
            ),
          ),
        ),
    h(
      'p',
      { class: 'voucher__actions' },
      h('a', { href: '/pay/settings', class: 'voucher__button', 'data-testid': 'pay-statement-back' }, t(locale, 'voucher.action.back')),
    ),
  );
}
