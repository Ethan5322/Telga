/**
 * Migration 013 — provider attempts and provider health.
 *
 * Both tables are new, so unlike 008–012 there is no table rebuild here and no
 * chance of dropping a row by mistyping a column list. What these tests check
 * instead is that the **constraints actually bite**, because the two that
 * matter are the ones that turn a silent data problem into a write failure:
 *
 *   - `UNIQUE (transaction_id, attempt_no)` — the attempt sequence cannot fork
 *     into two rows both claiming to be try number 2, which is the shape a
 *     duplicate-vending bug would take in the record;
 *   - `outcome` allows `NULL` — "we asked and never heard back" is a state
 *     CLAUDE.md §15 requires, not missing data.
 *
 * And that nothing existing was touched: this migration must not be able to
 * disturb the ledger.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '@telga/persistence';

let dir: string;
let file: string;
/**
 * Every connection opened by a test, closed before the directory is removed.
 *
 * Windows refuses to delete a file another handle still holds, so a test that
 * throws before its own `db.close()` used to fail twice — once for the real
 * reason and once with `EPERM` from the cleanup, which buries the first.
 */
let open: Database.Database[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'telga-m013-'));
  file = join(dir, 'telga.sqlite');
  open = [];
});

afterEach(() => {
  for (const db of open) {
    try {
      db.close();
    } catch {
      // Already closed by the test itself. Nothing to do.
    }
  }
  open = [];
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A database migrated up to `upTo`.
 *
 * `at` names the file, so a test can build two databases at different
 * migration levels and compare them. Reusing one file would re-run migrations
 * over an already-migrated database, which fails on the first `CREATE TABLE`.
 */
function migrate(upTo = '013', at = file): Database.Database {
  const db = new Database(at);
  open.push(db);
  db.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS) {
    if (migration.version > upTo) break;
    db.exec(`BEGIN; ${migration.sql} COMMIT;`);
  }
  return db;
}

const AT = '2026-08-29T08:00:00.000Z';

/** A merchant, a device and one transaction for the attempts to hang off. */
function seed(db: Database.Database): void {
  db.exec(`
    INSERT INTO merchants (id, status, mode, created_at, updated_at)
      VALUES ('merchant_alpha', 'ACTIVE', 'TRAINING', '${AT}', '${AT}');
    INSERT INTO devices (id, merchant_id, status, device_type, created_at, updated_at)
      VALUES ('device_alpha', 'merchant_alpha', 'ACTIVE', 'SMART_POS', '${AT}', '${AT}');
  `);

  // The columns this fixture actually cares about. Everything else required by
  // the schema is filled in below from `pragma_table_info`, so a later
  // migration that adds a NOT NULL column does not break this file — the point
  // here is migration 013, not the shape of `transactions`.
  const chosen: Record<string, string | number> = {
    id: 'txn_alpha',
    merchant_id: 'merchant_alpha',
    device_id: 'device_alpha',
    state: 'PENDING',
    product_type: 'NETWORK_A_AIRTIME',
    amount_minor: 2500,
    currency: 'ETB',
    recipient_masked: '09** *** 123',
    idempotency_key: 'idem_alpha',
    correlation_id: 'corr_alpha',
    created_at: AT,
    updated_at: AT,
    mode: 'TRAINING',
  };

  const columns = db
    .prepare(`SELECT name, type, "notnull" AS required, dflt_value AS fallback FROM pragma_table_info('transactions')`)
    .all() as { name: string; type: string; required: number; fallback: string | null }[];

  const values: Record<string, string | number> = {};
  for (const column of columns) {
    if (column.name in chosen) {
      values[column.name] = chosen[column.name];
      continue;
    }
    // Only fill what the schema insists on and has no default for.
    if (column.required !== 1 || column.fallback !== null) continue;
    values[column.name] = column.type === 'INTEGER' || column.type === 'REAL' ? 0 : 'fixture';
  }

  const used = Object.keys(values);
  db.prepare(
    `INSERT INTO transactions (${used.join(', ')}) VALUES (${used.map(() => '?').join(', ')})`,
  ).run(...used.map((k) => values[k]));
}

describe('the migration applies', () => {
  it('creates both tables', () => {
    const db = migrate();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('transaction_attempts');
    expect(names).toContain('provider_health_events');
    db.close();
  });

  it('leaves the ledger and its append-only triggers alone', () => {
    // This migration must not be able to disturb history. If it ever rebuilt a
    // table it should not, the triggers would be the first thing lost.
    const db = migrate();
    const triggers = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)
      .all() as { name: string }[];
    expect(triggers.length).toBeGreaterThan(0);

    // A second, separate database — migrating the first one again would
    // re-run 001 over tables that already exist.
    const before = migrate('012', join(dir, 'before.sqlite'));
    const ledgerBefore = before
      .prepare(`SELECT sql FROM sqlite_master WHERE name = 'ledger_entries'`)
      .get() as { sql: string } | undefined;
    before.close();
    const ledgerAfter = db
      .prepare(`SELECT sql FROM sqlite_master WHERE name = 'ledger_entries'`)
      .get() as { sql: string } | undefined;
    expect(ledgerAfter?.sql).toBe(ledgerBefore?.sql);
    db.close();
  });
});

describe('transaction_attempts', () => {
  it('records an attempt that is still in flight', () => {
    // A NULL outcome and a NULL finish are the "asked, no answer" state.
    const db = migrate();
    seed(db);
    db.prepare(
      `INSERT INTO transaction_attempts
         (id, transaction_id, attempt_no, started_at, provider_id, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('att_1', 'txn_alpha', 1, AT, 'provider_mock', 'corr_alpha');

    const row = db
      .prepare(`SELECT outcome, finished_at FROM transaction_attempts WHERE id = 'att_1'`)
      .get() as { outcome: string | null; finished_at: string | null };
    expect(row.outcome).toBeNull();
    expect(row.finished_at).toBeNull();
    db.close();
  });

  it('refuses a second row claiming the same attempt number', () => {
    // The constraint that turns a forked sequence into a write failure.
    const db = migrate();
    seed(db);
    const insert = db.prepare(
      `INSERT INTO transaction_attempts
         (id, transaction_id, attempt_no, started_at, provider_id, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run('att_1', 'txn_alpha', 1, AT, 'provider_mock', 'corr_alpha');
    expect(() => insert.run('att_2', 'txn_alpha', 1, AT, 'provider_mock', 'corr_alpha')).toThrow(
      /UNIQUE/i,
    );
    db.close();
  });

  it('allows a genuine second try on the same transaction', () => {
    // §30 requires an uncertain retry to reuse the same transaction, so several
    // attempts under one transaction id is the normal case, not an anomaly.
    const db = migrate();
    seed(db);
    const insert = db.prepare(
      `INSERT INTO transaction_attempts
         (id, transaction_id, attempt_no, started_at, provider_id, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run('att_1', 'txn_alpha', 1, AT, 'provider_mock', 'corr_alpha');
    insert.run('att_2', 'txn_alpha', 2, AT, 'provider_mock', 'corr_alpha');
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM transaction_attempts WHERE transaction_id = 'txn_alpha'`)
      .get() as { n: number };
    expect(count.n).toBe(2);
    db.close();
  });

  it('refuses an outcome outside the named set', () => {
    const db = migrate();
    seed(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO transaction_attempts
             (id, transaction_id, attempt_no, started_at, provider_id, correlation_id, outcome)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('att_bad', 'txn_alpha', 1, AT, 'provider_mock', 'corr_alpha', 'PROBABLY_FINE'),
    ).toThrow(/CHECK/i);
    db.close();
  });

  it('refuses an attempt against a transaction that does not exist', () => {
    const db = migrate();
    seed(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO transaction_attempts
             (id, transaction_id, attempt_no, started_at, provider_id, correlation_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('att_orphan', 'txn_missing', 1, AT, 'provider_mock', 'corr_alpha'),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });
});

describe('provider_health_events', () => {
  it('records a transition with the status it came from', () => {
    const db = migrate();
    db.prepare(
      `INSERT INTO provider_health_events (id, provider_id, at, status, previous_status)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('phe_1', 'provider_mock', AT, 'UNAVAILABLE', 'HEALTHY');

    const row = db
      .prepare(`SELECT status, previous_status FROM provider_health_events WHERE id = 'phe_1'`)
      .get() as { status: string; previous_status: string | null };
    expect(row.status).toBe('UNAVAILABLE');
    expect(row.previous_status).toBe('HEALTHY');
    db.close();
  });

  it('allows a first-ever observation with nothing before it', () => {
    const db = migrate();
    db.prepare(
      `INSERT INTO provider_health_events (id, provider_id, at, status, previous_status)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('phe_first', 'provider_mock', AT, 'HEALTHY', null);
    const row = db
      .prepare(`SELECT previous_status FROM provider_health_events WHERE id = 'phe_first'`)
      .get() as { previous_status: string | null };
    expect(row.previous_status).toBeNull();
    db.close();
  });

  it('refuses a status it does not recognise', () => {
    const db = migrate();
    expect(() =>
      db
        .prepare(
          `INSERT INTO provider_health_events (id, provider_id, at, status) VALUES (?, ?, ?, ?)`,
        )
        .run('phe_bad', 'provider_mock', AT, 'PROBABLY_UP'),
    ).toThrow(/CHECK/i);
    db.close();
  });

  it('is not scoped to a merchant', () => {
    // §16: an outage is a platform fact and there is no merchant override. A
    // merchant column here would be the first step toward one.
    const db = migrate();
    const columns = db
      .prepare(`SELECT name FROM pragma_table_info('provider_health_events')`)
      .all() as { name: string }[];
    expect(columns.map((c) => c.name)).not.toContain('merchant_id');
    db.close();
  });
});
