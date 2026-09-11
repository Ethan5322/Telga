/**
 * Settling a Chapa payment against a real database — `CLAUDE.md` §20.2.
 *
 * The pure decision rules are covered in `chapa-deposit.test.ts`. This exercises
 * the part that touches money: what actually reaches the ledger, and what
 * happens when the same webhook arrives twice.
 *
 * ## The defect these tests exist because of
 *
 * The first version drew a fresh posting id (`newId('post')`) and then asked
 * `postingExists` about it. A fresh id never exists, so the guard was always
 * false and stopped nothing — and `ledger_entries.posting_id` is a plain index,
 * not a unique one, so nothing downstream would have refused a second credit
 * either.
 *
 * Chapa retries webhooks as a matter of course. A shop would have been credited
 * twice for one payment, and the only sign would have been a balance nobody
 * could explain.
 *
 * The fix makes the **status update the lock**: `markTopupOrderPaid` is
 * `UPDATE … WHERE status = 'OPEN'`, so exactly one caller can see it change a
 * row, and only that caller credits.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS, SqliteLedgerDriver } from '@telga/persistence';
import { newDepositReference, normalizeDepositReference } from '@telga/domain';
import { settleChapaDeposit } from '@telga/api';

const AT = '2026-09-11T10:00:00.000Z';
const MERCHANT = 'merchant_a';

let dir: string;
let db: Database.Database;
let driver: SqliteLedgerDriver;
let reference: string;
let ids = 0;

/** Chapa's verify endpoint, answering however a test needs. */
const chapaAnswering = (body: unknown, status = 200): typeof fetch =>
  (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    )) as unknown as typeof fetch;

const ports = (fetchImpl: typeof fetch) => ({
  config: { secretKey: 'CHASECK_TEST-abc', fetchImpl },
  merchantEmail: 'shop@telga.example',
});

const deps = () =>
  ({ driver, now: () => AT, newId: (p: string) => `${p}_${String(++ids)}` }) as never;

const availableMinor = (): number => {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount_minor ELSE -amount_minor END), 0) AS n
         FROM ledger_entries WHERE merchant_id = ? AND account_type = 'MERCHANT_AVAILABLE'`,
    )
    .get(MERCHANT) as { n: number };
  return row.n;
};

const residualMinor = (): number => {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount_minor ELSE -amount_minor END), 0) AS n
         FROM ledger_entries`,
    )
    .get() as { n: number };
  return row.n;
};

beforeEach(() => {
  ids = 0;
  dir = mkdtempSync(join(tmpdir(), 'telga-chapa-'));
  db = new Database(join(dir, 'telga.sqlite'));
  db.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS) db.exec(`BEGIN; ${migration.sql} COMMIT;`);
  db.prepare(
    `INSERT INTO merchants (id, status, mode, created_at, updated_at)
     VALUES (?, 'ACTIVE', 'TRAINING', ?, ?)`,
  ).run(MERCHANT, AT, AT);

  driver = new SqliteLedgerDriver({ connection: db as never } as never);
  reference = driver.saveTopupOrder(
    {
      id: 'top_1',
      merchantId: MERCHANT,
      deviceId: 'till_one',
      operatorId: 'op_one',
      amountMinor: 250_000,
      correlationId: 'corr_1',
      mode: 'TRAINING',
      at: AT,
      expiresAt: '2026-09-12T10:00:00.000Z',
      method: 'CHAPA',
    },
    newDepositReference,
    normalizeDepositReference,
  );
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const success = () =>
  chapaAnswering({
    status: 'success',
    data: { status: 'success', amount: '2500', currency: 'ETB', tx_ref: reference, reference: 'chapa_ref_1' },
  });

describe('a confirmed payment reaches the balance', () => {
  it('credits the shop and balances the ledger', async () => {
    const result = await settleChapaDeposit(deps(), ports(success()), reference, (p) => `${p}_x`);

    expect(result.kind).toBe('CREDITED');
    expect(availableMinor()).toBe(250_000);
    // §13: every debit has a matching credit.
    expect(residualMinor()).toBe(0);
  });

  it('marks the order paid and records Chapa’s own reference', async () => {
    await settleChapaDeposit(deps(), ports(success()), reference, (p) => `${p}_x`);

    const order = db.prepare(`SELECT status, provider_reference FROM topup_orders`).get() as {
      status: string;
      provider_reference: string | null;
    };
    expect(order.status).toBe('PAID');
    expect(order.provider_reference).toBe('chapa_ref_1');

    const funding = db.prepare(`SELECT status, bank_reference FROM funding_submissions`).get() as {
      status: string;
      bank_reference: string;
    };
    expect(funding.status).toBe('CREDITED');
    expect(funding.bank_reference).toBe('chapa_ref_1');
  });
});

describe('the same webhook twice', () => {
  /**
   * The test the original code would have failed.
   *
   * Chapa retries until acknowledged, so this is the ordinary case rather than
   * an attack. One payment, one credit.
   */
  it('credits exactly once', async () => {
    const first = await settleChapaDeposit(deps(), ports(success()), reference, (p) => `${p}_a`);
    const second = await settleChapaDeposit(deps(), ports(success()), reference, (p) => `${p}_b`);

    expect(first.kind).toBe('CREDITED');
    expect(second.kind).toBe('REFUSED');

    expect(availableMinor()).toBe(250_000);
    expect(residualMinor()).toBe(0);

    const postings = db.prepare(`SELECT COUNT(DISTINCT posting_id) AS n FROM ledger_entries`).get() as {
      n: number;
    };
    expect(postings.n).toBe(1);
  });

  it('writes one funding submission, not two', async () => {
    await settleChapaDeposit(deps(), ports(success()), reference, (p) => `${p}_a`);
    await settleChapaDeposit(deps(), ports(success()), reference, (p) => `${p}_b`);

    const n = db.prepare(`SELECT COUNT(*) AS n FROM funding_submissions`).get() as { n: number };
    expect(n.n).toBe(1);
  });
});

describe('what never credits', () => {
  it('refuses an amount that does not match the order', async () => {
    const wrong = chapaAnswering({
      status: 'success',
      data: { status: 'success', amount: '9999', currency: 'ETB', tx_ref: reference, reference: 'r' },
    });
    const result = await settleChapaDeposit(deps(), ports(wrong), reference, (p) => `${p}_x`);

    expect(result).toEqual({ kind: 'REFUSED', reason: 'OVERPAID' });
    expect(availableMinor()).toBe(0);
  });

  it('refuses a payment Chapa has not called successful', async () => {
    const pending = chapaAnswering({
      status: 'success',
      data: { status: 'pending', amount: '2500', currency: 'ETB', tx_ref: reference, reference: 'r' },
    });
    const result = await settleChapaDeposit(deps(), ports(pending), reference, (p) => `${p}_x`);

    expect(result).toEqual({ kind: 'REFUSED', reason: 'NOT_SUCCESSFUL' });
    expect(availableMinor()).toBe(0);
  });

  it('credits nothing for a reference nobody was issued', async () => {
    const result = await settleChapaDeposit(deps(), ports(success()), 'ZZZZZZZZZ', (p) => `${p}_x`);
    expect(result).toEqual({ kind: 'UNKNOWN_REFERENCE' });
    expect(availableMinor()).toBe(0);
  });

  /**
   * §30: an uncertain outcome is never a definite one.
   *
   * Telga could not reach Chapa, so it does not know whether the payment
   * happened. It must not credit, and it must not mark the order settled — the
   * webhook is retried and the next attempt decides.
   */
  it('leaves the order open when Chapa cannot be reached', async () => {
    const dead = (() => Promise.reject(new Error('socket hang up'))) as unknown as typeof fetch;
    const result = await settleChapaDeposit(deps(), ports(dead), reference, (p) => `${p}_x`);

    expect(result.kind).toBe('UNVERIFIABLE');
    expect(availableMinor()).toBe(0);
    const order = db.prepare(`SELECT status FROM topup_orders`).get() as { status: string };
    expect(order.status).toBe('OPEN');
  });
});
