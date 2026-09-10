/**
 * The operations screens the console was missing — transactions, operators and
 * provider health.
 *
 * ## Why they were built
 *
 * An audit on 2026-09-09 compared the console's routes against
 * `ADMIN_PERMISSIONS` and found **fourteen of thirty permissions with no button
 * anywhere**. The console could create a shop and a device and then had nothing
 * to say about what they did afterwards — `CLAUDE.md` §17 is an entire section
 * on answering *"paid but no airtime"*, and its first step is searching for a
 * transaction, which was impossible.
 *
 * ## What these tests defend
 *
 * The two properties that would be expensive to get wrong on a screen that
 * lists other people's money:
 *
 *   1. **No individual transaction ever reaches a console page** — founder
 *      decision **D144**. Not "is not linked": the routes are gone and answer
 *      404. The feature-flag work already had to learn that hiding a button
 *      while the endpoint still answers is a defect, not a control.
 *   2. **No recipient in any form**, masked or otherwise, and no single sale
 *      amount. §22's "no unnecessary personal data" applies to an internal
 *      console as much as to a receipt.
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

let server: Server | undefined;
let db: Database.Database | undefined;
let dir: string | undefined;
let port = 0;

const NOW = '2026-09-09T12:00:00.000Z';
let nextId = 1;
let credited = 0;

afterEach(() => {
  server?.close();
  server = undefined;
  db?.close();
  db = undefined;
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/**
 * A console over a database holding one shop, one device, one operator and two
 * transactions — one successful, one pending.
 *
 * Seeded through raw SQL rather than the application, deliberately: these tests
 * are about *reading*, and building the rows directly keeps them independent of
 * whatever the sale path happens to do this week.
 */
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'telga-ops-'));
  db = new Database(join(dir, 'ops.sqlite'));
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

  db.prepare(
    `INSERT INTO merchants (id, status, mode, created_at, updated_at) VALUES (?, 'ACTIVE', 'TRAINING', ?, ?)`,
  ).run('merchant_a', NOW, NOW);
  db.prepare(
    `INSERT INTO devices (id, merchant_id, status, device_type, created_at, updated_at)
     VALUES (?, ?, 'ACTIVE', 'SMART_POS', ?, ?)`,
  ).run('device_a', 'merchant_a', NOW, NOW);
  const pin = await hashAdminSecret('123456');
  db.prepare(
    `INSERT INTO merchant_users
       (id, merchant_id, display_name, role, pin_hash, pin_salt, pin_params, status,
        mode, failed_attempts, created_at, updated_at)
     VALUES (?, ?, 'Counter One', 'MERCHANT_OPERATOR', ?, ?, ?, 'ACTIVE', 'TRAINING', 0, ?, ?)`,
  ).run('operator_a', 'merchant_a', pin.hash, pin.salt, pin.params, NOW, NOW);

  const tx = (id: string, state: string, recipient: string, at: string): void => {
    db?.prepare(
      `INSERT INTO transactions
         (id, merchant_id, device_id, operator_id, product_type, provider_id, amount_minor,
          currency, recipient_masked, recipient_hash, state, idempotency_key,
          payload_fingerprint, provider_reference, mode, created_at, updated_at)
       VALUES (?, 'merchant_a', 'device_a', 'operator_a', 'AIRTIME', 'provider_simulated',
               5000, 'ETB', ?, 'hash_of_full_number', ?, ?, 'fp', ?, 'TRAINING', ?, ?)`,
    ).run(id, recipient, state, `idem_${id}`, `provref_${id}`, at, at);
  };
  tx('txn_ok', 'SUCCESSFUL', '09****1234', '2026-09-09T10:00:00.000Z');
  tx('txn_pending', 'PENDING', '09****5678', '2026-09-09T11:00:00.000Z');

  credited = 0;
  db.prepare(
    `INSERT INTO provider_health_events (id, provider_id, at, status, previous_status, detail, correlation_id)
     VALUES (?, 'provider_simulated', ?, 'UNAVAILABLE', 'HEALTHY', 'simulated outage', 'corr_1')`,
  ).run('phe_1', '2026-09-09T09:30:00.000Z');

  server = createConsoleServer({
    db: db as never,
    now: () => NOW,
    // Unique per call. A fixed id collides on the second audit row, and the
    // audit writer swallows the failure — see the note in the suspend test.
    newId: (p) => `${p}_${String(nextId++)}`,
    schemaVersion: '018',
    secureCookies: false,
    // The founder's console runs this way for the acceptance round (D143), and
    // it is what makes a one-request-per-screen test meaningful.
    singleFactorAuth: true,
    // Supplied exactly as `cli.ts` supplies it. Without it the deposit screens
    // deliberately close — that guard is why `/deposits` used to 404 in
    // production, and a test that omitted it would be testing the wrong shape.
    creditMerchant: () => {
      credited += 1;
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

interface Reply {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, unknown>;
}

function send(
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

async function signIn(): Promise<string> {
  const reply = await send('/login', {
    method: 'POST',
    form: { email: 'owner@telga.example', password: 'ConsolePassword1' },
  });
  const set = (reply.headers['set-cookie'] as string[] | undefined) ?? [];
  return set.map((c) => c.split(';')[0]).join('; ');
}

describe('every console section answers after one sign-in', () => {
  it('serves every screen in the navigation', async () => {
    const cookie = await signIn();
    for (const path of [
      '/',
      '/applications',
      '/merchants',
      '/devices',
      '/deposits',
      '/activity',
      '/operators',
      '/provider-health',
      '/tenants',
      '/admins',
      '/audit',
    ]) {
      const reply = await send(path, { cookie });
      expect(reply.status, `${path} must answer`).toBe(200);
    }
  });

  it('links to every one of them from the navigation', async () => {
    // A screen with no entry in the navigation is a screen that does not exist
    // as far as an operator is concerned — which is how `/deposits` sat unused
    // with working routes behind it.
    const cookie = await signIn();
    const reply = await send('/', { cookie });
    for (const id of [
      'dashboard',
      'applications',
      'merchants',
      'devices',
      'deposits',
      'activity',
      'operators',
      'provider-health',
      'tenants',
      'admins',
      'audit',
    ]) {
      expect(reply.body, `nav must link ${id}`).toContain(`data-testid="nav-${id}"`);
    }
  });
});

describe('shop activity is aggregates, and only aggregates', () => {
  it('reports per-shop counts and volume', async () => {
    const cookie = await signIn();
    const reply = await send('/activity', { cookie });
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('activity-merchant_a');
    // Two seeded sales, one successful at 5000 minor.
    expect(reply.body).toContain('activity-total-sales');
    expect(reply.body).toContain('50.00 ETB');
  });

  it('counts pending and under-review separately, because somebody is waiting', async () => {
    // The one thing an operations desk genuinely needs from this screen: that a
    // shop *has* a problem, without saying whose money it was.
    const cookie = await signIn();
    const reply = await send('/activity', { cookie });
    expect(reply.body).toContain('activity-pending-merchant_a');
    expect(reply.body).toContain('activity-total-pending');
  });

  it('names no transaction and no recipient anywhere on the page', async () => {
    const cookie = await signIn();
    const reply = await send('/activity', { cookie });
    for (const leak of ['txn_ok', 'txn_pending', 'provref_txn_ok', '09****1234', '09****5678', 'hash_of_full_number']) {
      expect(reply.body, `${leak} must not appear`).not.toContain(leak);
    }
  });

  it('says on the page that it is aggregates only', async () => {
    // An operator must not have to infer the boundary. A screen that silently
    // omits detail looks identical to one whose data is missing.
    const cookie = await signIn();
    const reply = await send('/activity', { cookie });
    expect(reply.body).toContain('activity-privacy-note');
  });
});

describe('the transaction routes are gone, not hidden', () => {
  it('answers 404 for the list and for a known transaction id', async () => {
    // D144 removed them. If either ever answers again, a Telga employee can
    // read a shop's trade by typing an address, which is exactly the boundary
    // the founder drew.
    const cookie = await signIn();
    for (const path of ['/transactions', '/transactions/txn_ok', '/transactions?state=PENDING']) {
      const reply = await send(path, { cookie });
      expect(reply.status, `${path} must not be served`).toBe(404);
    }
  });

  it('offers no way to print or reprint a shop slip', async () => {
    // Founder decision: a slip is the shop's document for its customer, and
    // Telga never produces paper for someone else's counter. Asserted against
    // the whole navigation and dashboard rather than one route, so a future
    // screen cannot quietly add one.
    const cookie = await signIn();
    for (const path of ['/', '/activity', '/merchants', '/devices']) {
      const reply = await send(path, { cookie });
      expect(reply.body.toLowerCase(), `${path} must not offer printing`).not.toContain('reprint');
    }
    for (const path of ['/transactions/txn_ok/reprint', '/merchants/merchant_a/reprint']) {
      expect((await send(path, { method: 'POST', cookie, form: {} })).status).toBe(404);
    }
  });
});

describe('operators', () => {
  it('lists them with their status', async () => {
    const cookie = await signIn();
    const reply = await send('/operators', { cookie });
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('operator-operator_a');
    expect(reply.body).toContain('Counter One');
  });

  it('suspends one and revokes the session it was holding', async () => {
    // A suspension that waited for a voluntary sign-out would leave the till
    // working, which is the opposite of suspended.
    const cookie = await signIn();
    db?.prepare(
      `INSERT INTO sessions
         (id, user_id, merchant_id, device_id, role, csrf_hash, status,
          created_at, last_seen_at, idle_expires_at, absolute_expires_at)
       VALUES ('sess_1', 'operator_a', 'merchant_a', 'device_a', 'MERCHANT_OPERATOR',
               'csrf_hash', 'ACTIVE', ?, ?, ?, ?)`,
    ).run(NOW, NOW, '2026-09-09T13:00:00.000Z', '2026-09-09T20:00:00.000Z');

    const reply = await send('/operators/operator_a/suspend', { method: 'POST', cookie, form: {} });
    expect(reply.status).toBe(303);

    const row = db?.prepare('SELECT status FROM merchant_users WHERE id = ?').get('operator_a') as {
      status: string;
    };
    expect(row.status).toBe('SUSPENDED');

    const session = db
      ?.prepare('SELECT status, revoked_at FROM sessions WHERE id = ?')
      .get('sess_1') as { status: string; revoked_at: string | null };
    // Both, and the status is the one that matters: `authenticate` reads it, so
    // stamping only the timestamp would have left the session working.
    expect(session.status).toBe('REVOKED');
    expect(session.revoked_at).not.toBeNull();
  });

  it('issues a six-digit PIN once, in the page and never in a URL', async () => {
    const cookie = await signIn();
    const before = db
      ?.prepare('SELECT pin_hash FROM merchant_users WHERE id = ?')
      .get('operator_a') as { pin_hash: string };

    const reply = await send('/operators/operator_a/reset-pin', {
      method: 'POST',
      cookie,
      form: {},
    });
    expect(reply.status).toBe(201);
    // Rendered, not redirected: a PIN must never reach a URL or a server log.
    expect(reply.headers['location']).toBeUndefined();
    expect(reply.body).toContain('issued-pin-value');

    const after = db
      ?.prepare('SELECT pin_hash, must_change_pin, locked_until FROM merchant_users WHERE id = ?')
      .get('operator_a') as { pin_hash: string; must_change_pin: number; locked_until: string | null };
    expect(after.pin_hash).not.toBe(before.pin_hash);
    // A PIN staff have read aloud is a shared secret, so it must be replaced.
    expect(after.must_change_pin).toBe(1);
    // A reset also clears a lockout: the commonest reason for one is a
    // forgotten PIN, and leaving the lock would make the new PIN unusable.
    expect(after.locked_until).toBeNull();
  });

  it('records the reset without recording the PIN', async () => {
    const cookie = await signIn();
    await send('/operators/operator_a/reset-pin', { method: 'POST', cookie, form: {} });
    const audit = db
      ?.prepare(`SELECT event_type, metadata FROM audit_events WHERE event_type = 'ADMIN_OPERATOR_PIN_RESET'`)
      .get() as { event_type: string; metadata: string | null } | undefined;
    expect(audit?.event_type).toBe('ADMIN_OPERATOR_PIN_RESET');
    expect(audit?.metadata ?? '').not.toMatch(/\d{6}/);
  });
});

describe('provider health', () => {
  it('shows the current state and the transition that produced it', async () => {
    const cookie = await signIn();
    const reply = await send('/provider-health', { cookie });
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('provider-provider_simulated');
    expect(reply.body).toContain('UNAVAILABLE');
    // "how long was it down" is answerable from the transition, which is the
    // reason previous_status is stored at all.
    expect(reply.body).toContain('HEALTHY → UNAVAILABLE');
  });
});


describe('remote stop has a button, and a way back', () => {
  it('offers Stop on an active device and Reinstate on a stopped one', async () => {
    // `POST /devices/:id/stop` existed and was reachable only by typing the
    // address. §18 lists remote stop among the device controls a platform must
    // have — a required control with no button is a control nobody has.
    const cookie = await signIn();
    const active = await send('/devices', { cookie });
    expect(active.body).toContain('device-stop-device_a');
    // Not both at once: a device is either running or it is not.
    expect(active.body).not.toContain('device-reinstate-device_a');

    db?.prepare(`UPDATE devices SET status = 'STOPPED' WHERE id = 'device_a'`).run();

    const stopped = await send('/devices', { cookie });
    expect(stopped.body).toContain('device-reinstate-device_a');
    expect(stopped.body).not.toContain('device-stop-device_a');
  });

  it('reinstates a stopped device without handing its old key back', async () => {
    // Reinstating is not the inverse of stopping, and that is deliberate: the
    // device key may have been read off a machine that was out of the shop's
    // hands. The machine returns; the credential does not.
    const cookie = await signIn();
    db?.prepare(`UPDATE devices SET status = 'STOPPED' WHERE id = 'device_a'`).run();
    db?.prepare(
      `INSERT INTO device_enrollments
         (device_id, merchant_id, enrollment_state, secret_hash, secret_salt,
          enrolled_at, created_at, updated_at)
       VALUES ('device_a', 'merchant_a', 'REVOKED', 'h', 's', ?, ?, ?)`,
    ).run(NOW, NOW, NOW);

    const reply = await send('/devices/device_a/reinstate', { method: 'POST', cookie, form: {} });
    expect(reply.status).toBe(303);

    const device = db?.prepare(`SELECT status FROM devices WHERE id = 'device_a'`).get() as {
      status: string;
    };
    expect(device.status).toBe('ACTIVE');

    // The enrolment stays revoked, so the shop needs a fresh activation code.
    const enrolment = db
      ?.prepare(`SELECT enrollment_state FROM device_enrollments WHERE device_id = 'device_a'`)
      .get() as { enrollment_state: string };
    expect(enrolment.enrollment_state).toBe('REVOKED');

    // And the operator is told so, rather than left to discover it.
    expect(decodeURIComponent(String(reply.headers['location'] ?? ''))).toContain(
      'new activation code',
    );
  });

  it('answers the same way for an unknown device as for one already active', async () => {
    // Neither confirms which device ids exist: both redirect with the same
    // "Nothing changed" notice.
    const cookie = await signIn();
    const unknown = await send('/devices/no_such_device/reinstate', { method: 'POST', cookie, form: {} });
    const alreadyActive = await send('/devices/device_a/reinstate', { method: 'POST', cookie, form: {} });
    expect(unknown.status).toBe(alreadyActive.status);
    expect(unknown.headers['location']).toBe(alreadyActive.headers['location']);
  });
});


describe('the review screen shows the paperwork', () => {
  it('renders a verdict and a row per document', async () => {
    // The screen showed no documents at all: a reviewer approved a shop without
    // seeing whether it had supplied a licence, a TIN or an ID.
    const cookie = await signIn();
    db?.prepare(
      `INSERT INTO merchant_applications
         (id, reference, status, submitted_via, legal_name, owner_name, phone,
          address, locality, submitted_at, created_at, updated_at)
       VALUES ('app_r', 'TLG-AAAA-BBBB', 'SUBMITTED', 'ADMIN', 'Paper Shop', 'Owner',
               '+251911000000', 'Street', 'Addis Ababa', ?, ?, ?)`,
    ).run(NOW, NOW, NOW);
    db?.prepare(
      `INSERT INTO merchant_application_documents
         (id, application_id, kind, reference, status, expires_at, created_at, updated_at)
       VALUES ('d1', 'app_r', 'TRADE_LICENCE', 'TL-1', 'SUPPLIED', '2020-01-01T00:00:00.000Z', ?, ?)`,
    ).run(NOW, NOW);

    const reply = await send('/applications/app_r', { cookie });
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('application-readiness');
    // Licence expired, TIN and ID never supplied — three blocking facts.
    expect(reply.body).toContain('data-verdict="NOT_READY"');
    expect(reply.body).toContain('readiness-TRADE_LICENCE');
    expect(reply.body).toContain('readiness-TIN_CERTIFICATE');
    expect(reply.body).toContain('readiness-OWNER_PHOTO_ID');
    // In words a reviewer can act on, not schema tokens.
    expect(reply.body).toContain('Trade licence');
    expect(reply.body).toContain('expired on');
  });

  it('offers no scan link when there is no scan to open', async () => {
    // A "View scan" that 404s is worse than no link. Offered only when the
    // document has a vault handle *and* the admin may export data.
    const cookie = await signIn();
    db?.prepare(
      `INSERT INTO merchant_applications
         (id, reference, status, submitted_via, legal_name, owner_name, phone,
          address, locality, submitted_at, created_at, updated_at)
       VALUES ('app_n', 'TLG-CCCC-DDDD', 'SUBMITTED', 'SELF_SERVICE', 'No Scan Shop', 'Owner',
               '+251911000001', 'Street', 'Addis Ababa', ?, ?, ?)`,
    ).run(NOW, NOW, NOW);
    db?.prepare(
      `INSERT INTO merchant_application_documents
         (id, application_id, kind, reference, status, created_at, updated_at)
       VALUES ('d2', 'app_n', 'TIN_CERTIFICATE', 'TIN-1', 'SUPPLIED', ?, ?)`,
    ).run(NOW, NOW);

    const reply = await send('/applications/app_n', { cookie });
    expect(reply.body).not.toContain('readiness-view-TIN_CERTIFICATE');
    // And it is reported as reference-only rather than silently looking fine.
    expect(reply.body).toContain('no scan attached');
  });
});
