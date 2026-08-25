/**
 * The route table.
 *
 * A list of rows, matched in order. Each row names its HTTP method, its path
 * pattern, the **permission it requires**, and whether it writes. Patterns
 * carry `:name` segments and nothing else — no hand-written regular
 * expressions, no framework, and no way to register a route twice without it
 * being visible in one screenful.
 *
 * ## Protection is a property of the table, not of the handler
 *
 * Every row except the login route declares a permission, and `handle()` runs
 * the guard from that declaration before the handler is called. A new route
 * cannot be added without stating what it requires, and a handler cannot
 * accidentally be reachable unauthenticated — the type demands a permission for
 * anything not explicitly marked `public`.
 *
 * ## Failures are uniform
 *
 * An unauthenticated request, a wrong-merchant request, a missing permission
 * and a nonexistent resource all produce a response whose body carries a safe
 * code and nothing about what exists. See `guard.ts`.
 */

import type { Permission } from '@telga/domain';
import type { AuthContext } from '../auth/context';
import { failure } from '../auth/context';
import { json } from './contract';
import type { HttpRequest, HttpResponse } from './contract';
import type { AuthedApiDeps } from './deps';
import { guard } from './guard';
import { getBalance, getQueue, getTransaction, listTransactions, meta, postSale } from './handlers';
import { getLiveness, getReadiness } from './health';
import {
  getSession,
  postEnrolDevice,
  postLogin,
  postLogout,
  refusal,
} from './authHandlers';

export const TRAINING_PREFIX = '/api/training';
export const HEALTH_PREFIX = '/api/health';

type ProtectedHandler = (
  deps: AuthedApiDeps,
  request: HttpRequest,
  context: AuthContext,
  correlationId: string,
  params: Readonly<Record<string, string>>,
) => HttpResponse | Promise<HttpResponse>;

type PublicHandler = (
  deps: AuthedApiDeps,
  request: HttpRequest,
  correlationId: string,
) => HttpResponse | Promise<HttpResponse>;

interface ProtectedRoute {
  readonly method: string;
  readonly pattern: string;
  readonly permission: Permission;
  readonly write?: boolean;
  readonly rateScope?: 'SALE';
  readonly handler: ProtectedHandler;
  readonly public?: false;
}

interface PublicRoute {
  readonly method: string;
  readonly pattern: string;
  readonly public: true;
  readonly handler: PublicHandler;
}

type Route = ProtectedRoute | PublicRoute;

export const ROUTES: readonly Route[] = Object.freeze([
  // Public, read-only, outside the training namespace on purpose: a process
  // supervisor or reverse proxy checks these without a session, and they must
  // work identically regardless of whether TRAINING_PREFIX ever changes.
  {
    method: 'GET',
    pattern: `${HEALTH_PREFIX}/live`,
    public: true,
    handler: (d, r, c) => getLiveness(d, r, c),
  },
  {
    method: 'GET',
    pattern: `${HEALTH_PREFIX}/ready`,
    public: true,
    handler: (d, r, c) => getReadiness(d, r, c),
  },

  // The only route that may be reached without a session. It carries its own
  // rate limit and lockout inside `login()`.
  { method: 'POST', pattern: `${TRAINING_PREFIX}/auth/login`, public: true, handler: postLogin },

  {
    method: 'POST',
    pattern: `${TRAINING_PREFIX}/auth/logout`,
    permission: 'POS_LOGOUT',
    write: true,
    handler: (d, r, c, id) => postLogout(d, r, c, id),
  },
  {
    method: 'GET',
    pattern: `${TRAINING_PREFIX}/auth/session`,
    permission: 'POS_LOGOUT',
    handler: (d, r, c, id) => getSession(d, r, c, id),
  },
  {
    method: 'POST',
    pattern: `${TRAINING_PREFIX}/auth/devices`,
    permission: 'DEVICE_ENROL',
    write: true,
    handler: (d, r, c, id) => postEnrolDevice(d, r, c, id),
  },

  {
    method: 'GET',
    pattern: `${TRAINING_PREFIX}/transactions`,
    permission: 'POS_VIEW_HISTORY',
    handler: (d, r, c, id) => listTransactions(d, r, c, id),
  },
  {
    method: 'GET',
    pattern: `${TRAINING_PREFIX}/transactions/:id`,
    permission: 'POS_VIEW_TRANSACTION',
    handler: getTransaction,
  },
  {
    method: 'GET',
    pattern: `${TRAINING_PREFIX}/queue`,
    permission: 'POS_VIEW_PENDING_QUEUE',
    handler: (d, r, c, id) => getQueue(d, r, c, id),
  },
  {
    method: 'GET',
    pattern: `${TRAINING_PREFIX}/balance`,
    permission: 'POS_VIEW_HOME',
    handler: (d, r, c, id) => getBalance(d, r, c, id),
  },
  {
    method: 'POST',
    pattern: `${TRAINING_PREFIX}/sales`,
    permission: 'POS_CREATE_SALE',
    write: true,
    rateScope: 'SALE',
    handler: (d, r, c, id) => postSale(d, r, c, id),
  },
]);

function match(pattern: string, path: string): Readonly<Record<string, string>> | undefined {
  const expected = pattern.split('/');
  const actual = path.split('/');
  if (expected.length !== actual.length) return undefined;

  const params: Record<string, string> = {};
  for (let i = 0; i < expected.length; i += 1) {
    const segment = expected[i] as string;
    const value = actual[i] as string;
    if (segment.startsWith(':')) {
      if (value.length === 0) return undefined;
      params[segment.slice(1)] = decodeURIComponent(value);
      continue;
    }
    if (segment !== value) return undefined;
  }
  return params;
}

/** Strip a trailing slash so `/queue` and `/queue/` are the same route. */
function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

/** A client-supplied correlation id, when it is safe to put in a log line. */
function correlationOf(deps: AuthedApiDeps, request: HttpRequest): string {
  const supplied = request.headers['x-telga-correlation-id'];
  if (typeof supplied === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(supplied)) return supplied;
  return deps.newId('corr');
}

export interface RouterDeps extends AuthedApiDeps {}

/**
 * Dispatch one request.
 *
 * The order is: match, size, guard, handle. An unhandled throw becomes a 500
 * carrying a correlation id and a safe code — never a stack trace and never an
 * exception message. A merchant who telephones support quotes the correlation
 * id; the message stays in the log.
 */
export async function handle(deps: RouterDeps, request: HttpRequest): Promise<HttpResponse> {
  const path = normalizePath(request.path);
  const correlationId = correlationOf(deps, request);

  let pathMatched = false;
  for (const route of ROUTES) {
    const params = match(route.pattern, path);
    if (params === undefined) continue;
    pathMatched = true;
    if (route.method !== request.method) continue;

    // Size is checked before anything reads the body meaningfully. The
    // transport also caps what it will buffer; this is the second limit, for a
    // caller that reaches the router by some other path.
    const oversize = tooLarge(deps, request);
    if (oversize) return refusal(deps, correlationId, failure('REQUEST_TOO_LARGE'));

    try {
      if (route.public === true) {
        return await route.handler(deps, request, correlationId);
      }
      const guarded = guard(
        deps,
        request,
        { permission: route.permission, write: route.write, rateScope: route.rateScope },
        correlationId,
      );
      if (!guarded.ok) return refusal(deps, correlationId, guarded);
      return await route.handler(deps, request, guarded.context, correlationId, params);
    } catch {
      return errorResponse(deps, correlationId, 500, 'SYSTEM_ERROR', 'UNEXPECTED_HANDLER_ERROR');
    }
  }

  if (pathMatched) {
    return errorResponse(deps, correlationId, 405, 'INVALID_REQUEST', 'METHOD_NOT_ALLOWED');
  }
  return errorResponse(deps, correlationId, 404, 'NOT_FOUND', 'ROUTE_NOT_FOUND');
}

/** A rough size check on an already-parsed body. Cheap, and never throws. */
function tooLarge(deps: AuthedApiDeps, request: HttpRequest): boolean {
  if (request.body === undefined) return false;
  try {
    return JSON.stringify(request.body).length > deps.authConfig.session.maxRequestBytes;
  } catch {
    // A body that cannot be serialised is not one we can size. Refuse it.
    return true;
  }
}

function errorResponse(
  deps: RouterDeps,
  correlationId: string,
  status: number,
  kind: string,
  reasonCode: string,
): HttpResponse {
  const envelope = {
    ok: false as const,
    error: {
      kind,
      reasonCode,
      messageKey: status >= 500 ? 'status.sales_unavailable' : 'error.permission.denied',
      status,
    },
    meta: meta(deps, correlationId),
  };
  return json(status, envelope, envelope.meta);
}
