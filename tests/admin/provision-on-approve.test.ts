/**
 * Approving an application creates a shop.
 *
 * ## The gap this closes
 *
 * `/applications/:id/decide` used to write a status column and stop.
 * `provisionMerchant()` existed, was tested as a pure function, and had **no
 * caller** — it was not even exported from `@telga/api`. So an `APPROVED`
 * application and a shop that could trade were unrelated facts, and the only
 * way to turn one into the other was a CLI run by hand that nothing recorded.
 *
 * That is the sort of defect a unit test cannot find, because every unit was
 * working. It only appears when the request is made, which is why everything
 * here goes through `createConsoleServer` on a real socket and asserts against
 * the database afterwards.
 *
 * ## What is deliberately asserted about the *rejection* path
 *
 * A rejected application must leave no shop behind. That is not symmetry for
 * its own sake: a merchant row created for a rejected applicant is an account
 * for somebody who was refused one, and `Admin Operations Console` Decision 3
 * chose "no account until approved" precisely so there is nothing to attack.
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
  merchantIdFor,
  satisfyAdminMfa,
  stepUpAdmin,
  totpAt,
} from '@telga/api';
import type { AdminRole } from '@telga/domain';
import { createConsoleServer } from '../../apps/operations-console/src/server';

const SESSION_COOKIE = 'telga_admin_session';
const PASSWORD = 'a-long-enough-admin-password';
const APPLICATION = 'app_7Q4M2XKD';

let dir: string;
let db: Database.Database;
let server: Server | undefined;
let port = 0;
let clock = Date.parse('2026-09-08T09:00:00.000Z');

const now = (): string => new Date(clock).toISOString();
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
    if (init.cookie !== undefined) headers['cookie'] = init.cookie;
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

async function makeAdmin(id: string, role: AdminRole): Promise<string> {
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
  return id;
}

/**
 * Sign in, clear the second factor, and step up.
 *
 * **The step-up is not fixture noise — it is the control under test.** Deciding
 * an application is on the console's step-up list (`Admin Operations Console`:
 * *"creating or activating a merchant or device"*), so a session that has only
 * cleared MFA is sent to `/step-up` and provisions nothing. The first run of
 * this suite proved exactly that, which is the reason it is spelled out here
 * rather than hidden in a helper: a later change that dropped the requirement
 * would make these tests pass and the console weaker.
 *
 * `stepUp: false` leaves the session one factor short, so the refusal can be
 * asserted directly.
 */
async function signIn(id: string, opts: { stepUp?: boolean } = {}): Promise<string> {
  const result = await adminLogin(ports(), { email: `${id}@telga.example`, password: PASSWORD });
  if (result.kind !== 'AUTHENTICATED') throw new Error(`login refused: ${result.kind}`);
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(result.sessionToken)}`;
  const auth = authenticateAdmin(ports(), result.sessionToken);
  if (!auth.ok) throw new Error(`session not resolvable: ${auth.reason}`);
  const enrolment = beginMfaEnrolment(ports(), id, `${id}@telga.example`);
  const ok = await satisfyAdminMfa(ports(), auth.sessionId, id, totpAt(enrolment.secret, clock));
  if (!ok) throw new Error('MFA not satisfied in fixture');
  if (opts.stepUp === false) return cookie;
  const stepped = await stepUpAdmin(ports(), auth.sessionId, id, PASSWORD);
  if (!stepped) throw new Error('step-up not satisfied in fixture');
  return cookie;
}

/** An application sitting in the queue, already picked up for review. */
function seedApplication(id = APPLICATION, status = 'UNDER_REVIEW'): void {
  db.prepare(
    `INSERT INTO merchant_applications
       (id, reference, status, legal_name, trading_name, owner_name, phone, email,
        address, locality, submitted_at, created_at, updated_at)
     VALUES (?, ?, ?, 'Abebe Trading PLC', 'Abebe Shop', 'Abebe Bekele',
             '+251911000000', 'abebe@example.et', 'Bole Road 12', 'Addis Ababa', ?, ?, ?)`,
  ).run(id, `REF-${id}`, status, now(), now(), now());
}

const decide = (cookie: string, outcome: string, id = APPLICATION): Promise<Reply> =>
  send(`/applications/${id}/decide`, {
    method: 'POST',
    cookie,
    body: `outcome=${outcome}&reason=${encodeURIComponent('checked the documents')}`,
  });

const application = (id = APPLICATION): Record<string, unknown> =>
  db.prepare(`SELECT * FROM merchant_applications WHERE id = ?`).get(id) as Record<string, unknown>;

const tenants = (): Record<string, unknown>[] =>
  db.prepare(`SELECT * FROM tenant_registry`).all() as Record<string, unknown>[];

const merchants = (): Record<string, unknown>[] =>
  db.prepare(`SELECT * FROM merchants`).all() as Record<string, unknown>[];

const auditEvents = (): string[] =>
  (db.prepare(`SELECT event_type FROM audit_events`).all() as { event_type: string }[]).map(
    (r) => r.event_type,
  );

beforeEach(async () => {
  clock = Date.parse('2026-09-08T09:00:00.000Z');
  idSeq = 0;
  dir = mkdtempSync(join(tmpdir(), 'telga-provision-'));
  db = new Database(join(dir, 'telga.sqlite'));
  db.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS) db.exec(`BEGIN; ${migration.sql} COMMIT;`);

  server = createConsoleServer({
    db: db as never,
    now,
    newId,
    schemaVersion: '014',
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

describe('approving an application', () => {
  it('creates the merchant, the registry row, and links them together', async () => {
    seedApplication();
    const cookie = await signIn(await makeAdmin('ops', 'OPERATIONS_ADMIN'));

    const reply = await decide(cookie, 'APPROVE');
    expect(reply.status).toBe(303);
    // No `?error=` on the redirect: provisioning succeeded.
    expect(reply.location).toBe(`/applications/${APPLICATION}`);

    const expectedId = merchantIdFor(APPLICATION);
    expect(merchants()).toHaveLength(1);
    expect(merchants()[0]).toMatchObject({
      id: expectedId,
      status: 'ONBOARDING',
      // The schema's CHECK permits nothing else, so a live shop cannot be
      // provisioned down this path even by mistake.
      mode: 'TRAINING',
    });

    // Reachable, and only at the end: `ACTIVE` is the last step of provisioning.
    expect(tenants()).toHaveLength(1);
    expect(tenants()[0]).toMatchObject({ merchant_id: expectedId, status: 'ACTIVE' });

    // The shop exists and has no device yet, which is what the lifecycle says
    // comes next — not ACTIVE_TRAINING, which needs an enrolled device.
    expect(application()).toMatchObject({
      status: 'DEVICE_PENDING',
      merchant_id: expectedId,
      reviewed_by: 'ops',
    });
  });

  it('derives the merchant id from the application rather than generating one', async () => {
    // This is what makes a concurrent double approval collide on a primary key
    // instead of quietly creating two shops for one applicant.
    seedApplication();
    const cookie = await signIn(await makeAdmin('ops', 'OPERATIONS_ADMIN'));
    await decide(cookie, 'APPROVE');
    expect(merchants()[0]?.['id']).toBe('mch_7Q4M2XKD');
  });

  it('records both the decision and the provisioning', async () => {
    seedApplication();
    const cookie = await signIn(await makeAdmin('ops', 'OPERATIONS_ADMIN'));
    await decide(cookie, 'APPROVE');

    const events = auditEvents();
    expect(events).toContain('ADMIN_APPLICATION_DECIDED');
    expect(events).toContain('ADMIN_MERCHANT_PROVISIONED');
    // The decision is recorded before the consequence, so a failed provisioning
    // still leaves an auditable approval.
    expect(events.indexOf('ADMIN_APPLICATION_DECIDED')).toBeLessThan(
      events.indexOf('ADMIN_MERCHANT_PROVISIONED'),
    );
  });
});

describe('a second approval of the same application', () => {
  it('refuses rather than creating a second shop', async () => {
    seedApplication();
    const cookie = await signIn(await makeAdmin('ops', 'OPERATIONS_ADMIN'));
    await decide(cookie, 'APPROVE');
    expect(merchants()).toHaveLength(1);

    // Put it back into a reviewable state, as a second operator racing the
    // first would find it, and approve again.
    db.prepare(`UPDATE merchant_applications SET status = 'UNDER_REVIEW' WHERE id = ?`).run(
      APPLICATION,
    );
    const second = await decide(cookie, 'APPROVE');

    // The refusal reaches the operator by name rather than as a 500.
    expect(second.status).toBe(303);
    expect(second.location).toBe(`/applications/${APPLICATION}?error=ALREADY_PROVISIONED`);

    // And the important part: still one shop, one registry row.
    expect(merchants()).toHaveLength(1);
    expect(tenants()).toHaveLength(1);
    expect(auditEvents()).toContain('ADMIN_MERCHANT_PROVISION_REFUSED');
  });
});

describe('a rejected application', () => {
  it('leaves no merchant, no registry row and no database', async () => {
    // Decision 3: no account until approved. A merchant row for somebody who
    // was refused is an account nobody meant to create.
    seedApplication();
    const cookie = await signIn(await makeAdmin('ops', 'OPERATIONS_ADMIN'));

    const reply = await decide(cookie, 'REJECT');
    expect(reply.status).toBe(303);
    expect(merchants()).toHaveLength(0);
    expect(tenants()).toHaveLength(0);
    expect(application()).toMatchObject({ status: 'CLOSED', merchant_id: null });
    expect(auditEvents()).not.toContain('ADMIN_MERCHANT_PROVISIONED');
  });

  it('provisions nothing when the application is returned for correction', async () => {
    seedApplication();
    const cookie = await signIn(await makeAdmin('ops', 'OPERATIONS_ADMIN'));
    await decide(cookie, 'RETURN_FOR_CORRECTION');
    expect(merchants()).toHaveLength(0);
    expect(tenants()).toHaveLength(0);
  });
});

describe('an outcome the domain does not define', () => {
  /**
   * Found by hand, driving the console with `outcome=APPROVED` — one letter
   * from the value that approves.
   *
   * The route cast the raw form value onto the decision type. A cast is a
   * promise, not a check, so the string travelled intact to `statusAfterReview`,
   * which sends everything that is not `APPROVE` or `RETURN_FOR_CORRECTION` to
   * `CLOSED`. The applicant was **rejected**, the reviewer was shown no error,
   * and the audit trail recorded an outcome that does not exist.
   *
   * No click could produce it — the console's own buttons send correct values —
   * which is exactly why nothing caught it. Anything that is not a person
   * clicking, a rename, an integration, a retried request, meets this path.
   */
  it('changes nothing, and does not fall back to rejecting the shop', async () => {
    seedApplication();
    const cookie = await signIn(await makeAdmin('ops', 'OPERATIONS_ADMIN'));

    const reply = await decide(cookie, 'APPROVED');

    expect(reply.status).toBe(303);
    expect(reply.location).toContain('error=UNKNOWN_OUTCOME');
    // Still awaiting a decision — not closed, not approved.
    expect(application()).toMatchObject({ status: 'UNDER_REVIEW' });
    expect(merchants()).toHaveLength(0);
    expect(tenants()).toHaveLength(0);
    expect(auditEvents()).not.toContain('ADMIN_APPLICATION_DECIDED');
  });

  it('refuses a missing outcome rather than defaulting to reject', async () => {
    seedApplication();
    const cookie = await signIn(await makeAdmin('ops', 'OPERATIONS_ADMIN'));

    const reply = await send(`/applications/${APPLICATION}/decide`, {
      method: 'POST',
      cookie,
      body: `reason=${encodeURIComponent('no outcome field at all')}`,
    });

    expect(reply.status).toBe(303);
    expect(reply.location).toContain('error=UNKNOWN_OUTCOME');
    expect(application()).toMatchObject({ status: 'UNDER_REVIEW' });
    expect(merchants()).toHaveLength(0);
  });

  it('still accepts every outcome the domain does define', async () => {
    // The guard must refuse the unknown without narrowing the known.
    for (const outcome of ['APPROVE', 'REJECT', 'RETURN_FOR_CORRECTION']) {
      seedApplication(`app_${outcome}`);
      const cookie = await signIn(await makeAdmin(`ops_${outcome}`, 'OPERATIONS_ADMIN'));
      const reply = await decide(cookie, outcome, `app_${outcome}`);
      expect(reply.status).toBe(303);
      expect(reply.location).not.toContain('UNKNOWN_OUTCOME');
      expect(application(`app_${outcome}`)).not.toMatchObject({ status: 'UNDER_REVIEW' });
    }
  });
});

describe('who may do this', () => {
  it('refuses an auditor, who may read everything and change nothing', async () => {
    seedApplication();
    const cookie = await signIn(await makeAdmin('reader', 'AUDITOR'));

    const reply = await decide(cookie, 'APPROVE');
    expect(reply.status).toBe(403);
    expect(merchants()).toHaveLength(0);
    expect(application()).toMatchObject({ status: 'UNDER_REVIEW' });
  });

  it('refuses an unauthenticated caller without disclosing the application', async () => {
    seedApplication();
    const reply = await decide('', 'APPROVE');
    expect(reply.status).toBe(303);
    expect(reply.location).toBe('/login');
    expect(merchants()).toHaveLength(0);
  });

  it('demands step-up re-authentication, and provisions nothing without it', async () => {
    // A signed-in admin with the right permission and a cleared second factor
    // still may not create a shop. Password and MFA were both satisfied minutes
    // ago; step-up asks *now*, which is the difference between an authorised
    // person and an unattended laptop.
    seedApplication();
    const cookie = await signIn(await makeAdmin('ops', 'OPERATIONS_ADMIN'), { stepUp: false });

    const reply = await decide(cookie, 'APPROVE');
    expect(reply.status).toBe(303);
    expect(reply.location).toBe('/step-up?for=%2Fapplications%2Fapp_7Q4M2XKD%2Fdecide');

    // Nothing happened: not the decision, and certainly not the shop.
    expect(merchants()).toHaveLength(0);
    expect(tenants()).toHaveLength(0);
    expect(application()).toMatchObject({ status: 'UNDER_REVIEW', merchant_id: null });
  });
});
