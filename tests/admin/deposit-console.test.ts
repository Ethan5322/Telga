/**
 * The whole founder flow, over HTTP, in one file.
 *
 * **M3b.** Register a shop, approve it, issue its four sign-in parameters, then
 * pay money in quoting the device key that was just handed over — and watch that
 * shop's balance, and only that shop's, go up.
 *
 * Every earlier test proved one link. This proves the chain, which is a
 * different claim: each piece can be correct while the joins are wrong, and the
 * joins are where a device key issued by one route and looked up by another stop
 * matching.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  SqliteLedgerDriver,
  fundMerchant,
  runMigrations,
  saveAdminUser,
} from '@telga/persistence';
import {
  adminLogin,
  authenticateAdmin,
  beginMfaEnrolment,
  hashAdminSecret,
  satisfyAdminMfa,
  stepUpAdmin,
  totpAt,
} from '@telga/api';
import { fromBirr, postingId as toPostingId } from '@telga/domain';
import type { AdminRole, MerchantId } from '@telga/domain';
import { createConsoleServer } from '../../apps/operations-console/src/server';

const SESSION_COOKIE = 'telga_admin_session';
const PASSWORD = 'a-long-enough-admin-password';
const AT = '2026-09-08T09:00:00.000Z';
const ACCOUNT = '1000123456789';

let dir: string;
let driver: SqliteLedgerDriver;
let db: import('better-sqlite3').Database;
let server: Server | undefined;
let port = 0;
const clock = Date.parse(AT);
const now = (): string => AT;
let idSeq = 0;
const newId = (prefix: string): string => `${prefix}_${String(++idSeq)}`;
const ports = () => ({ db, now, newId });

interface Reply {
  readonly status: number;
  readonly location?: string | undefined;
  readonly body: string;
}

function send(
  path: string,
  init: { method?: string; cookie?: string; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: '127.0.0.1' };
    if (init.cookie !== undefined && init.cookie.length > 0) headers['cookie'] = init.cookie;
    if (init.body !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['content-length'] = String(Buffer.byteLength(init.body));
    }
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          body += c;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, location: res.headers.location, body }),
        );
      },
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

async function signIn(id: string, role: AdminRole = 'PLATFORM_OWNER'): Promise<string> {
  const derived = await hashAdminSecret(PASSWORD);
  saveAdminUser(db, {
    id,
    email: `${id}@telga.example`,
    displayName: id,
    department: 'PLATFORM',
    role,
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
  await stepUpAdmin(ports(), auth.sessionId, id, PASSWORD);
  return `${SESSION_COOKIE}=${encodeURIComponent(result.sessionToken)}`;
}

const shown = (body: string, id: string): string =>
  new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`).exec(body)?.[1]?.trim() ?? '';

const REGISTRATION = {
  legalName: 'Abebe Airtime Shop',
  address: 'Bole Road 12',
  locality: 'Addis Ababa',
  ownerName: 'Abebe Bekele',
  phone: '+251911000000',
  email: '',
  tradeLicence: 'TL/AA/2026/99887',
  tradeLicenceExpiry: '2027-06-30',
  tin: 'TIN-0012345678',
  photoId: 'ID-ETH-4455667',
};

/** Register, review, approve, and issue — returning the four parameters. */
async function onboardShop(
  cookie: string,
  over: Partial<typeof REGISTRATION> = {},
): Promise<{ merchantId: string; deviceKey: string }> {
  const created = await send('/applications', {
    method: 'POST',
    cookie,
    body: new URLSearchParams({ ...REGISTRATION, ...over }).toString(),
  });
  // The id comes from the redirect, not from an `ORDER BY`. Every row in this
  // fixture shares one frozen timestamp, so "the newest application" is not a
  // question the database can answer — and picking the wrong one silently
  // onboarded the second shop onto the first, which is exactly the confusion
  // these tests exist to detect.
  const application = { id: (created.location ?? '').replace('/applications/', '') };
  expect(application.id, 'registration must redirect to the new application').toMatch(/^app_/);

  await send(`/applications/${application.id}/pick-up`, { method: 'POST', cookie, body: '' });
  await send(`/applications/${application.id}/decide`, {
    method: 'POST',
    cookie,
    body: new URLSearchParams({ outcome: 'APPROVE', reason: 'checked' }).toString(),
  });

  const merchantId = String(
    (
      db.prepare(`SELECT merchant_id FROM merchant_applications WHERE id = ?`).get(application.id) as
        | { merchant_id: string }
        | undefined
    )?.merchant_id,
  );

  const issued = await send(`/merchants/${merchantId}/credentials`, {
    method: 'POST',
    cookie,
    body: '',
  });
  return { merchantId, deviceKey: shown(issued.body, 'handover-key') };
}

const depositBody = (over: Record<string, string>): string =>
  new URLSearchParams({
    quotedReference: '',
    claimedAmountBirr: '',
    bankReference: 'FT26090812345',
    bankAmountBirr: '1000',
    creditedAccount: ACCOUNT,
    evidence: 'CBE statement line 14',
    ...over,
  }).toString();

const availableBirr = (merchantId: string): number =>
  driver.balanceFor(merchantId as MerchantId).available.minor / 100;

beforeEach(async () => {
  idSeq = 0;
  dir = mkdtempSync(join(tmpdir(), 'telga-deposit-console-'));
  driver = new SqliteLedgerDriver({ file: join(dir, 'telga.sqlite') });
  runMigrations(driver.unsafeConnection, AT, MIGRATIONS);
  db = driver.unsafeConnection;

  server = createConsoleServer({
    db: db as never,
    now,
    newId,
    schemaVersion: '016',
    allowedHosts: ['127.0.0.1', 'localhost'],
    secureCookies: false,
    depositAccount: ACCOUNT,
    creditMerchant: (input) => {
      fundMerchant(driver, {
        merchantId: input.merchantId as MerchantId,
        amount: fromBirr(input.amountMinor / 100),
        at: input.at as never,
        correlationId: input.correlationId,
        postingId: toPostingId(input.postingId),
      });
    },
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
  driver.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the whole flow', () => {
  it('registers a shop, issues its key, and pays money into that shop', async () => {
    const cookie = await signIn('owner');
    const shop = await onboardShop(cookie);

    expect(availableBirr(shop.merchantId)).toBe(0);

    const reply = await send('/deposits', {
      method: 'POST',
      cookie,
      body: depositBody({ quotedReference: shop.deviceKey, claimedAmountBirr: '1000' }),
    });
    expect(reply.status).toBe(303);

    // The balance an operator would see on the POS.
    expect(availableBirr(shop.merchantId)).toBe(1_000);

    const row = db.prepare(`SELECT * FROM funding_submissions`).get() as Record<string, unknown>;
    expect(row).toMatchObject({
      merchant_id: shop.merchantId,
      status: 'CREDITED',
      bank_amount_minor: 100_000,
      currency: 'ETB',
      decided_by: 'owner',
    });
    expect(row['posting_id']).not.toBeNull();
  });

  it('pays two shops separately, with neither touching the other', async () => {
    const cookie = await signIn('owner');
    const alpha = await onboardShop(cookie);
    const beta = await onboardShop(cookie, {
      legalName: 'Beta Shop',
      tradeLicence: 'TL/AA/2026/00002',
      tin: 'TIN-9999999999',
      photoId: 'ID-ETH-0000002',
    });

    // Two shops, not one twice. Asserted before the money moves, because if
    // this is wrong every balance below is meaningless.
    expect(beta.merchantId).not.toBe(alpha.merchantId);
    expect(beta.deviceKey).not.toBe(alpha.deviceKey);

    await send('/deposits', {
      method: 'POST',
      cookie,
      body: depositBody({ quotedReference: alpha.deviceKey, bankReference: 'FT-A' }),
    });
    await send('/deposits', {
      method: 'POST',
      cookie,
      body: depositBody({
        quotedReference: beta.deviceKey,
        bankReference: 'FT-B',
        bankAmountBirr: '250',
      }),
    });

    expect(availableBirr(alpha.merchantId)).toBe(1_000);
    expect(availableBirr(beta.merchantId)).toBe(250);
  });
});

describe('the queue', () => {
  it('shows what happened, and how many need a person', async () => {
    const cookie = await signIn('owner');
    const shop = await onboardShop(cookie);

    await send('/deposits', {
      method: 'POST',
      cookie,
      body: depositBody({ quotedReference: shop.deviceKey }),
    });
    // An unknown reference: waits for a person, never guessed at a shop.
    await send('/deposits', {
      method: 'POST',
      cookie,
      body: depositBody({ quotedReference: 'NOBODYS-KEY', bankReference: 'FT-UNKNOWN' }),
    });

    const queue = await send('/deposits', { cookie });
    expect(queue.status).toBe(200);
    expect(queue.body).toContain('data-testid="deposit-FT26090812345"');
    expect(queue.body).toContain('data-testid="deposit-FT-UNKNOWN"');
    expect(queue.body).toContain('1 waiting for a decision.');
    expect(queue.body).toContain('MANUAL_REVIEW');
  });

  it('never shows a guessed shop for an unmatched deposit', async () => {
    const cookie = await signIn('owner');
    await onboardShop(cookie);
    await send('/deposits', {
      method: 'POST',
      cookie,
      body: depositBody({ quotedReference: 'NOBODYS-KEY' }),
    });

    const row = db.prepare(`SELECT merchant_id FROM funding_submissions`).get() as {
      merchant_id: string | null;
    };
    expect(row.merchant_id).toBeNull();
  });
});

describe('what the console refuses', () => {
  it('credits nothing when the bank fields are left empty', async () => {
    // Empty bank fields mean "the bank has no such transaction". CLAUDE.md L128
    // and L402: never credit from a claim alone.
    const cookie = await signIn('owner');
    const shop = await onboardShop(cookie);

    await send('/deposits', {
      method: 'POST',
      cookie,
      body: depositBody({
        quotedReference: shop.deviceKey,
        bankAmountBirr: '',
        creditedAccount: '',
        claimedAmountBirr: '5000',
      }),
    });

    expect(availableBirr(shop.merchantId)).toBe(0);
    expect(db.prepare(`SELECT status FROM funding_submissions`).get()).toMatchObject({
      status: 'REJECTED',
    });
  });

  it('holds a deposit over the cap without crediting it', async () => {
    const cookie = await signIn('owner');
    const shop = await onboardShop(cookie);

    await send('/deposits', {
      method: 'POST',
      cookie,
      body: depositBody({ quotedReference: shop.deviceKey, bankAmountBirr: '60000' }),
    });

    expect(availableBirr(shop.merchantId)).toBe(0);
    expect(db.prepare(`SELECT status, merchant_id FROM funding_submissions`).get()).toMatchObject({
      status: 'MATCHED',
      merchant_id: shop.merchantId,
    });
  });

  it('refuses a deposit with no bank reference', async () => {
    const cookie = await signIn('owner');
    const shop = await onboardShop(cookie);
    const reply = await send('/deposits', {
      method: 'POST',
      cookie,
      body: depositBody({ quotedReference: shop.deviceKey, bankReference: '' }),
    });
    expect(reply.body).toContain('BANK_REFERENCE_REQUIRED');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM funding_submissions`).get()).toMatchObject({ n: 0 });
  });

  it('keeps the shop’s device key out of the audit trail', async () => {
    // Under D125 the quoted reference *is* the device key. An audit screen
    // carrying it would hand a credential to every reader of the trail.
    const cookie = await signIn('owner');
    const shop = await onboardShop(cookie);
    await send('/deposits', {
      method: 'POST',
      cookie,
      body: depositBody({ quotedReference: shop.deviceKey }),
    });

    const rows = db.prepare(`SELECT metadata FROM audit_events`).all() as {
      metadata: string | null;
    }[];
    const all = rows.map((r) => r.metadata ?? '').join(' ');
    expect(all).toContain('FT26090812345');
    expect(all).not.toContain(shop.deviceKey);
  });
});

describe('who may record one', () => {
  it('refuses an auditor, who may read the queue and change nothing', async () => {
    const owner = await signIn('owner');
    const shop = await onboardShop(owner);
    const reader = await signIn('reader', 'AUDITOR');

    const reply = await send('/deposits', {
      method: 'POST',
      cookie: reader,
      body: depositBody({ quotedReference: shop.deviceKey }),
    });
    expect(reply.status).toBe(403);
    expect(availableBirr(shop.merchantId)).toBe(0);
  });

  it('refuses an unauthenticated caller', async () => {
    const owner = await signIn('owner');
    const shop = await onboardShop(owner);
    const reply = await send('/deposits', {
      method: 'POST',
      body: depositBody({ quotedReference: shop.deviceKey }),
    });
    expect(reply.status).toBe(303);
    expect(availableBirr(shop.merchantId)).toBe(0);
  });
});
