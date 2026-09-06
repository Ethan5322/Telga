/**
 * Telga staff authentication.
 *
 * Deliberately a separate module from `sessions.ts`, which authenticates
 * **merchant** users. They share the cryptography in `secrets.ts` and nothing
 * else: a code path that could return either kind of session is a code path
 * that could authorise the wrong one.
 *
 * ## Three gates, not one
 *
 * Signing in proves a password. That is the *first* gate and it is not enough
 * to do anything:
 *
 *   1. **Password** — issues a session with `mfaSatisfied` false.
 *   2. **Second factor** — flips it true. Until then `requireAdmin` refuses
 *      every permission, including reading.
 *   3. **Step-up** — a fresh proof, required again for anything that moves
 *      money or changes who can reach a shop.
 *
 * A session that has cleared the first gate only can do exactly one useful
 * thing: enrol a second factor. That is not a loophole, it is the bootstrap —
 * an admin has to be able to sign in once in order to set one up.
 *
 * ## What a refusal says
 *
 * `INVALID_CREDENTIALS` for a wrong password, an unknown email, and a
 * suspended account alike. Telling an attacker which of the three they hit is
 * how an account list gets enumerated. The audit log records the real reason;
 * the response does not.
 */

import {
  ADMIN_ROLE_PERMISSIONS,
  effectivePermissions,
} from '@telga/domain';
import type {
  AdminAuthContext,
  AdminDepartment,
  AdminPermission,
  AdminRole,
  AdminStatus,
  AdminUser,
  Timestamp,
} from '@telga/domain';
import {
  findAdminSession,
  findAdminUser,
  findAdminUserByEmail,
  listAdminGrants,
  markAdminMfaSatisfied,
  markAdminSteppedUp,
  recordAdminLoginFailure,
  recordAdminLoginSuccess,
  revokeAdminSession,
  revokeAllAdminSessions,
  setAdminMfaSecret,
  saveAdminSession,
  touchAdminSession,
} from '@telga/persistence';
import type { AdminUserRow } from '@telga/persistence';
import { deriveSecret, newToken, tokenFingerprint, verifySecret } from './secrets';
import { formatSecretForEntry, newTotpSecret, totpUri, verifyTotp } from './totp';

/**
 * Windows and thresholds.
 *
 * Shorter than the merchant session's on purpose: a console that can suspend
 * merchants and approve funding is worth more to an attacker than one POS, and
 * an admin re-authenticating is an inconvenience rather than a lost sale.
 */
export const ADMIN_AUTH_POLICY = Object.freeze({
  /** Failed sign-ins before the account locks. */
  lockAfterAttempts: 5,
  lockForMs: 15 * 60 * 1000,
  /** Inactivity before the session dies. */
  idleTimeoutMs: 15 * 60 * 1000,
  /** Hard ceiling, however active the session is. */
  absoluteTimeoutMs: 8 * 60 * 60 * 1000,
});

export type AdminLoginRefusal =
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'MFA_REQUIRED'
  | 'MFA_INVALID';

export type AdminLoginResult =
  | {
      readonly kind: 'AUTHENTICATED';
      readonly sessionToken: string;
      readonly csrfToken: string;
      readonly user: AdminUser;
      /** False until the second factor is cleared. Nothing works while it is. */
      readonly mfaSatisfied: boolean;
    }
  | { readonly kind: 'REFUSED'; readonly reason: AdminLoginRefusal };

/** The database handle, however the caller's driver exposes it. */
type Handle = Parameters<typeof findAdminUserByEmail>[0];

export interface AdminAuthPorts {
  readonly db: Handle;
  readonly now: () => string;
  readonly newId: (prefix: string) => string;
}

/** A row plus its grants, as the domain model wants it. */
export function toAdminUser(row: AdminUserRow, grants: readonly string[]): AdminUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    department: row.department as AdminDepartment,
    role: row.role as AdminRole,
    status: row.status as AdminStatus,
    mfaEnrolled: row.mfa_secret_hash !== null,
    // Only grants the role system still knows about. A permission removed from
    // the code but left in the table must not resurrect itself.
    grants: grants.filter((g): g is AdminPermission =>
      (ADMIN_ROLE_PERMISSIONS.PLATFORM_OWNER as readonly string[]).includes(g),
    ),
    createdBy: row.created_by,
    approvedBy: row.approved_by,
  };
}

const isLocked = (row: AdminUserRow, now: string): boolean =>
  row.locked_until !== null && Date.parse(row.locked_until) > Date.parse(now);

/**
 * Sign in with email and password.
 *
 * The password is verified **even when the account is unknown or suspended**,
 * against a throwaway hash. Skipping the work would make a missing account
 * answer faster than a real one, and that timing difference is how an account
 * list gets enumerated.
 */
export async function adminLogin(
  ports: AdminAuthPorts,
  request: { readonly email: string; readonly password: string },
): Promise<AdminLoginResult> {
  const now = ports.now();
  const row = findAdminUserByEmail(ports.db, request.email);

  if (row === undefined) {
    // Same work, thrown away. The response and the timing both have to look
    // like a wrong password.
    await verifySecret(request.password, {
      hash: 'ZGVjb3k=',
      salt: 'ZGVjb3k=',
      params: 'scrypt$N=16384,r=8,p=1,len=64',
    });
    return { kind: 'REFUSED', reason: 'INVALID_CREDENTIALS' };
  }

  if (isLocked(row, now)) return { kind: 'REFUSED', reason: 'ACCOUNT_LOCKED' };

  const ok = await verifySecret(request.password, {
    hash: row.password_hash,
    salt: row.password_salt,
    params: row.password_params,
  });

  if (!ok || row.status !== 'ACTIVE') {
    // A suspended account with the right password is still refused, and is
    // refused *identically* to a wrong one.
    recordAdminLoginFailure(
      ports.db,
      row.id,
      now,
      ADMIN_AUTH_POLICY.lockAfterAttempts,
      new Date(Date.parse(now) + ADMIN_AUTH_POLICY.lockForMs).toISOString(),
    );
    return { kind: 'REFUSED', reason: 'INVALID_CREDENTIALS' };
  }

  recordAdminLoginSuccess(ports.db, row.id, now);

  const sessionToken = newToken();
  const csrfToken = newToken();
  saveAdminSession(ports.db, {
    id: tokenFingerprint(sessionToken),
    adminUserId: row.id,
    role: row.role,
    csrfHash: tokenFingerprint(csrfToken),
    at: now,
    idleExpiresAt: new Date(Date.parse(now) + ADMIN_AUTH_POLICY.idleTimeoutMs).toISOString(),
    absoluteExpiresAt: new Date(
      Date.parse(now) + ADMIN_AUTH_POLICY.absoluteTimeoutMs,
    ).toISOString(),
  });

  const grants = listAdminGrants(ports.db, row.id).map((g) => g.permission);
  return {
    kind: 'AUTHENTICATED',
    sessionToken,
    csrfToken,
    user: toAdminUser(row, grants),
    // Always false. The password is the first gate, never the last.
    mfaSatisfied: false,
  };
}

export type AdminAuthFailure =
  | 'SESSION_MISSING'
  | 'SESSION_UNKNOWN'
  | 'SESSION_REVOKED'
  | 'SESSION_IDLE_EXPIRED'
  | 'SESSION_LIFETIME_EXPIRED'
  | 'ACCOUNT_INACTIVE';

export type AdminAuthResult =
  | { readonly ok: true; readonly context: AdminAuthContext; readonly sessionId: string }
  | { readonly ok: false; readonly reason: AdminAuthFailure };

/**
 * Resolve a session token into an admin context.
 *
 * The account's **current** status is read on every request, not trusted from
 * the session row. Suspending an admin has to take effect on their next
 * request, not on their next sign-in.
 */
export function authenticateAdmin(
  ports: AdminAuthPorts,
  sessionToken: string | undefined,
): AdminAuthResult {
  if (sessionToken === undefined || sessionToken.length === 0) {
    return { ok: false, reason: 'SESSION_MISSING' };
  }
  const now = ports.now();
  const id = tokenFingerprint(sessionToken);
  const session = findAdminSession(ports.db, id);
  if (session === undefined) return { ok: false, reason: 'SESSION_UNKNOWN' };
  if (session.status !== 'ACTIVE') return { ok: false, reason: 'SESSION_REVOKED' };

  if (Date.parse(session.absolute_expires_at) <= Date.parse(now)) {
    revokeAdminSession(ports.db, id, now, 'LIFETIME_EXPIRED');
    return { ok: false, reason: 'SESSION_LIFETIME_EXPIRED' };
  }
  if (Date.parse(session.idle_expires_at) <= Date.parse(now)) {
    revokeAdminSession(ports.db, id, now, 'IDLE_EXPIRED');
    return { ok: false, reason: 'SESSION_IDLE_EXPIRED' };
  }

  const user = adminById(ports, session.admin_user_id);
  if (user === undefined || user.status !== 'ACTIVE') {
    return { ok: false, reason: 'ACCOUNT_INACTIVE' };
  }

  touchAdminSession(
    ports.db,
    id,
    now,
    new Date(Date.parse(now) + ADMIN_AUTH_POLICY.idleTimeoutMs).toISOString(),
  );

  return {
    ok: true,
    sessionId: id,
    context: {
      user,
      mfaSatisfied: session.mfa_satisfied === 1,
      steppedUpAt: session.stepped_up_at as Timestamp | null,
    },
  };
}

/** An admin and their grants, by id. */
export function adminById(ports: AdminAuthPorts, id: string): AdminUser | undefined {
  const row = findAdminUser(ports.db, id);
  if (row === undefined) return undefined;
  return toAdminUser(row, listAdminGrants(ports.db, id).map((g) => g.permission));
}

// --- the second factor -----------------------------------------------------

/**
 * Begin enrolling a second factor.
 *
 * Returns the secret **once**, for the admin to put into an authenticator app.
 * It is stored so codes can be derived later — a TOTP secret is a shared key,
 * not a password, and hashing it would make verification impossible.
 *
 * That is the trade TOTP makes: the secret is at rest and readable by anything
 * that can read the row. It is why `admin_users` is on the platform database
 * and why a passkey (D105) remains the destination — a passkey leaves nothing
 * verifiable behind at all.
 */
export function beginMfaEnrolment(
  ports: AdminAuthPorts,
  adminUserId: string,
  account: string,
): { secret: string; uri: string; entry: string } {
  const secret = newTotpSecret();
  setAdminMfaSecret(ports.db, adminUserId, secret, ports.now());
  return {
    secret,
    uri: totpUri(secret, account),
    entry: formatSecretForEntry(secret),
  };
}

/**
 * Clear the second factor for this session, against the admin's TOTP secret.
 *
 * **This replaced a code Telga generated and showed on the screen that asked
 * for it.** That exercised the gate but proved nothing — the answer was
 * visible to anyone who could reach the page. A TOTP code is derived
 * independently on both sides from the shared secret and the clock, so there
 * is nothing to display and nothing to intercept.
 *
 * An account with no secret enrolled cannot clear the factor. It is not an
 * error — it is an admin who has not finished enrolling — and the caller sends
 * them to enrolment.
 */
export async function satisfyAdminMfa(
  ports: AdminAuthPorts,
  sessionId: string,
  adminUserId: string,
  supplied: string,
): Promise<boolean> {
  const row = findAdminUser(ports.db, adminUserId);
  if (row?.mfa_secret_hash == null || row.mfa_secret_hash.length === 0) return false;
  const ok = verifyTotp(row.mfa_secret_hash, supplied, Date.parse(ports.now()));
  if (ok) markAdminMfaSatisfied(ports.db, sessionId, ports.now());
  return Promise.resolve(ok);
}

/**
 * Re-prove identity for a high-risk action.
 *
 * The **password**, not the second factor: a step-up asks "is this still the
 * person who signed in", and a code from a device left on the desk beside the
 * laptop does not answer that.
 */
export async function stepUpAdmin(
  ports: AdminAuthPorts,
  sessionId: string,
  adminUserId: string,
  password: string,
): Promise<boolean> {
  const row = findAdminUser(ports.db, adminUserId);
  if (row === undefined) return false;
  const ok = await verifySecret(password, {
    hash: row.password_hash,
    salt: row.password_salt,
    params: row.password_params,
  });
  if (ok) markAdminSteppedUp(ports.db, sessionId, ports.now());
  return ok;
}

/** Hash a password or an MFA code for storage. Never stores the value itself. */
export const hashAdminSecret = deriveSecret;

/**
 * End every session an admin holds.
 *
 * What suspension and a password change both need: a credential that has
 * changed must not leave a session issued under the old one still working.
 */
export function revokeAdminEverywhere(
  ports: AdminAuthPorts,
  adminUserId: string,
  reason: string,
): number {
  return revokeAllAdminSessions(ports.db, adminUserId, ports.now(), reason);
}

/** What this admin may do right now, for a screen deciding what to render. */
export const permissionsFor = (context: AdminAuthContext): readonly AdminPermission[] =>
  context.mfaSatisfied ? effectivePermissions(context.user) : [];
