/**
 * Receipts and reprints.
 *
 * Ledger invariant 5: a reprint never creates a sale. `recordReprint` returns a
 * `ReprintEvent` and nothing else — it takes no ledger, changes no state, and
 * has no way to produce an entry. The guarantee is structural, not a promise.
 *
 * Printer failure is likewise never a transaction failure: if the sale
 * succeeded and the paper jammed, the sale stands and the receipt is
 * reprintable. See `04 UX UI/Receipt Specification.md`.
 */

import type {
  AuditEventId,
  DeviceId,
  MerchantId,
  MerchantUserId,
  ReceiptId,
  Timestamp,
  TransactionId,
} from './ids';
import type { Money } from './money';
import type { TransactionState } from './states';

export interface Receipt {
  readonly id: ReceiptId;
  readonly transactionId: TransactionId;
  readonly merchantId: MerchantId;
  readonly merchantName: string;
  readonly productLabel: string;
  readonly amount: Money;
  readonly recipient: string;
  readonly providerReference?: string;
  readonly state: TransactionState;
  readonly issuedAt: Timestamp;
  readonly supportContact: string;
  /** True only on a reprint. Printed on the paper. */
  readonly isReprint: boolean;
  /** Present while training mode is on. */
  readonly trainingBanner?: string;
}

export interface ReprintEvent {
  readonly id: AuditEventId;
  readonly transactionId: TransactionId;
  readonly merchantId: MerchantId;
  readonly operatorId: MerchantUserId;
  readonly deviceId: DeviceId;
  readonly at: Timestamp;
  /** Which reprint this is: 1 for the first reprint after the original. */
  readonly sequence: number;
}

/** Which states may produce a receipt, and what it says. */
export function receiptAvailable(state: TransactionState): boolean {
  return (
    state === 'SUCCESSFUL' ||
    state === 'FAILED' ||
    state === 'PENDING' ||
    state === 'UNDER_REVIEW' ||
    state === 'REVERSED' ||
    state === 'REJECTED'
  );
}

export function createReceipt(input: {
  id: ReceiptId;
  transactionId: TransactionId;
  merchantId: MerchantId;
  merchantName: string;
  productLabel: string;
  amount: Money;
  recipient: string;
  providerReference?: string;
  state: TransactionState;
  issuedAt: Timestamp;
  supportContact: string;
  isReprint?: boolean;
  trainingBanner?: string;
}): Receipt {
  return Object.freeze({ isReprint: false, ...input });
}

/**
 * Record a reprint.
 *
 * Returns only an event. There is no ledger parameter and no transaction
 * returned, so no caller can use this to move value or change state.
 */
export function recordReprint(input: {
  id: AuditEventId;
  transactionId: TransactionId;
  merchantId: MerchantId;
  operatorId: MerchantUserId;
  deviceId: DeviceId;
  at: Timestamp;
  sequence: number;
}): ReprintEvent {
  return Object.freeze({ ...input });
}
