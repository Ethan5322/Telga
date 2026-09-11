/**
 * Paying in through Chapa — `CLAUDE.md` §20.2.
 *
 * The same two screens the bank slip has, for the same reason: a shop asks for
 * an amount, and gets a slip carrying a reference. What differs is only *where*
 * the money is handed over — a Chapa checkout page rather than a bank counter.
 *
 * The founder's framing, kept deliberately: *"it's one kind of bank deposit
 * method."* So this reads like the counter slip, not like a separate product.
 *
 * ## The one sentence these screens exist to get right
 *
 * **The balance goes up on its own.** A shopkeeper who pays on Chapa and then
 * waits for someone to tell Telga has misunderstood the product, and will ring
 * up to ask. Said on the amount screen, again on the slip, and again after.
 */

import { h } from './element';
import type { El } from './element';
import { page } from './chrome';
import type { Chrome } from './chrome';
import { DEFAULT_SLIP_STYLE, slipCard } from './screens';
import type { SlipStyle } from './screens';
import { t } from '@telga/localization';

export interface ChapaAmountProps {
  readonly chrome: Chrome;
  readonly csrfToken: string;
  readonly errorMessage?: string;
  readonly minimumFormatted: string;
  readonly maximumFormatted: string;
}

export function chapaAmountScreen(props: ChapaAmountProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'chapa.title'),
    h('p', { class: 'lede', 'data-testid': 'chapa-lede' }, t(locale, 'chapa.lede')),
    props.errorMessage !== undefined &&
      h('p', { class: 'error', role: 'alert', 'data-testid': 'chapa-error' }, props.errorMessage),
    h(
      'form',
      { method: 'post', action: '/deposit/chapa', 'data-testid': 'chapa-form' },
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
          'data-testid': 'chapa-amount',
        }),
      ),
      h(
        'p',
        { class: 'hint', 'data-testid': 'chapa-limits' },
        `${t(locale, 'bank_deposit.limits')} ${props.minimumFormatted} – ${props.maximumFormatted}`,
      ),
      h(
        'button',
        { type: 'submit', class: 'button button--primary', 'data-testid': 'chapa-submit' },
        t(locale, 'chapa.pay_now'),
      ),
    ),
    h('p', { class: 'notice', 'data-testid': 'chapa-not-yet-money' }, t(locale, 'bank_deposit.not_yet_money')),
  );
}

export interface ChapaSlipProps {
  readonly chrome: Chrome;
  readonly style?: SlipStyle;
  readonly order: {
    readonly reference: string;
    readonly amountFormatted: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
  };
  /** Chapa's hosted checkout page for this payment. */
  readonly checkoutUrl: string;
  readonly supportContact: string;
}

/**
 * The slip, and the link that actually takes the money.
 *
 * Drawn by the same `slipCard` as every other printed thing, so it carries the
 * same brand line and the same `TRAINING — NO REAL VALUE` mark without this
 * screen having to ask for either.
 *
 * **The reference is on the paper even though Chapa does the matching.** If the
 * automatic path fails — a webhook lost, a payment Chapa cannot confirm — the
 * reference is the only thing that lets a person find the payment afterwards,
 * and by then the screen is long gone.
 */
export function chapaSlipScreen(props: ChapaSlipProps): El {
  const { chrome, order } = props;
  const locale = chrome.locale;

  return page(
    chrome,
    t(locale, 'chapa.slip_title'),
    h(
      'p',
      { 'data-testid': 'chapa-outcome', role: 'status', 'data-tone': 'CAUTION' },
      t(locale, 'chapa.slip_status'),
    ),
    // The primary action. Above the slip, because paying is what the shopkeeper
    // came here to do; the paper is for afterwards.
    h(
      'p',
      {},
      h(
        'a',
        {
          href: props.checkoutUrl,
          class: 'button button--primary',
          rel: 'noopener noreferrer',
          'data-testid': 'chapa-checkout-link',
        },
        t(locale, 'chapa.pay_now'),
      ),
    ),
    slipCard({
      locale,
      subtitle: t(locale, 'chapa.slip_title'),
      lines: [
        { label: t(locale, 'chapa.method'), value: t(locale, 'chapa.method_value'), id: 'slip-method' },
        { label: t(locale, 'transactions.column.amount'), value: order.amountFormatted, id: 'slip-amount' },
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
    h('p', { class: 'slip__notice', 'data-testid': 'chapa-keep-reference' }, t(locale, 'chapa.keep_reference')),
    // The sentence the whole screen exists for.
    h('p', { class: 'slip__notice', 'data-testid': 'chapa-credited-later' }, t(locale, 'chapa.credited_later')),
    h(
      'p',
      { class: 'slip__close' },
      h('a', { href: '/dashboard', class: 'button', 'data-testid': 'slip-close' }, `✕ ${t(locale, 'bank_deposit.close')}`),
    ),
    h('p', { class: 'hint', 'data-testid': 'slip-close-note' }, t(locale, 'bank_deposit.close_note')),
  );
}
