/**
 * Approving a queued shop transfer — `CLAUDE.md` §19.1.
 *
 * ## The report this closes
 *
 * From the deployment, 2026-09-12: *"I sent an amount from one shop to another
 * yesterday and it still hasn't arrived, even though the device key matches."*
 *
 * A transfer above the approval threshold is saved `NEEDS_APPROVAL` with **no
 * ledger entry** — the sender still holds the money and the recipient has never
 * seen it, which is what "awaiting approval" has to mean. But **no console route
 * read `shop_transfers` at all**, so nothing could ever decide one.
 * `listTransferQueue` had existed since migration 019 with no caller.
 *
 * The same shape as the stranded high-value deposit found two days earlier: a
 * status only a control could move, and the control was never built. Both were
 * found by asking which declared capability nothing exercises.
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

const NOW = '2026-09-12T10:00:00.000Z';

let dir: string;
let db: Database.Database | undefined;
let server: Server | undefined;
let port = 0;
let posted: { from: string; to: string; amountMinor: number }[] = [];
let nextId = 1;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'telga-transfer-'));
  db = new Database(join(dir, 'ops.sqlite'));
  db.pragma('foreign_keys = ON');
  runMigrations(db as never, NOW as never);

  const secret = await hashAdminSecret('ConsolePassword1');
  saveAdminUser(db as never, {
    id: 'adm_1',
    email: 'owner@telga.example',
    displayName: 'Owner',
    department: 'FINANCE',
    role: 'PLATFORM_OWNER',
    passwordHash: secret.hash,
    passwordSalt: secret.salt,
    passwordParams: secret.params,
    status: 'ACTIVE',
    at: NOW,
  });

  for (const id of ['shop_a', 'shop_b']) {
    db.prepare(
      `INSERT INTO merchants (id, status, mode, created_at, updated_at)
       VALUES (?, 'ACTIVE', 'TRAINING', ?, ?)`,
    ).run(id, NOW, NOW);
  }
  // Both tills must exist: `shop_transfers` has a foreign key on each.
  for (const [device, shop] of [
    ['till_a', 'shop_a'],
    ['till_b', 'shop_b'],
  ]) {
    db.prepare(
      `INSERT INTO devices (id, merchant_id, status, device_type, created_at, updated_at)
       VALUES (?, ?, 'ACTIVE', 'SMART_POS', ?, ?)`,
    ).run(device, shop, NOW, NOW);
  }

  // A transfer over the 10,000 birr threshold: queued, and nothing has moved.
  db.prepare(
    `INSERT INTO shop_transfers
       (id, sender_merchant_id, sender_device_id, sender_operator_id,
        recipient_device_id, recipient_merchant_id, amount_minor, fee_minor,
        status, correlation_id, mode, created_at, updated_at)
     VALUES ('trf_1', 'shop_a', 'till_a', 'op_a', 'till_b', 'shop_b',
             1500000, 0, 'NEEDS_APPROVAL', 'corr_1', 'TRAINING', ?, ?)`,
  ).run(NOW, NOW);

  posted = [];
  nextId = 1;
  server = createConsoleServer({
    db: db as never,
    now: () => NOW,
    newId: (prefix: string) => `${prefix}_${String(nextId++)}`,
    schemaVersion: '022',
    secureCookies: false,
    singleFactorAuth: true,
    creditMerchant: () => undefined,
    postTransfer: (input: { senderMerchantId: string; recipientMerchantId: string; amountMinor: number }) => {
      posted.push({
        from: input.senderMerchantId,
        to: input.recipientMerchantId,
        amountMinor: input.amountMinor,
      });
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

function call(
  method: string,
  path: string,
  options: { cookie?: string; form?: Record<string, string> } = {},
): Promise<{ status: number; location: string; cookies: string[] }> {
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
        res.resume();
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            location: String(res.headers['location'] ?? ''),
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

async function signIn(): Promise<string> {
  const first = await call('GET', '/login');
  const jar = first.cookies.map((c) => c.split(';')[0]).join('; ');
  const reply = await call('POST', '/login', {
    cookie: jar,
    form: { email: 'owner@telga.example', password: 'ConsolePassword1' },
  });
  return [...first.cookies, ...reply.cookies].map((c) => c.split(';')[0]).join('; ');
}

const statusOf = (): string =>
  (db?.prepare(`SELECT status FROM shop_transfers WHERE id = 'trf_1'`).get() as { status: string })
    .status;

describe('a queued transfer can finally be approved', () => {
  it('posts both sides and marks it settled', async () => {
    const cookie = await signIn();
    const reply = await call('POST', '/transfers/trf_1/approve', { cookie, form: {} });

    expect(reply.status).toBe(303);
    expect(statusOf()).toBe('SETTLED');
    // The money moves here and nowhere earlier.
    expect(posted).toEqual([{ from: 'shop_a', to: 'shop_b', amountMinor: 1_500_000 }]);
  });

  it('records who approved it and the posting', async () => {
    const cookie = await signIn();
    await call('POST', '/transfers/trf_1/approve', { cookie, form: {} });

    const row = db
      ?.prepare(`SELECT approved_by, posting_id FROM shop_transfers WHERE id = 'trf_1'`)
      .get() as { approved_by: string | null; posting_id: string | null };
    expect(row.approved_by).toBe('adm_1');
    // "Where did this shop's money go" must be answerable from one row.
    expect(row.posting_id).not.toBeNull();
  });
});

describe('it cannot move twice', () => {
  it('refuses a replayed approval', async () => {
    const cookie = await signIn();
    await call('POST', '/transfers/trf_1/approve', { cookie, form: {} });
    const again = await call('POST', '/transfers/trf_1/approve', { cookie, form: {} });

    expect(decodeURIComponent(again.location)).toContain('Already decided');
    // The claim is the lock: one posting, not two.
    expect(posted).toHaveLength(1);
  });
});

describe('refusing', () => {
  it('moves nothing and keeps the money with the sender', async () => {
    const cookie = await signIn();
    const reply = await call('POST', '/transfers/trf_1/refuse', {
      cookie,
      form: { reason: 'Sender could not confirm the recipient.' },
    });

    expect(statusOf()).toBe('REFUSED');
    // Nothing is returned because nothing ever left.
    expect(posted).toEqual([]);
    expect(decodeURIComponent(reply.location)).toContain('sender still holds');
  });

  it('requires a reason', async () => {
    const cookie = await signIn();
    const reply = await call('POST', '/transfers/trf_1/refuse', { cookie, form: { reason: '  ' } });

    expect(decodeURIComponent(reply.location)).toContain('reason is required');
    // Still waiting, not silently refused.
    expect(statusOf()).toBe('NEEDS_APPROVAL');
  });
});

describe('who may decide', () => {
  it('refuses an unauthenticated caller', async () => {
    const reply = await call('POST', '/transfers/trf_1/approve', { form: {} });
    expect(reply.status).toBeGreaterThanOrEqual(300);
    expect(posted).toEqual([]);
    expect(statusOf()).toBe('NEEDS_APPROVAL');
  });
});
