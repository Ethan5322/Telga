/**
 * The typed API client.
 *
 * `fetch` is injected, so every client test runs without a socket and without a
 * timer. The same class backs the browser script and the server-side render, so
 * there is one place that knows the shape of an envelope.
 *
 * ## Errors never escape as exceptions
 *
 * Every method returns `ApiEnvelope<T>`. A transport failure, a non-JSON body,
 * an HTTP error and an application rejection all come back as `ok: false` with
 * a `reasonCode`. A screen that has to `try`/`catch` around a status read is a
 * screen that will eventually show a stack trace to a merchant.
 *
 * ## Correlation
 *
 * The caller supplies a correlation id per merchant action, and it goes out on
 * every request in that action. The server echoes it back on the response and
 * writes it into its own logs, so one telephone call to support covers the sale,
 * the status reads and the recovery attempts under a single id.
 */

import type {
  ApiEnvelope,
  BalanceDto,
  CreateSaleBody,
  CreateSaleResultDto,
  QueueDto,
  RemoteFailure,
  TransactionDto,
} from '@telga/pos-view-model';

export const CORRELATION_HEADER = 'x-telga-correlation-id';

/** The subset of `fetch` this client uses. Anything more would be untestable noise. */
export interface FetchLike {
  (
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: unknown;
    },
  ): Promise<FetchResponseLike>;
}

export interface FetchResponseLike {
  readonly status: number;
  readonly ok: boolean;
  json(): Promise<unknown>;
  readonly headers?: { get(name: string): string | null };
}

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly fetch: FetchLike;
  now(): string;
}

const TRAINING = '/api/training';

export class TrainingApiClient {
  constructor(private readonly options: ApiClientOptions) {}

  private url(path: string, query: Readonly<Record<string, string | number | undefined>> = {}): string {
    const parts = Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    const suffix = parts.length > 0 ? `?${parts.join('&')}` : '';
    return `${this.options.baseUrl}${path}${suffix}`;
  }

  private failure(
    reasonCode: string,
    messageKey: string,
    status: number | null,
    correlationId: string | null,
  ): RemoteFailure {
    return { reasonCode, messageKey, status, correlationId, at: this.options.now() };
  }

  private async request<T>(
    path: string,
    correlationId: string,
    init: { method: string; query?: Readonly<Record<string, string | number | undefined>>; body?: unknown },
  ): Promise<ApiEnvelope<T>> {
    let response: FetchResponseLike;
    try {
      response = await this.options.fetch(this.url(path, init.query ?? {}), {
        method: init.method,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          [CORRELATION_HEADER]: correlationId,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch {
      // Unreachable server, DNS failure, a POS that lost its connection
      // mid-shift. None of these say anything about the sale.
      return this.envelopeFailure(
        this.failure('API_UNREACHABLE', 'status.sales_unavailable', null, correlationId),
        correlationId,
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return this.envelopeFailure(
        this.failure('API_RESPONSE_NOT_JSON', 'status.sales_unavailable', response.status, correlationId),
        correlationId,
      );
    }

    if (!isEnvelope(parsed)) {
      return this.envelopeFailure(
        this.failure('API_RESPONSE_MALFORMED', 'status.sales_unavailable', response.status, correlationId),
        correlationId,
      );
    }
    return parsed as ApiEnvelope<T>;
  }

  private envelopeFailure(failure: RemoteFailure, correlationId: string): ApiEnvelope<never> {
    return {
      ok: false,
      error: {
        kind: 'TRANSPORT',
        reasonCode: failure.reasonCode,
        messageKey: failure.messageKey,
        status: failure.status ?? 0,
      },
      meta: {
        correlationId,
        mode: 'TRAINING',
        simulated: true,
        serverTime: this.options.now(),
        polling: { statusCheckIntervalMs: 30_000, maxPolls: 0 },
      },
    };
  }

  getTransaction(
    merchantId: string,
    transactionId: string,
    correlationId: string,
  ): Promise<ApiEnvelope<TransactionDto>> {
    return this.request<TransactionDto>(
      `${TRAINING}/transactions/${encodeURIComponent(transactionId)}`,
      correlationId,
      { method: 'GET', query: { merchantId } },
    );
  }

  listTransactions(
    merchantId: string,
    correlationId: string,
    query: { state?: string; limit?: number } = {},
  ): Promise<ApiEnvelope<readonly TransactionDto[]>> {
    return this.request<readonly TransactionDto[]>(`${TRAINING}/transactions`, correlationId, {
      method: 'GET',
      query: { merchantId, ...query },
    });
  }

  getQueue(merchantId: string, correlationId: string): Promise<ApiEnvelope<QueueDto>> {
    return this.request<QueueDto>(`${TRAINING}/queue`, correlationId, {
      method: 'GET',
      query: { merchantId },
    });
  }

  getBalance(merchantId: string, correlationId: string): Promise<ApiEnvelope<BalanceDto>> {
    return this.request<BalanceDto>(`${TRAINING}/balance`, correlationId, {
      method: 'GET',
      query: { merchantId },
    });
  }

  createSale(
    body: CreateSaleBody,
    correlationId: string,
  ): Promise<ApiEnvelope<CreateSaleResultDto>> {
    return this.request<CreateSaleResultDto>(`${TRAINING}/sales`, correlationId, {
      method: 'POST',
      body,
    });
  }
}

function isEnvelope(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['ok'] !== 'boolean') return false;
  if (typeof v['meta'] !== 'object' || v['meta'] === null) return false;
  return v['ok'] === true ? 'data' in v : typeof v['error'] === 'object' && v['error'] !== null;
}

/** Turn an unsuccessful envelope into something a screen can render. */
export function toRemoteFailure(
  envelope: Extract<ApiEnvelope<unknown>, { ok: false }>,
  at: string,
): RemoteFailure {
  return {
    reasonCode: envelope.error.reasonCode,
    messageKey: envelope.error.messageKey,
    status: envelope.error.status,
    correlationId: envelope.meta.correlationId,
    at,
  };
}

/**
 * A {@link RemoteFailure} in a form that can be thrown.
 *
 * The polling loop signals a failed attempt by rejecting, and a rejection
 * carrying a bare object loses its stack and cannot be told apart from any
 * other thrown value. Wrapping keeps `RemoteFailure` a plain data type — it is
 * stored in screen state and compared in tests — while giving the throw path a
 * real `Error`.
 */
export class RemoteFailureError extends Error {
  constructor(readonly failure: RemoteFailure) {
    super(`${failure.reasonCode} (${failure.status === null ? 'no response' : String(failure.status)})`);
    this.name = 'RemoteFailureError';
  }
}

/**
 * Whatever was thrown, as something a screen can render.
 *
 * ## Why this is not a cast
 *
 * The caller used to write `attempt.error as RemoteFailure`. That is true only
 * when the server answered with an error envelope. A **connection** failure —
 * the shop's link dropping mid-poll, which is the ordinary case this build has
 * to survive — rejects with a `TypeError` or an `AbortError`, and the cast
 * turned it into an object whose `reasonCode` was `undefined`. The screen then
 * rendered a blank reason for the one condition an operator most needs named.
 *
 * So this narrows instead, and synthesises an honest failure for anything it
 * does not recognise. `status: null` already means *"the request never reached
 * the server"*, which is exactly what a dropped connection is.
 */
export function asRemoteFailure(error: unknown, at: string): RemoteFailure {
  if (error instanceof RemoteFailureError) return error.failure;
  // A plain object that already has the shape — thrown by an older caller, or
  // by a test that stubs the client directly.
  if (typeof error === 'object' && error !== null && 'reasonCode' in error) {
    return error as RemoteFailure;
  }
  return {
    reasonCode: 'NETWORK_UNAVAILABLE',
    messageKey: 'error.network_unavailable',
    status: null,
    correlationId: null,
    at,
  };
}
