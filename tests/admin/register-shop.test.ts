/**
 * "Register Telga User" — the form an admin fills in at a shop.
 *
 * **M1a.** This closes the first of the four gaps in `Multi-Shop Onboarding`:
 * nothing in the source could insert into `merchant_applications`, so the review
 * queue was real and reviewed nothing.
 *
 * ## The property this file exists to hold
 *
 * Recording a registration creates an **application and nothing else** — no
 * merchant, no operator, no device, no credentials. `Admin Operations Console`
 * Decision 3 chose that over creating a locked account: *"nothing to attack
 * beats a guard that must never be forgotten."* Approving is what creates a
 * shop, and that path is D120's.
 *
 * So the assertions are weighted towards what must **not** happen, and the last
 * test walks the whole chain — register, review, approve — to show the two
 * halves meet.
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

let dir: string;
let db: Database.Database;
let server: Server | undefined;
let port = 0;
const clock = Date.parse('2026-09-08T09:00:00.000Z');

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

async function signIn(id: string, role: AdminRole = 'OPERATIONS_ADMIN'): Promise<string> {
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
  if (result.kind !== 'AUTHENTICATED') throw new Error(`login refused: ${result.kind}`);
  const auth = authenticateAdmin(ports(), result.sessionToken);
  if (!auth.ok) throw new Error('session not resolvable');
  const enrolment = beginMfaEnrolment(ports(), id, `${id}@telga.example`);
  await satisfyAdminMfa(ports(), auth.sessionId, id, totpAt(enrolment.secret, clock));
  await stepUpAdmin(ports(), auth.sessionId, id, PASSWORD);
  return `${SESSION_COOKIE}=${encodeURIComponent(result.sessionToken)}`;
}

/** The founder's seven fields, plus the city the schema needs. */
const FORM = {
  legalName: 'Abebe Airtime Shop',
  address: 'Bole Road 12, near the roundabout',
  locality: 'Addis Ababa',
  ownerName: 'Abebe Bekele Tadesse',
  phone: '+251911000000',
  email: 'abebe@example.et',
  tradeLicence: 'TL/AA/2026/99887',
  tradeLicenceExpiry: '2027-06-30',
  tin: 'TIN-0012345678',
  photoId: 'ID-ETH-4455667',
};

const post = (cookie: string, over: Partial<typeof FORM> = {}): Promise<Reply> =>
  send('/applications', {
    method: 'POST',
    cookie,
    body: new URLSearchParams({ ...FORM, ...over }).toString(),
  });

const applications = (): Record<string, unknown>[] =>
  db.prepare(`SELECT * FROM merchant_applications`).all() as Record<string, unknown>[];

const documents = (): Record<string, unknown>[] =>
  db
    .prepare(`SELECT * FROM merchant_application_documents ORDER BY kind`)
    .all() as Record<string, unknown>[];

const countOf = (table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const auditEvents = (): string[] =>
  (db.prepare(`SELECT event_type FROM audit_events`).all() as { event_type: string }[]).map(
    (r) => r.event_type,
  );

beforeEach(async () => {
  idSeq = 0;
  dir = mkdtempSync(join(tmpdir(), 'telga-register-'));
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

describe('the form', () => {
  it('offers every field the founder specified', async () => {
    const cookie = await signIn('ops');
    const reply = await send('/applications/new', { cookie });
    expect(reply.status).toBe(200);

    for (const field of [
      'legalName',
      'address',
      'locality',
      'ownerName',
      'phone',
      'tradeLicence',
      'tin',
      'photoId',
    ]) {
      expect(reply.body, `field ${field} must be on the form`).toContain(
        `data-testid="field-${field}"`,
      );
    }
  });

  it('is reachable from the applications list', async () => {
    const cookie = await signIn('ops');
    const reply = await send('/applications', { cookie });
    expect(reply.body).toContain('data-testid="register-telga-user"');
    expect(reply.body).toContain('/applications/new');
  });

  it('says on the page that it creates no account', async () => {
    const cookie = await signIn('ops');
    const reply = await send('/applications/new', { cookie });
    expect(reply.body).toContain('creates no account');
  });
});

describe('recording a registration', () => {
  it('creates the application and its three documents', async () => {
    const cookie = await signIn('ops');
    const reply = await post(cookie);
    expect(reply.status).toBe(303);

    expect(applications()).toHaveLength(1);
    expect(applications()[0]).toMatchObject({
      status: 'SUBMITTED',
      legal_name: 'Abebe Airtime Shop',
      owner_name: 'Abebe Bekele Tadesse',
      phone: '+251911000000',
      locality: 'Addis Ababa',
      merchant_id: null,
    });

    expect(documents().map((d) => d['kind'])).toEqual([
      'OWNER_PHOTO_ID',
      'TIN_CERTIFICATE',
      'TRADE_LICENCE',
    ]);
    // Supplied, not verified. Nobody has checked anything yet.
    for (const document of documents()) expect(document['status']).toBe('SUPPLIED');
  });

  it('creates no account, no operator, no device and no credentials', async () => {
    // Decision 3, and the whole reason this route is safe to expose to an admin
    // standing in a shop with an applicant watching.
    const cookie = await signIn('ops');
    await post(cookie);

    expect(countOf('merchants')).toBe(0);
    expect(countOf('merchant_users')).toBe(0);
    expect(countOf('devices')).toBe(0);
    expect(countOf('device_enrollments')).toBe(0);
    expect(countOf('tenant_registry')).toBe(0);
  });

  it('records the action without putting a document number in the trail', async () => {
    // An audit trail carrying identity-document numbers turns every reader of
    // the audit screen into a holder of them.
    const cookie = await signIn('ops');
    await post(cookie);

    expect(auditEvents()).toContain('ADMIN_APPLICATION_RECORDED');
    const rows = db.prepare(`SELECT metadata FROM audit_events`).all() as {
      metadata: string | null;
    }[];
    const all = rows.map((r) => r.metadata ?? '').join(' ');
    expect(all).not.toContain(FORM.tin);
    expect(all).not.toContain(FORM.photoId);
    expect(all).not.toContain(FORM.tradeLicence);
  });

  it('gives back an unguessable reference rather than a number', async () => {
    const cookie = await signIn('ops');
    await post(cookie);
    expect(String(applications()[0]?.['reference'])).toMatch(/^TLG-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });
});

describe('what the form refuses', () => {
  it('refuses an expired business licence', async () => {
    // Not paperwork to fix after approval: the shop is not currently licensed.
    const cookie = await signIn('ops');
    const reply = await post(cookie, { tradeLicenceExpiry: '2026-01-01' });
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('LICENCE_ALREADY_EXPIRED');
    expect(applications()).toHaveLength(0);
  });

  it('refuses a missing document number, naming which rule failed', async () => {
    const cookie = await signIn('ops');
    const reply = await post(cookie, { tin: '' });
    expect(reply.body).toContain('DOCUMENT_REFERENCE_REQUIRED');
    expect(applications()).toHaveLength(0);
  });

  it('refuses an implausible phone number', async () => {
    const cookie = await signIn('ops');
    const reply = await post(cookie, { phone: '12' });
    expect(reply.body).toContain('PHONE_NOT_PLAUSIBLE');
    expect(applications()).toHaveLength(0);
  });

  it('hands the form back filled in, so one field is fixed and not seven', async () => {
    const cookie = await signIn('ops');
    const reply = await post(cookie, { phone: '12' });
    expect(reply.body).toContain('Abebe Airtime Shop');
    expect(reply.body).toContain('Abebe Bekele Tadesse');
    expect(reply.body).toContain('TIN-0012345678');
  });

  it('refuses a TIN already registered to another shop', async () => {
    // The signal the unique index was added for: one person opening shops under
    // several names.
    const cookie = await signIn('ops');
    await post(cookie);
    expect(applications()).toHaveLength(1);

    const second = await post(cookie, {
      legalName: 'A Different Shop',
      tradeLicence: 'TL/AA/2026/00001',
      photoId: 'ID-ETH-0000001',
      // Same TIN.
    });
    expect(second.body).toContain('DOCUMENT_ALREADY_REGISTERED_TO_ANOTHER_SHOP');
    expect(applications()).toHaveLength(1);
  });

  it('leaves nothing behind when a document collides', async () => {
    // The first version wrote the application, then the documents, so a
    // duplicate TIN left an application with no papers in the review queue —
    // created by the very check meant to refuse it. Both writes are now one
    // transaction, and this is what proves it stayed that way.
    const cookie = await signIn('ops');
    await post(cookie);
    const documentsBefore = documents().length;

    await post(cookie, {
      legalName: 'A Different Shop',
      tradeLicence: 'TL/AA/2026/00001',
      photoId: 'ID-ETH-0000001',
    });

    expect(applications()).toHaveLength(1);
    expect(documents()).toHaveLength(documentsBefore);
  });
});

describe('who may record one', () => {
  it('refuses an auditor, who reads everything and changes nothing', async () => {
    const cookie = await signIn('reader', 'AUDITOR');
    const reply = await post(cookie);
    expect(reply.status).toBe(403);
    expect(applications()).toHaveLength(0);
  });

  it('refuses an unauthenticated caller on the form and the route alike', async () => {
    const form = await send('/applications/new');
    expect(form.status).toBe(303);
    expect(form.location).toBe('/login');

    const submit = await post('');
    expect(submit.status).toBe(303);
    expect(applications()).toHaveLength(0);
  });
});

describe('the whole chain', () => {
  it('registers, reviews, approves — and only then is there a shop', async () => {
    const cookie = await signIn('ops');

    // 1. Register. No shop yet.
    await post(cookie);
    const id = String(applications()[0]?.['id']);
    expect(countOf('merchants')).toBe(0);

    // 2. Pick up for review. Still no shop.
    await send(`/applications/${id}/pick-up`, { method: 'POST', cookie, body: '' });
    expect(String(applications()[0]?.['status'])).toBe('UNDER_REVIEW');
    expect(countOf('merchants')).toBe(0);

    // 3. Approve. **Now** there is a shop, its registry row, and the link back.
    await send(`/applications/${id}/decide`, {
      method: 'POST',
      cookie,
      body: new URLSearchParams({ outcome: 'APPROVE', reason: 'documents checked' }).toString(),
    });

    expect(countOf('merchants')).toBe(1);
    expect(countOf('tenant_registry')).toBe(1);
    expect(applications()[0]).toMatchObject({ status: 'DEVICE_PENDING' });
    expect(String(applications()[0]?.['merchant_id'])).toMatch(/^mch_/);

    // The documents followed the application into the approved shop's file.
    expect(documents()).toHaveLength(3);
  });
});
