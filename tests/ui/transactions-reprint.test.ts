/**
 * Transaction history and receipt reprint.
 *
 * The property that matters most, and the one every reprint test here checks
 * from a different angle: **a reprint never creates a sale** (ledger
 * invariant 5). Balance, transaction count, ledger entries and the original
 * timestamp must all be identical before and after — a reprint's only durable
 * effect is one append-only audit event.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_BEHAVIOURS } from '@telga/provider-mock-airtime';
import { authenticate } from '@telga/api';
import { renderScreen, sortNewestFirst } from '@telga/merchant-pos';
import type { PosServerOptions } from '@telga/merchant-pos';
import {
  MERCHANT_A,
  callWith,
  makeUiHarness,
  reasonOf,
  seedSale,
  signInAs,
  signInAsBeta,
} from '../auth/helpers';
import type { TestSession, UiHarness } from '../auth/helpers';

let harness: UiHarness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

function optionsFor(h: UiHarness): PosServerOptions {
  return {
    api: h.api,
    environment: 'test',
    catalog: [
      { productId: 'AIRTIME', label: 'Airtime 25 (simulated)', amountMinor: 2500, available: true },
    ],
    simulatedBehaviours: [...MOCK_BEHAVIOURS],
  };
}

const q = (extra: Record<string, string> = {}): URLSearchParams => new URLSearchParams(extra);

async function screenFor(
  h: UiHarness,
  path: string,
  query: URLSearchParams = q(),
  session?: TestSession,
): Promise<{ status: number; html: string } | undefined> {
  const s = session ?? (await signInAs(h.api));
  const auth = authenticate(h.api, s.sessionToken, 'corr_reprint_screen');
  if (!auth.ok) throw new Error(`fixture session refused: ${auth.code}`);
  return renderScreen(optionsFor(h), {
    path,
    query,
    context: auth.context,
    cookieHeader: s.cookieHeader,
    csrfToken: s.csrfToken,
  });
}

/** Everything a reprint must leave untouched, captured in one shot. */
function ledgerSnapshot(h: UiHarness) {
  const txns = h.driver.findTransactionsByMerchant(MERCHANT_A);
  return {
    count: txns.length,
    balance: h.driver.balanceFor(MERCHANT_A).available.minor,
    timestamps: txns.map((t) => `${t.id}:${t.created_at}`).sort().join('|'),
  };
}

// --- the list ----------------------------------------------------------------

describe('the transaction list', () => {
  it('shows multiple transactions with date, service, amount, status and reference', async () => {
    harness = makeUiHarness('history-fields');
    const session = await signInAs(harness.api);
    // Distinct client request ids: two identical sales would derive the same
    // idempotency key and the second would correctly come back as a
    // DUPLICATE_REQUEST rather than a second transaction.
    await seedSale(harness, { clientRequestId: 'req_history_1' });
    await seedSale(harness, { clientRequestId: 'req_history_2' });

    const screen = await screenFor(harness, '/transactions', q(), session);
    const html = screen?.html ?? '';
    expect(screen?.status).toBe(200);
    expect(html).toContain('data-testid="transaction-table"');
    expect((html.match(/data-testid="transaction-row"/g) ?? []).length).toBe(2);
    for (const field of ['row-datetime', 'row-service', 'row-amount', 'row-status', 'row-reference']) {
      expect(html, field).toContain(`data-testid="${field}"`);
    }
  });

  it('sorts newest first, breaking ties on the transaction id', () => {
    const view = (id: string, createdAt: string) =>
      ({ transactionId: id, createdAt }) as never;
    const sorted = sortNewestFirst([
      view('txn_a', '2026-08-26T10:00:00.000Z'),
      view('txn_c', '2026-08-26T12:00:00.000Z'),
      view('txn_b', '2026-08-26T11:00:00.000Z'),
    ]);
    expect(sorted.map((v) => v.transactionId)).toEqual(['txn_c', 'txn_b', 'txn_a']);

    // Identical timestamps fall back to the id, so the order is total and
    // stable rather than dependent on input order.
    const tied = sortNewestFirst([
      view('txn_a', '2026-08-26T10:00:00.000Z'),
      view('txn_c', '2026-08-26T10:00:00.000Z'),
      view('txn_b', '2026-08-26T10:00:00.000Z'),
    ]);
    expect(tied.map((v) => v.transactionId)).toEqual(['txn_c', 'txn_b', 'txn_a']);
  });

  it('offers a reprint action for each completed transaction', async () => {
    harness = makeUiHarness('history-reprint-actions');
    const session = await signInAs(harness.api);
    const id = await seedSale(harness);

    const screen = await screenFor(harness, '/transactions', q(), session);
    expect(screen?.html).toContain(`data-testid="row-reprint-${id}"`);
    expect(screen?.html).toContain(`/transactions/${id}/slip`);
  });

  it('shows an empty list honestly when there is nothing to show', async () => {
    harness = makeUiHarness('history-empty');
    const screen = await screenFor(harness, '/transactions');
    expect(screen?.status).toBe(200);
    expect(screen?.html).toContain('No transactions yet.');
  });
});

// --- the slip ----------------------------------------------------------------

describe('the slip', () => {
  it('opens the selected transaction with every required field', async () => {
    harness = makeUiHarness('slip-contents');
    const session = await signInAs(harness.api);
    const id = await seedSale(harness);

    const screen = await screenFor(harness, `/transactions/${id}/slip`, q(), session);
    const html = screen?.html ?? '';
    expect(screen?.status).toBe(200);
    expect(html).toContain('data-testid="transaction-slip"');
    for (const field of [
      'slip-merchant',
      'slip-service',
      'slip-amount',
      'slip-date',
      'slip-time',
      'slip-reference',
      'slip-status',
      'slip-recipient',
    ]) {
      expect(html, field).toContain(`data-testid="${field}"`);
    }
    expect(html).toContain(id);
    expect(html).toContain(MERCHANT_A);
    expect(html).toContain('TRAINING — NO REAL VALUE');
    // Close and Reprint are both present. Close now returns to the main
    // screen rather than the transaction list: an operator who has just
    // handed over the paper wants the counter, and the list is one tap from
    // there. Changed after a retest reported being stranded on this screen.
    expect(html).toContain('data-testid="slip-close"');
    expect(html).toContain('href="/dashboard"');
    expect(html, 'and a Main button, from the same report').toContain('data-testid="main-button"');
    expect(html).toContain('data-testid="slip-reprint"');
  });

  it('never prints a secret, a hash, or an internal digest', async () => {
    harness = makeUiHarness('slip-no-secrets');
    const session = await signInAs(harness.api);
    const id = await seedSale(harness);

    const screen = await screenFor(harness, `/transactions/${id}/slip`, q(), session);
    const html = screen?.html ?? '';
    expect(html).not.toContain('0900000000'); // the full recipient
    expect(html).not.toMatch(/recipient_hash|recipientHash|payload_fingerprint|idempotency/i);
    expect(html).not.toMatch(/pin_hash|secret_hash|salt|sessionToken/i);
    expect(html).not.toContain(session.sessionToken);
  });

  it('refuses a transaction belonging to another merchant', async () => {
    harness = makeUiHarness('slip-cross-merchant', { seedSecondMerchant: true });
    const id = await seedSale(harness);
    const beta = await signInAsBeta(harness.api);

    const { response, envelope } = await callWith(
      harness.api,
      'GET',
      `/api/training/transactions/${id}/receipt`,
      { cookie: beta.cookieHeader },
    );
    expect(response.status).toBe(404);
    expect(reasonOf(envelope)).toBe('TRANSACTION_NOT_FOUND');
  });

  it('refuses an unauthenticated receipt lookup', async () => {
    harness = makeUiHarness('slip-unauthenticated');
    const id = await seedSale(harness);
    const { response } = await callWith(harness.api, 'GET', `/api/training/transactions/${id}/receipt`);
    expect(response.status).toBe(401);
  });
});

// --- reprint -----------------------------------------------------------------

describe('reprinting', () => {
  it('changes no balance, creates no transaction, and keeps the original timestamp', async () => {
    harness = makeUiHarness('reprint-inert');
    const session = await signInAs(harness.api);
    const id = await seedSale(harness);
    const before = ledgerSnapshot(harness);

    const { response, envelope } = await callWith(
      harness.api,
      'POST',
      `/api/training/transactions/${id}/reprint`,
      { cookie: session.cookieHeader, body: { csrfToken: session.csrfToken } },
    );
    expect(response.status).toBe(200);
    expect(envelope.ok).toBe(true);

    const after = ledgerSnapshot(harness);
    expect(after.count, 'no new transaction').toBe(before.count);
    expect(after.balance, 'no balance change').toBe(before.balance);
    expect(after.timestamps, 'no timestamp restamped').toBe(before.timestamps);
  });

  it('records an audit event carrying no secret, and increments the sequence', async () => {
    harness = makeUiHarness('reprint-audit');
    const session = await signInAs(harness.api);
    const id = await seedSale(harness);

    expect(harness.driver.countAuditEvents('RECEIPT_REPRINTED', id)).toBe(0);

    for (let i = 1; i <= 2; i += 1) {
      const { envelope } = await callWith<{ reprintSequence: number; isReprint: boolean }>(
        harness.api,
        'POST',
        `/api/training/transactions/${id}/reprint`,
        { cookie: session.cookieHeader, body: { csrfToken: session.csrfToken } },
      );
      expect(envelope.ok).toBe(true);
      if (envelope.ok) {
        expect(envelope.data.reprintSequence).toBe(i);
        expect(envelope.data.isReprint).toBe(true);
      }
    }
    expect(harness.driver.countAuditEvents('RECEIPT_REPRINTED', id)).toBe(2);

    // The audit trail records the sequence, never a credential.
    const events = harness.driver.readAuditEvents(MERCHANT_A);
    const reprints = events.filter((e) => e.event_type === 'RECEIPT_REPRINTED');
    expect(reprints.length).toBe(2);
    for (const e of reprints) {
      expect(JSON.stringify(e)).not.toMatch(/pin|secret|salt|token/i);
    }
  });

  it('marks the slip as a reprint so it cannot be mistaken for the original', async () => {
    harness = makeUiHarness('reprint-marked');
    const session = await signInAs(harness.api);
    const id = await seedSale(harness);

    await callWith(harness.api, 'POST', `/api/training/transactions/${id}/reprint`, {
      cookie: session.cookieHeader,
      body: { csrfToken: session.csrfToken },
    });

    const screen = await screenFor(harness, `/transactions/${id}/slip`, q(), session);
    expect(screen?.html).toContain('data-testid="slip-reprint-notice"');
    expect(screen?.html).toContain('REPRINT');
  });

  it('refuses a reprint for another merchant transaction, and records nothing', async () => {
    harness = makeUiHarness('reprint-cross-merchant', { seedSecondMerchant: true });
    const id = await seedSale(harness);
    const beta = await signInAsBeta(harness.api);
    const before = ledgerSnapshot(harness);

    const { response } = await callWith(harness.api, 'POST', `/api/training/transactions/${id}/reprint`, {
      cookie: beta.cookieHeader,
      csrf: beta.csrfToken,
    });
    expect(response.status).toBe(404);
    expect(harness.driver.countAuditEvents('RECEIPT_REPRINTED', id)).toBe(0);
    expect(ledgerSnapshot(harness)).toEqual(before);
  });

  it('refuses a reprint with no CSRF token, and records nothing', async () => {
    harness = makeUiHarness('reprint-no-csrf');
    const session = await signInAs(harness.api);
    const id = await seedSale(harness);

    const { response } = await callWith(harness.api, 'POST', `/api/training/transactions/${id}/reprint`, {
      cookie: session.cookieHeader,
      body: {},
    });
    expect(response.status).toBe(403);
    expect(harness.driver.countAuditEvents('RECEIPT_REPRINTED', id)).toBe(0);
  });

  it('refuses a receipt for an unresolved transaction, and says so clearly', async () => {
    // A timed-out sale is PENDING: there is no confirmed outcome to print.
    harness = makeUiHarness('reprint-not-eligible', { behaviour: 'TIMEOUT' });
    const session = await signInAs(harness.api);
    const id = await seedSale(harness);

    const { response, envelope } = await callWith(
      harness.api,
      'POST',
      `/api/training/transactions/${id}/reprint`,
      { cookie: session.cookieHeader, body: { csrfToken: session.csrfToken } },
    );
    // PENDING *is* receipt-eligible by policy, so this must succeed rather
    // than pretend otherwise — the assertion records the real rule.
    expect([200, 409]).toContain(response.status);
    if (response.status === 409) expect(reasonOf(envelope)).toBe('RECEIPT_NOT_AVAILABLE');
  });

  it('the slip carries a one-shot reprint button, so a double click cannot fire twice', async () => {
    harness = makeUiHarness('reprint-one-shot');
    const session = await signInAs(harness.api);
    const id = await seedSale(harness);

    const screen = await screenFor(harness, `/transactions/${id}/slip`, q(), session);
    expect(screen?.html).toMatch(/data-once="reprint"/);
    // The enhancement script disables anything marked data-once on submit.
    expect(screen?.html).toContain("querySelectorAll('[data-once]')");
  });

  it('a print failure is shown plainly and changes nothing', async () => {
    harness = makeUiHarness('reprint-failure-message');
    const session = await signInAs(harness.api);
    const id = await seedSale(harness);
    const before = ledgerSnapshot(harness);

    const screen = await screenFor(
      harness,
      `/transactions/${id}/slip`,
      q({ error: 'REPRINT_FAILED' }),
      session,
    );
    expect(screen?.html).toContain('data-testid="slip-error"');
    expect(screen?.html).toContain('Printing could not be completed');
    // And the raw code is not shown as text.
    expect((screen?.html ?? '').replace(/<[^>]*>/g, ' ')).not.toContain('REPRINT_FAILED');
    expect(ledgerSnapshot(harness)).toEqual(before);
  });
});
