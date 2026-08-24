/**
 * Orchestration test fixtures.
 *
 * Time and identifiers are both injected and both deterministic, so a whole
 * sale — including its audit trail and ledger entry ids — replays identically.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deviceId,
  fromBirr,
  merchantId,
  merchantUserId,
  postingId,
  productId,
  providerId,
  timestamp,
} from '@telga/domain';
import type { MerchantId, Money, ProductId, Timestamp } from '@telga/domain';
import { createSqliteDriver, fundMerchant } from '@telga/persistence';
import type { SqliteLedgerDriver } from '@telga/persistence';
import { MockAirtimeProvider } from '@telga/provider-mock-airtime';
import type { MockBehaviour } from '@telga/provider-mock-airtime';
import { simulatedCatalog } from '@telga/api';
import type { SaleDeps, SaleRequest } from '@telga/api';

export const MERCHANT_A: MerchantId = merchantId('merchant_alpha');
export const MERCHANT_B: MerchantId = merchantId('merchant_beta');
export const DEVICE_A = deviceId('device_alpha_1');
export const DEVICE_B = deviceId('device_beta_1');
export const OPERATOR_A = merchantUserId('operator_alpha_1');
export const PROVIDER = providerId('provider_simulated');
export const PRODUCT: ProductId = productId('AIRTIME');
export const SALT = 'test-salt-not-a-production-secret';

const BASE_TIME = Date.parse('2026-08-20T09:00:00.000Z');

/** A clock the test drives. Nothing in the services reads the real time. */
export class TestClock {
  private ms = BASE_TIME;

  now(): Timestamp {
    return timestamp(new Date(this.ms).toISOString());
  }

  advance(ms: number): void {
    this.ms += ms;
  }
}

/** Deterministic ids: `txn_1`, `post_2`, and so on, in call order. */
export function idFactory(): (prefix: string) => string {
  let n = 0;
  return (prefix: string) => {
    n += 1;
    return `${prefix}_${String(n)}`;
  };
}

export interface Harness {
  readonly deps: SaleDeps;
  readonly driver: SqliteLedgerDriver;
  readonly provider: MockAirtimeProvider;
  readonly clock: TestClock;
  /** The database file, so a test can open a second connection to it. */
  readonly file: string;
  cleanup(): void;
}

export interface HarnessOptions {
  readonly behaviour?: MockBehaviour;
  readonly delayTicks?: number;
  readonly fundBirr?: number;
  readonly pendingMaximumMs?: number;
  readonly mode?: SaleDeps['mode'];
  readonly productAvailable?: boolean;
  readonly seedSecondMerchant?: boolean;
}

export function makeHarness(name: string, options: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), `telga-orch-${name}-`));
  const file = join(dir, 'telga.sqlite');
  const clock = new TestClock();
  const driver = createSqliteDriver({ file }, clock.now());

  const provider = new MockAirtimeProvider({
    providerId: PROVIDER,
    behaviour: options.behaviour ?? 'SUCCESS',
    delayTicks: options.delayTicks ?? 1,
  });

  seed(driver, MERCHANT_A, DEVICE_A, clock.now());
  if (options.seedSecondMerchant) seed(driver, MERCHANT_B, DEVICE_B, clock.now());

  const fund = options.fundBirr ?? 100;
  if (fund > 0) {
    fundMerchant(driver, {
      merchantId: MERCHANT_A,
      amount: fromBirr(fund),
      at: clock.now(),
      correlationId: 'corr_seed',
      postingId: postingId('post_seed_a'),
    });
    if (options.seedSecondMerchant) {
      fundMerchant(driver, {
        merchantId: MERCHANT_B,
        amount: fromBirr(fund),
        at: clock.now(),
        correlationId: 'corr_seed_b',
        postingId: postingId('post_seed_b'),
      });
    }
  }

  const deps: SaleDeps = {
    driver,
    provider,
    providerId: PROVIDER,
    catalog: simulatedCatalog([
      { id: PRODUCT, label: 'Airtime (simulated)', available: options.productAvailable ?? true },
    ]),
    mode: options.mode ?? 'TRAINING',
    recipientSalt: SALT,
    now: () => clock.now(),
    newId: idFactory(),
    pendingMaximumMs: options.pendingMaximumMs ?? 5 * 60 * 1000,
  };

  return {
    deps,
    driver,
    provider,
    clock,
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

function seed(driver: SqliteLedgerDriver, merchant: MerchantId, device: string, at: Timestamp): void {
  driver.saveMerchant({ id: merchant, status: 'ACTIVE', mode: 'TRAINING', at });
  driver.saveDevice({ id: device, merchantId: merchant, status: 'ACTIVE', deviceType: 'SMART_POS', at });
}

export function saleRequest(overrides: Partial<SaleRequest> = {}): SaleRequest {
  return {
    merchantId: MERCHANT_A,
    deviceId: DEVICE_A,
    operatorId: OPERATOR_A,
    productId: PRODUCT,
    amount: fromBirr(25) as Money,
    recipient: '0900000000',
    clientRequestId: 'req_0001',
    ...overrides,
  };
}

/**
 * Wrap a driver so the Nth call to `method` throws.
 *
 * Used to inject failures at each stage of a unit of work without putting
 * test-only hooks into the production services.
 */
export function failAt(
  driver: SqliteLedgerDriver,
  method: keyof SqliteLedgerDriver,
  occurrence = 1,
  error: Error = new Error('injected failure'),
): SqliteLedgerDriver {
  let seen = 0;
  return new Proxy(driver, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (prop === method) {
        return (...args: unknown[]): unknown => {
          seen += 1;
          if (seen === occurrence) throw error;
          return fn.apply(target, args);
        };
      }
      return fn.bind(target);
    },
  }) as SqliteLedgerDriver;
}

export const withDriver = (deps: SaleDeps, driver: SqliteLedgerDriver): SaleDeps => ({ ...deps, driver });
