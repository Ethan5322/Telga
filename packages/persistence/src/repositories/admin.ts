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
 * Record a failed sign-in, and start a hold if this failure earns one.
 *
 * **Which tier applies is decided by the caller** (`lockUntilAfterFailure`),
 * not here. The escalation is a policy question — four failures then ten
 * minutes, two more chances, then twenty-four hours — and policy belongs beside
 * the rest of the auth rules rather than inside a SQL `CASE` that nothing can
 * unit-test.
 *
 * Counting failures on the **account** rather than only on the request is what
 * makes an offline guessing run expensive: an attacker who rotates IP
 * addresses still trips the same counter.
 */
export function recordAdminLoginFailure(
  db: Db,
  id: string,
  at: string,
  lockUntil: string | null,
): void {
  db.prepare(
    `UPDATE admin_users
        SET failed_attempts = failed_attempts + 1,
            -- COALESCE, not a plain assignment: a null lockUntil means "this
            -- failure does not start a hold", never "clear the hold that
            -- stands". Only a successful sign-in or an operator reset clears
            -- one.
            locked_until = COALESCE(@lockUntil, locked_until),
            updated_at = @at
      WHERE id = @id`,
  ).run({ id, at, lockUntil });
}

/**
 * Set an existing administrator's password, and let them back in.
 *
 * ## Why this exists
 *
 * Until 2026-09-12 there was **no way to change an admin password in this
 * product at all** — no console route, no CLI flag, nothing. `saveAdminUser`
 * only inserts, and the Railway boot step that creates the first owner is a
 * no-op ever after because the email is unique. A Railway container has no
 * shell, so an administrator who did not know their password had no path back
 * in and no way to be given one.
 *
 * ## Why it clears the lock and the status too
 *
 * Because the state that keeps somebody out is not only the password. Five
 * wrong attempts set `locked_until`, and `failed_attempts` is **never reset
 * except by a successful sign-in** — so after the first lockout a single wrong
 * guess re-locks for another fifteen minutes, indefinitely. A reset that fixed
 * the password and left the counter at five would appear not to have worked.
 *
 * `SUSPENDED` is cleared for the same reason: `adminLogin` refuses a suspended
 * account *identically* to a wrong password, so leaving it would look like the
 * new password had not taken.
 *
 * Returns rows changed: `0` means no account holds that email, which the caller
 * must report rather than treat as success.
 */
export function setAdminPassword(
  db: Db,
  input: {
    readonly email: string;
    readonly passwordHash: string;
    readonly passwordSalt: string;
    readonly passwordParams: string;
    readonly at: string;
  },
): number {
  return db
    .prepare(
      `UPDATE admin_users
          SET password_hash = @passwordHash,
              password_salt = @passwordSalt,
              password_params = @passwordParams,
              failed_attempts = 0,
              locked_until = NULL,
              status = 'ACTIVE',
              updated_at = @at
        WHERE email = @email`,
    )
    .run({ ...input, email: normalizeEmail(input.email) }).changes;
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

/**
 * The emailed sign-in code — §23.1.
 *
 * Migration 017 added these columns and **nothing ever read or wrote them**.
 * The code, its expiry, its attempt count and the moment it was sent all lived
 * in a schema nobody used, which is what a second factor looks like when the
 * delivery half was never built.
 *
 * The code itself is never stored. `otp_hash` and `otp_salt` are a derivation
 * of it, exactly as a password is — a database that could reveal a live sign-in
 * code is a database that is itself a second factor.
 */
export function saveAdminOtp(
  db: Db,
  input: {
    readonly adminId: string;
    readonly hash: string;
    readonly salt: string;
    readonly expiresAt: string;
    readonly sentAt: string;
  },
): void {
  db.prepare(
    `UPDATE admin_users
        SET otp_hash = ?, otp_salt = ?, otp_expires_at = ?, otp_sent_at = ?, otp_attempts = 0
      WHERE id = ?`,
  ).run(input.hash, input.salt, input.expiresAt, input.sentAt, input.adminId);
}

/** What is outstanding for this administrator, if anything. */
export const findAdminOtp = (
  db: Db,
  adminId: string,
): { hash: string; salt: string; expires_at: string; attempts: number; sent_at: string | null } | undefined =>
  db
    .prepare(
      `SELECT otp_hash AS hash, otp_salt AS salt, otp_expires_at AS expires_at,
              otp_attempts AS attempts, otp_sent_at AS sent_at
         FROM admin_users WHERE id = ? AND otp_hash IS NOT NULL`,
    )
    .get(adminId) as
    | { hash: string; salt: string; expires_at: string; attempts: number; sent_at: string | null }
    | undefined;

/**
 * A wrong guess.
 *
 * Counted against the **code**, never the account. Locking the account would
 * hand anybody who knows an administrator's email a denial-of-service button;
 * killing the code costs the real administrator one more email and costs an
 * attacker their whole budget.
 */
export const countAdminOtpAttempt = (db: Db, adminId: string): void => {
  db.prepare('UPDATE admin_users SET otp_attempts = otp_attempts + 1 WHERE id = ?').run(adminId);
};

/**
 * Used, expired, or abandoned — the code is gone either way.
 *
 * Cleared on success as well as on failure: a code that stayed in the row after
 * it had been accepted would be a second, silent way in.
 */
export const clearAdminOtp = (db: Db, adminId: string): void => {
  db.prepare(
    `UPDATE admin_users
        SET otp_hash = NULL, otp_salt = NULL, otp_expires_at = NULL,
            otp_sent_at = NULL, otp_attempts = 0
      WHERE id = ?`,
  ).run(adminId);
};
