/**
 * Authentication fixtures.
 *
 * Built on the UI harness, which is built on the orchestration harness, so an
 * auth test sees the same database, the same mock and the same injected clock a
 * sale test sees. Nothing here sleeps and nothing reads the wall clock: session
 * expiry is exercised by moving the injected clock forward, never by waiting.
 */

import {
  DEVICE_A,
  DEVICE_B,
  MERCHANT_A,
  MERCHANT_B,
  OPERATOR_A,
  OPERATOR_B,
  TEST_PIN,
  TRAINING_AUTH_CONFIG,
  call,
  enrolTestDevice,
  forgetSession,
  makeUiHarness,
  provisionOperator,
  request,
  seedSale,
  signInAs,
} from '../ui/helpers';
import type { TestSession, UiHarness } from '../ui/helpers';
import { CSRF_HEADER, SESSION_COOKIE, authenticate, handle, login } from '@telga/api';
import type { ApiDeps, HttpResponse } from '@telga/api';
import type { ApiEnvelope } from '@telga/pos-view-model';
import type { DeviceId, MerchantUserId } from '@telga/domain';

export {
  DEVICE_A,
  DEVICE_B,
  MERCHANT_A,
  MERCHANT_B,
  OPERATOR_A,
  OPERATOR_B,
  TEST_PIN,
  TRAINING_AUTH_CONFIG,
  call,
  enrolTestDevice,
  forgetSession,
  makeUiHarness,
  provisionOperator,
  request,
  seedSale,
  signInAs,
  authenticate,
  login,
};
export type { TestSession, UiHarness, ApiDeps };

/** The wrong PIN, everywhere. Same shape as the right one, different digits. */
export const WRONG_PIN = '481503';

/** Issue a request with an explicit cookie header, or none at all. */
export async function callWith<T>(
  api: ApiDeps,
  method: string,
  path: string,
  init: {
    cookie?: string;
    csrf?: string;
    query?: Record<string, string>;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<{ response: HttpResponse; envelope: ApiEnvelope<T> }> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.cookie !== undefined) headers['cookie'] = init.cookie;
  if (init.csrf !== undefined) headers[CSRF_HEADER] = init.csrf;

  const response = await handle(
    api,
    request(method, path, { query: init.query, headers, body: init.body }),
  );
  return { response, envelope: response.body as ApiEnvelope<T> };
}

/** The cookie header a browser would send for a token. */
export const cookieFor = (token: string): string =>
  `${SESSION_COOKIE}=${encodeURIComponent(token)}`;

/** Sign in as the second merchant's operator. */
export function signInAsBeta(api: ApiDeps): Promise<TestSession> {
  return signInAs(api, {
    userId: OPERATOR_B,
    merchantId: MERCHANT_B,
    deviceId: DEVICE_B as DeviceId,
  });
}

/** The reason code of a refused envelope, or a clear failure if it succeeded. */
export function reasonOf(envelope: ApiEnvelope<unknown>): string {
  if (envelope.ok) throw new Error('Expected a refusal, got a success');
  return envelope.error.reasonCode;
}

/**
 * Every audit event of a given type, newest first.
 *
 * Auth events are written with `entityType: 'session'`, so a test can assert
 * that a refusal was recorded without reading a log file.
 */
export function auditOf(harness: UiHarness, eventType: string): readonly { metadata: string | null }[] {
  return harness.driver
    .readAuditEvents()
    .filter((row) => row.event_type === eventType)
    .map((row) => ({ metadata: row.metadata }));
}

/** Move the injected clock forward. Session expiry is tested this way, never by sleeping. */
export function advance(harness: UiHarness, ms: number): void {
  harness.clock.advance(ms);
}

/** A signed-in operator with a role other than the default. */
export function signInWithRole(
  api: ApiDeps,
  role: Parameters<typeof signInAs>[1] extends { role?: infer R } ? R : never,
  userId = 'operator_role_1' as MerchantUserId,
): Promise<TestSession> {
  return signInAs(api, { userId, role });
}
