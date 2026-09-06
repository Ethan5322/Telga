/**
 * Routing a merchant to its own database.
 *
 * Decision **D103** put each shop in its own SQLite file. `tenants.ts` holds
 * the naming and the safety rules; this module is the part that actually opens
 * one and hands it back, and it is the single place in the platform allowed to
 * do so.
 *
 * ## Why a router at all, rather than opening a file where it is needed
 *
 * Per-shop databases move merchant isolation from *"every query remembered its
 * `WHERE merchant_id = ?`"* to *"the other shop's rows are not in the file"*.
 * That is only true while there is exactly one way to get a connection. A
 * second call site that builds a path itself is how one shop's request ends up
 * reading another's file, and no test of the first path would catch it.
 *
 * ## What is checked on every open, not just at registration
 *
 *   1. The merchant is in the registry at all.
 *   2. The stored name is still safe — re-derived and re-validated, never
 *      trusted because it was validated when it was written. A registry row is
 *      data, and data can be edited by anything that reaches the database.
 *   3. The tenant's status permits serving. `PROVISIONING`, `MIGRATING`,
 *      `SUSPENDED`, `CLOSED` and `FAILED` each get their own refusal, because
 *      "cannot serve this shop" and "this shop is suspended" are different
 *      conversations with a merchant.
 *   4. The schema version matches the platform's. A half-migrated tenant is a
 *      real state with N databases, and serving one is how a sale gets written
 *      against a schema that no longer means what the code thinks.
 *
 * ## Why connections are cached, and what that costs
 *
 * Opening SQLite per request would be slow and would lose the busy-timeout
 * behaviour that makes concurrent writers wait rather than fail. Cached
 * handles mean the router owns their lifetime: `evict` and `closeAll` exist so
 * a suspended or migrating tenant's handle does not outlive its permission to
 * be served.
 */

import type { MerchantId } from '@telga/domain';
import {
  UnsafeTenantNameError,
  databaseNameFor,
  isServable,
  type TenantRecord,
  type TenantStatus,
} from './tenants';

/** Why a tenant could not be routed to. Each one is a different conversation. */
export type TenantRefusal =
  | 'NOT_REGISTERED'
  | 'UNSAFE_NAME'
  | 'PROVISIONING'
  | 'MIGRATING'
  | 'SUSPENDED'
  | 'CLOSED'
  | 'FAILED'
  | 'SCHEMA_BEHIND'
  | 'SCHEMA_AHEAD';

export class TenantUnavailableError extends Error {
  constructor(
    readonly merchantId: string,
    readonly refusal: TenantRefusal,
    readonly detail?: string,
  ) {
    super(
      `Cannot serve merchant ${merchantId}: ${refusal}` +
        `${detail === undefined ? '' : ` (${detail})`}.`,
    );
    this.name = 'TenantUnavailableError';
  }
}

/**
 * What a merchant is told, in plain language.
 *
 * Deliberately vague about the platform's internals — a merchant does not need
 * to know what a schema version is — and deliberately specific about what to do
 * next, because a message that ends without one produces a support call. These
 * are localization keys, so Amharic stays in the localization package rather
 * than being invented here.
 */
export const REFUSAL_MESSAGE_KEY: Readonly<Record<TenantRefusal, string>> = Object.freeze({
  NOT_REGISTERED: 'tenant.not_registered',
  UNSAFE_NAME: 'tenant.unavailable',
  PROVISIONING: 'tenant.being_prepared',
  MIGRATING: 'tenant.being_updated',
  SUSPENDED: 'tenant.suspended',
  CLOSED: 'tenant.closed',
  FAILED: 'tenant.unavailable',
  SCHEMA_BEHIND: 'tenant.being_updated',
  SCHEMA_AHEAD: 'tenant.unavailable',
});

const STATUS_REFUSAL: Readonly<Record<Exclude<TenantStatus, 'ACTIVE'>, TenantRefusal>> =
  Object.freeze({
    PROVISIONING: 'PROVISIONING',
    MIGRATING: 'MIGRATING',
    SUSPENDED: 'SUSPENDED',
    CLOSED: 'CLOSED',
    FAILED: 'FAILED',
  });

/** A tenant connection, however the caller's driver represents one. */
export interface TenantConnection {
  readonly merchantId: string;
  readonly file: string;
  readonly driver: { close: () => void };
  close: () => void;
}

export interface TenantRouterOptions {
  /**
   * Where tenant databases live. Joined with a validated name and nothing else
   * — never with anything taken from a request.
   */
  readonly root: string;
  /** The schema version a tenant must be on to be served. */
  readonly schemaVersion: string;
  /** Reads the registry row. Undefined when the merchant is unknown. */
  readonly lookup: (merchantId: string) => TenantRecord | undefined;
  /** Opens a driver for one file. Injected so this module needs no SQLite. */
  readonly open: (file: string) => { close: () => void };
  /** Joins the root and the file name for this platform. */
  readonly join?: (root: string, name: string) => string;
}

const defaultJoin = (root: string, name: string): string =>
  root.endsWith('/') || root.endsWith('\\') ? `${root}${name}` : `${root}/${name}`;

/**
 * Decide whether a registry row may be served, without opening anything.
 *
 * Separated from the router so the decision can be tested exhaustively, and so
 * the console can show why a tenant is unavailable without connecting to it.
 */
export function routingRefusal(
  merchantId: string,
  record: TenantRecord | undefined,
  schemaVersion: string,
): TenantRefusal | undefined {
  if (record === undefined) return 'NOT_REGISTERED';

  // Re-derive rather than trust. If the stored name is not the one this
  // merchant id produces, the row has been edited, and the safest reading of
  // an edited routing row is that it is hostile.
  let expected: string;
  try {
    expected = databaseNameFor(merchantId);
  } catch (error) {
    if (error instanceof UnsafeTenantNameError) return 'UNSAFE_NAME';
    throw error;
  }
  if (record.databaseName !== expected) return 'UNSAFE_NAME';

  if (!isServable(record.status)) {
    return STATUS_REFUSAL[record.status as Exclude<TenantStatus, 'ACTIVE'>];
  }

  if (record.schemaVersion !== schemaVersion) {
    // Behind and ahead are different faults. Behind means a migration has not
    // reached this shop yet and will. Ahead means this process is older than
    // the database it is pointed at — a migration will never fix that, and it
    // must never be served: old code writing a new schema is how a ledger
    // acquires rows nothing can read back.
    return record.schemaVersion < schemaVersion ? 'SCHEMA_BEHIND' : 'SCHEMA_AHEAD';
  }

  return undefined;
}

/**
 * The one way to reach a shop's database.
 *
 * A closure holding a cache rather than a class: the cache is the only state,
 * and its lifetime is the router's.
 */
export function createTenantRouter(options: TenantRouterOptions) {
  const join = options.join ?? defaultJoin;
  const cache = new Map<string, TenantConnection>();

  const fileFor = (record: TenantRecord): string =>
    // `databaseNameFor` has already refused anything unsafe, and this join is
    // the only place a tenant path is built. It never sees request input.
    join(options.root, `${record.databaseName}.sqlite`);

  return {
    /**
     * Open (or reuse) the connection for one merchant.
     *
     * Throws rather than returning undefined. A caller that forgot to check a
     * returned value would otherwise fall through to the platform database,
     * and writing a shop's sale into the platform ledger is the exact failure
     * this whole design exists to prevent.
     */
    for(merchantId: MerchantId | string): TenantConnection {
      const id = String(merchantId);
      const cached = cache.get(id);
      if (cached !== undefined) return cached;

      const record = options.lookup(id);
      const refusal = routingRefusal(id, record, options.schemaVersion);
      if (refusal !== undefined || record === undefined) {
        throw new TenantUnavailableError(
          id,
          refusal ?? 'NOT_REGISTERED',
          record === undefined ? undefined : `status ${record.status}, schema ${record.schemaVersion}`,
        );
      }

      const file = fileFor(record);
      const driver = options.open(file);
      const connection: TenantConnection = {
        merchantId: id,
        file,
        driver,
        close: () => {
          driver.close();
          cache.delete(id);
        },
      };
      cache.set(id, connection);
      return connection;
    },

    /** Whether a merchant could be served right now, without opening anything. */
    canServe(merchantId: MerchantId | string): boolean {
      const id = String(merchantId);
      return routingRefusal(id, options.lookup(id), options.schemaVersion) === undefined;
    },

    /** Why a merchant cannot be served, or undefined if they can. */
    refusalFor(merchantId: MerchantId | string): TenantRefusal | undefined {
      const id = String(merchantId);
      return routingRefusal(id, options.lookup(id), options.schemaVersion);
    },

    /**
     * Drop one tenant's handle.
     *
     * Called when a shop is suspended or a migration starts. Without it a
     * cached handle keeps serving a tenant whose permission to be served has
     * just been withdrawn — the status check happens on open, and a cached
     * connection never opens again.
     */
    evict(merchantId: MerchantId | string): void {
      cache.get(String(merchantId))?.close();
    },

    /** Close everything. For shutdown, and for a test that must not leak files. */
    closeAll(): void {
      for (const connection of [...cache.values()]) connection.close();
      cache.clear();
    },

    /** How many tenants are currently held open. */
    get openCount(): number {
      return cache.size;
    },
  };
}

export type TenantRouter = ReturnType<typeof createTenantRouter>;
