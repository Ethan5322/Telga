/**
 * Idempotency.
 *
 * The rule from `03 Domain/Idempotency.md`: an uncertain outcome is never
 * retried as a new transaction. The same logical request always produces the
 * same key, and a key already in flight returns the existing transaction rather
 * than starting another.
 *
 * The fingerprint is a plain FNV-1a over the canonical payload — the domain
 * takes no dependency on node:crypto, and the value is a collision check, not a
 * security control.
 */

import { DuplicateInProgressError, IdempotencyPayloadMismatchError } from './errors';
import type {
  DeviceId,
  IdempotencyKey,
  MerchantId,
  ProductId,
  Timestamp,
  TransactionId,
} from './ids';
import { idempotencyKeyOf } from './ids';
import type { Money } from './money';

/**
 * The logical request a merchant intends. The client generates
 * `clientRequestId` once, when the confirmation screen opens — not when the
 * button is pressed — so a second press carries the same key.
 */
export interface SaleIntent {
  readonly merchantId: MerchantId;
  readonly deviceId: DeviceId;
  readonly productId: ProductId;
  readonly amount: Money;
  readonly recipient: string;
  readonly clientRequestId: string;
}

export interface IdempotencyRecord {
  readonly key: IdempotencyKey;
  readonly merchantId: MerchantId;
  readonly deviceId: DeviceId;
  readonly payloadFingerprint: string;
  readonly transactionId: TransactionId;
  readonly createdAt: Timestamp;
}

/** FNV-1a, 32-bit, rendered as 8 hex characters. */
export function fingerprint(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Canonical string form of an intent. Field order is fixed, so the hash is stable. */
export function canonicalPayload(intent: SaleIntent): string {
  return [
    intent.merchantId,
    intent.deviceId,
    intent.productId,
    intent.amount.currency,
    String(intent.amount.minor),
    intent.recipient,
    intent.clientRequestId,
  ].join('|');
}

export const payloadFingerprint = (intent: SaleIntent): string => fingerprint(canonicalPayload(intent));

/**
 * The part of an intent that identifies the *request*, as opposed to its
 * contents: which merchant, on which device, under which client request.
 */
export function canonicalKeySource(intent: SaleIntent): string {
  return [intent.merchantId, intent.deviceId, intent.clientRequestId].join('|');
}

/**
 * Derive the idempotency key for an intent.
 *
 * Deliberately derived from the *request identity* only — merchant, device and
 * client request id — not from the payload. If the key hashed the amount and
 * recipient too, then changing them would change the key, and a payload
 * mismatch could never be detected: every tampered request would simply look
 * like a brand new sale. Keying on identity and fingerprinting the payload
 * separately is what lets `register` refuse the mismatch.
 */
export function deriveIdempotencyKey(intent: SaleIntent): IdempotencyKey {
  return idempotencyKeyOf(`idem_${fingerprint(canonicalKeySource(intent))}`);
}

export type IdempotencyOutcome =
  | { readonly kind: 'NEW'; readonly record: IdempotencyRecord }
  | { readonly kind: 'REPLAY'; readonly record: IdempotencyRecord };

/**
 * In-memory idempotency store.
 *
 * Pure and synchronous by design — persistence lives behind the repository
 * interface in the API layer, so the rule can be tested without a database.
 */
export class IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  /**
   * Register an intent against a transaction.
   *
   * - Key unseen: records it and reports `NEW`.
   * - Key seen with the same payload: reports `REPLAY` with the original record.
   * - Key seen with a different payload: throws. Never silently overwritten.
   */
  register(
    intent: SaleIntent,
    txId: TransactionId,
    at: Timestamp,
  ): IdempotencyOutcome {
    const key = deriveIdempotencyKey(intent);
    const print = payloadFingerprint(intent);
    const existing = this.records.get(key);

    if (existing) {
      if (existing.payloadFingerprint !== print) {
        throw new IdempotencyPayloadMismatchError(key);
      }
      return { kind: 'REPLAY', record: existing };
    }

    const record: IdempotencyRecord = Object.freeze({
      key,
      merchantId: intent.merchantId,
      deviceId: intent.deviceId,
      payloadFingerprint: print,
      transactionId: txId,
      createdAt: at,
    });
    this.records.set(key, record);
    return { kind: 'NEW', record };
  }

  /**
   * Assert that a fresh sale may start for this intent.
   *
   * Throws `DuplicateInProgressError` when one is already in flight, which is
   * what makes a double tap on the confirm button harmless.
   */
  assertNotInProgress(intent: SaleIntent): void {
    const key = deriveIdempotencyKey(intent);
    const existing = this.records.get(key);
    if (existing) {
      throw new DuplicateInProgressError(key, existing.transactionId);
    }
  }

  lookup(key: IdempotencyKey): IdempotencyRecord | undefined {
    return this.records.get(key);
  }

  find(intent: SaleIntent): IdempotencyRecord | undefined {
    return this.records.get(deriveIdempotencyKey(intent));
  }

  get size(): number {
    return this.records.size;
  }
}
