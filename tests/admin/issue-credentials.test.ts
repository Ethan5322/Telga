/**
 * The four sign-in parameters, generated and handed over.
 *
 * **M2** — the founder's Steps 5 and 6. The test that matters most is the last
 * one: the parameters an admin writes down at a shop are checked against the
 * same verification the POS performs at sign-in. Generating credentials that
 * look right and do not work is the failure this file exists to rule out, and it
 * is not visible from the console alone.
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
  newTemporaryPin,
  satisfyAdminMfa,
  stepUpAdmin,
  totpAt,
  verifySecret,
} from '@telga/api';
import { pinRejection } from '@telga/domain';
import type { AdminRole } from '@telga/domain';
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

function seedMerchant(id = 'mch_ALPHA'): string {
  db.prepare(
    `INSERT INTO merchants (id, status, mode, created_at, updated_at)
     VALUES (?, 'ONBOARDING', 'TRAINING', ?, ?)`,
  ).run(id, AT, AT);
  return id;
}

const issue = (cookie: string, merchantId = 'mch_ALPHA'): Promise<Reply> =>
  send(`/merchants/${merchantId}/credentials`, { method: 'POST', cookie, body: '' });

/** Pull a value out of the hand-over table by its test id. */
const shown = (body: string, id: string): string =>
  new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`).exec(body)?.[1]?.trim() ?? '';

beforeEach(async () => {
  idSeq = 0;
  dir = mkdtempSync(join(tmpdir(), 'telga-credentials-'));
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

describe('issuing the four parameters', () => {
  it('creates an operator, a device and its enrolment', async () => {
    seedMerchant();
    const cookie = await signIn('owner');

    const reply = await issue(cookie);
    expect(reply.status).toBe(200);

    const operator = db.prepare(`SELECT * FROM merchant_users`).get() as Record<string, unknown>;
    const device = db.prepare(`SELECT * FROM devices`).get() as Record<string, unknown>;
    const enrolment = db.prepare(`SELECT * FROM device_enrollments`).get() as Record<string, unknown>;

    expect(operator).toMatchObject({
      merchant_id: 'mch_ALPHA',
      role: 'MERCHANT_OWNER',
      status: 'ACTIVE',
      // The whole point of a temporary PIN: it must be replaced at first login.
      must_change_pin: 1,
    });
    expect(device).toMatchObject({ merchant_id: 'mch_ALPHA', status: 'ACTIVE' });
    expect(enrolment).toMatchObject({ merchant_id: 'mch_ALPHA', enrollment_state: 'ENROLLED' });
  });

  it('shows all four, with the ids the founder asked for', async () => {
    seedMerchant();
    const cookie = await signIn('owner');
    const reply = await issue(cookie);

    expect(shown(reply.body, 'handover-merchant')).toBe('mch_ALPHA');
    expect(shown(reply.body, 'handover-operator')).toBe('operator_0001');
    expect(shown(reply.body, 'handover-device')).toBe('device_0001');
    // 43 characters, base64url, exactly as specified.
    expect(shown(reply.body, 'handover-key')).toHaveLength(43);
    expect(shown(reply.body, 'handover-pin')).toMatch(/^\d{6}$/);
  });

  it('says the parameters cannot be shown again', async () => {
    seedMerchant();
    const cookie = await signIn('owner');
    const reply = await issue(cookie);
    expect(reply.body).toContain('Shown once');
    expect(reply.body).toContain('cannot');
  });

  it('numbers the next shop 0002, not 0001 again', async () => {
    seedMerchant('mch_ALPHA');
    seedMerchant('mch_BETA');
    const cookie = await signIn('owner');

    await issue(cookie, 'mch_ALPHA');
    const second = await issue(cookie, 'mch_BETA');

    expect(shown(second.body, 'handover-operator')).toBe('operator_0002');
    expect(shown(second.body, 'handover-device')).toBe('device_0002');
  });
});

describe('what is stored and what is not', () => {
  it('keeps only hashes — the key and PIN are nowhere in the database', async () => {
    seedMerchant();
    const cookie = await signIn('owner');
    const reply = await issue(cookie);
    const key = shown(reply.body, 'handover-key');
    const pin = shown(reply.body, 'handover-pin');

    // Dump every text column of every table and look for either secret.
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
    ).map((t) => t.name);
    for (const table of tables) {
      const rows = db.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
      const dump = JSON.stringify(rows);
      expect(dump, `${table} must not contain the device key`).not.toContain(key);
      expect(dump, `${table} must not contain the PIN`).not.toContain(pin);
    }
  });

  it('records the issue without recording the secrets', async () => {
    seedMerchant();
    const cookie = await signIn('owner');
    const reply = await issue(cookie);
    const key = shown(reply.body, 'handover-key');

    const events = db
      .prepare(`SELECT event_type, metadata FROM audit_events WHERE event_type = ?`)
      .all('ADMIN_CREDENTIALS_ISSUED') as { metadata: string | null }[];
    expect(events).toHaveLength(1);
    expect(String(events[0]?.metadata)).toContain('operator_0001');
    expect(String(events[0]?.metadata)).not.toContain(key);
  });
});

describe('who may issue', () => {
  it('refuses an auditor', async () => {
    seedMerchant();
    const cookie = await signIn('reader', 'AUDITOR');
    const reply = await issue(cookie);
    expect(reply.status).toBe(403);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM devices`).get()).toMatchObject({ n: 0 });
  });

  it('refuses an unauthenticated caller', async () => {
    seedMerchant();
    const reply = await issue('');
    expect(reply.status).toBe(303);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM merchant_users`).get()).toMatchObject({ n: 0 });
  });

  it('refuses a merchant that does not exist, and creates nothing', async () => {
    const cookie = await signIn('owner');
    const reply = await issue(cookie, 'mch_NOT_A_SHOP');
    expect(reply.status).toBe(404);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM devices`).get()).toMatchObject({ n: 0 });
  });
});

describe('the parameters actually work', () => {
  it('verifies against the stored hashes, the way sign-in does', async () => {
    // The test that makes the rest worth having. Everything above proves the
    // right *shape* was produced; this proves the shop can use it. Credentials
    // that look correct and do not authenticate are the failure a console test
    // cannot otherwise see.
    seedMerchant();
    const cookie = await signIn('owner');
    const reply = await issue(cookie);

    const key = shown(reply.body, 'handover-key');
    const pin = shown(reply.body, 'handover-pin');

    const enrolment = db.prepare(`SELECT * FROM device_enrollments`).get() as {
      secret_hash: string;
      secret_salt: string;
    };
    const operator = db.prepare(`SELECT * FROM merchant_users`).get() as {
      pin_hash: string;
      pin_salt: string;
      pin_params: string;
    };

    // The device key, verified exactly as `sessions.ts` verifies it at sign-in.
    await expect(
      verifySecret(key, {
        hash: enrolment.secret_hash,
        salt: enrolment.secret_salt,
        params: 'scrypt$N=16384,r=8,p=1,len=64',
      }),
    ).resolves.toBe(true);

    // And the PIN.
    await expect(
      verifySecret(pin, {
        hash: operator.pin_hash,
        salt: operator.pin_salt,
        params: operator.pin_params,
      }),
    ).resolves.toBe(true);

    // A wrong key does not.
    await expect(
      verifySecret('not-the-key', {
        hash: enrolment.secret_hash,
        salt: enrolment.secret_salt,
        params: 'scrypt$N=16384,r=8,p=1,len=64',
      }),
    ).resolves.toBe(false);
  });
});

describe('the temporary PIN', () => {
  it('is six digits and never one the PIN rules would refuse', async () => {
    // `111111` and `123456` are the first guesses anybody makes, and a shop
    // handed one has a PIN its operator may never bother changing.
    for (let i = 0; i < 500; i += 1) {
      const pin = newTemporaryPin();
      expect(pin).toMatch(/^\d{6}$/);
      expect(pinRejection(pin), pin).toBeUndefined();
    }
  });

  it('is not predictable from the ones before it', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(newTemporaryPin());
    // Some collisions are expected in 500 draws from ~10^6; a generator with a
    // small period would show far fewer distinct values than this.
    expect(seen.size).toBeGreaterThan(490);
  });
});
