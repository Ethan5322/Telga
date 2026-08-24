/**
 * Safe next actions.
 *
 * The action bar is built **from the view model's `allowedActions`**, never
 * from a condition written at the call site. That is the whole design: adding a
 * button to a screen cannot widen what a merchant may do, because the screen
 * has no vocabulary for an action the state table did not permit.
 *
 * ## Why refusals are rendered too
 *
 * A missing button explains nothing. When the state forbids retrying, the
 * screen says so in a sentence, so an operator who is about to key the sale in
 * again knows why they should not — and a test can assert the refusal is
 * *stated*, not merely that a button is absent.
 */

import { t } from '@telga/localization';
import type { Locale } from '@telga/localization';
import type { ForbiddenAction, MerchantAction, TransactionViewModel } from '@telga/pos-view-model';
import { h } from './element';
import type { El } from './element';

interface ActionSpec {
  readonly label: string;
  /**
   * Navigation target, or undefined for a control the client script handles.
   *
   * No target carries a merchant id: the session decides scope, and a merchant
   * id in a link is a value that looks authoritative and is not.
   */
  readonly href?: (view: TransactionViewModel) => string;
}

const ACTIONS: Readonly<Record<MerchantAction, ActionSpec>> = Object.freeze({
  VIEW_DETAIL: {
    label: 'View details',
    href: (view) => `/transactions/${encodeURIComponent(view.transactionId)}`,
  },
  REFRESH_STATUS: { label: 'Check again now' },
  PRINT_RECEIPT: { label: 'Print receipt' },
  REPRINT_RECEIPT: { label: 'Reprint receipt' },
  START_NEW_SALE: { label: 'Start a new sale', href: () => '/sell' },
  CONTACT_SUPPORT: { label: 'Contact support' },
  COPY_SUPPORT_REFERENCE: { label: 'Copy support reference' },
  BACK_TO_HOME: { label: 'Back to home', href: () => '/' },
});

/** One sentence per refusal, in the merchant's terms rather than the domain's. */
const REFUSAL_TEXT: Readonly<Record<ForbiddenAction, string>> = Object.freeze({
  RETRY_SAME_SALE: 'Do not sell this again — it would charge the customer twice.',
  PRINT_RECEIPT: 'No receipt yet: this sale is not confirmed.',
  TREAT_AS_SUCCESSFUL: 'Do not tell the customer the airtime has arrived yet.',
  TREAT_AS_FAILED: 'Do not tell the customer the sale failed yet.',
  RELEASE_FUNDS: 'Your held balance stays held until this is resolved.',
  CHANGE_STATE: 'This transaction cannot be changed from the counter.',
});

/**
 * The refusals worth saying out loud on a counter screen.
 *
 * Not all of them: `CHANGE_STATE` is true of every transaction and telling a
 * merchant they cannot edit a database row is noise. These three are the ones
 * that change what the operator does next.
 */
const SPOKEN_REFUSALS: readonly ForbiddenAction[] = [
  'RETRY_SAME_SALE',
  'TREAT_AS_SUCCESSFUL',
  'RELEASE_FUNDS',
];

export function actionBar(
  view: TransactionViewModel,
  merchantId: string,
  locale: Locale = 'en',
): El {
  // Kept in the signature so call sites read consistently; the action targets
  // deliberately do not use it.
  void merchantId;
  const controls = view.allowedActions.map((action) => {
    const spec = ACTIONS[action];
    const label =
      action === 'REPRINT_RECEIPT' ? t(locale, 'receipt.reprint') : spec.label;
    const testId = `action-${action}`;

    if (spec.href) {
      return h(
        'a',
        { href: spec.href(view), 'data-testid': testId, 'data-action': action },
        label,
      );
    }
    return h(
      'button',
      { type: 'button', 'data-testid': testId, 'data-action': action },
      label,
    );
  });

  return h(
    'section',
    { 'data-testid': 'action-bar', 'aria-label': 'What you can do next' },
    h('h2', {}, 'What you can do next'),
    h('ul', { class: 'actions' }, ...controls.map((control) => h('li', {}, control))),
    refusals(view),
  );
}

function refusals(view: TransactionViewModel): El | false {
  const spoken = SPOKEN_REFUSALS.filter((action) => view.forbiddenActions.includes(action));
  if (spoken.length === 0) return false;
  return h(
    'section',
    { 'data-testid': 'refusals', 'aria-label': 'What not to do' },
    h('h2', {}, 'What not to do'),
    h(
      'ul',
      {},
      ...spoken.map((action) =>
        h('li', { 'data-testid': `refusal-${action}` }, REFUSAL_TEXT[action]),
      ),
    ),
  );
}

/** Exposed for the tests that assert the table itself, not a rendered screen. */
export { ACTIONS, REFUSAL_TEXT, SPOKEN_REFUSALS };
