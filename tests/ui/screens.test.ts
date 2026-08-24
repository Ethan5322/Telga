/**
 * Screen rendering.
 *
 * The screens are pure functions returning an element tree, so these tests
 * query the tree the way a person queries a page — by role, by accessible name,
 * by test id — with no DOM emulator and no timers.
 *
 * What is being defended here is not layout. It is that a screen cannot say a
 * sale succeeded when the provider has not said so, cannot offer a receipt for
 * an unresolved transaction, and cannot render at all without the training
 * banner.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { TRANSACTION_STATES } from '@telga/domain';
import type { TransactionState } from '@telga/domain';
import { toTransactionViewModel } from '@telga/pos-view-model';
import type { RemoteData, TransactionDto, TransactionViewModel } from '@telga/pos-view-model';
import {
  accessibleName,
  allByTestId,
  byRole,
  byTestId,
  find,
  findAll,
  focusOrder,
  contentSecurityPolicy,
  homeScreen,
  htmlDocument,
  newSaleScreen,
  queueScreen,
  renderToHtml,
  textOf,
  transactionDetailScreen,
  transactionHistoryScreen,
} from '@telga/merchant-pos';
import type { El, Node } from '@telga/merchant-pos';
import { MERCHANT_A, chromeFor, makeUiHarness, seedSale, viewOf } from './helpers';
import type { UiHarness } from './helpers';

let harness: UiHarness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

const ready = <T,>(data: T): RemoteData<T> => ({
  status: 'READY',
  data,
  loadedAt: '2026-08-20T09:00:00.000Z',
});

/** A DTO for a state we do not have a natural way to reach through a sale. */
function dtoAt(state: TransactionState, over: Partial<TransactionDto> = {}): TransactionDto {
  return {
    transactionId: 'txn_fixture',
    merchantId: MERCHANT_A,
    deviceId: 'device_alpha_1',
    state,
    productType: 'AIRTIME',
    amount: { amountMinor: 2500, currency: 'ETB', formatted: 'ETB 25.00' },
    recipientMasked: '09******00',
    providerReference: 'MOCKREF-DEADBEEF',
    idempotencyKey: 'idem_fixture',
    correlationId: 'corr_fixture',
    createdAt: '2026-08-20T09:00:00.000Z',
    updatedAt: '2026-08-20T09:00:05.000Z',
    mode: 'TRAINING',
    simulated: true,
    recovery: {
      pendingStatus: null,
      attempts: 0,
      maxAttempts: 5,
      firstPendingAt: null,
      lastAttemptAt: null,
      nextCheckAt: null,
      deadlineAt: null,
      lastOutcomeCategory: null,
      manualReviewStatus: 'NONE',
      claimActive: false,
      claimAttemptNo: null,
    },
    support: null,
    reservation: null,
    ...over,
  };
}

const viewAt = (state: TransactionState, over: Partial<TransactionDto> = {}): TransactionViewModel =>
  toTransactionViewModel(dtoAt(state, over));

const detailAt = (state: TransactionState, over: Partial<TransactionDto> = {}): El =>
  transactionDetailScreen({ chrome: chromeFor(), transaction: ready(viewAt(state, over)) });

/** Every screen this app can render, for the properties that must hold on all of them. */
function everyScreen(): ReadonlyArray<{ name: string; el: El }> {
  const chrome = chromeFor();
  return [
    {
      name: 'home',
      el: homeScreen({
        chrome,
        balance: ready({
          available: { amountMinor: 7500, currency: 'ETB', formatted: 'ETB 75.00' },
          reserved: { amountMinor: 2500, currency: 'ETB', formatted: 'ETB 25.00' },
          underReview: { amountMinor: 0, currency: 'ETB', formatted: 'ETB 0.00' },
          total: { amountMinor: 10000, currency: 'ETB', formatted: 'ETB 100.00' },
        }),
        recent: ready([viewAt('SUCCESSFUL')]),
        needsAttention: 1,
      }),
    },
    {
      name: 'new sale',
      el: newSaleScreen({
        chrome,
        catalog: [{ productId: 'AIRTIME', label: 'Airtime 25 (simulated)', amountMinor: 2500, available: true }],
        csrfToken: 'csrf_test_token',
        clientRequestId: 'req_fixture',
        simulatedBehaviours: ['SUCCESS', 'TIMEOUT', 'FAILURE'],
      }),
    },
    { name: 'detail', el: detailAt('PENDING') },
    {
      name: 'history',
      el: transactionHistoryScreen({ chrome, transactions: ready([viewAt('FAILED')]) }),
    },
    {
      name: 'queue',
      el: queueScreen({
        chrome,
        pending: [viewAt('PENDING')],
        underReview: [viewAt('UNDER_REVIEW')],
        reversalRequired: [],
      }),
    },
  ];
}

describe('the training banner', () => {
  it('appears on every screen', () => {
    for (const { name, el } of everyScreen()) {
      const banner = byTestId(el, 'training-banner');
      expect(banner, `no banner on ${name}`).toBeDefined();
      expect(textOf(banner as Node)).toContain('Training mode');
      expect(textOf(banner as Node)).toContain('no real value');
    }
  });

  it('names the environment, the merchant and the mode', () => {
    for (const { name, el } of everyScreen()) {
      const indicator = byTestId(el, 'environment-indicator');
      expect(indicator, name).toBeDefined();
      const text = textOf(indicator as Node);
      expect(text).toContain('Environment: test');
      expect(text).toContain(`Merchant: ${MERCHANT_A}`);
      expect(text).toContain('Mode: TRAINING');
    }
  });

  it('is announced politely, not as an interruption', () => {
    const banner = byTestId(everyScreen()[0]!.el, 'training-banner') as El;
    expect(banner.attrs['role']).toBe('status');
    expect(banner.attrs['aria-live']).toBe('polite');
  });

  it('refuses to render a screen whose mode is not TRAINING', () => {
    expect(() =>
      transactionHistoryScreen({
        chrome: chromeFor({ mode: 'LIVE' }),
        transactions: ready([]),
      }),
    ).toThrow(/training mode only/i);
  });

  it('shows the Amharic review warning when the locale is Amharic', () => {
    const el = transactionHistoryScreen({
      chrome: chromeFor({ locale: 'am' }),
      transactions: ready([viewAt('SUCCESSFUL')]),
    });
    const warning = byTestId(el, 'amharic-review-warning');
    expect(textOf(warning as Node)).toBe('REQUIRES NATIVE AMHARIC REVIEW BEFORE PRODUCTION');
  });
});

describe('no false success', () => {
  it('never renders a receipt affordance for an unresolved transaction', () => {
    for (const state of TRANSACTION_STATES) {
      if (state === 'SUCCESSFUL') continue;
      const el = detailAt(state);
      expect(byTestId(el, 'action-PRINT_RECEIPT'), state).toBeUndefined();
      expect(byTestId(el, 'action-REPRINT_RECEIPT'), state).toBeUndefined();
    }
  });

  it('states the certainty in words for every state', () => {
    for (const state of TRANSACTION_STATES) {
      const certainty = byTestId(detailAt(state), 'status-certainty');
      expect(certainty, state).toBeDefined();
      expect(textOf(certainty as Node).length, state).toBeGreaterThan(0);
    }
  });

  it('says the result is not known for a PROCESSING transaction', () => {
    const text = textOf(byTestId(detailAt('PROCESSING'), 'status-certainty') as Node);
    expect(text).toMatch(/not known/i);
  });

  it('says the result is not known for RESERVED without a provider reference', () => {
    const el = detailAt('RESERVED', { providerReference: null });
    expect(textOf(byTestId(el, 'status-certainty') as Node)).toMatch(/not known/i);
    expect(textOf(byTestId(el, 'provider-reference') as Node)).toBe('Not issued');
    expect(textOf(byTestId(el, 'funds-label') as Node)).toMatch(/held/i);
  });

  it('confirms a successful sale, and only then', () => {
    expect(textOf(byTestId(detailAt('SUCCESSFUL'), 'status-certainty') as Node)).toMatch(
      /confirmed by the provider/i,
    );
    expect(byTestId(detailAt('SUCCESSFUL'), 'action-PRINT_RECEIPT')).toBeDefined();
  });
});

describe('DO_NOT_RETRY_YET', () => {
  it('is present and announced for every uncertain state', () => {
    for (const state of ['CREATED', 'VALIDATED', 'RESERVED', 'PROCESSING', 'PENDING', 'UNDER_REVIEW', 'REVERSAL_REQUIRED'] as const) {
      const instruction = byTestId(detailAt(state), 'do-not-retry');
      expect(instruction, state).toBeDefined();
      expect((instruction as El).attrs['role'], state).toBe('alert');
      expect(textOf(instruction as Node)).toBe('Do not retry yet');
    }
  });

  it('is absent once the transaction has settled', () => {
    for (const state of ['SUCCESSFUL', 'FAILED', 'REVERSED', 'REJECTED'] as const) {
      expect(byTestId(detailAt(state), 'do-not-retry'), state).toBeUndefined();
    }
  });

  it('appears before the status detail, not after it', () => {
    const html = renderToHtml(detailAt('PENDING'));
    expect(html.indexOf('do-not-retry')).toBeLessThan(html.indexOf('status-explanation'));
  });

  it('repeats the warning on every pending row in a list', () => {
    const el = queueScreen({
      chrome: chromeFor(),
      pending: [viewAt('PENDING'), viewAt('PENDING')],
      underReview: [],
      reversalRequired: [],
    });
    expect(allByTestId(el, 'row-do-not-retry')).toHaveLength(2);
  });

  it('states the refusal in a sentence, not only as a missing button', () => {
    const el = detailAt('PENDING');
    const refusal = byTestId(el, 'refusal-RETRY_SAME_SALE');
    expect(refusal).toBeDefined();
    expect(textOf(refusal as Node)).toMatch(/charge the customer twice/i);
    expect(textOf(byTestId(el, 'refusal-RELEASE_FUNDS') as Node)).toMatch(/stays held/i);
  });
});

describe('funds and recovery', () => {
  it('says the money is held while a transaction is in flight', () => {
    for (const state of ['RESERVED', 'PROCESSING', 'PENDING'] as const) {
      expect(textOf(byTestId(detailAt(state), 'funds-label') as Node), state).toMatch(/held/i);
    }
  });

  it('says the money was returned only once it actually was', () => {
    expect(textOf(byTestId(detailAt('FAILED'), 'funds-label') as Node)).toMatch(/returned/i);
    expect(textOf(byTestId(detailAt('PENDING'), 'funds-label') as Node)).not.toMatch(/returned/i);
  });

  it('shows the recovery timeline for a pending transaction', () => {
    const el = detailAt('PENDING', {
      recovery: {
        pendingStatus: 'AWAITING',
        attempts: 2,
        maxAttempts: 5,
        firstPendingAt: '2026-08-20T09:00:05.000Z',
        lastAttemptAt: '2026-08-20T09:01:05.000Z',
        nextCheckAt: '2026-08-20T09:01:35.000Z',
        deadlineAt: '2026-08-20T09:05:05.000Z',
        lastOutcomeCategory: 'PROVIDER_INDETERMINATE',
        manualReviewStatus: 'NONE',
        claimActive: false,
        claimAttemptNo: null,
      },
    });
    expect(textOf(byTestId(el, 'recovery-attempts') as Node)).toBe('2 of 5');
    expect(textOf(byTestId(el, 'recovery-next-check') as Node)).toBe('2026-08-20T09:01:35.000Z');
    expect(textOf(byTestId(el, 'recovery-deadline') as Node)).toBe('2026-08-20T09:05:05.000Z');
    expect(textOf(byTestId(el, 'recovery-last-outcome') as Node)).toBe('PROVIDER_INDETERMINATE');
    expect(textOf(byTestId(el, 'recovery-phase') as Node)).toMatch(/waiting for telga/i);
  });

  it('says a worker is checking it right now when a lease is live', () => {
    const el = detailAt('PENDING', {
      recovery: { ...dtoAt('PENDING').recovery, pendingStatus: 'AWAITING', claimActive: true },
    });
    expect(textOf(byTestId(el, 'recovery-phase') as Node)).toMatch(/checking this with the provider now/i);
  });

  it('never names the worker, the lease or the scan', () => {
    const html = renderToHtml(
      detailAt('PENDING', {
        recovery: { ...dtoAt('PENDING').recovery, pendingStatus: 'AWAITING', claimActive: true, claimAttemptNo: 3 },
      }),
    );
    // Not a bare /lease/: "RELEASE_FUNDS" contains it, and that string is a
    // merchant-facing refusal rather than a worker internal.
    expect(html).not.toMatch(/worker_id|workerId|scan_id|scanId|expires_at|claim_lease|claimLease/i);
    expect(html).not.toMatch(/claimed_at|attempt_no/i);
  });

  it('shows the manual-review notice and the support reference for an escalated one', () => {
    const el = detailAt('UNDER_REVIEW', {
      recovery: { ...dtoAt('UNDER_REVIEW').recovery, pendingStatus: 'ESCALATED', manualReviewStatus: 'OPEN' },
      support: {
        reference: 'TG-TXN_1',
        reason: 'UNDER_REVIEW',
        status: 'OPEN',
        openedAt: '2026-08-20T09:05:05.000Z',
        approvedBy: null,
      },
    });
    expect(byTestId(el, 'manual-review-open')).toBeDefined();
    expect(textOf(byTestId(el, 'support-reference') as Node)).toContain('TG-TXN_1');
    expect(byTestId(el, 'action-COPY_SUPPORT_REFERENCE')).toBeDefined();
  });
});

describe('polling attributes', () => {
  it('marks an unresolved transaction for polling at the server interval', () => {
    const el = transactionDetailScreen({
      chrome: chromeFor(),
      transaction: ready(viewAt('PENDING')),
      polling: { statusCheckIntervalMs: 30_000, maxPolls: 4 },
    });
    const detail = byTestId(el, 'transaction-detail') as El;
    expect(detail.attrs['data-poll-transaction']).toBe('txn_fixture');
    expect(detail.attrs['data-poll-interval']).toBe(30_000);
    expect(detail.attrs['data-poll-max']).toBe(4);
    expect(detail.attrs['data-poll-state']).toBe('PENDING');
  });

  it('marks a settled transaction with no polling attributes at all', () => {
    const el = transactionDetailScreen({
      chrome: chromeFor(),
      transaction: ready(viewAt('SUCCESSFUL')),
      polling: { statusCheckIntervalMs: 30_000, maxPolls: 4 },
    });
    const detail = byTestId(el, 'transaction-detail') as El;
    expect(detail.attrs['data-poll-transaction']).toBeUndefined();
    expect(detail.attrs['data-poll-interval']).toBeUndefined();
  });
});

describe('accessibility and keyboard', () => {
  it('gives every screen exactly one level-one heading', () => {
    for (const { name, el } of everyScreen()) {
      const headings = byRole(el, 'heading').filter((h) => h.tag === 'h1');
      expect(headings, name).toHaveLength(1);
    }
  });

  it('gives every focusable control an accessible name', () => {
    for (const { name, el } of everyScreen()) {
      for (const control of focusOrder(el)) {
        if (control.tag === 'input' && control.attrs['type'] === 'hidden') continue;
        const label =
          accessibleName(control) ||
          String(control.attrs['name'] ?? control.attrs['id'] ?? '');
        expect(label.length, `${name}: <${control.tag}> has no accessible name`).toBeGreaterThan(0);
      }
    }
  });

  it('puts nothing in the focus order that a keyboard cannot use', () => {
    for (const { name, el } of everyScreen()) {
      for (const control of focusOrder(el)) {
        expect(['a', 'button', 'input', 'select'], name).toContain(control.tag);
      }
    }
  });

  it('reaches the primary action by keyboard on the sale form', () => {
    const el = everyScreen().find((s) => s.name === 'new sale')!.el;
    const order = focusOrder(el);
    const submit = order.find((control) => control.attrs['data-testid'] === 'confirm-sale');
    expect(submit).toBeDefined();
    // Nav links, then the fields, then confirm: confirm is not first, and is reachable.
    expect(order.indexOf(submit as El)).toBeGreaterThan(0);
  });

  it('associates every visible form field with a label element', () => {
    const el = everyScreen().find((s) => s.name === 'new sale')!.el;
    const labelledIds = new Set(
      findAll(el, (node) => node.tag === 'label').map((label) => String(label.attrs['for'])),
    );

    const visibleFields = focusOrder(el).filter(
      (control) =>
        control.tag === 'select' ||
        (control.tag === 'input' && control.attrs['type'] !== 'hidden'),
    );
    expect(visibleFields.length).toBeGreaterThan(0);

    for (const field of visibleFields) {
      const id = field.attrs['id'];
      expect(id, `<${field.tag}> has no id, so no label can point at it`).toBeDefined();
      expect(labelledIds, `no <label for="${String(id)}">`).toContain(String(id));
    }
  });

  it('points every described field at a hint that exists', () => {
    const el = everyScreen().find((s) => s.name === 'new sale')!.el;
    const described = findAll(el, (node) => node.attrs['aria-describedby'] !== undefined);
    expect(described.length).toBeGreaterThan(0);
    for (const field of described) {
      const target = String(field.attrs['aria-describedby']);
      expect(find(el, (node) => node.attrs['id'] === target), `no element with id ${target}`).toBeDefined();
    }
  });

  it('marks the current navigation destination', () => {
    const el = everyScreen().find((s) => s.name === 'queue')!.el;
    const current = byTestId(el, 'nav-queue') as El;
    expect(current.attrs['aria-current']).toBe('page');
    expect((byTestId(el, 'nav-home') as El).attrs['aria-current']).toBeUndefined();
  });

  it('never signals status by tone alone', () => {
    for (const state of TRANSACTION_STATES) {
      const block = byTestId(detailAt(state), 'status-block') as El;
      expect(block.attrs['data-tone'], state).toBeTruthy();
      // A tone attribute is only a colour hook; the label carries the meaning.
      const label = byTestId(block, 'status-label');
      expect(textOf(label as Node).length, state).toBeGreaterThan(0);
      expect((block.attrs['aria-label'] as string), state).toContain('Transaction status');
    }
  });

  it('hides the decorative status icon from assistive technology', () => {
    const icon = byTestId(detailAt('PENDING'), 'status-icon') as El;
    expect(icon.attrs['aria-hidden']).toBe('true');
  });
});

describe('escaping and the document shell', () => {
  it('escapes text and attribute values', () => {
    const el = detailAt('FAILED', { recipientMasked: '<script>alert(1)</script>' });
    const html = renderToHtml(el);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('serves a policy that forbids remote scripts and framing', () => {
    // The policy itself, then the document. The document carries it HTML-escaped
    // inside a meta attribute, which is correct — a browser decodes the entities
    // before parsing the policy — so the assertion escapes it too rather than
    // weakening the escaping to make a test read nicely.
    const csp = contentSecurityPolicy('n0nce');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");

    const html = htmlDocument('<p>hi</p>', chromeFor(), 'n0nce');
    expect(html).toContain(csp.replace(/'/g, '&#39;'));
    expect(html).toContain('noindex');
  });

  it('allows inline script and style only by nonce, never by unsafe-inline', () => {
    // This replaced `'unsafe-inline'`, which permitted any injected inline
    // script — most of what a CSP exists to stop.
    const csp = contentSecurityPolicy('n0nce');
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("script-src 'nonce-n0nce'");
    expect(csp).toContain("style-src 'nonce-n0nce'");
  });

  it('marks the page script and stylesheet with the same nonce', () => {
    const html = htmlDocument('<p>hi</p>', chromeFor(), 'n0nce');
    expect(html).toContain('<style nonce="n0nce">');
    expect(html).toContain('<script nonce="n0nce">');
  });

  it('forbids all inline execution when no nonce is issued, as on a JSON response', () => {
    const csp = contentSecurityPolicy(undefined);
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("style-src 'none'");
  });

  it('says the mode in the document title', () => {
    expect(htmlDocument('<p>hi</p>', chromeFor(), 'n0nce')).toContain('TRAINING');
  });
});

describe('against a real transaction', () => {
  it('renders a successful sale from the real API read model', async () => {
    harness = makeUiHarness('render-success', { behaviour: 'SUCCESS' });
    const id = await seedSale(harness);
    const view = await viewOf(harness.api, id);

    const el = transactionDetailScreen({ chrome: chromeFor(), transaction: ready(view) });
    expect(textOf(byTestId(el, 'status-label') as Node)).toBe('Transaction successful');
    expect(textOf(byTestId(el, 'transaction-id') as Node)).toBe(id);
    expect(byTestId(el, 'do-not-retry')).toBeUndefined();
    expect(byTestId(el, 'action-PRINT_RECEIPT')).toBeDefined();
    expect(renderToHtml(el)).not.toContain('0900000000');
  });

  it('renders a timed-out sale as pending, holding funds, with no receipt', async () => {
    harness = makeUiHarness('render-pending', { behaviour: 'TIMEOUT' });
    const id = await seedSale(harness);
    const view = await viewOf(harness.api, id);

    const el = transactionDetailScreen({ chrome: chromeFor(), transaction: ready(view) });
    expect(textOf(byTestId(el, 'status-label') as Node)).toBe('Transaction pending');
    expect(byTestId(el, 'do-not-retry')).toBeDefined();
    expect(byTestId(el, 'action-PRINT_RECEIPT')).toBeUndefined();
    expect(textOf(byTestId(el, 'funds-label') as Node)).toMatch(/held/i);
    expect(textOf(byTestId(el, 'recovery-deadline') as Node).length).toBeGreaterThan(0);
  });

  it('renders a confirmed failure as no sale, funds returned', async () => {
    harness = makeUiHarness('render-failed', { behaviour: 'FAILURE' });
    const id = await seedSale(harness);
    const view = await viewOf(harness.api, id);

    const el = transactionDetailScreen({ chrome: chromeFor(), transaction: ready(view) });
    expect(textOf(byTestId(el, 'status-label') as Node)).toBe('Transaction failed');
    expect(textOf(byTestId(el, 'status-explanation') as Node)).toContain('No charge was made');
    expect(textOf(byTestId(el, 'funds-label') as Node)).toMatch(/returned/i);
    expect(byTestId(el, 'action-START_NEW_SALE')).toBeDefined();
  });
});
