/** Persistence-layer errors. Distinct from domain errors — these are storage faults. */

export type PersistenceErrorCode =
  | 'MIGRATION_FAILED'
  | 'MIGRATION_CHECKSUM_MISMATCH'
  | 'LEDGER_APPEND_ONLY_VIOLATION'
  | 'DUPLICATE_IDEMPOTENCY_RECORD'
  | 'MERCHANT_SCOPE_VIOLATION'
  | 'ACCOUNT_NOT_FOUND'
  | 'DRIVER_CLOSED'
  | 'UNSUPPORTED_MODE';

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(code: PersistenceErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = new.target.name;
  }
}

export class MigrationFailedError extends PersistenceError {
  readonly version: string;

  constructor(version: string, cause: string) {
    super('MIGRATION_FAILED', `Migration ${version} failed and was rolled back: ${cause}`);
    this.version = version;
  }
}

export class MigrationChecksumMismatchError extends PersistenceError {
  constructor(version: string) {
    super(
      'MIGRATION_CHECKSUM_MISMATCH',
      `Migration ${version} has already been applied but its contents have changed. Migrations are immutable once applied; add a new migration instead.`,
    );
  }
}

export class LedgerAppendOnlyViolationError extends PersistenceError {
  constructor(operation: string) {
    super(
      'LEDGER_APPEND_ONLY_VIOLATION',
      `${operation} on ledger_entries is forbidden. Post an ADJUSTMENT entry instead.`,
    );
  }
}

export class DuplicateIdempotencyRecordError extends PersistenceError {
  constructor(key: string) {
    super('DUPLICATE_IDEMPOTENCY_RECORD', `An idempotency record already exists for key ${key}`);
  }
}

export class MerchantScopeViolationError extends PersistenceError {
  constructor(message: string) {
    super('MERCHANT_SCOPE_VIOLATION', message);
  }
}

export class AccountNotFoundError extends PersistenceError {
  constructor(message: string) {
    super('ACCOUNT_NOT_FOUND', message);
  }
}

export class DriverClosedError extends PersistenceError {
  constructor() {
    super('DRIVER_CLOSED', 'The database driver has been closed');
  }
}
