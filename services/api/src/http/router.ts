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
import {
  getBalance,
  getOrder,
  getQueue,
  getReceipt,
  getTransaction,
  postReprint,
  listTransactions,
  meta,
  getSettings,
  postAuthorizeOrder,
  postCancelOrder,
  postDeposit,
  getBankDepositOrder,
  postBankDepositOrder,
  postChapaDeposit,
  postCancelBankDepositOrder,
  postProfitTransfer,
  postShopTransferRequest,
  postChangePin,
  postOrder,
  postSale,
  postSettings,
} from './handlers';
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
  // Receipts. Lookup is a pure read; reprint records an audit event and
  // nothing else — no sale, no ledger entry, no timestamp change.
  {
    method: 'GET',
    pattern: `${TRAINING_PREFIX}/transactions/:id/receipt`,
    permission: 'POS_VIEW_TRANSACTION',
    handler: getReceipt,
  },
  {
    method: 'POST',
    pattern: `${TRAINING_PREFIX}/transactions/:id/reprint`,
    permission: 'POS_VIEW_TRANSACTION',
    write: true,
    handler: postReprint,
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

  // Voucher pending orders. `authorize` carries its own PIN_AUTH rate limit
  // and lockout inside `authorizeOrder`, mirroring how `login()` carries its
  // own — so no `rateScope` is declared here for it.
  {
    method: 'POST',
    pattern: `${TRAINING_PREFIX}/orders`,
    permission: 'POS_CREATE_SALE',
    write: true,
    rateScope: 'SALE',
    handler: (d, r, c, id) => postOrder(d, r, c, id),
  },
  {
    method: 'GET',
    pattern: `${TRAINING_PREFIX}/orders/:id`,
    permission: 'POS_CREATE_SALE',
    handler: getOrder,
  },
  {
    method: 'POST',
    pattern: `${TRAINING_PREFIX}/orders/:id/cancel`,
    permission: 'POS_CREATE_SALE',
    write: true,
    handler: postCancelOrder,
  },
  {
    method: 'POST',
    pattern: `${TRAINING_PREFIX}/orders/:id/authorize`,
    permission: 'POS_CREATE_SALE',
    write: true,
    handler: postAuthorizeOrder,
  },

  // Shop settings. The read is granted to every operator because a slip has
  // to print with the shop's chosen width and advertising line whoever is at
  // the counter; the write is owner-only, so an assistant cannot change the
  // displayed training margin.
  {
    method: 'GET',
    pattern: `${TRAINING_PREFIX}/settings`,
    permission: 'POS_VIEW_HOME',
    handler: (d, r, c, id) => getSettings(d, r, c, id),
  },
  {
    method: 'POST',
    pattern: `${TRAINING_PREFIX}/settings`,
    permission: 'POS_MANAGE_SETTINGS',
    write: true,
    handler: (d, r, c, id) => postSettings(d, r, c, id),
  },

  // Telga Pay training deposit. Owner-only and rate-limited as a sale is,
  // because it is the one path in this build that adds value to a float.
  // It is not payment acceptance — see `application/deposits.ts` and D70.
  {
    method: 'POST',
    pattern: `${TRAINING_PREFIX}/pay/deposits`,
    permission: 'POS_DEPOSIT_TRAINING_FUNDS',
    write: true,
    rateScope: 'SALE',
    handler: (d, r, c, id) => postDeposit(d, r, c, id),
  },

  // Moving earned profit into the selling balance. Owner-only: it changes
  // what the shop can sell with, and an assistant should not be able to.
  // Rate-limited as a sale is, and a write, so CSRF applies.
  {
    method: 'POST',
    pattern: `${TRAINING_PREFIX}/profit/transfers`,
    permission: 'POS_DEPOSIT_TRAINING_FUNDS',
    write: true,
    rateScope: 'SALE',
    handler: (d, r, c, id) => postProfitTransfer(d, r, c, id),
  },

  // Sending balance to another shop — §19.1, and a **regulated** activity kept
  // to a training simulation. Owner-only and rate-limited like a sale: it
  // parts with the shop's own money, and an assistant must not be able to.
  {
    method: 'POST',
    pattern: `${TRAINING_PREFIX}/transfers`,
    permission: 'POS_DEPOSIT_TRAINING_FUNDS',
    write: true,
    rateScope: 'SALE',
    handler: (d, r, c, id) => postShopTransferRequest(d, r, c, id),
  },

  // Starting a Chapa payment — §20.2. Owner-only and rate-limited like a sale:
  // it creates a reference Telga will honour, and a till that could mint them
  // unboundedly is a till that can fill the table with payments nobody makes.
  {
    method: 'POST',
    pattern: `${TRAINING_PREFIX}/deposits/chapa`,
    permission: 'POS_DEPOSIT_TRAINING_FUNDS',
    write: true,
    rateScope: 'SALE',
    handler: (d, r, c, id) => postChapaDeposit(d, r, c, id),
  },

  // --- bank deposit slips — §20.1 -------------------------------------------
  //
  // Asking for a slip. Owner-only and rate-limited like a sale: it creates a
  // reference Telga will later honour, and a till that could mint them
  // unboundedly is a till that can fill the table with paper nobody pays.
  //
  // **A write that moves no money.** CSRF still applies, because it changes
  // stored state and prints something a person acts on.
  {
    method: 'POST',
    pattern: `${TRAINING_PREFIX}/deposits/orders`,
    permission: 'POS_DEPOSIT_TRAINING_FUNDS',
    write: true,
    rateScope: 'SALE',
    handler: (d, r, c, id) => postBankDepositOrder(d, r, c, id),
  },
  {
    method: 'GET',
    pattern: `${TRAINING_PREFIX}/deposits/orders/open`,
    permission: 'POS_DEPOSIT_TRAINING_FUNDS',
    write: false,
    handler: (d, r, c, id) => getBankDepositOrder(d, r, c, id),
  },
  {
    method: 'POST',
    pattern: `${TRAINING_PREFIX}/deposits/orders/cancel`,
    permission: 'POS_DEPOSIT_TRAINING_FUNDS',
    write: true,
    rateScope: 'SALE',
    handler: (d, r, c, id) => postCancelBankDepositOrder(d, r, c, id),
  },

  // Changing a transaction PIN. Owner-only, because it changes who can
  // authorize a sale. The new PIN travels in the body and is hashed
  // immediately; it is never logged, echoed, or stored in any other form.
  {
    method: 'POST',
    pattern: `${TRAINING_PREFIX}/operators/pin`,
    permission: 'POS_MANAGE_SETTINGS',
    write: true,
    rateScope: 'SALE',
    handler: (d, r, c, id) => postChangePin(d, r, c, id),
  },
]);

function match(pattern: string, path: string): Readonly<Record<string, string>> | undefined {
  const expected = pattern.split('/');
  const actual = path.split('/');
  if (expected.length !== actual.length) return undefined;

  const params: Record<string, string> = {};
  for (let i = 0; i < expected.length; i += 1) {
    const segment = expected[i];
    const value = actual[i];
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

export type RouterDeps = AuthedApiDeps;

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
