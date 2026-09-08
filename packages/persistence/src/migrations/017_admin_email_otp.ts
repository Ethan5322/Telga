import type { Migration } from './index';

/**
 * Email one-time codes for administrator sign-in.
 *
 * The founder's design, 2026-09-08: an administrator signs in **either** with
 * email and password followed by a code sent to that email, **or** with a
 * biometric passkey which needs no second factor.
 *
 * ## Why the passkey path skips the code, and that is not a shortcut
 *
 * A passkey is already two factors: the device must be present, and the device
 * must verify its owner (face or fingerprint) before it will sign. Adding an
 * emailed code to that would be a third factor for the stronger path and a
 * second for the weaker one — security theatre pointed at the wrong door.
 * Email and password is a single factor, so it gets the code.
 *
 * ## Why the code is hashed, and why attempts are counted
 *
 * A six-digit code has a million possibilities, which is a small number if a
 * caller may guess for as long as they like. Two things bound it: the code is
 * stored as an scrypt hash so reading the table does not hand anybody a live
 * code, and `otp_attempts` is incremented on every wrong guess so the
 * application can stop accepting them. Neither alone is enough — a hash without
 * a limit is still brute-forceable at six digits, and a limit without a hash
 * leaks every pending code to anyone who can read the database.
 *
 * ## What replaces what
 *
 * `mfa_secret_hash` (TOTP, an authenticator app) stays in the schema and is not
 * dropped. The founder chose email codes; removing the TOTP column would make
 * that choice irreversible and would break every administrator already enrolled
 * before the switch. Columns are cheap and a migration that deletes credentials
 * is not.
 */
export const m017AdminEmailOtp: Migration = {
  version: '017',
  name: 'admin_email_otp',
  sql: `
    -- The pending code, scrypt-hashed. Null when no code is outstanding.
    ALTER TABLE admin_users ADD COLUMN otp_hash TEXT;
    ALTER TABLE admin_users ADD COLUMN otp_salt TEXT;
    -- When the code stops being accepted. A code with no expiry is a password
    -- that happens to be six digits long.
    ALTER TABLE admin_users ADD COLUMN otp_expires_at TEXT;
    -- Wrong guesses against the current code. Reset when a new code is issued
    -- and when one is accepted; a counter that only ever grows would lock an
    -- administrator out permanently after enough typos across the months.
    ALTER TABLE admin_users ADD COLUMN otp_attempts INTEGER NOT NULL DEFAULT 0
      CHECK (otp_attempts >= 0);
    -- When the last code was sent, so a caller cannot make Telga send mail to
    -- an address as fast as they can press a button.
    ALTER TABLE admin_users ADD COLUMN otp_sent_at TEXT;
  `,
};
