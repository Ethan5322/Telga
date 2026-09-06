/**
 * Migrations 010 and 011, checked against real rows.
 *
 * Same discipline as the 008 and 009 tests: seed a database migrated only as
 * far as the previous version, put real rows in it, then migrate and prove
 * nothing moved. Both are CHECK changes, so both rebuild a table — which is
 * exactly the operation that silently drops a column if a column list is
 * mistyped.
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
  dir = mkdtempSync(join(tmpdir(), 'telga-m1011-'));
  file = join(dir, 'telga.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Apply migrations in `(after, upTo]` on the same file. */
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

function seed(db: Database.Database): void {
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

const INSERT_ORDER_009 = `
  INSERT INTO pending_orders (
    id, merchant_id, device_id, operator_id, session_id, network, product_type,
    product_id, amount_minor, currency, total_minor, client_request_id, status,
    created_at, expires_at, transaction_id, recipient)
  VALUES (?, 'merchant_alpha', 'device_alpha_1', 'operator_alpha_1', 'session_1', ?, ?,
          ?, ?, 'ETB', ?, ?, ?, '2026-08-28T08:00:00.000Z', '2026-08-28T08:10:00.000Z', ?, ?)`;

describe('migration 010 — order quantity', () => {
  it('preserves every existing order and defaults them to one voucher', () => {
    let db = migrate('009');
    seed(db);
    db.prepare(INSERT_ORDER_009).run(
      'order_1', 'NETWORK_A', 'AIRTIME', 'NETWORK_A_AIRTIME_2500', 2500, 2500,
      'req_1', 'AUTHORIZED', 'txn_1', null,
    );
    db.prepare(INSERT_ORDER_009).run(
      'order_2', 'NETWORK_B', 'DATA', 'NETWORK_B_DATA_MONTHLY_1GB_30D', 12_500, 12_500,
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

    // Every pre-existing column is byte-identical; `quantity` is the only new
    // one, and an order that predates bulk printing was for exactly one.
    expect(after).toHaveLength(before.length);
    for (const [index, row] of after.entries()) {
      const original = before[index];
      for (const key of Object.keys(original)) {
        expect(row[key], `${String(original['id'])}.${key}`).toEqual(original[key]);
      }
      expect(row['quantity']).toBe(1);
    }
    db.close();
  });

  it('enforces total = amount × quantity, and bounds the quantity', () => {
    const db = migrate('010');
    seed(db);
    const insert = (id: string, qty: number, total: number): void => {
      db.prepare(
        `INSERT INTO pending_orders (
           id, merchant_id, device_id, operator_id, session_id, network, product_type,
           product_id, amount_minor, currency, quantity, total_minor, client_request_id,
           status, created_at, expires_at, transaction_id, recipient)
         VALUES (?, 'merchant_alpha', 'device_alpha_1', 'operator_alpha_1', 'session_1',
           'NETWORK_A', 'AIRTIME', 'p', 2500, 'ETB', ?, ?, ?, 'OPEN',
           '2026-08-28T08:00:00.000Z', '2026-08-28T08:10:00.000Z', NULL, NULL)`,
      ).run(id, qty, total, `req_${id}`);
    };

    expect(() => insert('ok', 4, 10_000), 'four vouchers at 25 birr is 100 birr').not.toThrow();
    expect(() => insert('bad_total', 4, 2500), 'a total that ignores quantity').toThrow();
    expect(() => insert('too_many', 21, 52_500), 'above the training ceiling').toThrow();
    expect(() => insert('none', 0, 0), 'a zero-voucher order').toThrow();
    db.close();
  });
});

describe('migration 011 — corporate settings', () => {
  it('keeps every existing setting and accepts the new keys', () => {
    let db = migrate('010');
    seed(db);
    const at = '2026-08-28T08:00:00.000Z';
    db.prepare(`INSERT INTO settings VALUES ('merchant_alpha', 'SLIP_SIZE', '58', ?)`).run(at);
    db.prepare(`INSERT INTO settings VALUES ('merchant_alpha', 'PROFIT_PERCENT_BPS', '450', ?)`).run(at);
    const before = db.prepare('SELECT * FROM settings ORDER BY key').all();
    db.close();

    db = migrate('011', '010');
    expect(db.prepare('SELECT * FROM settings ORDER BY key').all()).toEqual(before);

    for (const key of [
      'BUSINESS_NAME',
      'BUSINESS_ADDRESS',
      'BUSINESS_PHONE',
      'BUSINESS_TIN',
      'BUSINESS_LICENCE',
      'SLIP_FOOTER',
    ]) {
      expect(
        () => db.prepare(`INSERT INTO settings VALUES ('merchant_alpha', ?, 'x', ?)`).run(key, at),
        `${key} should be storable`,
      ).not.toThrow();
    }

    // The CHECK is still doing its job — a typo is a refused write, not a
    // setting that silently never applies.
    expect(() =>
      db.prepare(`INSERT INTO settings VALUES ('merchant_alpha', 'BUSINES_NAME', 'x', ?)`).run(at),
    ).toThrow();
    db.close();
  });

  it('leaves the database sound and adds no table', () => {
    let db = migrate('010');
    const tableNames = (d: Database.Database): string[] =>
      (
        d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
          name: string;
        }[]
      ).map((r) => r.name);
    const before = tableNames(db);
    db.close();

    db = migrate('011', '010');
    expect(tableNames(db)).toEqual(before);
    expect(
      (db.pragma('integrity_check') as { integrity_check: string }[])[0]?.integrity_check,
    ).toBe('ok');
    expect((db.pragma('foreign_key_check') as unknown[]).length).toBe(0);
    db.close();
  });
});
