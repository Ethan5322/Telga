/**
 * Getting a locked-out administrator back in — the console's only way.
 *
 * ## What was reported
 *
 * After the first deployment to `admin.telga.pro`, 2026-09-12: *"Admin console
 * login refuses my email/password every time — never lets me in."*
 *
 * The investigation found something worse than a wrong password. **This product
 * had no way to change an admin password at all**: no console route, no CLI
 * flag, and `saveAdminUser` only inserts — so the Railway boot step that creates
 * the first owner is a no-op ever after, because the email is unique. A Railway
 * container has no shell. The deployment was one forgotten password away from
 * being permanently unadministrable, and nothing would have said so.
 *
 * ## Why the reset clears more than the password
 *
 * `failed_attempts` is **never reset except by a successful sign-in**, and
 * under D161 that persistence is deliberate: it is what lets the escalation
 * know a first hold already happened. Four failures hold the account for ten
 * minutes, two further tries are allowed, and the sixth locks it for **a day**.
 *
 * So a reset that fixed only the password could leave an administrator waiting
 * twenty-four hours with the right password in their hand. It clears the hold
 * and the counter with it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, runMigrations, saveAdminUser, setAdminPassword } from '@telga/persistence';
import { adminLogin, hashAdminSecret } from '@telga/api';

const NOW = '2026-09-12T10:00:00.000Z';
const OLD = 'TheOldPassword1';
const NEW = 'TheNewPassword2';

let dir: string;
let db: Database.Database;

const ports = (at = NOW) => ({
  db: db as never,
  now: () => at,
  newId: (p: string) => `${p}_1`,
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'telga-pwreset-'));
  db = new Database(join(dir, 'ops.sqlite'));
  db.pragma('foreign_keys = ON');
  runMigrations(db as never, NOW as never, MIGRATIONS as never);

  const secret = await hashAdminSecret(OLD);
  saveAdminUser(db as never, {
    id: 'adm_owner',
    email: 'info@telga.example',
    displayName: 'Owner',
    department: 'PLATFORM',
    role: 'PLATFORM_OWNER',
    passwordHash: secret.hash,
    passwordSalt: secret.salt,
    passwordParams: secret.params,
    status: 'ACTIVE',
    at: NOW,
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const reset = async (email: string, password: string): Promise<number> => {
  const derived = await hashAdminSecret(password);
  return setAdminPassword(db as never, {
    email,
    passwordHash: derived.hash,
    passwordSalt: derived.salt,
    passwordParams: derived.params,
    at: NOW,
  });
};

const row = (): { failed_attempts: number; locked_until: string | null; status: string } =>
  db
    .prepare(`SELECT failed_attempts, locked_until, status FROM admin_users WHERE id = 'adm_owner'`)
    .get() as { failed_attempts: number; locked_until: string | null; status: string };

describe('the escalating hold', () => {
  const wrong = async (): Promise<void> => {
    await adminLogin(ports(), { email: 'info@telga.example', password: 'WrongPassword9' });
  };

  it('holds after four wrong attempts', async () => {
    for (let i = 0; i < 4; i += 1) await wrong();
    expect(row().failed_attempts).toBe(4);
    expect(row().locked_until).not.toBeNull();

    // Even the *right* password is refused while the hold stands.
    const correct = await adminLogin(ports(), { email: 'info@telga.example', password: OLD });
    expect(correct.kind).toBe('REFUSED');
    expect(correct.kind === 'REFUSED' && correct.reason).toBe('ACCOUNT_LOCKED');
  });

  it('reaches the twenty-four hour hold on the sixth failure', async () => {
    for (let i = 0; i < 4; i += 1) await wrong();
    // Eleven minutes on: the ten-minute hold has expired, two chances remain.
    const later = '2026-09-12T10:11:00.000Z';
    await adminLogin(ports(later), { email: 'info@telga.example', password: 'WrongPassword9' });
    await adminLogin(ports(later), { email: 'info@telga.example', password: 'WrongPassword9' });

    expect(row().failed_attempts).toBe(6);
    const heldUntil = Date.parse(row().locked_until as string);
    // A day, not ten minutes.
    expect(heldUntil - Date.parse(later)).toBe(24 * 60 * 60 * 1000);
  });

  it('is why a reset matters more than it used to', async () => {
    for (let i = 0; i < 4; i += 1) await wrong();
    const later = '2026-09-12T10:11:00.000Z';
    await adminLogin(ports(later), { email: 'info@telga.example', password: 'WrongPassword9' });
    await adminLogin(ports(later), { email: 'info@telga.example', password: 'WrongPassword9' });

    // Without the reset this administrator waits a day. With it, no wait.
    await reset('info@telga.example', NEW);
    const result = await adminLogin(ports(later), { email: 'info@telga.example', password: NEW });
    expect(result.kind).toBe('AUTHENTICATED');
  });
});

describe('the reset', () => {
  it('lets the new password in', async () => {
    expect(await reset('info@telga.example', NEW)).toBe(1);

    const result = await adminLogin(ports(), { email: 'info@telga.example', password: NEW });
    expect(result.kind).toBe('AUTHENTICATED');
  });

  it('refuses the old password afterwards', async () => {
    await reset('info@telga.example', NEW);
    const result = await adminLogin(ports(), { email: 'info@telga.example', password: OLD });
    expect(result.kind).toBe('REFUSED');
  });

  it('clears the lock and the counter, so the new password works immediately', async () => {
    for (let i = 0; i < 4; i += 1) {
      await adminLogin(ports(), { email: 'info@telga.example', password: 'WrongPassword9' });
    }
    expect(row().locked_until).not.toBeNull();

    await reset('info@telga.example', NEW);
    expect(row().failed_attempts).toBe(0);
    expect(row().locked_until).toBeNull();

    // No ten-minute wait. The whole point of the reset.
    const result = await adminLogin(ports(), { email: 'info@telga.example', password: NEW });
    expect(result.kind).toBe('AUTHENTICATED');
  });

  it('reactivates a suspended account, because suspension looks identical to a wrong password', async () => {
    db.prepare(`UPDATE admin_users SET status = 'SUSPENDED' WHERE id = 'adm_owner'`).run();
    await reset('info@telga.example', NEW);
    expect(row().status).toBe('ACTIVE');

    const result = await adminLogin(ports(), { email: 'info@telga.example', password: NEW });
    expect(result.kind).toBe('AUTHENTICATED');
  });

  it('matches the email however it was capitalised', async () => {
    // Emails are lowercased at write time; a value typed into a deployment
    // variable will not always be.
    expect(await reset('INFO@Telga.Example', NEW)).toBe(1);
    const result = await adminLogin(ports(), { email: 'info@telga.example', password: NEW });
    expect(result.kind).toBe('AUTHENTICATED');
  });
});

describe('what it must not do', () => {
  it('creates nothing for an email that holds no account', async () => {
    expect(await reset('stranger@telga.example', NEW)).toBe(0);
    expect(db.prepare(`SELECT count(*) AS n FROM admin_users`).get()).toEqual({ n: 1 });
  });

  it('leaves every other administrator alone', async () => {
    const other = await hashAdminSecret(OLD);
    saveAdminUser(db as never, {
      id: 'adm_two',
      email: 'second@telga.example',
      displayName: 'Second',
      department: 'FINANCE',
      role: 'FINANCE_VERIFIER',
      passwordHash: other.hash,
      passwordSalt: other.salt,
      passwordParams: other.params,
      status: 'ACTIVE',
      at: NOW,
    });

    await reset('info@telga.example', NEW);

    // The second administrator's password is untouched.
    const stillOld = await adminLogin(ports(), { email: 'second@telga.example', password: OLD });
    expect(stillOld.kind).toBe('AUTHENTICATED');
  });
});
