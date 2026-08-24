/**
 * Transaction and idempotency rows.
 */

import { isTransactionState } from '@telga/domain';
import type { MerchantId, TransactionId } from '@telga/domain';
import type { Db } from '../sqlite/connection';
import type { IdempotencyInput, TransactionInput } from '../driver/types';
import type { IdempotencyRow, TransactionRow } from '../schema/types';
import { DuplicateIdempotencyRecordError } from '../driver/errors';

export function saveTransaction(db: Db, input: TransactionInput): TransactionRow {
  const t = input.transaction;

  if (!isTransactionState(t.state)) {
    throw new Error(`Refusing to persist unknown transaction state "${t.state}"`);
  }

  db.prepare(
    `INSERT INTO transactions (
       id, merchant_id, device_id, operator_id, product_type, provider_id,
       amount_minor, currency, recipient_masked, recipient_hash, state,
       idempotency_key, payload_fingerprint, provider_reference, mode, created_at, updated_at)
     VALUES (
       @id, @merchantId, @deviceId, @operatorId, @productType, @providerId,
       @amountMinor, @currency, @recipientMasked, @recipientHash, @state,
       @idempotencyKey, @payloadFingerprint, @providerReference, @mode, @createdAt, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       state = @state,
       provider_reference = @providerReference,
       updated_at = @updatedAt`,
  ).run({
    id: t.id,
    merchantId: t.merchantId,
    deviceId: t.deviceId,
    operatorId: t.operatorId,
    productType: input.productType,
    providerId: t.providerId ?? null,
    amountMinor: t.amount.minor,
    currency: t.amount.currency,
    recipientMasked: input.recipientMasked,
    recipientHash: input.recipientHash,
    state: t.state,
    idempotencyKey: t.idempotencyKey,
    payloadFingerprint: input.payloadFingerprint,
    providerReference: t.providerReference ?? null,
    mode: t.mode,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  });

  const row = findTransaction(db, t.id);
  if (!row) throw new Error(`Transaction ${t.id} was not persisted`);
  return row;
}

/** Merchant scoping is applied in SQL when a merchant is supplied. */
export function findTransaction(
  db: Db,
  id: TransactionId,
  merchantId?: MerchantId,
): TransactionRow | undefined {
  if (merchantId === undefined) {
    return db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as TransactionRow | undefined;
  }
  return db
    .prepare('SELECT * FROM transactions WHERE id = ? AND merchant_id = ?')
    .get(id, merchantId) as TransactionRow | undefined;
}

export function findTransactionsByMerchant(db: Db, merchantId: MerchantId): readonly TransactionRow[] {
  return db
    .prepare('SELECT * FROM transactions WHERE merchant_id = ? ORDER BY created_at, id')
    .all(merchantId) as TransactionRow[];
}

/**
 * Store an idempotency record.
 *
 * The primary key is `(merchant_id, key)`, so the same client request id from
 * two different merchants is two records — merchants cannot collide with each
 * other, deliberately or otherwise.
 */
export function saveIdempotencyRecord(db: Db, input: IdempotencyInput): IdempotencyRow {
  const existing = findIdempotencyRecord(db, input.merchantId, input.key);
  if (existing) {
    throw new DuplicateIdempotencyRecordError(input.key);
  }

  db.prepare(
    `INSERT INTO idempotency_records
       (key, merchant_id, request_identity, payload_fingerprint, transaction_id, result_state, created_at, updated_at)
     VALUES (@key, @merchantId, @requestIdentity, @payloadFingerprint, @transactionId, NULL, @at, @at)`,
  ).run({
    key: input.key,
    merchantId: input.merchantId,
    requestIdentity: input.requestIdentity,
    payloadFingerprint: input.payloadFingerprint,
    transactionId: input.transactionId,
    at: input.at,
  });

  const row = findIdempotencyRecord(db, input.merchantId, input.key);
  if (!row) throw new Error(`Idempotency record ${input.key} was not persisted`);
  return row;
}

export function findIdempotencyRecord(
  db: Db,
  merchantId: MerchantId,
  key: string,
): IdempotencyRow | undefined {
  return db
    .prepare('SELECT * FROM idempotency_records WHERE merchant_id = ? AND key = ?')
    .get(merchantId, key) as IdempotencyRow | undefined;
}

/** Record the settled outcome against an idempotency record, for replay. */
export function recordIdempotencyResult(
  db: Db,
  merchantId: MerchantId,
  key: string,
  state: string,
  at: string,
): void {
  db.prepare(
    'UPDATE idempotency_records SET result_state = ?, updated_at = ? WHERE merchant_id = ? AND key = ?',
  ).run(state, at, merchantId, key);
}
