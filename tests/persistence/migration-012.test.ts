/**
 * Migration 012 — shifts, saved customers, and the shop's preferences.
 *
 * `settings` is rebuilt to widen its key CHECK, which is the operation that
 * silently drops rows if a column list is mistyped. `shifts` and `customers`
 * are new and empty.
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
  dir = mkdtempSync(join(tmpdir(), 'telga-m012-'));
  file = join(dir, 'telga.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

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

const AT = '2026-08-28T08:00:00.000Z';

function seed(db: Database.Database): void {
  db.exec(`
    INSERT INTO merchants (id, status, mode, created_at, updated_at)
      VALUES ('merchant_alpha', 'ACTIVE', 'TRAINING', '${AT}', '${AT}');
    INSERT INTO devices (id, merchant_id, status, device_type, created_at, updated_at)
      VALUES ('device_alpha_1', 'merchant_alpha', 'ACTIVE', 'WEB_POS', '${AT}', '${AT}');
    INSERT INTO merchant_users (
        id, merchant_id, display_name, role, pin_hash, pin_salt, pin_params, status,
        failed_attempts, locked_until, last_login_at, mode, created_at, updated_at)
      VALUES ('operator_alpha_1', 'merchant_alpha', 'Operator', 'MERCHANT_OPERATOR',
              'h', 's', 'scrypt$N=1', 'ACTIVE', 0, NULL, NULL, 'TRAINING', '${AT}', '${AT}');
  `);
}

describe('migration 012', () => {
  it('keeps every existing setting and accepts the new preference keys', () => {
    let db = migrate('011');
    seed(db);
    db.prepare(`INSERT INTO settings VALUES ('merchant_alpha', 'SLIP_SIZE', '58', ?)`).run(AT);
    db.prepare(`INSERT INTO settings VALUES ('merchant_alpha', 'BUSINESS_NAME', 'Shop', ?)`).run(AT);
    const before = db.prepare('SELECT * FROM settings ORDER BY key').all();
    db.close();

    db = migrate('012', '011');
    expect(db.prepare('SELECT * FROM settings ORDER BY key').all()).toEqual(before);

    for (const key of [
      'SOUND_ENABLED',
      'HIDE_BALANCE',
      'LOW_BALANCE_ALERT',
      'LOW_BALANCE_THRESHOLD_MINOR',
      'LOCK_SECONDS',
      'STATEMENTS_ADMIN_ONLY',
      'PRINT_BARCODE',
      'PRINT_LOOKUP_SLIP',
      'PIN_LOCK_ENABLED',
    ]) {
      expect(
        () => db.prepare(`INSERT INTO settings VALUES ('merchant_alpha', ?, 'on', ?)`).run(key, AT),
        `${key} should be storable`,
      ).not.toThrow();
    }
    // The CHECK still refuses a typo rather than storing a setting that would
    // silently never apply.
    expect(() =>
      db.prepare(`INSERT INTO settings VALUES ('merchant_alpha', 'SOUND_ENABLE', 'on', ?)`).run(AT),
    ).toThrow();
    db.close();
  });

  it('records a shift as a span of time, and closes it exactly once', () => {
    const db = migrate('012');
    seed(db);
    db.prepare(
      `INSERT INTO shifts VALUES ('shift_1', 'merchant_alpha', 'operator_alpha_1',
        'device_alpha_1', ?, NULL, 'TRAINING')`,
    ).run(AT);

    const close = db.prepare(
      "UPDATE shifts SET closed_at = ? WHERE id = ? AND closed_at IS NULL",
    );
    expect(close.run('2026-08-28T17:00:00.000Z', 'shift_1').changes, 'first close wins').toBe(1);
    expect(close.run('2026-08-28T18:00:00.000Z', 'shift_1').changes, 'second changes nothing').toBe(0);

    // Closing records a time; it never removes the row.
    const row = db.prepare('SELECT * FROM shifts WHERE id = ?').get('shift_1') as {
      closed_at: string;
    };
    expect(row.closed_at).toBe('2026-08-28T17:00:00.000Z');
    db.close();
  });

  it('stores a saved customer’s number masked, never in full', () => {
    const db = migrate('012');
    seed(db);
    db.prepare(
      `INSERT INTO customers VALUES ('cust_1', 'merchant_alpha', 'Abebe', '09******78', ?, ?, 'TRAINING')`,
    ).run(AT, AT);

    const row = db.prepare('SELECT * FROM customers WHERE id = ?').get('cust_1') as {
      phone_masked: string;
    };
    // The column is named for what it holds, and what it holds is a mask —
    // the repository masks at the boundary before anything reaches here.
    expect(row.phone_masked).toContain('*');
    expect(row.phone_masked).not.toBe('0912345678');
    db.close();
  });

  it('refuses a live-mode row in either new table', () => {
    const db = migrate('012');
    seed(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO shifts VALUES ('s', 'merchant_alpha', 'operator_alpha_1',
            'device_alpha_1', ?, NULL, 'LIVE')`,
        )
        .run(AT),
    ).toThrow();
    expect(() =>
      db
        .prepare(`INSERT INTO customers VALUES ('c', 'merchant_alpha', 'A', '09**78', ?, ?, 'LIVE')`)
        .run(AT, AT),
    ).toThrow();
    db.close();
  });

  it('leaves the database sound', () => {
    const db = migrate('012');
    expect(
      (db.pragma('integrity_check') as { integrity_check: string }[])[0]?.integrity_check,
    ).toBe('ok');
    expect((db.pragma('foreign_key_check') as unknown[]).length).toBe(0);
    db.close();
  });
});
