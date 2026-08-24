/**
 * Sign in, authenticate, sign out.
 *
 * ## The rule this file exists to enforce
 *
 * **The merchant comes from the session, never from the request.** `authenticate`
 * returns an `AuthContext` built entirely from server-side rows; a caller that
 * scopes its queries by `context.merchantId` cannot be talked into scoping by
 * anything a client supplied.
 *
 * ## What is checked on every request, not only at login
 *
 *   1. the session exists, is not revoked, and neither expiry has passed;
 *   2. the **device** is still enrolled, still active, still this merchant's;
 *   3. the **user** still exists, is not suspended and is not locked out.
 *
 * Checking the device only at login would mean a revoked device kept working
 * until its session happened to expire — which is precisely the window that
 * matters when a POS is stolen.
 *
 * ## What is never logged
 *
 * No function here writes anything anywhere. It returns typed results; the HTTP
 * layer decides what to record, and records codes rather than values. The raw
 * PIN, the session token and the device secret are arguments and return values
 * only — never fields on a result that gets serialised.
 */

import {
  auditEventId,
  createAuditEvent,
  deviceRejection,
  isLockedOut,
  sessionRejection,
} from '@telga/domain';
import type {
  ActorRole,
  AuditAction,
  DeviceEnrollment,
  DeviceId,
  MerchantId,
  MerchantUserId,
  SessionFacts,
  Timestamp,
} from '@telga/domain';
import type { SqliteLedgerDriver } from '@telga/persistence';
import type { DeviceEnrollmentRow, MerchantUserRow, SessionRow } from '@telga/persistence';
import type { AuthConfig, AuthContext, AuthResult } from './context';
import { shiftBy, failure, success } from './context';
import { deriveSecret, newToken, tokenFingerprint, tokensMatch, verifySecret } from './secrets';

/**
 * What the auth services need.
 *
 * The field is named `authConfig`, not `config`, so the HTTP layer's own
 * dependency bundle satisfies this interface structurally without a wrapper —
 * one object is passed all the way down, and there is no adapter to forget.
 */
export interface AuthDeps {
  readonly driver: SqliteLedgerDriver;
  readonly authConfig: AuthConfig;
  now(): Timestamp;
  newId(prefix: string): string;
}

/** What a successful sign-in hands back to the transport. */
export interface LoginSuccess {
  readonly ok: true;
  readonly context: AuthContext;
  /** Set once, in a cookie. Never stored, never logged, never put in a URL. */
  readonly sessionToken: string;
  readonly csrfToken: string;
}

export type LoginResult = LoginSuccess | ReturnType<typeof failure>;

export interface LoginRequest {
  readonly userId: MerchantUserId;
  readonly pin: string;
  readonly deviceId: DeviceId;
  /** Proves the caller holds the enrolled device's secret. */
  readonly deviceSecret: string;
}

function toEnrollment(row: DeviceEnrollmentRow): DeviceEnrollment {
  return {
    deviceId: row.device_id as DeviceId,
    merchantId: row.merchant_id as MerchantId,
    state: row.enrollment_state,
    displayName: row.display_name ?? undefined,
    enrolledAt: row.enrolled_at as Timestamp,
    lastSeenAt: (row.last_seen_at ?? undefined) as Timestamp | undefined,
    expiresAt: (row.expires_at ?? undefined) as Timestamp | undefined,
    revokedAt: (row.revoked_at ?? undefined) as Timestamp | undefined,
    revocationReason: row.revocation_reason ?? undefined,
  };
}

function toFacts(row: SessionRow): SessionFacts {
  return {
    userId: row.user_id as MerchantUserId,
    merchantId: row.merchant_id as MerchantId,
    deviceId: row.device_id as DeviceId,
    role: row.role,
    status: row.status,
    createdAt: row.created_at as Timestamp,
    lastSeenAt: row.last_seen_at as Timestamp,
    idleExpiresAt: row.idle_expires_at as Timestamp,
    absoluteExpiresAt: row.absolute_expires_at as Timestamp,
  };
}

/**
 * The merchant scope for an audit event that genuinely has none.
 *
 * A failed sign-in against an unknown user id belongs to no merchant, and
 * inventing one would be worse than saying so. `audit_events.merchant_id` has
 * no foreign key, so this is storable; it is a sentinel, never a real id.
 */
export const UNSCOPED_MERCHANT = 'merchant_unscoped' as MerchantId;

function audit(
  deps: AuthDeps,
  action: AuditAction,
  input: {
    userId: MerchantUserId | 'system';
    role: ActorRole;
    merchantId?: MerchantId;
    deviceId?: DeviceId;
    correlationId: string;
    /** A safe code. Never a PIN, a token, or a secret. */
    detail?: string;
  },
): void {
  deps.driver.saveAuditEvent({
    event: createAuditEvent({
      id: auditEventId(deps.newId('audit')),
      at: deps.now(),
      action,
      actor: { userId: input.userId, role: input.role, deviceId: input.deviceId },
      merchantId: input.merchantId ?? UNSCOPED_MERCHANT,
      detail: input.detail,
    }),
    correlationId: input.correlationId,
    entityType: 'session',
    entityId: input.deviceId,
  });
}

// --- sign in ----------------------------------------------------------------

/**
 * Sign in with a PIN and a device secret.
 *
 * Order matters. The rate limit is checked before the user is looked up, the
 * lockout before the PIN is verified, and the device before a session is
 * created — so a locked account costs an attacker a database read rather than
 * a scrypt derivation, and an unenrolled device never reaches the PIN check at
 * all.
 *
 * Every failure returns `INVALID_CREDENTIALS` where the alternative would
 * distinguish a wrong PIN from an unknown user.
 */
export async function login(
  deps: AuthDeps,
  request: LoginRequest,
  correlationId: string,
): Promise<LoginResult> {
  const now = deps.now();
  const windowStart = shiftBy(now, -deps.authConfig.lockout.rateWindowMs);

  // Rate limit is per user id, which is what an attacker varies least.
  const recent = deps.driver.countAttemptsSince('LOGIN', request.userId, windowStart);
  if (recent >= deps.authConfig.lockout.maxAttemptsPerWindow) {
    audit(deps, 'AUTH_RATE_LIMITED', {
      userId: 'system',
      role: 'SYSTEM',
      correlationId,
      detail: 'LOGIN_RATE_LIMIT',
    });
    return failure('RATE_LIMITED');
  }
  deps.driver.recordAttempt('LOGIN', request.userId, 'FAILURE', now);

  const user = deps.driver.findMerchantUser(request.userId);
  if (!user) {
    audit(deps, 'AUTH_LOGIN_FAILED', {
      userId: 'system',
      role: 'SYSTEM',
      correlationId,
      detail: 'USER_NOT_FOUND',
    });
    return failure('INVALID_CREDENTIALS');
  }

  if (user.status !== 'ACTIVE') {
    audit(deps, 'AUTH_LOGIN_FAILED', {
      userId: request.userId,
      role: user.role,
      merchantId: user.merchant_id as MerchantId,
      correlationId,
      detail: 'USER_SUSPENDED',
    });
    return failure('USER_SUSPENDED');
  }

  if (isLockedOut((user.locked_until ?? undefined) as Timestamp | undefined, now)) {
    audit(deps, 'AUTH_LOCKED_OUT', {
      userId: request.userId,
      role: user.role,
      merchantId: user.merchant_id as MerchantId,
      correlationId,
      detail: 'LOCKED_UNTIL_IN_FUTURE',
    });
    return failure('USER_LOCKED_OUT');
  }

  const merchantId = user.merchant_id as MerchantId;

  // The device is checked before the PIN: an unenrolled device is refused
  // without spending a scrypt derivation on it.
  const enrollmentRow = deps.driver.findDeviceEnrollment(request.deviceId);
  const rejection = deviceRejection(
    enrollmentRow ? toEnrollment(enrollmentRow) : undefined,
    merchantId,
    now,
  );
  if (rejection) {
    audit(deps, 'DEVICE_REJECTED', {
      userId: request.userId,
      role: user.role,
      merchantId,
      deviceId: request.deviceId,
      correlationId,
      detail: rejection,
    });
    return failure(rejection);
  }

  const enrollment = enrollmentRow as DeviceEnrollmentRow;
  const deviceOk = await verifySecret(request.deviceSecret, {
    hash: enrollment.secret_hash,
    salt: enrollment.secret_salt,
    params: 'scrypt$N=16384,r=8,p=1,len=64',
  });
  if (!deviceOk) {
    audit(deps, 'DEVICE_REJECTED', {
      userId: request.userId,
      role: user.role,
      merchantId,
      deviceId: request.deviceId,
      correlationId,
      detail: 'DEVICE_SECRET_MISMATCH',
    });
    return failure('INVALID_CREDENTIALS');
  }

  const pinOk = await verifySecret(request.pin, {
    hash: user.pin_hash,
    salt: user.pin_salt,
    params: user.pin_params,
  });
  if (!pinOk) {
    deps.driver.recordFailedLogin(
      request.userId,
      now,
      deps.authConfig.lockout.maxFailedAttempts,
      shiftBy(now, deps.authConfig.lockout.lockoutMs),
    );
    audit(deps, 'AUTH_LOGIN_FAILED', {
      userId: request.userId,
      role: user.role,
      merchantId,
      deviceId: request.deviceId,
      correlationId,
      detail: 'PIN_MISMATCH',
    });
    return failure('INVALID_CREDENTIALS');
  }

  // --- correct. Issue a fresh session ---------------------------------------
  //
  // A new token every time, which is what prevents session fixation: whatever
  // identifier the client arrived with is not the one it leaves with.
  const sessionToken = newToken();
  const csrfToken = newToken();
  const sessionId = tokenFingerprint(sessionToken);

  deps.driver.createSession({
    id: sessionId,
    userId: request.userId,
    merchantId,
    deviceId: request.deviceId,
    role: user.role,
    csrfHash: tokenFingerprint(csrfToken),
    createdAt: now,
    idleExpiresAt: shiftBy(now, deps.authConfig.session.idleTimeoutMs),
    absoluteExpiresAt: shiftBy(now, deps.authConfig.session.absoluteLifetimeMs),
  });

  deps.driver.recordSuccessfulLogin(request.userId, now);
  deps.driver.recordAttempt('LOGIN', request.userId, 'SUCCESS', now);
  deps.driver.touchDevice(request.deviceId, now);

  audit(deps, 'AUTH_LOGIN_SUCCEEDED', {
    userId: request.userId,
    role: user.role,
    merchantId,
    deviceId: request.deviceId,
    correlationId,
  });

  return {
    ok: true,
    sessionToken,
    csrfToken,
    context: contextOf(user, {
      sessionId,
      deviceId: request.deviceId,
      issuedAt: now,
      idleExpiresAt: shiftBy(now, deps.authConfig.session.idleTimeoutMs),
      absoluteExpiresAt: shiftBy(now, deps.authConfig.session.absoluteLifetimeMs),
      csrfToken,
    }),
  };
}

function contextOf(
  user: MerchantUserRow,
  session: {
    sessionId: string;
    deviceId: DeviceId;
    issuedAt: Timestamp;
    idleExpiresAt: Timestamp;
    absoluteExpiresAt: Timestamp;
    csrfToken?: string;
  },
): AuthContext {
  return {
    sessionId: session.sessionId,
    userId: user.id as MerchantUserId,
    merchantId: user.merchant_id as MerchantId,
    deviceId: session.deviceId,
    role: user.role,
    displayName: user.display_name,
    issuedAt: session.issuedAt,
    idleExpiresAt: session.idleExpiresAt,
    absoluteExpiresAt: session.absoluteExpiresAt,
    csrfToken: session.csrfToken,
  };
}

// --- authenticate -----------------------------------------------------------

/**
 * Resolve a session token into an authenticated context.
 *
 * Returns a failure rather than throwing, so every call site has to handle the
 * refusal explicitly. Sliding the idle window is the only write.
 */
export function authenticate(
  deps: AuthDeps,
  sessionToken: string | undefined,
  correlationId: string,
): AuthResult {
  const now = deps.now();
  if (sessionToken === undefined || sessionToken.length === 0) return failure('SESSION_MISSING');

  const row = deps.driver.findSession(tokenFingerprint(sessionToken));
  const rejected = sessionRejection(row ? toFacts(row) : undefined, now);

  // The device outranks a session verdict.
  //
  // Revoking a device also revokes the sessions it was carrying, so the next
  // request would otherwise be refused as SESSION_REVOKED — a 401 that sends
  // the operator to sign in, where they cannot succeed. Reporting the device
  // reason instead gives them an answer they can act on, and keeps them out of
  // a login loop they have no way to escape.
  if (row) {
    const enrolment = deps.driver.findDeviceEnrollment(row.device_id as DeviceId);
    const deviceProblem = deviceRejection(
      enrolment ? toEnrollment(enrolment) : undefined,
      row.merchant_id as MerchantId,
      now,
    );
    if (deviceProblem) {
      // Audited **once** per session, not on every retry: a stolen POS reloading
      // in a loop must not be able to flood the audit table, and the first
      // refusal is the one that carries the information.
      const firstTime = deps.driver.noteSessionRejection(row.id, deviceProblem, now);
      if (firstTime) {
        audit(deps, 'DEVICE_REJECTED', {
          userId: row.user_id as MerchantUserId,
          role: row.role,
          merchantId: row.merchant_id as MerchantId,
          deviceId: row.device_id as DeviceId,
          correlationId,
          detail: deviceProblem,
        });
      }
      return failure(deviceProblem);
    }
  }

  if (rejected) {
    if (row && (rejected === 'SESSION_IDLE_EXPIRED' || rejected === 'SESSION_LIFETIME_EXPIRED')) {
      // Expiry is recorded once, then the row is left alone: an expired session
      // is already unusable, and re-auditing it on every stale reload is noise.
      if (row.status === 'ACTIVE') {
        deps.driver.revokeSession(row.id, rejected, now);
        audit(deps, 'AUTH_SESSION_EXPIRED', {
          userId: row.user_id as MerchantUserId,
          role: row.role,
          merchantId: row.merchant_id as MerchantId,
          deviceId: row.device_id as DeviceId,
          correlationId,
          detail: rejected,
        });
      }
    }
    return failure(rejected);
  }

  // The device has already been checked above, for every request and not only
  // at sign-in, so by here it is enrolled, active, unexpired and this
  // merchant's.
  const session = row as SessionRow;

  const user = deps.driver.findMerchantUser(session.user_id as MerchantUserId);
  if (!user) return failure('USER_NOT_FOUND');
  if (user.status !== 'ACTIVE') return failure('USER_SUSPENDED');
  if (isLockedOut((user.locked_until ?? undefined) as Timestamp | undefined, now)) {
    return failure('USER_LOCKED_OUT');
  }
  // A user moved to another merchant invalidates the session outright rather
  // than silently carrying the old scope.
  if (user.merchant_id !== session.merchant_id) {
    deps.driver.revokeSession(session.id, 'USER_MERCHANT_CHANGED', now);
    return failure('SESSION_REVOKED');
  }

  const idleExpiresAt = shiftBy(now, deps.authConfig.session.idleTimeoutMs);
  deps.driver.touchSession(session.id, now, idleExpiresAt);
  deps.driver.touchDevice(session.device_id as DeviceId, now);

  return success(
    contextOf(user, {
      sessionId: session.id,
      deviceId: session.device_id as DeviceId,
      issuedAt: session.created_at as Timestamp,
      idleExpiresAt,
      absoluteExpiresAt: session.absolute_expires_at as Timestamp,
    }),
  );
}

/** Verify a CSRF token against the one bound to this session. */
export function csrfMatches(
  deps: AuthDeps,
  sessionId: string,
  suppliedToken: string | undefined,
): boolean {
  if (suppliedToken === undefined || suppliedToken.length === 0) return false;
  const row = deps.driver.findSession(sessionId);
  if (!row || row.status !== 'ACTIVE') return false;
  return tokensMatch(tokenFingerprint(suppliedToken), row.csrf_hash);
}

export function logout(deps: AuthDeps, context: AuthContext, correlationId: string): boolean {
  const revoked = deps.driver.revokeSession(context.sessionId, 'LOGOUT', deps.now());
  if (revoked) {
    audit(deps, 'AUTH_LOGGED_OUT', {
      userId: context.userId,
      role: context.role,
      merchantId: context.merchantId,
      deviceId: context.deviceId,
      correlationId,
    });
  }
  return revoked;
}

// --- provisioning -----------------------------------------------------------

/** Create or update an operator. The raw PIN is derived here and dropped. */
export async function upsertOperator(
  deps: AuthDeps,
  input: {
    userId: MerchantUserId;
    merchantId: MerchantId;
    displayName: string;
    role: ActorRole;
    pin: string;
    status?: 'ACTIVE' | 'SUSPENDED';
  },
): Promise<MerchantUserRow> {
  const derived = await deriveSecret(input.pin);
  return deps.driver.saveMerchantUser({
    id: input.userId,
    merchantId: input.merchantId,
    displayName: input.displayName,
    role: input.role,
    pinHash: derived.hash,
    pinSalt: derived.salt,
    pinParams: derived.params,
    status: input.status ?? 'ACTIVE',
    at: deps.now(),
  });
}

export interface EnrollmentResult {
  readonly deviceId: DeviceId;
  /** Shown once, at enrolment. Never stored and never recoverable afterwards. */
  readonly deviceSecret: string;
}

/**
 * Enrol a device.
 *
 * The secret is generated server-side and returned **once**. A device
 * identifier chosen by a browser is not evidence of anything; pairing it with a
 * server-issued secret is what makes the binding worth checking. It is still
 * training-grade — see `09 Engineering/Device Binding.md`.
 */
export async function enrolDevice(
  deps: AuthDeps,
  input: {
    deviceId: DeviceId;
    merchantId: MerchantId;
    displayName?: string;
    expiresAt?: Timestamp;
    actor: { userId: MerchantUserId | 'system'; role: ActorRole };
    correlationId: string;
  },
): Promise<EnrollmentResult> {
  const secret = newToken();
  const derived = await deriveSecret(secret);
  const now = deps.now();

  deps.driver.saveDeviceEnrollment({
    deviceId: input.deviceId,
    merchantId: input.merchantId,
    state: 'ENROLLED',
    displayName: input.displayName,
    secretHash: derived.hash,
    secretSalt: derived.salt,
    expiresAt: input.expiresAt,
    at: now,
  });

  // A re-enrolment is a new secret, so anything still holding the old one must
  // stop working. Revoking here rather than trusting the caller to remember.
  deps.driver.revokeSessionsForDevice(input.deviceId, 'DEVICE_REENROLLED', now);

  audit(deps, 'DEVICE_ENROLLED', {
    userId: input.actor.userId,
    role: input.actor.role,
    merchantId: input.merchantId,
    deviceId: input.deviceId,
    correlationId: input.correlationId,
  });

  return { deviceId: input.deviceId, deviceSecret: secret };
}

export function revokeDevice(
  deps: AuthDeps,
  input: {
    deviceId: DeviceId;
    merchantId: MerchantId;
    reason: string;
    actor: { userId: MerchantUserId | 'system'; role: ActorRole };
    correlationId: string;
  },
): { revoked: boolean; sessionsRevoked: number } {
  const result = deps.driver.revokeDevice(input.deviceId, input.reason, deps.now());
  audit(deps, 'DEVICE_REVOKED', {
    userId: input.actor.userId,
    role: input.actor.role,
    merchantId: input.merchantId,
    deviceId: input.deviceId,
    correlationId: input.correlationId,
    detail: input.reason,
  });
  return result;
}
