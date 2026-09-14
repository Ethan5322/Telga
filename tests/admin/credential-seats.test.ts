/**
 * Two live credential sets per shop, and the third retires one.
 *
 * Founder instruction, 2026-09-14: *"registered Telga shop issue two times, but
 * third issue must lock one of the accounts by asking which one you should
 * suspend."*
 *
 * ## Why a seat limit and not a lifetime cap
 *
 * The first version of this question was "refuse the third", and that is the
 * version that breaks a real shop: lose two devices over a year and the shop is
 * permanently locked out, with no override anywhere in the console. A seat
 * limit lets a shop re-credential forever and never accumulate live keys it has
 * lost track of.
 *
 * That matters because `Device Binding` A52 records that a copied device key is
 * indistinguishable from the original. A forgotten credential set is a working
 * key nobody will notice being used.
 *
 * ## Why the admin chooses
 *
 * The console cannot tell which machine was lost and which is on the counter
 * taking money. Choosing for them means guessing, and the wrong guess stops the
 * till that works.
 */

import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, runMigrations, saveAdminUser } from '@telga/persistence';
import { hashAdminSecret } from '@telga/api';
import { createConsoleServer } from '@telga/operations-console';

const NOW = '2026-09-14T10:00:00.000Z';
let dir: string;
let db: Database.Database;
let server: Server | undefined;
let port = 0;
let nextId = 1;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'telga-seats-'));
  db = new Database(join(dir, 'ops.sqlite'));
  db.pragma('foreign_keys = ON');
  runMigrations(db as never, NOW as never, MIGRATIONS as never);

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

  db.prepare(
    `INSERT INTO merchants (id, status, mode, created_at, updated_at)
     VALUES ('shop_a', 'ACTIVE', 'TRAINING', ?, ?)`,
  ).run(NOW, NOW);

  nextId = 1;
  server = createConsoleServer({
    db: db as never,
    now: () => NOW,
    newId: (p: string) => `${p}_${String(nextId++)}`,
    schemaVersion: '022',
    secureCookies: false,
    singleFactorAuth: true,
  } as never);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  port = (server?.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server === undefined) return resolve();
    server.close(() => resolve());
  });
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(
  method: string,
  path: string,
  options: { cookie?: string; form?: Record<string, string> } = {},
): Promise<{ status: number; body: string; cookies: string[] }> {
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

async function signIn(): Promise<string> {
  const first = await call('GET', '/login');
  const jar = first.cookies.map((c) => c.split(';')[0]).join('; ');
  const reply = await call('POST', '/login', {
    cookie: jar,
    form: { email: 'owner@telga.example', password: 'ConsolePassword1' },
  });
  return [...first.cookies, ...reply.cookies].map((c) => c.split(';')[0]).join('; ');
}

const issue = (cookie: string, form: Record<string, string> = {}) =>
  call('POST', '/merchants/shop_a/credentials', { cookie, form });

const live = (): { id: string; status: string }[] =>
  db
    .prepare(
      `SELECT id, status FROM devices
        WHERE merchant_id = 'shop_a' AND status IN ('ACTIVE','REGISTERED') ORDER BY created_at`,
    )
    .all() as { id: string; status: string }[];

describe('the first two sets are issued without a question', () => {
  it('gives a shop two live credential sets', async () => {
    const cookie = await signIn();
    await issue(cookie);
    expect(live()).toHaveLength(1);
    await issue(cookie);
    expect(live()).toHaveLength(2);
  });
});

describe('the third asks which to retire', () => {
  it('issues nothing until the question is answered', async () => {
    const cookie = await signIn();
    await issue(cookie);
    await issue(cookie);

    const third = await issue(cookie);
    expect(third.status).toBe(200);
    expect(third.body).toContain('data-testid="retire-device-form"');

    // Nothing was created and nothing was stopped: an admin who closes this
    // screen leaves the shop exactly as it was.
    expect(live()).toHaveLength(2);
    expect(live().every((d) => d.status === 'ACTIVE')).toBe(true);
  });

  it('offers exactly the shop’s own live devices to choose from', async () => {
    const cookie = await signIn();
    await issue(cookie);
    await issue(cookie);
    const before = live();

    const third = await issue(cookie);
    for (const device of before) {
      expect(third.body).toContain(`retire-option-${device.id}`);
    }
  });
});

describe('answering it', () => {
  it('retires the named device and issues a new set, staying at two', async () => {
    const cookie = await signIn();
    await issue(cookie);
    await issue(cookie);
    const [first, second] = live();

    await issue(cookie, { retireDeviceId: first.id });

    const after = live();
    expect(after).toHaveLength(2);
    // The one named is gone from the live set; the other kept trading.
    expect(after.map((d) => d.id)).not.toContain(first.id);
    expect(after.map((d) => d.id)).toContain(second.id);

    const stopped = db
      .prepare(`SELECT status FROM devices WHERE id = ?`)
      .get(first.id) as { status: string };
    expect(stopped.status).toBe('STOPPED');
  });

  it('records why the device stopped, not merely that it did', async () => {
    const cookie = await signIn();
    await issue(cookie);
    await issue(cookie);
    const [first] = live();
    await issue(cookie, { retireDeviceId: first.id });

    const events = db
      .prepare(`SELECT event_type, metadata FROM audit_events WHERE entity_id = ?`)
      .all(first.id) as { event_type: string; metadata: string | null }[];
    const stop = events.find((e) => e.event_type === 'ADMIN_DEVICE_STOPPED');
    expect(stop, 'the retirement is audited').toBeDefined();
    // A device retired to make room reads differently from one stopped for loss.
    expect(stop?.metadata ?? '').toContain('RETIRED_FOR_REISSUE');
  });
});

describe('what it refuses', () => {
  it('will not retire a device belonging to another shop', async () => {
    db.prepare(
      `INSERT INTO merchants (id, status, mode, created_at, updated_at)
       VALUES ('shop_b', 'ACTIVE', 'TRAINING', ?, ?)`,
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO devices (id, merchant_id, status, device_type, created_at, updated_at)
       VALUES ('device_other', 'shop_b', 'ACTIVE', 'SMART_POS', ?, ?)`,
    ).run(NOW, NOW);

    const cookie = await signIn();
    await issue(cookie);
    await issue(cookie);

    const reply = await issue(cookie, { retireDeviceId: 'device_other' });
    expect(reply.status).toBe(404);

    // The other shop's device is untouched, and shop_a gained nothing.
    const other = db
      .prepare(`SELECT status FROM devices WHERE id = 'device_other'`)
      .get() as { status: string };
    expect(other.status).toBe('ACTIVE');
    expect(live()).toHaveLength(2);
  });
});
