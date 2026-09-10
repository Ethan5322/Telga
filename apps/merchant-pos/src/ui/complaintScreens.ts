/**
 * Reporting a problem with a sale, from the counter.
 *
 * `CLAUDE.md` §17.2. A shop tells Telga what went wrong; Telga decides whether
 * it is real. This is the shop's half.
 *
 * ## Why the merchant names a transaction rather than browsing to one
 *
 * They have the receipt, or the customer is standing there quoting a number.
 * Asking them to find it in a list is asking them to do the search Telga will
 * do anyway, on a phone, with somebody waiting.
 *
 * ## Why there is no photograph upload
 *
 * D138 refused an unauthenticated upload path for registration, and the
 * reasoning carries: a route that accepts arbitrary bytes is a way to fill a
 * volume. The merchant describes the problem and names the sale; an admin
 * attaches evidence at review, where the originals are.
 *
 * ## What this screen must never promise
 *
 * A refund. §17 is explicit — *"never auto-refund an unknown outcome"* — and a
 * complaint form that says "we will return your money" has decided the case
 * before anyone has looked at it. What it promises is an answer, and names the
 * deadline Telga has committed to.
 */

import { t } from '@telga/localization';
import { page } from './chrome';
import type { Chrome } from './chrome';
import { h } from './element';
import type { El } from './element';

const REFUSAL_TEXT: Readonly<Record<string, string>> = Object.freeze({
  TRANSACTION_REQUIRED: 'Enter the transaction number from the receipt.',
  TRANSACTION_NOT_FOUND: 'No sale on this machine matches that number. Check the receipt.',
  DESCRIPTION_REQUIRED: 'Describe what went wrong, in your own words.',
  ALREADY_REPORTED: 'This sale has already been reported. Telga is looking at it.',
  NOT_SAVED: 'The report could not be saved. Try again in a moment.',
});

export interface ComplaintProps {
  readonly chrome: Chrome;
  readonly csrfToken: string;
  readonly refusal?: string;
  /** Prefilled when the shop reached this from a transaction. */
  readonly transactionId?: string;
  readonly values?: Readonly<Record<string, string>>;
}

export function complaintScreen(props: ComplaintProps): El {
  const { chrome } = props;
  const locale = chrome.locale;

  return page(
    chrome,
    t(locale, 'complaint.title'),
    h('p', { 'data-testid': 'complaint-intro' }, t(locale, 'complaint.intro')),
    props.refusal !== undefined &&
      h(
        'p',
        { 'data-testid': 'complaint-refusal', role: 'alert', 'data-tone': 'NEGATIVE' },
        REFUSAL_TEXT[props.refusal] ?? REFUSAL_TEXT['NOT_SAVED'],
      ),
    h(
      'form',
      { method: 'post', action: '/complaint', 'data-testid': 'complaint-form' },
      h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'transactionId' }, t(locale, 'complaint.transaction')),
        h('input', {
          id: 'transactionId',
          name: 'transactionId',
          type: 'text',
          required: true,
          value: props.transactionId ?? props.values?.['transactionId'],
          'data-testid': 'complaint-transaction',
          'aria-describedby': 'transactionId-hint',
        }),
        h('p', { id: 'transactionId-hint', class: 'field__hint' }, t(locale, 'complaint.transaction.hint')),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'description' }, t(locale, 'complaint.description')),
        h('textarea', {
          id: 'description',
          name: 'description',
          rows: '4',
          required: true,
          'data-testid': 'complaint-description',
        }, props.values?.['description'] ?? ''),
      ),
      h(
        'button',
        { type: 'submit', class: 'voucher__button', 'data-testid': 'complaint-submit' },
        t(locale, 'complaint.submit'),
      ),
    ),
    // The promise, stated once and honestly: an answer, not a refund.
    h('p', { class: 'slip__notice', 'data-testid': 'complaint-promise' }, t(locale, 'complaint.promise')),
  );
}

export interface ComplaintSentProps {
  readonly chrome: Chrome;
  readonly reference: string;
}

/**
 * What a shop sees after reporting.
 *
 * The case reference is what they quote when they ring, so it is the largest
 * thing on the screen. It deliberately says nothing about the likely outcome:
 * §17's states are successful, pending, confirmed failed and under review, and
 * none of them is known yet.
 */
export function complaintSentScreen(props: ComplaintSentProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'complaint.title'),
    h(
      'section',
      { 'data-testid': 'complaint-sent', role: 'status' },
      h('h2', {}, t(locale, 'complaint.sent.heading')),
      h('p', {}, t(locale, 'complaint.sent.reference')),
      h('p', { class: 'register__reference', 'data-testid': 'complaint-reference' }, props.reference),
      h('p', { 'data-testid': 'complaint-sent-next' }, t(locale, 'complaint.sent.next')),
    ),
    h(
      'p',
      { class: 'login__back' },
      h('a', { href: '/dashboard', 'data-testid': 'complaint-done' }, t(locale, 'receipt.action.close')),
    ),
  );
}
