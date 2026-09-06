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
import { format, money } from '@telga/domain';
import type { BalanceDto, RemoteData, TransactionViewModel } from '@telga/pos-view-model';
import { actionBar } from './actions';
import { nav, page } from './chrome';
import type { Chrome } from './chrome';
import { h } from './element';
import type { El, Node } from './element';
import { telgaLogo } from './logo';
import { recoveryPanel, referenceBlock, statusBlock, supportBlock, fundsBlock } from './status';
import { renderRemote } from './states';

/** Clearly-simulated denominations. Prices are NOT YET CONFIRMED; these are training values. */
export interface CatalogEntry {
  readonly productId: string;
  readonly label: string;
  readonly amountMinor: number;
  readonly available: boolean;
}

/**
 * A simulated training network, for the voucher flow only.
 *
 * `label` already carries the "(simulated)" suffix, so a screen that renders
 * it verbatim cannot accidentally present it as a real integration.
 */
export interface VoucherNetwork {
  readonly id: string;
  readonly label: string;
}

/** A voucher catalog entry: one network, one product type, one denomination. */
export interface VoucherProduct {
  readonly productId: string;
  readonly network: string;
  readonly productType: 'AIRTIME' | 'TOPUP' | 'DATA';
  readonly label: string;
  readonly amountMinor: number;
  readonly available: boolean;
  /** The per-network entry whose amount the operator types. */
  readonly isCustom?: boolean;
  /** Data bundles only: which category screen this belongs behind. */
  readonly dataCategory?: string;
  /** Data bundles only, e.g. `1GB` or `100 minutes`. */
  readonly volumeLabel?: string;
  readonly validityDays?: number;
  /** Data bundles only, e.g. `30 days`. */
  readonly validityLabel?: string;
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
      ' · ',
      h(
        'a',
        { href: '/menu', 'data-testid': 'open-voucher-menu' },
        t(locale, 'screen.vouchers'),
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
          // A disabled, pre-selected placeholder. Without it the browser
          // selects the first real option, so an operator who never touched
          // the control still submits an amount they did not choose.
          h(
            'option',
            { value: '', disabled: true, selected: true },
            t(locale, 'sale.amount.select_placeholder'),
          ),
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
        "Read the customer's cellphone number back to them before confirming.",
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
  /**
   * The date range in force, as `YYYY-MM-DD`, so the form shows what it filtered
   * by rather than resetting itself every time it is used.
   */
  readonly range?: { readonly from: string; readonly to: string };
}

/**
 * The date-range filter.
 *
 * A `GET` form, so a filtered view has its own URL: an owner can bookmark last
 * month, and the back button behaves. `type="date"` gives a native picker on a
 * phone and a POS, and degrades to a plain text field where it does not.
 *
 * The server re-applies the range regardless of what the form sends, so an
 * edited query string narrows a view but cannot widen it past the merchant's
 * own transactions — the read is already scoped by session.
 */
function dateRangeFilter(locale: Locale, range: { from: string; to: string } | undefined): El {
  return h(
    'form',
    { method: 'get', action: '/transactions', class: 'history__filter', 'data-testid': 'history-filter' },
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'from' }, t(locale, 'statements.from')),
      h('input', {
        id: 'from',
        name: 'from',
        type: 'date',
        value: range?.from ?? '',
        'data-testid': 'history-from',
      }),
    ),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'to' }, t(locale, 'statements.to')),
      h('input', {
        id: 'to',
        name: 'to',
        type: 'date',
        value: range?.to ?? '',
        'data-testid': 'history-to',
      }),
    ),
    h(
      'p',
      { class: 'voucher__actions' },
      h('button', { type: 'submit', class: 'voucher__button', 'data-testid': 'history-apply' }, t(locale, 'statements.apply')),
      h('a', { href: '/transactions', class: 'voucher__button', 'data-testid': 'history-clear' }, t(locale, 'statements.clear')),
      h('a', { href: '/statements', class: 'voucher__button', 'data-testid': 'history-statement' }, t(locale, 'statements.title')),
    ),
  );
}

/**
 * Newest first, with a stable tie-break.
 *
 * Two sales in the same millisecond are possible — the training clock is
 * injected and a test can hold it still — so `createdAt` alone is not a total
 * order. Falling back to the transaction id keeps the list stable across
 * renders instead of letting equal timestamps shuffle.
 */
export function sortNewestFirst(
  items: readonly TransactionViewModel[],
): readonly TransactionViewModel[] {
  return [...items].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.transactionId < b.transactionId ? 1 : -1;
  });
}

const dateOf = (iso: string): string => iso.slice(0, 10);
const timeOf = (iso: string): string => iso.slice(11, 19);

/** One row of the history table. Never renders a hash, digest or internal key. */
function historyRow(view: TransactionViewModel, locale: Locale): El {
  return h(
    'tr',
    { 'data-testid': 'transaction-row', 'data-state': view.state, 'data-tone': view.tone },
    h(
      'td',
      { 'data-testid': 'row-datetime' },
      h('span', { class: 'history__date' }, dateOf(view.createdAt)),
      ' ',
      h('span', { class: 'history__time' }, timeOf(view.createdAt)),
    ),
    // The view model carries no product label; the service is the transaction's
    // own product type, which is what the slip prints too.
    h('td', { 'data-testid': 'row-service' }, view.productType),
    h('td', { 'data-testid': 'row-amount' }, view.amountFormatted),
    h('td', { 'data-testid': 'row-status' }, view.statusLabel),
    h('td', { 'data-testid': 'row-reference' }, view.transactionId),
    h(
      'td',
      {},
      view.receiptAvailable
        ? h(
            'a',
            {
              href: `/transactions/${encodeURIComponent(view.transactionId)}/slip`,
              class: 'voucher__button',
              'data-testid': `row-reprint-${view.transactionId}`,
            },
            t(locale, 'receipt.reprint'),
          )
        : h('span', { 'data-testid': 'row-no-receipt' }, '—'),
    ),
  );
}

export function transactionHistoryScreen(props: HistoryProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'screen.search'),
    nav(locale, chrome.merchantId, 'transactions'),
    dateRangeFilter(locale, props.range),
    renderRemote(props.transactions, {
      what: 'transactions',
      emptyMessage: t(locale, 'transactions.empty'),
      locale,
      render: (items) =>
        h(
          'table',
          { class: 'history__table', 'data-testid': 'transaction-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', { scope: 'col' }, t(locale, 'transactions.column.datetime')),
              h('th', { scope: 'col' }, t(locale, 'transactions.column.service')),
              h('th', { scope: 'col' }, t(locale, 'transactions.column.amount')),
              h('th', { scope: 'col' }, t(locale, 'transactions.column.status')),
              h('th', { scope: 'col' }, t(locale, 'transactions.column.reference')),
              h('th', { scope: 'col' }, t(locale, 'receipt.reprint')),
            ),
          ),
          h('tbody', {}, ...sortNewestFirst(items).map((view) => historyRow(view, locale))),
        ),
    }),
  );
}

/**
 * How the shop has chosen to print.
 *
 * Read from the server's `settings` rows, never from the browser: a slip's
 * width and advertising line are the merchant's setting, not a client
 * preference, and they have to survive a device being replaced.
 */
export interface SlipStyle {
  readonly size: '58' | '80';
  /** The shop's own line at the foot of the slip. Empty means none. */
  readonly advert: string;
  /**
   * The shop's identity, printed under the Telga mark (migration 011).
   *
   * Carried on the *style* rather than passed to each slip separately,
   * because the style is already read once per render and handed to every
   * slip caller — so a new slip type cannot forget to print the shop's name.
   *
   * **Telga verifies none of these.** They are what the owner typed.
   */
  readonly business?: {
    readonly name?: string;
    readonly address?: string;
    readonly phone?: string;
    readonly tin?: string;
    readonly licence?: string;
    readonly footer?: string;
  };
  /**
   * Print a scannable code of the transaction reference on the slip.
   *
   * Drawn as bars rather than fetched as an image: a thermal printer renders
   * black-and-white bars perfectly and an image badly, and it keeps the slip
   * self-contained.
   */
  readonly printBarcode?: boolean;
  /**
   * Print a second, compact slip carrying only the reference — the one a shop
   * keeps to find a sale again, as opposed to the one the customer takes.
   */
  readonly printLookupSlip?: boolean;
}

/**
 * The registered company, as it must appear on anything printed.
 *
 * One constant rather than a literal at each print site: a slip, a reprint and
 * a Telga Pay deposit are three different code paths, and a legal name that
 * differs between them is worse than one that is merely wrong. Changing it here
 * changes every piece of paper the product produces.
 *
 * `Telga` remains the product name on screen — this is the entity behind it.
 */
export const TELGA_LEGAL_NAME = 'TELGA TRADING PLC';

export const DEFAULT_SLIP_STYLE: SlipStyle = Object.freeze({ size: '80', advert: '' });

export interface SlipLine {
  readonly label: string;
  readonly value: string;
  readonly id: string;
}

/**
 * A scannable code for the transaction reference.
 *
 * Deliberately drawn as bars rather than fetched as an image: a thermal head
 * renders solid black bars perfectly and a rasterised image badly, and it
 * keeps the slip self-contained with nothing to load. The widths come from
 * the reference's own characters, so what is scanned is what is printed.
 */
function barcodeOf(entry: SlipLine | false | undefined): El | false {
  if (entry === false || entry === undefined) return false;
  const source = entry.value;
  const bars: El[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    // Three bars per character, widths 1–3, so a short reference still fills
    // a readable strip and a long one does not overflow the roll.
    for (let bit = 0; bit < 3; bit += 1) {
      const width = ((code >> (bit * 2)) & 0x03) + 1;
      bars.push(h('i', { style: `width:${String(width)}px` }));
    }
  }
  return h(
    'div',
    { class: 'slip__barcode', 'data-testid': 'slip-barcode', 'aria-hidden': 'true' },
    h('div', { class: 'slip__barcode-bars' }, ...bars),
    h('span', { class: 'slip__barcode-text' }, source),
  );
}

export interface SlipCardProps {
  readonly locale: Locale;
  readonly subtitle: string;
  readonly lines: readonly (SlipLine | false)[];
  readonly style: SlipStyle;
  readonly supportContact: string;
  /** Rendered above the rule, e.g. the reprint notice. */
  readonly notice?: { readonly text: string; readonly id: string };
}

/**
 * The one slip.
 *
 * Every printed thing in Telga renders through this function — a sale, a
 * top-up, a reprint, and a Telga Pay deposit — so a change to what a slip
 * looks like cannot reach three of them and miss the fourth. It carries only
 * what belongs on paper: no hash, no digest, no idempotency key, no token.
 *
 * The training notice is not a parameter. Every slip this build can print is
 * a training slip, and a caller must not be able to omit the line that says
 * so.
 */
export function slipCard(props: SlipCardProps): El {
  const { locale, style } = props;
  const line = (entry: SlipLine): El =>
    h(
      'div',
      { class: 'slip__line' },
      h('span', { class: 'slip__label' }, entry.label),
      h('span', { class: 'slip__value', 'data-testid': entry.id }, entry.value),
    );

  return h(
    'section',
    {
      class: `slip slip--${style.size}`,
      'data-testid': 'transaction-slip',
      'data-slip-size': style.size,
    },
    // The mark, on every printed thing — a vending sale, a top-up, a data
    // bundle, a reprint and a Telga Pay deposit all draw this card, so the
    // logo cannot reach some slips and miss others.
    //
    // The `mono` variant, because a thermal roll is one bit per dot: the
    // colour mark would print as a smear. The screen shows the same shape,
    // and `document.ts` gives it colour outside the print stylesheet.
    h(
      'p',
      { class: 'slip__logo', 'data-testid': 'slip-logo' },
      telgaLogo({ variant: 'mono', height: 34, title: '' }),
    ),
    // The **legal entity**, not the product name.
    //
    // This printed `TELGA` — the brand. A receipt is the one artefact that
    // leaves the shop in a customer's hand, and `04 UX UI/Receipt
    // Specification` requires it to carry Telga's identity: for a document
    // somebody may take to a dispute, that means the registered company, not
    // a wordmark.
    //
    // Set by the founder on 2026-08-29. Note for the launch gates: printing
    // "PLC" asserts a registered legal form, so CLAUDE.md §8's *"company
    // authority documented"* gate has to close before this slip is handed to a
    // real customer. The training banner above it says no real value moved,
    // which is what keeps this honest in the meantime.
    h('p', { class: 'slip__brand', 'data-testid': 'slip-brand' }, TELGA_LEGAL_NAME),
    // The shop, under the platform. Absent fields do not print, so a shop
    // that has filled none in gets exactly the slip it had before.
    props.style.business?.name !== undefined &&
      props.style.business.name.length > 0 &&
      h('p', { class: 'slip__business-name', 'data-testid': 'slip-business-name' }, props.style.business.name),
    props.style.business?.address !== undefined &&
      props.style.business.address.length > 0 &&
      h('p', { class: 'slip__business-line', 'data-testid': 'slip-business-address' }, props.style.business.address),
    props.style.business?.phone !== undefined &&
      props.style.business.phone.length > 0 &&
      h('p', { class: 'slip__business-line', 'data-testid': 'slip-business-phone' }, props.style.business.phone),
    props.style.business?.tin !== undefined &&
      props.style.business.tin.length > 0 &&
      h('p', { class: 'slip__business-line', 'data-testid': 'slip-business-tin' }, `TIN ${props.style.business.tin}`),
    props.style.business?.licence !== undefined &&
      props.style.business.licence.length > 0 &&
      h('p', { class: 'slip__business-line', 'data-testid': 'slip-business-licence' }, `Licence ${props.style.business.licence}`),
    h('p', { class: 'slip__subtitle' }, props.subtitle),
    props.notice !== undefined &&
      h('p', { class: 'slip__reprint', 'data-testid': props.notice.id }, props.notice.text),
    h('hr', { class: 'slip__rule' }),
    ...props.lines.map((entry) => (entry === false ? false : line(entry))),
    // Printed immediately beneath the codes, not at the foot with the general
    // training banner. A customer reading a PIN needs the warning next to the
    // PIN, and like the training notice it is drawn here rather than passed
    // in, so no caller can print a code without it.
    props.lines.some((entry) => entry !== false && entry.id === 'slip-redemption-code') &&
      h(
        'p',
        { class: 'slip__code-notice', 'data-testid': 'slip-simulated-code-notice' },
        t(locale, 'receipt.slip.simulated_code_notice'),
      ),
    // The reference as bars, when the shop asked for it. Above the training
    // banner so a scanner meets it before the small print.
    style.printBarcode === true &&
      barcodeOf(props.lines.find((entry) => entry !== false && entry.id === 'slip-reference')),
    h('hr', { class: 'slip__rule' }),
    h(
      'p',
      { class: 'slip__banner', 'data-testid': 'slip-training-banner' },
      t(locale, 'receipt.training_notice'),
    ),
    style.advert.length > 0 &&
      h('p', { class: 'slip__advert', 'data-testid': 'slip-advert' }, style.advert),
    // The shop's closing line, kept separate from the advertisement: one is a
    // standing sign-off, the other is whatever the shop is promoting today.
    props.style.business?.footer !== undefined &&
      props.style.business.footer.length > 0 &&
      h('p', { class: 'slip__advert', 'data-testid': 'slip-business-footer' }, props.style.business.footer),
    h('p', { class: 'slip__support' }, props.supportContact),
  );
}

export interface SlipProps {
  readonly chrome: Chrome;
  readonly receipt: {
    readonly transactionId: string;
    readonly merchantId: string;
    readonly service: string;
    readonly network: string | null;
    readonly amountFormatted: string;
    readonly currency: string;
    readonly issuedAt: string;
    readonly state: string;
    readonly recipientMasked: string;
    readonly providerReference: string | null;
    readonly supportContact: string;
    readonly trainingBanner: string;
    readonly isReprint: boolean;
    readonly reprintSequence: number;
    /** Simulated redemption details. Null for a top-up, which has no code. */
    readonly networkCode?: string | null;
    readonly redemptionCode?: string | null;
    readonly redemptionReference?: string | null;
    readonly dialString?: string | null;
  };
  readonly csrfToken: string;
  readonly style?: SlipStyle;
  /** Set when a reprint request failed, so the operator is told plainly. */
  readonly failureMessage?: string;
}

/** The transaction lines every sale, top-up and reprint slip shares. */
export function transactionSlipLines(
  receipt: SlipProps['receipt'],
  locale: Locale,
): readonly (SlipLine | false)[] {
  return [
    { label: t(locale, 'voucher.summary.merchant'), value: receipt.merchantId, id: 'slip-merchant' },
    { label: t(locale, 'transactions.column.service'), value: receipt.service, id: 'slip-service' },
    receipt.network !== null && {
      label: t(locale, 'screen.provider_select'),
      value: receipt.network,
      id: 'slip-network',
    },
    {
      label: t(locale, 'transactions.column.amount'),
      value: receipt.amountFormatted,
      id: 'slip-amount',
    },
    { label: 'Date', value: dateOf(receipt.issuedAt), id: 'slip-date' },
    { label: 'Time', value: timeOf(receipt.issuedAt), id: 'slip-time' },
    {
      label: t(locale, 'transactions.column.reference'),
      value: receipt.transactionId,
      id: 'slip-reference',
    },
    { label: t(locale, 'transactions.column.status'), value: receipt.state, id: 'slip-status' },
    // Masked at write time by the persistence layer; the full number is never
    // stored, so it cannot be printed even by mistake. Omitted entirely when
    // the product has no recipient — a counter voucher is handed over, not
    // sent anywhere, and a blank or starred line there is worse than none.
    receipt.recipientMasked.length > 0 && {
      label: t(locale, 'screen.recipient'),
      value: receipt.recipientMasked,
      id: 'slip-recipient',
    },
    receipt.providerReference !== null && {
      label: 'Provider ref',
      value: receipt.providerReference,
      id: 'slip-provider-ref',
    },
    // Redemption details, for the products that have any. A top-up lands on
    // the customer's phone directly and carries none — printing a code there
    // would invite somebody to try to redeem it.
    //
    // Every value is deliberately fake and the notice below says so on the
    // paper itself, because a merchant hands this slip to a customer who has
    // no other way to know. See `simulatedVoucherCode()`.
    typeof receipt.networkCode === 'string' && {
      label: t(locale, 'receipt.slip.network_code'),
      value: receipt.networkCode,
      id: 'slip-network-code',
    },
    typeof receipt.redemptionCode === 'string' && {
      label: t(locale, 'receipt.slip.voucher_pin'),
      value: receipt.redemptionCode,
      id: 'slip-redemption-code',
    },
    typeof receipt.redemptionReference === 'string' && {
      label: t(locale, 'receipt.slip.token_reference'),
      value: receipt.redemptionReference,
      id: 'slip-redemption-reference',
    },
    typeof receipt.dialString === 'string' && {
      label: t(locale, 'receipt.slip.dial_string'),
      value: receipt.dialString,
      id: 'slip-dial-string',
    },
  ];
}

/**
 * The slip, reached from history or straight after a sale.
 *
 * Compact and narrow on purpose — it is the same shape a thermal roll prints,
 * and the print stylesheet drops everything except the card.
 */
export function slipScreen(props: SlipProps): El {
  const { chrome, receipt } = props;
  const locale = chrome.locale;

  return page(
    chrome,
    t(locale, 'receipt.slip.title'),
    props.failureMessage !== undefined &&
      h(
        'p',
        { 'data-testid': 'slip-error', role: 'alert', 'data-tone': 'NEGATIVE' },
        props.failureMessage,
      ),
    slipCard({
      locale,
      subtitle: t(locale, 'receipt.slip.title'),
      lines: transactionSlipLines(receipt, locale),
      style: props.style ?? DEFAULT_SLIP_STYLE,
      supportContact: receipt.supportContact,
      notice: receipt.isReprint
        ? {
            text: `${t(locale, 'receipt.slip.reprint_notice')} (${String(receipt.reprintSequence)})`,
            id: 'slip-reprint-notice',
          }
        : undefined,
    }),
    h('p', { class: 'slip__notice', 'data-testid': 'no-printer-notice' }, t(locale, 'voucher.result.no_printer')),
    h(
      'div',
      { class: 'voucher__actions slip__actions' },
      // Close returns to the main screen, which is where an operator wants to
      // be once the paper is in the customer's hand. History is one tap away
      // from there; being stranded is not.
      h(
        'a',
        { href: '/dashboard', class: 'voucher__button', 'data-testid': 'slip-close' },
        t(locale, 'receipt.action.close'),
      ),
      // The sale is finished and the paper is printed. There is no order left
      // to cancel, so Main is a plain link straight out of the flow — this is
      // the screen an operator was previously stranded on.
      mainButton({ chrome }),
      h(
        'form',
        {
          method: 'post',
          action: `/transactions/${encodeURIComponent(receipt.transactionId)}/reprint`,
          'data-testid': 'slip-reprint-form',
        },
        h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
        h(
          'button',
          {
            type: 'submit',
            class: 'voucher__button voucher__button--print',
            // Disabled on submit by the enhancement script, so a double click
            // cannot fire two reprint requests. A reprint is financially
            // inert either way — it only appends an audit line.
            'data-once': 'reprint',
            'data-testid': 'slip-reprint',
          },
          t(locale, 'receipt.reprint'),
        ),
      ),
    ),
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

// --- training voucher flow -------------------------------------------------
//
// Route foundation only (Stage 1). No screen below writes anything: the
// amount form and the PIN form are the only two `<form>` elements, and
// neither is wired to `createSale` yet — see `apps/merchant-pos/src/server.ts`
// for what each submit currently does. Every network label already carries
// "(simulated)"; no screen here may render one without it.

const formatAmount = (amountMinor: number): string => format(money(amountMinor));

export interface MenuProps {
  readonly chrome: Chrome;
  readonly balance?: RemoteData<BalanceDto>;
}

export function mainMenuScreen(props: MenuProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'screen.menu'),
    h(
      'ul',
      { 'data-testid': 'menu-list' },
      h(
        'li',
        {},
        h('a', { href: '/vouchers', 'data-testid': 'menu-vouchers' }, t(locale, 'screen.vouchers')),
      ),
      h(
        'li',
        {},
        h(
          'span',
          { 'data-testid': 'menu-data', 'aria-disabled': 'true' },
          `Data (${t(locale, 'voucher.data.unavailable')})`,
        ),
      ),
      h(
        'li',
        {},
        h(
          'span',
          { 'data-testid': 'menu-electricity', 'aria-disabled': 'true' },
          `Electricity (${t(locale, 'voucher.data.unavailable')})`,
        ),
      ),
      // The vending dashboard, not the legacy `/` home.
      h('li', {}, h('a', { href: '/dashboard', 'data-testid': 'menu-home' }, t(locale, 'nav.main'))),
    ),
    props.balance !== undefined &&
      renderRemote(props.balance, {
        what: 'balance',
        emptyMessage: 'No balance to show yet.',
        locale,
        render: (balance) => balanceTable(balance, locale),
      }),
  );
}

// --- the Main button ----------------------------------------------------------

export interface MainButtonProps {
  readonly chrome: Chrome;
  /**
   * Set on screens where an order already exists. Pressing Main cancels it
   * on the way out, so an abandoned order does not sit `OPEN` holding the
   * operator's next attempt hostage until its ten-minute clock expires.
   * Omitted on the screens before an order exists, where Main is a plain link.
   */
  readonly openOrderId?: string;
}

/**
 * "Go to the main screen", available at every depth of the sale flow.
 *
 * Two shapes, for one reason. Before an order exists there is nothing to
 * clean up, so this is an ordinary link and works with scripting off. Once an
 * order exists, leaving without cancelling would strand an `OPEN` row, so it
 * becomes a form — which means it carries CSRF like every other write.
 *
 * The confirmation is an enhancement (`data-confirm`), never a gate: with
 * scripting off the form still submits and still cancels, which is the safe
 * outcome either way. No voucher is issued in either case.
 *
 * Deliberately absent from `/dashboard` itself — a button that goes where you
 * already are is noise.
 */
export function mainButton(props: MainButtonProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  const label = t(locale, 'voucher.action.main');

  if (props.openOrderId === undefined) {
    return h(
      'a',
      {
        href: '/dashboard',
        class: 'voucher__button voucher__button--main',
        'data-testid': 'main-button',
      },
      label,
    );
  }

  return h(
    'form',
    {
      method: 'post',
      action: `/orders/${encodeURIComponent(props.openOrderId)}/cancel`,
      'data-testid': 'main-form',
    },
    h('input', { type: 'hidden', name: 'csrfToken', value: chrome.csrfToken ?? '' }),
    // Read by the server against a fixed list of destinations, never used as
    // a URL — a redirect target taken from a form field would be an open
    // redirect waiting to happen.
    h('input', { type: 'hidden', name: 'returnTo', value: 'dashboard' }),
    h(
      'button',
      {
        type: 'submit',
        class: 'voucher__button voucher__button--main',
        'data-confirm': t(locale, 'voucher.action.main_confirm'),
        'data-testid': 'main-button',
      },
      label,
    ),
  );
}

export interface VouchersScreenProps {
  readonly chrome: Chrome;
}

export function vouchersScreen(props: VouchersScreenProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'screen.vouchers'),
    h(
      'ul',
      { 'data-testid': 'voucher-category-list' },
      h(
        'li',
        {},
        h(
          'a',
          { href: '/vouchers/airtime', 'data-testid': 'category-airtime' },
          t(locale, 'voucher.product.airtime'),
        ),
      ),
      // Data is a live training flow now, not a disabled placeholder —
      // approved training-only, see Decision Log D72.
      h(
        'li',
        {},
        h(
          'a',
          { href: '/vouchers/data', 'data-testid': 'category-data' },
          t(locale, 'voucher.product.data'),
        ),
      ),
    ),
    h(
      'p',
      { class: 'voucher__actions' },
      h('a', { href: '/menu', 'data-testid': 'back-to-menu' }, t(locale, 'voucher.action.back')),
      mainButton({ chrome }),
    ),
  );
}

export interface NetworkScreenProps {
  readonly chrome: Chrome;
  readonly networks: readonly VoucherNetwork[];
  /**
   * Where a network tile leads. Defaults to the airtime branch; the data
   * branch passes its own, so one screen serves both rather than two
   * near-identical screens drifting apart.
   */
  readonly hrefFor?: (networkId: string) => string;
}

export function networkScreen(props: NetworkScreenProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  const hrefFor =
    props.hrefFor ?? ((id: string) => `/vouchers/airtime/${encodeURIComponent(id)}`);
  return page(
    chrome,
    t(locale, 'screen.provider_select'),
    h(
      'div',
      { class: 'voucher__grid', 'data-testid': 'network-list' },
      ...props.networks.map((network) =>
        h(
          'a',
          {
            href: hrefFor(network.id),
            class: 'voucher__grid-card',
            'data-testid': `network-${network.id}`,
          },
          h('span', { class: 'voucher__grid-icon', 'aria-hidden': 'true' }, '📶'),
          h('span', { class: 'voucher__grid-label' }, network.label),
        ),
      ),
    ),
    h(
      'p',
      { class: 'voucher__actions' },
      h('a', { href: '/dashboard', 'data-testid': 'back-to-vouchers' }, t(locale, 'voucher.action.back')),
      mainButton({ chrome }),
    ),
  );
}

export interface ProductTypeScreenProps {
  readonly chrome: Chrome;
  readonly network: VoucherNetwork;
}

/**
 * Airtime, or a direct top-up of a customer's phone.
 *
 * Both routes end at the same amount screen and the same PIN confirmation —
 * a top-up differs only in that it carries a phone number, which the server
 * requires for `TOPUP` and masks before storing. `Data` is still absent
 * rather than shown disabled: this screen lists what a merchant can sell.
 */
export function productTypeScreen(props: ProductTypeScreenProps): El {
  const { chrome, network } = props;
  const locale = chrome.locale;
  const tile = (productType: string, testId: string, icon: string, label: string): El =>
    h(
      'a',
      {
        href: `/vouchers/airtime/${encodeURIComponent(network.id)}/${productType}`,
        class: 'voucher__grid-card',
        'data-testid': testId,
      },
      h('span', { class: 'voucher__grid-icon', 'aria-hidden': 'true' }, icon),
      h('span', { class: 'voucher__grid-label' }, label),
    );
  return page(
    chrome,
    t(locale, 'screen.product_type'),
    h('p', { 'data-testid': 'selected-network' }, network.label),
    h(
      'div',
      { class: 'voucher__grid', 'data-testid': 'product-type-list' },
      tile('AIRTIME', 'product-type-airtime', '📱', t(locale, 'voucher.product.airtime')),
      tile('TOPUP', 'product-type-topup', '⬆️', t(locale, 'voucher.product.topup')),
    ),
    h(
      'p',
      { class: 'voucher__actions' },
      h(
        'a',
        { href: '/vouchers/airtime', 'data-testid': 'back-to-networks' },
        t(locale, 'voucher.action.back'),
      ),
      mainButton({ chrome }),
    ),
  );
}

export interface AmountScreenProps {
  readonly chrome: Chrome;
  readonly network: VoucherNetwork;
  readonly productType: string;
  readonly products: readonly VoucherProduct[];
  readonly csrfToken: string;
  /** Generated when this form is built, not when it is submitted — same rule as `newSaleScreen`. */
  readonly clientRequestId: string;
  /** Bounds for a typed amount. The server enforces them; these only hint the input. */
  readonly customLimits: {
    readonly minMinor: number;
    readonly maxMinor: number;
    readonly incrementMinor: number;
  };
  /** Bounds for the bulk-print stepper. The server enforces them too. */
  readonly quantityLimits: { readonly min: number; readonly max: number };
  readonly errorMessage?: string;
}

export function amountScreen(props: AmountScreenProps): El {
  const { chrome, network, productType } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'screen.amount_select'),
    h('p', { 'data-testid': 'selected-network' }, network.label),
    props.errorMessage !== undefined &&
      h('p', { 'data-testid': 'validation-message', role: 'alert' }, props.errorMessage),
    h(
      'form',
      { method: 'post', action: '/orders', 'data-testid': 'amount-form' },
      h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
      h('input', {
        type: 'hidden',
        name: 'clientRequestId',
        value: props.clientRequestId,
        'data-testid': 'client-request-id',
      }),
      h('input', { type: 'hidden', name: 'network', value: network.id }),
      h('input', { type: 'hidden', name: 'productType', value: productType }),
      // Only a direct top-up asks for a number, because only a direct top-up
      // has somewhere to send the airtime. A denomination voucher is handed
      // across the counter and needs none — the field is absent, not hidden,
      // so there is nothing for a tampered form to submit. The server refuses
      // a `TOPUP` without one and masks it before it reaches the database.
      productType === 'TOPUP' &&
        h(
          'div',
          { class: 'field voucher__recipient', 'data-testid': 'topup-recipient' },
          h('label', { for: 'recipient' }, t(locale, 'topup.phone.label')),
          h('input', {
            id: 'recipient',
            name: 'recipient',
            type: 'tel',
            inputmode: 'tel',
            autocomplete: 'off',
            required: true,
            'data-testid': 'recipient-input',
          }),
          h('p', { class: 'voucher__custom-hint' }, t(locale, 'topup.phone.hint')),
        ),
      // Denomination cards, not a dropdown: the reference terminal shows a
      // grid an operator taps, and a grid makes the chosen amount visible
      // rather than hidden inside a closed control.
      //
      // Every radio carries `required` and none is pre-checked, so the
      // browser refuses to submit until one is chosen — the "Continue is
      // unavailable until an amount is selected" rule, enforced natively
      // with no script. The server re-validates the combination regardless.
      // Fixed denominations first, laid out as a horizontal row of buttons,
      // then the custom entry. Every radio carries `required` and none is
      // pre-checked, so the browser refuses to submit until one is chosen —
      // enforced natively, with the server re-validating regardless.
      h(
        'fieldset',
        { class: 'voucher__amounts', 'data-testid': 'amount-cards' },
        h('legend', { class: 'voucher__amounts-legend' }, t(locale, 'sale.amount.select')),
        h(
          'div',
          { class: 'voucher__amounts-row' },
          ...props.products
            .filter((product) => product.isCustom !== true)
            .map((product) =>
              h(
                'label',
                {
                  class: 'voucher__amount-card',
                  'data-testid': `amount-card-${product.productId}`,
                  'data-amount-minor': String(product.amountMinor),
                },
                h('input', {
                  type: 'radio',
                  name: 'productId',
                  value: product.productId,
                  required: true,
                  disabled: !product.available,
                  class: 'voucher__amount-radio',
                  'data-testid': `amount-radio-${product.productId}`,
                }),
                h('span', { class: 'voucher__amount-value' }, formatAmount(product.amountMinor)),
                !product.available && h('span', { class: 'voucher__amount-note' }, '(unavailable)'),
              ),
            ),
        ),
        ...props.products
          .filter((product) => product.isCustom === true)
          .map((product) =>
            h(
              'div',
              { class: 'voucher__custom', 'data-testid': 'custom-amount' },
              h(
                'label',
                { class: 'voucher__amount-card voucher__amount-card--custom' },
                h('input', {
                  type: 'radio',
                  name: 'productId',
                  value: product.productId,
                  required: true,
                  class: 'voucher__amount-radio',
                  'data-testid': 'amount-radio-custom',
                }),
                h('span', { class: 'voucher__amount-value' }, t(locale, 'sale.amount.custom')),
              ),
              h(
                'span',
                { class: 'voucher__custom-field' },
                h('label', { for: 'customAmountBirr' }, t(locale, 'sale.amount.custom_label')),
                h('input', {
                  id: 'customAmountBirr',
                  name: 'customAmountBirr',
                  type: 'number',
                  inputmode: 'numeric',
                  min: String(props.customLimits.minMinor / 100),
                  max: String(props.customLimits.maxMinor / 100),
                  step: String(props.customLimits.incrementMinor / 100),
                  'data-testid': 'custom-amount-input',
                }),
              ),
              h(
                'p',
                { class: 'voucher__custom-hint', 'data-testid': 'custom-amount-hint' },
                `${formatAmount(props.customLimits.minMinor)} – ${formatAmount(props.customLimits.maxMinor)}`,
              ),
            ),
          ),
      ),
      // Bulk printing. A shop selling ten 25-birr vouchers presses PIN once,
      // not ten times. The +/− buttons are an enhancement over a plain number
      // input, so the field still works with scripting off; the server
      // re-validates the number against `QUANTITY_LIMITS` regardless.
      h(
        'div',
        { class: 'field voucher__quantity', 'data-testid': 'quantity-field' },
        h('label', { for: 'quantity' }, t(locale, 'voucher.quantity.label')),
        h(
          'span',
          { class: 'voucher__stepper' },
          h(
            'button',
            {
              type: 'button',
              class: 'voucher__stepper-button',
              'data-step': '-1',
              'data-step-target': 'quantity',
              'aria-label': t(locale, 'voucher.quantity.decrease'),
              'data-testid': 'quantity-decrease',
            },
            '−',
          ),
          h('input', {
            id: 'quantity',
            name: 'quantity',
            type: 'number',
            inputmode: 'numeric',
            min: String(props.quantityLimits.min),
            max: String(props.quantityLimits.max),
            step: '1',
            value: '1',
            required: true,
            class: 'voucher__stepper-input',
            'data-testid': 'quantity-input',
          }),
          h(
            'button',
            {
              type: 'button',
              class: 'voucher__stepper-button',
              'data-step': '1',
              'data-step-target': 'quantity',
              'aria-label': t(locale, 'voucher.quantity.increase'),
              'data-testid': 'quantity-increase',
            },
            '+',
          ),
        ),
      ),
      h(
        'button',
        { type: 'submit', class: 'voucher__button voucher__button--primary', 'data-testid': 'amount-continue' },
        t(locale, 'voucher.action.continue'),
      ),
    ),
    h(
      'p',
      {},
      h(
        'a',
        {
          href: `/vouchers/airtime/${encodeURIComponent(network.id)}`,
          'data-testid': 'back-to-product-type',
        },
        t(locale, 'voucher.action.back'),
      ),
      ' · ',
      h('a', { href: '/dashboard', 'data-testid': 'cancel-order' }, t(locale, 'voucher.action.cancel')),
      mainButton({ chrome }),
    ),
  );
}

/**
 * The authoritative figures for one order, as the server stored them.
 *
 * Deliberately **not** derived from the catalog. A custom-amount order's
 * catalog entry carries `amountMinor: 0` — the amount lives on the order row
 * — so a summary built from the catalog would show the operator one number
 * and charge them another. Everything here comes from `GET /orders/:id`.
 */
export interface OrderFigures {
  readonly productType: 'AIRTIME' | 'TOPUP' | 'DATA';
  /** The price of one voucher. */
  readonly amountMinor: number;
  /** How many. 1 unless bulk printing was used. */
  readonly quantity: number;
  readonly totalMinor: number;
  /** The shop's margin. Not added to what the customer pays — see D69. */
  readonly profitMinor: number;
  /** Already masked by the server. The full number is never stored or sent. */
  readonly recipientMasked: string | null;
}

export interface OrderSummaryProps {
  readonly chrome: Chrome;
  readonly network: VoucherNetwork;
  readonly order: OrderFigures;
}

/**
 * What the operator sees before they touch the PIN pad.
 *
 * Amount and profit are both shown, and shown separately: the customer pays
 * the amount, and the profit is what the shop earns on it. The reference
 * terminal keeps Balance and Profit as two running fields for exactly this
 * reason, and conflating them here would misstate both.
 */
function orderSummary(props: OrderSummaryProps): El {
  const { chrome, network, order } = props;
  const locale = chrome.locale;
  const row = (label: string, value: string, id: string): El =>
    h('tr', {}, h('th', { scope: 'row' }, label), h('td', { 'data-testid': id }, value));
  return h(
    'table',
    { 'data-testid': 'order-summary', class: 'voucher__summary-card' },
    h(
      'tbody',
      {},
      row(t(locale, 'voucher.summary.merchant'), chrome.merchantId, 'summary-merchant'),
      row(t(locale, 'screen.provider_select'), network.label, 'summary-network'),
      row(
        t(locale, 'screen.product_type'),
        t(locale, order.productType === 'TOPUP' ? 'voucher.product.topup' : 'voucher.product.airtime'),
        'summary-product-type',
      ),
      order.recipientMasked !== null &&
        row(t(locale, 'voucher.summary.recipient'), order.recipientMasked, 'summary-recipient'),
      // For a batch, "price each" and "how many" are shown separately from
      // the total — an operator confirming ten vouchers needs to see both the
      // unit price they quoted and the sum they are about to spend.
      order.quantity > 1
        ? row(t(locale, 'voucher.summary.each'), formatAmount(order.amountMinor), 'summary-amount')
        : row(t(locale, 'voucher.summary.amount'), formatAmount(order.amountMinor), 'summary-amount'),
      order.quantity > 1 &&
        row(t(locale, 'voucher.summary.quantity'), String(order.quantity), 'summary-quantity'),
      row(t(locale, 'voucher.summary.profit'), formatAmount(order.profitMinor), 'summary-profit'),
      row(t(locale, 'voucher.summary.total'), formatAmount(order.totalMinor), 'summary-total'),
    ),
  );
}

export interface OrderDetailsScreenProps {
  readonly chrome: Chrome;
  readonly network: VoucherNetwork;
  readonly order: OrderFigures;
  readonly orderId: string;
  readonly csrfToken: string;
}

/**
 * A real, server-persisted order from here on.
 *
 * PRINT is a plain link — it only navigates to the PIN screen and creates
 * nothing. CANCEL is a form: it changes real state (`pending_orders.status`),
 * so it carries CSRF like every other write. BACK is a plain link back to
 * amount selection and does **not** cancel — an abandoned order simply
 * expires on its own ten-minute clock, which is a safe outcome either way.
 */
export function orderDetailsScreen(props: OrderDetailsScreenProps): El {
  const { chrome, network, order, orderId } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'screen.order_details'),
    orderSummary({ chrome, network, order }),
    h(
      'p',
      { class: 'voucher__actions voucher__actions--stacked' },
      h(
        'a',
        {
          href: `/orders/${encodeURIComponent(orderId)}/authorize`,
          class: 'voucher__button voucher__button--print',
          'data-testid': 'print-button',
        },
        t(locale, 'voucher.action.print'),
      ),
    ),
    h(
      'div',
      { class: 'voucher__actions' },
      h(
        'form',
        { method: 'post', action: `/orders/${encodeURIComponent(orderId)}/cancel`, 'data-testid': 'cancel-order-form' },
        h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
        h(
          'button',
          { type: 'submit', class: 'voucher__button voucher__button--cancel', 'data-testid': 'cancel-order' },
          t(locale, 'voucher.action.cancel'),
        ),
      ),
      h(
        'a',
        {
          href: `/vouchers/airtime/${encodeURIComponent(network.id)}/${order.productType}`,
          class: 'voucher__button',
          'data-testid': 'back-to-amount',
        },
        t(locale, 'voucher.action.back'),
      ),
      // An order exists by now, so Main cancels it on the way out.
      mainButton({ chrome, openOrderId: orderId }),
    ),
  );
}

export interface PinAuthScreenProps {
  readonly chrome: Chrome;
  readonly network: VoucherNetwork;
  readonly order: OrderFigures;
  readonly orderId: string;
  readonly csrfToken: string;
  readonly errorMessage?: string;
}

/**
 * PIN entry.
 *
 * `pin` only ever travels in this form's POST body — never a query string,
 * never a hidden field with a default, never echoed back on a failed
 * attempt. The order id in the action path is a lookup key, not an
 * authorization claim: `postAuthorizeOrder` re-derives network, product and
 * amount from the stored row, never from anything this form carries.
 */
export function pinAuthScreen(props: PinAuthScreenProps): El {
  const { chrome, network, order, orderId } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'voucher.pin.heading'),
    // Amount and profit are on screen above the keypad, so nobody types a PIN
    // without having seen both figures first.
    orderSummary({ chrome, network, order }),
    props.errorMessage !== undefined &&
      h('p', { 'data-testid': 'pin-error', role: 'alert', 'data-tone': 'NEGATIVE' }, props.errorMessage),
    h('p', { 'data-testid': 'pin-prompt', class: 'voucher__pin-heading' }, t(locale, 'voucher.pin.heading')),
    h(
      'form',
      {
        method: 'post',
        action: `/orders/${encodeURIComponent(orderId)}/authorize`,
        'data-testid': 'pin-form',
      },
      h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'pin' }, t(locale, 'screen.pin_auth')),
        h('input', {
          id: 'pin',
          name: 'pin',
          type: 'password',
          inputmode: 'numeric',
          autocomplete: 'off',
          required: true,
          'data-testid': 'pin-input',
        }),
      ),
      h(
        'p',
        { class: 'voucher__actions' },
        h(
          'button',
          { type: 'reset', class: 'voucher__button', 'data-testid': 'pin-clear' },
          t(locale, 'voucher.pin.clear'),
        ),
        h(
          'button',
          { type: 'submit', class: 'voucher__button voucher__button--print', 'data-testid': 'pin-confirm' },
          t(locale, 'voucher.pin.confirm'),
        ),
      ),
    ),
    h(
      'div',
      { class: 'voucher__actions' },
      h(
        'form',
        { method: 'post', action: `/orders/${encodeURIComponent(orderId)}/cancel`, 'data-testid': 'cancel-order-form' },
        h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
        h(
          'button',
          { type: 'submit', class: 'voucher__button voucher__button--cancel', 'data-testid': 'cancel-order' },
          t(locale, 'voucher.action.cancel'),
        ),
      ),
      mainButton({ chrome, openOrderId: orderId }),
    ),
  );
}

/**
 * Every non-PIN authorization failure an operator can reach, mapped to a
 * translated sentence.
 *
 * A reason code is a machine token: `INSUFFICIENT_AVAILABLE_BALANCE` means
 * nothing at a shop counter. Anything not listed falls back to
 * `voucher.error.generic` rather than rendering blank or raw — an unmapped
 * code must still produce a sentence that says no voucher was issued.
 */
const FAILURE_MESSAGE_KEY: Readonly<Record<string, Parameters<typeof t>[1]>> = Object.freeze({
  INSUFFICIENT_AVAILABLE_BALANCE: 'voucher.error.insufficient_balance',
  ORDER_EXPIRED: 'voucher.error.order_expired',
  ORDER_NOT_OPEN: 'voucher.error.order_not_open',
  DUPLICATE_REQUEST: 'voucher.error.duplicate',
});

/** True for the two codes that mean "the PIN itself was the problem". */
export const isPinFailure = (reasonCode: string): boolean =>
  reasonCode === 'PIN_INVALID' || reasonCode === 'PIN_LOCKED';

export function failureMessage(locale: Locale, reasonCode: string): string {
  return t(locale, FAILURE_MESSAGE_KEY[reasonCode] ?? 'voucher.error.generic');
}

export interface VoucherFailureScreenProps {
  readonly chrome: Chrome;
  readonly network: VoucherNetwork;
  readonly order: OrderFigures;
  readonly reasonCode: string;
}

/**
 * A business-rule refusal. Deliberately **not** the PIN screen: the PIN was
 * accepted, so re-asking for it would be both wrong and confusing. Offers
 * only safe onward actions and never creates anything.
 */
export function voucherFailureScreen(props: VoucherFailureScreenProps): El {
  const { chrome, network, order } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'voucher.result.failed_title'),
    h(
      'div',
      { class: 'voucher__card voucher__card--failed', 'data-testid': 'voucher-failure' },
      h('p', { class: 'voucher__card-icon', 'aria-hidden': 'true' }, '⚠️'),
      h(
        'p',
        {
          class: 'voucher__card-headline',
          'data-testid': 'voucher-failure-message',
          role: 'alert',
          'data-tone': 'NEGATIVE',
          // The machine code stays as a data attribute for support and tests.
          // It is never rendered as visible text.
          'data-reason-code': props.reasonCode,
        },
        failureMessage(locale, props.reasonCode),
      ),
    ),
    orderSummary({ chrome, network, order }),
    h(
      'p',
      { class: 'voucher__actions' },
      h('a', { href: '/vouchers/airtime', 'data-testid': 'new-sale' }, t(locale, 'voucher.result.new_sale')),
      h('a', { href: '/vouchers', 'data-testid': 'back-to-vouchers' }, t(locale, 'voucher.action.back_to_vouchers')),
      h('a', { href: '/dashboard', 'data-testid': 'go-home' }, t(locale, 'voucher.action.home')),
      mainButton({ chrome }),
    ),
  );
}

export interface VoucherResultScreenProps {
  readonly chrome: Chrome;
  readonly network: VoucherNetwork;
  readonly order: OrderFigures;
  readonly transaction: RemoteData<TransactionViewModel>;
  /**
   * The printable receipt, when the sale reached a state that has one. Absent
   * for a result that is still pending: there is nothing honest to print yet,
   * and the order summary is shown instead.
   */
  readonly receipt?: SlipProps['receipt'];
  /**
   * Every slip the order produced. One for an ordinary sale, N for a bulk
   * print — each its own transaction with its own redemption code, so all N
   * are rendered and all N print together.
   */
  readonly receipts?: readonly SlipProps['receipt'][];
  readonly style?: SlipStyle;
  /** Play the success cue. The shop's setting; the script only obeys it. */
  readonly soundEnabled?: boolean;
}

/**
 * How the result card presents itself: the outcome, in one shape.
 *
 * ## Why this exists
 *
 * The card used to be hardcoded `voucher__card--ok` with a green ✅, whatever
 * the sale actually did. `statusBlock` inside it said "pending" in words, but
 * the tick and the colour said "sold" — and on a busy counter the tick is what
 * gets read. That is the exact failure CLAUDE.md §22 forbids by requiring text
 * **and** icon **and** colour to agree, and §15 forbids by requiring an
 * uncertain outcome to be shown as uncertain.
 *
 * It is a real loss, not a cosmetic one: an operator who reads a tick on a
 * `PENDING` airtime sale hands over the goods for a transaction that may still
 * fail, and — worse — may retry it, which is what §14 step 6 exists to prevent.
 *
 * The mapping is driven by `certainty` rather than `state`, so a state added to
 * the machine later inherits the right presentation instead of falling through
 * to a tick.
 */
const RESULT_CARD: Readonly<
  Record<TransactionViewModel['certainty'], { readonly modifier: string; readonly icon: string }>
> = Object.freeze({
  CERTAIN_SUCCESS: { modifier: 'ok', icon: '✅' },
  // Confirmed failure. A cross, not a tick, and never the success colour.
  CERTAIN_NO_SALE: { modifier: 'failed', icon: '✕' },
  // The three uncertain ones. All carry the caution mark: the honest statement
  // is "we do not know yet", and it must not resemble either outcome.
  IN_PROGRESS: { modifier: 'pending', icon: '⏳' },
  UNCERTAIN: { modifier: 'pending', icon: '⏳' },
  AWAITING_DETERMINATION: { modifier: 'pending', icon: '❓' },
});

/**
 * The loaded view, when there is one.
 *
 * `STALE` counts: it is real data that may be a moment old, and showing a
 * pending sale as pending from slightly stale data is right. `LOADING` carries
 * a `previous` for the same reason — a refresh must not blank the outcome and
 * let the card fall back to a default.
 */
function loadedTransaction(
  remote: RemoteData<TransactionViewModel>,
): TransactionViewModel | undefined {
  if (remote.status === 'READY' || remote.status === 'STALE') return remote.data;
  if (remote.status === 'LOADING') return remote.previous;
  return undefined;
}

/**
 * The real result.
 *
 * Reuses the existing transaction rendering (`statusBlock`, `fundsBlock`) —
 * the same blocks `transactionDetailScreen` uses — rather than inventing a
 * second way to describe a transaction's state. Adds only what is specific
 * to this flow: the network/product summary and the honest printer notice.
 */
export function voucherResultScreen(props: VoucherResultScreenProps): El {
  const { chrome, network, order } = props;
  const locale = chrome.locale;
  const view = loadedTransaction(props.transaction);
  // No data yet is not an outcome. Until the transaction loads, the card is
  // neutral — it must not default to the success it has not been told about.
  const card = view === undefined ? { modifier: 'loading', icon: '…' } : RESULT_CARD[view.certainty];
  // `receipts` is the batch; `receipt` remains for a single sale so existing
  // callers keep working. Both empty means the sale is still resolving and
  // there is nothing honest to print yet.
  const slips = props.receipts ?? (props.receipt !== undefined ? [props.receipt] : []);
  return page(
    chrome,
    t(locale, 'screen.voucher_result'),
    h(
      'div',
      {
        class: `voucher__card voucher__card--${card.modifier}`,
        // The test id names the outcome, so a test cannot assert "success" on
        // a screen that is showing a pending sale. It was `voucher-success`
        // unconditionally, which made exactly that assertion pass wrongly.
        'data-testid': `voucher-result-${card.modifier}`,
        'data-certainty': view?.certainty ?? 'UNKNOWN',
        // Kept so the success path's existing callers and tests still find it,
        // but now only on an actually-successful sale.
        ...(card.modifier === 'ok' ? { 'data-outcome': 'SUCCESS' } : {}),
      },
      h('p', { class: 'voucher__card-icon', 'aria-hidden': 'true' }, card.icon),
      renderRemote(props.transaction, {
        what: 'this voucher',
        emptyMessage: 'This voucher could not be found.',
        locale,
        render: (view) => h('div', {}, statusBlock(view, locale), fundsBlock(view, locale)),
      }),
    ),
    // The same slip the history screen and the reprint print. A sale and a
    // reprint of that sale must not produce two different-looking pieces of
    // paper, so there is only one function that draws one.
    ...(slips.length > 0
      ? slips.map((slip, index) =>
          slipCard({
            locale,
            subtitle:
              slips.length > 1
                ? `${t(locale, 'receipt.slip.title')} · ${t(locale, 'receipt.slip.batch_position')} ${String(index + 1)}/${String(slips.length)}`
                : t(locale, 'receipt.slip.title'),
            lines: transactionSlipLines(slip, locale),
            style: props.style ?? DEFAULT_SLIP_STYLE,
            supportContact: slip.supportContact,
          }),
        )
      : [orderSummary({ chrome, network, order })]),
    // The success cue. The attribute carries the shop's setting, so the
    // decision stays on the server with every other preference and the script
    // only obeys it.
    slips.length > 0 &&
      h('span', {
        'data-sound-cue': props.soundEnabled === false ? 'off' : 'on',
        'data-testid': 'sound-cue',
        hidden: true,
      }),
    // The lookup slip: a second, compact print carrying only the reference —
    // the one a shop keeps to find a sale again, as opposed to the one the
    // customer takes away.
    props.style?.printLookupSlip === true &&
      slips.length > 0 &&
      h(
        'div',
        { class: 'slip slip--lookup', 'data-testid': 'lookup-slip' },
        // The shop copy is still a printed Telga document, so it carries the
        // same legal name as the customer's slip. Two pieces of paper from one
        // sale must not name two different entities.
        h('p', { class: 'slip__brand', 'data-testid': 'lookup-slip-brand' }, TELGA_LEGAL_NAME),
        h('p', { class: 'slip__subtitle' }, t(locale, 'receipt.lookup_title')),
        h('hr', { class: 'slip__rule' }),
        h(
          'div',
          { class: 'slip__line' },
          h('span', { class: 'slip__label' }, t(locale, 'transactions.column.reference')),
          h(
            'span',
            { class: 'slip__value', 'data-testid': 'lookup-reference' },
            (slips[0]).transactionId,
          ),
        ),
        h(
          'div',
          { class: 'slip__line' },
          h('span', { class: 'slip__label' }, 'Date'),
          h('span', { class: 'slip__value' }, (slips[0]).issuedAt.slice(0, 10)),
        ),
        h('p', { class: 'slip__banner' }, t(locale, 'receipt.lookup_note')),
      ),
    h('p', { 'data-testid': 'no-printer-notice', class: 'voucher__notice' }, t(locale, 'voucher.result.no_printer')),
    // Reprint belongs here, on the screen an operator is looking at when the
    // paper jams or tears — not only on the history screen they would have to
    // navigate to first. A reprint is financially inert: it appends an audit
    // line and touches no ledger entry, no state and no timestamp.
    slips.length > 0 &&
      h(
        'div',
        { class: 'voucher__actions slip__actions' },
        h(
          'form',
          {
            method: 'post',
            // The first voucher of the batch. Reprinting one at a time from
            // history is the honest affordance for the rest: a reprint is
            // per-transaction, and pretending one button reprints ten would
            // record one audit line for ten pieces of paper.
            action: `/transactions/${encodeURIComponent((slips[0]).transactionId)}/reprint`,
            'data-testid': 'result-reprint-form',
          },
          h('input', { type: 'hidden', name: 'csrfToken', value: chrome.csrfToken ?? '' }),
          h(
            'button',
            {
              type: 'submit',
              class: 'voucher__button voucher__button--print',
              'data-once': 'reprint',
              'data-testid': 'result-reprint',
            },
            t(locale, 'receipt.reprint'),
          ),
        ),
        h(
          'a',
          { href: '/dashboard', class: 'voucher__button', 'data-testid': 'result-close' },
          t(locale, 'receipt.action.close'),
        ),
      ),
    h(
      'p',
      { class: 'voucher__actions' },
      h('a', { href: '/vouchers/airtime', 'data-testid': 'new-sale' }, t(locale, 'voucher.result.new_sale')),
      h('a', { href: '/vouchers', 'data-testid': 'back-to-vouchers' }, t(locale, 'voucher.action.back_to_vouchers')),
      mainButton({ chrome }),
    ),
  );
}


// --- moving profit into the selling balance -----------------------------------

export interface ProfitTransferScreenProps {
  readonly chrome: Chrome;
  readonly profitAvailableFormatted: string;
  readonly profitAvailableMinor: number;
  readonly csrfToken: string;
  readonly errorMessage?: string;
  /** Set after a successful move, so the operator sees what happened. */
  readonly done?: {
    readonly movedFormatted: string;
    readonly remainingFormatted: string;
    readonly newBalanceFormatted: string;
  };
}

/**
 * Type an amount, press OK, and the money changes bucket.
 *
 * The figure shown is **profit not yet moved** — all-time earned minus
 * all-time moved — not today's profit, which is what the dashboard pill
 * shows. They differ the moment a shop earns on Monday and moves on Tuesday,
 * and showing today's figure here would offer an owner a number they cannot
 * actually take.
 *
 * The `max` on the input is a courtesy, not the rule. `transferProfit`
 * re-reads the profit and re-checks the amount inside the same database
 * transaction that posts it, so a tampered form or two simultaneous presses
 * still cannot move more than was earned.
 */
export function profitTransferScreen(props: ProfitTransferScreenProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  const nothingToMove = props.profitAvailableMinor <= 0;

  return page(
    chrome,
    t(locale, 'screen.profit_transfer'),
    h(
      'table',
      { class: 'voucher__summary-card', 'data-testid': 'profit-summary' },
      h(
        'tbody',
        {},
        h(
          'tr',
          {},
          h('th', { scope: 'row' }, t(locale, 'profit.transfer.available')),
          h('td', { 'data-testid': 'profit-available' }, props.profitAvailableFormatted),
        ),
      ),
    ),
    props.done !== undefined &&
      h(
        'div',
        { class: 'voucher__summary-card', role: 'status', 'data-testid': 'profit-transfer-done' },
        h('p', { class: 'voucher__notice' }, t(locale, 'profit.transfer.done')),
        h(
          'p',
          {},
          `${t(locale, 'profit.transfer.remaining')}: `,
          h('strong', { 'data-testid': 'profit-remaining' }, props.done.remainingFormatted),
        ),
        h(
          'p',
          {},
          `${t(locale, 'profit.transfer.new_balance')}: `,
          h('strong', { 'data-testid': 'profit-new-balance' }, props.done.newBalanceFormatted),
        ),
      ),
    props.errorMessage !== undefined &&
      h(
        'p',
        { 'data-testid': 'profit-transfer-error', role: 'alert', 'data-tone': 'NEGATIVE' },
        props.errorMessage,
      ),
    nothingToMove
      ? h('p', { 'data-testid': 'profit-none', class: 'voucher__notice' }, t(locale, 'profit.transfer.none'))
      : h(
          'form',
          { method: 'post', action: '/profit/transfer', 'data-testid': 'profit-transfer-form' },
          h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
          h(
            'div',
            { class: 'field' },
            h('label', { for: 'amountBirr' }, t(locale, 'profit.transfer.amount_label')),
            h('input', {
              id: 'amountBirr',
              name: 'amountBirr',
              type: 'number',
              inputmode: 'numeric',
              min: '1',
              step: '1',
              // A hint for the keypad, not the rule — the server re-checks.
              max: String(Math.floor(props.profitAvailableMinor / 100)),
              required: true,
              'data-testid': 'profit-amount-input',
            }),
          ),
          h(
            'button',
            {
              type: 'submit',
              class: 'voucher__button voucher__button--primary',
              'data-once': 'profit-transfer',
              'data-testid': 'profit-transfer-confirm',
            },
            t(locale, 'profit.transfer.confirm'),
          ),
        ),
    h(
      'p',
      { class: 'voucher__actions' },
      h('a', { href: '/dashboard', 'data-testid': 'go-home' }, t(locale, 'voucher.action.home')),
      mainButton({ chrome }),
    ),
  );
}

// --- data bundles -------------------------------------------------------------
//
// Approved as a **training-only** flow (Decision Log D72), which changes what
// CLAUDE.md §7 previously listed as disabled. Nothing here reaches a provider:
// the bundles are clearly-simulated training values, and the volumes,
// validities and prices are **not** researched market rates.

export interface DataCategory {
  readonly id: string;
  readonly label: string;
}

export interface DataCategoryScreenProps {
  readonly chrome: Chrome;
  readonly network: VoucherNetwork;
  readonly categories: readonly DataCategory[];
}

/** Which kind of bundle — the screen between choosing a network and a package. */
export function dataCategoryScreen(props: DataCategoryScreenProps): El {
  const { chrome, network } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'data.category.select'),
    h('p', { 'data-testid': 'selected-network' }, network.label),
    h(
      'div',
      { class: 'voucher__grid', 'data-testid': 'data-category-list' },
      ...props.categories.map((category) =>
        h(
          'a',
          {
            href: `/vouchers/data/${encodeURIComponent(network.id)}/${encodeURIComponent(category.id)}`,
            class: 'voucher__grid-card',
            'data-testid': `data-category-${category.id}`,
          },
          h('span', { class: 'voucher__grid-icon', 'aria-hidden': 'true' }, '📶'),
          h('span', { class: 'voucher__grid-label' }, category.label),
        ),
      ),
    ),
    h(
      'p',
      { class: 'voucher__actions' },
      h('a', { href: '/vouchers/data', 'data-testid': 'back-to-networks' }, t(locale, 'voucher.action.back')),
      mainButton({ chrome }),
    ),
  );
}

export interface DataPackageScreenProps {
  readonly chrome: Chrome;
  readonly network: VoucherNetwork;
  readonly category: DataCategory;
  readonly products: readonly VoucherProduct[];
  readonly csrfToken: string;
  readonly clientRequestId: string;
  readonly errorMessage?: string;
}

/**
 * Volume, validity, price — and the phone number it is sent to.
 *
 * One form, not two screens: a data bundle always goes to a phone, so asking
 * for the number on a separate screen would add a step without adding a
 * decision. The server requires the number for `DATA` regardless of what this
 * form sends, and masks it before it reaches the database.
 */
export function dataPackageScreen(props: DataPackageScreenProps): El {
  const { chrome, network, category } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'data.package.select'),
    h('p', { 'data-testid': 'selected-network' }, `${network.label} — ${category.label}`),
    props.errorMessage !== undefined &&
      h('p', { 'data-testid': 'validation-message', role: 'alert' }, props.errorMessage),
    h(
      'form',
      { method: 'post', action: '/orders', 'data-testid': 'data-package-form' },
      h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
      h('input', {
        type: 'hidden',
        name: 'clientRequestId',
        value: props.clientRequestId,
        'data-testid': 'client-request-id',
      }),
      h('input', { type: 'hidden', name: 'network', value: network.id }),
      h('input', { type: 'hidden', name: 'productType', value: 'DATA' }),
      h(
        'fieldset',
        { class: 'voucher__amounts', 'data-testid': 'data-package-list' },
        h('legend', { class: 'voucher__amounts-legend' }, t(locale, 'data.package.select')),
        h(
          'div',
          { class: 'voucher__amounts-row voucher__amounts-row--wrap' },
          ...props.products.map((product) =>
            h(
              'label',
              {
                class: 'voucher__amount-card voucher__amount-card--data',
                'data-testid': `data-package-${product.productId}`,
                'data-amount-minor': String(product.amountMinor),
              },
              h('input', {
                type: 'radio',
                name: 'productId',
                value: product.productId,
                required: true,
                disabled: !product.available,
                class: 'voucher__amount-radio',
                'data-testid': `data-package-radio-${product.productId}`,
              }),
              h('span', { class: 'voucher__amount-value' }, product.volumeLabel ?? ''),
              h(
                'span',
                { class: 'voucher__amount-note' },
                `${t(locale, 'data.column.validity')}: ${product.validityLabel ?? ''}`,
              ),
              h('span', { class: 'voucher__amount-price' }, formatAmount(product.amountMinor)),
            ),
          ),
        ),
      ),
      h(
        'div',
        { class: 'field voucher__recipient', 'data-testid': 'data-recipient' },
        h('label', { for: 'recipient' }, t(locale, 'data.phone.label')),
        h('input', {
          id: 'recipient',
          name: 'recipient',
          type: 'tel',
          inputmode: 'tel',
          autocomplete: 'off',
          required: true,
          'data-testid': 'recipient-input',
        }),
        h('p', { class: 'voucher__custom-hint' }, t(locale, 'topup.phone.hint')),
      ),
      h(
        'button',
        { type: 'submit', class: 'voucher__button voucher__button--primary', 'data-testid': 'data-continue' },
        t(locale, 'voucher.action.continue'),
      ),
    ),
    h(
      'p',
      { class: 'voucher__actions' },
      h(
        'a',
        {
          href: `/vouchers/data/${encodeURIComponent(network.id)}`,
          'data-testid': 'back-to-categories',
        },
        t(locale, 'voucher.action.back'),
      ),
      mainButton({ chrome }),
    ),
  );
}

// --- settings ----------------------------------------------------------------

export interface SettingsView {
  readonly slipSize: '58' | '80';
  readonly slipAdvert: string;
  readonly profitPercent: number;
  /**
   * The shop's own identity, printed on every slip (migration 011).
   * Empty strings mean "not filled in", and those lines simply do not print.
   */
  readonly businessName: string;
  readonly businessAddress: string;
  readonly businessPhone: string;
  readonly businessTin: string;
  readonly businessLicence: string;
  readonly slipFooter: string;
  /**
   * In-app preferences and local policy (migration 012). Every one has a safe
   * default, so a shop that never opens Settings behaves as it always has.
   */
  readonly soundEnabled: boolean;
  readonly hideBalance: boolean;
  readonly lowBalanceAlert: boolean;
  readonly statementsAdminOnly: boolean;
  readonly printBarcode: boolean;
  readonly printLookupSlip: boolean;
  readonly screenLockEnabled: boolean;
  /** Seconds of inactivity before the screen locks. */
  readonly lockSeconds: number;
}

/** The keys `toggle()` may render — the boolean half of the view. */
export type SettingsToggleKey =
  | 'soundEnabled'
  | 'hideBalance'
  | 'lowBalanceAlert'
  | 'statementsAdminOnly'
  | 'printBarcode'
  | 'printLookupSlip'
  | 'screenLockEnabled';

/** The corporate fields, paired with their labels and form names. */
export const BUSINESS_FIELDS = Object.freeze([
  ['businessName', 'businessName', 'settings.business.name'],
  ['businessAddress', 'businessAddress', 'settings.business.address'],
  ['businessPhone', 'businessPhone', 'settings.business.phone'],
  ['businessTin', 'businessTin', 'settings.business.tin'],
  ['businessLicence', 'businessLicence', 'settings.business.licence'],
  ['slipFooter', 'slipFooter', 'settings.business.footer'],
] as const);

export interface SettingsScreenProps {
  readonly chrome: Chrome;
  readonly settings: SettingsView;
  readonly csrfToken: string;
  readonly savedMessage?: string;
  readonly errorMessage?: string;
  /** The outcome of a PIN change, shown beside its own form. */
  readonly pinMessage?: string;
  readonly pinChanged?: boolean;
}

/**
 * Slip and training settings.
 *
 * Owner-only, and refused server-side by `POS_MANAGE_SETTINGS` rather than by
 * this screen being hard to reach — an operator who types the URL gets the
 * same refusal as one who finds a link.
 *
 * The profit percentage is labelled as a training figure in the form itself,
 * not only in a note somewhere: a number an owner types into a box marked
 * "profit" is exactly the number they will later quote, so the screen has to
 * say plainly that it is not a negotiated commission rate.
 */
export function settingsScreen(props: SettingsScreenProps): El {
  const { chrome, settings } = props;
  const locale = chrome.locale;

  /**
   * One on/off preference.
   *
   * A plain checkbox with a hidden `off` companion, so an unchecked box
   * still submits a value — otherwise turning something off would send
   * nothing and the server would read it as "leave unchanged".
   */
  const toggle = (name: SettingsToggleKey, labelKey: Parameters<typeof t>[1]): El =>
    h(
      'div',
      { class: 'settings__toggle' },
      h('input', { type: 'hidden', name, value: 'off' }),
      h('input', {
        type: 'checkbox',
        id: name,
        name,
        value: 'on',
        checked: settings[name] === true,
        'data-testid': `settings-${name}`,
      }),
      h('label', { for: name }, t(locale, labelKey)),
    );
  const sizeOption = (value: '58' | '80', labelKey: 'settings.slip_size.58' | 'settings.slip_size.80'): El =>
    h(
      'label',
      { class: 'voucher__amount-card', 'data-testid': `slip-size-${value}` },
      h('input', {
        type: 'radio',
        name: 'slipSize',
        value,
        checked: settings.slipSize === value,
        class: 'voucher__amount-radio',
        'data-testid': `slip-size-radio-${value}`,
      }),
      h('span', { class: 'voucher__amount-value' }, t(locale, labelKey)),
    );

  return page(
    chrome,
    t(locale, 'settings.heading'),
    props.savedMessage !== undefined &&
      h('p', { 'data-testid': 'settings-saved', role: 'status', 'data-tone': 'POSITIVE' }, props.savedMessage),
    props.errorMessage !== undefined &&
      h('p', { 'data-testid': 'settings-error', role: 'alert', 'data-tone': 'NEGATIVE' }, props.errorMessage),
    h(
      'form',
      { method: 'post', action: '/settings', 'data-testid': 'settings-form' },
      h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
      h(
        'fieldset',
        { class: 'voucher__amounts' },
        h('legend', { class: 'voucher__amounts-legend' }, t(locale, 'settings.slip_size.label')),
        h(
          'div',
          { class: 'voucher__amounts-row' },
          sizeOption('58', 'settings.slip_size.58'),
          sizeOption('80', 'settings.slip_size.80'),
        ),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'slipAdvert' }, t(locale, 'settings.advert.label')),
        h('input', {
          id: 'slipAdvert',
          name: 'slipAdvert',
          type: 'text',
          maxlength: '120',
          value: settings.slipAdvert,
          'data-testid': 'slip-advert-input',
        }),
        h('p', { class: 'voucher__custom-hint' }, t(locale, 'settings.advert.hint')),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'profitPercent' }, t(locale, 'settings.profit.label')),
        h('input', {
          id: 'profitPercent',
          name: 'profitPercent',
          type: 'number',
          inputmode: 'decimal',
          min: '0',
          max: '100',
          step: '0.01',
          value: String(settings.profitPercent),
          'data-testid': 'profit-percent-input',
        }),
        h(
          'p',
          { class: 'voucher__custom-hint', 'data-testid': 'profit-training-note' },
          t(locale, 'settings.profit.hint'),
        ),
      ),
      h(
        'button',
        { type: 'submit', class: 'voucher__button voucher__button--primary', 'data-testid': 'settings-save' },
        t(locale, 'settings.save'),
      ),
    ),

    // --- business details, printed on every slip --------------------------
    //
    // Part of the same form above, so one Save writes them all — an owner
    // filling in their shop details should not have to find a second button.
    // Telga verifies none of these; the note says so on the screen, not only
    // in a comment, because a box marked "TIN" invites the assumption that
    // somebody checked it.
    h('h2', { class: 'settings__section' }, t(locale, 'settings.business.heading')),
    h('p', { class: 'voucher__custom-hint' }, t(locale, 'settings.business.hint')),
    h(
      'form',
      { method: 'post', action: '/settings/business', 'data-testid': 'settings-business-form' },
      h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
      ...BUSINESS_FIELDS.map(([key, name, labelKey]) =>
        h(
          'div',
          { class: 'field' },
          h('label', { for: name }, t(locale, labelKey)),
          h('input', {
            id: name,
            name,
            type: 'text',
            maxlength: '120',
            value: settings[key],
            'data-testid': `settings-${name}`,
          }),
        ),
      ),
      h(
        'button',
        {
          type: 'submit',
          class: 'voucher__button voucher__button--primary',
          'data-testid': 'settings-business-save',
        },
        t(locale, 'settings.save'),
      ),
    ),

    // --- changing the transaction PIN -------------------------------------
    //
    // Its own form, deliberately: it is the one control here that changes a
    // credential rather than a presentation value, so it submits on its own
    // and cannot be carried along by a Save the owner pressed for something
    // else. The current PIN is required — an open session is not enough.
    h('h2', { class: 'settings__section' }, t(locale, 'settings.pin.heading')),
    props.pinMessage !== undefined &&
      h(
        'p',
        {
          'data-testid': 'settings-pin-message',
          role: props.pinChanged === true ? 'status' : 'alert',
          'data-tone': props.pinChanged === true ? 'POSITIVE' : 'NEGATIVE',
        },
        props.pinMessage,
      ),
    h(
      'form',
      { method: 'post', action: '/settings/pin', 'data-testid': 'settings-pin-form' },
      h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
      ...(
        [
          ['currentPin', 'settings.pin.current'],
          ['newPin', 'settings.pin.new'],
          ['confirmPin', 'settings.pin.confirm'],
        ] as const
      ).map(([name, labelKey]) =>
        h(
          'div',
          { class: 'field' },
          h('label', { for: name }, t(locale, labelKey)),
          h('input', {
            id: name,
            name,
            type: 'password',
            inputmode: 'numeric',
            autocomplete: 'off',
            required: true,
            minlength: '6',
            maxlength: '6',
            'data-testid': `settings-${name}`,
          }),
        ),
      ),
      h(
        'button',
        {
          type: 'submit',
          class: 'voucher__button voucher__button--primary',
          'data-testid': 'settings-pin-save',
        },
        t(locale, 'settings.pin.save'),
      ),
    ),

    // --- shift ------------------------------------------------------------
    //
    // A shift is a labelled span of time, so what is configurable about it is
    // when it ends, not what it holds. Ending one is an action, not a
    // setting, so it links out to the screen that does it rather than being
    // duplicated here — the same control in two places is the duplication the
    // founder asked to avoid.
    h('h2', { class: 'settings__section' }, t(locale, 'settings.section.shift')),
    h('p', { class: 'voucher__custom-hint' }, t(locale, 'settings.shift.hint')),
    h(
      'div',
      { class: 'topup__options', 'data-testid': 'settings-shift' },
      h(
        'a',
        { href: '/shift/end', class: 'topup__option', 'data-testid': 'settings-end-shift' },
        h('span', { class: 'topup__label' }, t(locale, 'menu.end_shift')),
      ),
      h(
        'a',
        { href: '/transactions', class: 'topup__option', 'data-testid': 'settings-shift-statement' },
        h('span', { class: 'topup__label' }, t(locale, 'settings.shift.statement')),
      ),
    ),

    // --- account ----------------------------------------------------------
    //
    // Only what this build actually has. There is deliberately no "change
    // password": Telga has no password — sign-in is operator id, PIN and
    // device key — and a control that changes nothing is worse than its
    // absence. Changing the PIN is below, under Security, where it belongs.
    h('h2', { class: 'settings__section' }, t(locale, 'settings.section.account')),
    h(
      'table',
      { class: 'voucher__summary-card', 'data-testid': 'settings-account' },
      h(
        'tbody',
        {},
        h(
          'tr',
          {},
          h('th', { scope: 'row' }, t(locale, 'settings.account.operator')),
          h('td', { 'data-testid': 'account-operator' }, chrome.operatorId ?? chrome.merchantId),
        ),
        h(
          'tr',
          {},
          h('th', { scope: 'row' }, t(locale, 'settings.account.device')),
          h('td', { 'data-testid': 'account-device' }, chrome.deviceId ?? '—'),
        ),
        h(
          'tr',
          {},
          h('th', { scope: 'row' }, t(locale, 'settings.account.merchant')),
          h('td', { 'data-testid': 'account-merchant' }, chrome.merchantId),
        ),
      ),
    ),
    h('p', { class: 'voucher__custom-hint' }, t(locale, 'settings.account.hint')),

    // --- in-app preferences and admin-only options ------------------------
    //
    // One form, one Save. Each toggle is a plain checkbox: with scripting off
    // it still submits, and the server stores the value — nothing here
    // depends on a script running on a counter machine.
    //
    // The admin-only group is grouped by *label*, not enforced by this
    // screen: `POS_MANAGE_SETTINGS` already refuses an operator server-side,
    // which is what actually keeps an assistant out.
    h('h2', { class: 'settings__section' }, t(locale, 'settings.section.app')),
    h(
      'form',
      { method: 'post', action: '/settings/preferences', 'data-testid': 'settings-preferences-form' },
      h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
      ...(
        [
          ['soundEnabled', 'settings.toggle.sound'],
          ['hideBalance', 'settings.toggle.hide_balance'],
          ['lowBalanceAlert', 'settings.toggle.low_balance'],
        ] as const
      ).map(([name, labelKey]) => toggle(name, labelKey)),

      h('h2', { class: 'settings__section' }, t(locale, 'settings.section.admin')),
      ...(
        [
          ['statementsAdminOnly', 'settings.toggle.statements_admin'],
          ['printBarcode', 'settings.toggle.print_barcode'],
          ['printLookupSlip', 'settings.toggle.print_lookup'],
          ['screenLockEnabled', 'settings.toggle.pin_lock'],
        ] as const
      ).map(([name, labelKey]) => toggle(name, labelKey)),

      h('h2', { class: 'settings__section' }, t(locale, 'settings.section.security')),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'lockSeconds' }, t(locale, 'settings.lock_seconds')),
        h('input', {
          id: 'lockSeconds',
          name: 'lockSeconds',
          type: 'number',
          inputmode: 'numeric',
          min: '15',
          max: '3600',
          step: '5',
          value: String(settings.lockSeconds),
          'data-testid': 'settings-lock-seconds',
        }),
      ),
      h(
        'button',
        {
          type: 'submit',
          class: 'voucher__button voucher__button--primary',
          'data-testid': 'settings-preferences-save',
        },
        t(locale, 'settings.save'),
      ),
    ),

    // --- about and policies ------------------------------------------------
    h('h2', { class: 'settings__section' }, t(locale, 'settings.section.about')),
    h(
      'ul',
      { class: 'settings__links', 'data-testid': 'settings-policies' },
      ...(
        [
          ['/policy/about', 'settings.about.telga', 'about'],
          ['/policy/terms', 'settings.about.terms', 'terms'],
          ['/policy/privacy', 'settings.about.privacy', 'privacy'],
          ['/policy/cookies', 'settings.about.cookies', 'cookies'],
        ] as const
      ).map(([href, labelKey, id]) =>
        h('li', {}, h('a', { href, 'data-testid': `settings-policy-${id}` }, t(locale, labelKey))),
      ),
    ),

    // The full sign-out: device, device key, operator and PIN. Deliberately
    // here rather than on the counter screens — an idle timeout should cost
    // an operator a PIN, and the one action that costs them everything should
    // take a decision to reach. It asks before it acts.
    h(
      'form',
      { method: 'post', action: '/logout', 'data-testid': 'settings-signout-form' },
      h('input', { type: 'hidden', name: 'csrfToken', value: props.csrfToken }),
      h(
        'button',
        {
          type: 'submit',
          class: 'voucher__button voucher__button--cancel',
          'data-confirm': t(locale, 'settings.signout.confirm'),
          'data-testid': 'settings-signout',
        },
        t(locale, 'settings.signout'),
      ),
    ),
    h('p', { class: 'voucher__custom-hint' }, t(locale, 'settings.signout.hint')),
    h('p', {}, h('a', { href: '/dashboard', 'data-testid': 'go-home' }, t(locale, 'voucher.action.home'))),
  );
}

/** Serialise any screen as a full HTML document. */
export { type Node as ScreenNode };

// --- statements -----------------------------------------------------------

export interface StatementDay {
  readonly day: string;
  readonly sales: number;
  readonly grossFormatted: string;
  readonly profitFormatted: string;
  readonly reversals: number;
}

export interface StatementProps {
  readonly chrome: Chrome;
  readonly days: readonly StatementDay[];
  readonly range?: { readonly from: string; readonly to: string };
  readonly totalGrossFormatted: string;
  readonly totalProfitFormatted: string;
  readonly totalSales: number;
}

/**
 * The shop's statement: one row per calendar day.
 *
 * ## Why per day, and not one total
 *
 * A statement exists to be reconciled against something — a till, a float, a
 * day's takings. A single aggregate figure reconciles against nothing, and
 * "different days must be different" is the whole requirement. So the day is
 * the row, and the total is the sum of the rows shown rather than a separately
 * computed number that could disagree with them.
 *
 * ## What the profit column is
 *
 * Earnings, not net-of-collections. Moving profit into the selling balance is
 * an `ADJUSTMENT` — a movement between the shop's own buckets — and it is
 * excluded, or a day on which an owner collected would report a loss. A
 * `REVERSAL` **is** counted, because a reversed sale really is un-earned. That
 * distinction is `profitForDay`'s, not this screen's; the screen only shows it.
 */
export function statementScreen(props: StatementProps): El {
  const { chrome } = props;
  const locale = chrome.locale;
  return page(
    chrome,
    t(locale, 'statements.title'),
    h(
      'form',
      { method: 'get', action: '/statements', class: 'history__filter', 'data-testid': 'statement-filter' },
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'from' }, t(locale, 'statements.from')),
        h('input', { id: 'from', name: 'from', type: 'date', value: props.range?.from ?? '', 'data-testid': 'statement-from' }),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'to' }, t(locale, 'statements.to')),
        h('input', { id: 'to', name: 'to', type: 'date', value: props.range?.to ?? '', 'data-testid': 'statement-to' }),
      ),
      h(
        'p',
        { class: 'voucher__actions' },
        h('button', { type: 'submit', class: 'voucher__button', 'data-testid': 'statement-apply' }, t(locale, 'statements.apply')),
        h('a', { href: '/statements', class: 'voucher__button', 'data-testid': 'statement-clear' }, t(locale, 'statements.clear')),
      ),
    ),
    props.days.length === 0
      ? h('p', { 'data-testid': 'statement-empty' }, t(locale, 'transactions.empty'))
      : h(
          'table',
          { class: 'history__table', 'data-testid': 'statement-table' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', { scope: 'col' }, t(locale, 'transactions.column.datetime')),
              h('th', { scope: 'col' }, t(locale, 'statements.sales')),
              h('th', { scope: 'col' }, t(locale, 'statements.gross')),
              h('th', { scope: 'col' }, t(locale, 'statements.profit')),
              h('th', { scope: 'col' }, t(locale, 'statements.reversals')),
            ),
          ),
          h(
            'tbody',
            {},
            ...props.days.map((d) =>
              h(
                'tr',
                { 'data-testid': `statement-day-${d.day}` },
                // The day links to that day's transactions, so a figure that
                // looks wrong can be opened rather than argued about.
                h(
                  'td',
                  {},
                  h(
                    'a',
                    { href: `/transactions?from=${d.day}&to=${d.day}`, 'data-testid': `statement-open-${d.day}` },
                    d.day,
                  ),
                ),
                h('td', {}, String(d.sales)),
                h('td', {}, d.grossFormatted),
                h('td', { 'data-testid': `statement-profit-${d.day}` }, d.profitFormatted),
                h('td', {}, String(d.reversals)),
              ),
            ),
          ),
          h(
            'tfoot',
            {},
            h(
              'tr',
              { 'data-testid': 'statement-total' },
              h('th', { scope: 'row' }, t(locale, 'statements.total')),
              h('td', { 'data-testid': 'statement-total-sales' }, String(props.totalSales)),
              h('td', { 'data-testid': 'statement-total-gross' }, props.totalGrossFormatted),
              h('td', { 'data-testid': 'statement-total-profit' }, props.totalProfitFormatted),
              h('td', {}, ''),
            ),
          ),
        ),
    h('p', { class: 'voucher__custom-hint', 'data-testid': 'statement-note' }, t(locale, 'statements.note')),
    h(
      'p',
      { class: 'voucher__actions' },
      h('a', { href: '/transactions', class: 'voucher__button', 'data-testid': 'statement-back' }, t(locale, 'voucher.action.back')),
      mainButton({ chrome }),
    ),
  );
}
