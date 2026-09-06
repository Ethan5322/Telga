/**
 * Migration 009, checked against real rows rather than an empty database.
 *
 * The same discipline as `migration-008.test.ts`: seed a database migrated
 * only as far as 008, put real orders in it — including the `recipient` and
 * `TOPUP` values 008 introduced — then migrate and prove nothing moved.
 *
 * 008 had to insert `NULL` for a column that did not yet exist. 009 does not:
 * every column already exists, so a lost value here would be a plain copying
 * mistake, which is exactly what these assertions are for.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '@telga/persistence';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'telga-m009-'));
  file = join(dir, 'telga.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Apply migrations in `(after, upTo]` and return an open handle.
 *
 * Bounded at both ends because these tests reopen the *same file* to migrate
 * it further — replaying from `001` on a database that already has the
 * tables would fail with "table merchants already exists", which is the
 * migrator's own job to prevent and not what is under test here.
 */
function migrate(upTo: string, after = '000'): Database.Database {
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS) {
    if (migration.version <= after) continue;
    if (migration.version > upTo) break;
    db.exec(`BEGIN; ${migration.sql} COMMIT;`);
  }
  return db;
}

function seedOrderPrerequisites(db: Database.Database): void {
  const at = '2026-08-27T08:00:00.000Z';
  db.exec(`
    INSERT INTO merchants (id, status, mode, created_at, updated_at)
      VALUES ('merchant_alpha', 'ACTIVE', 'TRAINING', '${at}', '${at}');
    INSERT INTO devices (id, merchant_id, status, device_type, created_at, updated_at)
      VALUES ('device_alpha_1', 'merchant_alpha', 'ACTIVE', 'WEB_POS', '${at}', '${at}');
    INSERT INTO merchant_users (
        id, merchant_id, display_name, role, pin_hash, pin_salt, pin_params, status,
        failed_attempts, locked_until, last_login_at, mode, created_at, updated_at)
      VALUES ('operator_alpha_1', 'merchant_alpha', 'Operator', 'MERCHANT_OPERATOR',
              'h', 's', 'scrypt$N=1', 'ACTIVE', 0, NULL, NULL, 'TRAINING', '${at}', '${at}');
    INSERT INTO sessions (
        id, user_id, merchant_id, device_id, role, csrf_hash, status, created_at,
        last_seen_at, idle_expires_at, absolute_expires_at, revoked_at, revocation_reason)
      VALUES ('session_1', 'operator_alpha_1', 'merchant_alpha', 'device_alpha_1',
              'MERCHANT_OPERATOR', 'c', 'ACTIVE', '${at}', '${at}', '${at}', '${at}', NULL, NULL);
  `);
}

const INSERT_ORDER = `
  INSERT INTO pending_orders (
    id, merchant_id, device_id, operator_id, session_id, network, product_type,
    product_id, amount_minor, currency, total_minor, client_request_id, status,
    created_at, expires_at, transaction_id, recipient)
  VALUES (?, 'merchant_alpha', 'device_alpha_1', 'operator_alpha_1', 'session_1', ?, ?,
          ?, ?, 'ETB', ?, ?, ?, '2026-08-27T08:00:00.000Z', '2026-08-27T08:10:00.000Z', ?, ?)`;

describe('migration 009 preserves every existing order', () => {
  it('copies all columns byte-for-byte, recipient included', () => {
    let db = migrate('008');
    seedOrderPrerequisites(db);
    db.prepare(INSERT_ORDER).run(
      'order_1', 'NETWORK_A', 'AIRTIME', 'NETWORK_A_AIRTIME_2500', 2500, 2500,
      'req_1', 'AUTHORIZED', 'txn_1', null,
    );
    db.prepare(INSERT_ORDER).run(
      'order_2', 'NETWORK_B', 'TOPUP', 'NETWORK_B_TOPUP_1000', 1000, 1000,
      'req_2', 'OPEN', null, '09****78',
    );
    const before = db.prepare('SELECT * FROM pending_orders ORDER BY id').all();
    db.close();

    db = migrate('009', '008');
    const after = db.prepare('SELECT * FROM pending_orders ORDER BY id').all();
    expect(after).toEqual(before);
    db.close();
  });

  it('now accepts DATA, and still refuses anything else', () => {
    const db = migrate('009');
    seedOrderPrerequisites(db);

    expect(() =>
      db.prepare(INSERT_ORDER).run(
        'order_data', 'NETWORK_A', 'DATA', 'NETWORK_A_DATA_MONTHLY_1GB_30D', 12_500, 12_500,
        'req_data', 'OPEN', null, '09****78',
      ),
    ).not.toThrow();

    for (const rejected of ['ELECTRICITY', 'WATER', 'airtime', '']) {
      expect(
        () =>
          db.prepare(INSERT_ORDER).run(
            `order_${rejected}`, 'NETWORK_A', rejected, 'p', 100, 100,
            `req_${rejected}`, 'OPEN', null, null,
          ),
        `"${rejected}" must still be refused`,
      ).toThrow();
    }
    db.close();
  });

  it('recreates both indexes, so a duplicate client request is still refused', () => {
    const db = migrate('009');
    seedOrderPrerequisites(db);
    db.prepare(INSERT_ORDER).run(
      'order_1', 'NETWORK_A', 'AIRTIME', 'p', 100, 100, 'req_same', 'OPEN', null, null,
    );
    expect(() =>
      db.prepare(INSERT_ORDER).run(
        'order_2', 'NETWORK_A', 'AIRTIME', 'p', 100, 100, 'req_same', 'OPEN', null, null,
      ),
    ).toThrow();
    db.close();
  });

  it('adds no table and drops none', () => {
    let db = migrate('008');
    const before = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    db.close();

    db = migrate('009', '008');
    const after = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    // Deliberately no `voucher_codes`: redemption codes are derived from the
    // transaction id, never stored. See the migration's own note.
    expect(after).toEqual(before);
    db.close();
  });

  it('leaves the database sound and touches nothing else', () => {
    let db = migrate('008');
    seedOrderPrerequisites(db);
    const settingsBefore = db.prepare('SELECT * FROM settings').all();
    db.close();

    db = migrate('009', '008');
    expect((db.pragma('integrity_check') as { integrity_check: string }[])[0]?.integrity_check).toBe('ok');
    expect(db.prepare('SELECT * FROM settings').all()).toEqual(settingsBefore);
    expect(
      (db.pragma('foreign_key_check') as unknown[]).length,
      'the rebuild must leave no dangling reference',
    ).toBe(0);
    db.close();
  });
});
