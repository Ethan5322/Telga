/**
 * Status, funds and recovery blocks.
 *
 * These three carry the whole safety argument of the UI, so each is a separate
 * function with its own test id:
 *
 *   `statusBlock`   — what the transaction is, never overstated.
 *   `fundsBlock`    — where the merchant's money is right now.
 *   `recoveryPanel` — what Telga is doing about an unresolved one.
 *
 * ## The rule that shapes all three
 *
 * A screen may never imply an outcome that is not known. `statusBlock` renders
 * `certainty` as text, so an uncertain transaction says so in words rather than
 * relying on the reader inferring it from the absence of a tick. And when
 * `doNotRetryYet` is set the instruction is rendered **before** the status
 * detail, with `role="alert"`, because it is the one line that must not be
 * missed on a busy counter.
 */

import { t } from '@telga/localization';
import type { Locale } from '@telga/localization';
import { displayProviderReference } from '@telga/pos-view-model';
import type { RecoverySummary, TransactionViewModel } from '@telga/pos-view-model';
import { h } from './element';
import type { El } from './element';

/** Plain words for the certainty levels. No jargon reaches the counter. */
const CERTAINTY_TEXT: Readonly<Record<TransactionViewModel['certainty'], string>> = Object.freeze({
  IN_PROGRESS: 'Still in progress — the result is not known yet',
  UNCERTAIN: 'The result is not known yet',
  AWAITING_DETERMINATION: 'Being checked by Telga — the result is not known yet',
  CERTAIN_SUCCESS: 'Confirmed by the provider',
  CERTAIN_NO_SALE: 'Confirmed — no sale took place',
});

/**
 * Status is conveyed three ways at once: an icon, a text label and a tone
 * attribute. `04 UX UI/Design System.md` forbids colour as the only signal, and
 * a `data-tone` attribute is a colour hook, so the icon and the label carry the
 * meaning on their own.
 */
export function statusBlock(view: TransactionViewModel, locale: Locale = 'en'): El {
  return h(
    'section',
    {
      'data-testid': 'status-block',
      'data-state': view.state,
      'data-tone': view.tone,
      'data-certainty': view.certainty,
      'aria-label': `Transaction status: ${view.statusLabel}`,
    },
    view.doNotRetryYet &&
      h(
        'p',
        { 'data-testid': 'do-not-retry', role: 'alert', class: 'instruction instruction--urgent' },
        t(locale, 'status.pending.do_not_retry'),
      ),
    h(
      'p',
      { class: 'status__headline' },
      h('span', { 'data-testid': 'status-icon', 'aria-hidden': 'true' }, view.icon),
      h('span', { 'data-testid': 'status-label' }, view.statusLabel),
    ),
    h('p', { 'data-testid': 'status-certainty' }, CERTAINTY_TEXT[view.certainty]),
    h('p', { 'data-testid': 'status-explanation' }, view.statusExplanation),
    view.untranslated.length > 0 &&
      h(
        'p',
        { 'data-testid': 'untranslated-notice', class: 'notice' },
        'Shown in English: this text has not been translated yet.',
      ),
  );
}

/** Where the money is. Derived from the domain's own value disposition. */
export function fundsBlock(view: TransactionViewModel, locale: Locale = 'en'): El {
  return h(
    'section',
    {
      'data-testid': 'funds-block',
      'data-funds-status': view.fundsStatus,
      'aria-label': 'Funds status',
    },
    h('h2', {}, t(locale, 'balance.available')),
    h('p', { 'data-testid': 'funds-label' }, view.fundsLabel),
    h('p', { 'data-testid': 'funds-amount' }, view.amountFormatted),
  );
}

const PHASE_TEXT: Readonly<Record<RecoverySummary['phase'], string>> = Object.freeze({
  NOT_APPLICABLE: 'No recovery needed for this transaction.',
  AWAITING_RECOVERY: 'Waiting for Telga to check this with the provider.',
  BEING_CHECKED_NOW: 'Telga is checking this with the provider now.',
  ESCALATED: 'This has been passed to the Telga team to resolve.',
  RESOLVED: 'Telga finished checking this transaction.',
});

/**
 * The recovery timeline.
 *
 * Shows attempts, the last attempt, the next scheduled check and the escalation
 * deadline — the four things that answer "is anything actually happening". The
 * worker id, the lease and the scan id are all omitted: they identify Telga's
 * internals, not the merchant's transaction.
 */
export function recoveryPanel(view: TransactionViewModel): El {
  const r = view.recovery;
  const row = (label: string, value: string | null, id: string): El | false =>
    value === null
      ? false
      : h(
          'div',
          { class: 'timeline__row' },
          h('dt', {}, label),
          h('dd', { 'data-testid': id }, value),
        );

  return h(
    'section',
    { 'data-testid': 'recovery-panel', 'data-phase': r.phase, 'aria-label': 'Recovery status' },
    h('h2', {}, 'What Telga is doing'),
    h('p', { 'data-testid': 'recovery-phase' }, PHASE_TEXT[r.phase]),
    h(
      'dl',
      { class: 'timeline' },
      row(
        'Status checks made',
        r.phase === 'NOT_APPLICABLE'
          ? null
          : r.maxAttempts === null
            ? String(r.attempts)
            : `${r.attempts} of ${r.maxAttempts}`,
        'recovery-attempts',
      ),
      row('Last checked', r.lastAttemptAt, 'recovery-last-attempt'),
      row('Next check due', r.nextCheckAt, 'recovery-next-check'),
      row('Escalates after', r.deadlineAt, 'recovery-deadline'),
      row('Last provider outcome', r.lastOutcomeCategory, 'recovery-last-outcome'),
    ),
    r.manualReviewOpen &&
      h(
        'p',
        { 'data-testid': 'manual-review-open', role: 'status' },
        'A Telga reviewer is looking at this transaction.',
      ),
  );
}

/** The support block. Present only when there is a reference to quote. */
export function supportBlock(view: TransactionViewModel, locale: Locale = 'en'): El | false {
  if (view.supportReference === null) return false;
  return h(
    'section',
    { 'data-testid': 'support-block', 'aria-label': t(locale, 'support.contact') },
    h('h2', {}, t(locale, 'support.contact')),
    h('p', { 'data-testid': 'support-reference' }, `Reference: ${view.supportReference}`),
    h('p', {}, t(locale, 'support.response.notice')),
  );
}

/**
 * The identifiers support needs.
 *
 * The provider reference is shortened for a counter screen; the full value
 * stays in the transaction record. The correlation id is passed through whole,
 * because it is what ties this transaction to the worker's own log lines and it
 * carries no personal data.
 */
export function referenceBlock(view: TransactionViewModel, locale: Locale = 'en'): El {
  return h(
    'section',
    { 'data-testid': 'reference-block', 'aria-label': 'Transaction references' },
    h(
      'dl',
      {},
      h('dt', {}, t(locale, 'transaction.id')),
      h('dd', { 'data-testid': 'transaction-id' }, view.transactionId),
      h('dt', {}, 'Sent to'),
      h('dd', { 'data-testid': 'recipient-masked' }, view.recipientMasked),
      h('dt', {}, 'Provider reference'),
      h(
        'dd',
        { 'data-testid': 'provider-reference' },
        displayProviderReference(view.providerReference) ?? 'Not issued',
      ),
      h('dt', {}, 'Support code'),
      h('dd', { 'data-testid': 'correlation-id' }, view.correlationId),
    ),
  );
}
