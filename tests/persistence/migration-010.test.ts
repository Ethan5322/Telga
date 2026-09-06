/**
 * Migration 010, checked against real rows rather than an empty database.
 *
 * The same discipline as 008 and 009: seed a database migrated only as far as
 * 009, put real orders in it, then migrate and prove nothing moved.
 *
 * 010 adds `quantity` and changes the `total_minor` CHECK from
 * `total_minor = amount_minor` to `total_minor = amount_minor * quantity`.
 * Every pre-existing row must land as `quantity = 1`, which keeps the old
 * invariant true for it — a row that came out with a different quantity, or
 * with `total_minor` rewritten, would be a silent corruption of money.
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
  dir = mkdtempSync(join(tmpdir(), 'telga-m010-'));
  file = join(dir, 'telga.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Apply migrations in `(after, upTo]` and return an open handle. */
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
  const at = '2026-08-28T08:00:00.000Z';
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

/** Pre-010 shape: no `quantity` column. */
const INSERT_OLD = `
  INSERT INTO pending_orders (
    id, merchant_id, device_id, operator_id, session_id, network, product_type,
    product_id, amount_minor, currency, total_minor, client_request_id, status,
    created_at, expires_at, transaction_id, recipient)
  VALUES (?, 'merchant_alpha', 'device_alpha_1', 'operator_alpha_1', 'session_1', ?, ?,
          ?, ?, 'ETB', ?, ?, ?, '2026-08-28T08:00:00.000Z', '2026-08-28T08:10:00.000Z', ?, ?)`;

/** Post-010 shape. */
const INSERT_NEW = `
  INSERT INTO pending_orders (
    id, merchant_id, device_id, operator_id, session_id, network, product_type,
    product_id, amount_minor, currency, quantity, total_minor, client_request_id,
    status, created_at, expires_at, transaction_id, recipient)
  VALUES (?, 'merchant_alpha', 'device_alpha_1', 'operator_alpha_1', 'session_1', ?, ?,
          ?, ?, 'ETB', ?, ?, ?, ?, '2026-08-28T08:00:00.000Z', '2026-08-28T08:10:00.000Z', ?, ?)`;

describe('migration 010 preserves every existing order', () => {
  it('copies all columns byte-for-byte and lands every old row as quantity 1', () => {
    let db = migrate('009');
    seedOrderPrerequisites(db);
    db.prepare(INSERT_OLD).run(
      'order_1', 'NETWORK_A', 'AIRTIME', 'NETWORK_A_AIRTIME_2500', 2500, 2500,
      'req_1', 'AUTHORIZED', 'txn_1', null,
    );
    db.prepare(INSERT_OLD).run(
      'order_2', 'NETWORK_B', 'TOPUP', 'NETWORK_B_TOPUP_1000', 1000, 1000,
      'req_2', 'OPEN', null, '09****78',
    );
    const before = db.prepare('SELECT * FROM pending_orders ORDER BY id').all() as Record<
      string,
      unknown
    >[];
    db.close();

    db = migrate('010', '009');
    const after = db.prepare('SELECT * FROM pending_orders ORDER BY id').all() as Record<
      string,
      unknown
    >[];

    expect(after).toHaveLength(before.length);
    for (const [index, row] of after.entries()) {
      const original = before[index];
      expect(row['quantity'], 'an order written before bulk printing was for one voucher').toBe(1);
      // Every other column identical, `quantity` aside.
      const { quantity: _q, ...rest } = row;
      expect(rest).toEqual(original);
      // And the old invariant still holds for it.
      expect(row['total_minor']).toBe(original['amount_minor']);
    }
    db.close();
  });

  it('accepts a batch, and still insists the total follows from the parts', () => {
    const db = migrate('010');
    seedOrderPrerequisites(db);

    expect(() =>
      db.prepare(INSERT_NEW).run(
        'order_batch', 'NETWORK_A', 'AIRTIME', 'NETWORK_A_AIRTIME_2500', 2500, 4, 10_000,
        'req_batch', 'OPEN', null, null,
      ),
    ).not.toThrow();

    // A total that does not equal amount x quantity is refused by the database,
    // not merely by the service — so a caller that bypasses the service still
    // cannot store an order whose price does not add up.
    expect(() =>
      db.prepare(INSERT_NEW).run(
        'order_bad_total', 'NETWORK_A', 'AIRTIME', 'p', 2500, 4, 2500,
        'req_bad_total', 'OPEN', null, null,
      ),
    ).toThrow();
    db.close();
  });

  it('bounds the quantity in the database as well as in the service', () => {
    const db = migrate('010');
    seedOrderPrerequisites(db);
    for (const quantity of [0, -1, 21, 100]) {
      expect(
        () =>
          db.prepare(INSERT_NEW).run(
            `order_q_${String(quantity)}`, 'NETWORK_A', 'AIRTIME', 'p', 100, quantity,
            100 * quantity, `req_q_${String(quantity)}`, 'OPEN', null, null,
          ),
        `quantity ${String(quantity)} must be refused`,
      ).toThrow();
    }
    db.close();
  });

  it('still refuses an unknown product type, and still accepts the three real ones', () => {
    const db = migrate('010');
    seedOrderPrerequisites(db);
    for (const kind of ['AIRTIME', 'TOPUP', 'DATA']) {
      expect(() =>
        db.prepare(INSERT_NEW).run(
          `order_${kind}`, 'NETWORK_A', kind, 'p', 100, 1, 100,
          `req_${kind}`, 'OPEN', null, null,
        ),
      ).not.toThrow();
    }
    expect(() =>
      db.prepare(INSERT_NEW).run(
        'order_bad', 'NETWORK_A', 'ELECTRICITY', 'p', 100, 1, 100,
        'req_bad', 'OPEN', null, null,
      ),
    ).toThrow();
    db.close();
  });

  it('recreates both indexes, so a duplicate client request is still refused', () => {
    const db = migrate('010');
    seedOrderPrerequisites(db);
    db.prepare(INSERT_NEW).run(
      'order_1', 'NETWORK_A', 'AIRTIME', 'p', 100, 1, 100, 'req_same', 'OPEN', null, null,
    );
    expect(() =>
      db.prepare(INSERT_NEW).run(
        'order_2', 'NETWORK_A', 'AIRTIME', 'p', 100, 1, 100, 'req_same', 'OPEN', null, null,
      ),
    ).toThrow();
    db.close();
  });

  it('adds no table, drops none, and leaves the database sound', () => {
    let db = migrate('009');
    seedOrderPrerequisites(db);
    const tablesBefore = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    const settingsBefore = db.prepare('SELECT * FROM settings').all();
    db.close();

    db = migrate('010', '009');
    const tablesAfter = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);

    expect(tablesAfter).toEqual(tablesBefore);
    expect(db.prepare('SELECT * FROM settings').all()).toEqual(settingsBefore);
    expect(
      (db.pragma('integrity_check') as { integrity_check: string }[])[0]?.integrity_check,
    ).toBe('ok');
    expect(
      (db.pragma('foreign_key_check') as unknown[]).length,
      'the rebuild must leave no dangling reference',
    ).toBe(0);
    db.close();
  });
});
