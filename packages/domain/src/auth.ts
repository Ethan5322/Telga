/**
 * Identity, permissions and session rules.
 *
 * Pure, like the rest of the domain: no clock, no crypto, no database. What
 * lives here is the *decision* — which role may do which thing, and when a
 * session has expired. How a PIN is hashed and where a session is stored are
 * questions for `services/api` and `packages/persistence`.
 *
 * ## Permissions are a table
 *
 * Same reasoning as `VALID_TRANSITIONS` and `STATE_PRESENTATION`: a table is
 * exhaustively testable, and a new permission cannot be added without every
 * role being given an explicit answer for it. A permission check written as an
 * `if` at a call site is a permission nobody can audit.
 *
 * ## What a merchant operator may never do
 *
 * `FORBIDDEN_TO_MERCHANT` is stated separately from the grant table and tested
 * separately. Two lists that must agree are harder to get wrong by accident
 * than one list read twice — and the supervisor approval in `reversal.ts` is a
 * money control, so it deserves a second lock rather than a single lookup.
 */

import type { DeviceId, MerchantId, MerchantUserId, Timestamp } from './ids';

export type ActorRole =
  | 'MERCHANT_OPERATOR'
  | 'MERCHANT_OWNER'
  | 'OPS_VERIFIER'
  | 'OPS_APPROVER'
  | 'OPS_RECONCILER'
  | 'OPS_SUPPORT'
  | 'ADMIN'
  | 'SYSTEM';

/** Every decision the POS and its API can be asked to make. */
export const PERMISSIONS = [
  'POS_VIEW_HOME',
  'POS_CREATE_SALE',
  'POS_VIEW_TRANSACTION',
  'POS_VIEW_HISTORY',
  'POS_VIEW_PENDING_QUEUE',
  'POS_VIEW_UNDER_REVIEW_QUEUE',
  'POS_REQUEST_SUPPORT_REVIEW',
  'POS_LOGOUT',
  'DEVICE_ENROL',
  'DEVICE_REVOKE',
  // Beyond the POS. Listed so the table has to answer for them.
  'REVERSAL_REQUEST',
  'REVERSAL_APPROVE',
  'TRANSACTION_FORCE_STATE',
  'FUNDS_RELEASE',
  'RECOVERY_CONFIGURE',
  'PROVIDER_OVERRIDE_OUTCOME',
  'ADMIN_DIAGNOSTICS',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const OPERATOR_GRANTS: readonly Permission[] = [
  'POS_VIEW_HOME',
  'POS_CREATE_SALE',
  'POS_VIEW_TRANSACTION',
  'POS_VIEW_HISTORY',
  'POS_VIEW_PENDING_QUEUE',
  'POS_VIEW_UNDER_REVIEW_QUEUE',
  'POS_REQUEST_SUPPORT_REVIEW',
  'POS_LOGOUT',
];

/**
 * The owner is an operator who may also enrol a device for their own shop.
 * Revocation stays with operations, because a stolen device is exactly the case
 * where the person holding it must not be able to tidy up after themselves.
 */
const OWNER_GRANTS: readonly Permission[] = [...OPERATOR_GRANTS, 'DEVICE_ENROL'];

export const ROLE_PERMISSIONS: Readonly<Record<ActorRole, readonly Permission[]>> = Object.freeze({
  MERCHANT_OPERATOR: Object.freeze(OPERATOR_GRANTS),
  MERCHANT_OWNER: Object.freeze(OWNER_GRANTS),
  OPS_VERIFIER: Object.freeze(['POS_LOGOUT'] as const),
  OPS_RECONCILER: Object.freeze(['POS_LOGOUT'] as const),
  OPS_SUPPORT: Object.freeze(['POS_LOGOUT', 'REVERSAL_REQUEST', 'DEVICE_REVOKE'] as const),
  OPS_APPROVER: Object.freeze([
    'POS_LOGOUT',
    'REVERSAL_REQUEST',
    'REVERSAL_APPROVE',
    'FUNDS_RELEASE',
    'DEVICE_REVOKE',
  ] as const),
  ADMIN: Object.freeze([...PERMISSIONS]),
  // The system actor is the recovery worker. It authenticates no one and holds
  // no session; it is never the subject of a permission check.
  SYSTEM: Object.freeze([] as const),
});

/**
 * Permissions a merchant-side role must never hold, restated deliberately.
 *
 * Every one of these is a money control. `reversal.ts` already requires
 * `OPS_APPROVER` or `ADMIN`; this list makes the same statement in a place a
 * test can check without going through the reversal service.
 */
export const FORBIDDEN_TO_MERCHANT: readonly Permission[] = Object.freeze([
  'REVERSAL_APPROVE',
  'TRANSACTION_FORCE_STATE',
  'FUNDS_RELEASE',
  'RECOVERY_CONFIGURE',
  'PROVIDER_OVERRIDE_OUTCOME',
  'ADMIN_DIAGNOSTICS',
  'DEVICE_REVOKE',
]);

export const MERCHANT_ROLES: readonly ActorRole[] = Object.freeze([
  'MERCHANT_OPERATOR',
  'MERCHANT_OWNER',
]);

export const isMerchantRole = (role: ActorRole): boolean => MERCHANT_ROLES.includes(role);

export function can(role: ActorRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

// --- device enrollment ------------------------------------------------------

export type DeviceEnrollmentState = 'PENDING' | 'ENROLLED' | 'REVOKED' | 'EXPIRED';

/** A device may be used for a session only in this state. */
export const USABLE_ENROLLMENT_STATE: DeviceEnrollmentState = 'ENROLLED';

export interface DeviceEnrollment {
  readonly deviceId: DeviceId;
  readonly merchantId: MerchantId;
  readonly state: DeviceEnrollmentState;
  readonly displayName?: string;
  readonly enrolledAt: Timestamp;
  readonly lastSeenAt?: Timestamp;
  readonly expiresAt?: Timestamp;
  readonly revokedAt?: Timestamp;
  readonly revocationReason?: string;
}

export type DeviceRejection =
  | 'DEVICE_NOT_ENROLLED'
  | 'DEVICE_REVOKED'
  | 'DEVICE_ENROLLMENT_EXPIRED'
  | 'DEVICE_NOT_ASSIGNED_TO_MERCHANT';

/**
 * Whether an enrolment may carry a session **right now**.
 *
 * Takes the clock as an argument rather than reading it: a device whose
 * enrolment expired a second ago must be refused, and that is a decision about
 * a moment in time, not a stored flag.
 */
export function deviceRejection(
  enrollment: DeviceEnrollment | undefined,
  merchantId: MerchantId,
  now: Timestamp,
): DeviceRejection | undefined {
  if (!enrollment) return 'DEVICE_NOT_ENROLLED';
  if (enrollment.state === 'REVOKED') return 'DEVICE_REVOKED';
  if (enrollment.state === 'EXPIRED') return 'DEVICE_ENROLLMENT_EXPIRED';
  if (enrollment.state !== USABLE_ENROLLMENT_STATE) return 'DEVICE_NOT_ENROLLED';
  if (enrollment.expiresAt !== undefined && enrollment.expiresAt <= now) {
    return 'DEVICE_ENROLLMENT_EXPIRED';
  }
  // A device belongs to exactly one merchant. Reassignment is a revocation
  // followed by a new enrolment, never a quiet change of owner.
  if (enrollment.merchantId !== merchantId) return 'DEVICE_NOT_ASSIGNED_TO_MERCHANT';
  return undefined;
}

// --- sessions ---------------------------------------------------------------

export type SessionStatus = 'ACTIVE' | 'REVOKED';

export interface SessionFacts {
  readonly userId: MerchantUserId;
  readonly merchantId: MerchantId;
  readonly deviceId: DeviceId;
  readonly role: ActorRole;
  readonly status: SessionStatus;
  readonly createdAt: Timestamp;
  readonly lastSeenAt: Timestamp;
  /** Moves forward on every request. Inactivity ends a session. */
  readonly idleExpiresAt: Timestamp;
  /** Fixed at login. A session may never outlive this, however active it is. */
  readonly absoluteExpiresAt: Timestamp;
}

export type SessionRejection =
  | 'SESSION_MISSING'
  | 'SESSION_UNKNOWN'
  | 'SESSION_REVOKED'
  | 'SESSION_IDLE_EXPIRED'
  | 'SESSION_LIFETIME_EXPIRED';

/**
 * Whether a session may be used at `now`.
 *
 * Both expiries are checked on **every request**, not only at login. A session
 * that was valid when the page was rendered may not be valid when the form is
 * submitted, and the submission is the one that moves money.
 */
export function sessionRejection(
  session: SessionFacts | undefined,
  now: Timestamp,
): SessionRejection | undefined {
  if (!session) return 'SESSION_UNKNOWN';
  if (session.status === 'REVOKED') return 'SESSION_REVOKED';
  if (session.absoluteExpiresAt <= now) return 'SESSION_LIFETIME_EXPIRED';
  if (session.idleExpiresAt <= now) return 'SESSION_IDLE_EXPIRED';
  return undefined;
}

/** Session rejections a merchant should be asked to sign in again for. */
export const REAUTHENTICATE_ON: readonly SessionRejection[] = Object.freeze([
  'SESSION_MISSING',
  'SESSION_UNKNOWN',
  'SESSION_REVOKED',
  'SESSION_IDLE_EXPIRED',
  'SESSION_LIFETIME_EXPIRED',
]);

// --- PIN policy -------------------------------------------------------------

/**
 * Training PIN policy.
 *
 * Deliberately modest: a six-digit PIN is what a counter operator will actually
 * use, and its weakness is answered by lockout and by the device binding rather
 * than by length. Production values are **NOT YET CONFIRMED** — see
 * `07 Governance/Decision Log.md`.
 */
export const PIN_MIN_LENGTH = 6;
export const PIN_MAX_LENGTH = 12;

export type PinRejection = 'PIN_TOO_SHORT' | 'PIN_TOO_LONG' | 'PIN_NOT_NUMERIC' | 'PIN_TOO_SIMPLE';

const REPEATED = /^(\d)\1+$/;

function isSequential(pin: string): boolean {
  let ascending = true;
  let descending = true;
  for (let i = 1; i < pin.length; i += 1) {
    const previous = pin.charCodeAt(i - 1);
    const current = pin.charCodeAt(i);
    if (current !== previous + 1) ascending = false;
    if (current !== previous - 1) descending = false;
  }
  return ascending || descending;
}

/** Reject a PIN that is too weak to be worth hashing. Never logs the value. */
export function pinRejection(pin: string): PinRejection | undefined {
  if (!/^\d+$/.test(pin)) return 'PIN_NOT_NUMERIC';
  if (pin.length < PIN_MIN_LENGTH) return 'PIN_TOO_SHORT';
  if (pin.length > PIN_MAX_LENGTH) return 'PIN_TOO_LONG';
  if (REPEATED.test(pin)) return 'PIN_TOO_SIMPLE';
  if (isSequential(pin)) return 'PIN_TOO_SIMPLE';
  return undefined;
}

// --- lockout ----------------------------------------------------------------

export interface LockoutPolicy {
  /** Consecutive failures before the account is locked. */
  readonly maxFailedAttempts: number;
  readonly lockoutMs: number;
  /** Login attempts allowed in `rateWindowMs`, successful or not. */
  readonly maxAttemptsPerWindow: number;
  readonly rateWindowMs: number;
}

/**
 * Training values. **Not a production policy** — real thresholds depend on how
 * a real counter behaves and are NOT YET CONFIRMED.
 */
export const TRAINING_LOCKOUT_POLICY: LockoutPolicy = Object.freeze({
  maxFailedAttempts: 5,
  lockoutMs: 5 * 60_000,
  maxAttemptsPerWindow: 10,
  rateWindowMs: 60_000,
});

export const isLockedOut = (lockedUntil: Timestamp | undefined, now: Timestamp): boolean =>
  lockedUntil !== undefined && lockedUntil > now;
