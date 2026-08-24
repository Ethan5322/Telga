/**
 * Reprints and audit events.
 *
 * Ledger invariant 5: a reprint never creates a sale.
 * `09 Engineering/Security Model.md`: every mutation emits an audit event.
 */

import { describe, expect, it } from 'vitest';
import {
  AppendOnlyLedger,
  AuditLog,
  auditEventId,
  createAuditEvent,
  createReceipt,
  fromBirr,
  LedgerImmutableError,
  receiptAvailable,
  receiptId,
  recordReprint,
  transactionId,
  transitionTo,
  transitionWithAudit,
  TRAINING_BANNER,
} from '@telga/domain';
import {
  ACC_MERCHANT_A,
  actor,
  at,
  DEVICE_A,
  fundingEntries,
  makeTransaction,
  MERCHANT_A,
  MERCHANT_B,
  OPERATOR_A,
  posting,
  saleEntries,
} from '../helpers';

const TX = transactionId('txn_receipt_1');

function completedSale() {
  const ledger = new AppendOnlyLedger();
  ledger.post(posting('fund'), fundingEntries(MERCHANT_A, ACC_MERCHANT_A, fromBirr(100)), at(), 'TRAINING');
  ledger.post(posting('sale'), saleEntries(MERCHANT_A, ACC_MERCHANT_A, TX, fromBirr(25)), at(), 'TRAINING');

  let txn = makeTransaction({ id: TX });
  for (const next of ['VALIDATED', 'RESERVED', 'PROCESSING', 'SUCCESSFUL'] as const) {
    txn = transitionTo(txn, next, { at: at() });
  }
  return { ledger, txn };
}

describe('a reprint never creates a sale', () => {
  it('adds no ledger entry', () => {
    const { ledger } = completedSale();
    const before = ledger.size;

    recordReprint({
      id: auditEventId('audit_reprint_1'),
      transactionId: TX,
      merchantId: MERCHANT_A,
      operatorId: OPERATOR_A,
      deviceId: DEVICE_A,
      at: at(),
      sequence: 1,
    });

    expect(ledger.size).toBe(before);
  });

  it('does not change the transaction state', () => {
    const { txn } = completedSale();
    const stateBefore = txn.state;
    const historyBefore = txn.history.length;

    recordReprint({
      id: auditEventId('audit_reprint_2'),
      transactionId: TX,
      merchantId: MERCHANT_A,
      operatorId: OPERATOR_A,
      deviceId: DEVICE_A,
      at: at(),
      sequence: 1,
    });

    expect(txn.state).toBe(stateBefore);
    expect(txn.history).toHaveLength(historyBefore);
  });

  it('ten reprints still leave exactly one sale on the ledger', () => {
    const { ledger } = completedSale();
    const saleDebits = ledger.forTransaction(TX).filter((e) => e.direction === 'DEBIT');

    for (let i = 0; i < 10; i += 1) {
      recordReprint({
        id: auditEventId(`audit_reprint_${String(i)}`),
        transactionId: TX,
        merchantId: MERCHANT_A,
        operatorId: OPERATOR_A,
        deviceId: DEVICE_A,
        at: at(),
        sequence: i + 1,
      });
    }

    expect(saleDebits).toHaveLength(1);
    expect(ledger.forTransaction(TX)).toHaveLength(2);
  });

  it('marks the reprinted receipt as a reprint on the paper', () => {
    const original = createReceipt({
      id: receiptId('rcpt_1'),
      transactionId: TX,
      merchantId: MERCHANT_A,
      merchantName: 'Simulated Shop',
      productLabel: 'Airtime 25 (simulated)',
      amount: fromBirr(25),
      recipient: '0900000000',
      state: 'SUCCESSFUL',
      issuedAt: at(),
      supportContact: 'support@example.invalid',
      trainingBanner: TRAINING_BANNER,
    });
    const reprinted = createReceipt({ ...original, id: receiptId('rcpt_1r'), isReprint: true });

    expect(original.isReprint).toBe(false);
    expect(reprinted.isReprint).toBe(true);
    expect(reprinted.trainingBanner).toBe('TRAINING MODE — NO REAL VALUE');
  });

  it('a pending transaction can still print an honest receipt', () => {
    expect(receiptAvailable('PENDING')).toBe(true);
    expect(receiptAvailable('UNDER_REVIEW')).toBe(true);
    expect(receiptAvailable('FAILED')).toBe(true);
    // Nothing to print before the sale is even submitted.
    expect(receiptAvailable('CREATED')).toBe(false);
    expect(receiptAvailable('PROCESSING')).toBe(false);
  });
});

describe('audit events', () => {
  it('a transition produces an audit event recording before and after', () => {
    const txn = makeTransaction();
    const { transaction, audit } = transitionWithAudit(txn, 'VALIDATED', {
      at: at(),
      auditId: auditEventId('audit_1'),
      actor,
      reason: 'server validation passed',
    });

    expect(transaction.state).toBe('VALIDATED');
    expect(audit.action).toBe('TRANSACTION_TRANSITIONED');
    expect(audit.before).toBe('CREATED');
    expect(audit.after).toBe('VALIDATED');
    expect(audit.merchantId).toBe(MERCHANT_A);
    expect(audit.transactionId).toBe(txn.id);
    expect(audit.actor.deviceId).toBe(DEVICE_A);
  });

  it('records an audit event for every hop of a full lifecycle', () => {
    const log = new AuditLog();
    let txn = makeTransaction();
    const path = ['VALIDATED', 'RESERVED', 'PROCESSING', 'PENDING', 'UNDER_REVIEW', 'SUCCESSFUL'] as const;

    path.forEach((next, index) => {
      const result = transitionWithAudit(txn, next, {
        at: at(),
        auditId: auditEventId(`audit_${String(index)}`),
        actor,
      });
      txn = result.transaction;
      log.append(result.audit);
    });

    expect(log.size).toBe(path.length);
    expect(log.forTransaction(txn.id)).toHaveLength(path.length);
    expect(log.all().map((e) => e.after)).toEqual([...path]);
  });

  it('the audit log is append-only', () => {
    const log = new AuditLog();
    const event = createAuditEvent({
      id: auditEventId('audit_dupe'),
      at: at(),
      action: 'RECEIPT_REPRINTED',
      actor,
      merchantId: MERCHANT_A,
    });
    log.append(event);
    expect(() => log.append(event)).toThrow(LedgerImmutableError);
    expect(log.size).toBe(1);
  });

  it('audit events are isolated by merchant', () => {
    const log = new AuditLog();
    log.append(
      createAuditEvent({
        id: auditEventId('a1'),
        at: at(),
        action: 'TRANSACTION_CREATED',
        actor,
        merchantId: MERCHANT_A,
      }),
    );
    log.append(
      createAuditEvent({
        id: auditEventId('b1'),
        at: at(),
        action: 'TRANSACTION_CREATED',
        actor,
        merchantId: MERCHANT_B,
      }),
    );

    expect(log.forMerchant(MERCHANT_A)).toHaveLength(1);
    expect(log.forMerchant(MERCHANT_A)[0]?.id).toBe('a1');
  });
});
