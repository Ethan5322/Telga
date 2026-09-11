/**
 * Ordered migration list.
 *
 * Migrations are **immutable once applied**: the migrator stores a checksum of
 * each one, and editing an applied migration is refused rather than silently
 * re-run. To change the schema, add a new migration.
 *
 * There is no `down`. Production rollback is **forward-fix only** — see
 * `docs/obsidian/09 Engineering/Migration Strategy.md`. A ledger cannot be
 * un-migrated without risking history, so the rollback that exists is the
 * per-migration transaction: a migration that throws is rolled back whole and
 * never recorded as applied.
 */

import { m001InitialSchema } from './001_initial_schema';
import { m002LedgerAppendOnly } from './002_ledger_append_only';
import { m003AuditAppendOnly } from './003_audit_append_only';
import { m004PendingAndSupport } from './004_pending_and_support';
import { m005RecoveryClaims } from './005_recovery_claims';
import { m006AuthAndDevices } from './006_auth_and_devices';
import { m007PendingOrders } from './007_pending_orders';
import { m008RecipientTopupSettings } from './008_recipient_topup_settings';
import { m009DataVouchers } from './009_data_vouchers';
import { m010OrderQuantity } from './010_order_quantity';
import { m011CorporateSettings } from './011_corporate_settings';
import { m012ShiftsCustomersPreferences } from './012_shifts_customers_preferences';
import { m013AttemptsAndProviderHealth } from './013_attempts_and_provider_health';
import { m014AdminIdentityAndTenants } from './014_admin_identity_and_tenants';
import { m015ApplicationDocumentsAndPinChange } from './015_application_documents_and_pin_change';
import { m016FundingSubmissions } from './016_funding_submissions';
import { m017AdminEmailOtp } from './017_admin_email_otp';
import { m018SelfServiceRegistration } from './018_self_service_registration';
import { m019ReversalComplaintsTransfers } from './019_reversal_complaints_transfers';
import { m020TopupOrders } from './020_topup_orders';
import { m021ShopDepositReference } from './021_shop_deposit_reference';
import { m022DepositMethod } from './022_deposit_method';

export interface Migration {
  /** Sort key. Zero-padded so lexical order is execution order. */
  readonly version: string;
  readonly name: string;
  /** Executed inside a single database transaction. */
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  m001InitialSchema,
  m002LedgerAppendOnly,
  m003AuditAppendOnly,
  m004PendingAndSupport,
  m005RecoveryClaims,
  m006AuthAndDevices,
  m007PendingOrders,
  m008RecipientTopupSettings,
  m009DataVouchers,
  m010OrderQuantity,
  m011CorporateSettings,
  m012ShiftsCustomersPreferences,
  m013AttemptsAndProviderHealth,
  m014AdminIdentityAndTenants,
  m015ApplicationDocumentsAndPinChange,
  m016FundingSubmissions,
  m017AdminEmailOtp,
  m018SelfServiceRegistration,
  m019ReversalComplaintsTransfers,
  m020TopupOrders,
  m021ShopDepositReference,
  m022DepositMethod,
]);

export {
  m001InitialSchema,
  m002LedgerAppendOnly,
  m003AuditAppendOnly,
  m004PendingAndSupport,
  m005RecoveryClaims,
  m006AuthAndDevices,
  m007PendingOrders,
  m008RecipientTopupSettings,
  m009DataVouchers,
  m010OrderQuantity,
  m011CorporateSettings,
  m012ShiftsCustomersPreferences,
  m013AttemptsAndProviderHealth,
  m014AdminIdentityAndTenants,
  m015ApplicationDocumentsAndPinChange,
  m016FundingSubmissions,
  m017AdminEmailOtp,
  m018SelfServiceRegistration,
  m019ReversalComplaintsTransfers,
  m020TopupOrders,
  m021ShopDepositReference,
  m022DepositMethod,
};

