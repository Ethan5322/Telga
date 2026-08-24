/**
 * Persistence test fixtures.
 *
 * Every suite gets its **own database file** in its own temp directory, so
 * suites cannot interfere with each other and a WAL journal is real rather than
 * simulated. `:memory:` is deliberately not the default: an in-memory database
 * reports `journal_mode = memory`, so it could never prove WAL is on.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTransaction,
  deviceId,
  fromBirr,
  idempotencyKeyOf,
  merchantId,
  merchantUserId,
  productId,
  providerId,
  timestamp,
  transactionId,
} from '@telga/domain';
import type { AuditActor, MerchantId, Money, Timestamp, Transaction } from '@telga/domain';
import { createSqliteDriver, hashRecipient, maskRecipient, SqliteLedgerDriver } from '@telga/persistence';
import type { TransactionInput } from '@telga/persistence';

export const MERCHANT_A: MerchantId = merchantId('merchant_alpha');
export const MERCHANT_B: MerchantId = merchantId('merchant_beta');
export const DEVICE_A = 'device_alpha_1';
export const DEVICE_B = 'device_beta_1';
export const OPERATOR_A = merchantUserId('operator_alpha_1');
export const RECIPIENT_SALT = 'test-salt-not-a-production-secret';

export const at = (iso = '2026-08-20T09:00:00.000Z'): Timestamp => timestamp(iso);

export const actor: AuditActor = {
  userId: OPERATOR_A,
  role: 'MERCHANT_OPERATOR',
  deviceId: deviceId(DEVICE_A),
};

export interface Harness {
  readonly driver: SqliteLedgerDriver;
  readonly dir: string;
  readonly file: string;
  cleanup(): void;
}

/** A fresh migrated database in its own directory. */
export function makeHarness(name = 'telga'): Harness {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  const file = join(dir, 'telga-test.sqlite');
  const driver = createSqliteDriver({ file }, at());

  return {
    driver,
    dir,
    file,
    cleanup(): void {
      try {
        driver.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** An unmigrated database, for migration tests. */
export function makeRawHarness(name = 'telga-raw'): Harness {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  const file = join(dir, 'telga-test.sqlite');
  const driver = new SqliteLedgerDriver({ file });

  return {
    driver,
    dir,
    file,
    cleanup(): void {
      try {
        driver.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Register a merchant and a device so foreign keys are satisfiable. */
export function seedMerchant(driver: SqliteLedgerDriver, merchant: MerchantId, device: string): void {
  driver.saveMerchant({ id: merchant, status: 'ACTIVE', mode: 'TRAINING', at: at() });
  driver.saveDevice({
    id: device,
    merchantId: merchant,
    status: 'ACTIVE',
    deviceType: 'SMART_POS',
    at: at(),
  });
}

export function makeTransaction(overrides: {
  id?: string;
  merchant?: MerchantId;
  device?: string;
  amount?: Money;
  key?: string;
} = {}): Transaction {
  return createTransaction({
    id: transactionId(overrides.id ?? 'txn_sim_0001'),
    merchantId: overrides.merchant ?? MERCHANT_A,
    deviceId: deviceId(overrides.device ?? DEVICE_A),
    operatorId: OPERATOR_A,
    productId: productId('airtime_sim_25'),
    providerId: providerId('provider_simulated'),
    amount: overrides.amount ?? fromBirr(25),
    recipient: '0900000000',
    idempotencyKey: idempotencyKeyOf(overrides.key ?? 'idem_test0001'),
    mode: 'TRAINING',
    at: at(),
  });
}

export function transactionInput(transaction: Transaction, recipient = '0900000000'): TransactionInput {
  return {
    transaction,
    recipientMasked: maskRecipient(recipient),
    recipientHash: hashRecipient(recipient, RECIPIENT_SALT),
    payloadFingerprint: 'fp_test',
    productType: 'AIRTIME',
  };
}
