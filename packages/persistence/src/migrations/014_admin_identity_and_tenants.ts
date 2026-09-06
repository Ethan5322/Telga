import type { Migration } from './index';

/**
 * Admin identity, the tenant registry, and the merchant application lifecycle.
 *
 * The foundation for the Telga Operations Console — see
 * `09 Engineering/Admin Operations Console`. Nothing reads or writes these
 * tables yet; this creates the shape so the code that follows has somewhere to
 * put things.
 *
 * ## 1. `admin_users` — why a new table and not a new role
 *
 * `merchant_users.merchant_id` is `NOT NULL`, so **every user in this system
 * belongs to a shop**, including the ones whose role says `ADMIN`. A Telga
 * employee cannot exist. `sessions.device_id` is `NOT NULL` too, so an admin
 * would additionally need an enrolled POS terminal to hold a session.
 *
 * The alternative was making `merchant_users.merchant_id` nullable. That was
 * rejected: the `NOT NULL` is what makes cross-shop leakage *structurally*
 * impossible rather than merely checked, and trading it away to save a table
 * is a bad exchange. Merchant identity is untouched by this migration.
 *
 * Authentication here is **email, password and MFA** — never a PIN. CLAUDE.md
 * §24 and the owner brief both refuse a merchant PIN as an administrative
 * credential, and the columns reflect that: there is nowhere to put one.
 *
 * As with `merchant_users`, only derived values are stored. There is no column
 * a plaintext password could be written to.
 *
 * ## 2. `admin_permissions` — individually switchable
 *
 * A sub-admin's rights are toggled one at a time, so they cannot live in the
 * role alone. A row here is a **grant**: absent means not granted. Storing
 * denials as well would create the question of which wins, and the answer is
 * always "least privilege", which an absence already expresses.
 *
 * ## 3. `tenant_registry` — the one shared table
 *
 * Each shop gets its own database (owner decision, 2026-08-30). That model
 * needs exactly one thing to stay coherent: a registry saying which database
 * belongs to which merchant, what schema version it is on, and when it was
 * last backed up. Without it, per-shop databases are untracked files.
 *
 * `schema_version` is per tenant on purpose. With N databases, a half-migrated
 * tenant is a real state and has to be *detectable* rather than assumed away.
 *
 * ## 4. `merchant_applications` — registration before there is a merchant
 *
 * A public applicant has no account, no credentials, no device and no
 * database until an admin approves. So the form cannot write to `merchants` —
 * there is nothing to write yet. An application is its own record, and
 * approving one is what creates a merchant.
 *
 * The lifecycle is the eleven states in the owner brief. `merchants.status`
 * keeps its four; the application carries the review states, which is what
 * lets an application be rejected without ever having created a shop.
 *
 * ## What this migration does not do
 *
 * It does not create the per-shop databases, move any data, or change
 * `merchants`, `merchant_users`, `sessions` or `devices` in any way. Every
 * table here is new and empty, and nothing reads them yet.
 *
 * ## Rollback
 *
 * Forward-fix only, like every migration here. Because all five tables are
 * additive and nothing references them, the practical undo is `DROP TABLE` on
 * each in a later migration — no existing row moves, so no history is at risk.
 * The migrator wraps this in one transaction: a failure leaves the database
 * untouched and unrecorded.
 */
export const m014AdminIdentityAndTenants: Migration = {
  version: '014',
  name: 'admin_identity_and_tenants',
  sql: `
    -- Telga staff. Deliberately NOT merchant_users: an admin belongs to no
    -- shop, and an admin session needs no device.
    CREATE TABLE admin_users (
      id                TEXT PRIMARY KEY,
      -- Lowercased at write time by the application so that uniqueness is
      -- real. SQLite's UNIQUE is case-sensitive, and two admins differing
      -- only in capitalisation would be two accounts for one person.
      email             TEXT NOT NULL UNIQUE,
      display_name      TEXT NOT NULL,
      department        TEXT NOT NULL CHECK (department IN (
                          'PLATFORM', 'TECHNICAL', 'SALES', 'SUPPORT', 'FINANCE', 'SECURITY'
                        )),
      role              TEXT NOT NULL CHECK (role IN (
                          'PLATFORM_OWNER', 'OPERATIONS_ADMIN', 'FINANCE_VERIFIER',
                          'SUPPORT_AGENT', 'AUDITOR', 'SECURITY_ADMIN', 'DEPARTMENT_ADMIN'
                        )),
      -- Derived only. There is no column a plaintext password could go in.
      password_hash     TEXT NOT NULL,
      password_salt     TEXT NOT NULL,
      password_params   TEXT NOT NULL,
      -- Second factor. Null until enrolled; the application refuses privileged
      -- work without it rather than the schema doing so, because an admin must
      -- be able to sign in once in order to enrol one.
      mfa_secret_hash   TEXT,
      mfa_enrolled_at   TEXT,
      -- WebAuthn credential for the passkey / face unlock. The device verifies
      -- the face and releases a key; Telga stores a public key and never a
      -- face image or template.
      webauthn_credential_id TEXT,
      webauthn_public_key    TEXT,
      status            TEXT NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED')),
      -- Who made this account, and who approved it. A sub-admin may only be
      -- created by the Platform Owner, and that claim needs a record.
      created_by        TEXT REFERENCES admin_users(id),
      approved_by       TEXT REFERENCES admin_users(id),
      failed_attempts   INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
      locked_until      TEXT,
      last_login_at     TEXT,
      last_activity_at  TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    ) STRICT;

    CREATE INDEX idx_admin_users_status ON admin_users(status);
    CREATE INDEX idx_admin_users_department ON admin_users(department, role);

    -- One row per granted permission. Absence is denial: least privilege is
    -- the default, and an absent row already says so.
    CREATE TABLE admin_permissions (
      admin_user_id TEXT NOT NULL REFERENCES admin_users(id),
      permission    TEXT NOT NULL,
      granted_by    TEXT NOT NULL REFERENCES admin_users(id),
      granted_at    TEXT NOT NULL,
      PRIMARY KEY (admin_user_id, permission)
    ) STRICT;

    -- Admin sessions. No device_id: a console is used from a laptop, and
    -- requiring an enrolled POS to administer the platform is the wrong shape.
    CREATE TABLE admin_sessions (
      -- SHA-256 of the session token. The token itself is never stored.
      id                  TEXT PRIMARY KEY,
      admin_user_id       TEXT NOT NULL REFERENCES admin_users(id),
      role                TEXT NOT NULL,
      csrf_hash           TEXT NOT NULL,
      -- Whether this session has cleared MFA. A session that has not may sign
      -- in and enrol a second factor, and do nothing else.
      mfa_satisfied       INTEGER NOT NULL DEFAULT 0 CHECK (mfa_satisfied IN (0, 1)),
      -- When the last step-up re-authentication happened. High-risk actions
      -- compare against this rather than trusting the session's age.
      stepped_up_at       TEXT,
      status              TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
      created_at          TEXT NOT NULL,
      last_seen_at        TEXT NOT NULL,
      idle_expires_at     TEXT NOT NULL,
      absolute_expires_at TEXT NOT NULL,
      revoked_at          TEXT,
      revocation_reason   TEXT
    ) STRICT;

    CREATE INDEX idx_admin_sessions_user ON admin_sessions(admin_user_id, status);

    -- Which database belongs to which merchant. The one shared table under a
    -- per-shop database model, and the thing that keeps it from being a folder
    -- of untracked files.
    CREATE TABLE tenant_registry (
      merchant_id     TEXT PRIMARY KEY,
      -- Relative to the configured tenant root. Never an absolute path from a
      -- request: a path taken from input and joined is how a request for
      -- '../../etc' gets served.
      database_name   TEXT NOT NULL UNIQUE,
      -- Per tenant, because with N databases a half-migrated one is a real
      -- state that has to be detectable rather than assumed away.
      schema_version  TEXT NOT NULL,
      status          TEXT NOT NULL CHECK (status IN (
                        'PROVISIONING', 'ACTIVE', 'SUSPENDED', 'CLOSED', 'MIGRATING', 'FAILED'
                      )),
      last_backup_at  TEXT,
      last_restore_at TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    ) STRICT;

    CREATE INDEX idx_tenant_registry_status ON tenant_registry(status);

    -- A registration before there is anything to register against. An
    -- applicant has no account, no credentials and no database until an admin
    -- approves; approving is what creates the merchant.
    CREATE TABLE merchant_applications (
      id                TEXT PRIMARY KEY,
      -- Shown to the applicant. The only thing they get back, so it must be
      -- unguessable rather than sequential.
      reference         TEXT NOT NULL UNIQUE,
      status            TEXT NOT NULL CHECK (status IN (
                          'DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'PROVISIONING',
                          'DEVICE_PENDING', 'READY_FOR_TRAINING', 'ACTIVE_TRAINING',
                          'LIVE_ELIGIBLE', 'SUSPENDED', 'CLOSED'
                        )),
      legal_name        TEXT NOT NULL,
      trading_name      TEXT,
      owner_name        TEXT NOT NULL,
      phone             TEXT NOT NULL,
      email             TEXT,
      address           TEXT NOT NULL,
      locality          TEXT NOT NULL,
      -- Set only once approved, and the link back to the shop this became.
      merchant_id       TEXT,
      -- Who reviewed it, and why they decided what they did. A rejection
      -- without a reason is not a review.
      reviewed_by       TEXT REFERENCES admin_users(id),
      reviewed_at       TEXT,
      decision_reason   TEXT,
      relationship_owner TEXT REFERENCES admin_users(id),
      submitted_at      TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    ) STRICT;

    CREATE INDEX idx_applications_status ON merchant_applications(status, created_at);
  `,
};
