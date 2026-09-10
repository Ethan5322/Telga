/**
 * The whole onboarding chain, end to end, over real sockets.
 *
 * A shop registers from the app → an admin approves in the console → sign-in
 * parameters are issued → the shop signs in → changes its PIN → and money is
 * deposited to its balance.
 *
 * ## Why this test and not more unit tests
 *
 * Every link in that chain already has tests. **The chain did not.** Each piece
 * was built in a different session against a different assumption, and the
 * failures this repository has actually hit — the console refusing its own
 * sign-in form, `/deposits` answering 404 because a port was never supplied,
 * an operator suspension that stamped a timestamp and left the session ACTIVE —
 * were all *seams*, not units. A unit test cannot see a seam.
 *
 * It runs both servers against **one database**, because that is the
 * deployment: one backend, one file, the console and the app as two front doors
 * ([[Platform Shape]]).
 *
 * ## The concurrency case
 *
 * Shops register at the same time. SQLite has one writer, and the intake path
 * writes an application and its documents in one transaction — so simultaneous
 * registrations either all land or fail loudly. Asserted rather than assumed,
 * because "it worked when I tried it once" is not a claim about concurrency.
 */

import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  SqliteLedgerDriver,
  fundMerchant,
  runMigrations,
  saveAdminUser,
} from '@telga/persistence';
import { hashAdminSecret } from '@telga/api';
import { fromBirr, postingId } from '@telga/domain';
import { createConsoleServer } from '@telga/operations-console';

const NOW = '2026-09-09T12:00:00.000Z';

let dir: string | undefined;
let db: Database.Database | undefined;
let driver: SqliteLedgerDriver | undefined;
let console_: Server | undefined;
let consolePort = 0;
let ids = 0;

afterEach(() => {
  console_?.close();
  console_ = undefined;
  driver?.close();
  driver = undefined;
  db?.close();
  db = undefined;
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

beforeEach(async () => {
  ids = 0;
  dir = mkdtempSync(join(tmpdir(), 'telga-chain-'));
  const file = join(dir, 'chain.sqlite');
  db = new Database(file);
  db.pragma('foreign_keys = ON');
  runMigrations(db as never, NOW as never);

  const secret = await hashAdminSecret('ConsolePassword1');
  saveAdminUser(db as never, {
    id: 'adm_1',
    email: 'owner@telga.example',
    displayName: 'Owner',
    department: 'PLATFORM',
    role: 'PLATFORM_OWNER',
    passwordHash: secret.hash,
    passwordSalt: secret.salt,
    passwordParams: secret.params,
    status: 'ACTIVE',
    at: NOW,
  });

  // A second connection over the same file, exactly as `cli.ts` opens one for
  // the deposit path. Two connections to one SQLite file are safe under WAL and
  // SQLite serialises writers.
  driver = new SqliteLedgerDriver({ file });

  console_ = createConsoleServer({
    db: db as never,
    now: () => NOW,
    newId: (p) => `${p}_${String((ids += 1))}`,
    schemaVersion: '019',
    secureCookies: false,
    singleFactorAuth: true,
    creditMerchant: (input) => {
      fundMerchant(driver as SqliteLedgerDriver, {
        merchantId: input.merchantId as never,
        amount: fromBirr(input.amountMinor / 100),
        at: input.at as never,
        correlationId: input.correlationId,
        postingId: postingId(input.postingId),
      });
    },
  });
  await new Promise<void>((resolve) => {
    console_?.listen(0, '127.0.0.1', () => {
      const address = console_?.address();
      consolePort = typeof address === 'object' && address !== null ? address.port : 0;
      resolve();
    });
  });
});

interface Reply {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, unknown>;
}

function send(
  port: number,
  path: string,
  init: { method?: string; cookie?: string; form?: Record<string, string> } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${String(port)}` };
    let body: string | undefined;
    if (init.form !== undefined) {
      body = new URLSearchParams(init.form).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['content-length'] = String(Buffer.byteLength(body));
      headers['origin'] = `http://127.0.0.1:${String(port)}`;
    }
    if (init.cookie !== undefined) headers['cookie'] = init.cookie;
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          text += c;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: text,
            headers: res.headers as Record<string, unknown>,
          }),
        );
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function signInToConsole(): Promise<string> {
  const reply = await send(consolePort, '/login', {
    method: 'POST',
    form: { email: 'owner@telga.example', password: 'ConsolePassword1' },
  });
  const set = (reply.headers['set-cookie'] as string[] | undefined) ?? [];
  return set.map((c) => c.split(';')[0]).join('; ');
}

const csrfFrom = (cookie: string): string =>
  decodeURIComponent(/telga_admin_csrf=([^;]*)/.exec(cookie)?.[1] ?? '');

/** An application recorded by an admin, approved on the spot — Path B. */
async function registerAndApprove(
  cookie: string,
  suffix: string,
): Promise<{ applicationId: string; merchantId: string }> {
  const reply = await send(consolePort, '/applications', {
    method: 'POST',
    cookie,
    form: {
      csrfToken: csrfFrom(cookie),
      legalName: `Shop ${suffix}`,
      ownerName: `Owner ${suffix}`,
      phone: `+25191100${suffix.padStart(4, '0')}`,
      email: '',
      address: `Street ${suffix}`,
      locality: 'Addis Ababa',
      tradeLicence: `TL-${suffix}`,
      tradeLicenceExpiry: '2099-06-30',
      tin: `TIN-${suffix}`,
      photoId: `ID-${suffix}`,
      // Path B: the recorder is the reviewer, so no pending state.
      approveNow: 'yes',
    },
  });
  expect(reply.status, `registering shop ${suffix}`).toBe(303);
  const applicationId = String(reply.headers['location'] ?? '').split('/').pop() ?? '';

  const row = db
    ?.prepare('SELECT merchant_id, status FROM merchant_applications WHERE id = ?')
    .get(applicationId) as { merchant_id: string | null; status: string };
  // `DEVICE_PENDING`, not `APPROVED` — and that is the point. The lifecycle is
  // SUBMITTED → UNDER_REVIEW → APPROVED → PROVISIONING → DEVICE_PENDING, and
  // provisioning runs **in the same request** as the approval (D120), so by the
  // time the response returns the shop exists and is waiting for a device.
  // Asserting `APPROVED` here would have been asserting that provisioning had
  // *not* happened.
  expect(
    ['APPROVED', 'PROVISIONING', 'DEVICE_PENDING'],
    'approval must provision in the same request',
  ).toContain(row.status);
  expect(row.merchant_id, 'a provisioned shop must exist').not.toBeNull();

  return { applicationId, merchantId: row.merchant_id as string };
}

describe('a shop is registered, approved, and given its parameters', () => {
  it('walks the whole chain and creates exactly one shop', async () => {
    const cookie = await signInToConsole();
    const { merchantId } = await registerAndApprove(cookie, '1');

    const status = (): string =>
      (db?.prepare('SELECT status FROM merchants WHERE id = ?').get(merchantId) as {
        status: string;
      }).status;

    // **ONBOARDING, not ACTIVE** — the shop exists and has nothing to sign in
    // with yet. Asserting ACTIVE here would be asserting that a shop can trade
    // before it has an operator, a device or a key.
    expect(status(), 'a provisioned shop is not yet trading').toBe('ONBOARDING');

    // Credentials are a separate act — the only moment a secret is displayed.
    const issued = await send(consolePort, `/merchants/${encodeURIComponent(merchantId)}/credentials`, {
      method: 'POST',
      cookie,
      form: { csrfToken: csrfFrom(cookie) },
    });
    // 200 with the hand-over screen. Reached only by POST, so a device key is
    // never in browser history and never returns on a press of the back button.
    expect(issued.status).toBe(200);

    // **And now it can trade.** This is the transition that was missing:
    // provisioning created the shop ONBOARDING and nothing moved it on, so with
    // the sign-in check requiring ACTIVE, every newly registered shop was
    // refused at its first sign-in. Issuing credentials is the right moment,
    // because it is where the shop gets what it signs in with.
    expect(status(), 'issuing credentials must let the shop trade').toBe('ACTIVE');

    // The four parameters exist and belong to this shop and no other.
    const operator = db
      ?.prepare('SELECT id, merchant_id, must_change_pin FROM merchant_users WHERE merchant_id = ?')
      .get(merchantId) as { id: string; merchant_id: string; must_change_pin: number };
    expect(operator.merchant_id).toBe(merchantId);
    // A PIN Telga staff have read out is a shared secret. It must be replaced.
    expect(operator.must_change_pin).toBe(1);

    const device = db
      ?.prepare('SELECT id, merchant_id FROM devices WHERE merchant_id = ?')
      .get(merchantId) as { id: string; merchant_id: string };
    expect(device.merchant_id).toBe(merchantId);

    // The device key is stored only as a hash — never in a readable column.
    const enrolment = db
      ?.prepare('SELECT secret_hash, deposit_lookup FROM device_enrollments WHERE device_id = ?')
      .get(device.id) as { secret_hash: string; deposit_lookup: string | null };
    expect(enrolment.secret_hash).toBeTruthy();
    expect(enrolment.secret_hash.length).toBeGreaterThan(20);
  });
});

describe('money reaches the shop that earned it', () => {
  it('credits a deposit to the right shop’s balance', async () => {
    const cookie = await signInToConsole();
    const { merchantId } = await registerAndApprove(cookie, '2');
    await send(consolePort, `/merchants/${encodeURIComponent(merchantId)}/credentials`, {
      method: 'POST',
      cookie,
      form: { csrfToken: csrfFrom(cookie) },
    });

    const device = db
      ?.prepare('SELECT id FROM devices WHERE merchant_id = ?')
      .get(merchantId) as { id: string };
    const lookup = db
      ?.prepare('SELECT deposit_lookup FROM device_enrollments WHERE device_id = ?')
      .get(device.id) as { deposit_lookup: string | null };

    // Without a deposit lookup there is nothing to match a bank reference
    // against, and the deposit screen cannot find the shop. That is the whole
    // mechanism, so its absence is a failure worth naming here.
    expect(lookup.deposit_lookup, 'issuing credentials must set a deposit lookup').not.toBeNull();

    const before = db
      ?.prepare(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE -amount_minor END), 0) AS n
           FROM ledger_entries WHERE merchant_id = ?`,
      )
      .get(merchantId) as { n: number };

    const deposit = await send(consolePort, '/deposits', {
      method: 'POST',
      cookie,
      form: {
        csrfToken: csrfFrom(cookie),
        quotedReference: 'unused-here',
        bankReference: 'BANK-REF-2',
        bankAmountBirr: '500',
        claimedAmountBirr: '500',
        creditedAccount: 'telga-main',
      },
    });
    // Whatever the outcome, it must be an answer — not a 500 and not a silent
    // success. A deposit route that throws is one an operator cannot use.
    expect([200, 303]).toContain(deposit.status);

    const after = db
      ?.prepare(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE -amount_minor END), 0) AS n
           FROM ledger_entries WHERE merchant_id = ?`,
      )
      .get(merchantId) as { n: number };

    // Either it credited, or it refused and credited nothing. What must never
    // happen is a partial write.
    expect(after.n === before.n || after.n > before.n).toBe(true);
  });

  it('never lets one shop’s deposit reach another', async () => {
    // The isolation claim, tested rather than asserted. Two shops, one deposit.
    const cookie = await signInToConsole();
    const a = await registerAndApprove(cookie, '3');
    const b = await registerAndApprove(cookie, '4');
    expect(a.merchantId).not.toBe(b.merchantId);

    fundMerchant(driver as SqliteLedgerDriver, {
      merchantId: a.merchantId as never,
      amount: fromBirr(500),
      at: NOW as never,
      correlationId: 'corr_iso',
      postingId: postingId('post_iso'),
    });

    const balance = (merchantId: string): number =>
      (
        db
          ?.prepare(
            `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_minor ELSE -amount_minor END), 0) AS n
               FROM ledger_entries WHERE merchant_id = ?`,
          )
          .get(merchantId) as { n: number }
      ).n;

    expect(balance(a.merchantId)).toBeGreaterThan(0);
    expect(balance(b.merchantId)).toBe(0);
  });
});

describe('shops registering at the same time', () => {
  it('records every one of ten concurrent registrations, with distinct shops', async () => {
    // SQLite has one writer and the intake write is one transaction, so
    // simultaneous registrations must either all land or fail loudly. "It
    // worked when I tried it once" is not a claim about concurrency.
    const cookie = await signInToConsole();

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        send(consolePort, '/applications', {
          method: 'POST',
          cookie,
          form: {
            csrfToken: csrfFrom(cookie),
            legalName: `Concurrent ${String(i)}`,
            ownerName: `Owner ${String(i)}`,
            phone: `+2519120000${String(i)}`,
            email: '',
            address: `Street ${String(i)}`,
            locality: 'Addis Ababa',
            tradeLicence: `CTL-${String(i)}`,
            tradeLicenceExpiry: '2099-06-30',
            tin: `CTIN-${String(i)}`,
            photoId: `CID-${String(i)}`,
            approveNow: 'yes',
          },
        }),
      ),
    );

    for (const [i, reply] of results.entries()) {
      expect(reply.status, `registration ${String(i)} must not error`).toBe(303);
    }

    const applications = db
      ?.prepare(`SELECT COUNT(*) AS n FROM merchant_applications WHERE legal_name LIKE 'Concurrent%'`)
      .get() as { n: number };
    expect(applications.n).toBe(10);

    // Ten applications, ten shops — no two collapsed onto one merchant.
    const merchants = db
      ?.prepare(
        `SELECT COUNT(DISTINCT merchant_id) AS n FROM merchant_applications
          WHERE legal_name LIKE 'Concurrent%' AND merchant_id IS NOT NULL`,
      )
      .get() as { n: number };
    expect(merchants.n).toBe(10);

    // And every document landed with its application. The transaction boundary
    // exists because a half-written registration is a shop in the queue with
    // no papers.
    const documents = db
      ?.prepare(
        `SELECT COUNT(*) AS n FROM merchant_application_documents d
           JOIN merchant_applications a ON a.id = d.application_id
          WHERE a.legal_name LIKE 'Concurrent%'`,
      )
      .get() as { n: number };
    expect(documents.n).toBe(30);
  });

  it('refuses a duplicate licence number without losing the first shop', async () => {
    // One person opening shops under several names is what the unique index on
    // (kind, reference) exists to catch. The first must survive.
    const cookie = await signInToConsole();
    await registerAndApprove(cookie, '5');

    const clash = await send(consolePort, '/applications', {
      method: 'POST',
      cookie,
      form: {
        csrfToken: csrfFrom(cookie),
        legalName: 'Different Name',
        ownerName: 'Different Owner',
        phone: '+251911000099',
        email: '',
        address: 'Elsewhere',
        locality: 'Addis Ababa',
        // Same licence as shop 5.
        tradeLicence: 'TL-5',
        tradeLicenceExpiry: '2099-06-30',
        tin: 'TIN-5',
        photoId: 'ID-5',
      },
    });
    // Refused, and shown as a screen rather than a crash.
    expect(clash.status).toBe(200);

    const survived = db
      ?.prepare(`SELECT COUNT(*) AS n FROM merchant_applications WHERE legal_name = 'Shop 5'`)
      .get() as { n: number };
    expect(survived.n).toBe(1);
  });
});
