/**
 * The four sign-in parameters a shop is given, generated once.
 *
 * The founder's Steps 5 and 6: on approval the system produces an **Operator
 * ID**, a **Device ID**, a **43-character Device Key** and a **temporary PIN**,
 * and the admin hands them over at the shop.
 *
 * ## Why this is a separate act from provisioning
 *
 * `provisionMerchant` (D120) creates the shop. This creates the people and the
 * machine that trade for it, and it is deliberately its own step because it is
 * the only moment a secret is displayed. Separating them means:
 *
 *   - the display can be a `POST`, so a device key is never in browser history
 *     or re-fetchable by pressing back;
 *   - it can be **repeated** when a shop loses its key, without re-provisioning
 *     a shop that already exists;
 *   - it can carry its own step-up requirement and its own audit event.
 *
 * ## What is a secret here and what is not
 *
 * The ids are sequential and readable — `operator_0001`, `device_0001` — because
 * the founder asked for that and because they are **not secrets**. `Device
 * Binding` is explicit that a device identifier is a string the client sends and
 * evidence of nothing; the key is what makes the pairing worth checking. So the
 * ids are guessable by design and the two things that are not — the key and the
 * PIN — are generated with `randomBytes` and `randomInt`, stored only as scrypt
 * hashes, and shown once.
 *
 * ## Why the PIN is marked temporary
 *
 * A PIN that Telga staff have read out, or that is written on the paperwork
 * handed over with the device, is not a credential belonging to that shop — it
 * is a shared secret with an unknown number of holders. `must_change_pin` is set
 * so the operator must replace it at first sign-in, and
 * `updateMerchantUserPin` clears the flag in the same statement that writes the
 * new hash.
 */

import { randomInt } from 'node:crypto';
import { pinRejection } from '@telga/domain';
import type { MerchantId } from '@telga/domain';
import { deriveSecret, newToken } from '../auth/secrets';
import { depositLookupFor } from './recordDeposit';

/** Everything this needs from the outside, so it opens nothing itself. */
export interface CredentialPorts {
  readonly now: () => string;
  /**
   * The highest number already used for ids beginning `prefix_`.
   *
   * Read inside the caller's transaction. SQLite has one writer, so
   * `max + 1` cannot collide with a concurrent issue — and the primary key
   * would refuse it if it somehow did.
   */
  readonly highestNumberFor: (prefix: 'operator' | 'device') => number;
  readonly saveOperator: (input: {
    id: string;
    merchantId: string;
    displayName: string;
    pinHash: string;
    pinSalt: string;
    pinParams: string;
    at: string;
  }) => void;
  readonly saveDevice: (input: { id: string; merchantId: string; at: string }) => void;
  readonly saveEnrolment: (input: {
    deviceId: string;
    merchantId: string;
    secretHash: string;
    secretSalt: string;
    /**
     * The searchable form of the key, so a deposit quoting it can find this
     * shop in one indexed lookup.
     *
     * Written **here**, at the only moment the key exists in plaintext. If it
     * were left for later it could never be computed at all: what the database
     * keeps afterwards is a salted scrypt hash, which cannot be reversed and
     * cannot be searched. See migration 016 and D125.
     */
    depositLookup: string;
    at: string;
  }) => void;
}

/**
 * What the admin is shown, once.
 *
 * `deviceKey` and `temporaryPin` exist in this object, in the response that
 * renders it, and nowhere else. The database holds scrypt hashes.
 */
export interface IssuedCredentials {
  readonly operatorId: string;
  readonly deviceId: string;
  /** 43 characters, base64url. Shown once and not recoverable afterwards. */
  readonly deviceKey: string;
  /** Six digits. Must be replaced at first sign-in. */
  readonly temporaryPin: string;
}

/** `operator_0001`. Zero-padded so a list of shops sorts the way a person reads it. */
const idFor = (prefix: string, number: number): string =>
  `${prefix}_${String(number).padStart(4, '0')}`;

/**
 * A six-digit PIN a shop can actually be given.
 *
 * Rejected values are re-drawn rather than adjusted: nudging `111111` to
 * `111112` would bias the distribution towards whatever the nudge produces.
 * `pinRejection` refuses all-same and sequential runs, so the loop is short —
 * those are a vanishing fraction of a million.
 */
export function newTemporaryPin(): string {
  for (;;) {
    let pin = '';
    for (let i = 0; i < 6; i += 1) pin += String(randomInt(10));
    if (pinRejection(pin) === undefined) return pin;
  }
}

/**
 * Create the operator, the device and its enrolment, and return what to hand
 * over.
 *
 * Asynchronous because two scrypt derivations happen here. The caller runs it
 * inside a transaction: an operator without a device, or a device without an
 * enrolment, is a shop that cannot sign in and looks provisioned.
 */
export async function issueCredentials(
  ports: CredentialPorts,
  input: { merchantId: MerchantId; displayName?: string },
): Promise<IssuedCredentials> {
  const at = ports.now();

  const operatorId = idFor('operator', ports.highestNumberFor('operator') + 1);
  const deviceId = idFor('device', ports.highestNumberFor('device') + 1);

  const temporaryPin = newTemporaryPin();
  const pin = await deriveSecret(temporaryPin);

  // 32 bytes, base64url — exactly 43 characters, which is what the founder's
  // specification says the shop is given.
  const deviceKey = newToken();
  const key = await deriveSecret(deviceKey);

  // The device before the operator: `merchant_users` has no device reference,
  // but a device with no enrolment is the state that looks usable and is not,
  // so the enrolment follows immediately.
  ports.saveDevice({ id: deviceId, merchantId: input.merchantId, at });
  ports.saveEnrolment({
    deviceId,
    merchantId: input.merchantId,
    secretHash: key.hash,
    secretSalt: key.salt,
    depositLookup: depositLookupFor(deviceKey),
    at,
  });
  ports.saveOperator({
    id: operatorId,
    merchantId: input.merchantId,
    displayName: input.displayName ?? operatorId,
    pinHash: pin.hash,
    pinSalt: pin.salt,
    pinParams: pin.params,
    at,
  });

  return { operatorId, deviceId, deviceKey, temporaryPin };
}
