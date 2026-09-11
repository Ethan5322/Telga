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

import { money, profitBpsFrom, trainingProfitMinor, transactionId as toTransactionId } from '@telga/domain';
import type { MerchantId, ProductId, TransactionState } from '@telga/domain';
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
import { cancelBankDeposit, openBankDeposit, orderBankDeposit } from '../application/bankDeposit';
import { settleShopTransfer } from '../application/shopTransfer';
import { startChapaDeposit } from '../application/chapaDeposit';
import { postShopTransfer } from '@telga/persistence';
import { TRAINING_TRANSFER_POLICY, postingId } from '@telga/domain';
import { transferProfit } from '../application/profitTransfer';
import { changePin } from '../application/changePin';
import type { PendingOrderRow } from '@telga/persistence';
import { createSale } from '../application/createSale';
import { isOutcome } from '../application/results';
import type { SaleResult } from '../application/results';
import {
  authorizeOrder,
  cancelOrder,
  batchTransactionIds,
  createPendingOrder,
  getOrderForContext,
} from '../application/voucherOrders';
import type { CreatePendingOrderRequest } from '../application/voucherOrders';
import { depositTrainingFunds } from '../application/deposits';
import { readSettings, writeSettings } from '../application/settings';
import { lookupReceipt, reprintReceipt } from '../application/reprint';
import type { ReceiptDto, ReceiptResult } from '../application/reprint';
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
    deviceId: context.deviceId,
    operatorId: context.userId,
    productId: parsed.productId as ProductId,
    amount: money(parsed.amountMinor),
    recipient: parsed.recipient,
    clientRequestId: parsed.clientRequestId,
    correlationId,
  });

  return saleResultResponse(deps, correlationId, result);
}

/**
 * A `SaleResult` turned into an `HttpResponse`. Shared between `postSale` and
 * `postAuthorizeOrder`: a sale created through the voucher PIN flow gets
 * exactly the same status-code mapping as one created through `/sell` — there
 * is only one way a sale outcome becomes a wire response.
 */
function saleResultResponse(
  deps: AuthedApiDeps,
  correlationId: string,
  result: SaleResult,
): HttpResponse {
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

// --- receipts and reprints ---------------------------------------------------

/**
 * `GET /api/training/transactions/:id/receipt`
 *
 * A pure read: writes nothing, not even an audit event. Scoped to the
 * session's merchant, so another shop's transaction is a plain 404.
 */
export function getReceipt(
  deps: AuthedApiDeps,
  _request: HttpRequest,
  context: AuthContext,
  correlationId: string,
  params: Readonly<Record<string, string>>,
): HttpResponse {
  const result = lookupReceipt(deps, context, params['id'] ?? '');
  return receiptResponse(deps, correlationId, result);
}

/**
 * `POST /api/training/transactions/:id/reprint`
 *
 * Records a reprint and returns the slip. Creates no sale, posts no ledger
 * entry, and leaves the original timestamp alone — see `reprint.ts`.
 */
export function postReprint(
  deps: AuthedApiDeps,
  _request: HttpRequest,
  context: AuthContext,
  correlationId: string,
  params: Readonly<Record<string, string>>,
): HttpResponse {
  const refused = assertTraining(deps, correlationId);
  if (refused) return refused;
  const result = reprintReceipt(deps, context, params['id'] ?? '', correlationId);
  return receiptResponse(deps, correlationId, result);
}

function receiptResponse(
  deps: AuthedApiDeps,
  correlationId: string,
  result: ReceiptResult,
): HttpResponse {
  switch (result.kind) {
    case 'NOT_FOUND':
      return fail(deps, correlationId, 404, 'NOT_FOUND', 'TRANSACTION_NOT_FOUND', 'error.permission.denied');
    case 'NOT_ELIGIBLE':
      // An unresolved sale has no receipt to print — saying so is the point.
      return fail(
        deps,
        correlationId,
        409,
        'INVALID_REQUEST',
        'RECEIPT_NOT_AVAILABLE',
        'receipt.not_available',
      );
    case 'FOUND':
      return ok<ReceiptDto>(deps, correlationId, result.receipt);
  }
}

// --- training voucher orders -------------------------------------------------

export interface CreateOrderDto {
  readonly orderId: string;
  readonly network: string;
  readonly productId: string;
  readonly productType: string;
  /** The price of **one** voucher. Multiply by `quantity` for the order. */
  readonly amountMinor: number;
  readonly quantity: number;
  readonly totalMinor: number;
  readonly expiresAt: string;
  readonly status: string;
  readonly transactionId: string | null;
  /** Every transaction the order produced, in print order. Empty until authorized. */
  readonly transactionIds: readonly string[];
  /** Already masked at write time; the full number is never stored or sent. */
  readonly recipientMasked: string | null;
  /**
   * The shop's margin on this sale, shown before the operator confirms.
   * Never added to what the customer pays — see Decision Log D69.
   */
  readonly profitMinor: number;
  readonly profitBps: number;
}

// The whole row, not a structural subset: `batchTransactionIds` re-derives the
// batch from the order's device and client request id, so it needs the fields
// a hand-written subset kept leaving out.
function toCreateOrderDto(deps: AuthedApiDeps, order: PendingOrderRow): CreateOrderDto {
  const profitBps = profitBpsFrom(
    deps.driver.readSetting(order.merchant_id as MerchantId, 'PROFIT_PERCENT_BPS'),
  );
  return {
    orderId: order.id,
    network: order.network,
    productId: order.product_id,
    productType: order.product_type,
    amountMinor: order.amount_minor,
    quantity: order.quantity,
    totalMinor: order.total_minor,
    expiresAt: order.expires_at,
    status: order.status,
    transactionId: order.transaction_id,
    transactionIds: order.status === 'AUTHORIZED' ? batchTransactionIds(deps, order) : [],
    recipientMasked: order.recipient,
    // Profit on the whole order, so a batch of ten shows what ten earns.
    profitMinor: trainingProfitMinor(order.amount_minor, profitBps) * order.quantity,
    profitBps,
  };
}

function validateOrderBody(body: unknown): CreatePendingOrderRequest | string {
  if (typeof body !== 'object' || body === null) return 'BODY_NOT_AN_OBJECT';
  const b = body as Record<string, unknown>;
  for (const field of ['network', 'productType', 'productId', 'clientRequestId']) {
    const value = b[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      return `${field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).toUpperCase()}_REQUIRED`;
    }
  }
  // Optional, and only meaningful for a custom product. Accepted as a number
  // or a numeric string, because a form body carries strings; anything else
  // is refused here rather than coerced into a surprising value.
  const supplied = b['customAmountMinor'];
  const request = { ...(b as unknown as CreatePendingOrderRequest) };

  if (supplied !== undefined && supplied !== '') {
    const parsed = typeof supplied === 'number' ? supplied : Number(supplied);
    if (!Number.isSafeInteger(parsed)) return 'AMOUNT_NOT_A_NUMBER';
    (request as { customAmountMinor?: number }).customAmountMinor = parsed;
  }

  // Same treatment for the bulk-print quantity: a form body carries strings,
  // and anything that is not a whole number is refused here rather than
  // coerced. Absent means one, which is what every order was before.
  const quantity = b['quantity'];
  if (quantity !== undefined && quantity !== '') {
    const parsed = typeof quantity === 'number' ? quantity : Number(quantity);
    if (!Number.isSafeInteger(parsed)) return 'QUANTITY_INVALID';
    (request as { quantity?: number }).quantity = parsed;
  }

  return request;
}

/**
 * `POST /api/training/deposits/chapa` — start a Chapa payment.
 *
 * §20.2. Creates a top-up order and returns Chapa's checkout URL. **Credits
 * nothing**: the balance moves only when Chapa's own record confirms the
 * payment, which happens on the webhook path.
 */
export async function postChapaDeposit(
  deps: AuthedApiDeps,
  request: HttpRequest,
  context: AuthContext,
  correlationId: string,
): Promise<HttpResponse> {
  const refused = assertTraining(deps, correlationId);
  if (refused) return refused;

  const chapa = deps.chapa;
  if (chapa === undefined) {
    return fail(deps, correlationId, 400, 'INVALID_REQUEST', 'DISABLED', 'chapa.refused.disabled');
  }

  const body = request.body as Record<string, unknown> | null;
  const raw = body?.['amountBirr'];
  const birr = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(birr)) {
    return fail(
      deps,
      correlationId,
      400,
      'INVALID_REQUEST',
      'AMOUNT_INVALID',
      'bank_deposit.refused.amount_invalid',
    );
  }

  const result = await startChapaDeposit(deps, context, chapa, {
    amountMinor: Math.round(birr * 100),
    correlationId,
  });

  switch (result.kind) {
    case 'DISABLED':
      return fail(deps, correlationId, 400, 'INVALID_REQUEST', 'DISABLED', 'chapa.refused.disabled');
    case 'REFUSED':
      return fail(
        deps,
        correlationId,
        400,
        'INVALID_REQUEST',
        result.reason,
        'bank_deposit.refused.amount_invalid',
      );
    case 'PROVIDER_UNAVAILABLE':
      // 502: Telga is fine, the gateway is not. Distinct from a refusal so the
      // screen can say "nothing was charged" rather than blaming the amount.
      return fail(
        deps,
        correlationId,
        502,
        'PROVIDER_UNAVAILABLE',
        'PROVIDER_UNAVAILABLE',
        'chapa.refused.unavailable',
      );
    case 'STARTED':
      return ok(deps, correlationId, { reference: result.reference, checkoutUrl: result.checkoutUrl }, 201);
  }
}

/**
 * `POST /api/training/transfers` — send balance to another shop.
 *
 * §19.1, and **not a deposit**: no value enters Telga, an amount that already
 * exists moves sideways. Both ledger sides and the `shop_transfers` row go in
 * one transaction, because a transfer that debited without crediting is money
 * destroyed.
 */
export function postShopTransferRequest(
  deps: AuthedApiDeps,
  request: HttpRequest,
  context: AuthContext,
  correlationId: string,
): HttpResponse {
  const refused = assertTraining(deps, correlationId);
  if (refused) return refused;

  const body = request.body as Record<string, unknown> | null;
  const recipientDeviceId = String(body?.['recipientDeviceId'] ?? '').trim();
  const raw = body?.['amountBirr'];
  const birr = typeof raw === 'number' ? raw : Number(raw);

  if (recipientDeviceId.length === 0) {
    return fail(
      deps,
      correlationId,
      400,
      'INVALID_REQUEST',
      'RECIPIENT_UNKNOWN',
      'transfer.refused.recipient_unknown',
    );
  }
  if (!Number.isFinite(birr)) {
    return fail(deps, correlationId, 400, 'INVALID_REQUEST', 'AMOUNT_INVALID', 'transfer.refused.amount_invalid');
  }

  const result = settleShopTransfer(
    {
      deps,
      policy: TRAINING_TRANSFER_POLICY,
      availableMinor: (merchantId) => deps.driver.balanceFor(merchantId as never).available.minor,
      // The balanced pair, posted inside the transaction `settleShopTransfer`
      // opens around the row.
      postTransfer: (input) => {
        postShopTransfer(deps.driver as never, {
          senderMerchantId: input.senderMerchantId as never,
          recipientMerchantId: input.recipientMerchantId as never,
          amount: money(input.amountMinor),
          fee: money(input.feeMinor),
          at: input.at as never,
          correlationId: input.correlationId,
          postingId: postingId(input.postingId),
        });
      },
    },
    {
      senderMerchantId: context.merchantId,
      senderDeviceId: context.deviceId,
      senderOperatorId: context.userId,
      recipientDeviceId,
      amountMinor: Math.round(birr * 100),
    },
  );

  switch (result.kind) {
    case 'REFUSED':
      return fail(deps, correlationId, 400, 'INVALID_REQUEST', result.reason, 'transfer.refused.amount_invalid');
    case 'NEEDS_APPROVAL':
      // 202: recorded, awaiting a supervisor. **Not** a success — the screen
      // must not tell an operator the other shop has the money.
      return ok(
        deps,
        correlationId,
        { status: 'NEEDS_APPROVAL', amountMinor: result.amountMinor, feeMinor: result.feeMinor },
        202,
      );
    case 'SETTLED':
      return ok(
        deps,
        correlationId,
        {
          status: 'SETTLED',
          amountMinor: result.amountMinor,
          feeMinor: result.feeMinor,
          recipientMerchantId: result.recipientMerchantId,
        },
        201,
      );
  }
}

/**
 * `POST /api/training/deposits/orders` — ask for a bank payment slip.
 *
 * §20.1. Creates the order and returns its reference. **Credits nothing**: a
 * shop's balance after this call is exactly what it was before, and the screen
 * that renders the reply says so in words.
 */
export function postBankDepositOrder(
  deps: AuthedApiDeps,
  request: HttpRequest,
  context: AuthContext,
  correlationId: string,
): HttpResponse {
  const refused = assertTraining(deps, correlationId);
  if (refused) return refused;

  const body = request.body as Record<string, unknown> | null;
  const raw = body?.['amountBirr'];
  const birr = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(birr)) {
    return fail(
      deps,
      correlationId,
      400,
      'INVALID_REQUEST',
      'AMOUNT_INVALID',
      'bank_deposit.refused.amount_invalid',
    );
  }

  const result = orderBankDeposit(deps, context, {
    amountMinor: Math.round(birr * 100),
    correlationId,
  });

  switch (result.kind) {
    case 'SIMULATED_ONLY':
      return fail(deps, correlationId, 403, 'SIMULATED_ONLY', 'LIVE_MODE_REFUSED', 'mode.training');
    case 'REFUSED':
      // The reason travels as the reason code, so the screen can show the one
      // sentence that fits rather than a generic refusal.
      return fail(
        deps,
        correlationId,
        400,
        'INVALID_REQUEST',
        result.reason,
        'bank_deposit.refused.amount_invalid',
      );
    case 'ORDERED':
      return ok(
        deps,
        correlationId,
        {
          orderId: result.orderId,
          reference: result.reference,
          amountMinor: result.amountMinor,
          issuedAt: result.issuedAt,
          expiresAt: result.expiresAt,
        },
        201,
      );
  }
}

/** `GET /api/training/deposits/orders/open` — the slip this shop is holding. */
export function getBankDepositOrder(
  deps: AuthedApiDeps,
  _request: HttpRequest,
  context: AuthContext,
  correlationId: string,
): HttpResponse {
  const open = openBankDeposit(deps, context);
  return ok(deps, correlationId, { order: open ?? null });
}

/** `POST /api/training/deposits/orders/cancel` — abandon an unpaid slip. */
export function postCancelBankDepositOrder(
  deps: AuthedApiDeps,
  _request: HttpRequest,
  context: AuthContext,
  correlationId: string,
): HttpResponse {
  const refused = assertTraining(deps, correlationId);
  if (refused) return refused;
  return ok(deps, correlationId, { cancelled: cancelBankDeposit(deps, context) });
}

/**
 * `POST /api/training/profit/transfers` — move earned profit to the balance.
 *
 * The refusal for "more than you earned" carries the actual figure, so the
 * screen can tell an owner what they *can* move rather than only that they
 * cannot move what they asked for.
 */
export function postProfitTransfer(
  deps: AuthedApiDeps,
  request: HttpRequest,
  context: AuthContext,
  correlationId: string,
): HttpResponse {
  const refused = assertTraining(deps, correlationId);
  if (refused) return refused;

  const body = request.body as Record<string, unknown> | null;
  const raw = body?.['amountBirr'];
  const birr = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(birr)) {
    return fail(deps, correlationId, 400, 'INVALID_REQUEST', 'AMOUNT_NOT_A_NUMBER', 'profit.transfer.amount_invalid');
  }

  const result = transferProfit(deps, context, {
    amountMinor: Math.round(birr * 100),
    correlationId,
  });

  switch (result.kind) {
    case 'SIMULATED_ONLY':
      return fail(deps, correlationId, 403, 'ACCESS_DENIED', 'LIVE_MODE_REFUSED', 'status.sales_unavailable');
    case 'AMOUNT_INVALID':
      return fail(deps, correlationId, 400, 'INVALID_REQUEST', `AMOUNT_${result.reason}`, 'profit.transfer.amount_invalid');
    case 'EXCEEDS_PROFIT':
      return fail(
        deps,
        correlationId,
        400,
        'INVALID_REQUEST',
        `EXCEEDS_PROFIT:${String(result.profitAvailableMinor)}`,
        'profit.transfer.exceeds',
      );
    case 'TRANSFERRED':
      return ok(deps, correlationId, {
        amountMinor: result.amountMinor,
        profitRemainingMinor: result.profitRemainingMinor,
        availableAfterMinor: result.availableAfterMinor,
      });
  }
}

/**
 * `POST /api/training/operators/pin` — change a transaction PIN.
 *
 * The new PIN is hashed before anything else touches it and is never put in
 * a response, a log line, or an audit `metadata` blob. The current PIN is
 * required as well: possession of an open owner session should not be enough
 * to change the credential that authorizes sales, because a session left open
 * on a counter is exactly the case this protects against.
 */
export async function postChangePin(
  deps: AuthedApiDeps,
  request: HttpRequest,
  context: AuthContext,
  correlationId: string,
): Promise<HttpResponse> {
  const refused = assertTraining(deps, correlationId);
  if (refused) return refused;

  const body = request.body as Record<string, unknown> | null;
  const currentPin = typeof body?.['currentPin'] === 'string' ? (body['currentPin']) : '';
  const newPin = typeof body?.['newPin'] === 'string' ? (body['newPin']) : '';

  const result = await changePin(deps, context, { currentPin, newPin, correlationId });
  switch (result.kind) {
    case 'SIMULATED_ONLY':
      return fail(deps, correlationId, 403, 'ACCESS_DENIED', 'LIVE_MODE_REFUSED', 'status.sales_unavailable');
    case 'CURRENT_PIN_WRONG':
      return fail(deps, correlationId, 400, 'INVALID_REQUEST', 'CURRENT_PIN_WRONG', 'settings.pin.wrong_current');
    case 'NEW_PIN_WEAK':
      return fail(deps, correlationId, 400, 'INVALID_REQUEST', `NEW_PIN_${result.reason}`, 'settings.pin.weak');
    case 'CHANGED':
      return ok(deps, correlationId, { changed: true });
  }
}

/** `POST /api/training/orders` — creates a pending order, nothing else. */
export function postOrder(
  deps: AuthedApiDeps,
  request: HttpRequest,
  context: AuthContext,
  correlationId: string,
): HttpResponse {
  const refused = assertTraining(deps, correlationId);
  if (refused) return refused;

  const parsed = validateOrderBody(request.body);
  if (typeof parsed === 'string') {
    return fail(deps, correlationId, 400, 'INVALID_REQUEST', parsed, 'voucher.amount.invalid');
  }

  const result = createPendingOrder(deps, context, parsed);
  switch (result.kind) {
    case 'SIMULATED_ONLY':
      return fail(deps, correlationId, 403, 'SIMULATED_ONLY', 'LIVE_MODE_REFUSED', 'mode.training');
    case 'PRODUCT_INVALID':
      return fail(deps, correlationId, 400, 'INVALID_REQUEST', 'PRODUCT_INVALID', 'voucher.amount.invalid');
    case 'AMOUNT_INVALID':
      // The reason code names which rule was broken, so the operator is told
      // "below the minimum" rather than a vague "invalid".
      return fail(deps, correlationId, 400, 'INVALID_REQUEST', result.reason, 'voucher.amount.invalid');
    case 'QUANTITY_INVALID':
      return fail(deps, correlationId, 400, 'INVALID_REQUEST', 'QUANTITY_INVALID', 'voucher.quantity.invalid');
    case 'RECIPIENT_INVALID':
      return fail(
        deps,
        correlationId,
        400,
        'INVALID_REQUEST',
        'RECIPIENT_INVALID',
        'error.validation.recipient',
      );
    case 'INSUFFICIENT_BALANCE':
      // The available figure travels in the reason code so the screen can
      // state it without a second round trip.
      return fail(
        deps,
        correlationId,
        400,
        'INSUFFICIENT_BALANCE',
        `INSUFFICIENT_AVAILABLE_BALANCE:${String(result.availableMinor)}`,
        'voucher.error.insufficient_balance',
      );
    case 'CREATED':
      return ok(deps, correlationId, toCreateOrderDto(deps, result.order), 201);
  }
}

/** `GET /api/training/orders/:id` */
export function getOrder(
  deps: AuthedApiDeps,
  _request: HttpRequest,
  context: AuthContext,
  correlationId: string,
  params: Readonly<Record<string, string>>,
): HttpResponse {
  const id = params['id'];
  if (id === undefined || id.trim().length === 0) {
    return fail(deps, correlationId, 400, 'INVALID_REQUEST', 'ORDER_ID_REQUIRED', 'voucher.amount.invalid');
  }
  const found = getOrderForContext(deps, context, id);
  if (found.kind === 'NOT_FOUND') {
    return fail(deps, correlationId, 404, 'NOT_FOUND', 'ORDER_NOT_FOUND', 'error.permission.denied');
  }
  return ok(deps, correlationId, toCreateOrderDto(deps, found.order));
}

/** `POST /api/training/orders/:id/cancel` */
export function postCancelOrder(
  deps: AuthedApiDeps,
  _request: HttpRequest,
  context: AuthContext,
  correlationId: string,
  params: Readonly<Record<string, string>>,
): HttpResponse {
  const id = params['id'];
  if (id === undefined || id.trim().length === 0) {
    return fail(deps, correlationId, 400, 'INVALID_REQUEST', 'ORDER_ID_REQUIRED', 'voucher.amount.invalid');
  }
  const result = cancelOrder(deps, context, id);
  if (result.kind === 'NOT_FOUND') {
    return fail(deps, correlationId, 404, 'NOT_FOUND', 'ORDER_NOT_FOUND', 'error.permission.denied');
  }
  return ok(deps, correlationId, { cancelled: true });
}

/**
 * `POST /api/training/orders/:id/authorize`
 *
 * The PIN is read once, from the body, and never written to any variable
 * that outlives `authorizeOrder`'s own call — this handler never logs it,
 * never echoes it, and never puts it anywhere but the one function call that
 * needs it.
 */
export async function postAuthorizeOrder(
  deps: AuthedApiDeps,
  request: HttpRequest,
  context: AuthContext,
  correlationId: string,
  params: Readonly<Record<string, string>>,
): Promise<HttpResponse> {
  const refused = assertTraining(deps, correlationId);
  if (refused) return refused;

  const id = params['id'];
  const body = request.body as Record<string, unknown> | undefined;
  const pin = typeof body?.['pin'] === 'string' ? (body['pin']) : '';
  if (id === undefined || id.trim().length === 0 || pin.length === 0) {
    return fail(deps, correlationId, 400, 'INVALID_REQUEST', 'PIN_REQUIRED', 'voucher.pin.wrong');
  }

  const result = await authorizeOrder(deps, context, id, pin, correlationId);
  switch (result.kind) {
    case 'SIMULATED_ONLY':
      return fail(deps, correlationId, 403, 'SIMULATED_ONLY', 'LIVE_MODE_REFUSED', 'mode.training');
    case 'NOT_FOUND':
      return fail(deps, correlationId, 404, 'NOT_FOUND', 'ORDER_NOT_FOUND', 'error.permission.denied');
    case 'NOT_OPEN':
      return fail(deps, correlationId, 409, 'INVALID_REQUEST', 'ORDER_NOT_OPEN', 'voucher.amount.invalid');
    case 'EXPIRED':
      return fail(deps, correlationId, 409, 'INVALID_REQUEST', 'ORDER_EXPIRED', 'voucher.amount.invalid');
    case 'LOCKED':
      return fail(deps, correlationId, 423, 'RATE_LIMITED', 'PIN_LOCKED', 'voucher.pin.locked');
    case 'PIN_INVALID':
      return fail(deps, correlationId, 401, 'UNAUTHORIZED', 'PIN_INVALID', 'voucher.pin.wrong');
    case 'SALE':
      return saleResultResponse(deps, correlationId, result.result);
  }
}

// --- settings ---------------------------------------------------------------

/**
 * `GET /api/training/settings`
 *
 * Readable by any operator: the slip has to print with the shop's chosen
 * width and advertising line whoever is at the counter. Only the write below
 * is owner-only.
 */
export function getSettings(
  deps: AuthedApiDeps,
  _request: HttpRequest,
  context: AuthContext,
  correlationId: string,
): HttpResponse {
  return ok(deps, correlationId, readSettings(deps, context.merchantId));
}

/** `POST /api/training/settings` — owner only, per the route table. */
export function postSettings(
  deps: AuthedApiDeps,
  request: HttpRequest,
  context: AuthContext,
  correlationId: string,
): HttpResponse {
  const refused = assertTraining(deps, correlationId);
  if (refused) return refused;

  const body = request.body as Record<string, unknown> | undefined;
  if (typeof body !== 'object' || body === null) {
    return fail(deps, correlationId, 400, 'INVALID_REQUEST', 'BODY_NOT_AN_OBJECT', 'error.validation.recipient');
  }

  // Only strings are forwarded. A number, an array or an object for any of
  // these fields is a malformed request, not a value to coerce.
  const stringOrUndefined = (key: string): string | undefined =>
    typeof body[key] === 'string' ? (body[key]) : undefined;

  const result = writeSettings(
    deps,
    context,
    {
      slipSize: stringOrUndefined('slipSize'),
      slipAdvert: stringOrUndefined('slipAdvert'),
      profitPercent: stringOrUndefined('profitPercent'),
      businessName: stringOrUndefined('businessName'),
      businessAddress: stringOrUndefined('businessAddress'),
      businessPhone: stringOrUndefined('businessPhone'),
      businessTin: stringOrUndefined('businessTin'),
      businessLicence: stringOrUndefined('businessLicence'),
      slipFooter: stringOrUndefined('slipFooter'),
      soundEnabled: stringOrUndefined('soundEnabled'),
      hideBalance: stringOrUndefined('hideBalance'),
      lowBalanceAlert: stringOrUndefined('lowBalanceAlert'),
      statementsAdminOnly: stringOrUndefined('statementsAdminOnly'),
      printBarcode: stringOrUndefined('printBarcode'),
      printLookupSlip: stringOrUndefined('printLookupSlip'),
      screenLockEnabled: stringOrUndefined('screenLockEnabled'),
      lockSeconds: stringOrUndefined('lockSeconds'),
    },
    correlationId,
  );

  switch (result.kind) {
    case 'SIMULATED_ONLY':
      return fail(deps, correlationId, 403, 'SIMULATED_ONLY', 'LIVE_MODE_REFUSED', 'mode.training');
    case 'SLIP_SIZE_INVALID':
      return fail(deps, correlationId, 400, 'INVALID_REQUEST', 'SLIP_SIZE_INVALID', 'settings.slip_size.label');
    case 'ADVERT_INVALID':
      return fail(deps, correlationId, 400, 'INVALID_REQUEST', 'ADVERT_INVALID', 'settings.advert.hint');
    case 'LOCK_SECONDS_INVALID':
      return fail(deps, correlationId, 400, 'INVALID_REQUEST', 'LOCK_SECONDS_INVALID', 'settings.lock_seconds');
    case 'PROFIT_INVALID':
      return fail(deps, correlationId, 400, 'INVALID_REQUEST', 'PROFIT_INVALID', 'settings.profit.invalid');
    case 'SAVED':
      return ok(deps, correlationId, result.settings);
  }
}

// --- Telga Pay training deposits --------------------------------------------

/**
 * `POST /api/training/pay/deposits`
 *
 * Credits the simulated float. Owner-only and CSRF-protected like every other
 * write; see `application/deposits.ts` for why this is not payment acceptance.
 */
export function postDeposit(
  deps: AuthedApiDeps,
  request: HttpRequest,
  context: AuthContext,
  correlationId: string,
): HttpResponse {
  const refused = assertTraining(deps, correlationId);
  if (refused) return refused;

  const body = request.body as Record<string, unknown> | undefined;
  const amountMinor = typeof body?.['amountMinor'] === 'number' ? (body['amountMinor']) : NaN;
  const method = typeof body?.['method'] === 'string' ? (body['method']) : '';
  const clientRequestId =
    typeof body?.['clientRequestId'] === 'string' ? (body['clientRequestId']) : '';

  if (clientRequestId.trim().length === 0) {
    return fail(deps, correlationId, 400, 'INVALID_REQUEST', 'CLIENT_REQUEST_ID_REQUIRED', 'error.validation.recipient');
  }

  const result = depositTrainingFunds(deps, context, { amountMinor, method, clientRequestId });
  switch (result.kind) {
    case 'SIMULATED_ONLY':
      return fail(deps, correlationId, 403, 'SIMULATED_ONLY', 'LIVE_MODE_REFUSED', 'mode.training');
    case 'METHOD_INVALID':
      return fail(deps, correlationId, 400, 'INVALID_REQUEST', 'CARD_METHOD_INVALID', 'pay.deposit.invalid');
    case 'AMOUNT_INVALID':
      return fail(deps, correlationId, 400, 'INVALID_REQUEST', result.reason, 'pay.deposit.invalid');
    case 'CREDITED':
      return ok(deps, correlationId, result.receipt, 201);
    // 200, not 201: nothing was created this time. The operator still reaches
    // the slip, because their deposit is exactly as done as they asked for.
    case 'ALREADY_CREDITED':
      return ok(deps, correlationId, result.receipt, 200);
  }
}
