/**
 * What an administrator sees about the platform, and what they still cannot.
 *
 * **M5.** The founder's brief asks for two things on one screen that pull
 * against each other: *"view aggregate system metrics (total transactions,
 * total volume)"* and *"**NOT** view individual shop transactions"*.
 *
 * The resolution is that every figure here is a **count or a sum**, with no way
 * to open one. So the tests come in pairs: the number is right, and the rows
 * behind it never reach the page.
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

async function signIn(id = 'owner'): Promise<string> {
  const derived = await hashAdminSecret(PASSWORD);
  saveAdminUser(db, {
    id,
    email: `${id}@telga.example`,
    displayName: id,
    department: 'PLATFORM',
    role: 'PLATFORM_OWNER',
    passwordHash: derived.hash,
    passwordSalt: derived.salt,
    passwordParams: derived.params,
    status: 'ACTIVE',
    at: now(),
  });
  const result = await adminLogin(ports(), { email: `${id}@telga.example`, password: PASSWORD });
  if (result.kind !== 'AUTHENTICATED') throw new Error('login refused');
  const auth = authenticateAdmin(ports(), result.sessionToken);
  if (!auth.ok) throw new Error('session not resolvable');
  const enrolment = beginMfaEnrolment(ports(), id, `${id}@telga.example`);
  await satisfyAdminMfa(ports(), auth.sessionId, id, totpAt(enrolment.secret, clock));
  return `${SESSION_COOKIE}=${encodeURIComponent(result.sessionToken)}`;
}

/** A shop with a float and, optionally, some sales. */
function shop(id: string, floatBirr: number, sales: { amountBirr: number }[] = []): void {
  db.prepare(
    `INSERT INTO merchants (id, status, mode, created_at, updated_at)
     VALUES (?, 'ACTIVE', 'TRAINING', ?, ?)`,
  ).run(id, AT, AT);
  db.prepare(
    `INSERT INTO ledger_accounts (id, merchant_id, account_type, currency, created_at)
     VALUES (?, ?, 'MERCHANT_AVAILABLE', 'ETB', ?)`,
  ).run(`acct_${id}`, id, AT);
  db.prepare(
    `INSERT INTO ledger_accounts (id, merchant_id, account_type, currency, created_at)
     VALUES (?, NULL, 'BANK_CLEARING', 'ETB', ?)`,
  ).run(`bank_${id}`, AT);

  if (floatBirr > 0) {
    // A balanced pair, the way `fundMerchant` writes one: the shop is credited
    // and BANK_CLEARING is debited. Both halves matter — the residual check
    // below is only meaningful against balanced postings.
    db.prepare(
      `INSERT INTO ledger_entries
         (id, posting_id, account_id, merchant_id, account_type, direction, amount_minor,
          currency, entry_type, correlation_id, mode, created_at)
       VALUES (?, ?, ?, ?, 'MERCHANT_AVAILABLE', 'CREDIT', ?, 'ETB', 'FUNDING_CREDIT', ?, 'TRAINING', ?)`,
    ).run(`e_${id}_c`, `p_${id}`, `acct_${id}`, id, floatBirr * 100, `c_${id}`, AT);
    db.prepare(
      `INSERT INTO ledger_entries
         (id, posting_id, account_id, merchant_id, account_type, direction, amount_minor,
          currency, entry_type, correlation_id, mode, created_at)
       VALUES (?, ?, ?, NULL, 'BANK_CLEARING', 'DEBIT', ?, 'ETB', 'FUNDING_CREDIT', ?, 'TRAINING', ?)`,
    ).run(`e_${id}_d`, `p_${id}`, `bank_${id}`, floatBirr * 100, `c_${id}`, AT);
  }

  if (sales.length > 0) {
    db.prepare(
      `INSERT INTO devices (id, merchant_id, status, device_type, created_at, updated_at)
       VALUES (?, ?, 'ACTIVE', 'SMART_POS', ?, ?)`,
    ).run(`dev_${id}`, id, AT, AT);
  }
  sales.forEach((sale, i) => {
    db.prepare(
      `INSERT INTO transactions
         (id, merchant_id, device_id, operator_id, product_type, provider_id, amount_minor,
          currency, recipient_masked, recipient_hash, state, idempotency_key,
          payload_fingerprint, mode, created_at, updated_at)
       VALUES (?, ?, ?, 'op', 'AIRTIME', 'p', ?, 'ETB', '09****4321', 'h', 'SUCCESSFUL',
               ?, 'f', 'TRAINING', ?, ?)`,
    ).run(
      `txn_${id}_${String(i)}`,
      id,
      `dev_${id}`,
      sale.amountBirr * 100,
      `idem_${id}_${String(i)}`,
      AT,
      AT,
    );
  });
}

const value = (body: string, id: string): string =>
  new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`).exec(body)?.[1]?.trim() ?? '';

beforeEach(async () => {
  idSeq = 0;
  dir = mkdtempSync(join(tmpdir(), 'telga-dashboard-'));
  db = new Database(join(dir, 'telga.sqlite'));
  db.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS) db.exec(`BEGIN; ${migration.sql} COMMIT;`);

  server = createConsoleServer({
    db: db as never,
    now,
    newId,
    schemaVersion: '016',
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

describe('platform totals', () => {
  it('adds the shops up, and reports the sum as a platform figure', async () => {
    shop('mch_A', 1_000, [{ amountBirr: 50 }, { amountBirr: 30 }]);
    shop('mch_B', 500, [{ amountBirr: 20 }]);
    const cookie = await signIn();

    const page = await get('/', cookie);
    expect(page.status).toBe(200);

    expect(value(page.body, 'stat-total-sales')).toBe('3');
    expect(value(page.body, 'stat-total-volume')).toBe('100.00 ETB');
    // 1,000 + 500. Neither shop's own figure, and not reachable as one.
    expect(value(page.body, 'stat-total-float')).toBe('1,500.00 ETB');
  });

  it('shows no shop’s transactions, only the count of them', async () => {
    // The privacy half of the requirement, asserted rather than assumed.
    shop('mch_A', 1_000, [{ amountBirr: 50 }]);
    const cookie = await signIn();
    const page = await get('/', cookie);

    for (const leaked of ['txn_mch_A_0', '09****4321', 'AIRTIME', 'idem_mch_A_0']) {
      expect(page.body, `${leaked} must not reach the dashboard`).not.toContain(leaked);
    }
  });

  it('never counts BANK_CLEARING as money a shop holds', async () => {
    // The counterparty side of every deposit lives there. Counting it would
    // double the platform float and make it look like shops hold twice what
    // they do.
    shop('mch_A', 1_000);
    const cookie = await signIn();
    const page = await get('/', cookie);
    expect(value(page.body, 'stat-total-float')).toBe('1,000.00 ETB');
  });
});

describe('the ledger residual', () => {
  it('reports the books as balancing when every posting does', async () => {
    // Corrected under D120: this used to say the residual "cannot be proven"
    // because per-shop databases were unreadable. Under the shared model it is
    // one query, and reporting it as unknowable would be the opposite failure.
    shop('mch_A', 1_000);
    const cookie = await signIn();
    const page = await get('/', cookie);
    expect(page.body).toContain('Every posting balances');
  });

  it('says so plainly when they do not', async () => {
    shop('mch_A', 1_000);
    // A credit with no matching debit — the state §13.2 says must never happen.
    db.prepare(
      `INSERT INTO ledger_entries
         (id, posting_id, account_id, merchant_id, account_type, direction, amount_minor,
          currency, entry_type, correlation_id, mode, created_at)
       VALUES ('e_orphan', 'p_orphan', 'acct_mch_A', 'mch_A', 'MERCHANT_AVAILABLE', 'CREDIT',
               777, 'ETB', 'ADJUSTMENT', 'c_orphan', 'TRAINING', ?)`,
    ).run(AT);

    const cookie = await signIn();
    const page = await get('/', cookie);
    expect(page.body).toContain('Ledger residual is 777');
    expect(page.body).toContain('Investigate before trading');
  });
});

describe('what needs attention', () => {
  it('counts deposits waiting for a person', async () => {
    shop('mch_A', 1_000);
    for (const [id, status] of [
      ['f1', 'MANUAL_REVIEW'],
      ['f2', 'MATCHED'],
      ['f3', 'CREDITED'],
    ]) {
      db.prepare(
        `INSERT INTO funding_submissions
           (id, merchant_id, quoted_reference, bank_reference, status, created_at, updated_at)
         VALUES (?, 'mch_A', 'r', ?, ?, ?, ?)`,
      ).run(id, `FT_${String(id)}`, status, AT, AT);
    }

    const cookie = await signIn();
    const page = await get('/', cookie);
    // The credited one is done and is not waiting for anybody.
    expect(value(page.body, 'alert-deposits')).toBe('2');
  });

  it('counts shops low on float, and does not count a healthy one', async () => {
    shop('mch_A', 1_000);
    shop('mch_LOW', 50);
    shop('mch_EMPTY', 0);

    const cookie = await signIn();
    const page = await get('/', cookie);
    expect(value(page.body, 'alert-low-float')).toBe('2');
  });

  it('counts a licence that has expired or expires within thirty days', async () => {
    shop('mch_A', 1_000);
    db.prepare(
      `INSERT INTO merchant_applications
         (id, reference, status, legal_name, owner_name, phone, address, locality,
          created_at, updated_at)
       VALUES ('app_1', 'REF-1', 'ACTIVE_TRAINING', 'A', 'O', '+251911000000', 'addr',
               'Addis Ababa', ?, ?)`,
    ).run(AT, AT);

    const licences: [string, string][] = [
      ['d_expired', '2026-01-01T00:00:00.000Z'],
      ['d_soon', '2026-09-20T00:00:00.000Z'],
      ['d_fine', '2028-01-01T00:00:00.000Z'],
    ];
    for (const [id, expires] of licences) {
      db.prepare(
        `INSERT INTO merchant_application_documents
           (id, application_id, kind, reference, status, expires_at, created_at, updated_at)
         VALUES (?, 'app_1', 'TRADE_LICENCE', ?, 'SUPPLIED', ?, ?, ?)`,
      ).run(id, `TL-${id}`, expires, AT, AT);
    }

    const cookie = await signIn();
    const page = await get('/', cookie);
    expect(value(page.body, 'alert-licences')).toBe('2');
  });

  it('shows zeroes rather than nothing on an empty platform', async () => {
    // A dashboard with no rows must read as "nothing yet", not as broken.
    const cookie = await signIn();
    const page = await get('/', cookie);
    expect(value(page.body, 'stat-total-sales')).toBe('0');
    expect(value(page.body, 'stat-total-float')).toBe('0.00 ETB');
    expect(value(page.body, 'alert-deposits')).toBe('0');
  });
});
