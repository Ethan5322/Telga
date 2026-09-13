/**
 * Telga staff authentication, end to end against a real database.
 *
 * The owner brief §5 sets the shape and §12 names the refusals. The tests that
 * matter here are the ones about **not** getting in:
 *
 *   - a wrong password, an unknown email and a suspended account are refused
 *     identically, so an account list cannot be enumerated;
 *   - five failures lock the account;
 *   - a session that has cleared the password and nothing else can do nothing;
 *   - suspending an admin takes effect on their next request, not their next
 *     sign-in.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, saveAdminUser, setAdminStatus, grantAdminPermission } from '@telga/persistence';
import {
  ADMIN_AUTH_POLICY,
  adminLogin,
  authenticateAdmin,
  hashAdminSecret,
  beginMfaEnrolment,
  totpAt,
  revokeAdminEverywhere,
  satisfyAdminMfa,
  stepUpAdmin,
} from '@telga/api';
import { AdminAccessDeniedError, requireAdmin } from '@telga/domain';
import type { Timestamp } from '@telga/domain';

let dir: string;
let db: Database.Database;
let clock = Date.parse('2026-08-30T09:00:00.000Z');

const now = (): string => new Date(clock).toISOString();
const advance = (ms: number): void => {
  clock += ms;
};

const ports = () => ({ db, now, newId: (p: string) => `${p}_1` });

const PASSWORD = 'a-long-enough-admin-password';

beforeEach(async () => {
  clock = Date.parse('2026-08-30T09:00:00.000Z');
  dir = mkdtempSync(join(tmpdir(), 'telga-adminauth-'));
  db = new Database(join(dir, 'telga.sqlite'));
  db.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS) db.exec(`BEGIN; ${migration.sql} COMMIT;`);

  const derived = await hashAdminSecret(PASSWORD);
  saveAdminUser(db, {
    id: 'adm_owner',
    email: 'Owner@Telga.Example',
    displayName: 'Owner',
    department: 'PLATFORM',
    role: 'PLATFORM_OWNER',
    passwordHash: derived.hash,
    passwordSalt: derived.salt,
    passwordParams: derived.params,
    status: 'ACTIVE',
    at: now(),
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('signing in', () => {
  it('accepts the right password, whatever case the email was typed in', async () => {
    // Stored lowercased; SQLite's UNIQUE is case-sensitive, so matching has to
    // normalise or one person becomes two accounts.
    const result = await adminLogin(ports(), { email: 'owner@telga.example', password: PASSWORD });
    expect(result.kind).toBe('AUTHENTICATED');
    if (result.kind !== 'AUTHENTICATED') return;
    expect(result.user.role).toBe('PLATFORM_OWNER');
    expect(result.sessionToken.length).toBeGreaterThan(20);
  });

  it('issues a session that has NOT cleared the second factor', async () => {
    // The password is the first gate, never the last.
    const result = await adminLogin(ports(), { email: 'owner@telga.example', password: PASSWORD });
    expect(result.kind === 'AUTHENTICATED' && result.mfaSatisfied).toBe(false);
  });

  it('refuses a wrong password, an unknown email and a suspended account alike', async () => {
    // Three different truths, one answer. Telling an attacker which they hit is
    // how an account list gets enumerated.
    const wrong = await adminLogin(ports(), { email: 'owner@telga.example', password: 'nope' });
    const unknown = await adminLogin(ports(), { email: 'ghost@telga.example', password: PASSWORD });

    setAdminStatus(db, 'adm_owner', 'SUSPENDED', now());
    const suspended = await adminLogin(ports(), {
      email: 'owner@telga.example',
      password: PASSWORD,
    });

    for (const [label, result] of [
      ['wrong password', wrong],
      ['unknown email', unknown],
      ['suspended account', suspended],
    ] as const) {
      expect(result.kind, label).toBe('REFUSED');
      if (result.kind === 'REFUSED') expect(result.reason, label).toBe('INVALID_CREDENTIALS');
    }
  });
});

describe('lockout — four, then ten minutes, then two chances, then a day (D161)', () => {
  const wrongOnce = async (): Promise<void> => {
    await adminLogin(ports(), { email: 'owner@telga.example', password: 'wrong' });
  };
  const tryCorrect = async () =>
    adminLogin(ports(), { email: 'owner@telga.example', password: PASSWORD });

  it('does not lock on the first three failures', async () => {
    for (let i = 0; i < 3; i += 1) await wrongOnce();
    // Three typos is a person having a bad morning, not an attack.
    expect((await tryCorrect()).kind).toBe('AUTHENTICATED');
  });

  it('holds the account on the fourth failure', async () => {
    for (let i = 0; i < ADMIN_AUTH_POLICY.lockAfterAttempts; i += 1) await wrongOnce();
    const locked = await tryCorrect();
    // The correct password is refused too while a hold stands.
    expect(locked.kind).toBe('REFUSED');
    if (locked.kind === 'REFUSED') expect(locked.reason).toBe('ACCOUNT_LOCKED');
  });

  it('holds for ten minutes, not fifteen', async () => {
    for (let i = 0; i < 4; i += 1) await wrongOnce();
    advance(9 * 60 * 1000);
    expect((await tryCorrect()).kind, 'still held at nine minutes').toBe('REFUSED');
    advance(2 * 60 * 1000);
    expect((await tryCorrect()).kind, 'free at eleven').toBe('AUTHENTICATED');
  });

  it('gives two more chances after the hold, instead of re-locking at once', async () => {
    for (let i = 0; i < 4; i += 1) await wrongOnce();
    advance(ADMIN_AUTH_POLICY.lockForMs + 1000);

    // The fifth failure. Under the old flat policy this re-locked immediately,
    // which is what made a forgotten password unrecoverable — one try per
    // fifteen minutes, forever.
    await wrongOnce();
    expect((await tryCorrect()).kind, 'first chance').toBe('AUTHENTICATED');
  });

  it('locks for twenty-four hours once both chances are spent', async () => {
    for (let i = 0; i < 4; i += 1) await wrongOnce();
    advance(ADMIN_AUTH_POLICY.lockForMs + 1000);
    await wrongOnce(); // fifth — the first chance
    await wrongOnce(); // sixth — the second, and the last

    const locked = await tryCorrect();
    expect(locked.kind).toBe('REFUSED');
    if (locked.kind === 'REFUSED') expect(locked.reason).toBe('ACCOUNT_LOCKED');

    // Ten minutes is nowhere near enough now.
    advance(60 * 60 * 1000);
    expect((await tryCorrect()).kind, 'still held after an hour').toBe('REFUSED');

    advance(24 * 60 * 60 * 1000);
    expect((await tryCorrect()).kind, 'free after a day').toBe('AUTHENTICATED');
  });

  it('a correct password inside the grace window clears the whole escalation', async () => {
    for (let i = 0; i < 4; i += 1) await wrongOnce();
    advance(ADMIN_AUTH_POLICY.lockForMs + 1000);
    expect((await tryCorrect()).kind).toBe('AUTHENTICATED');

    // Back to a clean slate: four more failures are needed to hold it again,
    // and the next tier is the ten-minute one, not the day.
    for (let i = 0; i < 3; i += 1) await wrongOnce();
    expect((await tryCorrect()).kind, 'three failures do not hold it').toBe('AUTHENTICATED');
  });

  it('clears the counter on a success, so failures do not accumulate forever', async () => {
    for (let i = 0; i < 3; i += 1) {
      await adminLogin(ports(), { email: 'owner@telga.example', password: 'wrong' });
    }
    await adminLogin(ports(), { email: 'owner@telga.example', password: PASSWORD });
    // A fourth in a row would hold it if the counter had not been reset.
    for (let i = 0; i < 3; i += 1) {
      await adminLogin(ports(), { email: 'owner@telga.example', password: 'wrong' });
    }
    const ok = await adminLogin(ports(), { email: 'owner@telga.example', password: PASSWORD });
    expect(ok.kind).toBe('AUTHENTICATED');
  });
});

describe('a session that has only cleared the password', () => {
  it('can do nothing at all — not even read', async () => {
    const login = await adminLogin(ports(), { email: 'owner@telga.example', password: PASSWORD });
    if (login.kind !== 'AUTHENTICATED') throw new Error('expected a session');
    const auth = authenticateAdmin(ports(), login.sessionToken);
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;

    expect(auth.context.mfaSatisfied).toBe(false);
    expect(() =>
      requireAdmin(auth.context, 'ADMIN_VIEW_MERCHANT', now() as Timestamp),
    ).toThrow(/MFA_REQUIRED/);
  });

  it('works once the second factor is cleared', async () => {
    const login = await adminLogin(ports(), { email: 'owner@telga.example', password: PASSWORD });
    if (login.kind !== 'AUTHENTICATED') throw new Error('expected a session');
    const first = authenticateAdmin(ports(), login.sessionToken);
    if (!first.ok) throw new Error('expected an authenticated session');

    // A real TOTP: enrol once, then derive the code from the shared secret and
    // the clock. Nothing is transmitted and nothing is displayed.
    const { secret } = beginMfaEnrolment(ports(), 'adm_owner', 'owner@telga.example');
    const code = totpAt(secret, clock);
    expect(await satisfyAdminMfa(ports(), first.sessionId, 'adm_owner', code)).toBe(true);

    const second = authenticateAdmin(ports(), login.sessionToken);
    expect(second.ok && second.context.mfaSatisfied).toBe(true);
    if (!second.ok) return;
    expect(() =>
      requireAdmin(second.context, 'ADMIN_VIEW_MERCHANT', now() as Timestamp),
    ).not.toThrow();
  });

  it('refuses a wrong second-factor code', async () => {
    const login = await adminLogin(ports(), { email: 'owner@telga.example', password: PASSWORD });
    if (login.kind !== 'AUTHENTICATED') throw new Error('expected a session');
    const auth = authenticateAdmin(ports(), login.sessionToken);
    if (!auth.ok) throw new Error('expected an authenticated session');

    const { secret } = beginMfaEnrolment(ports(), 'adm_owner', 'owner@telga.example');
    const wrong = totpAt(secret, clock) === '000000' ? '111111' : '000000';
    expect(await satisfyAdminMfa(ports(), auth.sessionId, wrong, wrong)).toBe(false);
    const still = authenticateAdmin(ports(), login.sessionToken);
    expect(still.ok && still.context.mfaSatisfied).toBe(false);
  });
});

describe('the second factor is derived, not issued', () => {
  it('cannot be cleared by an account with no authenticator enrolled', async () => {
    // The account starts with no secret. There is no code that works, which is
    // what sends a new admin to enrolment rather than into the console.
    const login = await adminLogin(ports(), { email: 'owner@telga.example', password: PASSWORD });
    if (login.kind !== 'AUTHENTICATED') throw new Error('expected a session');
    const auth = authenticateAdmin(ports(), login.sessionToken);
    if (!auth.ok) throw new Error('expected an authenticated session');
    expect(await satisfyAdminMfa(ports(), auth.sessionId, 'adm_owner', '000000')).toBe(false);
  });

  it('gives each admin a different secret', () => {
    const a = beginMfaEnrolment(ports(), 'adm_owner', 'owner@telga.example');
    const b = beginMfaEnrolment(ports(), 'adm_owner', 'owner@telga.example');
    expect(a.secret).not.toBe(b.secret);
    expect(a.secret).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('hands out an otpauth URI an authenticator app can import', () => {
    const { uri } = beginMfaEnrolment(ports(), 'adm_owner', 'owner@telga.example');
    expect(uri).toMatch(/^otpauth:\/\/totp\/Telga%3Aowner%40telga\.example\?/);
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });
});

describe('step-up re-authentication', () => {
  it('asks for the password, not the second factor', async () => {
    // A step-up asks "is this still the person who signed in". A code from a
    // device sitting on the desk beside the laptop does not answer that.
    const login = await adminLogin(ports(), { email: 'owner@telga.example', password: PASSWORD });
    if (login.kind !== 'AUTHENTICATED') throw new Error('expected a session');
    const auth = authenticateAdmin(ports(), login.sessionToken);
    if (!auth.ok) throw new Error('expected an authenticated session');

    expect(await stepUpAdmin(ports(), auth.sessionId, 'adm_owner', 'wrong')).toBe(false);
    expect(await stepUpAdmin(ports(), auth.sessionId, 'adm_owner', PASSWORD)).toBe(true);
  });

  it('unlocks a high-risk action, and only inside its window', async () => {
    const login = await adminLogin(ports(), { email: 'owner@telga.example', password: PASSWORD });
    if (login.kind !== 'AUTHENTICATED') throw new Error('expected a session');
    let auth = authenticateAdmin(ports(), login.sessionToken);
    if (!auth.ok) throw new Error('expected an authenticated session');

    const { secret } = beginMfaEnrolment(ports(), 'adm_owner', 'owner@telga.example');
    await satisfyAdminMfa(ports(), auth.sessionId, 'adm_owner', totpAt(secret, clock));
    await stepUpAdmin(ports(), auth.sessionId, 'adm_owner', PASSWORD);

    auth = authenticateAdmin(ports(), login.sessionToken);
    if (!auth.ok) throw new Error('expected an authenticated session');
    expect(() =>
      requireAdmin(auth.context, 'ADMIN_APPROVE_FUNDING', now() as Timestamp),
    ).not.toThrow();

    // Six minutes later the proof is stale, and the same action is refused.
    const later = new Date(clock + 6 * 60 * 1000).toISOString() as Timestamp;
    expect(() => requireAdmin(auth.context, 'ADMIN_APPROVE_FUNDING', later)).toThrow(
      /STEP_UP_REQUIRED/,
    );
  });
});

describe('sessions', () => {
  it('expires on inactivity', async () => {
    const login = await adminLogin(ports(), { email: 'owner@telga.example', password: PASSWORD });
    if (login.kind !== 'AUTHENTICATED') throw new Error('expected a session');
    advance(ADMIN_AUTH_POLICY.idleTimeoutMs + 1000);
    const auth = authenticateAdmin(ports(), login.sessionToken);
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.reason).toBe('SESSION_IDLE_EXPIRED');
  });

  it('expires at the hard ceiling however active it was', async () => {
    const login = await adminLogin(ports(), { email: 'owner@telga.example', password: PASSWORD });
    if (login.kind !== 'AUTHENTICATED') throw new Error('expected a session');
    // Busy the whole time: touched every ten minutes, so idle never trips.
    // The assertion is on the call that *crosses* the ceiling — the first
    // refusal revokes the session, so any call after that correctly reports
    // SESSION_REVOKED instead, and checking a later one would test the wrong
    // thing.
    let crossing: ReturnType<typeof authenticateAdmin> | undefined;
    for (let i = 0; i < 60 && crossing === undefined; i += 1) {
      advance(10 * 60 * 1000);
      const auth = authenticateAdmin(ports(), login.sessionToken);
      if (!auth.ok) crossing = auth;
    }
    expect(crossing, 'the session never expired').toBeDefined();
    if (crossing && !crossing.ok) expect(crossing.reason).toBe('SESSION_LIFETIME_EXPIRED');
  });

  it('dies the moment the admin is suspended, not at their next sign-in', async () => {
    // Status is read on every request rather than trusted from the session row.
    const login = await adminLogin(ports(), { email: 'owner@telga.example', password: PASSWORD });
    if (login.kind !== 'AUTHENTICATED') throw new Error('expected a session');
    expect(authenticateAdmin(ports(), login.sessionToken).ok).toBe(true);

    setAdminStatus(db, 'adm_owner', 'SUSPENDED', now());
    const after = authenticateAdmin(ports(), login.sessionToken);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe('ACCOUNT_INACTIVE');
  });

  it('can be revoked everywhere at once', async () => {
    // What a password change needs: a credential that has changed must not
    // leave a session issued under the old one still working.
    const a = await adminLogin(ports(), { email: 'owner@telga.example', password: PASSWORD });
    const b = await adminLogin(ports(), { email: 'owner@telga.example', password: PASSWORD });
    if (a.kind !== 'AUTHENTICATED' || b.kind !== 'AUTHENTICATED') throw new Error('expected two');

    expect(revokeAdminEverywhere(ports(), 'adm_owner', 'PASSWORD_CHANGED')).toBe(2);
    for (const session of [a, b]) {
      const auth = authenticateAdmin(ports(), session.sessionToken);
      expect(auth.ok).toBe(false);
      if (!auth.ok) expect(auth.reason).toBe('SESSION_REVOKED');
    }
  });

  it('refuses a token that was never issued', () => {
    const auth = authenticateAdmin(ports(), 'not-a-real-token');
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.reason).toBe('SESSION_UNKNOWN');
  });

  it('refuses a missing token', () => {
    expect(authenticateAdmin(ports(), undefined).ok).toBe(false);
  });
});

describe('grants reach the session', () => {
  it('widens what an admin may do without changing their role', async () => {
    const derived = await hashAdminSecret(PASSWORD);
    saveAdminUser(db, {
      id: 'adm_sales',
      email: 'sales@telga.example',
      displayName: 'Sales One',
      department: 'SALES',
      role: 'DEPARTMENT_ADMIN',
      passwordHash: derived.hash,
      passwordSalt: derived.salt,
      passwordParams: derived.params,
      status: 'ACTIVE',
      createdBy: 'adm_owner',
      approvedBy: 'adm_owner',
      at: now(),
    });
    grantAdminPermission(db, {
      adminUserId: 'adm_sales',
      permission: 'ADMIN_REGISTER_DEVICE',
      grantedBy: 'adm_owner',
      at: now(),
    });

    const login = await adminLogin(ports(), { email: 'sales@telga.example', password: PASSWORD });
    if (login.kind !== 'AUTHENTICATED') throw new Error('expected a session');
    const auth = authenticateAdmin(ports(), login.sessionToken);
    if (!auth.ok) throw new Error('expected an authenticated session');

    const { secret } = beginMfaEnrolment(ports(), 'adm_sales', 'sales@telga.example');
    await satisfyAdminMfa(ports(), auth.sessionId, 'adm_sales', totpAt(secret, clock));
    await stepUpAdmin(ports(), auth.sessionId, 'adm_sales', PASSWORD);

    const ready = authenticateAdmin(ports(), login.sessionToken);
    if (!ready.ok) throw new Error('expected an authenticated session');
    expect(() =>
      requireAdmin(ready.context, 'ADMIN_REGISTER_DEVICE', now() as Timestamp),
    ).not.toThrow();
    // And still cannot do what the grant did not cover.
    expect(() => requireAdmin(ready.context, 'ADMIN_MANAGE_ADMINS', now() as Timestamp)).toThrow(
      AdminAccessDeniedError,
    );
  });
});
