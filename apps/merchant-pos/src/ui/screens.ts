/**
 * The screens.
 *
 * Five, which is the smallest coherent flow: home, new sale, transaction
 * detail, transaction history, and the pending / under-review queue. Each is a
 * pure function of view models and remote state, and each goes through `page()`,
 * so none of them can render without the training banner.
 *
 * ## The confirmation screen and the client request id
 *
 * `newSaleForm` takes a `clientRequestId` **generated when the form is built**,
 * not when it is submitted. That is what makes a double press idempotent: both
 * presses carry the same value, so `createSale` derives the same key and the
 * second one comes back as `DUPLICATE_REQUEST` rather than as a second sale.
 * A form that generated the id on submit would defeat the whole mechanism, so
 * it is a parameter rather than something this file invents.
 */

import { t } from '@telga/localization';
import type { Locale } from '@telga/localization';
import type { BalanceDto, RemoteData, TransactionViewModel } from '@telga/pos-view-model';
import { actionBar } from './actions';
import { nav, page } from './chrome';
import type { Chrome } from './chrome';
import { h } from './element';
import type { El, Node } from './element';
import { recoveryPanel, referenceBlock, statusBlock, supportBlock, fundsBlock } from './status';
import { renderRemote } from './states';

/** Clearly-simulated denominations. Prices are NOT YET CONFIRMED; these are training values. */
export interface CatalogEntry {
  readonly productId: string;
  readonly label: string;
  readonly amountMinor: number;
  readonly available: boolean;
}

export interface HomeProps {
  readonly chrome: Chrome;
  readonly balance: RemoteData<BalanceDto>;
  readonly recent: RemoteData<readonly TransactionViewModel[]>;
  readonly needsAttention: number;
}

function balanceTable(balance: BalanceDto, locale: Locale): El {
  const row = (labelKey: Parameters<typeof t>[1], value: string, id: string): El =>
    h(
      'tr',
      {},
      h('th', { scope: 'row' }, t(locale, labelKey)),
      h('td', { 'data-testid': id }, value),
    );

  return h(
    'table',
    { 'data-testid': 'balance-table' },
    h('caption', {}, t(locale, 'screen.balance')),
    h(
      'tbody',
      {},
      row('balance.available', balance.available.formatted, 'balance-available'),
      row('balance.reserved', balance.reserved.formatted, 'balance-reserved'),
      row('balance.under_review', balance.underReview.formatted, 'balance-under-review'),
    ),
  );
}

export function homeScreen(props: HomeProps): El {
  const { chrome, locale } = { chrome: props.chrome, locale: props.chrome.locale };
  return page(
    chrome,
    t(locale, 'screen.home'),
    nav(locale, chrome.merchantId, 'home'),
    renderRemote(props.balance, {
      what: 'balance',
      emptyMessage: 'No balance to show yet.',
      locale,
      render: (balance) => balanceTable(balance, locale),
    }),
    props.needsAttention > 0 &&
      h(
        'p',
        { 'data-testid': 'attention-count', role: 'status' },
        `${props.needsAttention} transaction(s) still being checked. Do not sell them again.`,
      ),
    h(
      'p',
      {},
      h(
        'a',
        { href: '/sell', 'data-testid': 'start-sale' },
        t(locale, 'sale.action.sell_airtime'),
      ),
    ),
    h('h2', {}, 'Recent sales'),
    renderRemote(props.recent, {
      what: 'recent sales',
      emptyMessage: 'No sales yet on this device.',
      locale,
      render: (items) => transactionList(items, chrome.merchantId, locale),
    }),
  );
}

export interface NewSaleProps {
  readonly chrome: Chrome;
  readonly catalog: readonly CatalogEntry[];
  /** Bound to the session. Every browser write carries it. */
  readonly csrfToken: string;
  /** Generated when this form is built. See the file header. */
  readonly clientRequestId: string;
  /** Training-only outcomes the operator can exercise on purpose. */
  readonly simulatedBehaviours: readonly string[];
  readonly validationMessage?: string;
}

export function newSaleScreen(props: NewSaleProps): El {
  const { chrome } = props;
  const locale = chrome.locale;

  const field = (id: string, label: string, control: El): El =>
    h('div', { class: 'field' }, h('label', { for: id }, label), control);

  return page(
    chrome,
    t(locale, 'screen.confirm'),
    nav(locale, chrome.merchantId, 'sell'),
    props.validationMessage !== undefined &&
      h('p', { 'data-testid': 'validation-message', role: 'alert' }, props.validationMessage),
    h(
      'form',
      { method: 'post', action: '/sell', 'data-testid': 'new-sale-form', 'aria-label': t(locale, 'sale.action.sell_airtime') },
      // No merchant, device or operator field. All three come from the session;
      // a hidden input carrying them would be an editable authorization claim.
      h('input', {
        type: 'hidden',
        name: 'csrfToken',
        value: props.csrfToken,
        'data-testid': 'csrf-token',
      }),
      h('input', {
        type: 'hidden',
        name: 'clientRequestId',
        value: props.clientRequestId,
        'data-testid': 'client-request-id',
      }),
      field(
        'productId',
        t(locale, 'sale.amount.select'),
        h(
          'select',
          { id: 'productId', name: 'productId', required: true, 'data-testid': 'product-select' },
          ...props.catalog.map((entry) =>
            h(
              'option',
              { value: entry.productId, disabled: !entry.available },
              `${entry.label}${entry.available ? '' : ' (unavailable)'}`,
            ),
          ),
        ),
      ),
      field(
        'recipient',
        t(locale, 'screen.recipient'),
        h('input', {
          id: 'recipient',
          name: 'recipient',
          type: 'tel',
          required: true,
          inputmode: 'numeric',
          autocomplete: 'off',
          'data-testid': 'recipient-input',
          'aria-describedby': 'recipient-hint',
        }),
      ),
      h(
        'p',
        { id: 'recipient-hint', 'data-testid': 'recipient-hint' },
        'Read the number back to the customer before confirming.',
      ),
      field(
        'simulatedProviderBehaviour',
        'Training outcome to practise',
        h(
          'select',
          {
            id: 'simulatedProviderBehaviour',
            name: 'simulatedProviderBehaviour',
            'data-testid': 'simulated-behaviour-select',
            'aria-describedby': 'simulated-hint',
          },
          ...props.simulatedBehaviours.map((behaviour) =>
            h('option', { value: behaviour }, behaviour),
          ),
        ),
      ),
      h(
        'p',
        { id: 'simulated-hint', 'data-testid': 'simulated-hint' },
        'Training only. This chooses which practice outcome the simulated provider returns. No real provider is contacted.',
      ),
      h(
        'button',
        { type: 'submit', 'data-testid': 'confirm-sale' },
        t(locale, 'sale.confirm.action'),
      ),
    ),
  );
}

export interface DetailProps {
  readonly chrome: Chrome;
  readonly transaction: RemoteData<TransactionViewModel>;
  /**
   * From the server envelope. The detail screen exposes it as data attributes
   * so the enhancement script polls at the recovery policy's own rate; with
   * scripting off the attributes are inert and the operator refreshes.
   */
  readonly polling?: { readonly statusCheckIntervalMs: number; readonly maxPolls: number };
}

export function transactionDetailScreen(props: DetailProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'screen.details'),
    nav(locale, chrome.merchantId, 'transactions'),
    renderRemote(props.transaction, {
      what: 'this transaction',
      emptyMessage: 'That transaction was not found for this merchant.',
      locale,
      render: (view) =>
        h(
          'div',
          {
            'data-testid': 'transaction-detail',
            'data-state': view.state,
            // Only an unresolved transaction is worth polling. A settled one
            // carries no poll attributes at all, so the script does nothing.
            'data-poll-transaction':
              view.refresh === 'POLL_UNTIL_RESOLVED' ? view.transactionId : undefined,
            'data-poll-merchant':
              view.refresh === 'POLL_UNTIL_RESOLVED' ? chrome.merchantId : undefined,
            'data-poll-state': view.refresh === 'POLL_UNTIL_RESOLVED' ? view.state : undefined,
            'data-poll-interval':
              view.refresh === 'POLL_UNTIL_RESOLVED' ? props.polling?.statusCheckIntervalMs : undefined,
            'data-poll-max':
              view.refresh === 'POLL_UNTIL_RESOLVED' ? props.polling?.maxPolls : undefined,
          },
          statusBlock(view, locale),
          fundsBlock(view, locale),
          referenceBlock(view, locale),
          recoveryPanel(view),
          supportBlock(view, locale),
          actionBar(view, chrome.merchantId, locale),
        ),
    }),
  );
}

/** A list of transactions. Every row states its own status in words. */
export function transactionList(
  items: readonly TransactionViewModel[],
  merchantId: string,
  locale: Locale = 'en',
): El {
  return h(
    'ul',
    { 'data-testid': 'transaction-list' },
    ...items.map((view) =>
      h(
        'li',
        { 'data-testid': 'transaction-row', 'data-state': view.state, 'data-tone': view.tone },
        h(
          'a',
          {
            href: `/transactions/${encodeURIComponent(view.transactionId)}`,
            'data-testid': `row-link-${view.transactionId}`,
          },
          `${view.amountFormatted} to ${view.recipientMasked}`,
        ),
        h('span', { 'data-testid': 'row-status' }, ` — ${view.statusLabel}`),
        view.doNotRetryYet &&
          h('span', { 'data-testid': 'row-do-not-retry' }, ` — ${t(locale, 'status.pending.do_not_retry')}`),
      ),
    ),
  );
}

export interface HistoryProps {
  readonly chrome: Chrome;
  readonly transactions: RemoteData<readonly TransactionViewModel[]>;
}

export function transactionHistoryScreen(props: HistoryProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'screen.search'),
    nav(locale, chrome.merchantId, 'transactions'),
    renderRemote(props.transactions, {
      what: 'transactions',
      emptyMessage: 'No transactions yet.',
      locale,
      render: (items) => transactionList(items, chrome.merchantId, locale),
    }),
  );
}

export interface QueueProps {
  readonly chrome: Chrome;
  readonly pending: readonly TransactionViewModel[];
  readonly underReview: readonly TransactionViewModel[];
  readonly reversalRequired: readonly TransactionViewModel[];
}

/**
 * The queue.
 *
 * Three groups, each labelled with what the merchant should do — which for all
 * three is "wait, and do not sell it again". The counts are rendered as text
 * beside each heading so an empty group is visibly empty rather than absent.
 */
export function queueScreen(props: QueueProps): El {
  const { chrome } = props;
  const locale = chrome.locale;

  const group = (
    title: string,
    id: string,
    items: readonly TransactionViewModel[],
    guidance: string,
  ): El =>
    h(
      'section',
      { 'data-testid': `queue-${id}`, 'aria-label': title },
      h('h2', {}, `${title} (${items.length})`),
      h('p', { 'data-testid': `queue-${id}-guidance` }, guidance),
      items.length === 0
        ? h('p', { 'data-testid': `queue-${id}-empty` }, 'Nothing here.')
        : transactionList(items, chrome.merchantId, locale),
    );

  return page(
    chrome,
    t(locale, 'screen.admin_queue'),
    nav(locale, chrome.merchantId, 'queue'),
    group(
      t(locale, 'status.pending'),
      'pending',
      props.pending,
      'Telga is still checking these with the provider. Do not retry them.',
    ),
    group(
      t(locale, 'status.under_review'),
      'under-review',
      props.underReview,
      'The Telga team is resolving these. Your money stays held until they do.',
    ),
    group(
      'Reversal required',
      'reversal-required',
      props.reversalRequired,
      'Value was taken and not delivered. Telga is returning it; a supervisor must authorize each one.',
    ),
  );
}

/** Serialise any screen as a full HTML document. */
export { type Node as ScreenNode };
