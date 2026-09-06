/**
 * Voucher pending orders: creation, PIN authorization, and cancellation.
 *
 * ## What this file deliberately does not do
 *
 * It never accepts network, product or amount from a request once an order
 * exists — `authorizeOrder` and `cancelOrder` take only an order id, look the
 * rest up from the row `createPendingOrder` wrote, and re-check it belongs to
 * the caller's session, device and merchant. There is nothing left in a later
 * request for a client to change.
 *
 * ## PIN_AUTH lockout is not login lockout
 *
 * A wrong voucher PIN is recorded as a `PIN_AUTH` failure in `auth_attempts`
 * and nowhere else. It never calls `recordFailedLogin` and never touches
 * `merchant_users.failed_attempts` or `locked_until` — a merchant who fails a
 * voucher PIN five times can still sign in immediately afterward. The lockout
 * is a plain trailing-window failure count (`countFailuresSince`), so there is
 * no stored "locked until" value to expire or clear.
 */

import type {
  CustomAmountRejection,
  DeviceId,
  MerchantId,
  MerchantUserId,
  ProductId,
} from '@telga/domain';
import {
  customAmountRejection,
  deriveIdempotencyKey,
  money,
  transactionId as toTransactionId,
} from '@telga/domain';
import type { PendingOrderRow } from '@telga/persistence';
import { maskRecipient } from '@telga/persistence';
import type { AuthContext } from '../auth/context';
import { shiftBy } from '../auth/context';
import { verifySecret } from '../auth/secrets';
import { createSale } from './createSale';
import type { SaleResult } from './results';
import type { AuthedApiDeps } from '../http/deps';

/**
 * The idempotency payload's stand-in when a product has no recipient.
 *
 * It contributes to the request fingerprint and **never reaches a slip**: the
 * sale carries `recipientMasked: ''` alongside it, so the receipt omits the
 * line entirely. Masking this string used to print `VOUC****…****ENT` on
 * every counter voucher — a row of stars where a phone number would go, on a
 * product that has no phone number at all.
 */
const NO_RECIPIENT = 'VOUCHER-SALE-NO-RECIPIENT';

export const PENDING_ORDER_EXPIRY_MS = 10 * 60_000;

// --- create ------------------------------------------------------------------

export type CreatePendingOrderResult =
  | { readonly kind: 'CREATED'; readonly order: PendingOrderRow }
  | { readonly kind: 'SIMULATED_ONLY' }
  | { readonly kind: 'PRODUCT_INVALID' }
  | { readonly kind: 'RECIPIENT_INVALID' }
  | { readonly kind: 'QUANTITY_INVALID' }
  | { readonly kind: 'AMOUNT_INVALID'; readonly reason: CustomAmountRejection }
  | {
      readonly kind: 'INSUFFICIENT_BALANCE';
      readonly availableMinor: number;
      readonly requestedMinor: number;
    };

export interface CreatePendingOrderRequest {
  readonly network: string;
  readonly productType: string;
  readonly productId: string;
  readonly clientRequestId: string;
  /**
   * Present only for a custom product. Minor units, supplied by the operator.
   * Never trusted: bounded here and re-checked against the balance.
   */
  readonly customAmountMinor?: number;
  /** The customer's phone number. Masked before storage; never stored raw. */
  readonly recipient?: string;
  /** How many vouchers to print. Defaults to 1; bounded by `QUANTITY_LIMITS`. */
  readonly quantity?: number;
}

/**
 * Bulk-printing bounds.
 *
 * A training ceiling rather than a business rule — it stops a typo becoming
 * two hundred ledger postings. Mirrored by the CHECK on `pending_orders`, so
 * a request that somehow bypasses this service still cannot store one.
 */
export const QUANTITY_LIMITS = Object.freeze({ min: 1, max: 20 });

export function quantityRejection(quantity: number): 'QUANTITY_INVALID' | undefined {
  if (!Number.isSafeInteger(quantity)) return 'QUANTITY_INVALID';
  if (quantity < QUANTITY_LIMITS.min || quantity > QUANTITY_LIMITS.max) return 'QUANTITY_INVALID';
  return undefined;
}

/** Refuse a recipient that is obviously not a phone number, before storing it. */
export function recipientRejection(recipient: string): 'RECIPIENT_INVALID' | undefined {
  const digits = recipient.replace(/[\s-]/g, '');
  return /^\+?\d{9,15}$/.test(digits) ? undefined : 'RECIPIENT_INVALID';
}

export function createPendingOrder(
  deps: AuthedApiDeps,
  context: AuthContext,
  request: CreatePendingOrderRequest,
): CreatePendingOrderResult {
  if (deps.mode !== 'TRAINING') return { kind: 'SIMULATED_ONLY' };

  const product = deps.voucherCatalog.find(request.productId);
  if (
    product === undefined ||
    !product.available ||
    product.network !== request.network ||
    product.productType !== request.productType
  ) {
    return { kind: 'PRODUCT_INVALID' };
  }

  // A custom product carries no denomination of its own: the operator's typed
  // amount is the amount, bounded here rather than by the browser. A fixed
  // product ignores any supplied amount entirely, so a tampered field cannot
  // change what a denomination costs.
  let amountMinor = product.amountMinor;
  if (product.isCustom === true) {
    const supplied = request.customAmountMinor;
    if (supplied === undefined) return { kind: 'AMOUNT_INVALID', reason: 'AMOUNT_NOT_A_NUMBER' };
    const rejection = customAmountRejection(supplied);
    if (rejection !== undefined) return { kind: 'AMOUNT_INVALID', reason: rejection };
    amountMinor = supplied;
  }

  const quantity = request.quantity ?? 1;
  if (quantityRejection(quantity) !== undefined) return { kind: 'QUANTITY_INVALID' };

  // Checked before the order is even created, so an operator is told they
  // cannot afford it while still on the amount screen. `createSale` re-checks
  // atomically at authorization — this is the early, friendly refusal, not
  // the authoritative one. The whole order has to be affordable, not one
  // voucher of it: ten 25-birr vouchers needs 250 birr on hand.
  const requestedMinor = amountMinor * quantity;
  const availableMinor = deps.driver.balanceFor(context.merchantId).available.minor;
  if (requestedMinor > availableMinor) {
    return { kind: 'INSUFFICIENT_BALANCE', availableMinor, requestedMinor };
  }

  // A recipient is required for a top-up and for a data bundle — both are
  // delivered to a phone, so there is nowhere else for them to go. It stays
  // optional for a denomination voucher, which is handed across the counter.
  const needsRecipient = request.productType === 'TOPUP' || request.productType === 'DATA';
  const supplied = request.recipient?.trim() ?? '';
  if (needsRecipient && supplied.length === 0) {
    return { kind: 'RECIPIENT_INVALID' };
  }
  if (supplied.length > 0 && recipientRejection(supplied) !== undefined) {
    return { kind: 'RECIPIENT_INVALID' };
  }

  const now = deps.now();
  const order = deps.driver.createPendingOrder({
    id: deps.newId('order'),
    merchantId: context.merchantId,
    deviceId: context.deviceId,
    operatorId: context.userId,
    sessionId: context.sessionId,
    network: product.network,
    productId: product.productId,
    // Narrowed from the request only after the catalog has already agreed
    // the product carries this type, so an unknown value cannot reach here.
    productType:
      request.productType === 'TOPUP'
        ? 'TOPUP'
        : request.productType === 'DATA'
          ? 'DATA'
          : 'AIRTIME',
    // Masked at the boundary: the full number is never written to the order
    // row, exactly as the transaction table has always stored only a mask.
    recipient: supplied.length > 0 ? maskRecipient(supplied) : null,
    amountMinor,
    quantity,
    clientRequestId: request.clientRequestId,
    createdAt: now,
    expiresAt: shiftBy(now, PENDING_ORDER_EXPIRY_MS),
  });
  return { kind: 'CREATED', order };
}

/**
 * The transactions one order produced, in print order.
 *
 * Re-derived rather than stored. Each voucher's client request id is a pure
 * function of the order's (`batchRequestId`), and an idempotency key is a
 * pure function of merchant, device and that id — so the whole batch can be
 * found again from the order row alone, with no column to hold a list in and
 * no chance of the list disagreeing with what was actually created.
 *
 * A missing record is skipped rather than faked: a batch whose third sale
 * failed returns two ids, which is the truth.
 */
export function batchTransactionIds(
  deps: AuthedApiDeps,
  order: PendingOrderRow,
): readonly string[] {
  const ids: string[] = [];
  for (let index = 0; index < order.quantity; index += 1) {
    const key = deriveIdempotencyKey({
      merchantId: order.merchant_id as MerchantId,
      deviceId: order.device_id as DeviceId,
      productId: order.product_id as ProductId,
      amount: money(order.amount_minor),
      recipient: order.recipient ?? NO_RECIPIENT,
      clientRequestId: batchRequestId(order.client_request_id, index),
    });
    const record = deps.driver.findIdempotencyRecord(order.merchant_id as MerchantId, key);
    if (record !== undefined) ids.push(record.transaction_id);
  }
  return ids;
}

// --- read, bound to the caller ------------------------------------------------

export type GetOrderResult =
  | { readonly kind: 'FOUND'; readonly order: PendingOrderRow }
  | { readonly kind: 'NOT_FOUND' };

/**
 * Loads an order and proves it belongs to this session, device and merchant.
 * A foreign or nonexistent id produces the identical `NOT_FOUND` — the same
 * indistinguishable-404 discipline `getTransaction` already uses.
 */
export function getOrderForContext(
  deps: AuthedApiDeps,
  context: AuthContext,
  orderId: string,
): GetOrderResult {
  deps.driver.expirePendingOrderIfDue(orderId, deps.now());
  const order = deps.driver.findPendingOrder(orderId);
  if (
    order === undefined ||
    order.session_id !== context.sessionId ||
    order.device_id !== context.deviceId ||
    order.merchant_id !== context.merchantId
  ) {
    return { kind: 'NOT_FOUND' };
  }
  return { kind: 'FOUND', order };
}

// --- cancel --------------------------------------------------------------------

export type CancelOrderResult = { readonly kind: 'CANCELLED' } | { readonly kind: 'NOT_FOUND' };

export function cancelOrder(
  deps: AuthedApiDeps,
  context: AuthContext,
  orderId: string,
): CancelOrderResult {
  const found = getOrderForContext(deps, context, orderId);
  if (found.kind === 'NOT_FOUND') return { kind: 'NOT_FOUND' };
  // Not `OPEN` (already authorized, cancelled, or expired): cancel is a no-op,
  // not an error — the operator's intent ("stop this order") is already true.
  deps.driver.cancelPendingOrder(orderId);
  return { kind: 'CANCELLED' };
}

// --- authorize -------------------------------------------------------------

export type AuthorizeOrderResult =
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'NOT_OPEN' }
  | { readonly kind: 'EXPIRED' }
  | { readonly kind: 'LOCKED' }
  | { readonly kind: 'PIN_INVALID' }
  | { readonly kind: 'SIMULATED_ONLY' }
  | {
      readonly kind: 'SALE';
      /** The first sale, which is the whole order when quantity is 1. */
      readonly result: SaleResult;
      /** Every sale the order produced, in print order. */
      readonly results: readonly SaleResult[];
    };

/**
 * The client request id for the Nth voucher of an order.
 *
 * Derived rather than generated, so the whole batch is idempotent the way a
 * single sale is: replaying an authorization produces the same N keys and
 * therefore the same N transactions, not a second batch. It is also how the
 * result screen finds the batch again without a new column to store it in.
 */
export const batchRequestId = (clientRequestId: string, index: number): string =>
  index === 0 ? clientRequestId : `${clientRequestId}#${String(index + 1)}`;

/**
 * Verify the PIN and, on success, create the sale.
 *
 * Order matters, mirroring `login()`'s own discipline: lockout is checked
 * before the PIN is verified, so a locked operator costs a database read
 * rather than a scrypt derivation.
 */
export async function authorizeOrder(
  deps: AuthedApiDeps,
  context: AuthContext,
  orderId: string,
  pin: string,
  correlationId: string,
): Promise<AuthorizeOrderResult> {
  if (deps.mode !== 'TRAINING') return { kind: 'SIMULATED_ONLY' };

  const found = getOrderForContext(deps, context, orderId);
  if (found.kind === 'NOT_FOUND') return { kind: 'NOT_FOUND' };
  const order = found.order;
  if (order.status === 'EXPIRED') return { kind: 'EXPIRED' };
  if (order.status !== 'OPEN') return { kind: 'NOT_OPEN' };

  const now = deps.now();
  const policy = deps.authConfig.pinLockout ?? deps.authConfig.lockout;
  const subject = context.userId;

  const lockoutWindowStart = shiftBy(now, -policy.lockoutMs);
  const recentFailures = deps.driver.countFailuresSince('PIN_AUTH', subject, lockoutWindowStart);
  if (recentFailures >= policy.maxFailedAttempts) {
    return { kind: 'LOCKED' };
  }

  const rateWindowStart = shiftBy(now, -policy.rateWindowMs);
  const recentAttempts = deps.driver.countAttemptsSince('PIN_AUTH', subject, rateWindowStart);
  if (recentAttempts >= policy.maxAttemptsPerWindow) {
    return { kind: 'LOCKED' };
  }

  const user = deps.driver.findMerchantUser(context.userId, context.merchantId);
  // The session already proved this operator exists; a missing row here would
  // be a deeper inconsistency than a wrong PIN, so it is treated the same way
  // a wrong PIN is — no separate code that would distinguish the two cases.
  const pinOk =
    user !== undefined &&
    (await verifySecret(pin, { hash: user.pin_hash, salt: user.pin_salt, params: user.pin_params }));

  if (!pinOk) {
    deps.driver.recordAttempt('PIN_AUTH', subject, 'FAILURE', now);
    return { kind: 'PIN_INVALID' };
  }
  deps.driver.recordAttempt('PIN_AUTH', subject, 'SUCCESS', now);

  // One PIN, one order — but a voucher each. Ten vouchers is ten things a
  // customer can hold, so it is ten transactions: ten idempotency keys, ten
  // reservations, ten sets of ledger postings and ten distinct simulated
  // redemption codes. A single row could not carry ten different PINs.
  //
  // Sequential rather than concurrent on purpose: each sale reserves against
  // the same float, and letting ten of them race would make the balance
  // check that guards the last one depend on scheduling.
  const quantity = order.quantity;
  const results: SaleResult[] = [];
  for (let index = 0; index < quantity; index += 1) {
    results.push(
      await createSale(deps, {
        merchantId: order.merchant_id as MerchantId,
        deviceId: order.device_id as DeviceId,
        operatorId: order.operator_id as MerchantUserId,
        productId: order.product_id as ProductId,
        amount: money(order.amount_minor),
        // The order row already holds the mask — it was masked at creation
        // and the full number was never kept — so it is passed through rather
        // than re-masked. A product with no recipient carries an empty mask,
        // and the slip omits the line instead of printing stars.
        recipient: order.recipient ?? NO_RECIPIENT,
        recipientMasked: order.recipient ?? '',
        clientRequestId: batchRequestId(order.client_request_id, index),
        correlationId,
      }),
    );
  }

  const result = results[0];
  // The order points at the first voucher. The rest are found by re-deriving
  // their request ids, which is why `batchRequestId` is deterministic.
  if ('transactionId' in result && typeof result.transactionId === 'string') {
    deps.driver.authorizePendingOrder(orderId, toTransactionId(result.transactionId));
  } else if ('originalTransactionId' in result) {
    // DUPLICATE_REQUEST: the sale already exists from a raced first submit.
    // The order still moves to AUTHORIZED, pointing at that same transaction.
    deps.driver.authorizePendingOrder(orderId, toTransactionId(result.originalTransactionId));
  }

  return { kind: 'SALE', result, results };
}
