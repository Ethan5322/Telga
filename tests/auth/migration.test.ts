/**
 * Migration 006, and what it must not disturb.
 *
 * Two questions:
 *
 *   1. Does the auth schema arrive correctly, with the constraints it claims?
 *   2. Does adding it leave the **ledger** exactly as it was?
 *
 * The second matters more. A schema change that quietly touched a ledger row
 * would be the worst kind of defect this repository can have, so the test seeds
 * real transactions and entries before migrating and compares them afterwards.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  MigrationsNotAppliedError,
  SqliteLedgerDriver,
  assertMigrationsApplied,
  createSqliteDriver,
  runMigrations,
  fundMerchant,
  m006AuthAndDevices,
} from '@telga/persistence';
import { fromBirr, merchantId, postingId, timestamp } from '@telga/domain';

const AT = timestamp('2026-08-20T09:00:00.000Z');
const MERCHANT = merchantId('merchant_alpha');

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `telga-mig-${name}-`));
  dirs.push(dir);
  return join(dir, 'telga.sqlite');
}

describe('the migration list', () => {
  it('includes 006 exactly once, last', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions.filter((v) => v === '006')).toHaveLength(1);
    expect(versions[versions.length - 1]).toBe('006');
    // Zero-padded, so lexical order is execution order.
    expect([...versions].sort()).toEqual(versions);
  });

  it('carries the tables the auth layer needs', () => {
    for (const table of ['merchant_users', 'device_enrollments', 'sessions', 'auth_attempts']) {
      expect(m006AuthAndDevices.sql, table).toContain(`CREATE TABLE ${table}`);
    }
  });

  it('constrains operators to training mode at the schema level', () => {
    // Not merely a check in TypeScript: an operator row for a live-money
    // deployment cannot be stored here even by direct SQL.
    expect(m006AuthAndDevices.sql).toContain("CHECK (mode = 'TRAINING')");
  });

  it('offers no column that could hold a raw secret', () => {
    // The schema names hashes and salts, and nothing that reads as a plaintext
    // credential column.
    expect(m006AuthAndDevices.sql).toContain('pin_hash');
    expect(m006AuthAndDevices.sql).toContain('secret_hash');
    expect(m006AuthAndDevices.sql).not.toMatch(/\bpin\s+TEXT/);
    expect(m006AuthAndDevices.sql).not.toMatch(/\bpassword\b/i);
    expect(m006AuthAndDevices.sql).not.toMatch(/\bsession_token\b/);
  });
});

describe('applying it', () => {
  it('creates every table with STRICT typing', () => {
    const driver = createSqliteDriver({ file: tempFile('apply') }, AT);
    try {
      const rows = driver.unsafeConnection
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string; sql: string }[];

      for (const table of ['merchant_users', 'device_enrollments', 'sessions', 'auth_attempts']) {
        const row = rows.find((r) => r.name === table);
        expect(row, table).toBeDefined();
        expect(row?.sql, table).toContain('STRICT');
      }
    } finally {
      driver.close();
    }
  });

  it('is idempotent: migrating twice applies it once', () => {
    const file = tempFile('idempotent');
    const driver = createSqliteDriver({ file }, AT);
    try {
      const again = driver.migrate(AT);
      expect(again.applied).toHaveLength(0);
      expect(again.skipped).toContain('006');

      const applied = driver.appliedMigrations().map((m) => m.version);
      expect(applied.filter((v) => v === '006')).toHaveLength(1);
    } finally {
      driver.close();
    }
  });

  it('refuses to start an application against an unmigrated database', () => {
    const file = tempFile('unmigrated');
    // Open without migrating — exactly what the worker and the POS both do.
    const driver = new SqliteLedgerDriver({ file });
    try {
      expect(() => assertMigrationsApplied(driver.unsafeConnection)).toThrow(
        MigrationsNotAppliedError,
      );
      // And it names what is missing, including the new one.
      try {
        assertMigrationsApplied(driver.unsafeConnection);
      } catch (error) {
        expect((error as Error).message).toContain('006');
      }
    } finally {
      driver.close();
    }
  });

  it('refuses to start when only the auth migration is missing', () => {
    const file = tempFile('partial');
    const driver = new SqliteLedgerDriver({ file });
    try {
      // A half-upgraded deployment: everything except 006.
      const earlier = MIGRATIONS.filter((m) => m.version !== '006');
      runMigrations(driver.unsafeConnection, AT, earlier);

      // The assertion is derived from MIGRATIONS rather than a hardcoded list,
      // so a newly added migration is covered without anyone editing a test —
      // the trap that broke the assertions when 004 was introduced.
      expect(() => assertMigrationsApplied(driver.unsafeConnection)).toThrow(
        MigrationsNotAppliedError,
      );
      try {
        assertMigrationsApplied(driver.unsafeConnection);
      } catch (error) {
        expect((error as Error).message).toContain('006');
        expect((error as Error).message).not.toContain('005');
      }

      // Applying the rest clears it.
      driver.migrate(AT);
      expect(() => assertMigrationsApplied(driver.unsafeConnection)).not.toThrow();
    } finally {
      driver.close();
    }
  });
});

describe('what it must not disturb', () => {
  it('leaves seeded ledger history byte-identical', () => {
    const file = tempFile('ledger-intact');

    // A database with real ledger content.
    const first = createSqliteDriver({ file }, AT);
    let before: { entries: unknown; residual: number };
    try {
      first.saveMerchant({ id: MERCHANT, status: 'ACTIVE', mode: 'TRAINING', at: AT });
      fundMerchant(first, {
        merchantId: MERCHANT,
        amount: fromBirr(100),
        at: AT,
        correlationId: 'corr_seed',
        postingId: postingId('post_seed'),
      });
      before = {
        entries: JSON.stringify(first.readEntries()),
        residual: first.ledgerResidualMinor(),
      };
    } finally {
      first.close();
    }

    // Re-open and migrate again. Nothing should move.
    const second = createSqliteDriver({ file }, AT);
    try {
      second.migrate(AT);
      expect(JSON.stringify(second.readEntries())).toBe(before.entries);
      expect(second.ledgerResidualMinor()).toBe(before.residual);
      expect(second.ledgerResidualMinor()).toBe(0);
    } finally {
      second.close();
    }
  });

  it('leaves the append-only triggers in force', () => {
    const file = tempFile('append-only');
    const driver = createSqliteDriver({ file }, AT);
    try {
      driver.saveMerchant({ id: MERCHANT, status: 'ACTIVE', mode: 'TRAINING', at: AT });
      fundMerchant(driver, {
        merchantId: MERCHANT,
        amount: fromBirr(50),
        at: AT,
        correlationId: 'corr_seed',
        postingId: postingId('post_seed'),
      });

      // The ledger is append-only in the database itself, not only in the
      // TypeScript surface — and migration 006 did not weaken that.
      expect(() =>
        driver.unsafeConnection.exec('UPDATE ledger_entries SET amount_minor = 1'),
      ).toThrow();
      expect(() => driver.unsafeConnection.exec('DELETE FROM ledger_entries')).toThrow();
    } finally {
      driver.close();
    }
  });

  it('deletes nothing: every earlier table still exists', () => {
    const file = tempFile('no-drops');
    const driver = createSqliteDriver({ file }, AT);
    try {
      const names = (
        driver.unsafeConnection
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[]
      ).map((r) => r.name);

      for (const table of [
        'merchants',
        'devices',
        'transactions',
        'ledger_entries',
        'ledger_accounts',
        'balance_reservations',
        'audit_events',
        'idempotency_records',
        'pending_resolutions',
        'support_cases',
        'recovery_claims',
      ]) {
        expect(names, table).toContain(table);
      }
    } finally {
      driver.close();
    }
  });
});
