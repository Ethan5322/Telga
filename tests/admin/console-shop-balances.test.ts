/**
 * The admin panel shows each shop its own balance — and no shop's transactions.
 *
 * Two requirements from the founder's brief meet on one screen, and they pull in
 * opposite directions:
 *
 *   - *"View shop-level performance (per-shop transaction counts, balances,
 *     activity)"*
 *   - *"**NOT** view individual shop transactions — privacy by design"*
 *
 * The resolution is that every figure here is an **aggregate of one shop**: its
 * own float, and a count of its own sales. Enough to answer "is this shop
 * trading, and with how much", never enough to read what it sold or to whom.
 *
 * This file also exists to settle a question asked directly: whether shops share
 * a balance. They do not, and `shop-balance-isolation.test.ts` proves it at the
 * ledger. This proves the **screen** an administrator actually looks at reports
 * it that way too — because a correct ledger displayed through a query that
 * forgot its `WHERE` would still hand one shop another's money.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, saveAdminUser } from '@telga/persistence';
import {
  adminLogin,
  authenticateAdmin,
  beginMfaEnrolment,
  hashAdminSecret,
  satisfyAdminMfa,
  totpAt,
} from '@telga/api';
import { createConsoleServer } from '../../apps/operations-console/src/server';

const SESSION_COOKIE = 'telga_admin_session';
const PASSWORD = 'a-long-enough-admin-password';
const AT = '2026-09-08T09:00:00.000Z';

let dir: string;
let db: Database.Database;
let server: Server | undefined;
let port = 0;
const clock = Date.parse(AT);

const now = (): string => AT;
let idSeq = 0;
const newId = (prefix: string): string => `${prefix}_${String(++idSeq)}`;
const ports = () => ({ db, now, newId });

function get(path: string, cookie: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { host: '127.0.0.1', cookie } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function signIn(id: string): Promise<string> {
  const derived = await hashAdminSecret(PASSWORD);
  saveAdminUser(db, {
    id,
    email: `${id}@telga.example`,
    displayName: id,
    department: 'PLATFORM',
    role: 'OPERATIONS_ADMIN',
    passwordHash: derived.hash,
    passwordSalt: derived.salt,
    passwordParams: derived.params,
    status: 'ACTIVE',
    at: now(),
  });
  const result = await adminLogin(ports(), { email: `${id}@telga.example`, password: PASSWORD });
  if (result.kind !== 'AUTHENTICATED') throw new Error(`login refused: ${result.kind}`);
  const auth = authenticateAdmin(ports(), result.sessionToken);
  if (!auth.ok) throw new Error('session not resolvable');
  const enrolment = beginMfaEnrolment(ports(), id, `${id}@telga.example`);
  await satisfyAdminMfa(ports(), auth.sessionId, id, totpAt(enrolment.secret, clock));
  return `${SESSION_COOKIE}=${encodeURIComponent(result.sessionToken)}`;
}

/** A shop with its own float, credited the way a verified deposit would. */
function shop(id: string, availableBirr: number, sales = 0): void {
  db.prepare(
    `INSERT INTO merchants (id, status, mode, created_at, updated_at) VALUES (?, 'ACTIVE', 'TRAINING', ?, ?)`,
  ).run(id, AT, AT);

  const accountId = `acct_${id}_available`;
  db.prepare(
    `INSERT INTO ledger_accounts (id, merchant_id, account_type, currency, created_at)
     VALUES (?, ?, 'MERCHANT_AVAILABLE', 'ETB', ?)`,
  ).run(accountId, id, AT);

  if (availableBirr > 0) {
    db.prepare(
      `INSERT INTO ledger_entries
         (id, posting_id, account_id, merchant_id, account_type, direction, amount_minor,
          currency, entry_type, correlation_id, mode, created_at)
       VALUES (?, ?, ?, ?, 'MERCHANT_AVAILABLE', 'CREDIT', ?, 'ETB', 'FUNDING_CREDIT', ?, 'TRAINING', ?)`,
    ).run(
      `entry_${id}`,
      `posting_${id}`,
      accountId,
      id,
      availableBirr * 100,
      `corr_${id}`,
      AT,
    );
  }

  if (sales > 0) {
    db.prepare(
      `INSERT INTO devices (id, merchant_id, status, device_type, created_at, updated_at)
       VALUES (?, ?, 'ACTIVE', 'WEB_POS', ?, ?)`,
    ).run(`device_${id}`, id, AT, AT);
  }

  for (let i = 0; i < sales; i += 1) {
    // `recipient_masked` and `recipient_hash` — the schema has no column a full
    // recipient number could be written to, which is why the leak assertion
    // below looks for the mask rather than a plain number.
    db.prepare(
      `INSERT INTO transactions
         (id, merchant_id, device_id, operator_id, product_type, provider_id, amount_minor,
          currency, recipient_masked, recipient_hash, state, idempotency_key,
          payload_fingerprint, mode, created_at, updated_at)
       VALUES (?, ?, ?, 'operator_x', 'AIRTIME', 'provider_x', 1000, 'ETB',
               '09****4321', 'hash_of_recipient', 'SUCCESSFUL', ?, 'fingerprint',
               'TRAINING', ?, ?)`,
    ).run(
      `txn_${id}_${String(i)}`,
      id,
      `device_${id}`,
      `idem_${id}_${String(i)}`,
      AT,
      AT,
    );
  }
}

beforeEach(async () => {
  idSeq = 0;
  dir = mkdtempSync(join(tmpdir(), 'telga-console-balances-'));
  db = new Database(join(dir, 'telga.sqlite'));
  db.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS) db.exec(`BEGIN; ${migration.sql} COMMIT;`);

  server = createConsoleServer({
    db: db as never,
    now,
    newId,
    schemaVersion: '015',
    allowedHosts: ['127.0.0.1', 'localhost'],
    secureCookies: false,
  });
  await new Promise<void>((resolve) => {
    server?.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve();
    });
  });
});

afterEach(() => {
  server?.close();
  server = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the merchants screen', () => {
  it('shows each shop its own balance, not a shared one', async () => {
    shop('merchant_alpha', 1_000);
    shop('merchant_beta', 500);
    const cookie = await signIn('ops');

    const reply = await get('/merchants', cookie);
    expect(reply.status).toBe(200);

    // Each shop's own figure, side by side and different.
    expect(reply.body).toContain('1,000.00 ETB');
    expect(reply.body).toContain('500.00 ETB');
    // And never the sum of the two, which is what a query missing its WHERE
    // would have produced for both rows.
    expect(reply.body).not.toContain('1,500.00 ETB');
  });

  it('gives a shop that deposited nothing a zero, not the other shop’s money', async () => {
    shop('merchant_alpha', 9_999);
    shop('merchant_beta', 0);
    const cookie = await signIn('ops');

    const reply = await get('/merchants', cookie);
    expect(reply.body).toContain('9,999.00 ETB');
    expect(reply.body).toContain('0.00 ETB');
  });

  it('counts each shop’s sales without showing any of them', async () => {
    shop('merchant_alpha', 1_000, 3);
    shop('merchant_beta', 500, 1);
    const cookie = await signIn('ops');

    const reply = await get('/merchants', cookie);

    // The counts are per shop.
    expect(reply.body).toMatch(/merchant-merchant_alpha-sales[^>]*>3</);
    expect(reply.body).toMatch(/merchant-merchant_beta-sales[^>]*>1</);

    // **And not one transaction id, recipient or amount appears.** This is the
    // privacy half of the requirement, and it is asserted rather than assumed.
    for (const leaked of ['txn_merchant_alpha_0', 'txn_merchant_beta_0', '09****4321', 'AIRTIME']) {
      expect(reply.body, `${leaked} must not reach the console`).not.toContain(leaked);
    }
  });

  it('says on the page whose money the figures are', async () => {
    // The screen states the rule it enforces. A number with no owner named is
    // exactly the ambiguity that caused this file to be written.
    shop('merchant_alpha', 1_000);
    const cookie = await signIn('ops');
    const reply = await get('/merchants', cookie);
    expect(reply.body).toContain('Each shop holds its own balance');
    expect(reply.body).toContain('Own balance');
  });

  it('still refuses an unauthenticated caller', async () => {
    shop('merchant_alpha', 1_000);
    const reply = await get('/merchants', '');
    expect(reply.status).toBe(303);
    expect(reply.body).not.toContain('1,000.00 ETB');
  });
});
