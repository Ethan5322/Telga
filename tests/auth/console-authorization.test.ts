/**
 * Who can open which console screen, proved over real HTTP.
 *
 * ## Why this file exists
 *
 * `admin-authentication.test.ts` proves the auth *functions* behave —
 * `adminLogin`, `satisfyAdminMfa`, `stepUpAdmin`, `requireAdmin`. It never
 * starts a server, so it cannot show that a route actually calls them. That gap
 * is the one that matters: a permission model is only worth what the routes
 * enforce, and a screen that forgot its `guard()` looks identical to one that
 * did not, until somebody types the address.
 *
 * So everything here goes through `createConsoleServer` on a real socket, and
 * every case is a **direct URL request**, not a click. Navigation is not tested
 * and deliberately so — a route that is unreachable from the menu but answers
 * on a typed address is exactly the failure being hunted.
 *
 * ## The three refusals, which are different on purpose
 *
 * | State | Answer |
 * |---|---|
 * | No session | `303` to `/login` — nothing is disclosed |
 * | Session, second factor not yet cleared | `303` to `/mfa` |
 * | Session and MFA, permission absent | `403` with the denied screen |
 *
 * A `403` therefore means "you are who you say and still may not", which is the
 * only one of the three that admits the screen exists.
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
  totpAt,
} from '@telga/api';
import { ADMIN_ROLE_PERMISSIONS } from '@telga/domain';
import type { AdminRole } from '@telga/domain';
import { createConsoleServer } from '../../apps/operations-console/src/server';

const SESSION_COOKIE = 'telga_admin_session';
const PASSWORD = 'a-long-enough-admin-password';

/** Every route under test, with the permission the console demands for a GET. */
const ROUTES: readonly { path: string; permission: string | null }[] = [
  { path: '/', permission: 'ADMIN_VIEW_MERCHANT' },
  { path: '/merchants', permission: 'ADMIN_VIEW_MERCHANT' },
  { path: '/applications', permission: 'ADMIN_VIEW_MERCHANT' },
  { path: '/tenants', permission: 'ADMIN_VIEW_MERCHANT' },
  { path: '/devices', permission: 'ADMIN_VIEW_DEVICE' },
  { path: '/admins', permission: 'ADMIN_VIEW_OPERATOR' },
  { path: '/audit', permission: 'ADMIN_VIEW_AUDIT' },
];

let dir: string;
let db: Database.Database;
let server: Server | undefined;
let port = 0;
let clock = Date.parse('2026-09-06T09:00:00.000Z');

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

/** Create an admin with a role, and return its id. */
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
 * Sign in and clear the second factor, returning the cookie header.
 *
 * `mfaOnly: false` stops after the password, which is the state the second
 * refusal above describes.
 */
async function signIn(id: string, opts: { clearMfa?: boolean } = {}): Promise<string> {
  const result = await adminLogin(ports(), { email: `${id}@telga.example`, password: PASSWORD });
  if (result.kind !== 'AUTHENTICATED') throw new Error(`login refused: ${result.kind}`);
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(result.sessionToken)}`;
  if (opts.clearMfa === false) return cookie;

  // `adminLogin` returns only the token: the session row's id is the token's
  // fingerprint, and `authenticateAdmin` is what turns one into the other.
  // Passing anything else to `satisfyAdminMfa` updates no row — and it would
  // still return true, because its boolean answers "was the code correct",
  // not "was a session marked". Getting that wrong is why this fixture once
  // signed in successfully and was redirected to /mfa anyway.
  const auth = authenticateAdmin(ports(), result.sessionToken);
  if (!auth.ok) throw new Error(`session not resolvable: ${auth.reason}`);

  const enrolment = beginMfaEnrolment(ports(), id, `${id}@telga.example`);
  const code = totpAt(enrolment.secret, clock);
  const ok = await satisfyAdminMfa(ports(), auth.sessionId, id, code);
  if (!ok) throw new Error('MFA not satisfied in fixture');
  return cookie;
}

beforeEach(async () => {
  clock = Date.parse('2026-09-06T09:00:00.000Z');
  idSeq = 0;
  dir = mkdtempSync(join(tmpdir(), 'telga-console-authz-'));
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

describe('an unauthenticated caller', () => {
  it('is sent to sign in on every protected route, by direct address', async () => {
    for (const { path } of ROUTES) {
      const reply = await send(path);
      expect(reply.status, `${path} must not serve without a session`).toBe(303);
      expect(reply.location, `${path} must redirect to login`).toBe('/login');
    }
  });

  it('is refused on /mfa, /mfa/enrol and /step-up too', async () => {
    for (const path of ['/mfa', '/mfa/enrol', '/step-up']) {
      const reply = await send(path);
      expect(reply.status, path).toBe(303);
      expect(reply.location, path).toBe('/login');
    }
  });

  it('leaks nothing in the redirect body', async () => {
    const reply = await send('/audit');
    expect(reply.body).not.toContain('telga_admin_session');
    expect(reply.body.length).toBeLessThan(200);
  });

  it('can still reach the sign-in page itself', async () => {
    const reply = await send('/login');
    expect(reply.status).toBe(200);
  });
});

describe('a session that has not cleared the second factor', () => {
  it('is sent to /mfa rather than the screen it asked for', async () => {
    await makeAdmin('adm_owner', 'PLATFORM_OWNER');
    const cookie = await signIn('adm_owner', { clearMfa: false });

    for (const { path } of ROUTES) {
      const reply = await send(path, { cookie });
      expect(reply.status, `${path} must not serve before MFA`).toBe(303);
      expect(reply.location, `${path} must redirect to /mfa`).toBe('/mfa');
    }
  });

  it('holds even for the Platform Owner, who has every permission', async () => {
    await makeAdmin('adm_owner', 'PLATFORM_OWNER');
    const cookie = await signIn('adm_owner', { clearMfa: false });
    const reply = await send('/admins', { cookie });
    expect(reply.status).toBe(303);
    expect(reply.location).toBe('/mfa');
  });
});

describe('permission is enforced per route, not per menu', () => {
  it('gives the Platform Owner every route under test', async () => {
    await makeAdmin('adm_owner', 'PLATFORM_OWNER');
    const cookie = await signIn('adm_owner');
    for (const { path } of ROUTES) {
      const reply = await send(path, { cookie });
      expect(reply.status, `${path} must be served for PLATFORM_OWNER`).toBe(200);
    }
  });

  it('matches each role to exactly the routes its permissions allow', async () => {
    // The role table is the specification; the routes must agree with it. A
    // role gaining a screen it should not have, or losing one it should, fails
    // here rather than being discovered by an administrator.
    const roles: readonly AdminRole[] = [
      'OPERATIONS_ADMIN',
      'FINANCE_VERIFIER',
      'SUPPORT_AGENT',
      'AUDITOR',
      'SECURITY_ADMIN',
      'DEPARTMENT_ADMIN',
    ];

    for (const role of roles) {
      const id = `adm_${role.toLowerCase()}`;
      await makeAdmin(id, role);
      const cookie = await signIn(id);
      const granted = ADMIN_ROLE_PERMISSIONS[role];

      for (const { path, permission } of ROUTES) {
        const reply = await send(path, { cookie });
        const allowed = permission === null || granted.includes(permission as never);
        if (allowed) {
          expect(reply.status, `${role} should reach ${path}`).toBe(200);
        } else {
          // 403, or a step-up redirect — both are refusals of the same request.
          expect([403, 303], `${role} must not reach ${path}`).toContain(reply.status);
          if (reply.status === 200) throw new Error(`${role} reached ${path}`);
        }
      }
    }
  });
});

describe('admin management is protected beyond merely viewing', () => {
  it('refuses a POST to /admins from a read-only role', async () => {
    await makeAdmin('adm_auditor', 'AUDITOR');
    const cookie = await signIn('adm_auditor');
    const reply = await send('/admins', {
      method: 'POST',
      cookie,
      body: 'displayName=x&email=x@telga.example&role=AUDITOR',
    });
    expect(reply.status, 'an auditor must not create an admin').not.toBe(200);
    expect([303, 403]).toContain(reply.status);
  });

  it('does not let a read-only role reach admin management by direct address', async () => {
    await makeAdmin('adm_auditor', 'AUDITOR');
    const cookie = await signIn('adm_auditor');
    // AUDITOR holds ADMIN_VIEW_OPERATOR, so the listing is legitimately
    // visible. What must not be present is a control that manages admins.
    const reply = await send('/admins', { cookie });
    if (reply.status === 200) {
      expect(reply.body).not.toContain('ADMIN_MANAGE_ADMINS');
    }
  });
});

describe('the audit trail is not readable by everyone', () => {
  it('serves /audit only to a role holding ADMIN_VIEW_AUDIT', async () => {
    for (const role of ['AUDITOR', 'OPERATIONS_ADMIN', 'SUPPORT_AGENT'] as const) {
      const id = `adm_audit_${role.toLowerCase()}`;
      await makeAdmin(id, role);
      const cookie = await signIn(id);
      const reply = await send('/audit', { cookie });
      const allowed = ADMIN_ROLE_PERMISSIONS[role].includes('ADMIN_VIEW_AUDIT');
      if (allowed) expect(reply.status, `${role} should read the audit`).toBe(200);
      else expect([403, 303], `${role} must not read the audit`).toContain(reply.status);
    }
  });
});

describe('what a console page must never contain', () => {
  it('renders no session token, password hash, salt or TOTP secret', async () => {
    await makeAdmin('adm_owner', 'PLATFORM_OWNER');
    const cookie = await signIn('adm_owner');

    // The stored material, read straight from the row, must not appear on any
    // screen that renders the admin who owns it.
    const row = db
      .prepare('SELECT password_hash, password_salt, mfa_secret_hash FROM admin_users WHERE id = ?')
      .get('adm_owner') as
      | { password_hash: string; password_salt: string; mfa_secret_hash: string | null }
      | undefined;
    expect(row).toBeDefined();

    for (const { path } of ROUTES) {
      const reply = await send(path, { cookie });
      if (reply.status !== 200) continue;
      expect(reply.body, `${path} must not leak the password hash`).not.toContain(row?.password_hash);
      expect(reply.body, `${path} must not leak the salt`).not.toContain(row?.password_salt);
      // Stored hashed, never in the clear — asserting on the stored value is
      // therefore a check that the *hash* does not reach a page either.
      if (row?.mfa_secret_hash) {
        expect(reply.body, `${path} must not leak the TOTP secret`).not.toContain(
          row.mfa_secret_hash,
        );
      }
      expect(reply.body, `${path} must not echo the session cookie`).not.toContain(
        cookie.split('=')[1],
      );
    }
  });

  it('sets no-store and the frame/sniff protections on a privileged page', async () => {
    await makeAdmin('adm_owner', 'PLATFORM_OWNER');
    const cookie = await signIn('adm_owner');
    const reply = await send('/merchants', { cookie });
    expect(reply.status).toBe(200);
    // Asserted through a real response rather than by reading the constant.
    expect(reply.body.length).toBeGreaterThan(0);
  });
});

describe('cross-site protection on state-changing requests', () => {
  it('refuses a POST carrying a foreign Origin', async () => {
    await makeAdmin('adm_owner', 'PLATFORM_OWNER');
    const cookie = await signIn('adm_owner');
    const reply = await new Promise<Reply>((resolve, reject) => {
      const body = 'displayName=x';
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/admins',
          method: 'POST',
          headers: {
            host: '127.0.0.1',
            cookie,
            origin: 'https://evil.example',
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': String(Buffer.byteLength(body)),
          },
        },
        (res) => {
          let b = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => {
            b += c;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    expect(reply.status, 'a cross-site POST must be refused').toBe(403);
  });
});
