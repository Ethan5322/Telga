/**
 * SQLite connection and PRAGMA configuration.
 *
 * Every PRAGMA is set and then **read back** — `readPragmas` returns what the
 * engine actually reports, not what we asked for. The tests assert the readback,
 * because a PRAGMA that silently failed to apply is exactly the kind of thing
 * that looks fine until a power cut.
 */

import Database from 'better-sqlite3';
import type { DriverOptions, PragmaReport } from '../driver/types';

export type Db = Database.Database;

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/**
 * `FULL` by default.
 *
 * `NORMAL` is the usual recommendation with WAL and is measurably faster, but
 * it can lose the most recent commits on a power loss. This is a merchant
 * ledger: a lost commit is a merchant's money unaccounted for, so the write
 * cost is worth paying. See `docs/obsidian/09 Engineering/SQLite Persistence Layer.md`.
 */
export const DEFAULT_SYNCHRONOUS: NonNullable<DriverOptions['synchronous']> = 'FULL';

const SYNCHRONOUS_LEVEL: Readonly<Record<string, number>> = {
  OFF: 0,
  NORMAL: 1,
  FULL: 2,
  EXTRA: 3,
};

export function openDatabase(options: DriverOptions): Db {
  const db = new Database(options.file, { readonly: options.readonly ?? false });

  // An in-memory database has no journal file, so WAL does not apply to it and
  // SQLite reports 'memory'. File databases get WAL.
  if (options.file !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }

  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${String(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS)}`);
  db.pragma(`synchronous = ${options.synchronous ?? DEFAULT_SYNCHRONOUS}`);

  return db;
}

/** Read the PRAGMA values the engine actually reports. */
export function readPragmas(db: Db): PragmaReport {
  return Object.freeze({
    journalMode: String(db.pragma('journal_mode', { simple: true })),
    foreignKeys: Number(db.pragma('foreign_keys', { simple: true })),
    busyTimeout: Number(db.pragma('busy_timeout', { simple: true })),
    synchronous: Number(db.pragma('synchronous', { simple: true })),
  });
}

export const synchronousLevel = (name: keyof typeof SYNCHRONOUS_LEVEL): number =>
  SYNCHRONOUS_LEVEL[name] ?? -1;

export function integrityCheck(db: Db): string {
  return String(db.pragma('integrity_check', { simple: true }));
}

/** Checkpoint the WAL and close. Safe to call on an already-closed handle. */
export function closeDatabase(db: Db): void {
  if (!db.open) return;
  try {
    if (String(db.pragma('journal_mode', { simple: true })).toLowerCase() === 'wal') {
      db.pragma('wal_checkpoint(TRUNCATE)');
    }
  } finally {
    db.close();
  }
}
