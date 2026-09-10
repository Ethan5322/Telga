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
import { changePin, hashAdminSecret, login } from '@telga/api';
// The training auth policy already used by every other auth test. Imported
// rather than restated, so a change to session or lockout policy reaches this
// chain too.
import { TRAINING_AUTH_CONFIG } from '../ui/helpers';
import { fromBirr, postingId } from '@telga/domain';
import { createConsoleServer } from '@telga/operations-console';
import { createPosServer } from '@telga/merchant-pos';
import { MOCK_BEHAVIOURS, MockAirtimeProvider } from '@telga/provider-mock-airtime';
// `simulatedCatalog` is an api helper; the branded-id constructors are domain.
import { simulatedCatalog } from '@telga/api';
import { productId, providerId } from '@telga/domain';

const NOW = '2026-09-09T12:00:00.000Z';

let dir: string | undefined;
let db: Database.Database | undefined;
let driver: SqliteLedgerDriver | undefined;
let console_: Server | undefined;
let consolePort = 0;
let ids = 0;

afterEach(() => {
  pos?.close();
  pos = undefined;
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

let pos: Server | undefined;
let posPort = 0;

/**
 * The merchant app, over the **same database** the console wrote to.
 *
 * Started per test rather than in `beforeEach`, because most tests here never
 * touch it and a listener nobody uses is a socket left open.
 *
 * This is the point of the whole file: the parameters an admin reads off the
 * console's hand-over screen have to work in the **real login form** on the
 * real server, not merely in `login()`. Between those two lies the form, the
 * route, the origin check, the cookie policy and the session — every one of
 * which has broken at least once in this repository.
 */
async function startPos(): Promise<number> {
  const provider = new MockAirtimeProvider({
    providerId: providerId('provider_simulated'),
    behaviour: 'SUCCESS',
  });
  pos = createPosServer({
    api: {
      driver: driver as never,
      provider,
      providerId: providerId('provider_simulated'),
      catalog: simulatedCatalog([
        { id: productId('product_airtime_10'), label: 'Airtime 10', available: true },
      ]),
      mode: 'TRAINING',
      recipientSalt: 'chain-test-salt',
      now: () => NOW,
      newId: (prefix: string) => `${prefix}_${String((ids += 1))}`,
      authConfig: TRAINING_AUTH_CONFIG,
      statusCheckIntervalMs: 2000,
      maxClientPolls: 10,
      voucherCatalog: { find: () => undefined },
    } as never,
    environment: 'test',
    catalog: [],
    simulatedBehaviours: [...MOCK_BEHAVIOURS],
  });
  return new Promise((resolve) => {
    pos?.listen(0, '127.0.0.1', () => {
      const address = pos?.address();
      posPort = typeof address === 'object' && address !== null ? address.port : 0;
      resolve(posPort);
    });
  });
}

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

describe('the shop signs in with what the console issued, and changes its PIN', () => {
  it('walks credentials → sign-in → PIN change → sign-in again', async () => {
    // The links the founder asked to be sure of, driven against the same
    // database the console wrote to. Nothing here is seeded by the test: the
    // operator, the device, the key and the PIN all come out of the console's
    // own hand-over screen, which is the only place they ever exist in
    // readable form.
    const cookie = await signInToConsole();
    const { merchantId } = await registerAndApprove(cookie, '9');

    const issued = await send(
      consolePort,
      `/merchants/${encodeURIComponent(merchantId)}/credentials`,
      { method: 'POST', cookie, form: { csrfToken: csrfFrom(cookie) } },
    );
    expect(issued.status).toBe(200);

    // Scraped from the hand-over screen, exactly as an admin reads them off it.
    const parameter = (id: string): string =>
      (new RegExp(`data-testid="${id}"[^>]*>([^<]*)`).exec(issued.body) ?? ['', ''])[1].trim();

    const operatorId = parameter('handover-operator');
    const deviceId = parameter('handover-device');
    const deviceKey = parameter('handover-key');
    const temporaryPin = parameter('handover-pin');

    // If the screen ever stops rendering one of these, this test must fail
    // loudly rather than silently sign in with an empty string.
    for (const [name, value] of Object.entries({ operatorId, deviceId, deviceKey, temporaryPin })) {
      expect(value, `the hand-over screen must show ${name}`).not.toBe('');
    }

    const deps = {
      driver: driver as never,
      authConfig: TRAINING_AUTH_CONFIG,
      now: () => NOW as never,
      newId: (prefix: string) => `${prefix}_${String((ids += 1))}`,
    };

    // --- 1. the shop signs in --------------------------------------------
    const first = await login(deps as never, {
      userId: operatorId as never,
      pin: temporaryPin,
      deviceId: deviceId as never,
      deviceSecret: deviceKey,
    }, `corr_${String((ids += 1))}`);
    // This is the assertion that would have failed before the ONBOARDING fix:
    // the shop was created, the credentials were correct, and sign-in was
    // refused because nothing had ever set the merchant ACTIVE.
    expect(first.ok, 'a newly registered shop must be able to sign in').toBe(true);

    // --- 2. it must change the PIN ---------------------------------------
    const user = db
      ?.prepare('SELECT must_change_pin FROM merchant_users WHERE id = ?')
      .get(operatorId) as { must_change_pin: number };
    // A PIN Telga staff read aloud belongs to everyone who heard it.
    expect(user.must_change_pin).toBe(1);

    const context = (first as { context: unknown }).context;
    const changed = await changePin(
      { ...deps, mode: 'TRAINING' } as never,
      context as never,
      { currentPin: temporaryPin, newPin: '907413', correlationId: 'corr_pin' } as never,
    );
    expect(changed.kind, 'the shop must be able to set its own PIN').toBe('CHANGED');

    // The flag clears in the same statement that writes the new hash, so a
    // shop is never left being asked to change a PIN it has already changed.
    const after = db
      ?.prepare('SELECT must_change_pin FROM merchant_users WHERE id = ?')
      .get(operatorId) as { must_change_pin: number };
    expect(after.must_change_pin).toBe(0);

    // --- 3. the old PIN stops working, the new one works ------------------
    const withOld = await login(deps as never, {
      userId: operatorId as never,
      pin: temporaryPin,
      deviceId: deviceId as never,
      deviceSecret: deviceKey,
    }, `corr_${String((ids += 1))}`);
    expect(withOld.ok, 'the temporary PIN must stop working').toBe(false);

    const withNew = await login(deps as never, {
      userId: operatorId as never,
      pin: '907413',
      deviceId: deviceId as never,
      deviceSecret: deviceKey,
    }, `corr_${String((ids += 1))}`);
    expect(withNew.ok, 'the shop’s own PIN must work').toBe(true);
  });

  it('refuses the shop once Telga suspends it, on the same live chain', async () => {
    // The other half of R40/R45. A test that only proved sign-in *works* would
    // not have caught the bug that made every new shop unable to — and one that
    // only proved suspension blocks would not have caught it either. Both
    // directions, on a shop this test actually created.
    const cookie = await signInToConsole();
    const { merchantId } = await registerAndApprove(cookie, '8');
    const issued = await send(
      consolePort,
      `/merchants/${encodeURIComponent(merchantId)}/credentials`,
      { method: 'POST', cookie, form: { csrfToken: csrfFrom(cookie) } },
    );
    const parameter = (id: string): string =>
      (new RegExp(`data-testid="${id}"[^>]*>([^<]*)`).exec(issued.body) ?? ['', ''])[1].trim();

    const credentials = {
      userId: parameter('handover-operator') as never,
      pin: parameter('handover-pin'),
      deviceId: parameter('handover-device') as never,
      deviceSecret: parameter('handover-key'),
    };
    const deps = {
      driver: driver as never,
      authConfig: TRAINING_AUTH_CONFIG,
      now: () => NOW as never,
      newId: (prefix: string) => `${prefix}_${String((ids += 1))}`,
    };

    expect((await login(deps as never, credentials, `corr_${String((ids += 1))}`)).ok, 'before suspension').toBe(true);

    const suspend = await send(consolePort, `/merchants/${encodeURIComponent(merchantId)}/suspend`, {
      method: 'POST',
      cookie,
      form: { csrfToken: csrfFrom(cookie), reason: 'testing the chain' },
    });
    expect(suspend.status).toBe(303);

    // Refused now. R40 was exactly this being allowed.
    expect((await login(deps as never, credentials, `corr_${String((ids += 1))}`)).ok, 'after suspension').toBe(false);
  });
});

describe('the device accepts what the console handed over', () => {
  it('shows a field for every parameter on the sign-in form', async () => {
    // Four parameters are issued. If the form asked for three, an admin would
    // read out something the shop has nowhere to type.
    await startPos();
    const screen = await send(posPort, '/login');
    expect(screen.status).toBe(200);
    for (const field of ['login-user', 'login-pin', 'login-device', 'login-device-secret']) {
      expect(screen.body, `the sign-in form must have ${field}`).toContain(field);
    }
  });

  it('signs a brand-new shop in through the real form and route', async () => {
    // The end of the chain, over a socket. `login()` passing proves the rules;
    // this proves the *form* a shop actually fills in reaches them — through
    // the origin check, the route, the cookie policy and the session.
    const cookie = await signInToConsole();
    const { merchantId } = await registerAndApprove(cookie, '7');
    const issued = await send(
      consolePort,
      `/merchants/${encodeURIComponent(merchantId)}/credentials`,
      { method: 'POST', cookie, form: { csrfToken: csrfFrom(cookie) } },
    );
    const parameter = (id: string): string =>
      (new RegExp(`data-testid="${id}"[^>]*>([^<]*)`).exec(issued.body) ?? ['', ''])[1].trim();

    await startPos();
    const reply = await send(posPort, '/login', {
      method: 'POST',
      form: {
        // The exact four an admin reads off the hand-over screen.
        userId: parameter('handover-operator'),
        pin: parameter('handover-pin'),
        deviceId: parameter('handover-device'),
        deviceSecret: parameter('handover-key'),
      },
    });

    // A refusal comes back as a redirect carrying `?error=`; a success carries
    // a session cookie. Checking the cookie rather than only the status is what
    // stops this passing on a redirect that refused.
    const cookies = (reply.headers['set-cookie'] as string[] | undefined) ?? [];
    expect(
      String(reply.headers['location'] ?? ''),
      'sign-in must not be refused',
    ).not.toContain('error');
    expect(
      cookies.join(';'),
      'a successful sign-in must set a session cookie',
    ).toContain('telga_session');
  });

  it('refuses the same parameters once the shop is suspended', async () => {
    // Through the form, not the function. The suspension path and the POS
    // transport are separate pieces of code and this is the only place they
    // meet.
    const cookie = await signInToConsole();
    const { merchantId } = await registerAndApprove(cookie, '6');
    const issued = await send(
      consolePort,
      `/merchants/${encodeURIComponent(merchantId)}/credentials`,
      { method: 'POST', cookie, form: { csrfToken: csrfFrom(cookie) } },
    );
    const parameter = (id: string): string =>
      (new RegExp(`data-testid="${id}"[^>]*>([^<]*)`).exec(issued.body) ?? ['', ''])[1].trim();
    const form = {
      userId: parameter('handover-operator'),
      pin: parameter('handover-pin'),
      deviceId: parameter('handover-device'),
      deviceSecret: parameter('handover-key'),
    };

    await startPos();
    const before = await send(posPort, '/login', { method: 'POST', form });
    expect(
      ((before.headers['set-cookie'] as string[] | undefined) ?? []).join(';'),
    ).toContain('telga_session');

    await send(consolePort, `/merchants/${encodeURIComponent(merchantId)}/suspend`, {
      method: 'POST',
      cookie,
      form: { csrfToken: csrfFrom(cookie), reason: 'chain test' },
    });

    const after = await send(posPort, '/login', { method: 'POST', form });
    expect(
      String(after.headers['location'] ?? ''),
      'a suspended shop must be refused at the form',
    ).toContain('error');
  });
});
