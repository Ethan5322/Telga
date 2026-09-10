/**
 * Asking Telga to return the money on a sale.
 *
 * `CLAUDE.md` §17.1. The founder's case: a customer is handed an airtime or
 * data token, cannot use it, and hands it back. The sale succeeded — Telga
 * issued a token — and no value reached anybody.
 *
 * ## This screen asks. It does not reverse.
 *
 * §13 invariant 8: *"Corrections are authorized adjustment entries, never
 * silent edits."* A merchant judging for themselves whether value was delivered
 * is a merchant who can return their own money for a sale a customer received.
 * So the shop files a request and a supervisor completes it, and **every string
 * here is written so nobody expects otherwise**. There is no "your money will
 * be returned"; there is "Telga will check".
 *
 * ## Why every request in this build needs a person
 *
 * `decideReversal` refuses outright when a token is `REDEEMED` and settles
 * without approval when it is `UNREDEEMED`. This build can read **neither**:
 * there is no provider API to ask and no redemption column anywhere in the
 * schema. So redemption is `UNKNOWN` for every request, which routes all of
 * them to `ACCEPTED_NEEDS_APPROVAL` — a human decides.
 *
 * That is the honest behaviour rather than a limitation to work around. §17:
 * *"never auto-refund an unknown outcome."* When a provider that can answer
 * exists, the same code path settles the clear cases on its own.
 */

import { t } from '@telga/localization';
import { page } from './chrome';
import type { Chrome } from './chrome';
import { h } from './element';
import type { El } from './element';

const REFUSAL_TEXT: Readonly<Record<string, string>> = Object.freeze({
  TRANSACTION_REQUIRED: 'Enter the transaction number from the receipt.',
  TRANSACTION_NOT_FOUND: 'No sale on this machine matches that number.',
  REASON_REQUIRED: 'Say why the sale should be reversed.',
  ALREADY_REVERSED: 'This sale has already been reversed.',
  REVERSAL_ALREADY_REQUESTED: 'A request for this sale is already with Telga. Do not send another.',
  NOT_A_REVERSIBLE_STATE:
    'This sale cannot be reversed. A failed sale never took the money, so there is nothing to return.',
  TOKEN_ALREADY_REDEEMED: 'The customer has already used this token, so the value cannot be returned.',
  OUTSIDE_REVERSAL_WINDOW: 'This sale is too old to reverse. Contact Telga if you think it should be.',
  NOT_SAVED: 'The request could not be sent. Try again in a moment.',
});

export interface ReversalProps {
  readonly chrome: Chrome;
  readonly csrfToken: string;
  readonly refusal?: string;
  readonly transactionId?: string;
  readonly values?: Readonly<Record<string, string>>;
}

export function reversalScreen(props: ReversalProps): El {
  const { chrome } = props;
  const locale = chrome.locale;

  return page(
    chrome,
    t(locale, 'reverse.title'),
    h('p', { 'data-testid': 'reverse-intro' }, t(locale, 'reverse.intro')),
    props.refusal !== undefined &&
      h(
        'p',
        { 'data-testid': 'reverse-refusal', role: 'alert', 'data-tone': 'NEGATIVE', 'data-reason-code': props.refusal },
        REFUSAL_TEXT[props.refusal] ?? REFUSAL_TEXT['NOT_SAVED'],
      ),
    h(
      'form',
      { method: 'post', action: '/reverse', 'data-testid': 'reverse-form' },
      h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'transactionId' }, t(locale, 'reverse.transaction')),
        h('input', {
          id: 'transactionId',
          name: 'transactionId',
          type: 'text',
          required: true,
          value: props.transactionId ?? props.values?.['transactionId'],
          'data-testid': 'reverse-transaction',
        }),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'reason' }, t(locale, 'reverse.reason')),
        h(
          'textarea',
          {
            id: 'reason',
            name: 'reason',
            rows: '3',
            required: true,
            'data-testid': 'reverse-reason',
            'aria-describedby': 'reason-hint',
          },
          props.values?.['reason'] ?? '',
        ),
        h('p', { id: 'reason-hint', class: 'field__hint' }, t(locale, 'reverse.reason.hint')),
      ),
      h(
        'button',
        { type: 'submit', class: 'voucher__button', 'data-testid': 'reverse-submit' },
        t(locale, 'reverse.submit'),
      ),
    ),
  );
}

export interface ReversalSentProps {
  readonly chrome: Chrome;
  readonly reference: string;
}

export function reversalSentScreen(props: ReversalSentProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'reverse.title'),
    h(
      'section',
      { 'data-testid': 'reverse-sent', role: 'status' },
      h('h2', {}, t(locale, 'reverse.sent.heading')),
      h('p', {}, t(locale, 'reverse.sent.reference')),
      h('p', { class: 'register__reference', 'data-testid': 'reverse-reference' }, props.reference),
      // The whole point of the screen: nothing has moved yet, and the shop
      // should not plan around money it does not have.
      h('p', { 'data-testid': 'reverse-sent-next' }, t(locale, 'reverse.sent.next')),
    ),
    h(
      'p',
      { class: 'login__back' },
      h('a', { href: '/dashboard', 'data-testid': 'reverse-done' }, t(locale, 'receipt.action.close')),
    ),
  );
}
