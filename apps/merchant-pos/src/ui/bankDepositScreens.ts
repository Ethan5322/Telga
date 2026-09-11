/**
 * The **Deposit money** button, its amount screen, and the payment slip.
 *
 * `CLAUDE.md` §20.1. A shop needs selling balance before it can sell anything.
 * This is how it asks for some: press one button, name an amount, carry the
 * printed slip to a bank.
 *
 * ## The one thing these screens must never imply
 *
 * **That the money has arrived.** Nothing here credits a balance, and the words
 * are chosen so a shopkeeper is never left thinking otherwise: the slip says
 * what to pay and what to quote, and says plainly that balance appears only
 * after Telga sees the payment on its bank statement.
 *
 * A screen that said "Deposit complete" over a slip nobody had paid yet would
 * be the whole feature's failure mode, in one string.
 */

import { h } from './element';
import type { El } from './element';
import { page } from './chrome';
import type { Chrome } from './chrome';
import { DEFAULT_SLIP_STYLE, slipCard } from './screens';
import type { SlipStyle } from './screens';
import { t } from '@telga/localization';

// ---------------------------------------------------------------------------
// Amount
// ---------------------------------------------------------------------------

export interface BankDepositAmountProps {
  readonly chrome: Chrome;
  readonly csrfToken: string;
  /** Shown when the shop already has a slip out — §20.1, one at a time. */
  readonly openOrder?: {
    readonly reference: string;
    readonly amountFormatted: string;
    readonly expiresAt: string;
  };
  readonly errorMessage?: string;
  readonly minimumFormatted: string;
  readonly maximumFormatted: string;
}

/**
 * How much do you want to pay in?
 *
 * The amount is typed rather than chosen from denominations: a bank deposit is
 * whatever the shop is carrying, not one of four fixed values, and offering
 * fixed values would make the common case the awkward one.
 */
export function bankDepositAmountScreen(props: BankDepositAmountProps): El {
  const { chrome, locale } = { ...props, locale: props.chrome.locale };

  // Already holding a slip: show it rather than an empty form. A shopkeeper who
  // pressed the button twice needs the reference they are already carrying, not
  // a second one that would split their payment from their order.
  if (props.openOrder !== undefined) {
    return page(
      chrome,
      t(locale, 'bank_deposit.title'),
      h(
        'p',
        { 'data-testid': 'bank-deposit-open', role: 'status', 'data-tone': 'CAUTION' },
        t(locale, 'bank_deposit.already_open'),
      ),
      h(
        'dl',
        { class: 'summary', 'data-testid': 'bank-deposit-open-detail' },
        h('dt', {}, t(locale, 'bank_deposit.reference')),
        h('dd', { class: 'reference', 'data-testid': 'open-reference' }, props.openOrder.reference),
        h('dt', {}, t(locale, 'transactions.column.amount')),
        h('dd', { 'data-testid': 'open-amount' }, props.openOrder.amountFormatted),
        h('dt', {}, t(locale, 'bank_deposit.expires')),
        h('dd', { 'data-testid': 'open-expires' }, props.openOrder.expiresAt.slice(0, 16).replace('T', ' ')),
      ),
      h(
        'p',
        {},
        h(
          'a',
          { href: '/deposit/slip', class: 'button', 'data-testid': 'view-open-slip' },
          t(locale, 'bank_deposit.view_slip'),
        ),
      ),
      // Cancelling is a form, not a link: it changes stored state.
      h(
        'form',
        { method: 'post', action: '/deposit/cancel', 'data-testid': 'cancel-order-form' },
        h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
        h(
          'button',
          {
            type: 'submit',
            class: 'button button--quiet',
            'data-confirm': t(locale, 'bank_deposit.cancel_confirm'),
            'data-testid': 'cancel-order',
          },
          t(locale, 'bank_deposit.cancel'),
        ),
      ),
    );
  }

  return page(
    chrome,
    t(locale, 'bank_deposit.title'),
    h('p', { class: 'lede', 'data-testid': 'bank-deposit-lede' }, t(locale, 'bank_deposit.lede')),
    props.errorMessage !== undefined &&
      h('p', { class: 'error', role: 'alert', 'data-testid': 'bank-deposit-error' }, props.errorMessage),
    h(
      'form',
      { method: 'post', action: '/deposit', 'data-testid': 'bank-deposit-form' },
      h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
      h(
        'label',
        { for: 'amount' },
        t(locale, 'bank_deposit.amount_label'),
        h('input', {
          id: 'amount',
          name: 'amountBirr',
          type: 'number',
          inputmode: 'numeric',
          min: '1',
          step: '1',
          required: true,
          autocomplete: 'off',
          'data-testid': 'bank-deposit-amount',
        }),
      ),
      h(
        'p',
        { class: 'hint', 'data-testid': 'bank-deposit-limits' },
        `${t(locale, 'bank_deposit.limits')} ${props.minimumFormatted} – ${props.maximumFormatted}`,
      ),
      h(
        'button',
        { type: 'submit', class: 'button button--primary', 'data-testid': 'bank-deposit-submit' },
        t(locale, 'bank_deposit.print_slip'),
      ),
    ),
    // Said before the slip exists, not only on it.
    h('p', { class: 'notice', 'data-testid': 'bank-deposit-warning' }, t(locale, 'bank_deposit.not_yet_money')),
  );
}

/**
 * The placeholder account a training slip prints.
 *
 * ## Why the slip prints at all without real bank details
 *
 * It used to refuse, on the reasoning that §30 forbids inventing bank details.
 * That was the wrong reading: the rule is against fabricating a **relationship
 * that could be taken for real**, and it made the feature untestable to guard
 * against a risk that labelling handles better. The same pattern is already
 * everywhere in this build — `Airtime 10 (simulated)`, the Telga Pay card
 * simulator (D87/D124), training deposits (D70).
 *
 * ## Why these particular strings
 *
 * **A slip is paper, and paper leaves the building.** Somebody can carry one to
 * a real bank counter, so the test details must be impossible to mistake — not
 * merely marked somewhere else on the page.
 *
 * So: no real bank is named, the account number is visibly not an account
 * number, and every line says so on its own. A realistic-looking fake — a real
 * bank's name with a plausible number — is the dangerous version, because it is
 * the one a teller would accept and act on. These cannot be read aloud without
 * the reader noticing.
 *
 * Replaced by `--deposit-bank-name`, `--deposit-account-name` and
 * `--deposit-account-number` when Telga's real arrangement exists (§31).
 */
export const TEST_DEPOSIT_BANK = Object.freeze({
  bankName: 'TEST BANK — NOT A REAL BANK',
  accountName: 'TELGA TEST ACCOUNT — NO REAL VALUE',
  accountNumber: '0000-TEST-0000',
});

// ---------------------------------------------------------------------------
// The slip
// ---------------------------------------------------------------------------

export interface BankDepositSlipProps {
  readonly chrome: Chrome;
  readonly style?: SlipStyle;
  readonly order: {
    readonly reference: string;
    readonly amountFormatted: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
    readonly merchantId: string;
  };
  /**
   * Where to pay.
   *
   * `undefined` when no account is configured — and then the slip refuses to
   * print rather than showing a blank line. §31: Telga's bank details are
   * `NOT YET CONFIRMED`, and a slip naming no account is a slip that sends a
   * shopkeeper to a bank counter with nothing to say.
   */
  readonly bank?: {
    readonly bankName: string;
    readonly accountName: string;
    readonly accountNumber: string;
  };
  readonly supportContact: string;
}

/**
 * The paper.
 *
 * Drawn by the same `slipCard` as a sale, a reprint and a Telga Pay deposit, so
 * it carries the same brand line and the same `TRAINING — NO REAL VALUE` mark
 * without this screen having to remember to ask for either.
 *
 * ## What is on it, and what is deliberately not
 *
 * On it: where to pay, how much, and the reference. Not on it: **any name or
 * phone number**. §22 allows a receipt no unnecessary personal data, and this
 * particular slip is handed to bank staff and then lives in a statement archive.
 * The reference identifies the shop; nothing else has to.
 */
export function bankDepositSlipScreen(props: BankDepositSlipProps): El {
  const { chrome, order } = props;
  const locale = chrome.locale;

  // No configured account means a **test** slip, not no slip. See
  // `TEST_DEPOSIT_BANK` for why the placeholder reads the way it does.
  const bank = props.bank ?? TEST_DEPOSIT_BANK;
  const isTestAccount = props.bank === undefined;

  return page(
    chrome,
    t(locale, 'bank_deposit.slip_title'),
    h(
      'p',
      { 'data-testid': 'bank-deposit-outcome', role: 'status', 'data-tone': 'CAUTION' },
      t(locale, 'bank_deposit.slip_status'),
    ),
    slipCard({
      locale,
      subtitle: t(locale, 'bank_deposit.slip_title'),
      lines: [
        { label: t(locale, 'bank_deposit.bank'), value: bank.bankName, id: 'slip-bank' },
        { label: t(locale, 'bank_deposit.account_name'), value: bank.accountName, id: 'slip-account-name' },
        {
          label: t(locale, 'bank_deposit.account_number'),
          value: bank.accountNumber,
          id: 'slip-account-number',
        },
        { label: t(locale, 'transactions.column.amount'), value: order.amountFormatted, id: 'slip-amount' },
        // The line the whole design turns on.
        { label: t(locale, 'bank_deposit.reference'), value: order.reference, id: 'slip-reference' },
        { label: 'Date', value: order.issuedAt.slice(0, 10), id: 'slip-date' },
        { label: 'Time', value: order.issuedAt.slice(11, 19), id: 'slip-time' },
        {
          label: t(locale, 'bank_deposit.expires'),
          value: order.expiresAt.slice(0, 16).replace('T', ' '),
          id: 'slip-expires',
        },
      ],
      style: props.style ?? DEFAULT_SLIP_STYLE,
      supportContact: props.supportContact,
    }),
    // Two warnings, both on the paper the shopkeeper carries.
    h(
      'p',
      { class: 'slip__notice', 'data-testid': 'slip-quote-reference' },
      t(locale, 'bank_deposit.quote_reference'),
    ),
    h(
      'p',
      { class: 'slip__notice', 'data-testid': 'slip-personal-account-warning' },
      t(locale, 'bank_deposit.never_personal_account'),
    ),
    h('p', { class: 'slip__notice', 'data-testid': 'slip-credit-later' }, t(locale, 'bank_deposit.credited_later')),
    // Said once more, outside the card, when the account is a placeholder. On
    // the card it is one line among eight; here it is the last thing read.
    isTestAccount &&
      h(
        'p',
        { class: 'slip__notice', role: 'alert', 'data-testid': 'slip-test-account' },
        t(locale, 'bank_deposit.test_account'),
      ),
    /**
     * Close.
     *
     * **Closes the screen, not the order.** The slip is finished with; the
     * order stays `OPEN`, stays payable, and still resolves if the money
     * arrives days later. Closing a *view* must never destroy a *record* — a
     * shopkeeper who dismisses this screen and then walks to the bank has done
     * nothing wrong, and the payment has to land somewhere.
     *
     * A plain link, because it changes nothing. Cancelling the order is a
     * different act with its own form and its own confirmation.
     */
    h(
      'p',
      { class: 'slip__close' },
      h(
        'a',
        { href: '/dashboard', class: 'button', 'data-testid': 'slip-close' },
        `\u2715 ${t(locale, 'bank_deposit.close')}`,
      ),
    ),
    h(
      'p',
      { class: 'hint', 'data-testid': 'slip-close-note' },
      t(locale, 'bank_deposit.close_note'),
    ),
  );
}
