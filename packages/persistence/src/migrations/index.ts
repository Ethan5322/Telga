/**
 * Ordered migration list.
 *
 * Migrations are **immutable once applied**: the migrator stores a checksum of
 * each one, and editing an applied migration is refused rather than silently
 * re-run. To change the schema, add a new migration.
 *
 * There is no `down`. Production rollback is **forward-fix only** — see
 * `docs/obsidian/09 Engineering/Migration Strategy.md`. A ledger cannot be
 * un-migrated without risking history, so the rollback that exists is the
 * per-migration transaction: a migration that throws is rolled back whole and
 * never recorded as applied.
 */

import { m001InitialSchema } from './001_initial_schema';
import { m002LedgerAppendOnly } from './002_ledger_append_only';
import { m003AuditAppendOnly } from './003_audit_append_only';
import { m004PendingAndSupport } from './004_pending_and_support';
import { m005RecoveryClaims } from './005_recovery_claims';
import { m006AuthAndDevices } from './006_auth_and_devices';

export interface Migration {
  /** Sort key. Zero-padded so lexical order is execution order. */
  readonly version: string;
  readonly name: string;
  /** Executed inside a single database transaction. */
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  m001InitialSchema,
  m002LedgerAppendOnly,
  m003AuditAppendOnly,
  m004PendingAndSupport,
  m005RecoveryClaims,
  m006AuthAndDevices,
]);

export {
  m001InitialSchema,
  m002LedgerAppendOnly,
  m003AuditAppendOnly,
  m004PendingAndSupport,
  m005RecoveryClaims,
  m006AuthAndDevices,
};
