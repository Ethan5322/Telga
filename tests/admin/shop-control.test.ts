/**
 * Stopping a shop trading, and letting it start again.
 *
 * **M4.** Two controls that look similar and are not:
 *
 *   - **Suspending a merchant** stops that shop selling on every device it owns.
 *   - **Stopping a device** stops one machine while the shop carries on — R14's
 *     case, a POS lost or stolen and a business still open.
 *
 * Both are real, not display changes: `createSale.ts` refuses a merchant whose
 * status is not `ACTIVE` (line 142) and a device whose status is not `ACTIVE`
 * (line 150). The tests below assert the rows those two checks read.
 *
 * ## The rule both controls are bounded by
 *
 * `05 Operations/Merchant Onboarding` and `09 Engineering/Security Model` say it
 * the same way: *"halts selling **without deleting history**"*. So the tests
 * that matter most are the ones counting what is still there afterwards.
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
  stepUpAdmin,
  totpAt,
} from '@telga/api';
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

/** A shop with two devices, an operator, a live session and some history. */
function seedShop(merchantId = 'mch_ALPHA'): void {
  db.prepare(
    `INSERT INTO merchants (id, status, mode, created_at, updated_at)
     VALUES (?, 'ACTIVE', 'TRAINING', ?, ?)`,
  ).run(merchantId, AT, AT);
  db.prepare(
    `INSERT INTO merchant_users
       (id, merchant_id, display_name, role, pin_hash, pin_salt, pin_params, status, mode,
        created_at, updated_at)
     VALUES ('operator_0001', ?, 'Op', 'MERCHANT_OWNER', 'h', 's', 'p', 'ACTIVE', 'TRAINING', ?, ?)`,
  ).run(merchantId, AT, AT);

  for (const deviceId of ['device_0001', 'device_0002']) {
    db.prepare(
      `INSERT INTO devices (id, merchant_id, status, device_type, created_at, updated_at)
       VALUES (?, ?, 'ACTIVE', 'SMART_POS', ?, ?)`,
    ).run(deviceId, merchantId, AT, AT);
    db.prepare(
      `INSERT INTO device_enrollments
         (device_id, merchant_id, enrollment_state, secret_hash, secret_salt,
          enrolled_at, created_at, updated_at)
       VALUES (?, ?, 'ENROLLED', 'h', 's', ?, ?, ?)`,
    ).run(deviceId, merchantId, AT, AT, AT);
    db.prepare(
      `INSERT INTO sessions
         (id, user_id, merchant_id, device_id, role, csrf_hash, status, created_at,
          last_seen_at, idle_expires_at, absolute_expires_at)
       VALUES (?, 'operator_0001', ?, ?, 'MERCHANT_OWNER', 'c', 'ACTIVE', ?, ?, ?, ?)`,
    ).run(`sess_${deviceId}`, merchantId, deviceId, AT, AT, AT, AT);
  }

  // A day's trade, so "history survives" can be counted rather than asserted.
  db.prepare(
    `INSERT INTO transactions
       (id, merchant_id, device_id, operator_id, product_type, provider_id, amount_minor,
        currency, recipient_masked, recipient_hash, state, idempotency_key,
        payload_fingerprint, mode, created_at, updated_at)
     VALUES ('txn_1', ?, 'device_0001', 'operator_0001', 'AIRTIME', 'p', 5000, 'ETB',
             '09****4321', 'h', 'SUCCESSFUL', 'idem_1', 'f', 'TRAINING', ?, ?)`,
  ).run(merchantId, AT, AT);
}

const merchantStatus = (id = 'mch_ALPHA'): string =>
  String((db.prepare(`SELECT status FROM merchants WHERE id = ?`).get(id) as { status: string }).status);

const deviceStatus = (id: string): string =>
  String((db.prepare(`SELECT status FROM devices WHERE id = ?`).get(id) as { status: string }).status);

const activeSessions = (deviceId: string): number =>
  (
    db
      .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE device_id = ? AND status = 'ACTIVE'`)
      .get(deviceId) as { n: number }
  ).n;

const countOf = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const suspend = (cookie: string, reason = 'suspected fraud', id = 'mch_ALPHA'): Promise<Reply> =>
  send(`/merchants/${id}/suspend`, {
    method: 'POST',
    cookie,
    body: new URLSearchParams({ reason }).toString(),
  });

beforeEach(async () => {
  idSeq = 0;
  dir = mkdtempSync(join(tmpdir(), 'telga-control-'));
  db = new Database(join(dir, 'telga.sqlite'));
  db.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS) db.exec(`BEGIN; ${migration.sql} COMMIT;`);
  seedShop();

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

describe('suspending a shop', () => {
  it('sets the status createSale refuses on', async () => {
    const cookie = await signIn('owner');
    const reply = await suspend(cookie);

    expect(reply.status).toBe(303);
    expect(merchantStatus()).toBe('SUSPENDED');
  });

  it('deletes no history whatsoever', async () => {
    // The rule the vault states twice. Only one column moves.
    const cookie = await signIn('owner');
    const before = {
      transactions: countOf('transactions'),
      devices: countOf('devices'),
      users: countOf('merchant_users'),
      enrolments: countOf('device_enrollments'),
    };

    await suspend(cookie);

    expect(countOf('transactions')).toBe(before.transactions);
    expect(countOf('devices')).toBe(before.devices);
    expect(countOf('merchant_users')).toBe(before.users);
    expect(countOf('device_enrollments')).toBe(before.enrolments);
    // And the shop itself is still there, suspended rather than removed.
    expect(countOf('merchants')).toBe(1);
  });

  it('records the reason, because somebody will be asked for it', async () => {
    const cookie = await signIn('owner');
    await suspend(cookie, 'licence expired');

    const row = db
      .prepare(`SELECT metadata FROM audit_events WHERE event_type = 'ADMIN_MERCHANT_SUSPENDED'`)
      .get() as { metadata: string | null };
    expect(String(row.metadata)).toContain('licence expired');
  });

  it('refuses a suspension with no reason, and changes nothing', async () => {
    const cookie = await signIn('owner');
    const reply = await suspend(cookie, '   ');

    expect(reply.location).toBe('/merchants?error=REASON_REQUIRED');
    expect(merchantStatus()).toBe('ACTIVE');
  });

  it('reinstates a suspended shop, exactly as it was', async () => {
    const cookie = await signIn('owner');
    await suspend(cookie);
    expect(merchantStatus()).toBe('SUSPENDED');

    await send('/merchants/mch_ALPHA/reinstate', { method: 'POST', cookie, body: '' });

    expect(merchantStatus()).toBe('ACTIVE');
    // Its devices and its trade are untouched throughout.
    expect(deviceStatus('device_0001')).toBe('ACTIVE');
    expect(countOf('transactions')).toBe(1);
  });

  it('answers a shop that does not exist the same as one already suspended', async () => {
    // Neither is an error, and answering them identically means this cannot be
    // used to discover which merchant ids exist.
    const cookie = await signIn('owner');
    await suspend(cookie);

    const again = await suspend(cookie);
    const missing = await suspend(cookie, 'reason', 'mch_NOT_A_SHOP');
    expect(again.location).toBe('/merchants?error=NOT_CHANGED');
    expect(missing.location).toBe('/merchants?error=NOT_CHANGED');
  });
});

describe('stopping one device', () => {
  it('stops that device and revokes its sessions', async () => {
    // A stopped device holding a live session would still be usable, which is
    // the opposite of stopped.
    const cookie = await signIn('owner');
    expect(activeSessions('device_0001')).toBe(1);

    await send('/devices/device_0001/stop', { method: 'POST', cookie, body: '' });

    expect(deviceStatus('device_0001')).toBe('STOPPED');
    expect(activeSessions('device_0001')).toBe(0);
    const enrolment = db
      .prepare(`SELECT enrollment_state, revocation_reason FROM device_enrollments WHERE device_id = ?`)
      .get('device_0001') as { enrollment_state: string; revocation_reason: string | null };
    expect(enrolment.enrollment_state).toBe('REVOKED');
    expect(enrolment.revocation_reason).toBe('REMOTE_STOP');
  });

  it('leaves the shop trading on its other device', async () => {
    // R14: one machine lost, a business still open. This is the whole reason
    // stopping a device and suspending a shop are two different controls.
    const cookie = await signIn('owner');
    await send('/devices/device_0001/stop', { method: 'POST', cookie, body: '' });

    expect(merchantStatus()).toBe('ACTIVE');
    expect(deviceStatus('device_0002')).toBe('ACTIVE');
    expect(activeSessions('device_0002')).toBe(1);
  });

  it('deletes no history', async () => {
    const cookie = await signIn('owner');
    await send('/devices/device_0001/stop', { method: 'POST', cookie, body: '' });

    expect(countOf('transactions')).toBe(1);
    expect(countOf('devices')).toBe(2);
    // The session row survives, revoked — an audit trail needs the row, not a
    // gap where one used to be.
    expect(countOf('sessions')).toBe(2);
  });
});

describe('who may stop a shop', () => {
  it('refuses an auditor both controls', async () => {
    const cookie = await signIn('reader', 'AUDITOR');

    expect((await suspend(cookie)).status).toBe(403);
    expect(
      (await send('/devices/device_0001/stop', { method: 'POST', cookie, body: '' })).status,
    ).toBe(403);
    expect(merchantStatus()).toBe('ACTIVE');
    expect(deviceStatus('device_0001')).toBe('ACTIVE');
  });

  it('refuses an unauthenticated caller', async () => {
    expect((await suspend('')).status).toBe(303);
    expect(merchantStatus()).toBe('ACTIVE');
  });

  it('offers the controls on the merchants screen to an admin who has them', async () => {
    const cookie = await signIn('owner');
    const screen = await send('/merchants', { cookie });
    expect(screen.body).toContain('data-testid="merchant-mch_ALPHA-suspend"');

    await suspend(cookie);
    const after = await send('/merchants', { cookie });
    // The control flips rather than sitting alongside a contradictory one.
    expect(after.body).toContain('data-testid="merchant-mch_ALPHA-reinstate"');
    expect(after.body).not.toContain('data-testid="merchant-mch_ALPHA-suspend"');
  });
});
