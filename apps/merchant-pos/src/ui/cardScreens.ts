/**
 * Taking a card at the counter.
 *
 * Three screens: present the card, then approved or declined. They render
 * whatever `takeCardPayment` returns, so the same screens serve the simulator
 * today and a certified reader later — the flow above them does not change.
 *
 * ## Why the decline screen is the important one
 *
 * An approval needs a reference and a slip. A decline needs an operator to
 * know, in one glance and in words they can say aloud, whether to ask for
 * another card or another payment method. `INSUFFICIENT_FUNDS` means nothing
 * across a counter; "not enough money on the card" is what gets said.
 *
 * ## And why the third outcome has its own screen
 *
 * When the bank does not answer, the money may or may not have moved. That is
 * neither an approval nor a decline, and showing it as either causes a real
 * loss — goods handed over for nothing, or a customer refused after being
 * charged. It gets its own screen, and it tells the operator to stop.
 */

import { t } from '@telga/localization';
import type { Locale } from '@telga/localization';
import { page } from './chrome';
import type { Chrome } from './chrome';
import { h } from './element';
import type { El } from './element';
import { telgaLogo } from './logo';
import { slipCard } from './screens';
import type { SlipLine, SlipStyle } from './screens';

export type CardGesture = 'TAP' | 'INSERT' | 'SWIPE';

export interface CardPresentProps {
  readonly chrome: Chrome;
  readonly amountFormatted: string;
  readonly csrfToken: string;
  /** The cards a training operator can present, and what each one does. */
  readonly cards: readonly { readonly lastFour: string; readonly scheme: string; readonly label: string }[];
  /** False when no reader is attached — the screen says so rather than waiting. */
  readonly readerPresent: boolean;
  readonly cashback?: boolean;
}

/** One gesture, drawn rather than typed so it does not depend on an emoji font. */
function gestureTile(locale: Locale, value: CardGesture, checked: boolean): El {
  const labelKey =
    value === 'TAP' ? 'pay.card.tap' : value === 'INSERT' ? 'pay.card.insert' : 'pay.card.swipe';
  return h(
    'label',
    { class: 'card__gesture', 'data-testid': `card-gesture-${value}` },
    h('input', {
      type: 'radio',
      name: 'entryMode',
      value,
      checked,
      class: 'card__gesture-radio',
    }),
    h(
      'span',
      { class: 'card__gesture-art', 'aria-hidden': 'true' },
      // A card shape for all three; the motion is what differs, so the
      // arrows and waves carry the meaning rather than three unrelated icons.
      h('span', { class: `card__gesture-card card__gesture-card--${value.toLowerCase()}` }),
    ),
    h('span', { class: 'card__gesture-label' }, t(locale, labelKey)),
  );
}

export function cardPresentScreen(props: CardPresentProps): El {
  const { chrome } = props;
  const locale = chrome.locale;

  return page(
    chrome,
    t(locale, 'card.present'),
    h(
      'div',
      { class: 'card__amount', 'data-testid': 'card-amount' },
      h('span', { class: 'card__amount-label' }, t(locale, 'transactions.column.amount')),
      h('strong', { class: 'card__amount-value' }, props.amountFormatted),
    ),
    !props.readerPresent &&
      h(
        'p',
        { role: 'alert', 'data-tone': 'NEGATIVE', 'data-testid': 'card-no-reader' },
        t(locale, 'card.no_reader'),
      ),
    h(
      'form',
      { method: 'post', action: '/pay/card/authorize', 'data-testid': 'card-form' },
      h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
      props.cashback === true && h('input', { type: 'hidden', name: 'kind', value: 'CASHBACK' }),

      h('p', { class: 'card__prompt' }, t(locale, 'card.present')),
      h(
        'div',
        { class: 'card__gestures', 'data-testid': 'card-gestures' },
        gestureTile(locale, 'TAP', false),
        gestureTile(locale, 'INSERT', true),
        gestureTile(locale, 'SWIPE', false),
      ),

      // Which simulated card is presented. On a real terminal this whole
      // block disappears — the reader supplies the card — which is why it is
      // fenced off and labelled rather than mixed in with the gestures.
      h(
        'div',
        { class: 'card__simulator', 'data-testid': 'card-simulator' },
        h('p', { class: 'card__simulator-title' }, t(locale, 'card.simulator_title')),
        h(
          'div',
          { class: 'card__sim-list' },
          ...props.cards.map((card, index) =>
            h(
              'label',
              { class: 'card__sim', 'data-testid': `card-sim-${card.lastFour}` },
              h('input', {
                type: 'radio',
                name: 'lastFour',
                value: card.lastFour,
                checked: index === 0,
                class: 'card__sim-radio',
              }),
              h('span', { class: 'card__sim-pan' }, `•••• ${card.lastFour}`),
              h('span', { class: 'card__sim-scheme' }, card.scheme),
              h('span', { class: 'card__sim-label' }, card.label),
            ),
          ),
        ),
      ),
      h(
        'button',
        {
          type: 'submit',
          class: 'voucher__button voucher__button--primary',
          'data-once': 'card',
          'data-testid': 'card-submit',
          disabled: !props.readerPresent,
        },
        t(locale, 'card.read'),
      ),
    ),
    h(
      'p',
      { class: 'voucher__actions' },
      h('a', { href: '/pay', class: 'voucher__button', 'data-testid': 'card-cancel' }, t(locale, 'voucher.action.cancel')),
    ),
  );
}

export interface CardResultProps {
  readonly chrome: Chrome;
  readonly outcome: 'APPROVED' | 'DECLINED' | 'NO_RESPONSE' | 'NOT_READ';
  readonly amountFormatted?: string;
  readonly cashOutFormatted?: string;
  readonly maskedPan?: string;
  readonly scheme?: string;
  readonly entryMode?: CardGesture;
  readonly authorizationCode?: string;
  /** The sentence for this decline, already translated. */
  readonly message?: string;
  readonly retryable?: boolean;
  /**
   * The slip for this attempt.
   *
   * Present on **every** outcome, not only an approval. A declined or
   * unanswered card is exactly the attempt a customer argues about later, and
   * a counter with no paper for it has nothing to show. The slip states the
   * outcome in words, so a decline slip cannot be mistaken for a receipt.
   */
  readonly slip?: {
    readonly lines: readonly SlipLine[];
    readonly subtitle: string;
    readonly supportContact: string;
    readonly style: SlipStyle;
  };
}

export function cardResultScreen(props: CardResultProps): El {
  const { chrome } = props;
  const locale = chrome.locale;

  const tone =
    props.outcome === 'APPROVED'
      ? 'POSITIVE'
      : props.outcome === 'NO_RESPONSE'
        ? 'CAUTION'
        : 'NEGATIVE';

  // Three outcomes, three headlines.
  //
  // `NO_RESPONSE` used to fall through to the decline text, because the
  // headline was chosen by `approved ? ... : ...` and nothing passed a message
  // for it. So the one screen that must say "we do not know" said "declined" —
  // the exact wrong answer, on the exact outcome where the money may already
  // have moved. Found by running the flow, not by a test.
  const heading =
    props.outcome === 'APPROVED'
      ? t(locale, 'card.approved')
      : props.outcome === 'NO_RESPONSE'
        ? t(locale, 'card.no_response_heading')
        : t(locale, 'card.declined_heading');

  return page(
    chrome,
    heading,
    h(
      'div',
      { class: `card__result card__result--${props.outcome.toLowerCase()}`, 'data-testid': 'card-result' },
      h('div', { class: 'card__result-mark' }, telgaLogo({ height: 56, title: '' })),
      h(
        'p',
        { class: 'card__result-headline', 'data-tone': tone, 'data-testid': 'card-outcome' },
        props.outcome === 'APPROVED' || props.outcome === 'NO_RESPONSE'
          ? heading
          : (props.message ?? t(locale, 'card.decline.generic')),
      ),
      // The one line that decides what the operator does next.
      props.outcome === 'NO_RESPONSE' &&
        h(
          'p',
          { class: 'card__result-warning', 'data-testid': 'card-no-response' },
          t(locale, 'card.no_response'),
        ),
      props.retryable === true &&
        h('p', { class: 'card__result-hint', 'data-testid': 'card-retryable' }, t(locale, 'card.try_again')),
    ),
    (props.maskedPan !== undefined || props.amountFormatted !== undefined) &&
      h(
        'table',
        { class: 'voucher__summary-card', 'data-testid': 'card-detail' },
        h(
          'tbody',
          {},
          props.amountFormatted !== undefined &&
            h(
              'tr',
              {},
              h('th', { scope: 'row' }, t(locale, 'transactions.column.amount')),
              h('td', { 'data-testid': 'card-amount-value' }, props.amountFormatted),
            ),
          props.cashOutFormatted !== undefined &&
            h(
              'tr',
              {},
              h('th', { scope: 'row' }, t(locale, 'pay.cashback.label')),
              h('td', { 'data-testid': 'card-cashout-value' }, props.cashOutFormatted),
            ),
          // Masked, always. There is no field anywhere in Telga that holds a
          // full card number, and none that holds a CVV at all.
          props.maskedPan !== undefined &&
            h(
              'tr',
              {},
              h('th', { scope: 'row' }, t(locale, 'card.number')),
              h('td', { 'data-testid': 'card-masked-pan' }, props.maskedPan),
            ),
          props.scheme !== undefined &&
            h('tr', {}, h('th', { scope: 'row' }, t(locale, 'card.scheme')), h('td', {}, props.scheme)),
          props.entryMode !== undefined &&
            h(
              'tr',
              {},
              h('th', { scope: 'row' }, t(locale, 'card.entry_mode')),
              h('td', { 'data-testid': 'card-entry-mode' }, props.entryMode),
            ),
          props.authorizationCode !== undefined &&
            h(
              'tr',
              {},
              h('th', { scope: 'row' }, t(locale, 'card.reference')),
              h('td', { 'data-testid': 'card-auth-code' }, props.authorizationCode),
            ),
        ),
      ),
    // The paper. Drawn with the same `slipCard` a vending sale uses, so a
    // Telga Pay slip and a vending slip cannot look like two different
    // products — and so the legal name and support line come from one place.
    props.slip !== undefined &&
      slipCard({
        locale,
        subtitle: props.slip.subtitle,
        lines: props.slip.lines,
        style: props.slip.style,
        supportContact: props.slip.supportContact,
      }),
    h(
      'p',
      { class: 'voucher__actions' },
      h('a', { href: '/pay', class: 'voucher__button', 'data-testid': 'card-again' }, t(locale, 'voucher.result.new_sale')),
      h(
        'a',
        { href: '/dashboard', class: 'voucher__button voucher__button--main', 'data-testid': 'main-button' },
        t(locale, 'voucher.action.main'),
      ),
    ),
  );
}
