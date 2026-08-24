/**
 * POS and API-surface fixtures.
 *
 * Built on the orchestration harness rather than beside it: the UI tests must
 * see the same database, the same mock and the same injected clock the sale
 * tests see, or they would be asserting against a second reality.
 *
 * Nothing here sleeps, and nothing reads the wall clock.
 */

import {
  makeHarness,
  MERCHANT_A,
  MERCHANT_B,
  DEVICE_A,
  DEVICE_B,
  OPERATOR_A,
  PRODUCT,
  saleRequest,
} from '../orchestration/helpers';
import type { Harness } from '../orchestration/helpers';
import {
  createSale,
  enrolDevice,
  handle,
  login,
  upsertOperator,
  CSRF_HEADER,
  SESSION_COOKIE,
  TRAINING_SESSION_POLICY,
} from '@telga/api';
import type { ApiDeps, AuthConfig, HttpRequest, HttpResponse } from '@telga/api';
import { TRAINING_LOCKOUT_POLICY } from '@telga/domain';
import type { ActorRole, DeviceId, MerchantId, MerchantUserId } from '@telga/domain';
import { MOCK_BEHAVIOURS } from '@telga/provider-mock-airtime';
import type { MockBehaviour } from '@telga/provider-mock-airtime';
import type {
  ApiEnvelope,
  TransactionDto,
  TransactionViewModel,
} from '@telga/pos-view-model';
import { toTransactionViewModel } from '@telga/pos-view-model';
import type { Chrome } from '@telga/merchant-pos';
import type { FetchLike, FetchResponseLike } from '@telga/merchant-pos';

export { MERCHANT_A, MERCHANT_B, DEVICE_A, DEVICE_B, OPERATOR_A, PRODUCT, saleRequest };

export const STATUS_CHECK_INTERVAL_MS = 30_000;
export const MAX_CLIENT_POLLS = 4;

/** The PIN every fixture operator uses. Six digits, neither repeated nor sequential. */
export const TEST_PIN = '481502';
export const OPERATOR_USER = 'operator_alpha_1' as MerchantUserId;
export const OWNER_USER = 'owner_alpha_1' as MerchantUserId;
/** The second merchant's operator, for the cross-merchant tests. */
export const OPERATOR_B = 'operator_beta_1' as MerchantUserId;

/**
 * Training auth policy for tests.
 *
 * `secureCookies: false` because the fixtures speak plain HTTP; the production
 * value is a deployment decision, not a test one.
 */
export const TRAINING_AUTH_CONFIG: AuthConfig = Object.freeze({
  session: TRAINING_SESSION_POLICY,
  lockout: TRAINING_LOCKOUT_POLICY,
  secureCookies: false,
});

export interface UiHarness extends Harness {
  readonly api: ApiDeps;
  /** Swap the mock's behaviour between sales, the way the training form does. */
  setBehaviour(behaviour: MockBehaviour): void;
}

export function makeUiHarness(
  name: string,
  options: Parameters<typeof makeHarness>[1] = {},
): UiHarness {
  const harness = makeHarness(`ui-${name}`, options);

  const api: ApiDeps = {
    ...harness.deps,
    statusCheckIntervalMs: STATUS_CHECK_INTERVAL_MS,
    maxClientPolls: MAX_CLIENT_POLLS,
    maxStatusAttempts: 5,
    authConfig: TRAINING_AUTH_CONFIG,
    // Exactly how a real deps factory would wire it: validate the name, then
    // re-script the mock. Unknown names throw, and the handler turns that into
    // a 400 rather than letting it escape.
    useSimulatedBehaviour(value: string): void {
      if (!(MOCK_BEHAVIOURS as readonly string[]).includes(value)) {
        throw new Error(`Unknown simulated behaviour: ${value}`);
      }
      harness.provider.useBehaviour(value as MockBehaviour);
    },
  };

  return {
    ...harness,
    api,
    setBehaviour(value: MockBehaviour): void {
      harness.provider.useBehaviour(value);
    },
  };
}

// --- authentication fixtures ----------------------------------------------

export interface TestSession {
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly cookieHeader: string;
  readonly userId: MerchantUserId;
  readonly merchantId: MerchantId;
  readonly deviceId: DeviceId;
}

/**
 * Sessions the helpers attach automatically.
 *
 * Keyed by the `ApiDeps` object so `call()` and `routerFetch()` keep their
 * existing signatures: a test that does not care about authentication gets a
 * signed-in operator without saying so, and a test that does care calls
 * `signInAs` and passes the cookie explicitly.
 *
 * A promise, not a value, because signing in derives a scrypt hash. The first
 * request through a harness performs it; every later one reuses it.
 */
const defaultSessions = new WeakMap<ApiDeps, Promise<TestSession>>();

/** Create an operator with a known PIN. Returns nothing secret beyond the PIN. */
export async function provisionOperator(
  api: ApiDeps,
  input: {
    userId?: MerchantUserId;
    merchantId?: MerchantId;
    role?: ActorRole;
    pin?: string;
    displayName?: string;
    status?: 'ACTIVE' | 'SUSPENDED';
  } = {},
): Promise<MerchantUserId> {
  const userId = input.userId ?? OPERATOR_USER;
  await upsertOperator(api, {
    userId,
    merchantId: input.merchantId ?? MERCHANT_A,
    displayName: input.displayName ?? 'Training operator',
    role: input.role ?? 'MERCHANT_OPERATOR',
    pin: input.pin ?? TEST_PIN,
    status: input.status ?? 'ACTIVE',
  });
  return userId;
}

/** Enrol a device and return the one-time secret. */
export async function enrolTestDevice(
  api: ApiDeps,
  input: { deviceId?: DeviceId; merchantId?: MerchantId } = {},
): Promise<string> {
  const result = await enrolDevice(api, {
    deviceId: input.deviceId ?? (DEVICE_A as DeviceId),
    merchantId: input.merchantId ?? MERCHANT_A,
    actor: { userId: 'system', role: 'ADMIN' },
    correlationId: 'corr_test_enrol',
  });
  return result.deviceSecret;
}

/** Provision, enrol and sign in. The whole fixture path in one call. */
export async function signInAs(
  api: ApiDeps,
  input: {
    userId?: MerchantUserId;
    merchantId?: MerchantId;
    deviceId?: DeviceId;
    role?: ActorRole;
    pin?: string;
  } = {},
): Promise<TestSession> {
  const merchantId = input.merchantId ?? MERCHANT_A;
  const deviceId = input.deviceId ?? (DEVICE_A as DeviceId);
  const userId = await provisionOperator(api, {
    userId: input.userId,
    merchantId,
    role: input.role,
    pin: input.pin,
  });
  const deviceSecret = await enrolTestDevice(api, { deviceId, merchantId });

  const result = await login(
    api,
    { userId, pin: input.pin ?? TEST_PIN, deviceId, deviceSecret },
    'corr_test_login',
  );
  if (!result.ok) throw new Error(`Fixture sign-in failed: ${result.code}`);

  return {
    sessionToken: result.sessionToken,
    csrfToken: result.csrfToken,
    cookieHeader: `${SESSION_COOKIE}=${encodeURIComponent(result.sessionToken)}`,
    userId,
    merchantId,
    deviceId,
  };
}

/** The session `call()` attaches when a test does not supply one. */
export function defaultSession(api: ApiDeps): Promise<TestSession> {
  let existing = defaultSessions.get(api);
  if (existing === undefined) {
    existing = signInAs(api);
    defaultSessions.set(api, existing);
  }
  return existing;
}

/** Forget the cached session, so the next request signs in again. */
export function forgetSession(api: ApiDeps): void {
  defaultSessions.delete(api);
}

/** Issue one request through the API router, without a socket. */
export function request(
  method: string,
  path: string,
  init: { query?: Record<string, string>; headers?: Record<string, string>; body?: unknown } = {},
): HttpRequest {
  return {
    method,
    path,
    query: init.query ?? {},
    headers: init.headers ?? {},
    body: init.body,
  };
}

/**
 * Call the API as a signed-in operator.
 *
 * The session cookie and the CSRF header are attached unless the test supplies
 * its own — so an unauthenticated test writes `headers: {}` explicitly and gets
 * exactly that, while an ordinary test does not have to think about it.
 *
 * `anonymous: true` skips the attachment entirely.
 */
export async function call<T>(
  api: ApiDeps,
  method: string,
  path: string,
  init: Parameters<typeof request>[2] & { anonymous?: boolean; session?: TestSession } = {},
): Promise<{ response: HttpResponse; envelope: ApiEnvelope<T> }> {
  const headers = { ...(init.headers ?? {}) };

  if (init.anonymous !== true) {
    const session = init.session ?? (await defaultSession(api));
    if (headers['cookie'] === undefined) headers['cookie'] = session.cookieHeader;
    if (headers[CSRF_HEADER] === undefined) headers[CSRF_HEADER] = session.csrfToken;
  }

  const response = await handle(api, request(method, path, { ...init, headers }));
  return { response, envelope: response.body as ApiEnvelope<T> };
}

/** A sale straight through the application service, bypassing HTTP. */
export async function seedSale(
  harness: UiHarness,
  overrides: Parameters<typeof saleRequest>[0] = {},
): Promise<string> {
  const result = await createSale(harness.deps, saleRequest(overrides));
  const id = 'transactionId' in result ? result.transactionId : undefined;
  if (typeof id !== 'string') {
    throw new Error(`Expected a transaction id, got kind ${result.kind}`);
  }
  return id;
}

export function chromeFor(overrides: Partial<Chrome> = {}): Chrome {
  return {
    locale: 'en',
    environment: 'test',
    merchantId: MERCHANT_A,
    mode: 'TRAINING',
    serverTime: '2026-08-20T09:00:00.000Z',
    ...overrides,
  };
}

/** A view model built from whatever the API currently reports for a transaction. */
export async function viewOf(
  api: ApiDeps,
  transactionId: string,
  locale: 'en' | 'am' = 'en',
): Promise<TransactionViewModel> {
  const { envelope } = await call<TransactionDto>(
    api,
    'GET',
    `/api/training/transactions/${transactionId}`,
    { query: { merchantId: MERCHANT_A } },
  );
  if (!envelope.ok) throw new Error(`Read failed: ${envelope.error.reasonCode}`);
  return toTransactionViewModel(envelope.data, locale);
}

// --- a fetch the tests control --------------------------------------------

export interface StubCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

/**
 * A `fetch` backed by the API router.
 *
 * Real request shaping, real routing, real envelopes — no socket, no timer.
 * `calls` records what the client sent, so a test can assert the correlation
 * header rather than trusting it.
 */
export function routerFetch(api: ApiDeps): FetchLike & { calls: StubCall[] } {
  const calls: StubCall[] = [];
  const fetchLike = (async (url: string, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body,
    });
    // The browser would attach these; the stub does the same, so the client
    // tests exercise the guarded routes rather than a bypass of them.
    const session = await defaultSession(api);
    const parsed = new URL(url, 'http://pos.test');
    const response = await handle(api, {
      method: init?.method ?? 'GET',
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams.entries()),
      headers: {
        ...(init?.headers ?? {}),
        cookie: session.cookieHeader,
        [CSRF_HEADER]: session.csrfToken,
      },
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    });
    return {
      status: response.status,
      ok: response.status < 400,
      json: async () => response.body,
    } satisfies FetchResponseLike;
  }) as FetchLike & { calls: StubCall[] };
  fetchLike.calls = calls;
  return fetchLike;
}

/** A `fetch` that always fails, for the unreachable-API tests. */
export function unreachableFetch(): FetchLike {
  return async () => {
    throw new Error('ECONNREFUSED');
  };
}

/** A `fetch` that answers with something that is not an envelope. */
export function malformedFetch(status = 200): FetchLike {
  return async () =>
    ({
      status,
      ok: status < 400,
      json: async () => ({ unexpected: true }),
    }) satisfies FetchResponseLike;
}
