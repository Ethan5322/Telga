/**
 * Uploading a shop's licence and passport, over HTTP, into the encrypted vault.
 *
 * **M1b.** `document-vault.test.ts` proves the encryption and `multipart.test.ts`
 * proves the parsing; this proves the two are actually joined to a route, which
 * is the part that has been missing elsewhere in this codebase often enough to
 * be worth asserting rather than assuming.
 *
 * It also proves the half of **R37** that storage cannot: who may open a
 * document, and that the opening is recorded.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
  newDocumentEncryptionKey,
  satisfyAdminMfa,
  stepUpAdmin,
  totpAt,
} from '@telga/api';
import type { AdminRole } from '@telga/domain';
import { createConsoleServer } from '../../apps/operations-console/src/server';

const SESSION_COOKIE = 'telga_admin_session';
const PASSWORD = 'a-long-enough-admin-password';
const BOUNDARY = '----TelgaBoundary9f2';
const KEY = newDocumentEncryptionKey();

/** Every byte value, so "the bytes survived" is not a claim about ASCII. */
const SCAN = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

let dir: string;
let documentsDir: string;
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
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

function send(
  path: string,
  init: { method?: string; cookie?: string; body?: Buffer; contentType?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: '127.0.0.1' };
    if (init.cookie !== undefined && init.cookie.length > 0) headers['cookie'] = init.cookie;
    if (init.body !== undefined) {
      headers['content-type'] = init.contentType ?? 'application/x-www-form-urlencoded';
      headers['content-length'] = String(init.body.byteLength);
    }
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/** A registration form the way a browser posts one, with files attached. */
function registrationBody(
  files: readonly { name: string; filename: string; mediaType: string; content: Buffer }[],
  fields: Readonly<Record<string, string>> = {},
): Buffer {
  const text: Record<string, string> = {
    legalName: 'Abebe Airtime Shop',
    address: 'Bole Road 12',
    locality: 'Addis Ababa',
    ownerName: 'Abebe Bekele Tadesse',
    phone: '+251911000000',
    email: '',
    tradeLicence: 'TL/AA/2026/99887',
    tradeLicenceExpiry: '2027-06-30',
    tin: 'TIN-0012345678',
    photoId: 'ID-ETH-4455667',
    ...fields,
  };
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(text)) {
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${file.name}"; ` +
          `filename="${file.filename}"\r\nContent-Type: ${file.mediaType}\r\n\r\n`,
        'utf8',
      ),
    );
    chunks.push(file.content);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

const THREE_SCANS = [
  { name: 'tradeLicenceFile', filename: 'licence.jpg', mediaType: 'image/jpeg', content: SCAN },
  { name: 'tinFile', filename: 'tin.png', mediaType: 'image/png', content: SCAN },
  { name: 'photoIdFile', filename: 'passport.pdf', mediaType: 'application/pdf', content: SCAN },
];

const register = (cookie: string, body: Buffer): Promise<Reply> =>
  send('/applications', {
    method: 'POST',
    cookie,
    body,
    contentType: `multipart/form-data; boundary=${BOUNDARY}`,
  });

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

const documentRows = (): Record<string, unknown>[] =>
  db
    .prepare(`SELECT * FROM merchant_application_documents ORDER BY kind`)
    .all() as Record<string, unknown>[];

const applicationId = (): string =>
  String(
    (db.prepare(`SELECT id FROM merchant_applications LIMIT 1`).get() as { id: string } | undefined)
      ?.id ?? '',
  );

async function start(withVault: boolean): Promise<void> {
  server = createConsoleServer({
    db: db as never,
    now,
    newId,
    schemaVersion: '015',
    allowedHosts: ['127.0.0.1', 'localhost'],
    secureCookies: false,
    ...(withVault ? { documents: { directory: documentsDir, encryptionKey: KEY } } : {}),
  });
  await new Promise<void>((resolve) => {
    server?.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve();
    });
  });
}

beforeEach(() => {
  idSeq = 0;
  dir = mkdtempSync(join(tmpdir(), 'telga-docs-http-'));
  documentsDir = join(dir, 'documents');
  db = new Database(join(dir, 'telga.sqlite'));
  db.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS) db.exec(`BEGIN; ${migration.sql} COMMIT;`);
});

afterEach(() => {
  server?.close();
  server = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('uploading the three scans', () => {
  it('stores each one encrypted and records the handle', async () => {
    await start(true);
    const cookie = await signIn('owner');

    const reply = await register(cookie, registrationBody(THREE_SCANS));
    expect(reply.status).toBe(303);

    const rows = documentRows();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row['document_uri']).toMatch(/^doc_[A-Za-z0-9_-]+\.enc$/);
      expect(row['byte_size']).toBe(SCAN.byteLength);
    }
    expect(rows.map((r) => r['media_type'])).toEqual([
      'application/pdf', // OWNER_PHOTO_ID
      'image/png', // TIN_CERTIFICATE
      'image/jpeg', // TRADE_LICENCE
    ]);
    expect(readdirSync(documentsDir)).toHaveLength(3);
  });

  it('writes no readable passport to the disk', async () => {
    // The assertion R37 exists for, made at the level an operator would meet it:
    // through the route, not the primitive.
    await start(true);
    const cookie = await signIn('owner');
    await register(cookie, registrationBody(THREE_SCANS));

    for (const name of readdirSync(documentsDir)) {
      const onDisk = readFileSync(join(documentsDir, name));
      expect(onDisk.includes(SCAN), `${name} must not contain the plaintext`).toBe(false);
    }
  });

  it('still records a registration when no scans are attached', async () => {
    // A reference number without a photograph is a valid document row. M1a's
    // behaviour is not broken by M1b existing.
    await start(true);
    const cookie = await signIn('owner');
    const reply = await register(cookie, registrationBody([]));

    expect(reply.status).toBe(303);
    expect(documentRows()).toHaveLength(3);
    for (const row of documentRows()) {
      expect(row['document_uri']).toBeNull();
      expect(row['media_type']).toBeNull();
    }
    expect(readdirSync(documentsDir)).toHaveLength(0);
  });
});

describe('opening a stored document', () => {
  const openIt = async (cookie: string): Promise<Reply> => {
    const row = documentRows().find((r) => r['kind'] === 'OWNER_PHOTO_ID');
    return send(
      `/applications/${applicationId()}/documents/${String(row?.['id'])}`,
      { cookie },
    );
  };

  it('returns the exact bytes that were uploaded', async () => {
    await start(true);
    const cookie = await signIn('owner');
    await register(cookie, registrationBody(THREE_SCANS));

    const reply = await openIt(cookie);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual(SCAN);
    expect(reply.headers['content-type']).toBe('application/pdf');
  });

  it('is never cached and never rendered inline', async () => {
    // A passport left in a browser cache on a shared laptop outlives the
    // session that opened it.
    await start(true);
    const cookie = await signIn('owner');
    await register(cookie, registrationBody(THREE_SCANS));

    const reply = await openIt(cookie);
    expect(String(reply.headers['cache-control'])).toContain('no-store');
    expect(String(reply.headers['content-disposition'])).toContain('attachment');
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
  });

  it('records who looked, and at what kind of document', async () => {
    await start(true);
    const cookie = await signIn('owner');
    await register(cookie, registrationBody(THREE_SCANS));
    await openIt(cookie);

    const events = db
      .prepare(`SELECT event_type, actor_id, metadata FROM audit_events WHERE event_type = ?`)
      .all('ADMIN_DOCUMENT_VIEWED') as { actor_id: string; metadata: string | null }[];
    expect(events).toHaveLength(1);
    expect(events[0]?.actor_id).toBe('owner');
    expect(String(events[0]?.metadata)).toContain('OWNER_PHOTO_ID');
    // Never the reference number: an audit screen that carries passport numbers
    // turns every reader of it into a holder of them.
    expect(String(events[0]?.metadata)).not.toContain('ID-ETH-4455667');
  });

  it('refuses a role that may review but not export', async () => {
    // Reading the queue and taking a copy of somebody's passport are different
    // acts. `ADMIN_EXPORT_DATA` says so, and brings step-up with it.
    await start(true);
    const owner = await signIn('owner');
    await register(owner, registrationBody(THREE_SCANS));

    const ops = await signIn('ops', 'OPERATIONS_ADMIN');
    const reply = await openIt(ops);
    expect(reply.status).toBe(403);
    expect(reply.body.includes(SCAN)).toBe(false);
  });

  it('refuses an unauthenticated caller without disclosing anything', async () => {
    await start(true);
    const cookie = await signIn('owner');
    await register(cookie, registrationBody(THREE_SCANS));

    const reply = await openIt('');
    expect(reply.status).toBe(303);
    expect(reply.location).toBe('/login');
    expect(reply.body.includes(SCAN)).toBe(false);
  });

  it('will not serve a document belonging to another application', async () => {
    // The id is scoped to its application, so this cannot be used to walk the
    // store one document id at a time.
    await start(true);
    const cookie = await signIn('owner');
    await register(cookie, registrationBody(THREE_SCANS));
    const row = documentRows()[0];

    const reply = await send(`/applications/app_not_this_one/documents/${String(row?.['id'])}`, {
      cookie,
    });
    expect(reply.status).toBe(404);
    expect(reply.body.includes(SCAN)).toBe(false);
  });
});

describe('what the route refuses', () => {
  it('refuses an upload when no vault is configured, and records nothing', async () => {
    // Never "store it in the clear for now". The registration is refused whole
    // rather than recorded with its documents silently dropped.
    await start(false);
    const cookie = await signIn('owner');

    const reply = await register(cookie, registrationBody(THREE_SCANS));
    expect(reply.status).toBe(200);
    expect(reply.body.toString('utf8')).toContain('DOCUMENT_STORE_NOT_CONFIGURED');
    expect(documentRows()).toHaveLength(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM merchant_applications`).get()).toMatchObject({
      n: 0,
    });
  });

  it('refuses a media type outside the three, before anything is written', async () => {
    await start(true);
    const cookie = await signIn('owner');

    const reply = await register(
      cookie,
      registrationBody([
        { name: 'photoIdFile', filename: 'x.html', mediaType: 'text/html', content: SCAN },
      ]),
    );
    expect(reply.body.toString('utf8')).toContain('DOCUMENT_TYPE_NOT_ALLOWED');
    expect(documentRows()).toHaveLength(0);
    expect(readdirSync(documentsDir)).toHaveLength(0);
  });

  it('refuses a body it cannot parse', async () => {
    await start(true);
    const cookie = await signIn('owner');
    const reply = await register(cookie, Buffer.from('not a multipart body', 'utf8'));
    expect(reply.body.toString('utf8')).toContain('UPLOAD_NOT_READABLE');
    expect(documentRows()).toHaveLength(0);
  });
});
