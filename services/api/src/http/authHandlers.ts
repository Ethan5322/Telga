/**
 * Sign-in, sign-out, session read, and device enrolment over HTTP.
 *
 * ## Why login is the only unauthenticated route
 *
 * Everything else needs a session by definition. Login is the one place a
 * request arrives with nothing, so it carries its own protections rather than
 * the guard's: the rate limit and the lockout live inside `login()`, before any
 * expensive work happens.
 *
 * ## Set-Cookie, and only here
 *
 * Two cookies are issued on a successful sign-in and cleared on sign-out. No
 * other handler in the codebase writes a `Set-Cookie` header, so the session
 * lifecycle is readable in one file.
 *
 * ## What a response never contains
 *
 * The session token appears in a `Set-Cookie` header and nowhere else — not in
 * a body, not in a URL, not in a log. The CSRF token likewise travels only in
 * its own readable cookie.
 *
 * There is exactly **one** exception, and it is deliberate: the device key
 * returned by enrolment. `assertSafeForDisplay` refuses any body carrying a key
 * that names a secret, so that response is built without the gate rather than
 * by weakening it — see `okShownOnce` at the bottom of this file.
 */

import type { DeviceId, MerchantUserId } from '@telga/domain';
import type { ApiEnvelope } from '@telga/pos-view-model';
import { failure } from '../auth/context';
import type { AuthContext } from '../auth/context';
import { CSRF_COOKIE, SESSION_COOKIE, clearCookie, serializeCookie } from '../auth/cookies';
import { enrolDevice, login, logout } from '../auth/sessions';
import { json } from './contract';
import type { HttpRequest, HttpResponse } from './contract';
import type { AuthedApiDeps } from './deps';
import { statusFor } from './guard';
import { fail, meta, ok } from './handlers';

/**
 * What the POS is told about the signed-in operator.
 *
 * No secrets, no hashes — and deliberately **no CSRF token**. The token reaches
 * the page in its own readable cookie, and `assertSafeForDisplay` refuses any
 * response body carrying a key that names a token. Putting it here would have
 * meant loosening that gate for every response in order to serve one, so the
 * cookie carries it and the gate stays absolute.
 */
export interface SessionDto {
  readonly userId: string;
  readonly displayName: string;
  readonly merchantId: string;
  readonly deviceId: string;
  readonly role: string;
  readonly issuedAt: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
}

export function toSessionDto(context: AuthContext): SessionDto {
  return {
    userId: context.userId,
    displayName: context.displayName,
    merchantId: context.merchantId,
    deviceId: context.deviceId,
    role: context.role,
    issuedAt: context.issuedAt,
    idleExpiresAt: context.idleExpiresAt,
    absoluteExpiresAt: context.absoluteExpiresAt,
  };
}

function cookieOptions(deps: AuthedApiDeps): { secure: boolean } {
  return { secure: deps.authConfig.secureCookies };
}

function credentialsOf(body: unknown): {
  userId: string;
  pin: string;
  deviceId: string;
  deviceSecret: string;
} | string {
  if (typeof body !== 'object' || body === null) return 'BODY_NOT_AN_OBJECT';
  const b = body as Record<string, unknown>;
  const fields = ['userId', 'pin', 'deviceId', 'deviceSecret'] as const;
  const out: Record<string, string> = {};
  for (const field of fields) {
    const value = b[field];
    if (typeof value !== 'string' || value.length === 0) return 'CREDENTIALS_INCOMPLETE';
    // A generous cap, purely so an oversized field cannot reach scrypt.
    if (value.length > 512) return 'CREDENTIALS_INCOMPLETE';
    out[field] = value;
  }
  return out as { userId: string; pin: string; deviceId: string; deviceSecret: string };
}

/**
 * `POST /api/training/auth/login`
 *
 * On success the response carries two `Set-Cookie` headers and a fresh session
 * id. The id is new every time, which is what defeats session fixation: an
 * identifier planted on the client before sign-in is not the one that ends up
 * authenticating anything.
 */
export async function postLogin(
  deps: AuthedApiDeps,
  request: HttpRequest,
  correlationId: string,
): Promise<HttpResponse> {
  if (deps.mode !== 'TRAINING') {
    return fail(deps, correlationId, 403, 'SIMULATED_ONLY', 'LIVE_MODE_REFUSED', 'mode.training');
  }

  const credentials = credentialsOf(request.body);
  if (typeof credentials === 'string') {
    // The same shape as a wrong PIN, so a malformed body is not a probe that
    // tells an attacker which field they got wrong.
    return refusal(deps, correlationId, failure('INVALID_CREDENTIALS'));
  }

  const result = await login(
    deps,
    {
      userId: credentials.userId as MerchantUserId,
      pin: credentials.pin,
      deviceId: credentials.deviceId as DeviceId,
      deviceSecret: credentials.deviceSecret,
    },
    correlationId,
  );

  if (!result.ok) return refusal(deps, correlationId, result);

  const response = ok<SessionDto>(deps, correlationId, toSessionDto(result.context), 200);
  return withCookies(response, [
    serializeCookie(SESSION_COOKIE, result.sessionToken, cookieOptions(deps)),
    // Readable by script on purpose — it is not a credential. See `cookies.ts`.
    serializeCookie(CSRF_COOKIE, result.csrfToken, {
      ...cookieOptions(deps),
      httpOnly: false,
    }),
  ]);
}

/** `POST /api/training/auth/logout` — revokes the session and clears the cookies. */
export function postLogout(
  deps: AuthedApiDeps,
  _request: HttpRequest,
  context: AuthContext,
  correlationId: string,
): HttpResponse {
  logout(deps, context, correlationId);
  const response = ok<{ loggedOut: true }>(deps, correlationId, { loggedOut: true });
  return withCookies(response, [
    clearCookie(SESSION_COOKIE, cookieOptions(deps)),
    clearCookie(CSRF_COOKIE, { ...cookieOptions(deps), httpOnly: false }),
  ]);
}

/** `GET /api/training/auth/session` — who am I, according to the server. */
export function getSession(
  deps: AuthedApiDeps,
  _request: HttpRequest,
  context: AuthContext,
  correlationId: string,
): HttpResponse {
  return ok<SessionDto>(deps, correlationId, toSessionDto(context));
}

/**
 * `POST /api/training/auth/devices`
 *
 * Enrol a device for the caller's own merchant. Requires `DEVICE_ENROL`, which
 * a plain operator does not hold. The secret is returned **once** and is not
 * recoverable afterwards.
 */
export async function postEnrolDevice(
  deps: AuthedApiDeps,
  request: HttpRequest,
  context: AuthContext,
  correlationId: string,
): Promise<HttpResponse> {
  const body = request.body;
  if (typeof body !== 'object' || body === null) {
    return fail(
      deps,
      correlationId,
      400,
      'INVALID_REQUEST',
      'BODY_NOT_AN_OBJECT',
      'error.validation.recipient',
    );
  }
  const deviceId = (body as Record<string, unknown>)['deviceId'];
  if (typeof deviceId !== 'string' || deviceId.trim().length === 0 || deviceId.length > 128) {
    return fail(
      deps,
      correlationId,
      400,
      'INVALID_REQUEST',
      'DEVICE_ID_REQUIRED',
      'error.validation.recipient',
    );
  }
  const displayName = (body as Record<string, unknown>)['displayName'];

  // The device row must exist and belong to this merchant already. Enrolment is
  // an authentication fact about a known device, not a way to create one.
  const device = deps.driver.findDevice(deviceId, context.merchantId);
  if (!device) {
    return fail(
      deps,
      correlationId,
      404,
      'NOT_FOUND',
      'DEVICE_NOT_FOUND',
      'error.permission.denied',
    );
  }

  const result = await enrolDevice(deps, {
    deviceId: deviceId as DeviceId,
    merchantId: context.merchantId,
    displayName: typeof displayName === 'string' ? displayName.slice(0, 64) : undefined,
    actor: { userId: context.userId, role: context.role },
    correlationId,
  });

  return okShownOnce(deps, correlationId, {
    deviceId: result.deviceId,
    deviceSecret: result.deviceSecret,
    shownOnce: true,
  });
}

/**
 * The one response that carries a secret.
 *
 * `ok()` runs `assertSafeForDisplay`, which refuses a body containing a key
 * that names a secret — and it is right to. Enrolment is the single case where
 * delivering a secret **is** the point: the device key is generated server-side,
 * hashed, and returned once because it cannot be recovered afterwards.
 *
 * This builds the response without that gate rather than loosening the gate for
 * every response in the system. Two consequences are load-bearing:
 *
 *   - the POS renders this straight into the page and **never redirects with
 *     it**, so it reaches no URL, no browser history and no access log;
 *   - `cache-control: no-store` is already on every response from `json()`.
 */
function okShownOnce(
  deps: AuthedApiDeps,
  correlationId: string,
  data: { deviceId: string; deviceSecret: string; shownOnce: true },
): HttpResponse {
  const envelope: ApiEnvelope<typeof data> = {
    ok: true,
    data,
    meta: meta(deps, correlationId),
  };
  return json(201, envelope, envelope.meta);
}

// --- helpers ----------------------------------------------------------------

/** Turn an auth failure into a response, with its `reauthenticate` hint intact. */
export function refusal(
  deps: AuthedApiDeps,
  correlationId: string,
  result: ReturnType<typeof failure>,
): HttpResponse {
  const status = statusFor(result.code);
  const envelope: ApiEnvelope<never> & { reauthenticate?: boolean } = {
    ok: false,
    error: {
      kind: result.reauthenticate ? 'REAUTHENTICATE' : 'ACCESS_DENIED',
      reasonCode: result.code,
      messageKey: result.messageKey,
      status,
    },
    meta: meta(deps, correlationId),
  };
  return json(status, envelope, envelope.meta);
}

function withCookies(response: HttpResponse, cookies: readonly string[]): HttpResponse {
  return {
    ...response,
    headers: { ...response.headers, 'set-cookie': cookies.join('\n') },
  };
}

/** The header value carrying one or more cookies, split back out for `node:http`. */
export const splitSetCookie = (value: string | undefined): readonly string[] =>
  value === undefined ? [] : value.split('\n');
