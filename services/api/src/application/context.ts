/**
 * Orchestration dependencies.
 *
 * Everything the sale services need is injected: the driver, the provider, the
 * clock and the id generator. Nothing here reads `Date.now()` or `Math.random()`
 * on its own, so a test can replay a whole sale byte-identically.
 */

import type {
  AirtimeProvider,
  DeviceId,
  MerchantId,
  MerchantUserId,
  Money,
  OperatingMode,
  ProductId,
  ProviderId,
  Timestamp,
} from '@telga/domain';
import type { SqliteLedgerDriver } from '@telga/persistence';

/** What a product is, from the orchestration's point of view. */
export interface CatalogProduct {
  readonly id: ProductId;
  readonly label: string;
  readonly available: boolean;
}

export interface ProductCatalog {
  find(productId: ProductId): CatalogProduct | undefined;
}

/** A catalog of clearly simulated airtime denominations. */
export function simulatedCatalog(products: readonly CatalogProduct[]): ProductCatalog {
  const byId = new Map(products.map((p) => [p.id, p]));
  return { find: (productId) => byId.get(productId) };
}

export interface SaleDeps {
  readonly driver: SqliteLedgerDriver;
  readonly provider: AirtimeProvider;
  readonly providerId: ProviderId;
  readonly catalog: ProductCatalog;
  /** Always TRAINING in this build; anything else is refused at the door. */
  readonly mode: OperatingMode;
  readonly recipientSalt: string;
  /** Injected clock. */
  now(): Timestamp;
  /** Injected id generation, so ids are deterministic in tests. */
  newId(prefix: string): string;
  /** How long a transaction may stay PENDING before escalation. Default 5 minutes. */
  readonly pendingMaximumMs?: number;
  /** Milliseconds the adapter is given before silence is treated as pending. */
  readonly providerTimeoutMs?: number;
}

export const DEFAULT_PENDING_MAXIMUM_MS = 5 * 60 * 1000;
export const DEFAULT_PROVIDER_TIMEOUT_MS = 5000;

export interface SaleRequest {
  readonly merchantId: MerchantId;
  readonly deviceId: DeviceId;
  readonly operatorId: MerchantUserId;
  readonly productId: ProductId;
  readonly amount: Money;
  readonly recipient: string;
  /**
   * Generated once per user intent — when the confirmation screen opens, not
   * when the button is pressed — so a second press carries the same value.
   */
  readonly clientRequestId: string;
  readonly correlationId?: string;
}

export const pendingMaximum = (deps: SaleDeps): number =>
  deps.pendingMaximumMs ?? DEFAULT_PENDING_MAXIMUM_MS;

export const providerTimeout = (deps: SaleDeps): number =>
  deps.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;

/** Add milliseconds to a timestamp without pulling in a date library. */
export function addMs(at: Timestamp, ms: number): Timestamp {
  return new Date(new Date(at).getTime() + ms).toISOString() as Timestamp;
}

export const isAfter = (a: string, b: string): boolean => new Date(a).getTime() >= new Date(b).getTime();
