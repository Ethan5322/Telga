/**
 * Rebuild a domain `Transaction` from its stored row.
 *
 * Two things are deliberately not restored:
 *
 *  - **The full recipient.** Only the mask survives in storage, so the mask is
 *    what a rehydrated transaction carries. After the first write, the full
 *    number never exists in memory again.
 *  - **The in-memory transition history.** The durable history is the audit log
 *    (`audit_events`), which is append-only and merchant-scoped. `history` on a
 *    rehydrated transaction starts empty and records only the moves made in the
 *    current process.
 */

import {
  deviceId,
  idempotencyKeyOf,
  merchantId,
  merchantUserId,
  money,
  productId,
  providerId,
  timestamp,
  transactionId,
} from '@telga/domain';
import type { Transaction } from '@telga/domain';
import type { SqliteLedgerDriver, TransactionRow } from '@telga/persistence';

export function rehydrate(row: TransactionRow): Transaction {
  return Object.freeze({
    id: transactionId(row.id),
    merchantId: merchantId(row.merchant_id),
    deviceId: deviceId(row.device_id),
    operatorId: merchantUserId(row.operator_id ?? 'system'),
    productId: productId(row.product_type),
    providerId: row.provider_id === null ? undefined : providerId(row.provider_id),
    amount: money(row.amount_minor),
    recipient: row.recipient_masked,
    idempotencyKey: idempotencyKeyOf(row.idempotency_key),
    providerReference: row.provider_reference ?? undefined,
    state: row.state,
    mode: row.mode,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    history: Object.freeze([]),
  });
}

/** Persist a rehydrated transaction, carrying its stored privacy fields forward. */
export function persistRehydrated(
  driver: SqliteLedgerDriver,
  transaction: Transaction,
  row: TransactionRow,
): void {
  driver.saveTransaction({
    transaction,
    recipientMasked: row.recipient_masked,
    recipientHash: row.recipient_hash,
    payloadFingerprint: row.payload_fingerprint,
    productType: row.product_type,
  });
}
