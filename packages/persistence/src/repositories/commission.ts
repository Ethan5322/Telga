/**
 * The commission policy — reading the rates, and recording what was paid.
 *
 * Two questions this module answers and one it deliberately does not.
 *
 * **What rate applies to this sale?** `effectiveCommissionBps` resolves the
 * most specific configured rate: a provider's rate for this product, then that
 * provider's rate for all products, then Telga's own platform default. Three
 * steps, each one a row an administrator wrote.
 *
 * **What did a sale actually pay?** `recordCommission` appends one entry, and
 * the figures in it are history from the moment it is written — migration 023
 * has a trigger that refuses to edit them.
 *
 * **What it does not do is calculate.** The split lives in `@telga/domain`, so
 * one function decides how money divides and the database does not get a second
 * opinion. This module carries figures; it never derives them.
 */

import type { MerchantId, Timestamp } from '@telga/domain';
import type { Db } from '../sqlite/connection';

export interface PlatformFeeSettings {
  readonly defaultCommissionBps: number;
  readonly shopShareBps: number;
  readonly cardFeeBps: number;
  /** The monthly software fee, in minor units. Migration 024. */
  readonly softwareFeeMinor: number;
  readonly softwareFeeEnabled: boolean;
  /**
   * The first month the software fee may be charged for, `YYYY-MM`.
   *
   * `null` until the first month-end run, which sets it to the month it runs
   * in. That is what stops the fee reaching back into months that ended before
   * it existed.
   */
  readonly softwareFeeFirstPeriod: string | null;
  readonly updatedByAdminId: string | null;
  readonly updatedAt: string;
}

/**
 * The platform's fee configuration. One row, no merchant scope.
 *
 * There is no merchant parameter, and that absence is the enforcement: a shop
 * cannot have its own rate because there is nowhere to put one.
 */
export function readPlatformFeeSettings(db: Db): PlatformFeeSettings {
  const row = db
    .prepare(
      `SELECT default_commission_bps, shop_share_bps, card_fee_bps,
              software_fee_minor, software_fee_enabled, software_fee_first_period,
              updated_by_admin_id, updated_at
         FROM platform_fee_settings WHERE id = 1`,
    )
    .get() as
    | {
        default_commission_bps: number;
        shop_share_bps: number;
        card_fee_bps: number;
        software_fee_minor: number;
        software_fee_enabled: number;
        software_fee_first_period: string | null;
        updated_by_admin_id: string | null;
        updated_at: string;
      }
    | undefined;

  if (row === undefined) {
    // Migration 023 seeds the row, so this is unreachable on a migrated
    // database. It throws rather than substituting defaults: a missing fee
    // configuration means the database is not what this code believes it is,
    // and guessing a rate at that moment is how a shop gets paid a number
    // nobody chose.
    throw new Error('platform_fee_settings has no row — run migrations');
  }

  return {
    defaultCommissionBps: row.default_commission_bps,
    shopShareBps: row.shop_share_bps,
    cardFeeBps: row.card_fee_bps,
    softwareFeeMinor: row.software_fee_minor,
    // SQLite has no boolean; the column is a CHECK-constrained 0 or 1.
    softwareFeeEnabled: row.software_fee_enabled === 1,
    softwareFeeFirstPeriod: row.software_fee_first_period,
    updatedByAdminId: row.updated_by_admin_id,
    updatedAt: row.updated_at,
  };
}

export interface FeeSettingsUpdate {
  readonly defaultCommissionBps?: number;
  readonly shopShareBps?: number;
  readonly cardFeeBps?: number;
  readonly softwareFeeMinor?: number;
  readonly softwareFeeEnabled?: boolean;
  readonly softwareFeeFirstPeriod?: string;
  readonly adminId: string;
  readonly at: Timestamp;
}

/** Change the platform's fee configuration. Admin-only, by shape and by route. */
export function writePlatformFeeSettings(db: Db, update: FeeSettingsUpdate): void {
  const current = readPlatformFeeSettings(db);
  db.prepare(
    `UPDATE platform_fee_settings
        SET default_commission_bps = @defaultCommissionBps,
            shop_share_bps         = @shopShareBps,
            card_fee_bps           = @cardFeeBps,
            software_fee_minor     = @softwareFeeMinor,
            software_fee_enabled   = @softwareFeeEnabled,
            software_fee_first_period = @softwareFeeFirstPeriod,
            updated_by_admin_id    = @adminId,
            updated_at             = @at
      WHERE id = 1`,
  ).run({
    defaultCommissionBps: update.defaultCommissionBps ?? current.defaultCommissionBps,
    shopShareBps: update.shopShareBps ?? current.shopShareBps,
    cardFeeBps: update.cardFeeBps ?? current.cardFeeBps,
    softwareFeeMinor: update.softwareFeeMinor ?? current.softwareFeeMinor,
    softwareFeeEnabled: (update.softwareFeeEnabled ?? current.softwareFeeEnabled) ? 1 : 0,
    softwareFeeFirstPeriod: update.softwareFeeFirstPeriod ?? current.softwareFeeFirstPeriod,
    adminId: update.adminId,
    at: update.at,
  });
}

export interface ProviderCommissionRate {
  readonly id: string;
  readonly providerId: string;
  readonly productType: string | null;
  readonly commissionBps: number;
  readonly source: string;
  readonly status: 'NOT_YET_CONFIRMED' | 'CONFIRMED';
  readonly updatedAt: string;
}

export function readProviderRates(db: Db): readonly ProviderCommissionRate[] {
  const rows = db
    .prepare(
      `SELECT id, provider_id, product_type, commission_bps, source, status, updated_at
         FROM provider_commission_rates
        ORDER BY provider_id, product_type IS NULL DESC, product_type`,
    )
    .all() as {
    id: string;
    provider_id: string;
    product_type: string | null;
    commission_bps: number;
    source: string;
    status: 'NOT_YET_CONFIRMED' | 'CONFIRMED';
    updated_at: string;
  }[];

  return rows.map((r) => ({
    id: r.id,
    providerId: r.provider_id,
    productType: r.product_type,
    commissionBps: r.commission_bps,
    source: r.source,
    status: r.status,
    updatedAt: r.updated_at,
  }));
}

export interface ProviderRateInput {
  readonly id: string;
  readonly providerId: string;
  readonly productType: string | null;
  readonly commissionBps: number;
  readonly source: string;
  readonly status?: 'NOT_YET_CONFIRMED' | 'CONFIRMED';
  readonly adminId: string;
  readonly at: Timestamp;
}

/** Record a provider's rate. `source` is required — see migration 023. */
export function saveProviderRate(db: Db, input: ProviderRateInput): void {
  db.prepare(
    `INSERT INTO provider_commission_rates
       (id, provider_id, product_type, commission_bps, source, status,
        created_by_admin_id, created_at, updated_at)
     VALUES (@id, @providerId, @productType, @commissionBps, @source, @status,
             @adminId, @at, @at)
     ON CONFLICT (provider_id, product_type) WHERE product_type IS NOT NULL
       DO UPDATE SET commission_bps = @commissionBps, source = @source,
                     status = @status, updated_at = @at`,
  ).run({
    id: input.id,
    providerId: input.providerId,
    productType: input.productType,
    commissionBps: input.commissionBps,
    source: input.source,
    status: input.status ?? 'NOT_YET_CONFIRMED',
    adminId: input.adminId,
    at: input.at,
  });
}

/**
 * The rate that applies to one sale, most specific first.
 *
 * 1. This provider's rate for this product.
 * 2. This provider's rate for all its products.
 * 3. Telga's platform default.
 *
 * Step 3 is a configured figure an administrator can see and change, not a
 * constant reached for inside a calculation — the distinction §30 turns on.
 * A sale with no provider (a training sale, say) lands there directly.
 */
export function effectiveCommissionBps(
  db: Db,
  providerId: string | null,
  productType: string,
): number {
  if (providerId !== null) {
    const specific = db
      .prepare(
        `SELECT commission_bps FROM provider_commission_rates
          WHERE provider_id = ? AND product_type = ?`,
      )
      .get(providerId, productType) as { commission_bps: number } | undefined;
    if (specific !== undefined) return specific.commission_bps;

    const fallback = db
      .prepare(
        `SELECT commission_bps FROM provider_commission_rates
          WHERE provider_id = ? AND product_type IS NULL`,
      )
      .get(providerId) as { commission_bps: number } | undefined;
    if (fallback !== undefined) return fallback.commission_bps;
  }

  return readPlatformFeeSettings(db).defaultCommissionBps;
}

export interface CommissionEntryInput {
  readonly id: string;
  readonly transactionId: string;
  readonly merchantId: MerchantId;
  readonly providerId: string | null;
  readonly productType: string;
  readonly transactionAmountMinor: number;
  readonly providerCommissionBps: number;
  readonly shopShareBps: number;
  readonly providerCommissionMinor: number;
  readonly shopShareMinor: number;
  readonly telgaShareMinor: number;
  readonly cardFeeMinor?: number;
  readonly at: Timestamp;
}

/**
 * Append one commission entry.
 *
 * The figures arrive already calculated, from `splitCommission`. Nothing is
 * recomputed here — a second implementation of the split is a second answer to
 * what a shop earned.
 */
export function recordCommission(db: Db, input: CommissionEntryInput): void {
  db.prepare(
    `INSERT INTO commission_entries
       (id, transaction_id, merchant_id, provider_id, product_type,
        transaction_amount_minor, provider_commission_bps, shop_share_bps,
        provider_commission_minor, shop_share_minor, telga_share_minor,
        card_fee_minor, created_at)
     VALUES (@id, @transactionId, @merchantId, @providerId, @productType,
             @transactionAmountMinor, @providerCommissionBps, @shopShareBps,
             @providerCommissionMinor, @shopShareMinor, @telgaShareMinor,
             @cardFeeMinor, @at)`,
  ).run({
    id: input.id,
    transactionId: input.transactionId,
    merchantId: input.merchantId,
    providerId: input.providerId,
    productType: input.productType,
    transactionAmountMinor: input.transactionAmountMinor,
    providerCommissionBps: input.providerCommissionBps,
    shopShareBps: input.shopShareBps,
    providerCommissionMinor: input.providerCommissionMinor,
    shopShareMinor: input.shopShareMinor,
    telgaShareMinor: input.telgaShareMinor,
    cardFeeMinor: input.cardFeeMinor ?? 0,
    at: input.at,
  });
}

export interface CommissionTotals {
  readonly entries: number;
  readonly providerCommissionMinor: number;
  readonly shopShareMinor: number;
  readonly telgaShareMinor: number;
  readonly unsettledMinor: number;
}

/**
 * What one shop earned, and what Telga kept from it.
 *
 * Reversed entries are excluded from every figure: a reversed sale earned
 * nobody anything, and counting it would overstate both sides.
 */
export function commissionTotalsFor(db: Db, merchantId: MerchantId): CommissionTotals {
  const row = db
    .prepare(
      `SELECT COUNT(*)                          AS entries,
              COALESCE(SUM(provider_commission_minor), 0) AS provider_total,
              COALESCE(SUM(shop_share_minor), 0)          AS shop_total,
              COALESCE(SUM(telga_share_minor), 0)         AS telga_total,
              COALESCE(SUM(CASE WHEN settlement_status = 'UNSETTLED'
                                THEN provider_commission_minor ELSE 0 END), 0) AS unsettled
         FROM commission_entries
        WHERE merchant_id = ? AND reversal_status = 'NONE'`,
    )
    .get(merchantId) as {
    entries: number;
    provider_total: number;
    shop_total: number;
    telga_total: number;
    unsettled: number;
  };

  return {
    entries: row.entries,
    providerCommissionMinor: row.provider_total,
    shopShareMinor: row.shop_total,
    telgaShareMinor: row.telga_total,
    unsettledMinor: row.unsettled,
  };
}

/**
 * Telga's own revenue across every shop.
 *
 * The console's answer to "where does Telga earn from providing this to shops".
 * It is a platform aggregate and names no shop's individual sale — §23.2.
 */
export function platformCommissionTotals(db: Db): CommissionTotals {
  const row = db
    .prepare(
      `SELECT COUNT(*)                          AS entries,
              COALESCE(SUM(provider_commission_minor), 0) AS provider_total,
              COALESCE(SUM(shop_share_minor), 0)          AS shop_total,
              COALESCE(SUM(telga_share_minor), 0)         AS telga_total,
              COALESCE(SUM(CASE WHEN settlement_status = 'UNSETTLED'
                                THEN provider_commission_minor ELSE 0 END), 0) AS unsettled
         FROM commission_entries
        WHERE reversal_status = 'NONE'`,
    )
    .get() as {
    entries: number;
    provider_total: number;
    shop_total: number;
    telga_total: number;
    unsettled: number;
  };

  return {
    entries: row.entries,
    providerCommissionMinor: row.provider_total,
    shopShareMinor: row.shop_total,
    telgaShareMinor: row.telga_total,
    unsettledMinor: row.unsettled,
  };
}

/** Mark a commission reversed. Forward-only — migration 023 refuses the undo. */
export function reverseCommission(
  db: Db,
  transactionId: string,
  at: Timestamp,
  reversalTransactionId?: string,
): void {
  db.prepare(
    `UPDATE commission_entries
        SET reversal_status = 'REVERSED', reversed_at = ?, reversal_transaction_id = ?
      WHERE transaction_id = ? AND reversal_status = 'NONE'`,
  ).run(at, reversalTransactionId ?? null, transactionId);
}
