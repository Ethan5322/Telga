import type { Migration } from './index';

/**
 * Operators, sessions, device enrolment and attempt records.
 *
 * ## What is deliberately absent from every column
 *
 * There is no column that can hold a raw PIN, a session token, or a device
 * secret. Only derived values are storable:
 *
 *   `merchant_users.pin_hash`      a scrypt derived key, with its own salt
 *   `device_enrollments.secret_hash` the same, for the device secret
 *   `sessions.id`                  a SHA-256 of the session token
 *   `sessions.csrf_hash`           a SHA-256 of the CSRF token
 *
 * The session **token** is never stored anywhere. A stolen database therefore
 * yields no usable session and no usable PIN, only work factors to grind.
 *
 * ## Why sessions carry both expiries
 *
 * `idle_expires_at` moves forward on every request; `absolute_expires_at` is
 * fixed at login. A counter operator who walks away is ended by the first; a
 * session left open all week is ended by the second regardless of activity.
 * Both are checked on every request, not only at login.
 *
 * ## Why `device_enrollments` is a separate table
 *
 * `devices` already exists and is referenced by every transaction. Enrolment is
 * an *authentication* fact with its own lifecycle — revocation, expiry, a
 * secret — and mixing it into a table the ledger depends on would tie a
 * security change to a table that must stay stable. One row per device, keyed
 * by the device id.
 *
 * TRAINING MODE — NO REAL VALUE. `merchant_users.mode` is constrained to
 * `'TRAINING'`, so an operator record for a live-money deployment cannot be
 * stored here at all.
 */
export const m006AuthAndDevices: Migration = {
  version: '006',
  name: 'auth_and_devices',
  sql: `
CREATE TABLE merchant_users (
  id              TEXT PRIMARY KEY,
  merchant_id     TEXT NOT NULL REFERENCES merchants(id),
  display_name    TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN (
                    'MERCHANT_OPERATOR','MERCHANT_OWNER','OPS_VERIFIER','OPS_APPROVER',
                    'OPS_RECONCILER','OPS_SUPPORT','ADMIN')),
  -- Derived only. There is no column a raw PIN could be written to.
  pin_hash        TEXT NOT NULL,
  pin_salt        TEXT NOT NULL,
  pin_params      TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED')),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until    TEXT,
  last_login_at   TEXT,
  mode            TEXT NOT NULL CHECK (mode = 'TRAINING'),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;

CREATE INDEX idx_merchant_users_merchant ON merchant_users(merchant_id);

CREATE TABLE device_enrollments (
  device_id         TEXT PRIMARY KEY REFERENCES devices(id),
  merchant_id       TEXT NOT NULL REFERENCES merchants(id),
  enrollment_state  TEXT NOT NULL CHECK (enrollment_state IN ('PENDING','ENROLLED','REVOKED','EXPIRED')),
  display_name      TEXT,
  secret_hash       TEXT NOT NULL,
  secret_salt       TEXT NOT NULL,
  enrolled_at       TEXT NOT NULL,
  last_seen_at      TEXT,
  expires_at        TEXT,
  revoked_at        TEXT,
  revocation_reason TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
) STRICT;

CREATE INDEX idx_device_enrollments_merchant ON device_enrollments(merchant_id, enrollment_state);

CREATE TABLE sessions (
  -- SHA-256 of the session token. The token itself is never stored.
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES merchant_users(id),
  merchant_id         TEXT NOT NULL REFERENCES merchants(id),
  device_id           TEXT NOT NULL REFERENCES devices(id),
  role                TEXT NOT NULL,
  csrf_hash           TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  created_at          TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  idle_expires_at     TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at          TEXT,
  revocation_reason   TEXT
) STRICT;

CREATE INDEX idx_sessions_user ON sessions(user_id, status);
CREATE INDEX idx_sessions_device ON sessions(device_id, status);

-- Attempt records back the rate limits and the lockout. Rows are keyed by a
-- subject that is already an internal identifier — a user id or a device id —
-- so nothing here identifies a person beyond what the other tables already do.
CREATE TABLE auth_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope      TEXT NOT NULL CHECK (scope IN ('LOGIN','SALE')),
  subject    TEXT NOT NULL,
  outcome    TEXT NOT NULL CHECK (outcome IN ('SUCCESS','FAILURE')),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_auth_attempts_subject ON auth_attempts(scope, subject, created_at);
`,
};
