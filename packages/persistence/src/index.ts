/**
 * @telga/persistence — SQLite behind a driver interface.
 *
 * TRAINING MODE — NO REAL VALUE. The schema constrains `mode` to `'TRAINING'`
 * on merchants, transactions and ledger entries, so live-money rows cannot be
 * stored even by direct SQL.
 *
 * The ledger is append-only in two independent places: this package offers no
 * update or delete, and migration 002 installs database triggers that abort
 * both.
 */

export type * from './schema/types';
export { MERCHANT_FACING_ACCOUNTS } from './schema/types';
export type * from './driver/types';
export * from './driver/errors';
export * from './migrations/index';
export { SqliteLedgerDriver, createSqliteDriver } from './sqlite/driver';
export {
  openDatabase,
  readPragmas,
  closeDatabase,
  integrityCheck,
  synchronousLevel,
  DEFAULT_BUSY_TIMEOUT_MS,
  DEFAULT_SYNCHRONOUS,
} from './sqlite/connection';
export type { Db } from './sqlite/connection';
export {
  runMigrations,
  appliedMigrations,
  checksumOf,
  ensureMigrationTable,
  assertMigrationsApplied,
  MigrationsNotAppliedError,
} from './sqlite/migrator';
export * from './operations';
export * as recoveryRepo from './repositories/recovery';
export * as identityRepo from './repositories/identity';
export { maskRecipient, hashRecipient, assertSafeMetadata, serializeMetadata } from './privacy';
