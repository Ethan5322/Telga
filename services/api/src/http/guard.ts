/**
 * The request guard.
 *
 * Everything a protected route must survive before a handler sees it, in the
 * order it has to happen:
 *
 *   1. **Size.** A body larger than the policy is refused before it is parsed.
 *   2. **Session.** Resolved from the cookie, never from a query parameter, a
 *      header the page could set, or a form field.
 *   3. **Device.** Re-checked on every request inside `authenticate`.
 *   4. **Permission.** The role must hold the route's permission.
 *   5. **CSRF.** Writes only, and after authentication, so a forged request
 *      without a session fails as unauthenticated rather than as a token
 *      mismatch.
 *   6. **Rate limit.** Writes only.
 *   7. **Merchant hint.** A client-supplied merchant id is compared with the
 *      session's and refused when they disagree — it is a consistency check,
 *      never a grant.
 *
 * A refusal at any step returns before the handler runs, so no route can
 * accidentally read a resource while deciding whether it was allowed to.
 */

import type { Permission } from '@telga/domain';
import type { AuthContext, AuthFailure, AuthFailureCode } from '../auth/context';
import { failure } from '../auth/context';
import { authorize, consistentMerchantHint, isAllowed } from '../auth/authorize';
import { CSRF_COOKIE, CSRF_HEADER, CSRF_FIELD, SESSION_COOKIE, parseCookies } from '../auth/cookies';
import { authenticate, csrfMatches, shiftByForRate } from './rate';
import type { AuthedApiDeps } from './deps';
import type { HttpRequest } from './contract';

export interface GuardOptions {
  /** The permission this route requires. */
  readonly permission: Permission;
  /** True for anything that writes. Adds CSRF and the sale rate limit. */
  readonly write?: boolean;
  /** Rate-limit scope, when the route is rate-limited. */
  readonly rateScope?: 'SALE';
}

export type GuardResult = { ok: true; context: AuthContext } | AuthFailure;

/** HTTP status for each refusal. 401 means "sign in"; 403 means "not for you". */
export function statusFor(code: AuthFailureCode): number {
  switch (code) {
    case 'SESSION_MISSING':
    case 'SESSION_UNKNOWN':
    case 'SESSION_REVOKED':
    case 'SESSION_IDLE_EXPIRED':
    case 'SESSION_LIFETIME_EXPIRED':
    case 'INVALID_CREDENTIALS':
      return 401;
    case 'RATE_LIMITED':
      return 429;
    case 'REQUEST_TOO_LARGE':
      return 413;
    default:
      // Everything else — a revoked device, a wrong merchant, a missing
      // permission, a bad CSRF token — is 403. Deliberately uniform: a caller
      // must not be able to tell a scope mismatch from a missing resource.
      return 403;
  }
}

export function sessionTokenOf(request: HttpRequest): string | undefined {
  const cookies = parseCookies(request.headers['cookie']);
  return cookies[SESSION_COOKIE];
}

/** The CSRF token a browser submitted: form field first, then header. */
export function csrfTokenOf(request: HttpRequest): string | undefined {
  const body = request.body;
  if (typeof body === 'object' && body !== null) {
    const supplied = (body as Record<string, unknown>)[CSRF_FIELD];
    if (typeof supplied === 'string' && supplied.length > 0) return supplied;
  }
  const header = request.headers[CSRF_HEADER];
  if (typeof header === 'string' && header.length > 0) return header;
  return undefined;
}

export function guard(
  deps: AuthedApiDeps,
  request: HttpRequest,
  options: GuardOptions,
  correlationId: string,
): GuardResult {
  const result = authenticate(deps, sessionTokenOf(request), correlationId);
  if (!result.ok) return result;
  const context = result.context;

  const permitted = authorize(context, options.permission);
  if (!isAllowed(permitted)) return permitted;

  if (options.write === true) {
    if (!csrfMatches(deps, context.sessionId, csrfTokenOf(request))) {
      return failure(
        csrfTokenOf(request) === undefined ? 'CSRF_TOKEN_MISSING' : 'CSRF_TOKEN_INVALID',
      );
    }
  }

  if (options.rateScope === 'SALE') {
    const since = shiftByForRate(deps.now(), deps.authConfig.session.saleRateWindowMs);
    const recent = deps.driver.countAttemptsSince('SALE', context.sessionId, since);
    if (recent >= deps.authConfig.session.maxSalesPerWindow) {
      return failure('RATE_LIMITED');
    }
  }

  // A merchant id in the URL or the form is checked for agreement and then
  // discarded. Nothing downstream reads it.
  const hint =
    request.query['merchantId'] ??
    (typeof request.body === 'object' && request.body !== null
      ? ((request.body as Record<string, unknown>)['merchantId'] as string | undefined)
      : undefined);
  const consistent = consistentMerchantHint(context, hint);
  if (!isAllowed(consistent)) return consistent;

  return { ok: true, context };
}

export { CSRF_COOKIE, SESSION_COOKIE };
