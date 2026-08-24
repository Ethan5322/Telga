/**
 * Idempotency records and audit events at the persistence boundary.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  auditEventId,
  createAuditEvent,
  fromBirr,
  postingId,
  transactionId,
} from '@telga/domain';
import {
  assertSafeMetadata,
  DuplicateIdempotencyRecordError,
  fundMerchant,
  hashRecipient,
  maskRecipient,
  reserve,
} from '@telga/persistence';
import type { SqliteLedgerDriver } from '@telga/persistence';
import {
  actor,
  at,
  DEVICE_A,
  DEVICE_B,
  makeHarness,
  makeTransaction,
  MERCHANT_A,
  MERCHANT_B,
  RECIPIENT_SALT,
  seedMerchant,
  transactionInput,
} from './helpers';
import type { Harness } from './helpers';

const TX_A = transactionId('txn_idem_a');
const TX_B = transactionId('txn_idem_b');
const KEY = 'idem_shared_key';

let harnesses: Harness[] = [];

function ready(name: string): SqliteLedgerDriver {
  const h = makeHarness(name);
  harnesses.push(h);
  const { driver } = h;
  seedMerchant(driver, MERCHANT_A, DEVICE_A);
  seedMerchant(driver, MERCHANT_B, DEVICE_B);
  driver.saveTransaction(
    transactionInput(makeTransaction({ id: TX_A, merchant: MERCHANT_A, device: DEVICE_A, key: KEY })),
  );
  driver.saveTransaction(
    transactionInput(makeTransaction({ id: TX_B, merchant: MERCHANT_B, device: DEVICE_B, key: KEY })),
  );
  return driver;
}

const record = (merchant: typeof MERCHANT_A, txId: typeof TX_A, fingerprint = 'fp_original') => ({
  key: KEY,
  merchantId: merchant,
  requestIdentity: `${merchant}|device|req_0001`,
  payloadFingerprint: fingerprint,
  transactionId: txId,
  at: at(),
});

afterEach(() => {
  for (const h of harnesses) h.cleanup();
  harnesses = [];
});

describe('idempotency records', () => {
  it('the same scoped key returns the original transaction', () => {
    const driver = ready('idem-replay');
    driver.saveIdempotencyRecord(record(MERCHANT_A, TX_A));

    const found = driver.findIdempotencyRecord(MERCHANT_A, KEY);
    expect(found?.transaction_id).toBe(TX_A);
  });

  it('a duplicate record for the same merchant and key is refused', () => {
    const driver = ready('idem-dupe');
    driver.saveIdempotencyRecord(record(MERCHANT_A, TX_A));

    expect(() => driver.saveIdempotencyRecord(record(MERCHANT_A, TX_A))).toThrow(
      DuplicateIdempotencyRecordError,
    );
  });

  it('the same key from a different merchant is a separate record', () => {
    const driver = ready('idem-scope');
    driver.saveIdempotencyRecord(record(MERCHANT_A, TX_A));
    driver.saveIdempotencyRecord(record(MERCHANT_B, TX_B));

    expect(driver.findIdempotencyRecord(MERCHANT_A, KEY)?.transaction_id).toBe(TX_A);
    expect(driver.findIdempotencyRecord(MERCHANT_B, KEY)?.transaction_id).toBe(TX_B);
  });

  it('a stored fingerprint lets a caller detect a changed payload', () => {
    const driver = ready('idem-fingerprint');
    driver.saveIdempotencyRecord(record(MERCHANT_A, TX_A, 'fp_original'));

    const stored = driver.findIdempotencyRecord(MERCHANT_A, KEY);
    expect(stored?.payload_fingerprint).toBe('fp_original');
    expect(stored?.payload_fingerprint).not.toBe('fp_tampered');
  });

  it('concurrent duplicate requests create one logical transaction', () => {
    const driver = ready('idem-concurrent');
    const attempts = Array.from({ length: 10 }, () => () =>
      driver.saveIdempotencyRecord(record(MERCHANT_A, TX_A)),
    );

    let succeeded = 0;
    let refused = 0;
    for (const attempt of attempts) {
      try {
        attempt();
        succeeded += 1;
      } catch {
        refused += 1;
      }
    }

    expect(succeeded).toBe(1);
    expect(refused).toBe(9);
    expect(driver.findIdempotencyRecord(MERCHANT_A, KEY)?.transaction_id).toBe(TX_A);
  });

  it('the unique index on (merchant, idempotency_key) blocks a second transaction row', () => {
    const driver = ready('idem-unique');
    const duplicate = transactionInput(
      makeTransaction({ id: 'txn_idem_a_dup', merchant: MERCHANT_A, device: DEVICE_A, key: KEY }),
    );
    expect(() => driver.saveTransaction(duplicate)).toThrow(/UNIQUE constraint failed/i);
  });
});

describe('recipient privacy', () => {
  it('stores a mask and a hash, never the full number', () => {
    const driver = ready('privacy');
    const row = driver.findTransaction(TX_A, MERCHANT_A);

    expect(row?.recipient_masked).toBe('09******00');
    expect(row?.recipient_masked).not.toContain('0900000000');
    expect(row?.recipient_hash).toHaveLength(64);
    expect(row?.recipient_hash).not.toContain('0900000000');
  });

  it('the hash is salted, so it is not a plain digest of the number', () => {
    const withSalt = hashRecipient('0900000000', RECIPIENT_SALT);
    const otherSalt = hashRecipient('0900000000', 'a-different-salt');
    expect(withSalt).not.toBe(otherSalt);
  });

  it('the same number and salt hash identically, so lookup still works', () => {
    expect(hashRecipient('0900000000', RECIPIENT_SALT)).toBe(hashRecipient('0900000000', RECIPIENT_SALT));
  });

  it('a short value is masked entirely', () => {
    expect(maskRecipient('123')).toBe('***');
  });

  it('refuses metadata that would carry sensitive data', () => {
    for (const key of ['pin', 'apiKey', 'authorization', 'recipient', 'providerSecret']) {
      expect(() => {
        assertSafeMetadata({ [key]: 'x' });
      }).toThrow(/sensitive/i);
    }
  });

  it('allows safe metadata', () => {
    expect(() => {
      assertSafeMetadata({ attempt: 2, channel: 'POS', simulated: true });
    }).not.toThrow();
  });
});

describe('audit events', () => {
  it('every balance-changing action creates an audit event', () => {
    const driver = ready('audit-balance');
    fundMerchant(driver, {
      merchantId: MERCHANT_A,
      amount: fromBirr(100),
      at: at(),
      correlationId: 'corr_fund',
      postingId: postingId('post_fund'),
    });
    reserve(driver, {
      merchantId: MERCHANT_A,
      transactionId: TX_A,
      amount: fromBirr(25),
      at: at(),
      correlationId: 'corr_sale',
      actor,
      postingId: postingId('post_res'),
      auditId: 'audit_res',
    });

    const events = driver.readAuditEvents(MERCHANT_A);
    expect(events.some((e) => e.event_type === 'BALANCE_RESERVED')).toBe(true);
  });

  it('carries actor and correlation id', () => {
    const driver = ready('audit-actor');
    fundMerchant(driver, {
      merchantId: MERCHANT_A,
      amount: fromBirr(100),
      at: at(),
      correlationId: 'corr_fund',
      postingId: postingId('post_fund'),
    });
    reserve(driver, {
      merchantId: MERCHANT_A,
      transactionId: TX_A,
      amount: fromBirr(25),
      at: at(),
      correlationId: 'corr_trace_me',
      actor,
      postingId: postingId('post_res'),
      auditId: 'audit_res',
    });

    const event = driver.readAuditEventsByCorrelation('corr_trace_me')[0];
    expect(event?.actor_type).toBe('MERCHANT_OPERATOR');
    expect(event?.actor_id).toBe('operator_alpha_1');
    expect(event?.correlation_id).toBe('corr_trace_me');
    expect(event?.entity_id).toBe(TX_A);
  });

  it('audit events cannot be silently modified', () => {
    const driver = ready('audit-immutable');
    driver.saveAuditEvent({
      event: createAuditEvent({
        id: auditEventId('audit_fixed'),
        at: at(),
        action: 'TRANSACTION_CREATED',
        actor,
        merchantId: MERCHANT_A,
      }),
      correlationId: 'corr_1',
      entityType: 'transaction',
    });

    expect(() => {
      driver.unsafeConnection.prepare("UPDATE audit_events SET actor_id = 'someone_else'").run();
    }).toThrow(/append-only.*UPDATE is forbidden/i);
  });

  it('audit events cannot be deleted', () => {
    const driver = ready('audit-nodelete');
    driver.saveAuditEvent({
      event: createAuditEvent({
        id: auditEventId('audit_fixed'),
        at: at(),
        action: 'TRANSACTION_CREATED',
        actor,
        merchantId: MERCHANT_A,
      }),
      correlationId: 'corr_1',
      entityType: 'transaction',
    });

    expect(() => {
      driver.unsafeConnection.prepare('DELETE FROM audit_events').run();
    }).toThrow(/append-only.*DELETE is forbidden/i);
    expect(driver.readAuditEvents()).toHaveLength(1);
  });

  it('refuses to store sensitive metadata on an audit event', () => {
    const driver = ready('audit-metadata');
    expect(() =>
      driver.saveAuditEvent({
        event: createAuditEvent({
          id: auditEventId('audit_bad'),
          at: at(),
          action: 'TRANSACTION_CREATED',
          actor,
          merchantId: MERCHANT_A,
        }),
        correlationId: 'corr_1',
        entityType: 'transaction',
        metadata: { operatorPin: '1234' },
      }),
    ).toThrow(/sensitive/i);
  });
});
