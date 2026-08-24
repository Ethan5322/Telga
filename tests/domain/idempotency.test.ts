/**
 * Idempotency — the rule that prevents duplicate vending.
 * See `03 Domain/Idempotency.md`.
 *
 * The key identifies the request (merchant, device, client request id); the
 * fingerprint covers the payload (product, amount, recipient). That separation
 * is what makes a payload mismatch detectable at all.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveIdempotencyKey,
  DuplicateInProgressError,
  fromBirr,
  IdempotencyPayloadMismatchError,
  IdempotencyStore,
  payloadFingerprint,
  productId,
  transactionId,
} from '@telga/domain';
import type { SaleIntent } from '@telga/domain';
import { at, DEVICE_A, MERCHANT_A, MERCHANT_B, PRODUCT } from '../helpers';

const intent = (overrides: Partial<SaleIntent> = {}): SaleIntent => ({
  merchantId: MERCHANT_A,
  deviceId: DEVICE_A,
  productId: PRODUCT,
  amount: fromBirr(25),
  recipient: '0900000000',
  clientRequestId: 'req_0001',
  ...overrides,
});

describe('key derivation', () => {
  it('is deterministic for the same intent', () => {
    expect(deriveIdempotencyKey(intent())).toBe(deriveIdempotencyKey(intent()));
  });

  it('is stable when only the payload changes — this is what makes mismatch detectable', () => {
    expect(deriveIdempotencyKey(intent())).toBe(
      deriveIdempotencyKey(intent({ amount: fromBirr(500) })),
    );
  });

  it('differs when the merchant differs — no cross-merchant collision', () => {
    expect(deriveIdempotencyKey(intent())).not.toBe(
      deriveIdempotencyKey(intent({ merchantId: MERCHANT_B })),
    );
  });

  it('differs for a genuinely new client request', () => {
    expect(deriveIdempotencyKey(intent())).not.toBe(
      deriveIdempotencyKey(intent({ clientRequestId: 'req_0002' })),
    );
  });
});

describe('duplicate idempotency key', () => {
  it('a second register with the same payload replays rather than creating a sale', () => {
    const store = new IdempotencyStore();
    const first = store.register(intent(), transactionId('txn_0001'), at());
    const second = store.register(intent(), transactionId('txn_0002'), at());

    expect(first.kind).toBe('NEW');
    expect(second.kind).toBe('REPLAY');
    // The second attempt resolves to the FIRST transaction — not a new one.
    expect(second.record.transactionId).toBe('txn_0001');
    expect(store.size).toBe(1);
  });

  it('ten rapid retries still produce exactly one transaction', () => {
    const store = new IdempotencyStore();
    const outcomes = Array.from({ length: 10 }, (_, i) =>
      store.register(intent(), transactionId(`txn_000${String(i)}`), at()),
    );

    expect(outcomes.filter((o) => o.kind === 'NEW')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'REPLAY')).toHaveLength(9);
    expect(new Set(outcomes.map((o) => o.record.transactionId)).size).toBe(1);
    expect(store.size).toBe(1);
  });

  it('a double tap on confirm is refused while the sale is in flight', () => {
    const store = new IdempotencyStore();
    store.register(intent(), transactionId('txn_0001'), at());
    expect(() => {
      store.assertNotInProgress(intent());
    }).toThrow(DuplicateInProgressError);
  });

  it('reports the in-flight transaction id so the UI can show its state', () => {
    const store = new IdempotencyStore();
    store.register(intent(), transactionId('txn_0001'), at());
    try {
      store.assertNotInProgress(intent());
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateInProgressError);
      expect((error as DuplicateInProgressError).transactionId).toBe('txn_0001');
    }
  });
});

describe('same idempotency key with a different payload', () => {
  it('throws rather than silently overwriting, when the amount changed', () => {
    const store = new IdempotencyStore();
    const original = intent();
    store.register(original, transactionId('txn_0001'), at());

    const tampered = intent({ amount: fromBirr(500) });
    expect(deriveIdempotencyKey(tampered)).toBe(deriveIdempotencyKey(original));

    expect(() => store.register(tampered, transactionId('txn_0002'), at())).toThrow(
      IdempotencyPayloadMismatchError,
    );
  });

  it('throws when the recipient changed', () => {
    const store = new IdempotencyStore();
    store.register(intent(), transactionId('txn_0001'), at());
    expect(() =>
      store.register(intent({ recipient: '0911111111' }), transactionId('txn_0002'), at()),
    ).toThrow(IdempotencyPayloadMismatchError);
  });

  it('throws when the product changed', () => {
    const store = new IdempotencyStore();
    store.register(intent(), transactionId('txn_0001'), at());
    expect(() =>
      store.register(intent({ productId: productId('airtime_sim_100') }), transactionId('txn_0002'), at()),
    ).toThrow(IdempotencyPayloadMismatchError);
  });

  it('leaves the original record intact after a rejected mismatch', () => {
    const store = new IdempotencyStore();
    store.register(intent(), transactionId('txn_0001'), at());
    try {
      store.register(intent({ amount: fromBirr(500) }), transactionId('txn_0002'), at());
    } catch {
      // expected
    }
    expect(store.find(intent())?.transactionId).toBe('txn_0001');
    expect(store.size).toBe(1);
  });

  it('detects a payload change through the fingerprint', () => {
    expect(payloadFingerprint(intent())).not.toBe(
      payloadFingerprint(intent({ recipient: '0911111111' })),
    );
  });
});
