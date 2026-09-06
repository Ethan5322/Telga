/**
 * Telga staff records: admins, their grants, and their sessions.
 *
 * Separate from `identity.ts`, which reads merchant users. The two must not
 * share a code path — a query that could return either kind of user is a query
 * that could authorise the wrong one.
 *
 * ## Email is matched lowercased
 *
 * SQLite's `UNIQUE` is case-sensitive, so `Owner@telga.example` and
 * `owner@telga.example` would be two accounts for one person. Normalising on
 * the way in **and** on the way out is what makes the constraint mean what it
 * looks like it means.
 */

import type { Db } from '../sqlite/connection';
import type { AdminPermissionRow, AdminSessionRow, AdminUserRow } from '../schema/types';

/** Lowercased and trimmed. The only form an email is ever stored or matched in. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export interface AdminUserInput {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly department: string;
  readonly role: string;
  readonly passwordHash: string;
  readonly passwordSalt: string;
  readonly passwordParams: string;
  readonly status: string;
  readonly createdBy?: string | null;
  readonly approvedBy?: string | null;
  readonly at: string;
}

export function saveAdminUser(db: Db, input: AdminUserInput): void {
  db.prepare(
    `INSERT INTO admin_users
       (id, email, display_name, department, role, password_hash, password_salt,
        password_params, status, created_by, approved_by, created_at, updated_at)
     VALUES (@id, @email, @displayName, @department, @role, @passwordHash, @passwordSalt,
             @passwordParams, @status, @createdBy, @approvedBy, @at, @at)`,
  ).run({
    ...input,
    email: normalizeEmail(input.email),
    createdBy: input.createdBy ?? null,
    approvedBy: input.approvedBy ?? null,
  });
}

export const findAdminUser = (db: Db, id: string): AdminUserRow | undefined =>
  db.prepare(`SELECT * FROM admin_users WHERE id = ?`).get(id) as AdminUserRow | undefined;

export const findAdminUserByEmail = (db: Db, email: string): AdminUserRow | undefined =>
  db.prepare(`SELECT * FROM admin_users WHERE email = ?`).get(normalizeEmail(email)) as
    | AdminUserRow
    | undefined;

export const listAdminUsers = (db: Db): readonly AdminUserRow[] =>
  db.prepare(`SELECT * FROM admin_users ORDER BY created_at DESC`).all() as readonly AdminUserRow[];

/**
 * Record a failed sign-in, and lock the account once the threshold is passed.
 *
 * Counting failures on the **account** rather than only on the request is what
 * makes an offline guessing run expensive: an attacker who rotates IP
 * addresses still trips the same counter.
 */
export function recordAdminLoginFailure(
  db: Db,
  id: string,
  at: string,
  lockAfter: number,
  lockUntil: string,
): void {
  db.prepare(
    `UPDATE admin_users
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE WHEN failed_attempts + 1 >= @lockAfter THEN @lockUntil ELSE locked_until END,
            updated_at = @at
      WHERE id = @id`,
  ).run({ id, at, lockAfter, lockUntil });
}

/** A successful sign-in clears the counter and the lock in one statement. */
export function recordAdminLoginSuccess(db: Db, id: string, at: string): void {
  db.prepare(
    `UPDATE admin_users
        SET failed_attempts = 0, locked_until = NULL,
            last_login_at = @at, last_activity_at = @at, updated_at = @at
      WHERE id = @id`,
  ).run({ id, at });
}

export function setAdminStatus(db: Db, id: string, status: string, at: string): void {
  db.prepare(`UPDATE admin_users SET status = @status, updated_at = @at WHERE id = @id`).run({
    id,
    status,
    at,
  });
}

export function setAdminMfaSecret(db: Db, id: string, secretHash: string, at: string): void {
  db.prepare(
    `UPDATE admin_users
        SET mfa_secret_hash = @secretHash, mfa_enrolled_at = @at, updated_at = @at
      WHERE id = @id`,
  ).run({ id, secretHash, at });
}

// --- grants ----------------------------------------------------------------

export const listAdminGrants = (db: Db, adminUserId: string): readonly AdminPermissionRow[] =>
  db.prepare(`SELECT * FROM admin_permissions WHERE admin_user_id = ?`).all(adminUserId) as
    readonly AdminPermissionRow[];

/**
 * Grant one permission.
 *
 * `INSERT OR IGNORE`: granting twice is not an error, it is the same state.
 * The `granted_by` of the first grant is kept, because that is who actually
 * made the decision.
 */
export function grantAdminPermission(
  db: Db,
  input: { adminUserId: string; permission: string; grantedBy: string; at: string },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO admin_permissions (admin_user_id, permission, granted_by, granted_at)
     VALUES (@adminUserId, @permission, @grantedBy, @at)`,
  ).run(input);
}

/** Revoke one permission. Absence is denial, so removing the row is the whole act. */
export function revokeAdminPermission(db: Db, adminUserId: string, permission: string): void {
  db.prepare(
    `DELETE FROM admin_permissions WHERE admin_user_id = ? AND permission = ?`,
  ).run(adminUserId, permission);
}

// --- sessions --------------------------------------------------------------

export interface AdminSessionInput {
  readonly id: string;
  readonly adminUserId: string;
  readonly role: string;
  readonly csrfHash: string;
  readonly at: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
}

export function saveAdminSession(db: Db, input: AdminSessionInput): void {
  db.prepare(
    `INSERT INTO admin_sessions
       (id, admin_user_id, role, csrf_hash, mfa_satisfied, status,
        created_at, last_seen_at, idle_expires_at, absolute_expires_at)
     VALUES (@id, @adminUserId, @role, @csrfHash, 0, 'ACTIVE',
             @at, @at, @idleExpiresAt, @absoluteExpiresAt)`,
  ).run(input);
}

export const findAdminSession = (db: Db, id: string): AdminSessionRow | undefined =>
  db.prepare(`SELECT * FROM admin_sessions WHERE id = ?`).get(id) as AdminSessionRow | undefined;

/** Mark the second factor cleared. Never reversed: a session is re-issued instead. */
export function markAdminMfaSatisfied(db: Db, id: string, at: string): void {
  db.prepare(
    `UPDATE admin_sessions SET mfa_satisfied = 1, last_seen_at = @at WHERE id = @id`,
  ).run({ id, at });
}

/** Record a fresh identity proof. High-risk actions compare against this. */
export function markAdminSteppedUp(db: Db, id: string, at: string): void {
  db.prepare(
    `UPDATE admin_sessions SET stepped_up_at = @at, last_seen_at = @at WHERE id = @id`,
  ).run({ id, at });
}

export function touchAdminSession(db: Db, id: string, at: string, idleExpiresAt: string): void {
  db.prepare(
    `UPDATE admin_sessions SET last_seen_at = @at, idle_expires_at = @idleExpiresAt WHERE id = @id`,
  ).run({ id, at, idleExpiresAt });
}

export function revokeAdminSession(db: Db, id: string, at: string, reason: string): void {
  db.prepare(
    `UPDATE admin_sessions
        SET status = 'REVOKED', revoked_at = @at, revocation_reason = @reason
      WHERE id = @id AND status = 'ACTIVE'`,
  ).run({ id, at, reason });
}

/**
 * Revoke every session an admin holds.
 *
 * What suspension and a password change both need: changing the credential
 * must not leave a session issued under the old one still working.
 */
export function revokeAllAdminSessions(db: Db, adminUserId: string, at: string, reason: string): number {
  const result = db
    .prepare(
      `UPDATE admin_sessions
          SET status = 'REVOKED', revoked_at = @at, revocation_reason = @reason
        WHERE admin_user_id = @adminUserId AND status = 'ACTIVE'`,
    )
    .run({ adminUserId, at, reason });
  return result.changes;
}

export const listActiveAdminSessions = (db: Db, adminUserId: string): readonly AdminSessionRow[] =>
  db
    .prepare(`SELECT * FROM admin_sessions WHERE admin_user_id = ? AND status = 'ACTIVE'`)
    .all(adminUserId) as readonly AdminSessionRow[];

/**
 * Clear an administrator's second factor so they can enrol a new one.
 *
 * The recovery path for a lost or replaced phone. Without this an admin whose
 * device is gone is locked out permanently, and the pressure that creates —
 * sharing a working account, or a database edit by hand — is worse than the
 * reset itself.
 *
 * It only clears. It does not issue a replacement secret, so whoever performs
 * the reset never learns the new one: the admin enrols it themselves on next
 * sign-in. Revoking their live sessions is the caller's job and is not
 * optional — a session that already satisfied MFA would otherwise keep running
 * on a factor that no longer exists.
 */
export function clearAdminMfaSecret(db: Db, id: string, at: string): void {
  db.prepare(
    `UPDATE admin_users
        SET mfa_secret_hash = NULL, mfa_enrolled_at = NULL, updated_at = @at
      WHERE id = @id`,
  ).run({ id, at });
}
