/**
 * An uncertain sale is never dressed as a completed one.
 *
 * `04 UX UI/Screen Inventory` lists Processing (7) and Pending (8) as their own
 * screens, with *"No retry control exists"* and *"Explicit block on retry"*.
 * They are built as one screen driven by [[State To UI Mapping]] — the state
 * presentation in `pos-view-model` — and that part was right.
 *
 * What was wrong was the frame around it. `voucherResultScreen` rendered
 * `voucher__card--ok` and a green ✅ for **every** outcome, so a `PENDING`
 * airtime sale arrived at the counter under a tick. The words underneath said
 * "the result is not known yet"; the tick is what gets read.
 *
 * That is a real loss and not a cosmetic one. An operator who reads a tick on a
 * pending sale hands over the goods for a transaction that may still fail, and
 * may retry it — the thing CLAUDE.md §15 exists to prevent. These tests assert
 * the three signals agree: icon, colour hook, and words.
 */

import { describe, expect, it } from 'vitest';
import { renderToHtml } from '@telga/merchant-pos';
import { voucherResultScreen } from '@telga/merchant-pos';
import { STATE_PRESENTATION, toTransactionViewModel } from '@telga/pos-view-model';
import type { TransactionDto, TransactionViewModel } from '@telga/pos-view-model';
import type { TransactionState } from '@telga/domain';
const uiChrome = () => ({
  locale: 'en' as const,
  environment: 'test',
  merchantId: 'mer_test',
  mode: 'TRAINING',
  serverTime: '2026-08-29T10:00:00.000Z',
});

const money = (amountMinor: number) => ({
  amountMinor,
  currency: 'ETB',
  formatted: `ETB ${(amountMinor / 100).toFixed(2)}`,
});

/** A transaction in whatever state the test needs, and nothing else varying. */
function viewIn(state: TransactionState): TransactionViewModel {
  const dto: TransactionDto = {
    transactionId: 'txn_test_0001',
    merchantId: 'mer_test',
    deviceId: 'dev_test',
    state,
    productType: 'AIRTIME',
    amount: money(5000),
    recipientMasked: '09** *** 123',
    providerReference: null,
    idempotencyKey: 'idem_test_0001',
    correlationId: 'corr_test',
    createdAt: '2026-08-29T10:00:00.000Z',
    updatedAt: '2026-08-29T10:00:00.000Z',
    mode: 'TRAINING',
    simulated: true,
    recovery: {
      pendingStatus: null,
      attempts: 0,
      maxAttempts: null,
      firstPendingAt: null,
      lastAttemptAt: null,
      nextCheckAt: null,
      deadlineAt: null,
    } as TransactionDto['recovery'],
    support: null,
    reservation: null,
  };
  return toTransactionViewModel(dto, 'en');
}

const NETWORK = { id: 'NETWORK_A', label: 'Network A' };

const ORDER = {
  productType: 'AIRTIME' as const,
  amountMinor: 5000,
  quantity: 1,
  totalMinor: 5000,
  profitMinor: 0,
  recipientMasked: '09** *** 123',
};

function render(state: TransactionState): string {
  return renderToHtml(
    voucherResultScreen({
      chrome: uiChrome(),
      network: NETWORK,
      order: ORDER,
      transaction: { status: 'READY', data: viewIn(state), loadedAt: '2026-08-29T10:00:00.000Z' },
    }),
  );
}

/** Every state whose outcome is not yet known. */
const UNCERTAIN: readonly TransactionState[] = [
  'CREATED',
  'VALIDATED',
  'RESERVED',
  'SUBMITTED',
  'PROCESSING',
  'PENDING',
  'UNDER_REVIEW',
  'REVERSAL_REQUIRED',
];

describe('a sale whose outcome is not known', () => {
  it('never shows the success tick', () => {
    for (const state of UNCERTAIN) {
      const html = render(state);
      expect(html, `${state} must not carry a tick`).not.toContain('✅');
    }
  });

  it('never uses the success card', () => {
    for (const state of UNCERTAIN) {
      const html = render(state);
      expect(html, `${state} must not use the success card`).not.toContain(
        'data-testid="voucher-result-ok"',
      );
      expect(html, `${state} must not claim a successful outcome`).not.toContain(
        'data-outcome="SUCCESS"',
      );
    }
  });

  it('marks itself as uncertain in a way a stylesheet cannot override', () => {
    for (const state of UNCERTAIN) {
      const html = render(state);
      // The certainty is on the element, so the reason is inspectable rather
      // than inferred from a colour.
      const certainty = STATE_PRESENTATION[state].certainty;
      expect(html, `${state}`).toContain(`data-certainty="${certainty}"`);
      expect(certainty).not.toBe('CERTAIN_SUCCESS');
    }
  });

  it('says in words that the result is not known', () => {
    for (const state of UNCERTAIN) {
      expect(render(state), `${state}`).toContain('result is not known yet');
    }
  });

  it('tells the operator not to retry, before anything else', () => {
    // §15's one line that must not be missed on a busy counter. It is rendered
    // with `role="alert"` and above the status detail.
    for (const state of UNCERTAIN) {
      const html = render(state);
      expect(html, `${state}`).toContain('data-testid="do-not-retry"');
      const alertAt = html.indexOf('data-testid="do-not-retry"');
      const detailAt = html.indexOf('data-testid="status-explanation"');
      expect(alertAt, `${state}: the instruction must come first`).toBeLessThan(detailAt);
    }
  });

  it('offers no receipt, because there is nothing honest to print', () => {
    for (const state of UNCERTAIN) {
      expect(STATE_PRESENTATION[state].receiptAvailable, `${state}`).toBe(false);
    }
  });
});

describe('a confirmed outcome', () => {
  it('shows the tick only when the provider confirmed delivery', () => {
    const html = render('SUCCESSFUL');
    expect(html).toContain('✅');
    expect(html).toContain('data-testid="voucher-result-ok"');
    expect(html).toContain('data-certainty="CERTAIN_SUCCESS"');
    expect(html).toContain('data-outcome="SUCCESS"');
  });

  it('shows a confirmed failure as a failure, not as a pending one', () => {
    // A confirmed failure is certain. Presenting it as uncertain would leave an
    // operator waiting for an answer that has already arrived.
    const html = render('FAILED');
    expect(html).toContain('data-testid="voucher-result-failed"');
    expect(html).not.toContain('✅');
    expect(html).not.toContain('data-testid="do-not-retry"');
  });

  it('distinguishes the three cards from one another', () => {
    const ok = render('SUCCESSFUL');
    const pending = render('PENDING');
    const failed = render('FAILED');
    const modifier = (html: string): string =>
      /voucher__card voucher__card--(\w+)"/.exec(html)?.[1] ?? '';
    expect(new Set([modifier(ok), modifier(pending), modifier(failed)]).size).toBe(3);
  });
});

describe('before the transaction has loaded', () => {
  it('shows no outcome at all rather than defaulting to success', () => {
    // The old code's default was the success card. A screen that has been told
    // nothing must say nothing.
    const html = renderToHtml(
      voucherResultScreen({
        chrome: uiChrome(),
        network: NETWORK,
        order: ORDER,
        transaction: { status: 'LOADING' },
      }),
    );
    expect(html).not.toContain('✅');
    expect(html).not.toContain('data-testid="voucher-result-ok"');
    expect(html).toContain('data-certainty="UNKNOWN"');
  });
});
