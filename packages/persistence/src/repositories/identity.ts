/**
 * Operators, sessions, device enrolment and attempt records.
 *
 * Every read that can be scoped to a merchant takes a `MerchantId` and filters
 * **in SQL** — the same rule the rest of the driver follows. Merchant isolation
 * is a property of the query, not of the caller remembering to check.
 *
 * Nothing in this file takes a raw PIN, a session token or a device secret. It
 * takes hashes. Hashing lives in `services/api/src/auth/secrets.ts`, where the
 * work factor belongs; persistence only stores what it is given, and the schema
 * offers no column that could hold the raw value.
 */

import type {
  ActorRole,
  DeviceEnrollmentState,
  DeviceId,
  MerchantId,
  MerchantUserId,
  SessionStatus,
  Timestamp,
} from '@telga/domain';
import type { Db } from '../sqlite/connection';
import type {
  AttemptScope,
  AuthAttemptRow,
  DeviceEnrollmentRow,
  MerchantUserRow,
  SessionRow,
} from '../schema/types';

// --- operators --------------------------------------------------------------

export interface MerchantUserInput {
  readonly id: MerchantUserId;
  readonly merchantId: MerchantId;
  readonly displayName: string;
  readonly role: ActorRole;
  readonly pinHash: string;
  readonly pinSalt: string;
  readonly pinParams: string;
  readonly status: MerchantUserRow['status'];
  readonly at: Timestamp;
}

export function saveMerchantUser(db: Db, input: MerchantUserInput): MerchantUserRow {
  db.prepare(
    `INSERT INTO merchant_users (
       id, merchant_id, display_name, role, pin_hash, pin_salt, pin_params,
       status, failed_attempts, locked_until, last_login_at, mode, created_at, updated_at)
     VALUES (@id, @merchantId, @displayName, @role, @pinHash, @pinSalt, @pinParams,
       @status, 0, NULL, NULL, 'TRAINING', @at, @at)
     ON CONFLICT(id) DO UPDATE SET
       display_name = excluded.display_name,
       role         = excluded.role,
       pin_hash     = excluded.pin_hash,
       pin_salt     = excluded.pin_salt,
       pin_params   = excluded.pin_params,
       status       = excluded.status,
       updated_at   = excluded.updated_at`,
  ).run(input);
  return findMerchantUser(db, input.id) as MerchantUserRow;
}

export function findMerchantUser(
  db: Db,
  id: MerchantUserId,
  merchantId?: MerchantId,
): MerchantUserRow | undefined {
  const sql =
    merchantId === undefined
      ? 'SELECT * FROM merchant_users WHERE id = ?'
      : 'SELECT * FROM merchant_users WHERE id = ? AND merchant_id = ?';
  const args = merchantId === undefined ? [id] : [id, merchantId];
  return db.prepare(sql).get(...args) as MerchantUserRow | undefined;
}

export function findMerchantUsers(db: Db, merchantId: MerchantId): readonly MerchantUserRow[] {
  return db
    .prepare('SELECT * FROM merchant_users WHERE merchant_id = ? ORDER BY id')
    .all(merchantId) as MerchantUserRow[];
}

/** Record a failed sign-in, and lock the account when the threshold is reached. */
export function recordFailedLogin(
  db: Db,
  id: MerchantUserId,
  at: Timestamp,
  maxFailedAttempts: number,
  lockedUntil: Timestamp,
): MerchantUserRow | undefined {
  db.prepare(
    `UPDATE merchant_users
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE WHEN failed_attempts + 1 >= @maxFailedAttempts
                                THEN @lockedUntil ELSE locked_until END,
            updated_at = @at
      WHERE id = @id`,
  ).run({ id, at, maxFailedAttempts, lockedUntil });
  return findMerchantUser(db, id);
}

/** Clear the failure counter and the lock. Called only after a correct PIN. */
export function recordSuccessfulLogin(db: Db, id: MerchantUserId, at: Timestamp): void {
  db.prepare(
    `UPDATE merchant_users
        SET failed_attempts = 0, locked_until = NULL, last_login_at = @at, updated_at = @at
      WHERE id = @id`,
  ).run({ id, at });
}

// --- device enrolment -------------------------------------------------------

export interface DeviceEnrollmentInput {
  readonly deviceId: DeviceId;
  readonly merchantId: MerchantId;
  readonly state: DeviceEnrollmentState;
  readonly displayName?: string;
  readonly secretHash: string;
  readonly secretSalt: string;
  readonly expiresAt?: Timestamp;
  readonly at: Timestamp;
}

export function saveDeviceEnrollment(db: Db, input: DeviceEnrollmentInput): DeviceEnrollmentRow {
  db.prepare(
    `INSERT INTO device_enrollments (
       device_id, merchant_id, enrollment_state, display_name, secret_hash, secret_salt,
       enrolled_at, last_seen_at, expires_at, revoked_at, revocation_reason, created_at, updated_at)
     VALUES (@deviceId, @merchantId, @state, @displayName, @secretHash, @secretSalt,
       @at, NULL, @expiresAt, NULL, NULL, @at, @at)
     ON CONFLICT(device_id) DO UPDATE SET
       merchant_id       = excluded.merchant_id,
       enrollment_state  = excluded.enrollment_state,
       display_name      = excluded.display_name,
       secret_hash       = excluded.secret_hash,
       secret_salt       = excluded.secret_salt,
       enrolled_at       = excluded.enrolled_at,
       expires_at        = excluded.expires_at,
       revoked_at        = NULL,
       revocation_reason = NULL,
       updated_at        = excluded.updated_at`,
  ).run({
    deviceId: input.deviceId,
    merchantId: input.merchantId,
    state: input.state,
    displayName: input.displayName ?? null,
    secretHash: input.secretHash,
    secretSalt: input.secretSalt,
    expiresAt: input.expiresAt ?? null,
    at: input.at,
  });
  return findDeviceEnrollment(db, input.deviceId) as DeviceEnrollmentRow;
}

export function findDeviceEnrollment(
  db: Db,
  deviceId: DeviceId,
): DeviceEnrollmentRow | undefined {
  return db.prepare('SELECT * FROM device_enrollments WHERE device_id = ?').get(deviceId) as
    | DeviceEnrollmentRow
    | undefined;
}

export function findDeviceEnrollments(
  db: Db,
  merchantId: MerchantId,
): readonly DeviceEnrollmentRow[] {
  return db
    .prepare('SELECT * FROM device_enrollments WHERE merchant_id = ? ORDER BY device_id')
    .all(merchantId) as DeviceEnrollmentRow[];
}

/**
 * Revoke a device.
 *
 * Returns the number of sessions revoked with it. A revoked device that left
 * live sessions behind would be a device that is still usable, which is the
 * opposite of revoked.
 */
export function revokeDevice(
  db: Db,
  deviceId: DeviceId,
  reason: string,
  at: Timestamp,
): { revoked: boolean; sessionsRevoked: number } {
  const result = db
    .prepare(
      `UPDATE device_enrollments
          SET enrollment_state = 'REVOKED', revoked_at = @at, revocation_reason = @reason,
              updated_at = @at
        WHERE device_id = @deviceId AND enrollment_state != 'REVOKED'`,
    )
    .run({ deviceId, reason, at });
  const sessions = revokeSessionsForDevice(db, deviceId, reason, at);
  return { revoked: result.changes === 1, sessionsRevoked: sessions };
}

export function touchDevice(db: Db, deviceId: DeviceId, at: Timestamp): void {
  db.prepare('UPDATE device_enrollments SET last_seen_at = ?, updated_at = ? WHERE device_id = ?')
    .run(at, at, deviceId);
}

// --- sessions ---------------------------------------------------------------

export interface SessionInput {
  /** SHA-256 of the token. The token never reaches this layer. */
  readonly id: string;
  readonly userId: MerchantUserId;
  readonly merchantId: MerchantId;
  readonly deviceId: DeviceId;
  readonly role: ActorRole;
  readonly csrfHash: string;
  readonly createdAt: Timestamp;
  readonly idleExpiresAt: Timestamp;
  readonly absoluteExpiresAt: Timestamp;
}

export function createSession(db: Db, input: SessionInput): SessionRow {
  db.prepare(
    `INSERT INTO sessions (
       id, user_id, merchant_id, device_id, role, csrf_hash, status,
       created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at, revocation_reason)
     VALUES (@id, @userId, @merchantId, @deviceId, @role, @csrfHash, 'ACTIVE',
       @createdAt, @createdAt, @idleExpiresAt, @absoluteExpiresAt, NULL, NULL)`,
  ).run(input);
  return findSession(db, input.id) as SessionRow;
}

export function findSession(db: Db, id: string): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
}

/** Slide the idle window forward. The absolute expiry is never extended. */
export function touchSession(db: Db, id: string, at: Timestamp, idleExpiresAt: Timestamp): void {
  db.prepare('UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ? AND status = ?')
    .run(at, idleExpiresAt, id, 'ACTIVE');
}

export function revokeSession(
  db: Db,
  id: string,
  reason: string,
  at: Timestamp,
): boolean {
  const result = db
    .prepare(
      `UPDATE sessions SET status = 'REVOKED', revoked_at = @at, revocation_reason = @reason
        WHERE id = @id AND status = 'ACTIVE'`,
    )
    .run({ id, reason, at });
  return result.changes === 1;
}

/**
 * Record the reason a session was refused, regardless of its current status.
 *
 * `revokeSession` is guarded on `ACTIVE`, which is right for revoking — but a
 * session already revoked still needs its reason updated the first time a
 * *device* refusal is detected, so the refusal can be audited exactly once
 * rather than on every retry. Returns true when the reason actually changed.
 */
export function noteSessionRejection(
  db: Db,
  id: string,
  reason: string,
  at: Timestamp,
): boolean {
  const result = db
    .prepare(
      `UPDATE sessions
          SET status = 'REVOKED',
              revoked_at = COALESCE(revoked_at, @at),
              revocation_reason = @reason
        WHERE id = @id AND (revocation_reason IS NULL OR revocation_reason != @reason)`,
    )
    .run({ id, reason, at });
  return result.changes === 1;
}

export function revokeSessionsForDevice(
  db: Db,
  deviceId: DeviceId,
  reason: string,
  at: Timestamp,
): number {
  return db
    .prepare(
      `UPDATE sessions SET status = 'REVOKED', revoked_at = @at, revocation_reason = @reason
        WHERE device_id = @deviceId AND status = 'ACTIVE'`,
    )
    .run({ deviceId, reason, at }).changes;
}

export function revokeSessionsForUser(
  db: Db,
  userId: MerchantUserId,
  reason: string,
  at: Timestamp,
): number {
  return db
    .prepare(
      `UPDATE sessions SET status = 'REVOKED', revoked_at = @at, revocation_reason = @reason
        WHERE user_id = @userId AND status = 'ACTIVE'`,
    )
    .run({ userId, reason, at }).changes;
}

export function countActiveSessions(db: Db, status: SessionStatus = 'ACTIVE'): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE status = ?').get(status) as {
    n: number;
  };
  return row.n;
}

// --- attempts ---------------------------------------------------------------

export function recordAttempt(
  db: Db,
  scope: AttemptScope,
  subject: string,
  outcome: AuthAttemptRow['outcome'],
  at: Timestamp,
): void {
  db.prepare(
    'INSERT INTO auth_attempts (scope, subject, outcome, created_at) VALUES (?, ?, ?, ?)',
  ).run(scope, subject, outcome, at);
}

/** How many attempts a subject has made since `since`. Backs the rate limits. */
export function countAttemptsSince(
  db: Db,
  scope: AttemptScope,
  subject: string,
  since: Timestamp,
): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM auth_attempts WHERE scope = ? AND subject = ? AND created_at > ?',
    )
    .get(scope, subject, since) as { n: number };
  return row.n;
}

/** Discard attempt records older than `before`. Housekeeping, not history. */
export function pruneAttempts(db: Db, before: Timestamp): number {
  return db.prepare('DELETE FROM auth_attempts WHERE created_at < ?').run(before).changes;
}
