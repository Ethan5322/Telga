/**
 * Proving a PIN to unlock the screen.
 *
 * Separate from `authorizeOrder` because unlocking authorizes nothing: no
 * order exists, no money moves, and there is no result to record beyond
 * whether the PIN was right. What it shares with the voucher PIN is the
 * credential and the abuse budget.
 *
 * ## The same lockout, deliberately
 *
 * Attempts are recorded under `PIN_AUTH`, the scope a wrong voucher PIN uses.
 * Guessing at the lock screen therefore eats the same trailing-window budget
 * as guessing at the PIN pad — somebody who has picked up an unattended
 * machine cannot get unlimited tries by choosing the quieter door.
 *
 * And, exactly as there: it never touches `merchant_users.failed_attempts` or
 * `locked_until`, so a failed unlock can never lock an operator out of
 * *signing in*.
 */

import type { AuthContext } from '../auth/context';
import { shiftBy } from '../auth/context';
import { verifySecret } from '../auth/secrets';
import type { AuthedApiDeps } from '../http/deps';

export type UnlockResult =
  | { readonly kind: 'UNLOCKED' }
  | { readonly kind: 'PIN_INVALID' }
  | { readonly kind: 'LOCKED_OUT' };

export async function unlockWithPin(
  deps: AuthedApiDeps,
  context: AuthContext,
  pin: string,
  _correlationId: string,
): Promise<UnlockResult> {
  const userId = context.userId;
  const now = deps.now();

  // Lockout first, so a locked operator costs a database read rather than a
  // scrypt derivation — the order `login` and `authorizeOrder` both use.
  const policy = deps.authConfig.pinLockout ?? deps.authConfig.lockout;
  const failures = deps.driver.countFailuresSince(
    'PIN_AUTH',
    userId,
    shiftBy(now, -policy.lockoutMs),
  );
  if (failures >= policy.maxFailedAttempts) return { kind: 'LOCKED_OUT' };

  const user = deps.driver.findMerchantUser(userId, context.merchantId);
  const ok =
    user !== undefined &&
    (await verifySecret(pin, {
      hash: user.pin_hash,
      salt: user.pin_salt,
      params: user.pin_params,
    }));

  if (!ok) {
    deps.driver.recordAttempt('PIN_AUTH', userId, 'FAILURE', now);
    return { kind: 'PIN_INVALID' };
  }

  deps.driver.recordAttempt('PIN_AUTH', userId, 'SUCCESS', now);
  return { kind: 'UNLOCKED' };
}
