/**
 * The backup schedule.
 *
 * `05 Operations/Backup Restore Implementation` lists this as the one missing
 * piece — *"a real backup schedule: **not designed**"* — and it is why launch
 * gate 10 stays open despite the restore evidence existing.
 *
 * ## What is actually being tested
 *
 * Not "does it call the backup function". The property worth having is that
 * **the absence of a recent backup is impossible to miss**, because a schedule
 * that stops silently is worse than none: somebody believes they are covered.
 * So the tests are mostly about failure — a backup that throws, a retention
 * window that would delete everything, a loop that must not give up.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  MIN_INTERVAL_MS,
  ScheduleConfigError,
  runSchedule,
  scheduleRefusal,
  scheduleWarnings,
} from '@telga/backup';
import type { BackupAttempt, SchedulePorts } from '@telga/backup';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function harness(
  over: Partial<SchedulePorts> = {},
): { ports: SchedulePorts; attempts: BackupAttempt[]; waited: number[] } {
  const attempts: BackupAttempt[] = [];
  const waited: number[] = [];
  let clock = Date.parse('2026-09-08T02:00:00.000Z');

  const ports: SchedulePorts = {
    now: () => clock,
    runBackup: () => Promise.resolve({ backupPath: `/data/backups/telga-${String(clock)}.sqlite` }),
    record: (outcome) => attempts.push(outcome),
    prune: () => 0,
    wait: (ms) => {
      waited.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    ...over,
  };
  return { ports, attempts, waited };
}

describe('what the schedule refuses to start as', () => {
  it('refuses a retention window shorter than the interval', () => {
    // The failure this exists to make impossible: each backup deleted before
    // the next is taken, leaving **nothing**. A schedule that runs perfectly
    // and protects nobody.
    expect(scheduleRefusal({ everyMs: DAY, keepForMs: HOUR })).toBe('RETENTION_BELOW_INTERVAL');
    expect(scheduleRefusal({ everyMs: DAY, keepForMs: DAY })).toBe('RETENTION_BELOW_INTERVAL');
    // Two intervals is the minimum, so one older copy always survives.
    expect(scheduleRefusal({ everyMs: DAY, keepForMs: 2 * DAY })).toBeUndefined();
  });

  it('refuses an interval short enough to be a mistake', () => {
    expect(scheduleRefusal({ everyMs: 1_000, keepForMs: 30 * DAY })).toBe('INTERVAL_TOO_SHORT');
    expect(scheduleRefusal({ everyMs: MIN_INTERVAL_MS, keepForMs: 30 * DAY })).toBeUndefined();
  });

  it('refuses a retention of zero, which would keep nothing at all', () => {
    expect(scheduleRefusal({ everyMs: DAY, keepForMs: 0 })).toBe('RETENTION_TOO_SHORT');
  });

  it('throws before the first backup rather than on the first prune', async () => {
    // Checked at start-up, so a misconfigured schedule fails on the operator's
    // screen instead of quietly deleting its own output a day later.
    const { ports, attempts } = harness();
    await expect(runSchedule(ports, { everyMs: DAY, keepForMs: HOUR })).rejects.toThrow(
      ScheduleConfigError,
    );
    expect(attempts).toEqual([]);
  });
});

describe('a schedule that is working', () => {
  it('takes a backup, prunes, and records the outcome each time', async () => {
    const prune = vi.fn(() => 2);
    const { ports, attempts, waited } = harness({ prune });

    const summary = await runSchedule(ports, {
      everyMs: DAY,
      keepForMs: 30 * DAY,
      maxAttempts: 3,
    });

    expect(summary).toMatchObject({ attempts: 3, succeeded: 3, failed: 0 });
    expect(attempts).toHaveLength(3);
    for (const attempt of attempts) {
      expect(attempt.ok).toBe(true);
      expect(attempt.backupPath).toContain('/data/backups/');
      expect(attempt.pruned).toBe(2);
    }
    // Waits between attempts, not after the last one.
    expect(waited).toEqual([DAY, DAY]);
    expect(prune).toHaveBeenCalledTimes(3);
  });

  it('reports when it last succeeded, so staleness is answerable', async () => {
    const { ports } = harness();
    const summary = await runSchedule(ports, {
      everyMs: DAY,
      keepForMs: 30 * DAY,
      maxAttempts: 2,
    });
    expect(summary.lastSuccessAt).toBe('2026-09-09T02:00:00.000Z');
  });
});

describe('a schedule that is failing', () => {
  it('records the reason and keeps going', async () => {
    // A disk full at 02:00 must not mean no further attempt is ever made. A
    // schedule that gives up after one bad night is the silent stop again.
    let call = 0;
    const { ports, attempts } = harness({
      runBackup: () => {
        call += 1;
        if (call === 1) return Promise.reject(new Error('ENOSPC: no space left on device'));
        return Promise.resolve({ backupPath: '/data/backups/later.sqlite' });
      },
    });

    const summary = await runSchedule(ports, {
      everyMs: DAY,
      keepForMs: 30 * DAY,
      maxAttempts: 3,
    });

    expect(summary).toMatchObject({ attempts: 3, succeeded: 2, failed: 1 });
    expect(attempts[0]).toMatchObject({ ok: false });
    expect(attempts[0]?.reason).toContain('ENOSPC');
    expect(attempts[1]?.ok).toBe(true);
  });

  it('does not prune on the night the backup failed', async () => {
    // Deleting an old copy on the one night no new one was taken is the worst
    // possible moment to be reducing what exists.
    const prune = vi.fn(() => 1);
    const { ports } = harness({
      prune,
      runBackup: () => Promise.reject(new Error('database is locked')),
    });

    await runSchedule(ports, { everyMs: DAY, keepForMs: 30 * DAY, maxAttempts: 2 });
    expect(prune).not.toHaveBeenCalled();
  });

  it('reports no last success when every attempt failed', async () => {
    const { ports } = harness({ runBackup: () => Promise.reject(new Error('nope')) });
    const summary = await runSchedule(ports, {
      everyMs: DAY,
      keepForMs: 30 * DAY,
      maxAttempts: 2,
    });
    expect(summary.succeeded).toBe(0);
    expect(summary.lastSuccessAt).toBeUndefined();
  });

  it('records a non-Error rejection without crashing the loop', async () => {
    const { ports, attempts } = harness({
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      runBackup: () => Promise.reject('a string, because somebody threw one'),
    });
    const summary = await runSchedule(ports, {
      everyMs: DAY,
      keepForMs: 30 * DAY,
      maxAttempts: 1,
    });
    expect(summary.failed).toBe(1);
    expect(attempts[0]?.reason).toBe('unknown error');
  });
});

describe('stopping', () => {
  it('stops when the signal aborts, without another backup', async () => {
    // A deployment stops this on SIGTERM. It must not take one more backup on
    // its way out, half-writing a file the process will not live to finish.
    const signal = { aborted: false };
    const runBackup = vi.fn(() => {
      signal.aborted = true;
      return Promise.resolve({ backupPath: '/data/backups/one.sqlite' });
    });
    const { ports } = harness({ runBackup });

    const summary = await runSchedule(ports, { everyMs: DAY, keepForMs: 30 * DAY }, signal);
    expect(summary.attempts).toBe(1);
    expect(runBackup).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when aborted before it starts', async () => {
    const { ports, attempts } = harness();
    const summary = await runSchedule(ports, { everyMs: DAY, keepForMs: 30 * DAY }, {
      aborted: true,
    });
    expect(summary.attempts).toBe(0);
    expect(attempts).toEqual([]);
  });
});

describe('what it says it does not protect against', () => {
  it('warns plainly when backups stay on the same volume', () => {
    // An operator who believes backups are handled, when what is handled is
    // half the problem, is exactly who gate 10 exists to protect.
    const warnings = scheduleWarnings({ offPlatform: false });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('does NOT protect against the volume itself being lost');
    expect(warnings[0]).toContain('thirty days after credits lapse');
    expect(warnings[0]).toContain('gate 10');
  });

  it('has nothing to warn about once a copy leaves the platform', () => {
    expect(scheduleWarnings({ offPlatform: true })).toEqual([]);
  });
});
