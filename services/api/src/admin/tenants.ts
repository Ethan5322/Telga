/**
 * The tenant registry: which database belongs to which shop.
 *
 * Under the per-shop database model (Decision Log **D103**) this is the one
 * shared table, and it is what keeps that model from being a folder of
 * untracked files. Everything else — routing, migration, backup — reads from
 * here.
 *
 * ## Why the database name is derived, never supplied
 *
 * A caller that could choose a tenant's filename could choose
 * `../../../etc/passwd`, or could point two merchants at one file. The name is
 * computed from the merchant id and validated against a strict pattern, and
 * the pattern is checked again at open time rather than trusted from the row —
 * a registry row is data, and data that becomes a filesystem path is exactly
 * what must not be trusted.
 *
 * ## Why `schema_version` is per tenant
 *
 * With one database, "migrated" is a single fact. With N, a half-migrated
 * tenant is a real state: the run can fail on shop 400 of 1,000. It has to be
 * **detectable**, so every tenant records its own version and
 * {@link tenantsBehind} is how a deploy finds the ones that need attention.
 */

import type { MerchantId } from '@telga/domain';

/** Only these characters, and never a separator. */
const SAFE_NAME = /^[a-z0-9_-]+$/;

export type TenantStatus =
  | 'PROVISIONING'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'CLOSED'
  | 'MIGRATING'
  | 'FAILED';

export interface TenantRecord {
  readonly merchantId: string;
  readonly databaseName: string;
  readonly schemaVersion: string;
  readonly status: TenantStatus;
  readonly lastBackupAt: string | null;
  readonly lastRestoreAt: string | null;
}

export class UnsafeTenantNameError extends Error {
  readonly code = 'UNSAFE_TENANT_NAME';
  constructor(readonly supplied: string) {
    // The value is named so an operator can see what was refused, but it is
    // never joined onto a path first.
    super(`Refusing tenant database name ${JSON.stringify(supplied)}: not a safe identifier.`);
    this.name = 'UnsafeTenantNameError';
  }
}

/**
 * The database name for a merchant.
 *
 * Derived, so two merchants cannot collide and no caller can choose one. A
 * merchant id that would not produce a safe name is refused rather than
 * sanitised: silently rewriting an id would map two different merchants onto
 * one file, which is the exact failure this model exists to prevent.
 */
export function databaseNameFor(merchantId: MerchantId | string): string {
  const name = String(merchantId).trim().toLowerCase();
  if (!SAFE_NAME.test(name)) throw new UnsafeTenantNameError(String(merchantId));
  return `${name}.sqlite`;
}

/**
 * Resolve a registry row to a filename, re-checking the pattern.
 *
 * The row was written by this service, but it is still data in a table, and a
 * table can be edited. Checking again at open time costs a regular expression
 * and removes a whole class of path traversal.
 */
export function tenantFileName(record: Pick<TenantRecord, 'databaseName'>): string {
  const base = record.databaseName.replace(/\.sqlite$/, '');
  if (!SAFE_NAME.test(base)) throw new UnsafeTenantNameError(record.databaseName);
  return `${base}.sqlite`;
}

/** Whether a tenant may be opened for ordinary work. */
export const isServable = (status: TenantStatus): boolean => status === 'ACTIVE';

/**
 * Tenants not on the current schema version.
 *
 * The query a deploy asks. Under one database this question does not exist;
 * under N it is the difference between "migrated" and "mostly migrated", and
 * only one of those is safe to serve.
 */
export function tenantsBehind(
  tenants: readonly TenantRecord[],
  currentVersion: string,
): readonly TenantRecord[] {
  return tenants.filter((t) => t.schemaVersion !== currentVersion);
}

/**
 * Tenants whose backup is older than the policy allows, newest omission first.
 *
 * `null` counts as overdue and sorts first: a shop that has **never** been
 * backed up is the most urgent case, and treating a missing backup as "not yet
 * due" is how it stays missing.
 */
export function backupsOverdue(
  tenants: readonly TenantRecord[],
  now: string,
  maxAgeMs: number,
): readonly TenantRecord[] {
  const cutoff = Date.parse(now) - maxAgeMs;
  return tenants
    .filter((t) => {
      if (t.status === 'CLOSED') return false;
      if (t.lastBackupAt === null) return true;
      const at = Date.parse(t.lastBackupAt);
      return !Number.isFinite(at) || at < cutoff;
    })
    .sort((a, b) => {
      if (a.lastBackupAt === b.lastBackupAt) return 0;
      if (a.lastBackupAt === null) return -1;
      if (b.lastBackupAt === null) return 1;
      return a.lastBackupAt < b.lastBackupAt ? -1 : 1;
    });
}

/**
 * Whether the platform's books can be proven right now.
 *
 * Under one database `ledgerResidualMinor()` proved double entry across
 * everything in a single query. Under N it proves it **per shop**, which is
 * the invariant CLAUDE.md §13.2 actually states — a merchant's books must
 * balance. The platform-wide figure is this sum, and it is only meaningful
 * when every tenant was actually readable: a tenant that could not be opened
 * makes the total a guess, so this reports that rather than returning a number
 * that looks authoritative.
 */
export interface PlatformResidual {
  readonly residualMinor: number;
  readonly tenantsChecked: number;
  readonly tenantsUnreadable: readonly string[];
  /** True only when every non-closed tenant was read and every one balanced. */
  readonly sound: boolean;
}

export function summariseResiduals(
  results: readonly { merchantId: string; residualMinor: number | null }[],
): PlatformResidual {
  const unreadable = results.filter((r) => r.residualMinor === null).map((r) => r.merchantId);
  const readable = results.filter(
    (r): r is { merchantId: string; residualMinor: number } => r.residualMinor !== null,
  );
  const residual = readable.reduce((sum, r) => sum + r.residualMinor, 0);
  return {
    residualMinor: residual,
    tenantsChecked: readable.length,
    tenantsUnreadable: unreadable,
    // A zero total across tenants that were not all readable is not proof.
    sound: unreadable.length === 0 && residual === 0,
  };
}
