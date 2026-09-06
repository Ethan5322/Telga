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

/**
 * What a voucher catalog entry is, from the order-creation service's point of
 * view. Separate from `CatalogProduct`: `/sell` and the voucher order flow
 * must never share one structure, so a change to one cannot silently change
 * what the other validates against.
 */
export interface VoucherOrderProduct {
  readonly productId: string;
  readonly network: string;
  readonly productType: 'AIRTIME' | 'TOPUP' | 'DATA';
  /** The fixed denomination. Meaningless — and never used — when `isCustom`. */
  readonly amountMinor: number;
  readonly available: boolean;
  /**
   * True for the per-network custom entry, whose amount the operator types
   * and the server validates against `TRAINING_CUSTOM_AMOUNT_LIMITS` and the
   * available balance.
   */
  readonly isCustom?: boolean;
}

export interface VoucherOrderCatalog {
  find(productId: string): VoucherOrderProduct | undefined;
}

export function simulatedVoucherCatalog(
  products: readonly VoucherOrderProduct[],
): VoucherOrderCatalog {
  const byId = new Map(products.map((p) => [p.productId, p]));
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
   * The mask to store, when the caller already holds one and the full number
   * no longer exists.
   *
   * The voucher flow masks a phone number at order creation and deliberately
   * never keeps the full value, so by authorization time there is nothing
   * left to mask — re-masking a mask would print nonsense. An empty string
   * means the product genuinely has no recipient, and the slip omits the
   * line rather than printing a row of stars.
   */
  readonly recipientMasked?: string;
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
