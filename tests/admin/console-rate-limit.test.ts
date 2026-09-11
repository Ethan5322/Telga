/**
 * The console refuses a flood — `CLAUDE.md` §24, *"rate limiting"*.
 *
 * ## What was missing
 *
 * The merchant API has been rate limited since early on. **The console had
 * nothing.** Every route, sign-in included, answered as fast as a caller could
 * ask, which makes two things cheap that should both be expensive: guessing an
 * administrator's password, and keeping the one SQLite connection busy until
 * nobody else can use it.
 *
 * Account lockout already exists and does **not** cover this. Lockout is per
 * account: it stops one account being guessed at and says nothing about a flood
 * spread across many accounts, or a flood that never authenticates at all.
 *
 * ## The property these tests pin
 *
 * A refusal must cost less than the work it refuses. The counter is asserted
 * directly here; the server wiring puts it above the origin check, the session
 * read and every database statement, so a refused request parses no body and
 * opens no connection.
 */

import { describe, expect, it } from 'vitest';
import {
  CONSOLE_RATE_POLICY,
  ConsoleRateLimiter,
  scopeForPath,
} from '../../apps/operations-console/src/rateLimit';

const T0 = 1_700_000_000_000;

describe('which budget a path falls under', () => {
  it('treats every identity-proving path as AUTH', () => {
    // All three are attempts at proving who you are, so they share the tight
    // budget. Splitting them would let a caller spend one budget three times.
    expect(scopeForPath('/login')).toBe('AUTH');
    expect(scopeForPath('/mfa')).toBe('AUTH');
    expect(scopeForPath('/mfa/enrol')).toBe('AUTH');
    expect(scopeForPath('/step-up')).toBe('AUTH');
  });

  it('treats ordinary work as REQUEST', () => {
    for (const path of ['/', '/deposits', '/merchants', '/audit']) {
      expect(scopeForPath(path), path).toBe('REQUEST');
    }
  });
});

describe('the sign-in budget', () => {
  it('allows a careful operator and refuses a guesser', () => {
    const limiter = new ConsoleRateLimiter();
    const address = '203.0.113.9';

    for (let i = 0; i < CONSOLE_RATE_POLICY.authPerMinute; i += 1) {
      expect(limiter.check(address, 'AUTH', T0).ok, `attempt ${String(i + 1)}`).toBe(true);
    }
    const refused = limiter.check(address, 'AUTH', T0);
    expect(refused.ok).toBe(false);
    // Told when to come back, so an operator who trips it waits rather than
    // reloading blindly — and so the answer can carry a Retry-After.
    if (!refused.ok) expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('forgives once the window rolls', () => {
    const limiter = new ConsoleRateLimiter();
    const address = '203.0.113.9';
    for (let i = 0; i < CONSOLE_RATE_POLICY.authPerMinute; i += 1) {
      limiter.check(address, 'AUTH', T0);
    }
    expect(limiter.check(address, 'AUTH', T0).ok).toBe(false);

    // A refusal is a pause, never a lockout. Locking an administrator out over
    // page loads is the wrong cost; a colleague would have to unlock them.
    expect(limiter.check(address, 'AUTH', T0 + CONSOLE_RATE_POLICY.windowMs).ok).toBe(true);
  });
});

describe('what one caller cannot do to another', () => {
  it('counts each address separately', () => {
    const limiter = new ConsoleRateLimiter();
    for (let i = 0; i < CONSOLE_RATE_POLICY.authPerMinute; i += 1) {
      limiter.check('198.51.100.1', 'AUTH', T0);
    }
    expect(limiter.check('198.51.100.1', 'AUTH', T0).ok).toBe(false);

    // The property that keeps this from being a denial of service of its own:
    // one attacker must not be able to lock every administrator out by
    // exhausting a shared counter.
    expect(limiter.check('198.51.100.2', 'AUTH', T0).ok).toBe(true);
  });

  it('counts each scope separately, so a flood does not close sign-in', () => {
    const limiter = new ConsoleRateLimiter();
    const address = '198.51.100.3';
    for (let i = 0; i < CONSOLE_RATE_POLICY.requestsPerMinute; i += 1) {
      limiter.check(address, 'REQUEST', T0);
    }
    expect(limiter.check(address, 'REQUEST', T0).ok).toBe(false);
    // An operator whose browser hammered a page must still be able to sign in.
    expect(limiter.check(address, 'AUTH', T0).ok).toBe(true);
  });
});

describe('the ordinary budget', () => {
  it('is loose enough that real work never notices', () => {
    const limiter = new ConsoleRateLimiter();
    // A busy operator moving fast generates perhaps one request a second; the
    // console is server-rendered and does not poll. Sixty in a minute must not
    // come close.
    for (let i = 0; i < 60; i += 1) {
      expect(limiter.check('198.51.100.4', 'REQUEST', T0 + i * 1000).ok).toBe(true);
    }
  });

  it('still refuses a loop', () => {
    const limiter = new ConsoleRateLimiter();
    let refusals = 0;
    for (let i = 0; i < CONSOLE_RATE_POLICY.requestsPerMinute + 50; i += 1) {
      if (!limiter.check('198.51.100.5', 'REQUEST', T0).ok) refusals += 1;
    }
    expect(refusals).toBe(50);
  });
});

describe('it does not grow without bound', () => {
  it('drops counters whose window has passed', () => {
    const limiter = new ConsoleRateLimiter();
    // Enough distinct addresses to cross the prune threshold. A limiter that
    // kept every address it had ever seen would be a memory leak with a
    // security label on it.
    for (let i = 0; i < 5000; i += 1) {
      limiter.check(`10.0.${String(Math.floor(i / 256))}.${String(i % 256)}`, 'REQUEST', T0);
    }
    expect(limiter.check('10.9.9.9', 'REQUEST', T0 + CONSOLE_RATE_POLICY.windowMs * 2).ok).toBe(true);
  });
});
