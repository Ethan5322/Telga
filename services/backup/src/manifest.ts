/**
 * The backup manifest.
 *
 * Written beside every backup file as `<backup>.manifest.json`. Contains
 * exactly what `Backup and Restore Runbook.md` requires and nothing a
 * merchant, an operator's credential, or a recipient could ever appear in —
 * counts and a checksum, never row content.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';

export interface BackupManifest {
  readonly manifestVersion: 1;
  /** The last applied migration version — see `MIGRATIONS` in `@telga/persistence`. */
  readonly schemaVersion: string;
  readonly createdAt: string;
  /** File size in bytes, after the WAL checkpoint, before the copy. */
  readonly databaseSizeBytes: number;
  /** Must be zero for a trustworthy backup. Recorded, not silently corrected. */
  readonly ledgerResidualMinor: number;
  readonly rowCounts: BackupRowCounts;
  /** SHA-256 of the backup file's bytes, computed after the copy completes. */
  readonly checksumSha256: string;
  /** The source database's file name only — never the full host path. */
  readonly sourceIdentifier: string;
}

export interface BackupRowCounts {
  readonly merchants: number;
  readonly transactions: number;
  readonly ledgerEntries: number;
  readonly recoveryClaims: number;
  readonly pendingResolutions: number;
  readonly supportCases: number;
  readonly auditEvents: number;
  readonly merchantUsers: number;
  readonly deviceEnrollments: number;
  readonly sessions: number;
}

/** Never the full path — only what identifies the file without the host's directory structure. */
export const sourceIdentifierOf = (path: string): string => basename(path);

/** Streamed, so a large database file is never held in memory twice. */
export function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      resolvePromise(hash.digest('hex'));
    });
    stream.on('error', reject);
  });
}

export class ManifestMissingError extends Error {
  constructor(path: string) {
    super(`No manifest found beside "${basename(path)}". A backup without its manifest cannot be verified.`);
    this.name = 'ManifestMissingError';
  }
}

export class ChecksumMismatchError extends Error {
  constructor() {
    super('Backup file does not match its manifest checksum. Refusing to restore a possibly corrupt backup.');
    this.name = 'ChecksumMismatchError';
  }
}

export class SchemaMismatchError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`Restored database is missing migrations: ${missing.join(', ')}.`);
    this.name = 'SchemaMismatchError';
    this.missing = missing;
  }
}
