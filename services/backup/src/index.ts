/**
 * @telga/backup — training-mode backup and restore, host-neutral.
 *
 * TRAINING MODE — NO REAL VALUE. Both `runBackup` and `runRestore` refuse a
 * non-TRAINING mode before opening any database.
 */

export * from './errors';
export * from './manifest';
export * from './paths';
export * from './backup';
export * from './restore';
