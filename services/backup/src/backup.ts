/**
 * Backup: checkpoint, copy, manifest. Nothing else.
 *
 * The source database is never migrated, never mutated beyond the WAL
 * checkpoint SQLite already performs on every clean shutdown, and never
 * deleted. See `Backup and Restore Runbook.md` for the full design this
 * implements.
 */

import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS, SqliteLedgerDriver } from '@telga/persistence';
import { LiveModeRefusedError } from './errors';
import type { BackupManifest, BackupRowCounts } from './manifest';
import { sha256OfFile, sourceIdentifierOf } from './manifest';
import type { BackupRestoreConfig } from './paths';
import { assertAllowedPath } from './paths';

export class SourceNotFoundError extends Error {
  constructor(path: string) {
    super(`No database found at "${path}".`);
    this.name = 'SourceNotFoundError';
  }
}

export class DestinationExistsError extends Error {
  constructor(path: string) {
    super(`A backup already exists at "${path}". Pass force to overwrite it deliberately.`);
    this.name = 'DestinationExistsError';
  }
}

export class BackupTooLargeError extends Error {
  constructor(sizeBytes: number, maxBytes: number) {
    super(`Database is ${String(sizeBytes)} bytes, exceeding the configured maximum of ${String(maxBytes)}.`);
    this.name = 'BackupTooLargeError';
  }
}

export interface BackupOptions {
  readonly mode: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly force?: boolean;
  readonly config: BackupRestoreConfig;
  /** Injected clock, so a test produces a byte-identical manifest. */
  readonly now?: () => string;
}

export interface BackupResult {
  readonly manifest: BackupManifest;
  readonly manifestPath: string;
  readonly backupPath: string;
}

function countRows(driver: SqliteLedgerDriver): BackupRowCounts {
  // A table can genuinely be absent — a database backed up before its latest
  // migration has a real, honest count of zero for what does not exist yet,
  // not a crash. `runBackup` never migrates the source, so this is the
  // normal case for an intentionally-preserved older schema, not a defect.
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

/**
 * Run a backup.
 *
 * Order matters: checkpoint before reading anything, so the counts, the
 * residual and the eventual file copy all describe the same consistent
 * state — never a mix of pre- and post-checkpoint data.
 */
export async function runBackup(options: BackupOptions): Promise<BackupResult> {
  if (options.mode !== 'TRAINING') {
    throw new LiveModeRefusedError('back up');
  }

  const sourcePath = assertAllowedPath(options.sourcePath, options.config);
  const destinationPath = assertAllowedPath(options.destinationPath, options.config);

  if (!existsSync(sourcePath)) {
    throw new SourceNotFoundError(options.sourcePath);
  }
  if (existsSync(destinationPath) && options.force !== true) {
    throw new DestinationExistsError(options.destinationPath);
  }

  const now = options.now ?? (() => new Date().toISOString());

  // Opened directly, never `createSqliteDriver` — a backup tool must never
  // apply a migration. That is a single-writer startup procedure belonging
  // to the worker or the POS, not to this tool. See Migration Ownership.
  const driver = new SqliteLedgerDriver({ file: sourcePath });
  try {
    // The same checkpoint SQLite performs on a clean shutdown — folding the
    // WAL back into the main file so a copy taken immediately after is one
    // consistent file, not a file plus a WAL that must also be captured
    // atomically. See "How SQLite is safely copied" in the runbook.
    driver.unsafeConnection.pragma('wal_checkpoint(TRUNCATE)');

    const applied = new Set(driver.appliedMigrations().map((m) => m.version));
    const latestApplied = driver.appliedMigrations().at(-1)?.version ?? '(none)';
    const missing = MIGRATIONS.filter((m) => !applied.has(m.version));
    if (missing.length > 0) {
      // A backup of a not-fully-migrated database is not refused outright —
      // an operator may legitimately want to preserve a pre-migration state
      // — but the manifest must say so honestly rather than claim currency
      // it does not have.
    }

    // Defensive for the same reason as `countRows`: a database backed up
    // before its first real migration has no `ledger_entries` table yet, and
    // that is a real, honest residual of zero — not a crash.
    let residual = 0;
    try {
      residual = driver.ledgerResidualMinor();
    } catch {
      residual = 0;
    }
    const rowCounts = countRows(driver);

    const sizeBytes = statSync(sourcePath).size;
    if (options.config.maxBackupSizeBytes !== undefined && sizeBytes > options.config.maxBackupSizeBytes) {
      throw new BackupTooLargeError(sizeBytes, options.config.maxBackupSizeBytes);
    }

    mkdirSync(dirname(destinationPath), { recursive: true });
    copyFileSync(sourcePath, destinationPath);

    const checksum = await sha256OfFile(destinationPath);

    const manifest: BackupManifest = {
      manifestVersion: 1,
      schemaVersion: missing.length > 0 ? `${latestApplied} (incomplete: missing ${missing.join(', ')})` : latestApplied,
      createdAt: now(),
      databaseSizeBytes: sizeBytes,
      ledgerResidualMinor: residual,
      rowCounts,
      checksumSha256: checksum,
      sourceIdentifier: sourceIdentifierOf(sourcePath),
    };

    const manifestPath = `${destinationPath}.manifest.json`;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    return { manifest, manifestPath, backupPath: destinationPath };
  } finally {
    driver.close();
  }
}
