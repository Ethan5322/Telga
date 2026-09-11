/**
 * The columns of the tables that matter most, held as a ledger.
 *
 * ## Why this exists
 *
 * `05 Operations/Runbooks` recorded the gap after migration 018 broke
 * `migration-008.test.ts`, and ended with a recommendation:
 *
 * > *"Columns are not covered by this guard, and three migrations have now
 * > added one (`must_change_pin`, `deposit_lookup`, `submitted_via`). Only the
 * > first has a direct assertion. A companion guard over column lists would
 * > close the gap."*
 *
 * This is that guard. `migration-008.test.ts` catches an unexpected **table**;
 * a column could be added, renamed or dropped in silence — and a dropped column
 * is the one that loses data.
 *
 * ## How to read a failure
 *
 * The question is **"did I mean to change that?"**, never "how do I make this
 * pass". If the change was intended, update the expectation in the same commit
 * as the migration, so the diff shows the schema moving. If it was not, the
 * migration is wrong.
 *
 * Only the columns are pinned, not their types or constraints: those belong to
 * the migration that declares them, and duplicating them here would make every
 * `CHECK` widening a two-file edit for no extra safety.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@telga/persistence';

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A fully migrated database, and its shape. */
function schema(): Map<string, string[]> {
  dir = mkdtempSync(join(tmpdir(), 'telga-schema-'));
  const db = new Database(join(dir, 'schema.sqlite'));
  db.pragma('foreign_keys = ON');
  runMigrations(db as never, '2026-09-09T12:00:00.000Z' as never);

  const tables = (
    db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name);

  const shape = new Map<string, string[]>();
  for (const table of tables) {
    const columns = (
      db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).map((c) => c.name);
    // Sorted, so a column added in the middle of a CREATE TABLE reads as an
    // addition rather than as a reordering of everything after it.
    shape.set(table, columns.sort());
  }
  db.close();
  return shape;
}

/**
 * The columns each table is expected to have.
 *
 * Grouped by the migration that introduced the table, so a reader can see when
 * each arrived. **Changing this is part of changing the schema**, not a
 * follow-up chore.
 */
const EXPECTED: Readonly<Record<string, readonly string[]>> = {
  // --- 019: reversal requests, complaint reviews, shop transfers ------------
  complaint_reviews: [
    'created_at', 'description', 'id', 'merchant_id', 'provider_state', 'redemption',
    'reviewed_at', 'reviewed_by', 'support_case_id', 'telga_state', 'updated_at',
    'verdict', 'verdict_reason',
  ],
  reversal_requests: [
    'amount_minor', 'correlation_id', 'created_at', 'decided_at', 'decided_by',
    'decision_reason', 'device_id', 'id', 'merchant_id', 'reason', 'redemption',
    'requested_by', 'reversal_entry_id', 'status', 'transaction_id', 'updated_at',
  ],
  shop_transfers: [
    'amount_minor', 'approved_at', 'approved_by', 'correlation_id', 'created_at',
    'fee_minor', 'id', 'mode', 'posting_id', 'recipient_device_id',
    'recipient_merchant_id', 'refusal_reason', 'sender_device_id',
    'sender_merchant_id', 'sender_operator_id', 'status', 'updated_at',
  ],

  // --- 018: self-service registration ---------------------------------------
  registration_attempts: ['created_at', 'id', 'outcome', 'source'],

  // --- the money-and-identity core ------------------------------------------
  //
  // Added 2026-09-11. This guard's own title says *"every column of every
  // table"* and it covered **four** — the ones migration 019 happened to add.
  // A column dropped from `merchants`, `transactions` or `ledger_entries` —
  // the tables where losing one loses money or identity — passed unnoticed.
  //
  // Still not every table. The claim in the title is narrowed to match what
  // is actually pinned, because a guard that overstates its coverage is worse
  // than one that admits a limit.
  merchants: ['created_at', 'deposit_reference', 'id', 'mode', 'status', 'updated_at'],
  devices: ['created_at', 'device_type', 'id', 'merchant_id', 'status', 'updated_at'],
  merchant_users: [
    'created_at', 'display_name', 'failed_attempts', 'id', 'last_login_at',
    'locked_until', 'merchant_id', 'mode', 'must_change_pin', 'pin_hash', 'pin_params',
    'pin_salt', 'role', 'status', 'updated_at'
  ],
  device_enrollments: [
    'created_at', 'deposit_lookup', 'device_id', 'display_name', 'enrolled_at',
    'enrollment_state', 'expires_at', 'last_seen_at', 'merchant_id',
    'revocation_reason', 'revoked_at', 'secret_hash', 'secret_salt', 'updated_at'
  ],
  transactions: [
    'amount_minor', 'created_at', 'currency', 'device_id', 'id', 'idempotency_key',
    'merchant_id', 'mode', 'operator_id', 'payload_fingerprint', 'product_type',
    'provider_id', 'provider_reference', 'recipient_hash', 'recipient_masked', 'state',
    'updated_at'
  ],
  ledger_entries: [
    'account_id', 'account_type', 'amount_minor', 'correlation_id', 'created_at',
    'currency', 'direction', 'entry_type', 'id', 'merchant_id', 'metadata', 'mode',
    'posting_id', 'provider_reference', 'rule_version', 'transaction_id'
  ],
  ledger_accounts: ['account_type', 'created_at', 'currency', 'id', 'merchant_id'],
  funding_submissions: [
    'approved_at', 'approved_by', 'bank_amount_minor', 'bank_reference',
    'claimed_amount_minor', 'created_at', 'currency', 'decided_at', 'decided_by',
    'evidence', 'id', 'merchant_id', 'outcome_reason', 'posting_id', 'quoted_reference',
    'recorded_by', 'status', 'updated_at'
  ],
  topup_orders: [
    'amount_minor', 'correlation_id', 'created_at', 'currency', 'device_id',
    'expires_at', 'funding_submission_id', 'id', 'merchant_id', 'method', 'mode',
    'operator_id', 'provider_reference', 'provider_status', 'reference', 'status',
    'updated_at'
  ],
  admin_users: [
    'approved_by', 'created_at', 'created_by', 'department', 'display_name', 'email',
    'failed_attempts', 'id', 'last_activity_at', 'last_login_at', 'locked_until',
    'mfa_enrolled_at', 'mfa_secret_hash', 'otp_attempts', 'otp_expires_at', 'otp_hash',
    'otp_salt', 'otp_sent_at', 'password_hash', 'password_params', 'password_salt',
    'role', 'status', 'updated_at', 'webauthn_credential_id', 'webauthn_public_key'
  ],
};

describe('the schema’s columns are a ledger, not an accident', () => {
  it('has exactly the columns expected for every table this guard covers', () => {
    const actual = schema();
    const wrong: string[] = [];

    for (const [table, expected] of Object.entries(EXPECTED)) {
      const found = actual.get(table);
      if (found === undefined) {
        wrong.push(`${table}: table is missing entirely`);
        continue;
      }
      const added = found.filter((c) => !expected.includes(c));
      const removed = expected.filter((c) => !found.includes(c));
      if (added.length > 0) wrong.push(`${table}: unexpected column(s) ${added.join(', ')}`);
      // A dropped column is the one that loses data, so it is reported first
      // and separately from an addition.
      if (removed.length > 0) wrong.push(`${table}: MISSING column(s) ${removed.join(', ')}`);
    }

    expect(wrong, `Did you mean to change the schema?\n  ${wrong.join('\n  ')}`).toEqual([]);
  });

  it('still carries the three columns earlier migrations added quietly', () => {
    // The specific gap the Runbooks recommendation named. Each of these was
    // added by a migration whose *tables* were guarded and whose *columns* were
    // not, so a later migration could have dropped one in silence.
    const actual = schema();
    expect(actual.get('merchant_users')).toContain('must_change_pin');
    expect(actual.get('device_enrollments')).toContain('deposit_lookup');
    expect(actual.get('merchant_applications')).toContain('submitted_via');
  });

  it('keeps the ledger append-only in shape as well as in triggers', () => {
    // `ledger_entries` is the table §13 cares about most. Its columns are the
    // vocabulary every balance is derived from, and a rename here would be
    // silent everywhere until a total came out wrong.
    const columns = schema().get('ledger_entries') ?? [];
    for (const required of [
      'account_id',
      'amount_minor',
      'created_at',
      'currency',
      'direction',
      'entry_type',
      'merchant_id',
      'posting_id',
      'transaction_id',
    ]) {
      expect(columns, `ledger_entries.${required}`).toContain(required);
    }
  });
});
