/**
 * Shared test fixtures.
 *
 * All values here are simulated. No real merchant, no real recipient number,
 * no real provider. The no-real-data rule is recorded outside this repository.
 */

import {
  createTransaction,
  deviceId,
  fromBirr,
  idempotencyKeyOf,
  ledgerAccountId,
  merchantId,
  merchantUserId,
  postingId,
  productId,
  providerId,
  reservationId,
  timestamp,
  transactionId,
} from '@telga/domain';
import type {
  AuditActor,
  DraftEntry,
  LedgerAccountId,
  MerchantId,
  Money,
  Timestamp,
  Transaction,
  TransactionId,
} from '@telga/domain';

export const MERCHANT_A: MerchantId = merchantId('merchant_alpha');
export const MERCHANT_B: MerchantId = merchantId('merchant_beta');

export const DEVICE_A = deviceId('device_alpha_1');
export const OPERATOR_A = merchantUserId('operator_alpha_1');
export const PRODUCT = productId('airtime_sim_25');
export const PROVIDER = providerId('provider_simulated');

export const ACC_MERCHANT_A: LedgerAccountId = ledgerAccountId('acct_merchant_alpha_funds');
export const ACC_MERCHANT_B: LedgerAccountId = ledgerAccountId('acct_merchant_beta_funds');
export const ACC_PROVIDER: LedgerAccountId = ledgerAccountId('acct_provider_settlement');
export const ACC_CLEARING: LedgerAccountId = ledgerAccountId('acct_bank_clearing');

export const at = (iso = '2026-08-20T09:00:00.000Z'): Timestamp => timestamp(iso);

export const actor: AuditActor = {
  userId: OPERATOR_A,
  role: 'MERCHANT_OPERATOR',
  deviceId: DEVICE_A,
};

export const systemActor: AuditActor = { userId: 'system', role: 'SYSTEM' };

export function makeTransaction(overrides: Partial<{
  id: TransactionId;
  merchant: MerchantId;
  amount: Money;
  key: string;
}> = {}): Transaction {
  return createTransaction({
    id: overrides.id ?? transactionId('txn_sim_0001'),
    merchantId: overrides.merchant ?? MERCHANT_A,
    deviceId: DEVICE_A,
    operatorId: OPERATOR_A,
    productId: PRODUCT,
    providerId: PROVIDER,
    amount: overrides.amount ?? fromBirr(25),
    recipient: '0900000000',
    idempotencyKey: idempotencyKeyOf(overrides.key ?? 'idem_test0001'),
    mode: 'TRAINING',
    at: at(),
  });
}

/** A balanced funding posting: credit merchant funds, debit bank clearing. */
export function fundingEntries(
  merchant: MerchantId,
  account: LedgerAccountId,
  amount: Money,
): DraftEntry[] {
  return [
    {
      accountId: account,
      accountKind: 'MERCHANT_FUNDS',
      merchantId: merchant,
      direction: 'CREDIT',
      amount,
      reason: 'FUNDING_CREDIT',
    },
    {
      accountId: ACC_CLEARING,
      accountKind: 'BANK_CLEARING',
      direction: 'DEBIT',
      amount,
      reason: 'FUNDING_CREDIT',
    },
  ];
}

/** A balanced sale posting: debit merchant funds, credit provider settlement. */
export function saleEntries(
  merchant: MerchantId,
  account: LedgerAccountId,
  txId: TransactionId,
  amount: Money,
): DraftEntry[] {
  return [
    {
      accountId: account,
      accountKind: 'MERCHANT_FUNDS',
      merchantId: merchant,
      transactionId: txId,
      direction: 'DEBIT',
      amount,
      reason: 'SALE_DEBIT',
      providerReference: 'MOCKREF-TEST',
      ruleVersion: 'unconfirmed-0',
    },
    {
      accountId: ACC_PROVIDER,
      accountKind: 'PROVIDER_SETTLEMENT',
      transactionId: txId,
      direction: 'CREDIT',
      amount,
      reason: 'SALE_DEBIT',
    },
  ];
}

export const posting = (name: string) => postingId(name);
export const reservation = (name: string) => reservationId(name);
