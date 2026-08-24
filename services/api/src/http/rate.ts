/**
 * The small bridge between the guard and the auth services.
 *
 * `guard.ts` needs three things from `auth/`: `authenticate`, `csrfMatches`,
 * and a way to compute the start of a rate-limit window. Importing them through
 * one module keeps the guard's import list short and gives the window helper a
 * name that says what it is for.
 */

import type { Timestamp } from '@telga/domain';

export { authenticate, csrfMatches } from '../auth/sessions';

/** The start of a rate-limit window ending now. */
export function shiftByForRate(now: Timestamp, windowMs: number): Timestamp {
  return new Date(new Date(now).getTime() - windowMs).toISOString() as Timestamp;
}
