/**
 * Keeping the console from being jammed.
 *
 * The merchant API has had rate limiting since early on — `SALE` scope, a
 * window, a cap. **The console had none.** Every route, including sign-in, would
 * answer as fast as a caller could ask, which makes two things cheap that should
 * both be expensive:
 *
 * 1. **Guessing an administrator's password.** Account lockout exists
 *    (`failed_attempts`, `locked_until`), and it is per-account: it stops one
 *    account being guessed at, and does nothing about ten thousand attempts
 *    spread across many addresses or many accounts. Lockout and rate limiting
 *    answer different questions.
 * 2. **Flooding the console until nobody can use it.** A single loop over
 *    `/deposits` is enough to keep one SQLite connection busy, and the console
 *    shares that connection with the merchant server.
 *
 * ## Why a fixed window per address, and not something cleverer
 *
 * A token bucket or sliding log would be smoother. This is deliberately the
 * simplest thing that removes the cheapness: a counter per address per window,
 * held in memory, dropped when the process restarts.
 *
 * **In-memory is honest for what this is.** The console runs as one process
 * beside one SQLite file (D120); a shared store would be infrastructure for a
 * deployment shape that does not exist. If the console is ever run behind more
 * than one process, this becomes per-process and the note below must be read
 * again — it is written down rather than discovered.
 *
 * ## What it deliberately does not do
 *
 * **It does not lock anybody out.** A refusal lasts until the window rolls,
 * seconds later. An administrator who trips it during a busy morning waits, and
 * is told to; a locked account needs a colleague, which is the right cost for a
 * wrong password and the wrong cost for too many page loads.
 *
 * **It does not distinguish users.** The limit is on the *address*, because a
 * flood arrives before anybody authenticates and the identity of an attacker is
 * exactly what is not known yet.
 */

/** What the caller is trying to do, because the two deserve different limits. */
export type ConsoleRateScope =
  /**
   * Sign-in and step-up. **Tight**, because each attempt is a guess at a
   * secret, and a legitimate operator makes a handful in a morning.
   */
  | 'AUTH'
  /** Everything else. Loose enough that ordinary work never notices it. */
  | 'REQUEST';

export interface ConsoleRatePolicy {
  readonly authPerMinute: number;
  readonly requestsPerMinute: number;
  readonly windowMs: number;
}

/**
 * The defaults.
 *
 * **10 sign-in attempts a minute** — a person typing a password carefully
 * manages two or three, and account lockout at four wrong ones arrives long
 * before this does. This is the floor under a *distributed* attempt, not a
 * replacement for lockout.
 *
 * **240 requests a minute** — four a second, sustained. The console is
 * server-rendered with no polling, so a busy operator moving fast generates
 * perhaps one a second. This leaves headroom for a page with several assets and
 * still refuses a loop.
 */
export const CONSOLE_RATE_POLICY: ConsoleRatePolicy = Object.freeze({
  authPerMinute: 10,
  requestsPerMinute: 240,
  windowMs: 60_000,
});

interface Counter {
  count: number;
  windowStart: number;
}

/**
 * A fixed-window counter, per address per scope.
 *
 * Entries are pruned when the map grows, rather than on a timer: a timer keeps
 * the process alive and would have to be cleared by every test that builds a
 * console. Pruning on write is less elegant and needs no lifecycle.
 */
export class ConsoleRateLimiter {
  private readonly counters = new Map<string, Counter>();

  constructor(private readonly policy: ConsoleRatePolicy = CONSOLE_RATE_POLICY) {}

  /**
   * May this address do this now?
   *
   * Returns the seconds to wait when it may not, so the answer can carry a
   * `Retry-After` rather than leaving a caller to guess — and so an operator
   * who has tripped it is told when to try again instead of reloading blindly.
   */
  check(address: string, scope: ConsoleRateScope, nowMs: number): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const limit = scope === 'AUTH' ? this.policy.authPerMinute : this.policy.requestsPerMinute;
    const key = `${scope}:${address}`;
    const existing = this.counters.get(key);

    if (existing === undefined || nowMs - existing.windowStart >= this.policy.windowMs) {
      // Prune before inserting, so a long-running console does not accumulate
      // one entry per address it has ever seen.
      if (this.counters.size > 4096) this.prune(nowMs);
      this.counters.set(key, { count: 1, windowStart: nowMs });
      return { ok: true };
    }

    if (existing.count >= limit) {
      const elapsed = nowMs - existing.windowStart;
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((this.policy.windowMs - elapsed) / 1000)),
      };
    }

    existing.count += 1;
    return { ok: true };
  }

  private prune(nowMs: number): void {
    for (const [key, counter] of this.counters) {
      if (nowMs - counter.windowStart >= this.policy.windowMs) this.counters.delete(key);
    }
  }
}

/**
 * Which scope a path falls under.
 *
 * Sign-in, MFA and step-up are all attempts at proving identity, so they share
 * the tight budget. Everything else is work.
 */
export const scopeForPath = (path: string): ConsoleRateScope =>
  path === '/login' || path.startsWith('/mfa') || path.startsWith('/step-up') ? 'AUTH' : 'REQUEST';
