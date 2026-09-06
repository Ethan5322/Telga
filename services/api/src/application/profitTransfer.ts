/**
 * Moving earned profit into the selling balance.
 *
 * The shop owner has two figures on the dashboard: what they can sell with,
 * and what they have earned. This is the one action that moves value between
 * them — and it is a *move*, not an increase: the ledger posts a balanced
 * pair, so the total never changes.
 *
 * ## Why the bound is checked here and not in the ledger
 *
 * `transferProfitToBalance` posts what it is handed. The rule "you cannot
 * take out more than you have earned" needs to come back as a refusal an
 * operator can read, with the actual figure in it, and that is a service
 * concern. The check and the posting run inside one database transaction, so
 * two simultaneous transfers cannot both pass a check against the same
 * balance and then both post.
 *
 * ## Training only
 *
 * No money leaves Telga. This moves a simulated profit figure into a
 * simulated selling balance, in a build where `TRAINING — NO REAL VALUE` is
 * printed on every slip. It is not a payout, a withdrawal, or a settlement,
 * and it must not be described as one.
 */

import {
  auditEventId,
  createAuditEvent,
  money,
  postingId as toPostingId,
} from '@telga/domain';
import { transferProfitToBalance } from '@telga/persistence';
import type { AuthContext } from '../auth/context';
import type { AuthedApiDeps } from '../http/deps';

/** Bounds on a single transfer. Whole birr, like every other typed amount. */
export const PROFIT_TRANSFER_LIMITS = Object.freeze({
  minMinor: 100, // 1 birr
  incrementMinor: 100, // whole birr
});

export type ProfitTransferResult =
  | {
      readonly kind: 'TRANSFERRED';
      readonly amountMinor: number;
      readonly profitRemainingMinor: number;
      readonly availableAfterMinor: number;
    }
  | { readonly kind: 'AMOUNT_INVALID'; readonly reason: 'NOT_A_NUMBER' | 'BELOW_MINIMUM' | 'NOT_WHOLE_BIRR' }
  | {
      readonly kind: 'EXCEEDS_PROFIT';
      readonly requestedMinor: number;
      readonly profitAvailableMinor: number;
    }
  | { readonly kind: 'SIMULATED_ONLY' };

export interface ProfitTransferRequest {
  readonly amountMinor: number;
  readonly correlationId: string;
}

export function transferProfit(
  deps: AuthedApiDeps,
  context: AuthContext,
  request: ProfitTransferRequest,
): ProfitTransferResult {
  if (deps.mode !== 'TRAINING') return { kind: 'SIMULATED_ONLY' };

  const amountMinor = request.amountMinor;
  if (!Number.isSafeInteger(amountMinor)) {
    return { kind: 'AMOUNT_INVALID', reason: 'NOT_A_NUMBER' };
  }
  if (amountMinor < PROFIT_TRANSFER_LIMITS.minMinor) {
    return { kind: 'AMOUNT_INVALID', reason: 'BELOW_MINIMUM' };
  }
  if (amountMinor % PROFIT_TRANSFER_LIMITS.incrementMinor !== 0) {
    return { kind: 'AMOUNT_INVALID', reason: 'NOT_WHOLE_BIRR' };
  }

  const merchantId = context.merchantId;

  // Check and post together. Reading the profit, deciding, and then posting
  // as three separate steps would let two transfers both see the same
  // balance and both succeed — which is how a shop takes out more than it
  // earned.
  return deps.driver.transaction(() => {
    const profitAvailable = deps.driver.profitAvailableMinor(merchantId);
    if (amountMinor > profitAvailable) {
      return {
        kind: 'EXCEEDS_PROFIT',
        requestedMinor: amountMinor,
        profitAvailableMinor: profitAvailable,
      } as const;
    }

    const at = deps.now();
    transferProfitToBalance(deps.driver, {
      merchantId,
      amount: money(amountMinor),
      at,
      correlationId: request.correlationId,
      postingId: toPostingId(deps.newId('post')),
    });

    deps.driver.saveAuditEvent({
      event: createAuditEvent({
        id: auditEventId(deps.newId('audit')),
        at,
        action: 'PROFIT_TRANSFERRED_TO_BALANCE',
        actor: {
          userId: context.userId,
          role: context.role,
          deviceId: context.deviceId,
        },
        merchantId,
        detail: 'PROFIT_TO_SELLING_BALANCE',
      }),
      correlationId: request.correlationId,
      entityType: 'merchant',
      entityId: merchantId,
      // The amount and the figure it was checked against — never a PIN, a
      // token or a device key; `assertSafeMetadata` refuses those keys anyway.
      metadata: { amountMinor, profitBeforeMinor: profitAvailable },
    });

    return {
      kind: 'TRANSFERRED',
      amountMinor,
      profitRemainingMinor: deps.driver.profitAvailableMinor(merchantId),
      availableAfterMinor: deps.driver.balanceFor(merchantId).available.minor,
    } as const;
  });
}
