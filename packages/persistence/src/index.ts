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
export * as settingsRepo from './repositories/settings';
export type { SettingKey, SettingRow } from './repositories/settings';
export * as shopbookRepo from './repositories/shopbook';
export * as adminRepo from './repositories/admin';
export * as applicationsRepo from './repositories/applications';
export * as extensionsRepo from './repositories/extensions';
export * from './repositories/extensions';
// §20.1 — a shop's own deposit reference, and the lookup that resolves it.
export { ensureDepositReference, findMerchantByDepositReference } from './repositories/merchants';
// §23.1 — the emailed sign-in code. Migration 017 added the columns; these
// are the first functions ever to read or write them.
export { saveAdminOtp, findAdminOtp, countAdminOtpAttempt, clearAdminOtp } from './repositories/admin';
export * as topupOrdersRepo from './repositories/topupOrders';
export * from './repositories/topupOrders';
export {
  recordApplication,
  countRegistrationAttemptsSince,
  recordRegistrationAttempt,
  pruneRegistrationAttempts,
  ApplicationWriteError,
} from './repositories/applications';
export type {
  ApplicationInput,
  ApplicationDocumentInput,
  ApplicationWriteRefusal,
  SubmissionChannel,
} from './repositories/applications';
export {
  clearAdminMfaSecret,
  findAdminSession,
  findAdminUser,
  findAdminUserByEmail,
  grantAdminPermission,
  listActiveAdminSessions,
  listAdminGrants,
  listAdminUsers,
  markAdminMfaSatisfied,
  markAdminSteppedUp,
  normalizeEmail,
  recordAdminLoginFailure,
  recordAdminLoginSuccess,
  revokeAdminPermission,
  revokeAdminSession,
  revokeAllAdminSessions,
  saveAdminSession,
  saveAdminUser,
  setAdminMfaSecret,
  setAdminStatus,
  touchAdminSession,
} from './repositories/admin';
export type { AdminSessionInput, AdminUserInput } from './repositories/admin';
export type {
  AdminPermissionRow,
  AdminSessionRow,
  AdminUserRow,
  MerchantApplicationRow,
  TenantRegistryRow,
} from './schema/types';

export type { CustomerInput, ShiftInput } from './repositories/shopbook';
export { maskRecipient, hashRecipient, assertSafeMetadata, serializeMetadata } from './privacy';
