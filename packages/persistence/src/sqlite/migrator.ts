/**
 * Migration runner.
 *
 * Properties this provides, each of which has a test:
 *   - ordered execution by version
 *   - already-applied migrations are skipped, so re-running is safe
 *   - each migration runs inside a transaction, so a failure rolls back whole
 *     and is never recorded as applied
 *   - a checksum detects an applied migration whose contents later changed
 *
 * There is no `down`. Production rollback is forward-fix only — see
 * `docs/obsidian/09 Engineering/Migration Strategy.md`.
 */

import { createHash } from 'node:crypto';
import type { Db } from './connection';
import type { Migration } from '../migrations/index';
import { MIGRATIONS } from '../migrations/index';
import type { MigrationResult } from '../driver/types';
import type { MigrationRow } from '../schema/types';
import { MigrationChecksumMismatchError, MigrationFailedError, PersistenceError } from '../driver/errors';

const MIGRATION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  checksum   TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;
`;

export const checksumOf = (migration: Migration): string =>
  createHash('sha256').update(`${migration.version}:${migration.name}:${migration.sql}`).digest('hex');

export function ensureMigrationTable(db: Db): void {
  db.exec(MIGRATION_TABLE);
}

export function appliedMigrations(db: Db): readonly MigrationRow[] {
  ensureMigrationTable(db);
  return db
    .prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version')
    .all() as MigrationRow[];
}

/**
 * Apply every migration not yet applied.
 *
 * `now` is injected rather than read from the clock, so a test can produce a
 * byte-identical database.
 */
export function runMigrations(
  db: Db,
  now: string,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationResult {
  ensureMigrationTable(db);

  const existing = new Map(appliedMigrations(db).map((row) => [row.version, row]));
  const applied: string[] = [];
  const skipped: string[] = [];

  const ordered = [...migrations].sort((a, b) => a.version.localeCompare(b.version));

  for (const migration of ordered) {
    const checksum = checksumOf(migration);
    const already = existing.get(migration.version);

    if (already) {
      if (already.checksum !== checksum) {
        throw new MigrationChecksumMismatchError(migration.version);
      }
      skipped.push(migration.version);
      continue;
    }

    // Each migration is its own unit of work: a throw rolls back the DDL *and*
    // the bookkeeping row together, so a half-applied migration cannot exist.
    const run = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
      ).run(migration.version, migration.name, checksum, now);
    });

    try {
      run();
    } catch (error) {
      throw new MigrationFailedError(migration.version, error instanceof Error ? error.message : String(error));
    }

    applied.push(migration.version);
  }

  return Object.freeze({
    applied: Object.freeze(applied),
    skipped: Object.freeze(skipped),
    total: ordered.length,
  });
}

/**
 * Throw unless every known migration has been applied.
 *
 * Migration ownership is a **single-writer startup procedure**: one process
 * applies migrations, and every other process refuses to start until they are
 * done. A worker that migrated on its own would be exactly the untested
 * concurrent-migration case recorded as assumption A30.
 *
 * See `09 Engineering/Migration Ownership.md`.
 */
export function assertMigrationsApplied(db: Db, migrations: readonly Migration[] = MIGRATIONS): void {
  const applied = new Set(appliedMigrations(db).map((row) => row.version));
  const missing = migrations.filter((m) => !applied.has(m.version)).map((m) => m.version);

  if (missing.length > 0) {
    throw new MigrationsNotAppliedError(missing);
  }
}

export class MigrationsNotAppliedError extends PersistenceError {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      'MIGRATION_FAILED',
      `Refusing to start: migrations not applied (${missing.join(', ')}). Migrations run through a single-writer startup procedure; this process must not apply them itself.`,
    );
    this.name = 'MigrationsNotAppliedError';
    this.missing = missing;
  }
}
