/**
 * Telga transfer — sending balance from one shop's device to another's.
 *
 * `CLAUDE.md` §19.1. **This is not a deposit.** No new value enters Telga: an
 * amount that already exists moves from one shop to another, and the total
 * across the platform is unchanged. The two deposit routes bring money *in*
 * from outside; this moves it *sideways*.
 *
 * ## Switched off, and built anyway
 *
 * Moving value between two legal entities is money transfer, and §2 and §7 list
 * remittance among the features disabled until legal review. This exists as a
 * **training simulation** — a training ledger, no counterparty, no bank, no
 * network — on the same precedent as the Telga Pay card simulator (D87/D124)
 * and training deposits (D70). Founder decision **D146** turned the flag on for
 * the training deployment; `money.live` is false and `assertNoLiveMoneyEnabled()`
 * refuses to boot if any real-money flag is on, so what this gates is the
 * simulation.
 *
 * (That function was called `assertSafeStartup` here until 2026-09-11. No such
 * function has ever existed — the name was repeated from a summary and never
 * checked against the code. The guarantee is real; the name was not.)
 *
 * ## The rule that matters most on this screen
 *
 * **The recipient is named by device id, never by device key.** A device key is
 * a credential (§18.2); asking one shopkeeper to read one aloud to another
 * teaches precisely the habit that loses a shop its money. The field says
 * "device ID" and the hint says where to find it.
 */

import { h } from './element';
import type { El } from './element';
import { page } from './chrome';
import type { Chrome } from './chrome';
import { t } from '@telga/localization';

export interface ShopTransferProps {
  readonly chrome: Chrome;
  readonly csrfToken: string;
  readonly availableFormatted: string;
  readonly errorMessage?: string;
  /** Set after a settled transfer, so the operator sees what moved. */
  readonly done?: {
    readonly amountFormatted: string;
    readonly feeFormatted: string;
    readonly recipientDeviceId: string;
    readonly remainingFormatted: string;
  };
  /** Set when the amount is over the threshold and Telga must approve first. */
  readonly awaitingApproval?: { readonly amountFormatted: string };
}

export function shopTransferScreen(props: ShopTransferProps): El {
  const { chrome } = props;
  const locale = chrome.locale;

  if (props.done !== undefined) {
    return page(
      chrome,
      t(locale, 'transfer.title'),
      h(
        'p',
        { 'data-testid': 'transfer-outcome', role: 'status', 'data-tone': 'POSITIVE' },
        t(locale, 'transfer.sent'),
      ),
      h(
        'dl',
        { class: 'summary', 'data-testid': 'transfer-receipt' },
        h('dt', {}, t(locale, 'transactions.column.amount')),
        h('dd', { 'data-testid': 'transfer-amount' }, props.done.amountFormatted),
        h('dt', {}, t(locale, 'transfer.fee')),
        h('dd', { 'data-testid': 'transfer-fee' }, props.done.feeFormatted),
        h('dt', {}, t(locale, 'transfer.recipient')),
        h('dd', { 'data-testid': 'transfer-recipient' }, props.done.recipientDeviceId),
        h('dt', {}, t(locale, 'balance.available')),
        h('dd', { 'data-testid': 'transfer-remaining' }, props.done.remainingFormatted),
      ),
      // §19.1: irreversible once settled, unless both shops agree and an admin
      // approves. Said here rather than only in a document, because this is the
      // moment somebody would want to undo it.
      h('p', { class: 'notice', 'data-testid': 'transfer-final' }, t(locale, 'transfer.final')),
      h('p', {}, h('a', { href: '/dashboard', 'data-testid': 'go-home' }, t(locale, 'voucher.action.home'))),
    );
  }

  if (props.awaitingApproval !== undefined) {
    return page(
      chrome,
      t(locale, 'transfer.title'),
      h(
        'p',
        { 'data-testid': 'transfer-outcome', role: 'status', 'data-tone': 'CAUTION' },
        t(locale, 'transfer.needs_approval'),
      ),
      h('p', { 'data-testid': 'transfer-pending-amount' }, props.awaitingApproval.amountFormatted),
      // The money has **not** moved. An operator who reads "sent" here would
      // tell the other shop to expect it.
      h('p', { class: 'notice', 'data-testid': 'transfer-not-moved' }, t(locale, 'transfer.not_moved')),
      h('p', {}, h('a', { href: '/dashboard', 'data-testid': 'go-home' }, t(locale, 'voucher.action.home'))),
    );
  }

  return page(
    chrome,
    t(locale, 'transfer.title'),
    h('p', { class: 'lede', 'data-testid': 'transfer-lede' }, t(locale, 'transfer.lede')),
    h(
      'p',
      { class: 'summary__value', 'data-testid': 'transfer-available' },
      `${t(locale, 'balance.available')}: ${props.availableFormatted}`,
    ),
    props.errorMessage !== undefined &&
      h('p', { class: 'error', role: 'alert', 'data-testid': 'transfer-error' }, props.errorMessage),
    h(
      'form',
      { method: 'post', action: '/transfer', 'data-testid': 'transfer-form' },
      h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
      h(
        'label',
        { for: 'recipientDeviceId' },
        t(locale, 'transfer.recipient'),
        h('input', {
          id: 'recipientDeviceId',
          name: 'recipientDeviceId',
          type: 'text',
          required: true,
          autocomplete: 'off',
          'data-testid': 'transfer-recipient-input',
        }),
      ),
      // The sentence that keeps a device key off this screen.
      h('p', { class: 'hint', 'data-testid': 'transfer-device-hint' }, t(locale, 'transfer.device_hint')),
      h(
        'label',
        { for: 'amountBirr' },
        t(locale, 'transactions.column.amount'),
        h('input', {
          id: 'amountBirr',
          name: 'amountBirr',
          type: 'number',
          inputmode: 'numeric',
          min: '1',
          step: '1',
          required: true,
          autocomplete: 'off',
          'data-testid': 'transfer-amount-input',
        }),
      ),
      h(
        'label',
        { for: 'pin' },
        t(locale, 'transfer.pin'),
        h('input', {
          id: 'pin',
          name: 'pin',
          type: 'password',
          inputmode: 'numeric',
          required: true,
          autocomplete: 'off',
          'data-testid': 'transfer-pin',
        }),
      ),
      h(
        'button',
        {
          type: 'submit',
          class: 'button button--primary',
          // Settled transfers do not come back. An accidental press is another
          // shop's balance.
          'data-confirm': t(locale, 'transfer.confirm'),
          'data-testid': 'transfer-submit',
        },
        t(locale, 'transfer.send'),
      ),
    ),
    h('p', { class: 'notice', 'data-testid': 'transfer-training-note' }, t(locale, 'transfer.training_only')),
  );
}
