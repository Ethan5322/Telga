/** Errors shared between `backup.ts` and `restore.ts`. */

export class LiveModeRefusedError extends Error {
  constructor(action: 'back up' | 'restore') {
    super(`Refusing to ${action}: mode is not TRAINING. Checked before the database is opened.`);
    this.name = 'LiveModeRefusedError';
  }
}
