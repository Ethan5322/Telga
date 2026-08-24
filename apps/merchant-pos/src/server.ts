/**
 * The POS server.
 *
 * A thin adapter: `node:http` in, the API's `HttpRequest` out, screens rendered
 * from the same view models the client uses. It contains no business rule at
 * all — a route here either serves a screen or forwards to `handle()`.
 *
 * ## Identity comes from the session, on every route
 *
 * There is no merchant id in a URL, a form field or a link. `renderScreen`
 * takes an `AuthContext` produced by `authenticate()`, and every read it
 * performs goes through the API router, which guards itself independently. A
 * screen therefore cannot be rendered for a merchant nobody proved, and a
 * tampered URL has nothing to tamper with.
 *
 * ## Server-rendered, deliberately
 *
 * The counter screens render on the server and post ordinary forms. A POS on a
 * shop counter with an intermittent connection is better served by a page that
 * arrives complete than by one that arrives empty and then fetches. The client
 * script only *enhances*: it polls a transaction that is still in flight. With
 * scripting off, every screen still works and the operator refreshes.
 *
 * ## Training only
 *
 * `page()` throws for any mode but TRAINING, and `assertTrainingBoundary`
 * checks it once at startup, so a misconfigured server fails to boot rather
 * than serving a banner that lies.
 */

import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  authenticate,
  clearCookie,
  csrfMatches,
  handle,
  login,
  logout,
  serializeCookie,
} from '@telga/api';
import type { ApiDeps, AuthContext, AuthFailure, HttpRequest } from '@telga/api';
import { parseCookies } from '@telga/api';
import type { Locale } from '@telga/localization';
import { isLocale } from '@telga/localization';
import { toTransactionViewModel, succeed, succeedList } from '@telga/pos-view-model';
import type { RemoteData, TransactionDto, TransactionViewModel } from '@telga/pos-view-model';
import type { DeviceId, MerchantUserId } from '@telga/domain';
import { renderToHtml } from './ui/element';
import type { El } from './ui/element';
import type { Chrome } from './ui/chrome';
import { htmlDocument } from './ui/document';
import {
  accessDeniedScreen,
  deviceEnrolmentScreen,
  loginScreen,
  safeErrorScreen,
  sessionExpiredScreen,
} from './ui/authScreens';
import type { AuthChrome } from './ui/authScreens';
import {
  homeScreen,
  newSaleScreen,
  queueScreen,
  transactionDetailScreen,
  transactionHistoryScreen,
} from './ui/screens';
import type { CatalogEntry } from './ui/screens';
import { LOCAL_HTTP_DEFAULTS, terminatesTlsItself, validateTransport } from './transport/config';
import type { TransportConfig } from './transport/config';
import { loadTlsMaterial } from './transport/tls';
import {
  STATE_CHANGING,
  checkHost,
  checkOrigin,
  cookieSecureFor,
  resolveScheme,
} from './transport/proxy';
import type { ConnectionFacts, RequestScheme } from './transport/proxy';
import { newNonce, securityHeaders } from './transport/headers';

export interface PosServerOptions {
  readonly api: ApiDeps;
  readonly environment: string;
  readonly catalog: readonly CatalogEntry[];
  readonly simulatedBehaviours: readonly string[];
  readonly defaultLocale?: Locale;
  /**
   * How the deployment is reached. Defaults to loopback plain HTTP, which is
   * the only default safe enough to have one.
   */
  readonly transport?: TransportConfig;
}

const transportOf = (options: PosServerOptions): TransportConfig =>
  options.transport ?? LOCAL_HTTP_DEFAULTS;

export class NotTrainingModeError extends Error {
  readonly code = 'POS_SERVER_REFUSES_NON_TRAINING_MODE';
  constructor(mode: string) {
    super(`The merchant POS server starts in training mode only; configured mode is "${mode}"`);
    this.name = 'NotTrainingModeError';
  }
}

/** Called once at startup. A misconfigured server must not boot. */
export function assertTrainingBoundary(options: PosServerOptions): void {
  if (options.api.mode !== 'TRAINING') throw new NotTrainingModeError(options.api.mode);
}

function authChrome(options: PosServerOptions, locale: Locale): AuthChrome {
  return {
    locale,
    environment: options.environment,
    mode: options.api.mode,
    serverTime: options.api.now(),
  };
}

function chromeFor(
  options: PosServerOptions,
  context: AuthContext,
  locale: Locale,
  csrfToken: string | undefined,
): Chrome {
  return {
    locale,
    environment: options.environment,
    merchantId: context.merchantId,
    mode: options.api.mode,
    serverTime: options.api.now(),
    operatorName: context.displayName,
    operatorId: context.userId,
    deviceId: context.deviceId,
    csrfToken,
  };
}

function localeOf(options: PosServerOptions, query: URLSearchParams): Locale {
  const requested = query.get('locale');
  if (requested !== null && isLocale(requested)) return requested;
  return options.defaultLocale ?? 'en';
}

const views = (dtos: readonly TransactionDto[], locale: Locale): readonly TransactionViewModel[] =>
  dtos.map((dto) => toTransactionViewModel(dto, locale));

type ReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; reasonCode: string; messageKey: string; status: number; correlationId: string };

/**
 * Read through the API's own router rather than reaching into the driver.
 *
 * The screens therefore see exactly what a browser sees — the guard, the
 * merchant scoping and the redaction gate all included — so a leak or a scope
 * bug cannot exist on the server-rendered path while the fetched path stays
 * clean. The session cookie is passed through, so the router authenticates the
 * read independently of whatever this file already decided.
 */
async function readVia<T>(
  options: PosServerOptions,
  path: string,
  query: Record<string, string>,
  cookieHeader: string | undefined,
): Promise<ReadResult<T>> {
  const request: HttpRequest = {
    method: 'GET',
    path,
    query,
    headers: cookieHeader === undefined ? {} : { cookie: cookieHeader },
  };
  const response = await handle(options.api, request);
  const body = response.body as
    | { ok: true; data: T; meta: { correlationId: string } }
    | {
        ok: false;
        error: { reasonCode: string; messageKey: string; status: number };
        meta: { correlationId: string };
      };
  if (body.ok) return { ok: true, data: body.data };
  return {
    ok: false,
    reasonCode: body.error.reasonCode,
    messageKey: body.error.messageKey,
    status: body.error.status,
    correlationId: body.meta.correlationId,
  };
}

function remoteOf<T>(result: ReadResult<T>, at: string): RemoteData<T> {
  if (result.ok) return succeed(result.data, at);
  return {
    status: 'ERROR',
    failure: {
      reasonCode: result.reasonCode,
      messageKey: result.messageKey,
      status: result.status,
      correlationId: result.correlationId,
      at,
    },
  };
}

function remoteListOf(
  result: ReadResult<readonly TransactionDto[]>,
  locale: Locale,
  at: string,
): RemoteData<readonly TransactionViewModel[]> {
  if (result.ok) return succeedList(views(result.data, locale), at);
  return {
    status: 'ERROR',
    failure: {
      reasonCode: result.reasonCode,
      messageKey: result.messageKey,
      status: result.status,
      correlationId: result.correlationId,
      at,
    },
  };
}

export interface ScreenRequest {
  readonly path: string;
  readonly query: URLSearchParams;
  readonly context: AuthContext;
  /** Passed through to the API router so it authenticates each read itself. */
  readonly cookieHeader?: string;
  readonly csrfToken?: string;
  /**
   * The per-response CSP nonce.
   *
   * Required in practice — a page rendered without one loses its script and its
   * stylesheet under the policy — but defaulted here so a test that only cares
   * about markup does not have to invent one.
   */
  readonly nonce?: string;
}

interface QueueData {
  readonly pending: readonly TransactionDto[];
  readonly underReview: readonly TransactionDto[];
  readonly reversalRequired: readonly TransactionDto[];
}

/**
 * Render one authenticated screen.
 *
 * Exported so a test can drive it without a socket. It takes an `AuthContext`
 * rather than a merchant id, which is the whole point: there is no argument a
 * caller could supply to render somebody else's shop.
 */
export async function renderScreen(
  options: PosServerOptions,
  request: ScreenRequest,
): Promise<{ status: number; html: string } | undefined> {
  const { path, query, context } = request;
  const nonce = request.nonce ?? newNonce();
  const locale = localeOf(options, query);
  const chrome = chromeFor(options, context, locale, request.csrfToken);
  const at = options.api.now();
  const cookie = request.cookieHeader;

  if (path === '/' || path === '/home') {
    const [balance, recent, queueResult] = await Promise.all([
      readVia<Parameters<typeof homeScreen>[0]['balance'] extends RemoteData<infer B> ? B : never>(
        options,
        '/api/training/balance',
        {},
        cookie,
      ),
      readVia<readonly TransactionDto[]>(options, '/api/training/transactions', { limit: '5' }, cookie),
      readVia<QueueData>(options, '/api/training/queue', {}, cookie),
    ]);
    const needsAttention = queueResult.ok
      ? queueResult.data.pending.length +
        queueResult.data.underReview.length +
        queueResult.data.reversalRequired.length
      : 0;
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          homeScreen({
            chrome,
            balance: remoteOf(balance, at),
            recent: remoteListOf(recent, locale, at),
            needsAttention,
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  if (path === '/sell') {
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          newSaleScreen({
            chrome,
            catalog: options.catalog,
            csrfToken: request.csrfToken ?? '',
            // Generated when the form is built, so a double press is idempotent.
            clientRequestId: options.api.newId('req'),
            simulatedBehaviours: options.simulatedBehaviours,
            validationMessage: query.get('error') ?? undefined,
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  if (path === '/transactions') {
    const list = await readVia<readonly TransactionDto[]>(
      options,
      '/api/training/transactions',
      {},
      cookie,
    );
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          transactionHistoryScreen({ chrome, transactions: remoteListOf(list, locale, at) }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  const detail = /^\/transactions\/([^/]+)$/.exec(path);
  if (detail) {
    const id = decodeURIComponent(detail[1] as string);
    const result = await readVia<TransactionDto>(
      options,
      `/api/training/transactions/${encodeURIComponent(id)}`,
      {},
      cookie,
    );
    const remote: RemoteData<TransactionViewModel> = result.ok
      ? succeed(toTransactionViewModel(result.data, locale), at)
      : {
          status: 'ERROR',
          failure: {
            reasonCode: result.reasonCode,
            messageKey: result.messageKey,
            status: result.status,
            correlationId: result.correlationId,
            at,
          },
        };
    return {
      status: result.ok ? 200 : result.status,
      html: htmlDocument(
        renderToHtml(
          transactionDetailScreen({
            chrome,
            transaction: remote,
            polling: {
              statusCheckIntervalMs: options.api.statusCheckIntervalMs,
              maxPolls: options.api.maxClientPolls,
            },
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  if (path === '/queue') {
    const result = await readVia<QueueData>(options, '/api/training/queue', {}, cookie);
    if (!result.ok) {
      return {
        status: result.status,
        html: htmlDocument(
          renderToHtml(safeErrorScreen(authChrome(options, locale), result.correlationId)),
          chrome,
          nonce,
        ),
      };
    }
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          queueScreen({
            chrome,
            pending: views(result.data.pending, locale),
            underReview: views(result.data.underReview, locale),
            reversalRequired: views(result.data.reversalRequired, locale),
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  if (path === '/enrol') {
    return {
      status: 200,
      html: htmlDocument(
        renderToHtml(
          deviceEnrolmentScreen({
            chrome: authChrome(options, locale),
            merchantId: context.merchantId,
            csrfToken: request.csrfToken ?? '',
            refusal: query.get('error') ?? undefined,
          }),
        ),
        chrome,
        nonce,
      ),
    };
  }

  return undefined;
}

// --- node:http adapter -----------------------------------------------------

/**
 * Read a body, refusing anything over the configured size.
 *
 * The limit is enforced **while reading**, not after: a caller that streams
 * megabytes must be cut off, not buffered and then rejected.
 */
async function readBody(
  request: IncomingMessage,
  limitBytes: number,
): Promise<Buffer | 'TOO_LARGE'> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limitBytes) return 'TOO_LARGE';
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(
  request: IncomingMessage,
  limitBytes: number,
): Promise<unknown | 'TOO_LARGE'> {
  const raw = await readBody(request, limitBytes);
  if (raw === 'TOO_LARGE') return 'TOO_LARGE';
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return undefined;
  }
}

async function readFormBody(
  request: IncomingMessage,
  limitBytes: number,
): Promise<Record<string, string> | 'TOO_LARGE'> {
  const raw = await readBody(request, limitBytes);
  if (raw === 'TOO_LARGE') return 'TOO_LARGE';
  return Object.fromEntries(new URLSearchParams(raw.toString('utf8')).entries());
}

export function createPosServer(options: PosServerOptions): Server {
  assertTrainingBoundary(options);
  const transport = transportOf(options);
  validateTransport(transport);

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    void route(options, request, response).catch(() => {
      // Never a stack trace and never a message. A correlation id would be
      // better, but by here we may not have one — a safe code is the floor.
      response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: { reasonCode: 'POS_UNEXPECTED_ERROR' } }));
    });
  };

  if (terminatesTlsItself(transport)) {
    // Validated above, so both paths are present; `loadTlsMaterial` throws a
    // typed error the CLI turns into exit 4 if either is unreadable or if they
    // do not belong together.
    const material = loadTlsMaterial(
      transport.tlsCertificatePath as string,
      transport.tlsPrivateKeyPath as string,
    );
    return createTlsServer({ cert: material.cert, key: material.key }, handler);
  }

  return createServer(handler);
}

/**
 * Everything about one connection that the transport rules need.
 *
 * Built once per request so the scheme is decided once, from the socket and the
 * trusted-proxy configuration, rather than re-derived at each place that needs
 * to know.
 */
function factsOf(request: IncomingMessage): ConnectionFacts {
  return {
    remoteAddress: request.socket.remoteAddress,
    // `encrypted` is present only on a TLS socket, so this is true exactly when
    // *this process* terminated TLS for this connection.
    encryptedSocket: (request.socket as { encrypted?: boolean }).encrypted === true,
    headers: Object.fromEntries(
      Object.entries(request.headers).map(([k, v]) => [
        k.toLowerCase(),
        Array.isArray(v) ? v[0] : v,
      ]),
    ),
  };
}

/**
 * Headers for an HTML response.
 *
 * Every POS page is session-sensitive: a shared counter machine whose back
 * button re-renders the previous operator's balance from cache is a real leak.
 */
function htmlHeaders(
  transport: TransportConfig,
  scheme: RequestScheme,
  nonce: string,
): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    ...securityHeaders({ config: transport, scheme, nonce, sessionSensitive: true }),
  };
}

/**
 * Where to send the operator after signing in.
 *
 * Only a same-origin path is accepted — one leading slash, no second one and no
 * scheme — so `returnTo` cannot be turned into an open redirect to another
 * site dressed up as a Telga login.
 */
export function safeReturnTo(value: string | undefined | null): string {
  if (typeof value !== 'string' || value.length === 0) return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//')) return '/';
  if (value.includes(':')) return '/';
  return value;
}

async function route(
  options: PosServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const transport = transportOf(options);
  const facts = factsOf(request);
  const scheme = resolveScheme(transport, facts);
  const nonce = newNonce();

  const url = new URL(request.url ?? '/', `${scheme.scheme}://pos.local`);
  const path = url.pathname;
  const method = request.method ?? 'GET';
  const cookieHeader = request.headers['cookie'];
  const cookies = parseCookies(cookieHeader);
  const locale = localeOf(options, url.searchParams);
  const limit = options.api.authConfig.session.maxRequestBytes;

  // Cookies follow the **client's** scheme, not this process's listener: behind
  // a terminator the process speaks HTTP while the client used HTTPS.
  const cookieOpts = { secure: cookieSecureFor(transport, scheme) };

  // --- host and origin, before anything else ------------------------------
  //
  // The `Host` header is client-controlled, and a server that reflects it into
  // a redirect or a link will point an operator at somebody else's machine.
  const hostProblem = checkHost(transport, facts);
  if (hostProblem !== undefined) {
    respondHtml(
      response,
      400,
      htmlDocumentAuth(options, safeErrorScreen(authChrome(options, locale), hostProblem), locale, nonce),
      transport,
      scheme,
      nonce,
    );
    return;
  }

  if (STATE_CHANGING.has(method)) {
    const originProblem = checkOrigin(transport, facts, scheme);
    if (originProblem !== undefined) {
      respondHtml(
        response,
        403,
        htmlDocumentAuth(
          options,
          accessDeniedScreen(authChrome(options, locale), originProblem, options.api.newId('corr')),
          locale,
          nonce,
        ),
        transport,
        scheme,
        nonce,
      );
      return;
    }
  }

  // --- the API, guarded by its own router ---------------------------------
  if (path.startsWith('/api/')) {
    const body = method === 'POST' ? await readJsonBody(request, limit) : undefined;
    if (body === 'TOO_LARGE') {
      response.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: { reasonCode: 'REQUEST_TOO_LARGE' } }));
      return;
    }
    const apiResponse = await handle(options.api, {
      method,
      path,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: Object.fromEntries(
        Object.entries(request.headers).map(([k, v]) => [
          k,
          Array.isArray(v) ? (v[0] ?? '') : (v ?? ''),
        ]),
      ),
      body,
    });
    writeApi(response, apiResponse, transport, scheme);
    return;
  }

  // --- public: sign in ------------------------------------------------------
  if (path === '/login' && method === 'GET') {
    respondHtml(
      response,
      200,
      htmlDocumentAuth(
        options,
        loginScreen({
          chrome: authChrome(options, locale),
          refusal: url.searchParams.get('error') ?? undefined,
          returnTo: safeReturnTo(url.searchParams.get('returnTo')),
        }),
        locale,
        nonce,
      ),
      transport,
      scheme,
      nonce,
    );
    return;
  }

  if (path === '/login' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE') {
      respondHtml(
        response,
        413,
        htmlDocumentAuth(options, safeErrorScreen(authChrome(options, locale), 'oversized'), locale, nonce),
        transport,
        scheme,
        nonce,
      );
      return;
    }
    const returnTo = safeReturnTo(form['returnTo']);
    const result = await login(
      options.api,
      {
        userId: (form['userId'] ?? '') as MerchantUserId,
        pin: form['pin'] ?? '',
        deviceId: (form['deviceId'] ?? '') as DeviceId,
        deviceSecret: form['deviceSecret'] ?? '',
      },
      options.api.newId('corr'),
    );
    if (!result.ok) {
      // Post/redirect/get, so a refused attempt is not resubmitted by a refresh
      // and the PIN never survives in the browser's form state.
      response.writeHead(303, {
        location: `/login?error=${encodeURIComponent(result.code)}&returnTo=${encodeURIComponent(returnTo)}`,
      });
      response.end();
      return;
    }
    response.writeHead(303, {
      location: returnTo,
      'set-cookie': [
        serializeCookie(SESSION_COOKIE, result.sessionToken, cookieOpts),
        serializeCookie(CSRF_COOKIE, result.csrfToken, { ...cookieOpts, httpOnly: false }),
      ],
      ...securityHeaders({ config: transport, scheme, sessionSensitive: true }),
    });
    response.end();
    return;
  }

  // --- everything below requires a session ---------------------------------
  const auth = authenticate(options.api, cookies[SESSION_COOKIE], options.api.newId('corr'));
  if (!auth.ok) {
    respondRefused(options, response, auth, path, locale, method, transport, scheme, nonce);
    return;
  }
  const context = auth.context;
  const csrfToken = cookies[CSRF_COOKIE];

  if (path === '/logout' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE' || !csrfMatches(options.api, context.sessionId, form['csrfToken'])) {
      respondHtml(
        response,
        403,
        htmlDocumentAuth(
          options,
          accessDeniedScreen(authChrome(options, locale), 'CSRF_TOKEN_INVALID', options.api.newId('corr')),
          locale,
          nonce,
        ),
        transport,
        scheme,
        nonce,
      );
      return;
    }
    logout(options.api, context, options.api.newId('corr'));
    response.writeHead(303, {
      location: '/login',
      'set-cookie': [
        clearCookie(SESSION_COOKIE, cookieOpts),
        clearCookie(CSRF_COOKIE, { ...cookieOpts, httpOnly: false }),
      ],
      ...securityHeaders({ config: transport, scheme, sessionSensitive: true }),
    });
    response.end();
    return;
  }

  // The sell form posts here, then redirects to the transaction it created —
  // post/redirect/get, so a browser refresh cannot resubmit the sale.
  if (path === '/sell' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE') {
      response.writeHead(303, { location: '/sell?error=REQUEST_TOO_LARGE' });
      response.end();
      return;
    }
    const apiResponse = await handle(options.api, {
      method: 'POST',
      path: '/api/training/sales',
      query: {},
      headers: { cookie: cookieHeader ?? '' },
      body: {
        csrfToken: form['csrfToken'],
        productId: form['productId'],
        amountMinor:
          options.catalog.find((entry) => entry.productId === form['productId'])?.amountMinor ?? 0,
        recipient: form['recipient'],
        clientRequestId: form['clientRequestId'],
        simulatedProviderBehaviour: form['simulatedProviderBehaviour'],
      },
    });
    const body = apiResponse.body as {
      ok: boolean;
      data?: { transactionId: string | null };
      error?: { reasonCode: string };
    };
    const location =
      body.ok && body.data?.transactionId
        ? `/transactions/${encodeURIComponent(body.data.transactionId)}`
        : `/sell?error=${encodeURIComponent(body.error?.reasonCode ?? 'SALE_REFUSED')}`;
    response.writeHead(303, { location });
    response.end();
    return;
  }

  if (path === '/enrol' && method === 'POST') {
    const form = await readFormBody(request, limit);
    if (form === 'TOO_LARGE') {
      response.writeHead(303, { location: '/enrol?error=REQUEST_TOO_LARGE' });
      response.end();
      return;
    }
    const apiResponse = await handle(options.api, {
      method: 'POST',
      path: '/api/training/auth/devices',
      query: {},
      headers: { cookie: cookieHeader ?? '' },
      body: { csrfToken: form['csrfToken'], deviceId: form['deviceId'] },
    });
    const body = apiResponse.body as {
      ok: boolean;
      data?: { deviceId: string; deviceSecret: string };
      error?: { reasonCode: string };
    };
    if (!body.ok) {
      response.writeHead(303, {
        location: `/enrol?error=${encodeURIComponent(body.error?.reasonCode ?? 'ENROLMENT_REFUSED')}`,
      });
      response.end();
      return;
    }
    // The secret is rendered directly rather than redirected to: it must never
    // reach a URL, a history entry or a server log.
    respondHtml(
      response,
      201,
      htmlDocumentAuth(
        options,
        deviceEnrolmentScreen({
          chrome: authChrome(options, locale),
          merchantId: context.merchantId,
          csrfToken: csrfToken ?? '',
          issuedSecret: body.data,
        }),
        locale,
        nonce,
      ),
      transport,
      scheme,
      nonce,
    );
    return;
  }

  const screen = await renderScreen(options, {
    path,
    query: url.searchParams,
    context,
    cookieHeader,
    csrfToken,
    nonce,
  });
  if (screen === undefined) {
    response.writeHead(404, htmlHeaders(transport, scheme, nonce));
    response.end('<p data-testid="not-found">No such screen.</p>');
    return;
  }
  respondHtml(response, screen.status, screen.html, transport, scheme, nonce);
}

/**
 * Refuse a screen request.
 *
 * A session problem sends the operator to sign in, carrying where they were
 * going. Anything else — a revoked device, a missing permission — renders
 * access-denied instead, because signing in again would not fix it and looping
 * them through a login they cannot pass is worse than saying no.
 */
function respondRefused(
  options: PosServerOptions,
  response: ServerResponse,
  auth: AuthFailure,
  path: string,
  locale: Locale,
  method: string,
  transport: TransportConfig,
  scheme: RequestScheme,
  nonce: string,
): void {
  if (auth.reauthenticate) {
    if (method === 'GET') {
      response.writeHead(303, {
        location: `/login?error=${encodeURIComponent(auth.code)}&returnTo=${encodeURIComponent(safeReturnTo(path))}`,
        ...securityHeaders({ config: transport, scheme, sessionSensitive: true }),
      });
      response.end();
      return;
    }
    respondHtml(
      response,
      401,
      htmlDocumentAuth(
        options,
        sessionExpiredScreen(authChrome(options, locale), auth.code),
        locale,
        nonce,
      ),
      transport,
      scheme,
      nonce,
    );
    return;
  }
  respondHtml(
    response,
    403,
    htmlDocumentAuth(
      options,
      accessDeniedScreen(authChrome(options, locale), auth.code, options.api.newId('corr')),
      locale,
      nonce,
    ),
    transport,
    scheme,
    nonce,
  );
}

function htmlDocumentAuth(
  options: PosServerOptions,
  el: El,
  locale: Locale,
  nonce: string,
): string {
  return htmlDocument(
    renderToHtml(el),
    {
      locale,
      environment: options.environment,
      merchantId: '',
      mode: options.api.mode,
      serverTime: options.api.now(),
    },
    nonce,
  );
}

function respondHtml(
  response: ServerResponse,
  status: number,
  html: string,
  transport: TransportConfig,
  scheme: RequestScheme,
  nonce: string,
): void {
  response.writeHead(status, htmlHeaders(transport, scheme, nonce));
  response.end(html);
}

/**
 * Write an API response.
 *
 * The security headers are added here too. A JSON response runs no script, so
 * it gets no nonce and its CSP is `script-src 'none'` — which is exactly right
 * for a body that is never meant to be rendered as a document.
 */
function writeApi(
  response: ServerResponse,
  apiResponse: { status: number; headers: Readonly<Record<string, string>>; body: unknown },
  transport: TransportConfig,
  scheme: RequestScheme,
): void {
  const headers: Record<string, string | string[]> = {
    ...securityHeaders({ config: transport, scheme, sessionSensitive: true }),
    ...apiResponse.headers,
  };
  const setCookie = apiResponse.headers['set-cookie'];
  if (setCookie !== undefined) headers['set-cookie'] = setCookie.split('\n');
  response.writeHead(apiResponse.status, headers);
  response.end(JSON.stringify(apiResponse.body));
}
