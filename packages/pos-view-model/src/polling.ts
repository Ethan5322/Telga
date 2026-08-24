/**
 * Status polling for a transaction screen.
 *
 * Every input is injected — the clock, the scheduler and the fetch — so a test
 * drives the whole thing by advancing a fake scheduler. There is no `setTimeout`
 * in this file and no `Date.now()`. A UI test that needs a sleep to pass is a
 * test that will flake on a slow machine; see `09 Engineering/Test Stability Runbook.md`.
 *
 * ## The rules
 *
 * 1. **Bounded.** `maxPolls` is required. A screen left open on a counter
 *    overnight must not hammer the API until morning.
 * 2. **The interval comes from the server**, not from the client's opinion —
 *    `statusCheckIntervalMs` is the recovery policy's own number, so the POS
 *    asks at roughly the rate the worker works at rather than faster.
 * 3. **Stopping is a state, not an exception.** `PollOutcome` says why it
 *    stopped, so the screen can distinguish "resolved" from "gave up".
 */

import { isTerminal } from '@telga/domain';
import type { TransactionState } from '@telga/domain';

export type PollStopReason =
  | 'RESOLVED'
  | 'MAX_POLLS_REACHED'
  | 'STOPPED_BY_CALLER'
  | 'NOT_STARTED';

export interface Scheduler {
  /** Returns a handle the controller passes back to `cancel`. */
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface PollOptions<T> {
  /** From the server envelope: the recovery policy's own status-check interval. */
  readonly intervalMs: number;
  readonly maxPolls: number;
  readonly scheduler: Scheduler;
  /** One status read. Rejections are reported, never thrown out of the loop. */
  fetchOnce(): Promise<T>;
  /** Called after every attempt, successful or not. */
  onResult(result: PollAttempt<T>): void;
  /** Return false to stop. Defaults to "stop when the state is terminal". */
  shouldContinue?(value: T): boolean;
}

export interface PollAttempt<T> {
  readonly attempt: number;
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: unknown;
}

/**
 * Poll until the caller says stop, the maximum is reached, or the value
 * resolves. A failed attempt does **not** stop the loop: a transaction whose
 * status lookup failed is exactly the one worth asking about again.
 */
export class PollController<T> {
  private handle: unknown = undefined;
  private attempts = 0;
  private running = false;
  private stopped: PollStopReason = 'NOT_STARTED';
  /** The attempt currently in flight, if any. See `settled()`. */
  private inFlight: Promise<void> | undefined;

  constructor(private readonly options: PollOptions<T>) {}

  get attemptCount(): number {
    return this.attempts;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get stopReason(): PollStopReason {
    return this.stopped;
  }

  /**
   * Resolve when the attempt currently in flight has finished.
   *
   * Exists for tests, and it is the reason none of them need a sleep: a test
   * fires the scheduler and then awaits *this*, rather than guessing how many
   * microtasks a fetch happens to take. Guessing is what makes a UI test flake
   * on a loaded machine.
   */
  async settled(): Promise<void> {
    await this.inFlight;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.queue();
  }

  stop(reason: PollStopReason = 'STOPPED_BY_CALLER'): void {
    if (!this.running) return;
    this.running = false;
    this.stopped = reason;
    if (this.handle !== undefined) {
      this.options.scheduler.cancel(this.handle);
      this.handle = undefined;
    }
  }

  private queue(): void {
    if (!this.running) return;
    if (this.attempts >= this.options.maxPolls) {
      this.stop('MAX_POLLS_REACHED');
      return;
    }
    this.handle = this.options.scheduler.schedule(() => {
      this.handle = undefined;
      this.inFlight = this.tick();
      void this.inFlight;
    }, this.options.intervalMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    this.attempts += 1;
    try {
      const value = await this.options.fetchOnce();
      this.options.onResult({ attempt: this.attempts, ok: true, value });
      const carryOn = this.options.shouldContinue?.(value) ?? true;
      if (!carryOn) {
        this.stop('RESOLVED');
        return;
      }
    } catch (error) {
      // A failed lookup is not a resolution. Keep asking.
      this.options.onResult({ attempt: this.attempts, ok: false, error });
    }
    this.queue();
  }
}

/** The default stop condition for a transaction screen. */
export function stopWhenSettled(state: TransactionState): boolean {
  return !isTerminal(state);
}

/** A scheduler backed by the host's timers. Used by the browser client only. */
export function timerScheduler(): Scheduler {
  return {
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/**
 * A scheduler a test drives by hand.
 *
 * `runNext()` fires the earliest pending callback and returns whether there was
 * one. No wall clock is involved, so a hundred polls take no time at all.
 */
export class ManualScheduler implements Scheduler {
  private nextId = 1;
  private readonly queued = new Map<number, { callback: () => void; delayMs: number }>();

  schedule(callback: () => void, delayMs: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.queued.set(id, { callback, delayMs });
    return id;
  }

  cancel(handle: unknown): void {
    this.queued.delete(handle as number);
  }

  get pending(): number {
    return this.queued.size;
  }

  /** Delays of everything currently queued, in scheduling order. */
  get delays(): readonly number[] {
    return [...this.queued.values()].map((entry) => entry.delayMs);
  }

  runNext(): boolean {
    const first = [...this.queued.keys()][0];
    if (first === undefined) return false;
    const entry = this.queued.get(first);
    this.queued.delete(first);
    entry?.callback();
    return true;
  }
}
