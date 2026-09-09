/**
 * Settling a transfer between two shops.
 *
 * `CLAUDE.md` §19.1. The rules live in `@telga/domain`'s `decideTransfer`; this
 * is the part that moves the money, and it does exactly one thing that matters:
 * **both sides in one database transaction**.
 *
 * > TRAINING ONLY. Real money is blocked by `money.live`, which is false and
 * > asserted at start-up — not by this module and not by the feature flag. What
 * > moves here is a training ledger, on the precedent of the Telga Pay card
 * > simulator (D87/D124) and training deposits (D70).
 *
 * ## Why one transaction, and not two calls
 *
 * A debit that commits without its credit is money **destroyed**: the sender is
 * poorer, the recipient is no richer, and the ledger no longer balances —
 * which §13 makes an invariant rather than a preference. Two separate writes
 * cannot be made safe by ordering them carefully; a process can die between
 * any two statements. So the pair is written inside `driver.transaction`, and
 * if any part throws, none of it happened.
 *
 * ## Why the recipient's credit is the full amount
 *
 * The fee is charged on top, to the sender. A transfer where the recipient
 * receives less than the number both shops agreed is a transfer that will be
 * disputed — the sender says 500, the recipient says 495, both are right, and
 * Telga ends up arbitrating its own fee.
 */

import { decideTransfer } from '@telga/domain';
import type { TransferPolicy } from '@telga/domain';
import type { SaleDeps } from './context';

export type TransferSettlement =
  | {
      readonly kind: 'SETTLED';
      readonly transferId: string;
      readonly amountMinor: number;
      readonly feeMinor: number;
      readonly recipientMerchantId: string;
    }
  | {
      readonly kind: 'NEEDS_APPROVAL';
      readonly transferId: string;
      readonly amountMinor: number;
      readonly feeMinor: number;
    }
  | { readonly kind: 'REFUSED'; readonly reason: string };

export interface TransferAttempt {
  readonly senderMerchantId: string;
  readonly senderDeviceId: string;
  readonly senderOperatorId: string;
  /** As typed at the counter. A device **id**, never a device key — §18.2. */
  readonly recipientDeviceId: string;
  readonly amountMinor: number;
}

/**
 * Everything this needs from outside, so it opens nothing itself.
 *
 * `availableMinor` is passed in rather than read here because the caller
 * already holds the balance port and because a transfer must judge against the
 * same figure the screen showed the operator — reading it again here would
 * introduce a window where the two disagree.
 */
export interface TransferPorts {
  readonly deps: SaleDeps;
  readonly policy: TransferPolicy;
  availableMinor(merchantId: string): number;
  /** Moves the pair. Called **inside** the transaction below. */
  postTransfer(input: {
    readonly postingId: string;
    readonly senderMerchantId: string;
    readonly recipientMerchantId: string;
    readonly amountMinor: number;
    readonly feeMinor: number;
    readonly correlationId: string;
    readonly at: string;
  }): void;
}

/** Midnight UTC of the day containing `at`, for the daily limit. */
export const dayStart = (at: string): string => `${at.slice(0, 10)}T00:00:00.000Z`;

export function settleShopTransfer(
  ports: TransferPorts,
  attempt: TransferAttempt,
): TransferSettlement {
  const { deps } = ports;
  const at = deps.now();
  const correlationId = deps.newId('corr');

  // Resolve the recipient from the device id the operator typed. A device that
  // does not exist and a device belonging to a closed shop are different
  // refusals, and `decideTransfer` tells them apart.
  const device = deps.driver.findDevice(attempt.recipientDeviceId as never);
  const recipientMerchant =
    device === undefined
      ? undefined
      : deps.driver.findMerchant(device.merchant_id as never);

  const sender = deps.driver.findMerchant(attempt.senderMerchantId as never);
  if (sender === undefined) return { kind: 'REFUSED', reason: 'SENDER_NOT_ACTIVE' };

  const decision = decideTransfer(
    {
      senderMerchantId: attempt.senderMerchantId,
      senderStatus: sender.status,
      senderAvailableMinor: ports.availableMinor(attempt.senderMerchantId),
      sentTodayMinor: deps.driver.sentTodayMinor(attempt.senderMerchantId, dayStart(at)),
      recipient:
        recipientMerchant === undefined
          ? undefined
          : { merchantId: recipientMerchant.id, status: recipientMerchant.status },
      amountMinor: attempt.amountMinor,
    },
    ports.policy,
  );

  const transferId = deps.newId('xfer');

  if (decision.outcome === 'REFUSED') {
    // Recorded even when refused. A shop repeatedly trying to send more than it
    // has, or to a shop that is suspended, is a pattern worth being able to see
    // — and a refusal that leaves no trace cannot be investigated later.
    deps.driver.saveShopTransfer({
      id: transferId,
      senderMerchantId: attempt.senderMerchantId,
      senderDeviceId: attempt.senderDeviceId,
      senderOperatorId: attempt.senderOperatorId,
      recipientDeviceId: attempt.recipientDeviceId,
      // A refused transfer with no resolvable recipient still needs a row, and
      // the schema requires one. The sender is used, and the status says
      // REFUSED so nothing reads it as a real counterparty.
      recipientMerchantId: recipientMerchant?.id ?? attempt.senderMerchantId,
      amountMinor: attempt.amountMinor > 0 ? attempt.amountMinor : 1,
      feeMinor: 0,
      status: 'REFUSED',
      refusalReason: decision.refusal,
      correlationId,
      at,
    });
    return { kind: 'REFUSED', reason: decision.refusal ?? 'REFUSED' };
  }

  const recipientId = (recipientMerchant as { id: string }).id;

  if (decision.outcome === 'ACCEPTED_NEEDS_APPROVAL') {
    // Queued, not settled. No ledger entry exists yet, so nothing has moved and
    // the sender's balance is untouched — which is what "awaiting approval"
    // has to mean if the word is to be worth anything.
    deps.driver.saveShopTransfer({
      id: transferId,
      senderMerchantId: attempt.senderMerchantId,
      senderDeviceId: attempt.senderDeviceId,
      senderOperatorId: attempt.senderOperatorId,
      recipientDeviceId: attempt.recipientDeviceId,
      recipientMerchantId: recipientId,
      amountMinor: decision.creditMinor,
      feeMinor: decision.feeMinor,
      status: 'NEEDS_APPROVAL',
      correlationId,
      at,
    });
    return {
      kind: 'NEEDS_APPROVAL',
      transferId,
      amountMinor: decision.creditMinor,
      feeMinor: decision.feeMinor,
    };
  }

  const postingId = deps.newId('post');

  // **One transaction.** The row and both ledger sides commit together or not
  // at all. A debit that commits without its credit is money destroyed.
  deps.driver.transaction((): void => {
    ports.postTransfer({
      postingId,
      senderMerchantId: attempt.senderMerchantId,
      recipientMerchantId: recipientId,
      amountMinor: decision.creditMinor,
      feeMinor: decision.feeMinor,
      correlationId,
      at,
    });
    deps.driver.saveShopTransfer({
      id: transferId,
      senderMerchantId: attempt.senderMerchantId,
      senderDeviceId: attempt.senderDeviceId,
      senderOperatorId: attempt.senderOperatorId,
      recipientDeviceId: attempt.recipientDeviceId,
      recipientMerchantId: recipientId,
      amountMinor: decision.creditMinor,
      feeMinor: decision.feeMinor,
      status: 'SETTLED',
      postingId,
      correlationId,
      at,
    });
  });

  return {
    kind: 'SETTLED',
    transferId,
    amountMinor: decision.creditMinor,
    feeMinor: decision.feeMinor,
    recipientMerchantId: recipientId,
  };
}
