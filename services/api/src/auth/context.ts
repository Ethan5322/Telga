/**
 * Authentication configuration and the authenticated context.
 *
 * `AuthContext` is what every protected handler receives instead of a merchant
 * id from a URL. It is produced only by `authenticate()`, and it is the *only*
 * thing downstream code is allowed to scope a query by.
 */

import type {
  ActorRole,
  DeviceId,
  LockoutPolicy,
  MerchantId,
  MerchantUserId,
  Timestamp,
} from '@telga/domain';

/** Every duration is configured, none is a constant buried in a handler. */
export interface SessionPolicy {
  /** Inactivity that ends a session. */
  readonly idleTimeoutMs: number;
  /** Maximum life of a session, however active. */
  readonly absoluteLifetimeMs: number;
  /** Sales allowed per session in `saleRateWindowMs`. */
  readonly maxSalesPerWindow: number;
  readonly saleRateWindowMs: number;
  /** Largest request body the API will read, in bytes. */
  readonly maxRequestBytes: number;
}

/**
 * Training values.
 *
 * **Not a production policy.** Real numbers depend on how a counter actually
 * behaves over a shift and are NOT YET CONFIRMED — see
 * `07 Governance/Decision Log.md`.
 */
export const TRAINING_SESSION_POLICY: SessionPolicy = Object.freeze({
  idleTimeoutMs: 15 * 60_000,
  absoluteLifetimeMs: 12 * 60 * 60_000,
  maxSalesPerWindow: 30,
  saleRateWindowMs: 60_000,
  maxRequestBytes: 16 * 1024,
});

export interface AuthConfig {
  readonly session: SessionPolicy;
  readonly lockout: LockoutPolicy;
  /**
   * Whether the cookie is marked `Secure`.
   *
   * False on the controlled training machine, which is served over plain HTTP.
   * That is a stated limitation, not an oversight: see
   * `09 Engineering/Authentication and Sessions.md`.
   */
  readonly secureCookies: boolean;
}

/**
 * The authenticated caller.
 *
 * Note what is **not** here: anything the client supplied. Every field is read
 * from the server-side session row, so a handler that scopes by
 * `context.merchantId` cannot be talked into scoping by someone else's.
 */
export interface AuthContext {
  readonly sessionId: string;
  readonly userId: MerchantUserId;
  readonly merchantId: MerchantId;
  readonly deviceId: DeviceId;
  readonly role: ActorRole;
  readonly displayName: string;
  readonly issuedAt: Timestamp;
  readonly idleExpiresAt: Timestamp;
  readonly absoluteExpiresAt: Timestamp;
  /** The CSRF token for this session, for embedding in a form. */
  readonly csrfToken?: string;
}

/** Why a request was refused. Every value is safe to log and safe to show. */
export type AuthFailureCode =
  | 'SESSION_MISSING'
  | 'SESSION_UNKNOWN'
  | 'SESSION_REVOKED'
  | 'SESSION_IDLE_EXPIRED'
  | 'SESSION_LIFETIME_EXPIRED'
  | 'DEVICE_NOT_ENROLLED'
  | 'DEVICE_REVOKED'
  | 'DEVICE_ENROLLMENT_EXPIRED'
  | 'DEVICE_NOT_ASSIGNED_TO_MERCHANT'
  | 'USER_NOT_FOUND'
  | 'USER_SUSPENDED'
  | 'USER_LOCKED_OUT'
  | 'PERMISSION_DENIED'
  | 'MERCHANT_SCOPE_MISMATCH'
  | 'CSRF_TOKEN_MISSING'
  | 'CSRF_TOKEN_INVALID'
  | 'RATE_LIMITED'
  | 'REQUEST_TOO_LARGE'
  | 'INVALID_CREDENTIALS';

export interface AuthFailure {
  readonly ok: false;
  readonly code: AuthFailureCode;
  /**
   * Whether the merchant should be sent to sign in again, as opposed to being
   * shown an access-denied page. A revoked device is *not* a sign-in problem
   * and must not send an operator round a login loop they cannot escape.
   */
  readonly reauthenticate: boolean;
  readonly messageKey: string;
}

export interface AuthSuccess {
  readonly ok: true;
  readonly context: AuthContext;
}

export type AuthResult = AuthSuccess | AuthFailure;

const REAUTH: readonly AuthFailureCode[] = [
  'SESSION_MISSING',
  'SESSION_UNKNOWN',
  'SESSION_REVOKED',
  'SESSION_IDLE_EXPIRED',
  'SESSION_LIFETIME_EXPIRED',
];

const MESSAGE_KEY: Readonly<Partial<Record<AuthFailureCode, string>>> = Object.freeze({
  SESSION_MISSING: 'error.session.expired',
  SESSION_UNKNOWN: 'error.session.expired',
  SESSION_REVOKED: 'error.session.expired',
  SESSION_IDLE_EXPIRED: 'error.session.expired',
  SESSION_LIFETIME_EXPIRED: 'error.session.expired',
  INVALID_CREDENTIALS: 'error.permission.denied',
});

export function failure(code: AuthFailureCode): AuthFailure {
  return {
    ok: false,
    code,
    reauthenticate: REAUTH.includes(code),
    messageKey: MESSAGE_KEY[code] ?? 'error.permission.denied',
  };
}

export const success = (context: AuthContext): AuthSuccess => ({ ok: true, context });

/**
 * Add milliseconds to a timestamp.
 *
 * Named `shiftBy` rather than `addMs` because the orchestration already exports
 * an `addMs`, and two identically named helpers re-exported from one package
 * index is an ambiguity the compiler resolves by dropping both.
 */
export function shiftBy(at: Timestamp, ms: number): Timestamp {
  return new Date(new Date(at).getTime() + ms).toISOString() as Timestamp;
}
