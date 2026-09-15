/**
 * Migrating a database that already has data in it.
 *
 * `migration-023` and `migration-024` both build their database from nothing,
 * which proves the SQL is valid and proves nothing about the deployment. The
 * Railway volume is at **022**, with training merchants, devices, sales, ledger
 * entries and settings already in it, and that is what these migrations will
 * actually meet.
 *
 * The difference has bitten this repository before: migration 008 rebuilt
 * `pending_orders` under a new name and the rebuild is where the risk lives, not
 * the `CREATE TABLE`.
 *
 * So this seeds a realistic 022 database, migrates it forward, and checks that
 * nothing already there was disturbed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, runMigrations } from '@telga/persistence';

const AT = '2026-09-01T10:00:00.000Z';
let dir: string;
let db: Database.Database;

/** Everything up to and including 022 — what the deployment is running. */
const THROUGH_022 = MIGRATIONS.filter((m) => m.version <= '022');
const FROM_023 = MIGRATIONS.filter((m) => m.version > '022');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'telga-upgrade-'));
  db = new Database(join(dir, 'telga.sqlite'));
  db.pragma('foreign_keys = ON');
  runMigrations(db as never, AT as never, THROUGH_022 as never);

  // A shop that has been trading: a merchant, a device, an operator, a settled
  // sale with its ledger pair, and the per-shop profit setting that D165 stops
  // reading but must not destroy.
  db.exec(`
    INSERT INTO merchants (id, status, mode, created_at, updated_at)
      VALUES ('shop_live', 'ACTIVE', 'TRAINING', '${AT}', '${AT}');
    INSERT INTO devices (id, merchant_id, status, device_type, created_at, updated_at)
      VALUES ('dev_live', 'shop_live', 'ACTIVE', 'SMART_POS', '${AT}', '${AT}');
    INSERT INTO transactions
      (id, merchant_id, device_id, product_type, amount_minor, currency,
       recipient_masked, recipient_hash, state, idempotency_key,
       payload_fingerprint, mode, created_at, updated_at)
      VALUES ('txn_live', 'shop_live', 'dev_live', 'AIRTIME', 2500, 'ETB',
              '09****1234', 'h', 'SUCCESSFUL', 'idem_live', 'fp', 'TRAINING',
              '${AT}', '${AT}');
    INSERT INTO settings (merchant_id, key, value, updated_at)
      VALUES ('shop_live', 'PROFIT_PERCENT_BPS', '400', '${AT}');
    INSERT INTO settings (merchant_id, key, value, updated_at)
      VALUES ('shop_live', 'BUSINESS_NAME', 'Bole Mobile Shop', '${AT}');
  `);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const migrateForward = (): void => {
  runMigrations(db as never, '2026-09-15T00:00:00.000Z' as never, MIGRATIONS as never);
};

describe('a database already carrying training data', () => {
  it('migrates from 022 to 024 without error', () => {
    expect(() => migrateForward()).not.toThrow();
  });

  it('leaves the shop, its device and its sale exactly as they were', () => {
    migrateForward();

    const merchant = db.prepare(`SELECT status FROM merchants WHERE id = 'shop_live'`).get() as {
      status: string;
    };
    expect(merchant.status).toBe('ACTIVE');

    const txn = db.prepare(`SELECT state, amount_minor FROM transactions WHERE id = 'txn_live'`).get() as {
      state: string;
      amount_minor: number;
    };
    expect(txn.state).toBe('SUCCESSFUL');
    expect(txn.amount_minor).toBe(2500);
  });

  it('keeps PROFIT_PERCENT_BPS, because it is history', () => {
    // D165 stops the sale path reading it. It does not delete it: the rows
    // explain what past training sales paid, and section 13 invariant 1 makes
    // the historical record append-only.
    migrateForward();

    const row = db
      .prepare(`SELECT value FROM settings WHERE merchant_id = 'shop_live' AND key = 'PROFIT_PERCENT_BPS'`)
      .get() as { value: string } | undefined;
    expect(row?.value).toBe('400');
  });

  it('keeps the shop’s business name, which the dashboard now shows', () => {
    // D167 replaced the raw merchant id on the dashboard with this value. A
    // migration that lost it would turn every trading shop's home screen blank.
    migrateForward();

    const row = db
      .prepare(`SELECT value FROM settings WHERE merchant_id = 'shop_live' AND key = 'BUSINESS_NAME'`)
      .get() as { value: string } | undefined;
    expect(row?.value).toBe('Bole Mobile Shop');
  });

  it('arrives with the fee configuration seeded and no provider rate invented', () => {
    migrateForward();

    const fees = db.prepare(`SELECT * FROM platform_fee_settings`).all() as Record<string, number>[];
    expect(fees).toHaveLength(1);
    expect(fees[0].shop_share_bps).toBe(7_000);
    expect(fees[0].software_fee_minor).toBe(125_000);

    // Section 30: no provider term may be invented. The table starts empty on
    // a live database exactly as it does on a fresh one.
    const rates = db.prepare(`SELECT COUNT(*) AS n FROM provider_commission_rates`).get() as {
      n: number;
    };
    expect(rates.n).toBe(0);
  });

  it('charges the shop no fee merely by migrating', () => {
    // A migration must not move money. Nothing is owed until a month-end run
    // decides it is.
    migrateForward();

    const charges = db.prepare(`SELECT COUNT(*) AS n FROM software_fee_charges`).get() as {
      n: number;
    };
    expect(charges.n).toBe(0);
  });

  it('is idempotent: running the migrator again changes nothing', () => {
    // Railway restarts run the migrator on every boot. A second pass must be a
    // no-op, not a second seed row or a failure that stops the service.
    migrateForward();
    const before = db.prepare(`SELECT * FROM platform_fee_settings`).get();

    expect(() => migrateForward()).not.toThrow();
    expect(db.prepare(`SELECT * FROM platform_fee_settings`).get()).toEqual(before);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM platform_fee_settings`).get() as { n: number }).n,
    ).toBe(1);
  });

  it('records both migrations as applied', () => {
    migrateForward();
    const applied = (
      db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as {
        version: string;
      }[]
    ).map((r) => r.version);

    for (const migration of FROM_023) {
      expect(applied, `${migration.version} must be recorded`).toContain(migration.version);
    }
  });
});
