import type { Migration } from './index';

/**
 * The vendor's own registration, and the throttle that makes it safe to expose.
 *
 * The founder's flow, 2026-09-09: the Telga app opens on **Login** and
 * **Register as vendor**; a shop taps the second, submits its details, and the
 * submission lands in the operations console for an admin to review. Nothing is
 * approved automatically. See `CLAUDE.md` §18.1 and [[Vendor Registration]].
 *
 * This reverses the registration half of [[Decision Log]] **D113(b)**, which
 * deferred self-service registration. **D138** is that reversal. What D113(b)
 * still forbids is untouched: a *device* may not provision itself, and this
 * migration adds nothing that would let one.
 *
 * ## Why `submitted_via` exists, and why it is not cosmetic
 *
 * Until now every application was typed by a Telga admin from a folder of
 * papers a shop carried in. A reviewer could assume someone had seen the
 * documents. That assumption stops being true the moment the internet can
 * write to this table, and a reviewer who cannot tell the two apart will keep
 * making it.
 *
 * So the column records **who did the typing**, not who owns the shop:
 *
 *   - `ADMIN` — an operator recorded it, having seen the originals.
 *   - `SELF_SERVICE` — a stranger typed it into the app. Every field is a
 *     claim, and none of it has been checked by anybody.
 *
 * The default is `ADMIN` because every row that exists before this migration
 * was recorded that way. A default of `SELF_SERVICE` would retroactively
 * relabel verified applications as unverified, which is the safer-sounding
 * option and the wrong one: it would make the flag meaningless on exactly the
 * rows where it is most trustworthy.
 *
 * ## Why a separate `registration_attempts` table
 *
 * `auth_attempts` counts *authentication* — a subject failing to prove who they
 * are. A registration attempt has no subject to be: nobody is signing in, and
 * the caller is anonymous by design. Widening that table's `scope` CHECK would
 * also mean rebuilding it (SQLite cannot alter a constraint in place), which is
 * a table rewrite carrying live lockout state, in exchange for sharing a column
 * whose meaning does not fit.
 *
 * `source` is a **hash** of the caller's address, never the address itself.
 * Throttling needs only to know that two requests came from the same place; it
 * does not need to know where that is, and an IP address sitting in a database
 * is personal data under §24's minimization rule with no purpose to justify it.
 * Rows are prunable by `created_at` because the throttle only ever asks about a
 * recent window.
 */
export const m018SelfServiceRegistration: Migration = {
  version: '018',
  name: 'self_service_registration',
  sql: `
    -- Who typed this application in. See the note above: this is a statement
    -- about evidence, not about the shop.
    ALTER TABLE merchant_applications
      ADD COLUMN submitted_via TEXT NOT NULL DEFAULT 'ADMIN'
        CHECK (submitted_via IN ('ADMIN', 'SELF_SERVICE'));

    -- A reviewer's queue is ordered by what needs looking at first, and an
    -- unverified submission is a different kind of work from a verified one.
    CREATE INDEX idx_applications_submitted_via
      ON merchant_applications(submitted_via, status, created_at);

    -- The throttle for the one route on this platform that an unauthenticated
    -- stranger may write through.
    CREATE TABLE registration_attempts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      -- A salted hash of the caller's address. Never the address.
      source     TEXT NOT NULL,
      -- Whether a row was written. A refused submission still counts against
      -- the window: otherwise a caller could probe validation for free and
      -- only the successes would be limited.
      outcome    TEXT NOT NULL CHECK (outcome IN ('RECORDED', 'REFUSED')),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX idx_registration_attempts_source
      ON registration_attempts(source, created_at);
  `,
};
