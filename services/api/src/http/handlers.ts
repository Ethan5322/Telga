/**
 * Training-mode HTTP handlers.
 *
 * Every handler is a function from an **authenticated context** plus an
 * `HttpRequest` to an `HttpResponse`, over the existing application services.
 * Nothing here posts a ledger entry, changes a transaction state, calls a
 * provider, or computes a balance. Writes go through `createSale`; reads go
 * through the read model.
 *
 * ## Where the merchant comes from
 *
 * `context.merchantId`, always. Read from the server-side session row by
 * `authenticate`, never from the URL, a form field or a header. A merchant id
 * supplied by a client is compared with the session's in `guard.ts` and then
 * discarded — no handler in this file reads one.
 *
 * ## The mode gate
 *
 * `assertTraining` runs on every write before the body is examined. It is not
 * the only guard — the orchestration refuses a non-TRAINING mode at its own
 * door, and the schema refuses to store a live-money row — but it is the one
 * that stops a live-mode request reaching an application service at all.
 *
 * ## What is missing on purpose
 *
 * No endpoint sets a state, releases a reservation, approves a reversal or
 * credits a balance. `reversal.ts` already requires a supervisor approval, and
 * exposing it over HTTP without an authenticated supervisor session would be a
 * way *around* that approval rather than an implementation of it. Recorded as a
 * known limitation in `09 Engineering/Merchant POS UI.md`.
 */

import { money, transactionId as toTransactionId } from '@telga/domain';
import type { DeviceId, MerchantUserId, ProductId, TransactionState } from '@telga/domain';
import type {
  ApiEnvelope,
  BalanceDto,
  CreateSaleBody,
  CreateSaleResultDto,
  EnvelopeMeta,
  QueueDto,
  TransactionDto,
} from '@telga/pos-view-model';
import { assertSafeForDisplay } from '@telga/pos-view-model';
import { createSale } from '../application/createSale';
import { isOutcome } from '../application/results';
import type { SaleResult } from '../application/results';
import type { AuthContext } from '../auth/context';
import { json } from './contract';
import type { HttpRequest, HttpResponse } from './contract';
import type { AuthedApiDeps } from './deps';
import { listTransactionDtos, toBalanceDto, toTransactionDto } from './readModel';
import type { ReadModelDeps } from './readModel';

export type { AuthedApiDeps as ApiDeps } from './deps';

const STATES = new Set<string>([
  'CREATED',
  'VALIDATED',
  'RESERVED',
  'SUBMITTED',
  'PROCESSING',
  'PENDING',
  'UNDER_REVIEW',
  'REVERSAL_REQUIRED',
  'SUCCESSFUL',
  'FAILED',
  'REVERSED',
  'REJECTED',
]);

export function meta(deps: AuthedApiDeps, correlationId: string): EnvelopeMeta {
  return {
    correlationId,
    mode: deps.mode,
    simulated: true,
    serverTime: deps.now(),
    polling: {
      statusCheckIntervalMs: deps.statusCheckIntervalMs,
      maxPolls: deps.maxClientPolls,
    },
  };
}

export function fail(
  deps: AuthedApiDeps,
  correlationId: string,
  status: number,
  kind: string,
  reasonCode: string,
  messageKey: string,
): HttpResponse {
  const envelope: ApiEnvelope<never> = {
    ok: false,
    error: { kind, reasonCode, messageKey, status },
    meta: meta(deps, correlationId),
  };
  return json(status, envelope, envelope.meta);
}

export function ok<T>(
  deps: AuthedApiDeps,
  correlationId: string,
  data: T,
  status = 200,
): HttpResponse {
  // The last gate before anything reaches a screen.
  assertSafeForDisplay(data);
  const envelope: ApiEnvelope<T> = { ok: true, data, meta: meta(deps, correlationId) };
  return json(status, envelope, envelope.meta);
}

function readModelDeps(deps: AuthedApiDeps): ReadModelDeps {
  return {
    driver: deps.driver,
    maxStatusAttempts: deps.maxStatusAttempts,
    now: () => deps.now(),
  };
}

/** Refuse anything that is not training mode, before the body is examined. */
function assertTraining(
  deps: AuthedApiDeps,
  correlationId: string,
): HttpResponse | undefined {
  if (deps.mode === 'TRAINING') return undefined;
  return fail(deps, correlationId, 403, 'SIMULATED_ONLY', 'LIVE_MODE_REFUSED', 'mode.training');
}

// --- reads -----------------------------------------------------------------

/** `GET /api/training/transactions?state=…&limit=…` */
export function listTransactions(
  deps: AuthedApiDeps,
  request: HttpRequest,
  context: AuthContext,
  correlationId: string,
): HttpResponse {
  const stateParam = request.query['state'];
  if (stateParam !== undefined && !STATES.has(stateParam)) {
    return fail(
      deps,
      correlationId,
      400,
      'INVALID_REQUEST',
      'UNKNOWN_STATE_FILTER',
      'error.validation.recipient',
    );
  }

  const limitParam = request.query['limit'];
  const limit = limitParam === undefined ? 50 : Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return fail(
      deps,
      correlationId,
      400,
      'INVALID_REQUEST',
      'LIMIT_OUT_OF_RANGE',
      'error.validation.recipient',
    );
  }

  const items = listTransactionDtos(readModelDeps(deps), context.merchantId, correlationId, {
    limit,
    states: stateParam ? [stateParam as TransactionState] : undefined,
  });
  return ok<readonly TransactionDto[]>(deps, correlationId, items);
}

/**
 * `GET /api/training/transactions/:id`
 *
 * Scoped in SQL by the **session's** merchant. A transaction belonging to
 * another merchant and a transaction that does not exist produce the identical
 * 404, so ids cannot be enumerated by reading status codes.
 */
export function getTransaction(
  deps: AuthedApiDeps,
  _request: HttpRequest,
  context: AuthContext,
  correlationId: string,
  params: Readonly<Record<string, string>>,
): HttpResponse {
  const id = params['id'];
  if (id === undefined || id.trim().length === 0) {
    return fail(
      deps,
      correlationId,
      400,
      'INVALID_REQUEST',
      'TRANSACTION_ID_REQUIRED',
      'error.validation.recipient',
    );
  }

  const row = deps.driver.findTransaction(toTransactionId(id), context.merchantId);
  if (!row) {
    return fail(
      deps,
      correlationId,
      404,
      'NOT_FOUND',
      'TRANSACTION_NOT_FOUND',
      'error.permission.denied',
    );
  }
  return ok<TransactionDto>(
    deps,
    correlationId,
    toTransactionDto(readModelDeps(deps), row, correlationId),
  );
}

/** `GET /api/training/queue` — pending, under review, reversal required. */
export function getQueue(
  deps: AuthedApiDeps,
  _request: HttpRequest,
  context: AuthContext,
  correlationId: string,
): HttpResponse {
  const rm = readModelDeps(deps);
  const pick = (states: readonly TransactionState[]): readonly TransactionDto[] =>
    listTransactionDtos(rm, context.merchantId, correlationId, { states, limit: 200 });

  const queue: QueueDto = {
    pending: pick(['PENDING']),
    underReview: pick(['UNDER_REVIEW']),
    reversalRequired: pick(['REVERSAL_REQUIRED']),
  };
  return ok<QueueDto>(deps, correlationId, queue);
}

/** `GET /api/training/balance` */
export function getBalance(
  deps: AuthedApiDeps,
  _request: HttpRequest,
  context: AuthContext,
  correlationId: string,
): HttpResponse {
  return ok<BalanceDto>(
    deps,
    correlationId,
    toBalanceDto(readModelDeps(deps), context.merchantId),
  );
}

// --- the one write ---------------------------------------------------------

function validateBody(body: unknown): CreateSaleBody | string {
  if (typeof body !== 'object' || body === null) return 'BODY_NOT_AN_OBJECT';
  const b = body as Record<string, unknown>;
  // `merchantId` is deliberately absent: it comes from the session.
  for (const field of ['productId', 'recipient', 'clientRequestId']) {
    const value = b[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      return `${field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).toUpperCase()}_REQUIRED`;
    }
  }
  const amount = b['amountMinor'];
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
    return 'AMOUNT_MINOR_INVALID';
  }
  const behaviour = b['simulatedProviderBehaviour'];
  if (behaviour !== undefined && (typeof behaviour !== 'string' || behaviour.length > 32)) {
    return 'SIMULATED_BEHAVIOUR_INVALID';
  }
  return b as unknown as CreateSaleBody;
}

/** How a sale result becomes a wire result. Nothing is invented, nothing hidden. */
function toSaleResultDto(
  deps: AuthedApiDeps,
  result: SaleResult,
  correlationId: string,
): CreateSaleResultDto {
  const transactionId =
    'transactionId' in result && typeof result.transactionId === 'string'
      ? result.transactionId
      : 'originalTransactionId' in result
        ? result.originalTransactionId
        : null;

  const row =
    transactionId === null
      ? undefined
      : deps.driver.findTransaction(toTransactionId(transactionId));

  return {
    kind: result.kind,
    state:
      isOutcome(result) || result.kind === 'DUPLICATE_REQUEST'
        ? (result as { state: TransactionState }).state
        : null,
    transactionId,
    messageKey: result.messageKey,
    nextAction: result.nextAction,
    providerErrorCategory: 'providerErrorCategory' in result ? result.providerErrorCategory : null,
    reasonCode: 'reasonCode' in result ? result.reasonCode : null,
    simulated: true,
    transaction: row ? toTransactionDto(readModelDeps(deps), row, correlationId) : null,
  };
}

/**
 * `POST /api/training/sales`
 *
 * The merchant, the device and the operator all come from the session. The body
 * carries only what the sale itself is: product, amount, recipient, and the
 * client request id that makes a double press idempotent.
 *
 * The status code follows the **result kind**, not the HTTP habit of treating
 * anything non-2xx as broken. A `PENDING` sale is a successful request with an
 * unresolved outcome — 201 with `kind: 'PENDING'` — because the alternative
 * teaches a client to treat an unknown outcome as an error, which is exactly
 * the mistake the pending path exists to prevent.
 */
export async function postSale(
  deps: AuthedApiDeps,
  request: HttpRequest,
  context: AuthContext,
  correlationId: string,
): Promise<HttpResponse> {
  const refused = assertTraining(deps, correlationId);
  if (refused) return refused;

  const parsed = validateBody(request.body);
  if (typeof parsed === 'string') {
    return fail(deps, correlationId, 400, 'INVALID_REQUEST', parsed, 'error.validation.recipient');
  }

  if (parsed.simulatedProviderBehaviour !== undefined) {
    if (!deps.useSimulatedBehaviour) {
      return fail(
        deps,
        correlationId,
        400,
        'INVALID_REQUEST',
        'SIMULATION_NOT_AVAILABLE',
        'error.validation.recipient',
      );
    }
    try {
      deps.useSimulatedBehaviour(parsed.simulatedProviderBehaviour);
    } catch {
      return fail(
        deps,
        correlationId,
        400,
        'INVALID_REQUEST',
        'UNKNOWN_SIMULATED_BEHAVIOUR',
        'error.validation.recipient',
      );
    }
  }

  // Counted before the sale runs, so a burst is limited even if each sale is
  // slow. A refused sale still counts: the limit is on attempts, not successes.
  deps.driver.recordAttempt('SALE', context.sessionId, 'SUCCESS', deps.now());

  const result = await createSale(deps, {
    merchantId: context.merchantId,
    deviceId: context.deviceId as DeviceId,
    operatorId: context.userId as MerchantUserId,
    productId: parsed.productId as ProductId,
    amount: money(parsed.amountMinor),
    recipient: parsed.recipient,
    clientRequestId: parsed.clientRequestId,
    correlationId,
  });

  const dto = toSaleResultDto(deps, result, correlationId);

  if (!isOutcome(result) && result.kind !== 'DUPLICATE_REQUEST') {
    const status =
      result.kind === 'UNAUTHORIZED'
        ? 403
        : result.kind === 'PROVIDER_UNAVAILABLE' || result.kind === 'PRODUCT_UNAVAILABLE'
          ? 503
          : result.kind === 'PERSISTENCE_FAILURE'
            ? 500
            : 400;
    const envelope: ApiEnvelope<CreateSaleResultDto> = {
      ok: false,
      error: {
        kind: result.kind,
        reasonCode: 'reasonCode' in result ? result.reasonCode : result.kind,
        messageKey: result.messageKey,
        status,
      },
      meta: meta(deps, correlationId),
    };
    return json(status, envelope, envelope.meta);
  }

  return ok<CreateSaleResultDto>(deps, correlationId, dto, 201);
}
