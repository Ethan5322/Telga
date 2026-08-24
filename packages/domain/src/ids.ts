/**
 * Branded identifier types.
 *
 * A `MerchantId` and a `DeviceId` are both strings at runtime, but the compiler
 * refuses to swap one for the other. Merchant isolation starts here.
 */

declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type MerchantId = Brand<string, 'MerchantId'>;
export type MerchantUserId = Brand<string, 'MerchantUserId'>;
export type DeviceId = Brand<string, 'DeviceId'>;
export type ProductId = Brand<string, 'ProductId'>;
export type ProviderId = Brand<string, 'ProviderId'>;
export type TransactionId = Brand<string, 'TransactionId'>;
export type AttemptId = Brand<string, 'AttemptId'>;
export type LedgerAccountId = Brand<string, 'LedgerAccountId'>;
export type LedgerEntryId = Brand<string, 'LedgerEntryId'>;
export type PostingId = Brand<string, 'PostingId'>;
export type ReservationId = Brand<string, 'ReservationId'>;
export type ReceiptId = Brand<string, 'ReceiptId'>;
export type AuditEventId = Brand<string, 'AuditEventId'>;
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>;
export type SessionId = Brand<string, 'SessionId'>;

export const merchantId = (value: string): MerchantId => value as MerchantId;
export const sessionId = (value: string): SessionId => value as SessionId;
export const merchantUserId = (value: string): MerchantUserId => value as MerchantUserId;
export const deviceId = (value: string): DeviceId => value as DeviceId;
export const productId = (value: string): ProductId => value as ProductId;
export const providerId = (value: string): ProviderId => value as ProviderId;
export const transactionId = (value: string): TransactionId => value as TransactionId;
export const attemptId = (value: string): AttemptId => value as AttemptId;
export const ledgerAccountId = (value: string): LedgerAccountId => value as LedgerAccountId;
export const ledgerEntryId = (value: string): LedgerEntryId => value as LedgerEntryId;
export const postingId = (value: string): PostingId => value as PostingId;
export const reservationId = (value: string): ReservationId => value as ReservationId;
export const receiptId = (value: string): ReceiptId => value as ReceiptId;
export const auditEventId = (value: string): AuditEventId => value as AuditEventId;
export const idempotencyKeyOf = (value: string): IdempotencyKey => value as IdempotencyKey;

/** An ISO-8601 timestamp. The domain never reads a clock itself — callers pass time in. */
export type Timestamp = Brand<string, 'Timestamp'>;
export const timestamp = (value: string | Date): Timestamp =>
  (value instanceof Date ? value.toISOString() : value) as Timestamp;
