/**
 * Restore: verify, copy into isolation, verify again, apply the documented
 * session and claim policy. Never touches the original backup file, never
 * starts a worker, never calls a provider, never opens the live database
 * path directly.
 *
 * ## Session policy
 *
 * Every session in the restored copy is revoked, unconditionally. A session
 * from a backup predates the restore point by definition, and this
 * repository never keeps a live-looking credential whose real validity is
 * unknown — see `Backup and Restore Runbook.md`. Operators sign in again.
 * This is a decision, not an oversight: the alternative (leaving sessions
 * live) would let a stale session outlive an explicit revocation that may
 * have happened after the backup was taken.
 *
 * ## Claim policy
 *
 * Every recovery claim in the restored copy is released, unconditionally.
 * The claim-lease mechanism (A37/R16) is already safe by construction — an
 * expired lease is simply reclaimable — but a restored copy has no worker
 * that legitimately holds any lease against it, so leaving claims "active"
 * from the backup's perspective is stale bookkeeping, not protection. The
 * next real sweep re-claims cleanly rather than waiting out a lease that
 * means nothing in the restored copy's own timeline.
 */

import { copyFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { MIGRATIONS, SqliteLedgerDriver } from '@telga/persistence';
import { LiveModeRefusedError } from './errors';
import type { BackupManifest, BackupRowCounts } from './manifest';
import { ChecksumMismatchError, ManifestMissingError, SchemaMismatchError, sha256OfFile } from './manifest';
import type { BackupRestoreConfig } from './paths';
import { assertAllowedPath } from './paths';

export class BackupNotFoundError extends Error {
  constructor(path: string) {
    super(`No backup found at "${path}".`);
    this.name = 'BackupNotFoundError';
  }
}

export class TargetExistsError extends Error {
  constructor(path: string) {
    super(`"${path}" already exists. Restore never overwrites an existing target by default.`);
    this.name = 'TargetExistsError';
  }
}

export class DatabaseIntegrityError extends Error {
  constructor(detail: string) {
    super(`Restored database failed integrity verification: ${detail}`);
    this.name = 'DatabaseIntegrityError';
  }
}

export class NonZeroResidualError extends Error {
  constructor(residual: number) {
    super(`Restored database has a non-zero ledger residual (${String(residual)}). Refusing to trust it.`);
    this.name = 'NonZeroResidualError';
  }
}

export class AppendOnlyProtectionMissingError extends Error {
  constructor() {
    super('The restored database accepted a mutation to ledger_entries. Its append-only triggers are missing.');
    this.name = 'AppendOnlyProtectionMissingError';
  }
}

export class RowCountMismatchError extends Error {
  readonly table: string;

  constructor(table: string, expected: number, actual: number) {
    super(`Row count mismatch in "${table}": manifest says ${String(expected)}, restored copy has ${String(actual)}.`);
    this.name = 'RowCountMismatchError';
    this.table = table;
  }
}

export interface RestoreOptions {
  readonly mode: string;
  readonly backupPath: string;
  readonly targetPath: string;
  readonly allowExistingTarget?: boolean;
  readonly config: BackupRestoreConfig;
}

export interface RestoreReport {
  readonly targetPath: string;
  readonly schemaVersion: string;
  readonly ledgerResidualMinor: number;
  readonly checksumSha256: string;
  readonly rowCounts: BackupRowCounts;
  readonly sessionsRevoked: number;
  readonly claimsReleased: number;
  readonly integrityCheck: string;
  readonly appendOnlyVerified: boolean;
}

function countRows(driver: SqliteLedgerDriver): BackupRowCounts {
  // Same defensive read as `backup.ts`'s `countRows` — kept honest for a
  // restored copy whose source predates the running code's latest migration.
  const count = (table: string): number => {
    try {
      const row = driver.unsafeConnection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      return row.n;
    } catch {
      return 0;
    }
  };
  return {
    merchants: count('merchants'),
    transactions: count('transactions'),
    ledgerEntries: count('ledger_entries'),
    recoveryClaims: count('recovery_claims'),
    pendingResolutions: count('pending_resolutions'),
    supportCases: count('support_cases'),
    auditEvents: count('audit_events'),
    merchantUsers: count('merchant_users'),
    deviceEnrollments: count('device_enrollments'),
    sessions: count('sessions'),
  };
}

function loadManifest(backupPath: string): BackupManifest {
  const manifestPath = `${backupPath}.manifest.json`;
  if (!existsSync(manifestPath)) {
    throw new ManifestMissingError(backupPath);
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest;
}

/** Confirms the append-only triggers are active without leaving a trace: the attempt itself must throw. */
function verifyAppendOnly(driver: SqliteLedgerDriver): void {
  const row = driver.unsafeConnection.prepare('SELECT id FROM ledger_entries LIMIT 1').get() as
    | { id: string }
    | undefined;
  if (row === undefined) return; // nothing to verify against; not a failure

  let refused = false;
  try {
    driver.unsafeConnection.exec(`UPDATE ledger_entries SET amount_minor = amount_minor WHERE id = '${row.id}'`);
  } catch {
    refused = true;
  }
  if (!refused) {
    throw new AppendOnlyProtectionMissingError();
  }
}

/**
 * Run a restore into an isolated target.
 *
 * Checksum verification happens against the **backup file itself**, before
 * anything is copied — a corrupt backup never produces even a partial
 * target file. Every failure after the copy removes the target it created,
 * so a failed restore leaves nothing half-built behind.
 */
export async function runRestore(options: RestoreOptions): Promise<RestoreReport> {
  if (options.mode !== 'TRAINING') {
    throw new LiveModeRefusedError('restore');
  }

  const backupPath = assertAllowedPath(options.backupPath, options.config);
  const targetPath = assertAllowedPath(options.targetPath, options.config);

  if (!existsSync(backupPath)) {
    throw new BackupNotFoundError(options.backupPath);
  }

  const manifest = loadManifest(backupPath);

  const actualChecksum = await sha256OfFile(backupPath);
  if (actualChecksum !== manifest.checksumSha256) {
    throw new ChecksumMismatchError();
  }

  if (existsSync(targetPath) && options.allowExistingTarget !== true) {
    throw new TargetExistsError(options.targetPath);
  }

  copyFileSync(backupPath, targetPath);

  try {
    // Opened directly, never `createSqliteDriver` — restore verifies the
    // schema that is there; it does not silently upgrade it.
    const driver = new SqliteLedgerDriver({ file: targetPath });
    try {
      // Migrations are checked before anything that touches `ledger_entries`
      // — `driver.health()` computes the ledger residual internally, which
      // throws a raw SQLite error on a table that does not exist yet. A
      // missing migration must be reported as `SchemaMismatchError`, not as
      // an opaque "no such table".
      const applied = new Set(driver.appliedMigrations().map((m) => m.version));
      const missing = MIGRATIONS.filter((m) => !applied.has(m.version)).map((m) => m.version);
      if (missing.length > 0) {
        throw new SchemaMismatchError(missing);
      }

      // Checked directly, not via `health.healthy` — that flag also folds in
      // the ledger residual, which gets its own, more specific error below.
      const health = driver.health();
      if (health.integrityCheck !== 'ok') {
        throw new DatabaseIntegrityError(`integrity_check=${health.integrityCheck}`);
      }
      if (health.pragmas.foreignKeys !== 1) {
        throw new DatabaseIntegrityError('foreign_keys pragma is not enabled');
      }

      verifyAppendOnly(driver);

      const residual = driver.ledgerResidualMinor();
      if (residual !== 0) {
        throw new NonZeroResidualError(residual);
      }

      const rowCounts = countRows(driver);
      for (const [table, expected] of Object.entries(manifest.rowCounts) as [
        keyof BackupRowCounts,
        number,
      ][]) {
        const actual = rowCounts[table];
        if (actual !== expected) {
          throw new RowCountMismatchError(table, expected, actual);
        }
      }

      const now = new Date().toISOString();
      const sessionsRevoked = driver.unsafeConnection
        .prepare(
          `UPDATE sessions SET status = 'REVOKED', revoked_at = ?, revocation_reason = 'RESTORED_FROM_BACKUP'
           WHERE status = 'ACTIVE'`,
        )
        .run(now).changes;

      const claimsReleased = driver.unsafeConnection
        .prepare(
          `UPDATE recovery_claims SET status = 'RELEASED', released_at = ?, updated_at = ?
           WHERE status = 'ACTIVE'`,
        )
        .run(now, now).changes;

      return {
        targetPath,
        schemaVersion: driver.appliedMigrations().at(-1)?.version ?? '(none)',
        ledgerResidualMinor: residual,
        checksumSha256: actualChecksum,
        rowCounts,
        sessionsRevoked: Number(sessionsRevoked),
        claimsReleased: Number(claimsReleased),
        integrityCheck: health.integrityCheck,
        appendOnlyVerified: true,
      };
    } finally {
      driver.close();
    }
  } catch (error) {
    // No partial or failed target is left behind.
    try {
      rmSync(targetPath, { force: true });
      rmSync(`${targetPath}-wal`, { force: true });
      rmSync(`${targetPath}-shm`, { force: true });
    } catch {
      // Best-effort cleanup; the original error is what matters.
    }
    throw error;
  }
}

/** Size on disk, for a report or a log line — never the file's contents. */
export const sizeOf = (path: string): number => statSync(path).size;
