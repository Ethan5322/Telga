/**
 * A transport the API can be tested without.
 *
 * `HttpRequest` and `HttpResponse` are plain values. `node:http` is adapted to
 * them by the POS app; a test builds one by hand. That is why every API test in
 * this repository runs without opening a socket, and why the same handler can
 * later sit behind a different server without being rewritten.
 */

import type { EnvelopeMeta } from '@telga/pos-view-model';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export interface HttpRequest {
  readonly method: string;
  /** Path only, without the query string. */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  /** Already-parsed JSON body, or undefined. */
  readonly body?: unknown;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** Header a client sends to carry its correlation id into the server's logs. */
export const CORRELATION_HEADER = 'x-telga-correlation-id';

/** Header every response carries back, so a merchant can quote it to support. */
export const RESPONSE_CORRELATION_HEADER = 'x-telga-correlation-id';

/** Stated on every response. A screen renders it; a test asserts it. */
export const MODE_HEADER = 'x-telga-mode';

export function json(status: number, body: unknown, meta: EnvelopeMeta): HttpResponse {
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      [RESPONSE_CORRELATION_HEADER]: meta.correlationId,
      [MODE_HEADER]: meta.mode,
      // A POS page renders no third-party content and embeds nothing.
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
    body,
  };
}
