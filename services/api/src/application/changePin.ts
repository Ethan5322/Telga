/**
 * Changing a transaction PIN.
 *
 * ## The current PIN is required
 *
 * An open owner session is not enough. A session left unlocked on a counter
 * is precisely the situation this guards against: whoever walked up to the
 * machine should not be able to rewrite the credential that authorizes sales
 * and then keep using it. Knowing the current PIN is the proof that the
 * person changing it is the person who owns it.
 *
 * ## The PIN never exists anywhere but here
 *
 * Both the current and the new PIN arrive in the request body, are used
 * immediately, and are never written to a log, an audit `metadata` blob, a
 * response, or a cookie. Only the scrypt-derived key, its salt and its
 * parameters reach the database — the same shape provisioning writes. The
 * audit event records *that* a PIN changed and by whom, never what it is.
 *
 * ## A wrong current PIN counts as a PIN failure
 *
 * It is recorded in `auth_attempts` under `PIN_AUTH`, the same scope a wrong
 * voucher PIN uses, so guessing at the change form is bounded by the same
 * trailing-window lockout and does not need its own counter. It never touches
 * `merchant_users.failed_attempts`, so it cannot lock anybody out of signing in.
 */

import { auditEventId, createAuditEvent } from '@telga/domain';
import type { AuthContext } from '../auth/context';
import { shiftBy } from '../auth/context';
import { deriveSecret, verifySecret } from '../auth/secrets';
import type { AuthedApiDeps } from '../http/deps';

/**
 * What a training PIN must be.
 *
 * Six digits, matching what provisioning issues and what the PIN pad accepts.
 * `NOT_DIFFERENT` exists because "changing" a PIN to the same value is almost
 * always a mis-typed form rather than an intention.
 */
export const PIN_RULES = Object.freeze({ length: 6 });

export type ChangePinResult =
  | { readonly kind: 'CHANGED' }
  | { readonly kind: 'CURRENT_PIN_WRONG' }
  | {
      readonly kind: 'NEW_PIN_WEAK';
      readonly reason: PinWeakness;
    }
  | { readonly kind: 'SIMULATED_ONLY' };

export interface ChangePinRequest {
  readonly currentPin: string;
  readonly newPin: string;
  readonly correlationId: string;
}

export type PinWeakness = 'WRONG_LENGTH' | 'NOT_DIGITS' | 'NOT_DIFFERENT' | 'TOO_SIMPLE';

/** Why a proposed PIN is unacceptable, or `undefined` if it is fine. */
export function newPinRejection(newPin: string, currentPin: string): PinWeakness | undefined {
  if (newPin.length !== PIN_RULES.length) return 'WRONG_LENGTH';
  if (!/^\d+$/.test(newPin)) return 'NOT_DIGITS';
  if (newPin === currentPin) return 'NOT_DIFFERENT';
  // All one digit (`111111`) or a straight run (`123456`, `987654`). Refused
  // because a PIN protects a float, and these are the first guesses anybody
  // makes. Deliberately a short list: a long "common PINs" blocklist would
  // reject values a shop legitimately chose without making guessing much harder.
  if (/^(\d)\1+$/.test(newPin)) return 'TOO_SIMPLE';
  const digits = [...newPin].map(Number);
  const ascending = digits.every((d, i) => i === 0 || d === (digits[i - 1]) + 1);
  const descending = digits.every((d, i) => i === 0 || d === (digits[i - 1]) - 1);
  if (ascending || descending) return 'TOO_SIMPLE';
  return undefined;
}

/**
 * Must this operator replace their PIN before doing anything else?
 *
 * True only for a PIN somebody else issued. An administrator provisioning a
 * shop sets `mustChangePin`, because a PIN that Telga staff have read out, or
 * that is written on the paperwork handed over with the device, is not a
 * credential belonging to that shop — it is a shared secret with an unknown
 * number of holders.
 *
 * `updateMerchantUserPin` clears the flag in the same statement that writes the
 * new hash, so there is no window in which a changed PIN is still marked
 * temporary. Nothing else clears it: signing in with a temporary PIN does not
 * make it permanent, however many times it happens.
 *
 * An operator that predates migration 015 reads as `0` and is unaffected, which
 * is the whole reason the column defaults that way.
 *
 * **This answers the question; it does not enforce anything.** The caller
 * decides what to do with the answer — the POS is expected to send the operator
 * to the change-PIN screen and refuse to sell until it is done.
 */
export function pinChangeRequired(
  deps: AuthedApiDeps,
  context: Pick<AuthContext, 'userId' | 'merchantId'>,
): boolean {
  // Scoped by merchant as well as id: one shop must never be able to read
  // another's operator row, even with a guessed user id.
  const user = deps.driver.findMerchantUser(context.userId, context.merchantId);
  return user?.must_change_pin === 1;
}

export async function changePin(
  deps: AuthedApiDeps,
  context: AuthContext,
  request: ChangePinRequest,
): Promise<ChangePinResult> {
  if (deps.mode !== 'TRAINING') return { kind: 'SIMULATED_ONLY' };

  const userId = context.userId;
  const merchantId = context.merchantId;
  const now = deps.now();

  // Lockout first, so a locked operator costs a database read rather than a
  // scrypt derivation — the same order `login` and `authorizeOrder` use.
  const policy = deps.authConfig.pinLockout ?? deps.authConfig.lockout;
  const recentFailures = deps.driver.countFailuresSince(
    'PIN_AUTH',
    userId,
    shiftBy(now, -policy.lockoutMs),
  );
  if (recentFailures >= policy.maxFailedAttempts) return { kind: 'CURRENT_PIN_WRONG' };

  const user = deps.driver.findMerchantUser(userId, merchantId);
  const currentOk =
    user !== undefined &&
    (await verifySecret(request.currentPin, {
      hash: user.pin_hash,
      salt: user.pin_salt,
      params: user.pin_params,
    }));

  if (!currentOk) {
    deps.driver.recordAttempt('PIN_AUTH', userId, 'FAILURE', now);
    return { kind: 'CURRENT_PIN_WRONG' };
  }

  // Checked only after the current PIN is proven, so the rules cannot be used
  // to probe anything about the stored value.
  const weak = newPinRejection(request.newPin, request.currentPin);
  if (weak !== undefined) return { kind: 'NEW_PIN_WEAK', reason: weak };

  const derived = await deriveSecret(request.newPin);
  const updated = deps.driver.updateMerchantUserPin({
    id: userId,
    merchantId,
    pinHash: derived.hash,
    pinSalt: derived.salt,
    pinParams: derived.params,
    at: now,
  });
  // The session already proved this user exists, so a miss here would be a
  // deeper inconsistency than a wrong PIN — reported the same way rather than
  // through a code that would distinguish the two.
  if (!updated) return { kind: 'CURRENT_PIN_WRONG' };

  deps.driver.recordAttempt('PIN_AUTH', userId, 'SUCCESS', now);
  deps.driver.saveAuditEvent({
    event: createAuditEvent({
      id: auditEventId(deps.newId('audit')),
      at: now,
      action: 'OPERATOR_PIN_CHANGED',
      actor: { userId, role: context.role, deviceId: context.deviceId },
      merchantId,
      detail: 'PIN_CHANGED_BY_OWNER',
    }),
    correlationId: request.correlationId,
    entityType: 'merchant_user',
    entityId: userId,
    // That it happened, never what it changed to. `assertSafeMetadata`
    // refuses a `pin` key anyway; this records nothing that resembles one.
    metadata: {},
  });

  return { kind: 'CHANGED' };
}
