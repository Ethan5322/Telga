/**
 * SQLite configuration and migration behaviour.
 *
 * Every PRAGMA is asserted by **reading it back from the engine**, not by
 * trusting that the statement we sent had the effect we wanted.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  appliedMigrations,
  checksumOf,
  MigrationChecksumMismatchError,
  MigrationFailedError,
  MIGRATIONS,
  runMigrations,
  synchronousLevel,
} from '@telga/persistence';
import type { Migration } from '@telga/persistence';
import { at, makeHarness, makeRawHarness } from './helpers';
import type { Harness } from './helpers';

/** Derived from the migration list, so adding a migration cannot break these. */
const ALL_VERSIONS = [...MIGRATIONS].map((m) => m.version).sort((a, b) => a.localeCompare(b));

let harnesses: Harness[] = [];
const fresh = (name?: string): Harness => {
  const h = makeHarness(name);
  harnesses.push(h);
  return h;
};
const raw = (name?: string): Harness => {
  const h = makeRawHarness(name);
  harnesses.push(h);
  return h;
};

afterEach(() => {
  for (const h of harnesses) h.cleanup();
  harnesses = [];
});

describe('PRAGMA configuration', () => {
  it('WAL journal mode is active on a file database', () => {
    const { driver } = fresh('wal');
    expect(driver.pragmas().journalMode.toLowerCase()).toBe('wal');
  });

  it('foreign keys are active', () => {
    const { driver } = fresh('fk');
    expect(driver.pragmas().foreignKeys).toBe(1);
  });

  it('foreign keys are actually enforced, not merely reported on', () => {
    const { driver } = fresh('fk2');
    expect(() =>
      driver.saveDevice({
        id: 'device_orphan',
        // @ts-expect-error deliberately referencing a merchant that does not exist
        merchantId: 'merchant_does_not_exist',
        status: 'ACTIVE',
        deviceType: 'SMART_POS',
        at: at(),
      }),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('busy timeout is set', () => {
    const { driver } = fresh('busy');
    expect(driver.pragmas().busyTimeout).toBe(5000);
  });

  it('synchronous is FULL — this is a ledger, not a cache', () => {
    const { driver } = fresh('sync');
    expect(driver.pragmas().synchronous).toBe(synchronousLevel('FULL'));
  });
});

describe('STRICT tables', () => {
  it('reject text in an integer money column', () => {
    const { driver } = fresh('strict');
    expect(() => {
      driver.unsafeConnection
        .prepare(
          `INSERT INTO ledger_entries (id, posting_id, account_id, account_type, direction,
             amount_minor, currency, entry_type, correlation_id, mode, created_at)
           VALUES ('e1','p1','a1','MERCHANT_AVAILABLE','CREDIT','not-a-number','ETB','FUNDING_CREDIT','c1','TRAINING','t')`,
        )
        .run();
    }).toThrow(/cannot store TEXT value in INTEGER column/i);
  });

  it('reject a float in an integer money column', () => {
    const { driver } = fresh('strict2');
    expect(() => {
      driver.unsafeConnection
        .prepare(
          `INSERT INTO ledger_entries (id, posting_id, account_id, account_type, direction,
             amount_minor, currency, entry_type, correlation_id, mode, created_at)
           VALUES ('e2','p2','a2','MERCHANT_AVAILABLE','CREDIT', 12.5, 'ETB','FUNDING_CREDIT','c1','TRAINING','t')`,
        )
        .run();
    }).toThrow(/cannot store REAL value in INTEGER column/i);
  });

  it('reject an unknown transaction state', () => {
    const { driver } = fresh('strict3');
    expect(() => {
      driver.unsafeConnection
        .prepare(
          `INSERT INTO transactions (id, merchant_id, device_id, product_type, amount_minor, currency,
             recipient_masked, recipient_hash, state, idempotency_key, payload_fingerprint, mode, created_at, updated_at)
           VALUES ('t1','m','d','AIRTIME',100,'ETB','09**00','hash','NOT_A_STATE','k','fp','TRAINING','t','t')`,
        )
        .run();
    }).toThrow(/CHECK constraint failed/i);
  });

  it('reject a live-money row outright', () => {
    const { driver } = fresh('strict4');
    expect(() => {
      driver.unsafeConnection
        .prepare(
          `INSERT INTO merchants (id, status, mode, created_at, updated_at)
           VALUES ('m_live','ACTIVE','LIVE','t','t')`,
        )
        .run();
    }).toThrow(/CHECK constraint failed/i);
  });
});

describe('migrations', () => {
  it('run once and record every migration', () => {
    const { driver } = raw('mig1');
    const result = driver.migrate(at());

    expect(result.applied).toEqual(ALL_VERSIONS);
    expect(result.skipped).toEqual([]);
    expect(driver.appliedMigrations()).toHaveLength(MIGRATIONS.length);
  });

  it('re-running is safe and applies nothing', () => {
    const { driver } = raw('mig2');
    driver.migrate(at());
    const second = driver.migrate(at());

    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(ALL_VERSIONS);
    expect(driver.appliedMigrations()).toHaveLength(MIGRATIONS.length);
  });

  it('records a checksum for each migration', () => {
    const { driver } = raw('mig3');
    driver.migrate(at());
    const rows = driver.appliedMigrations();
    for (const row of rows) {
      const source = MIGRATIONS.find((m) => m.version === row.version);
      expect(source).toBeDefined();
      expect(row.checksum).toBe(checksumOf(source as Migration));
    }
  });

  it('refuses an applied migration whose contents later changed', () => {
    const { driver } = raw('mig4');
    driver.migrate(at());

    const tampered: Migration[] = [
      { version: '001', name: 'initial_schema', sql: 'SELECT 1;' },
    ];
    expect(() => runMigrations(driver.unsafeConnection, at(), tampered)).toThrow(
      MigrationChecksumMismatchError,
    );
  });

  it('rolls a failed migration back whole and does not record it', () => {
    const { driver } = raw('mig5');
    const db = driver.unsafeConnection;

    const broken: Migration[] = [
      {
        version: '900',
        name: 'broken',
        sql: `CREATE TABLE will_not_survive (id TEXT PRIMARY KEY) STRICT;
              THIS IS NOT VALID SQL;`,
      },
    ];

    expect(() => runMigrations(db, at(), broken)).toThrow(MigrationFailedError);

    // Neither the table nor the bookkeeping row survives.
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='will_not_survive'")
      .get();
    expect(table).toBeUndefined();
    expect(appliedMigrations(db).some((row) => row.version === '900')).toBe(false);
  });

  it('applies migrations in version order regardless of array order', () => {
    const { driver } = raw('mig6');
    const shuffled = [...MIGRATIONS].reverse();
    const result = runMigrations(driver.unsafeConnection, at(), shuffled);
    expect(result.applied).toEqual(ALL_VERSIONS);
  });
});

describe('lifecycle', () => {
  it('reports healthy after migration', () => {
    const { driver } = fresh('health');
    const health = driver.health();

    expect(health.healthy).toBe(true);
    expect(health.integrityCheck).toBe('ok');
    expect(health.migrationsApplied).toBe(MIGRATIONS.length);
    expect(health.pragmas.foreignKeys).toBe(1);
  });

  it('closes cleanly and refuses use afterwards', () => {
    const harness = makeHarness('close');
    const { driver } = harness;

    expect(driver.isOpen).toBe(true);
    driver.close();
    expect(driver.isOpen).toBe(false);
    expect(() => driver.readEntries()).toThrow(/closed/i);

    harness.cleanup();
  });

  it('closing twice is safe', () => {
    const harness = makeHarness('close2');
    harness.driver.close();
    expect(() => {
      harness.driver.close();
    }).not.toThrow();
    harness.cleanup();
  });

  it('each suite gets its own database file', () => {
    const a = fresh('iso-a');
    const b = fresh('iso-b');
    expect(a.file).not.toBe(b.file);
  });
});
