/**
 * Ordering a bank deposit — `CLAUDE.md` §20.1.
 *
 * A shop presses **Deposit money**, and this creates the row that makes the
 * printed slip answerable: whose deposit it is, how much was promised, and the
 * reference the shop will quote at the bank counter.
 *
 * ## What this does not do, and must never do
 *
 * **It moves no money.** Not a santim, not a reservation, not a pending entry.
 * A shop's balance after ordering a slip is exactly what it was before. The
 * credit happens somewhere else entirely — `recordDeposit` in the console, and
 * only once a bank record has been confirmed.
 *
 * That separation is the feature's whole safety. If this function could credit,
 * printing paper would be a way to create money.
 *
 * ## The reference is drawn by the store, not here
 *
 * `saveTopupOrder` draws codes until the `UNIQUE` index accepts one. This
 * module never chooses a reference, because a module that chose one is where
 * somebody later adds "reuse the shop's last code" — and reuse is the single
 * thing the design cannot survive. A thousand shops paying in the same amount
 * on the same morning must produce a thousand different references.
 */

import {
  TRAINING_TOPUP_POLICY,
  auditEventId,
  createAuditEvent,
  decideTopupOrder,
  money,
  newDepositReference,
  normalizeDepositReference,
  topupOrderExpiry,
} from '@telga/domain';
import type { TopupOrderPolicy, TopupOrderRefusal } from '@telga/domain';
import type { AuthContext } from '../auth/context';
import type { AuthedApiDeps } from '../http/deps';

export type BankDepositResult =
  | {
      readonly kind: 'ORDERED';
      readonly orderId: string;
      readonly reference: string;
      readonly amountMinor: number;
      readonly issuedAt: string;
      readonly expiresAt: string;
    }
  | { readonly kind: 'REFUSED'; readonly reason: TopupOrderRefusal }
  | { readonly kind: 'SIMULATED_ONLY' };

export interface BankDepositRequest {
  readonly amountMinor: number;
  readonly correlationId: string;
}

/**
 * Create a top-up order, or say why not.
 *
 * Refusals are values rather than exceptions: every one is an ordinary thing a
 * shopkeeper can do — too small, too large, already holding a slip — and each
 * has its own sentence on screen.
 */
export function orderBankDeposit(
  deps: AuthedApiDeps,
  context: AuthContext,
  request: BankDepositRequest,
  policy: TopupOrderPolicy = TRAINING_TOPUP_POLICY,
): BankDepositResult {
  // Live money is a different question with a different answer, and this build
  // has not been given it. Same gate as every other value-adjacent service.
  if (deps.mode !== 'TRAINING') return { kind: 'SIMULATED_ONLY' };

  const at = deps.now();
  const merchant = deps.driver.findMerchant(context.merchantId);

  const refusal = decideTopupOrder(
    {
      // A merchant row that does not exist is not `ACTIVE`. Reported as "not
      // active" rather than "no such shop": the caller is already
      // authenticated as that merchant, so a missing row is Telga's problem to
      // investigate, not a different fact to disclose.
      shopStatus: merchant?.status ?? 'UNKNOWN',
      amount: money(request.amountMinor),
      hasOpenOrder: deps.driver.findOpenTopupOrder(context.merchantId, at) !== undefined,
      // §20.1 is a training simulation until a bank feed exists, so the flag
      // that gates training deposits gates this too.
      depositsEnabled: true,
    },
    policy,
  );
  if (refusal !== undefined) return { kind: 'REFUSED', reason: refusal };

  const expiresAt = topupOrderExpiry(new Date(at), policy);
  const orderId = `top_${request.correlationId}`;

  const reference = deps.driver.saveTopupOrder(
    {
      id: orderId,
      merchantId: context.merchantId,
      deviceId: context.deviceId,
      operatorId: context.userId,
      amountMinor: request.amountMinor,
      correlationId: request.correlationId,
      mode: 'TRAINING',
      at,
      expiresAt,
    },
    newDepositReference,
    normalizeDepositReference,
  );

  // Ordering a slip is a thing somebody did with money in mind, so it is
  // audited even though it moves none. An operations desk asking "where did
  // this reference come from" gets an operator and a till.
  deps.driver.saveAuditEvent({
    event: createAuditEvent({
      id: auditEventId(deps.newId('audit')),
      at,
      action: 'TOPUP_ORDER_CREATED',
      actor: { userId: context.userId, role: context.role, deviceId: context.deviceId },
      merchantId: context.merchantId,
    }),
    correlationId: request.correlationId,
    entityType: 'merchant',
    entityId: context.merchantId,
    // The reference is **not a secret**: it authorises nothing, and the whole
    // point of its shape is that the worst somebody holding one can do is give
    // the shop money. It belongs in the trail, because it is the only thing
    // that ties a bank payment back to this moment.
    metadata: { orderId, reference, amountMinor: request.amountMinor },
  });

  return { kind: 'ORDERED', orderId, reference, amountMinor: request.amountMinor, issuedAt: at, expiresAt };
}

/** The shop's live slip, for redisplay and for the "already open" refusal. */
export function openBankDeposit(
  deps: AuthedApiDeps,
  context: AuthContext,
): { readonly reference: string; readonly amountMinor: number; readonly issuedAt: string; readonly expiresAt: string } | undefined {
  const row = deps.driver.findOpenTopupOrder(context.merchantId, deps.now());
  if (row === undefined) return undefined;
  return {
    reference: row.reference,
    amountMinor: row.amount_minor,
    issuedAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Abandon the slip.
 *
 * Only an `OPEN` order cancels, so a shop cannot cancel one that has already
 * been paid — and the reference stays on the row forever either way, so a
 * payment that arrives after a cancellation still resolves to the shop that
 * ordered it rather than to nobody.
 */
export function cancelBankDeposit(deps: AuthedApiDeps, context: AuthContext): boolean {
  const at = deps.now();
  const row = deps.driver.findOpenTopupOrder(context.merchantId, at);
  if (row === undefined) return false;
  const cancelled = deps.driver.cancelTopupOrder(row.id, at) === 1;
  if (!cancelled) return false;

  deps.driver.saveAuditEvent({
    event: createAuditEvent({
      id: auditEventId(deps.newId('audit')),
      at,
      action: 'TOPUP_ORDER_CANCELLED',
      actor: { userId: context.userId, role: context.role, deviceId: context.deviceId },
      merchantId: context.merchantId,
    }),
    correlationId: row.correlation_id,
    entityType: 'merchant',
    entityId: context.merchantId,
    metadata: { orderId: row.id, reference: row.reference },
  });
  return true;
}
