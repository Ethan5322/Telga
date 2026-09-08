/**
 * A backup schedule.
 *
 * `05 Operations/Backup Restore Implementation` lists this as the missing piece:
 * *"A real backup schedule — **Not designed** — this is a CLI, not a cron job."*
 * It is why launch gate 10 is still open even though the restore evidence
 * exists: a drill that was run once by hand is not a backup regime.
 *
 * ## Why this matters more than it sounds
 *
 * `05 Operations/Railway Deployment Checklist` records that **volume data is
 * deleted thirty days after credits run out**. The training deployment's ledger
 * — a real shop, a real balance, real transactions — currently exists in exactly
 * one place, and the only copy ever taken was taken by a person who remembered
 * to.
 *
 * ## The property this is built around
 *
 * **A schedule that stops silently is worse than no schedule**, because
 * somebody believes they are covered. So the design goal is not "run a backup
 * every day"; it is *"make the absence of a recent backup impossible to miss"*.
 * Three things follow from that:
 *
 *   1. Every attempt records its outcome, success or failure, with a reason.
 *   2. The last **successful** time is written where the console's existing
 *      `backupsOverdue` alert already reads it, so a stalled schedule surfaces
 *      on a screen an operator looks at rather than in a log nobody tails.
 *   3. A failure never stops the loop. A disk full at 02:00 must not mean no
 *      further attempts are ever made — the next one may well succeed, and a
 *      schedule that gives up after one bad night is the silent stop again.
 *
 * ## What this deliberately does not do
 *
 * It does not copy anything **off** the machine. That is the part gate 10
 * ultimately needs and it requires a destination and credentials Telga does not
 * have — see `09 Engineering/Deposit Rail Options` for the same shape of
 * problem. Writing to the volume protects against a database corrupted or
 * mistakenly deleted; it does **not** protect against the volume itself going
 * away, which is precisely what the thirty-day rule describes. That limitation
 * is reported by {@link scheduleWarnings} rather than left for somebody to
 * discover, and gate 10 stays open until it is answered.
 */

/** Injected so the loop is testable without waiting for real hours to pass. */
export interface SchedulePorts {
  readonly now: () => number;
  /** Takes one backup. Rejects on failure; the reason is recorded. */
  readonly runBackup: () => Promise<{ readonly backupPath: string }>;
  /** Records an attempt. Never throws — a failed record must not fail a backup. */
  readonly record: (outcome: BackupAttempt) => void;
  /** Removes backups older than the retention window. Returns how many went. */
  readonly prune: (olderThanMs: number) => number;
  /** Sleep. Injected so a test does not wait. */
  readonly wait: (ms: number) => Promise<void>;
}

export interface BackupAttempt {
  readonly at: string;
  readonly ok: boolean;
  readonly backupPath?: string;
  readonly reason?: string;
  readonly pruned?: number;
}

export interface ScheduleConfig {
  /** How often to try. */
  readonly everyMs: number;
  /**
   * How long a backup is kept.
   *
   * Retention was *"deliberately not implemented"* in the CLI, because a tool
   * that deletes backups is a tool that can delete the wrong one. Here it is
   * necessary — an unbounded schedule fills the volume the ledger lives on, and
   * a full volume stops every shop trading. So it is bounded, explicit, and
   * refuses a window short enough to leave nothing behind.
   */
  readonly keepForMs: number;
  /**
   * Stop after this many attempts. Absent means run until stopped, which is
   * what a deployment does; a test passes a number.
   */
  readonly maxAttempts?: number;
}

export type ScheduleRefusal = 'INTERVAL_TOO_SHORT' | 'RETENTION_TOO_SHORT' | 'RETENTION_BELOW_INTERVAL';

/** A minute. Anything shorter is a mistake, not a policy. */
export const MIN_INTERVAL_MS = 60_000;
/** Two intervals, so a schedule always keeps at least one older copy. */
export const MIN_RETENTION_FACTOR = 2;

/**
 * Why a schedule cannot run, or `undefined`.
 *
 * Checked before the first backup rather than on the first prune: a retention
 * window shorter than the interval deletes each backup before the next one is
 * taken, leaving **nothing** — a schedule that runs perfectly and protects
 * nobody. That is the failure this refusal exists to make impossible.
 */
export function scheduleRefusal(config: ScheduleConfig): ScheduleRefusal | undefined {
  if (config.everyMs < MIN_INTERVAL_MS) return 'INTERVAL_TOO_SHORT';
  if (config.keepForMs <= 0) return 'RETENTION_TOO_SHORT';
  if (config.keepForMs < config.everyMs * MIN_RETENTION_FACTOR) {
    return 'RETENTION_BELOW_INTERVAL';
  }
  return undefined;
}

export class ScheduleConfigError extends Error {
  readonly code = 'BACKUP_SCHEDULE_REFUSED';
  constructor(readonly refusal: ScheduleRefusal) {
    super(`Refusing to start the backup schedule: ${refusal}.`);
    this.name = 'ScheduleConfigError';
  }
}

/**
 * What this schedule does **not** protect against.
 *
 * Returned rather than logged once at startup, so a screen or a health endpoint
 * can show it. An operator who believes backups are handled, when what is
 * handled is only half the problem, is exactly the person gate 10 exists to
 * protect.
 */
export function scheduleWarnings(input: { readonly offPlatform: boolean }): readonly string[] {
  if (input.offPlatform) return [];
  return [
    'Backups are written to the same volume as the database. This protects against a ' +
      'corrupted or deleted database. It does NOT protect against the volume itself being ' +
      'lost — and Railway deletes volume data thirty days after credits lapse. Launch gate 10 ' +
      'stays open until a copy leaves the platform.',
  ];
}

export interface ScheduleSummary {
  readonly attempts: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly lastSuccessAt?: string;
}

/**
 * Run the schedule.
 *
 * Takes a backup, prunes, waits, repeats. Returns when `maxAttempts` is reached
 * or `signal` aborts, so a deployment can stop it cleanly on `SIGTERM` and a
 * test can run three cycles in no time at all.
 */
export async function runSchedule(
  ports: SchedulePorts,
  config: ScheduleConfig,
  signal?: { readonly aborted: boolean },
): Promise<ScheduleSummary> {
  const refusal = scheduleRefusal(config);
  if (refusal !== undefined) throw new ScheduleConfigError(refusal);

  let attempts = 0;
  let succeeded = 0;
  let failed = 0;
  let lastSuccessAt: string | undefined;

  /**
   * Read through a call, deliberately.
   *
   * `signal.aborted` flips **during** the awaited backup, and TypeScript
   * narrows the property from the loop condition and then reports the later
   * check as unreachable — which is true of the type and false of the program.
   * A function call cannot be narrowed, so the check survives and says what it
   * means: ask again, now.
   */
  const aborted = (): boolean => signal?.aborted === true;

  while (!aborted() && (config.maxAttempts === undefined || attempts < config.maxAttempts)) {
    attempts += 1;
    const at = new Date(ports.now()).toISOString();

    try {
      const result = await ports.runBackup();
      // Pruned only after a successful backup. Pruning after a failure would
      // delete an old copy on the very night no new one was taken, which is the
      // worst possible moment to be reducing what exists.
      const pruned = ports.prune(config.keepForMs);
      succeeded += 1;
      lastSuccessAt = at;
      ports.record({ at, ok: true, backupPath: result.backupPath, pruned });
    } catch (error) {
      failed += 1;
      // The loop continues. A disk full at 02:00 must not mean no further
      // attempt is ever made.
      ports.record({
        at,
        ok: false,
        reason: error instanceof Error ? error.message : 'unknown error',
      });
    }

    if (config.maxAttempts !== undefined && attempts >= config.maxAttempts) break;
    // Asked again here, because a SIGTERM arriving during the backup must not
    // be answered by sleeping for a day first.
    if (aborted()) break;
    await ports.wait(config.everyMs);
  }

  return {
    attempts,
    succeeded,
    failed,
    ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
  };
}
