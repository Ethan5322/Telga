/**
 * Migration 008: recipient, top-up, settings.
 *
 * The rebuild of `pending_orders` is the risky part — SQLite cannot alter a
 * CHECK constraint, so the table is recreated and copied. These tests seed
 * real rows *before* the migration and assert every one survives byte for
 * byte, because "the migration ran" and "no data was lost" are different
 * claims and only the second one matters.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  SqliteLedgerDriver,
  runMigrations,
  m008RecipientTopupSettings,
} from '@telga/persistence';
import { timestamp } from '@telga/domain';

const AT = timestamp('2026-08-27T09:00:00.000Z');
let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `telga-m008-${name}-`));
  dirs.push(dir);
  return join(dir, 'telga.sqlite');
}

/** A database migrated only as far as 007, with one real pending order in it. */
function seededTo007(name: string): SqliteLedgerDriver {
  const driver = new SqliteLedgerDriver({ file: tempFile(name) });
  runMigrations(
    driver.unsafeConnection,
    AT,
    MIGRATIONS.filter((m) => m.version < '008'),
  );
  const db = driver.unsafeConnection;
  db.prepare(
    `INSERT INTO merchants (id, status, mode, created_at, updated_at)
     VALUES ('merchant_alpha','ACTIVE','TRAINING',?,?)`,
  ).run(AT, AT);
  db.prepare(
    `INSERT INTO devices (id, merchant_id, status, device_type, created_at, updated_at)
     VALUES ('device_1','merchant_alpha','ACTIVE','WEB_POS',?,?)`,
  ).run(AT, AT);
  db.prepare(
    `INSERT INTO merchant_users (id, merchant_id, display_name, role, pin_hash, pin_salt,
       pin_params, status, failed_attempts, locked_until, last_login_at, mode, created_at, updated_at)
     VALUES ('op_1','merchant_alpha','Op','MERCHANT_OWNER','h','s','p','ACTIVE',0,NULL,NULL,'TRAINING',?,?)`,
  ).run(AT, AT);
  db.prepare(
    `INSERT INTO sessions (id, user_id, merchant_id, device_id, role, csrf_hash, status,
       created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at, revocation_reason)
     VALUES ('sess_1','op_1','merchant_alpha','device_1','MERCHANT_OWNER','c','ACTIVE',?,?,?,?,NULL,NULL)`,
  ).run(AT, AT, AT, AT);
  db.prepare(
    `INSERT INTO pending_orders (id, merchant_id, device_id, operator_id, session_id, network,
       product_type, product_id, amount_minor, currency, total_minor, client_request_id, status,
       created_at, expires_at, transaction_id)
     VALUES ('order_1','merchant_alpha','device_1','op_1','sess_1','NETWORK_A','AIRTIME',
       'NETWORK_A_AIRTIME_2500',2500,'ETB',2500,'req_1','OPEN',?,?,NULL)`,
  ).run(AT, AT);
  return driver;
}

describe('migration 008', () => {
  it('is registered exactly once, after 007', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions.filter((v) => v === '008')).toHaveLength(1);
    expect([...versions].sort()).toEqual(versions);
    expect(versions.indexOf('008')).toBe(versions.indexOf('007') + 1);
  });

  it('preserves every existing pending order, byte for byte', () => {
    const driver = seededTo007('preserves');
    try {
      const before = driver.unsafeConnection
        .prepare('SELECT * FROM pending_orders ORDER BY id')
        .all() as Record<string, unknown>[];
      expect(before).toHaveLength(1);

      driver.migrate(AT);

      const after = driver.unsafeConnection
        .prepare('SELECT * FROM pending_orders ORDER BY id')
        .all() as Record<string, unknown>[];
      expect(after).toHaveLength(1);

      // Every column that existed before is identical afterwards.
      for (const key of Object.keys(before[0])) {
        expect(after[0]?.[key], `column ${key}`).toEqual(before[0]?.[key]);
      }
      // The new column exists and is null for a pre-existing row, rather than
      // an invented number.
      expect(after[0]).toHaveProperty('recipient');
      expect(after[0]?.['recipient']).toBeNull();
    } finally {
      driver.close();
    }
  });

  it('accepts a recipient on a new order, and TOPUP as a product type', () => {
    const driver = seededTo007('accepts-new');
    try {
      driver.migrate(AT);
      const db = driver.unsafeConnection;
      db.prepare(
        `INSERT INTO pending_orders (id, merchant_id, device_id, operator_id, session_id, network,
           product_type, product_id, amount_minor, currency, total_minor, client_request_id, status,
           created_at, expires_at, transaction_id, recipient)
         VALUES ('order_2','merchant_alpha','device_1','op_1','sess_1','NETWORK_A','TOPUP',
           'NETWORK_A_TOPUP',5000,'ETB',5000,'req_2','OPEN',?,?,NULL,'0911***678')`,
      ).run(AT, AT);

      const row = db.prepare('SELECT product_type, recipient FROM pending_orders WHERE id = ?').get('order_2') as {
        product_type: string;
        recipient: string;
      };
      expect(row.product_type).toBe('TOPUP');
      expect(row.recipient).toBe('0911***678');
    } finally {
      driver.close();
    }
  });

  it('still refuses a product type outside the widened list', () => {
    const driver = seededTo007('refuses-unknown');
    try {
      driver.migrate(AT);
      expect(() =>
        driver.unsafeConnection
          .prepare(
            `INSERT INTO pending_orders (id, merchant_id, device_id, operator_id, session_id, network,
               product_type, product_id, amount_minor, currency, total_minor, client_request_id, status,
               created_at, expires_at, transaction_id, recipient)
             VALUES ('order_3','merchant_alpha','device_1','op_1','sess_1','NETWORK_A','ELECTRICITY',
               'X',5000,'ETB',5000,'req_3','OPEN',?,?,NULL,NULL)`,
          )
          .run(AT, AT),
      ).toThrow();
    } finally {
      driver.close();
    }
  });

  it('creates a settings table that refuses an unknown key', () => {
    const driver = seededTo007('settings');
    try {
      driver.migrate(AT);
      const db = driver.unsafeConnection;

      db.prepare(
        `INSERT INTO settings (merchant_id, key, value, updated_at)
         VALUES ('merchant_alpha','PROFIT_PERCENT_BPS','400',?)`,
      ).run(AT);
      const row = db.prepare('SELECT value FROM settings WHERE merchant_id = ? AND key = ?').get(
        'merchant_alpha',
        'PROFIT_PERCENT_BPS',
      ) as { value: string };
      expect(row.value).toBe('400');

      // A typo is a refused write, not a setting that silently never applies.
      expect(() =>
        db
          .prepare(
            `INSERT INTO settings (merchant_id, key, value, updated_at)
             VALUES ('merchant_alpha','PROFIT_PERCNT','400',?)`,
          )
          .run(AT),
      ).toThrow();
    } finally {
      driver.close();
    }
  });

  it('leaves the ledger and audit tables untouched', () => {
    const driver = seededTo007('ledger-untouched');
    try {
      const db = driver.unsafeConnection;
      const tablesBefore = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];

      driver.migrate(AT);

      const tablesAfter = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      const added = tablesAfter
        .map((t) => t.name)
        .filter((n) => !tablesBefore.map((t) => t.name).includes(n));
      // `driver.migrate` applies *every* pending migration, not only 008, so
      // this list grows as migrations are added — and that is the point: an
      // unexpected new table fails here rather than appearing unnoticed.
      // `pending_orders` is rebuilt under its own name and so is not "new".
      //
      //   008 → settings
      //   012 → customers, shifts
      //   013 → transaction_attempts, provider_health_events
      //   014 → admin_users, admin_permissions, admin_sessions,
      //         tenant_registry, merchant_applications
      //   015 → merchant_application_documents
      //   016 → funding_submissions
      //   018 → registration_attempts
      //   019 → reversal_requests, complaint_reviews, shop_transfers
      //
      // 015 also adds `merchant_users.must_change_pin`, 016 adds
      // `device_enrollments.deposit_lookup`, and 018 adds
      // `merchant_applications.submitted_via`. All are columns and so do not
      // appear here. That columns are invisible to this guard is why
      // migration-015.test.ts asserts its one directly, against a database
      // populated before the migration ran.
      expect(added).toEqual([
        'admin_permissions',
        'admin_sessions',
        'admin_users',
        'complaint_reviews',
        'customers',
        'funding_submissions',
        'merchant_application_documents',
        'merchant_applications',
        'provider_health_events',
        'registration_attempts',
        'reversal_requests',
        'settings',
        'shifts',
        'shop_transfers',
        'tenant_registry',
        'transaction_attempts',
      ]);
      expect(driver.health().integrityCheck).toBe('ok');
    } finally {
      driver.close();
    }
  });

  it('is immutable once applied: re-running is a no-op', () => {
    const driver = seededTo007('idempotent');
    try {
      driver.migrate(AT);
      const first = driver.appliedMigrations().length;
      driver.migrate(AT);
      expect(driver.appliedMigrations().length).toBe(first);
      expect(m008RecipientTopupSettings.version).toBe('008');
    } finally {
      driver.close();
    }
  });
});
