/**
 * The second approval a high-value deposit needs — `CLAUDE.md` §20.
 *
 * ## The gap these tests close
 *
 * `recordDeposit` stored an over-cap deposit as `MATCHED` and returned
 * `NEEDS_APPROVAL`. The deposits screen counted those rows — *"N waiting for a
 * decision"* — and **no route could make the decision**. A shop that paid in
 * more than the cap had its money sit in a row indefinitely: no error, no
 * complaint path, no balance.
 *
 * Found by auditing which of the declared admin permissions guard no route at
 * all. `ADMIN_SECOND_APPROVE_FUNDING` guarded nothing, which is what a
 * permission looks like when the control it names was never built.
 *
 * ## The property that matters most
 *
 * **A second approval must come from a second person.** §20 exists to put two
 * judgements between a bank statement and a shop's balance; one person pressing
 * two buttons is one judgement. The check is on `recorded_by` and it is
 * enforced in the *route*, not hidden in the screen — §23.2: *"hiding a control
 * while its endpoint still answers is a defect, not a control."*
 */

import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations, saveAdminUser } from '@telga/persistence';
import { hashAdminSecret } from '@telga/api';
import { createConsoleServer } from '@telga/operations-console';

const NOW = '2026-09-11T10:00:00.000Z';

let dir: string;
let db: Database.Database | undefined;
let server: Server | undefined;
let port = 0;
let credited: { merchantId: string; amountMinor: number }[] = [];
let nextId = 1;

async function admin(id: string, email: string): Promise<void> {
  const secret = await hashAdminSecret('ConsolePassword1');
  saveAdminUser(db as never, {
    id,
    email,
    displayName: id,
    department: 'FINANCE',
    role: 'PLATFORM_OWNER',
    passwordHash: secret.hash,
    passwordSalt: secret.salt,
    passwordParams: secret.params,
    status: 'ACTIVE',
    at: NOW,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'telga-second-'));
  db = new Database(join(dir, 'ops.sqlite'));
  db.pragma('foreign_keys = ON');
  runMigrations(db as never, NOW as never);

  await admin('adm_recorder', 'recorder@telga.example');
  await admin('adm_approver', 'approver@telga.example');

  db.prepare(
    `INSERT INTO merchants (id, status, mode, created_at, updated_at) VALUES (?, 'ACTIVE', 'TRAINING', ?, ?)`,
  ).run('merchant_a', NOW, NOW);

  // A deposit already waiting: over the cap, so `recordDeposit` stored it
  // MATCHED with no credit yet. This is the row that used to be unreachable.
  db.prepare(
    `INSERT INTO funding_submissions
       (id, merchant_id, quoted_reference, bank_reference, claimed_amount_minor,
        bank_amount_minor, status, currency, recorded_by, created_at, updated_at)
     VALUES ('fund_big', 'merchant_a', 'REF-BIG', 'CBE-9001', 6000000, 6000000,
             'MATCHED', 'ETB', 'adm_recorder', ?, ?)`,
  ).run(NOW, NOW);

  credited = [];
  nextId = 1;
  server = createConsoleServer({
    db: db as never,
    now: () => NOW,
    newId: (prefix: string) => `${prefix}_${String(nextId++)}`,
    schemaVersion: '020',
    secureCookies: false,
    singleFactorAuth: true,
    creditMerchant: (input: { merchantId: string; amountMinor: number }) => {
      credited.push({ merchantId: input.merchantId, amountMinor: input.amountMinor });
    },
  } as never);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  port = (server?.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server === undefined) return resolve();
    server.close(() => resolve());
  });
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Reply {
  readonly status: number;
  readonly location: string;
  readonly body: string;
  readonly cookies: readonly string[];
}

function call(
  method: string,
  path: string,
  options: { cookie?: string; form?: Record<string, string> } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload =
      options.form === undefined ? undefined : new URLSearchParams(options.form).toString();
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
          ...(payload === undefined
            ? {}
            : {
                'content-type': 'application/x-www-form-urlencoded',
                'content-length': String(Buffer.byteLength(payload)),
                origin: `http://127.0.0.1:${String(port)}`,
              }),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            location: String(res.headers['location'] ?? ''),
            body,
            cookies: (res.headers['set-cookie'] ?? []) as string[],
          }),
        );
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function signIn(email: string): Promise<string> {
  const first = await call('GET', '/login');
  const jar = first.cookies.map((c) => c.split(';')[0]).join('; ');
  const reply = await call('POST', '/login', {
    cookie: jar,
    form: { email, password: 'ConsolePassword1' },
  });
  return [...first.cookies, ...reply.cookies].map((c) => c.split(';')[0]).join('; ');
}

const statusOf = (): string =>
  (db?.prepare(`SELECT status FROM funding_submissions WHERE id = 'fund_big'`).get() as {
    status: string;
  }).status;

describe('a high-value deposit can finally be approved', () => {
  it('credits the shop and marks the row CREDITED', async () => {
    const cookie = await signIn('approver@telga.example');
    const reply = await call('POST', '/deposits/fund_big/approve', { cookie, form: {} });

    expect(reply.status).toBe(303);
    expect(statusOf()).toBe('CREDITED');
    // The bank's figure, to the shop that quoted the reference.
    expect(credited).toEqual([{ merchantId: 'merchant_a', amountMinor: 6_000_000 }]);
  });

  it('records who approved it, beside who recorded it', async () => {
    const cookie = await signIn('approver@telga.example');
    await call('POST', '/deposits/fund_big/approve', { cookie, form: {} });

    const row = db?.prepare(`SELECT approved_by, posting_id FROM funding_submissions WHERE id = 'fund_big'`).get() as {
      approved_by: string | null;
      posting_id: string | null;
    };
    expect(row.approved_by).toBe('adm_approver');
    // The posting is named on the row, so the credit and the authorisation are
    // one traceable pair rather than two facts a reader has to correlate.
    expect(row.posting_id).not.toBeNull();
  });
});

describe('the control that makes it a *second* approval', () => {
  it('refuses the person who recorded it, and credits nothing', async () => {
    const cookie = await signIn('recorder@telga.example');
    const reply = await call('POST', '/deposits/fund_big/approve', { cookie, form: {} });

    expect(reply.status).toBe(303);
    expect(decodeURIComponent(reply.location)).toContain('cannot be its second approver');
    // The two assertions that matter: nothing moved, and nothing changed.
    expect(credited).toEqual([]);
    expect(statusOf()).toBe('MATCHED');
  });

  it('refuses through the route, not merely by hiding the button', async () => {
    // §23.2. The recorder posting directly — as anyone reading the HTML could —
    // must meet the same refusal a hidden control would have implied.
    const cookie = await signIn('recorder@telga.example');
    await call('POST', '/deposits/fund_big/approve', { cookie, form: {} });
    expect(statusOf()).toBe('MATCHED');
  });

  it('refuses an unauthenticated caller outright', async () => {
    const reply = await call('POST', '/deposits/fund_big/approve', { form: {} });
    expect(reply.status).toBeGreaterThanOrEqual(300);
    expect(credited).toEqual([]);
    expect(statusOf()).toBe('MATCHED');
  });
});

describe('it cannot credit twice', () => {
  it('refuses a replayed approval', async () => {
    const cookie = await signIn('approver@telga.example');
    await call('POST', '/deposits/fund_big/approve', { cookie, form: {} });
    const again = await call('POST', '/deposits/fund_big/approve', { cookie, form: {} });

    expect(decodeURIComponent(again.location)).toContain('Already decided');
    // One credit, not two. A double-press on a slow connection is the ordinary
    // way this would happen.
    expect(credited).toHaveLength(1);
  });

  it('refuses a deposit that resolved to no shop', async () => {
    db?.prepare(
      `INSERT INTO funding_submissions
         (id, merchant_id, quoted_reference, bank_reference, claimed_amount_minor,
          bank_amount_minor, status, currency, recorded_by, created_at, updated_at)
       VALUES ('fund_orphan', NULL, 'REF-NOBODY', 'CBE-9002', 100000, 100000,
               'MANUAL_REVIEW', 'ETB', 'adm_recorder', ?, ?)`,
    ).run(NOW, NOW);

    const cookie = await signIn('approver@telga.example');
    const reply = await call('POST', '/deposits/fund_orphan/approve', { cookie, form: {} });

    // Never guessed at a shop — §20.1: a reference that does not resolve goes
    // to a person, and approving is not what a person does with it.
    expect(decodeURIComponent(reply.location)).toMatch(/manual review|Already decided/i);
    expect(credited).toEqual([]);
  });
});
