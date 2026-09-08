/**
 * Redeeming an activation code.
 *
 * ## The gap this closes
 *
 * The console could **issue** an activation code — `POST /devices/:id/enrollment-token`
 * generates 100 bits, stores only its hash, and displays it once — and nothing
 * could **redeem** one. `normalizeEnrollmentToken` had no caller outside the
 * tests. So a shop could be read a code down the phone and had nowhere to type
 * it, and device keys still came from a CLI run by an administrator.
 *
 * ## Why the token and the device key are different secrets
 *
 * `enrollment.ts` states the rule: *"It activates a device once and then dies.
 * What the device keeps afterwards is a separate credential."* Conflating them
 * would mean the thing a person reads down a phone line is also the thing that
 * authenticates every later request — a credential that has been spoken aloud,
 * written on a note, and possibly overheard.
 *
 * So redemption is an **exchange**: a short-lived code a human carries, for a
 * 256-bit key only the machine ever sees.
 *
 * ## How single use is guaranteed
 *
 * Not by a flag that has to be remembered. `device_enrollments` holds one
 * secret hash per device; issuing a code writes the **code's** hash there, and
 * redeeming replaces it with the **key's** hash. After a successful redemption
 * the token no longer verifies against anything, because what it was compared to
 * is gone. A second attempt with the same code fails the way an incorrect code
 * fails, which is also the answer an attacker should get.
 */

import type { DeviceId, MerchantId } from '@telga/domain';
import { verifySecret } from '../auth/secrets';
import { enrolDevice } from '../auth/sessions';
import type { AuthDeps } from '../auth/sessions';
import { normalizeEnrollmentToken } from './enrollment';

export type RedemptionRefusal =
  /** No enrolment row. Same answer as a wrong code — see below. */
  | 'ACTIVATION_REFUSED'
  /** The code was issued and its hour has passed. Ask the console for another. */
  | 'ACTIVATION_EXPIRED'
  /** Already activated, revoked, or never issued a code. */
  | 'ACTIVATION_NOT_PENDING';

export type RedemptionResult =
  | {
      readonly kind: 'ACTIVATED';
      readonly deviceId: DeviceId;
      /** Shown once. Never stored in recoverable form and never recoverable later. */
      readonly deviceSecret: string;
    }
  | { readonly kind: 'REFUSED'; readonly reason: RedemptionRefusal };

export interface RedemptionRequest {
  readonly deviceId: DeviceId;
  /** As typed, with whatever grouping and case the person used. */
  readonly token: string;
  readonly correlationId: string;
}

/**
 * Exchange an activation code for a device key.
 *
 * ## Why an unknown device and a wrong code get the same answer
 *
 * `ACTIVATION_REFUSED` covers both. Distinguishing them would turn this into a
 * device-id oracle: an attacker with no code could enumerate ids and learn which
 * shops exist and which are mid-activation, which is exactly the map worth
 * having before trying anything else. `Device Binding` makes the same choice for
 * `DEVICE_NOT_ENROLLED`, and for the same reason.
 *
 * **Expiry is told apart**, deliberately. A shop whose code has lapsed needs to
 * know to ask for another, and by then they have already proved they hold a
 * code that was genuinely issued to them.
 */
export async function redeemEnrollmentToken(
  deps: AuthDeps,
  request: RedemptionRequest,
): Promise<RedemptionResult> {
  const enrolment = deps.driver.findDeviceEnrollment(request.deviceId);
  if (enrolment === undefined) return { kind: 'REFUSED', reason: 'ACTIVATION_REFUSED' };

  // A device already ENROLLED must not be re-activated by anybody holding an old
  // code: re-enrolment is an operations decision with its own audit event, not
  // something a counter can trigger. REVOKED is the case this most protects —
  // a stolen POS whose enrolment was withdrawn must stay withdrawn.
  if (enrolment.enrollment_state !== 'PENDING') {
    return { kind: 'REFUSED', reason: 'ACTIVATION_NOT_PENDING' };
  }

  // Checked before the hash comparison: an expired code is refused whether or
  // not it is correct, so there is no way to use this to test codes against a
  // lapsed enrolment.
  const now = deps.now();
  if (enrolment.expires_at !== null && enrolment.expires_at <= now) {
    return { kind: 'REFUSED', reason: 'ACTIVATION_EXPIRED' };
  }

  // `device_enrollments` stores a hash and a salt and no parameters, so the
  // parameter string is supplied by the caller. This is the same literal
  // `sessions.ts` uses to verify a device secret at sign-in, and it must stay
  // the same: the two verify hashes written by the same `deriveSecret`, and a
  // divergence here would refuse every correct code with no visible reason.
  const ok = await verifySecret(normalizeEnrollmentToken(request.token), {
    hash: enrolment.secret_hash,
    salt: enrolment.secret_salt,
    params: 'scrypt$N=16384,r=8,p=1,len=64',
  });
  if (!ok) return { kind: 'REFUSED', reason: 'ACTIVATION_REFUSED' };

  // `enrolDevice` generates the long-term key, overwrites the token's hash with
  // the key's, sets the state to ENROLLED and revokes any session the device was
  // carrying. Reused rather than reimplemented so activation and re-enrolment
  // cannot drift into behaving differently.
  const enrolled = await enrolDevice(deps, {
    deviceId: request.deviceId,
    merchantId: enrolment.merchant_id as MerchantId,
    displayName: enrolment.display_name ?? undefined,
    actor: { userId: 'system', role: 'ADMIN' },
    correlationId: request.correlationId,
  });

  return {
    kind: 'ACTIVATED',
    deviceId: enrolled.deviceId,
    deviceSecret: enrolled.deviceSecret,
  };
}
