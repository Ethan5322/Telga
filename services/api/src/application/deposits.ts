/**
 * Telga Pay training deposits.
 *
 * ## What this is, and what it is emphatically not
 *
 * This credits a merchant's **simulated** training float so airtime sales can
 * be practised end to end. It is not payment acceptance, not cash-in, and not
 * custody of anyone's money. No card is read, no processor is contacted, and
 * no external system is told anything. The card screen that precedes it is a
 * drawing of a terminal — see `apps/merchant-pos/src/ui/telgaPay.ts`.
 *
 * Recorded as Decision Log **D70**, which reverses the earlier "Telga Pay is
 * UI-only" position for this one training-mode path and states plainly why
 * that is not payment acceptance.
 *
 * ## Why it is still a real ledger posting
 *
 * A deposit that only moved a number on a screen would teach the wrong thing:
 * the whole point of the training float is that a sale reserves against it, a
 * failure releases back to it, and the day's reconciliation adds up. So the
 * credit goes through `fundMerchant` — the same balanced, append-only posting
 * the CLI's `fund` command uses — against `BANK_CLEARING`, in TRAINING mode,
 * which the driver and the schema both refuse to write in any other mode.
 *
 * ## Limits
 *
 * Bounded per deposit. A training float is for practising a shop's day, not
 * for typing a number with nine digits in it and watching what happens.
 */

import { auditEventId, createAuditEvent, money, postingId as toPostingId } from '@telga/domain';
import type { Money } from '@telga/domain';
import { fundMerchant } from '@telga/persistence';
import type { AuthContext } from '../auth/context';
import type { AuthedApiDeps } from '../http/deps';

/** Minor units. 10 birr to 50,000 birr per deposit. */
export const TRAINING_DEPOSIT_LIMITS = Object.freeze({
  minMinor: 1_000,
  maxMinor: 5_000_000,
});

export type DepositRejection =
  | 'AMOUNT_NOT_A_NUMBER'
  | 'AMOUNT_NOT_A_WHOLE_BIRR'
  | 'AMOUNT_BELOW_MINIMUM'
  | 'AMOUNT_ABOVE_MAXIMUM';

/** Refuse anything that is not a whole number of birr inside the limits. */
export function depositRejection(amountMinor: number): DepositRejection | undefined {
  if (!Number.isFinite(amountMinor) || !Number.isSafeInteger(amountMinor)) {
    return 'AMOUNT_NOT_A_NUMBER';
  }
  if (amountMinor % 100 !== 0) return 'AMOUNT_NOT_A_WHOLE_BIRR';
  if (amountMinor < TRAINING_DEPOSIT_LIMITS.minMinor) return 'AMOUNT_BELOW_MINIMUM';
  if (amountMinor > TRAINING_DEPOSIT_LIMITS.maxMinor) return 'AMOUNT_ABOVE_MAXIMUM';
  return undefined;
}

export type CardMethod = 'TAP' | 'INSERT' | 'SWIPE';

const isCardMethod = (value: string): value is CardMethod =>
  value === 'TAP' || value === 'INSERT' || value === 'SWIPE';

export interface DepositReceiptDto {
  readonly depositId: string;
  readonly merchantId: string;
  readonly amountMinor: number;
  readonly currency: 'ETB';
  readonly method: CardMethod;
  readonly issuedAt: string;
  /** The float *after* the credit, so the slip states what the shop now has. */
  readonly availableAfterMinor: number;
}

export type DepositResult =
  | { readonly kind: 'CREDITED'; readonly receipt: DepositReceiptDto }
  /** The same deposit, pressed twice. Credited once; reported as done. */
  | { readonly kind: 'ALREADY_CREDITED'; readonly receipt: DepositReceiptDto }
  | { readonly kind: 'AMOUNT_INVALID'; readonly reason: DepositRejection }
  | { readonly kind: 'METHOD_INVALID' }
  | { readonly kind: 'SIMULATED_ONLY' };

export interface DepositRequest {
  readonly amountMinor: number;
  /** Which of the three simulated card gestures the operator practised. */
  readonly method: string;
  /**
   * Generated once when the deposit screen opens. Reused verbatim if the
   * operator presses twice, so a double submit posts one credit.
   */
  readonly clientRequestId: string;
}

/**
 * Credit the training float.
 *
 * The `clientRequestId` becomes the posting id, so a second press of the same
 * button resolves to the same posting and credits nothing twice. The ledger's
 * own primary key is what actually guarantees that; the explicit check below
 * only decides whether the operator sees their slip or a system error.
 */
export function depositTrainingFunds(
  deps: AuthedApiDeps,
  context: AuthContext,
  request: DepositRequest,
): DepositResult {
  if (deps.mode !== 'TRAINING') return { kind: 'SIMULATED_ONLY' };

  const rejection = depositRejection(request.amountMinor);
  if (rejection !== undefined) return { kind: 'AMOUNT_INVALID', reason: rejection };
  if (!isCardMethod(request.method)) return { kind: 'METHOD_INVALID' };

  const at = deps.now();
  const amount: Money = money(request.amountMinor);
  const posting = `posting_deposit_${request.clientRequestId}`;

  // A second press of the same button carries the same `clientRequestId`, so
  // it resolves to the same posting id. Report it as the success it already
  // is, with the *current* balance — rather than letting the ledger's own
  // primary key refuse it and surface to the operator as a system error. The
  // ledger remains the real guard; this only decides what the operator sees.
  if (deps.driver.postingExists(posting)) {
    return {
      kind: 'ALREADY_CREDITED',
      receipt: {
        depositId: posting,
        merchantId: context.merchantId,
        amountMinor: request.amountMinor,
        currency: 'ETB',
        method: isCardMethod(request.method) ? request.method : 'TAP',
        issuedAt: at,
        availableAfterMinor: deps.driver.balanceFor(context.merchantId).available.minor,
      },
    };
  }

  fundMerchant(deps.driver, {
    merchantId: context.merchantId,
    amount,
    at,
    correlationId: request.clientRequestId,
    postingId: toPostingId(posting),
  });

  deps.driver.saveAuditEvent({
    event: createAuditEvent({
      id: auditEventId(deps.newId('audit')),
      at,
      action: 'TRAINING_DEPOSIT_CREDITED',
      actor: {
        userId: context.userId,
        role: context.role,
        deviceId: context.deviceId,
      },
      merchantId: context.merchantId,
      // A safe code and the gesture pressed. There is no card, no PAN and no
      // processor reference for there to be one of.
      detail: `TRAINING_DEPOSIT_${request.method}`,
    }),
    correlationId: request.clientRequestId,
    entityType: 'merchant',
    entityId: context.merchantId,
    // `depositId` is the posting id, and it is what makes a deposit
    // **reprintable**: the audit row is the only durable record of a training
    // deposit, and without the id a later screen can list the deposit but
    // cannot rebuild the slip for it. The entity is the merchant, so the id
    // has nowhere else to live.
    metadata: {
      depositId: posting,
      amountMinor: request.amountMinor,
      method: request.method,
    },
  });

  const balance = deps.driver.balanceFor(context.merchantId);

  return {
    kind: 'CREDITED',
    receipt: {
      depositId: posting,
      merchantId: context.merchantId,
      amountMinor: request.amountMinor,
      currency: 'ETB',
      method: request.method,
      issuedAt: at,
      availableAfterMinor: balance.available.minor,
    },
  };
}
