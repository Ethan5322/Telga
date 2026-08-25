/**
 * Path safety and configuration for backup and restore.
 *
 * Every path an operator supplies is resolved to an absolute path and checked
 * against an explicit allow-list of roots before anything touches disk. There
 * is no default allow-list — an empty or missing configuration refuses every
 * path, rather than falling back to "anywhere is fine."
 */

import { isAbsolute, resolve, sep as SEP } from 'node:path';

export class PathNotAllowedError extends Error {
  constructor(path: string) {
    super(`Refusing to use "${path}": it does not resolve inside an allowed training path.`);
    this.name = 'PathNotAllowedError';
  }
}

/**
 * Typed configuration. Every field is explicit — there is no hidden
 * production default, matching the rest of this repository's configuration
 * philosophy (`worker/workerConfig.ts`, `Feature Flags.md`).
 */
export interface BackupRestoreConfig {
  /** Absolute directories a `--db`, `--output`, `--backup` or `--target` path must resolve inside. */
  readonly allowedRoots: readonly string[];
  /** Refuse a backup larger than this. `undefined` means no limit is enforced. */
  readonly maxBackupSizeBytes?: number;
  /** How long `PRAGMA wal_checkpoint(TRUNCATE)` may take before the backup is refused. */
  readonly checkpointTimeoutMs: number;
  /**
   * How many backups to retain in the same output directory. `undefined`
   * means no pruning is performed — this tool never deletes a backup file on
   * its own. A retention *policy* is recorded so the field exists to be
   * wired to an actual pruning step later, deliberately, not implemented
   * here: automatic deletion of an operator's only backup is exactly the
   * kind of silent, destructive action this repository's own safety rules
   * refuse to take without an explicit, reviewed decision.
   */
  readonly retentionCount?: number;
}

export const DEFAULT_CHECKPOINT_TIMEOUT_MS = 30_000;

/** Resolve and validate a path against the configured allowed roots. Throws, never guesses. */
export function assertAllowedPath(path: string, config: BackupRestoreConfig): string {
  if (path.trim().length === 0) {
    throw new PathNotAllowedError(path);
  }
  const absolute = isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path);

  if (config.allowedRoots.length === 0) {
    throw new PathNotAllowedError(path);
  }

  const inside = config.allowedRoots.some((root) => {
    const normalizedRoot = resolve(root);
    return absolute === normalizedRoot || absolute.startsWith(`${normalizedRoot}${SEP}`);
  });

  if (!inside) {
    throw new PathNotAllowedError(path);
  }
  return absolute;
}
