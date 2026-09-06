/**
 * Turning an approved application into a shop that can trade.
 *
 * Approval used to set a status column and stop. Everything that makes a shop
 * real — the merchant record, its own database, the registry row that lets a
 * request reach it — was left for somebody to do by hand, which meant an
 * `APPROVED` application and a working shop were unrelated facts.
 *
 * ## Why the order below is the order
 *
 * Provisioning touches two databases and cannot be one transaction. So the
 * steps are ordered by what a failure leaves behind:
 *
 *   1. **Reserve the name and claim the registry row** as `PROVISIONING`. The
 *      row is the lock. Two approvals of the same application race here and one
 *      loses on the primary key, which is why the merchant id is derived from
 *      the application rather than generated fresh.
 *   2. **Create and migrate the tenant database.** The slow, failure-prone step,
 *      done while the registry says `PROVISIONING` — a status no request will
 *      be served against.
 *   3. **Write the merchant record** into the tenant database.
 *   4. **Mark the registry `ACTIVE`.** The single moment the shop becomes
 *      reachable, and the last step, so nothing is reachable before it is ready.
 *   5. **Link the application to the merchant.** Bookkeeping, after the fact.
 *
 * A crash between any two steps leaves the registry on `PROVISIONING` or
 * `FAILED`. Both refuse to serve, and both are visible on the console's tenant
 * screen. Nothing is left in a state that looks finished but is not.
 *
 * ## Why nothing is rolled back on failure
 *
 * A half-provisioned tenant is marked `FAILED` and kept. Deleting the file
 * would be the tidy option and the wrong one: if step 3 half-succeeded, that
 * file holds the only evidence of what happened, and the ledger rules in
 * `CLAUDE.md` §13 do not have an exception for files that are probably empty.
 * Re-running provisioning for a `FAILED` tenant is a deliberate act with its
 * own audit event, not an automatic retry.
 */

import type { MerchantId } from '@telga/domain';
import { UnsafeTenantNameError, databaseNameFor, type TenantRecord } from './tenants';

/** Everything provisioning needs, injected so this module opens nothing itself. */
export interface ProvisioningPorts {
  readonly now: () => string;
  /** The schema version a newly created tenant must end up on. */
  readonly schemaVersion: string;
  /** Claims the registry row. Must fail if the merchant id is already taken. */
  readonly claimRegistryRow: (record: {
    merchantId: string;
    databaseName: string;
    schemaVersion: string;
    at: string;
  }) => void;
  readonly setTenantStatus: (
    merchantId: string,
    status: TenantRecord['status'],
    at: string,
  ) => void;
  /** Creates the file and runs every migration. Returns the version reached. */
  readonly createTenantDatabase: (databaseName: string) => { schemaVersion: string };
  /** Writes the merchant row into the tenant database just created. */
  readonly writeMerchantRecord: (input: {
    databaseName: string;
    merchantId: string;
    legalName: string;
    tradingName: string | null;
    locality: string;
    at: string;
  }) => void;
  /** Links the application back to the shop it became. */
  readonly linkApplication: (applicationId: string, merchantId: string, at: string) => void;
}

export interface ApprovedApplication {
  readonly id: string;
  readonly reference: string;
  readonly legalName: string;
  readonly tradingName: string | null;
  readonly locality: string;
  readonly status: string;
}

export type ProvisioningRefusal =
  | 'NOT_APPROVED'
  | 'ALREADY_PROVISIONED'
  | 'UNSAFE_NAME'
  | 'DATABASE_FAILED'
  | 'MERCHANT_WRITE_FAILED';

export class ProvisioningError extends Error {
  constructor(
    readonly refusal: ProvisioningRefusal,
    readonly applicationId: string,
    // `Error` already declares `cause`, so this narrows it rather than
    // introducing it.
    override readonly cause?: unknown,
  ) {
    super(`Cannot provision ${applicationId}: ${refusal}.`);
    this.name = 'ProvisioningError';
  }
}

/**
 * The merchant id an application becomes.
 *
 * Derived, not generated. Two operators approving the same application at the
 * same moment must collide on the registry's primary key rather than quietly
 * creating two shops for one applicant — and a retry after a crash must land on
 * the same id it did the first time, or the second attempt would provision a
 * duplicate alongside the wreckage of the first.
 *
 * The application id is already unguessable (`newApplicationReference` uses
 * `randomInt`), so deriving from it leaks nothing a merchant id should not.
 */
export const merchantIdFor = (applicationId: string): string =>
  `mch_${applicationId.replace(/^app_/, '')}`;

/** Which statuses may be provisioned from. */
const PROVISIONABLE = new Set(['APPROVED', 'PROVISIONING']);

export interface ProvisioningResult {
  readonly merchantId: string;
  readonly databaseName: string;
  readonly schemaVersion: string;
}

/**
 * Provision one approved application.
 *
 * Synchronous throughout: every port is a local database call, and making this
 * async would invite a caller to interleave two provisionings whose only
 * mutual exclusion is the registry row.
 */
export function provisionMerchant(
  ports: ProvisioningPorts,
  application: ApprovedApplication,
): ProvisioningResult {
  if (!PROVISIONABLE.has(application.status)) {
    throw new ProvisioningError('NOT_APPROVED', application.id);
  }

  const merchantId = merchantIdFor(application.id);
  let databaseName: string;
  try {
    databaseName = databaseNameFor(merchantId);
  } catch (error) {
    if (error instanceof UnsafeTenantNameError) {
      throw new ProvisioningError('UNSAFE_NAME', application.id, error);
    }
    throw error;
  }

  // Step 1 — claim the row. This is the lock, so it happens before any work.
  try {
    ports.claimRegistryRow({
      merchantId,
      databaseName,
      schemaVersion: ports.schemaVersion,
      at: ports.now(),
    });
  } catch (error) {
    // A primary-key collision means somebody else got here first. That is a
    // refusal, not an error: the shop exists, which is what was wanted.
    throw new ProvisioningError('ALREADY_PROVISIONED', application.id, error);
  }

  // Step 2 — the slow part, behind a status nothing is served against.
  let reached: string;
  try {
    reached = ports.createTenantDatabase(databaseName).schemaVersion;
  } catch (error) {
    markFailed(ports, merchantId);
    throw new ProvisioningError('DATABASE_FAILED', application.id, error);
  }

  // Step 3 — the merchant record, inside its own database.
  try {
    ports.writeMerchantRecord({
      databaseName,
      merchantId,
      legalName: application.legalName,
      tradingName: application.tradingName,
      locality: application.locality,
      at: ports.now(),
    });
  } catch (error) {
    markFailed(ports, merchantId);
    throw new ProvisioningError('MERCHANT_WRITE_FAILED', application.id, error);
  }

  // Step 4 — reachable, and not one moment sooner.
  ports.setTenantStatus(merchantId, 'ACTIVE', ports.now());

  // Step 5 — bookkeeping. A failure here leaves a working shop with a stale
  // application row, which is the mildest of the states available and is
  // repairable from the derived merchant id alone.
  ports.linkApplication(application.id, merchantId, ports.now());

  return { merchantId, databaseName, schemaVersion: reached };
}

/**
 * Mark a tenant `FAILED` without letting that write mask the original fault.
 *
 * If the registry itself is unreachable, the caller still needs to see why
 * provisioning failed rather than why the bookkeeping about the failure failed.
 */
function markFailed(ports: ProvisioningPorts, merchantId: string): void {
  try {
    ports.setTenantStatus(merchantId, 'FAILED', ports.now());
  } catch {
    // Swallowed on purpose. The throw that follows carries the real cause.
  }
}

/**
 * What the console shows after provisioning.
 *
 * The device is deliberately not created here. A shop exists before it has
 * hardware, and an operator has to enrol a device with a token that expires in
 * an hour (`enrollment.ts`) — minting one at approval time, hours or days
 * before anyone is standing at the counter, would mean either a token that has
 * expired by the time it is needed or one with a lifetime long enough to be
 * worth stealing.
 */
export const PROVISIONED_NOTICE =
  'The shop and its database are ready. Register a device next, then issue an ' +
  'activation code from the device screen when the merchant is with you.';

/** Applied to a merchant id given `MerchantId` branding elsewhere. */
export const asMerchantId = (id: string): MerchantId => id as MerchantId;
