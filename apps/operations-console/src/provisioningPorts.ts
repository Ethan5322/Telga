/**
 * The console's implementation of {@link ProvisioningPorts}.
 *
 * `provisioning.ts` describes *what* provisioning does and in what order;
 * this file is *where* the rows land. Keeping them apart is what lets the
 * storage model change without the provisioning sequence being rewritten — and
 * that separation is load-bearing here, because the storage model is an open
 * decision.
 *
 * ## The storage model this implements, and the decision behind it
 *
 * **One shared database, with logical isolation.** Every shop's rows live in the
 * file the console already has open, separated by `merchant_id` and by the fact
 * that `handlers.ts` derives the merchant from the session and never from a
 * request body.
 *
 * That is **not** what [[Decision Log]] D103 chose. D103 chose one SQLite file
 * per shop and called it *"the irreversible choice"*. D113 then deferred it for
 * the single-shop training deployment, and named the condition that would end
 * the deferral: *"it stops being defensible the moment a second real shop
 * exists."*
 *
 * The founder's multi-tenant brief re-opened it from the other side, asking for
 * data *"logically isolated, even if in the same database"* — a weaker
 * requirement than D103's. **D118 recommends taking that weaker requirement**,
 * on the grounds that the brief's own admin panel wants aggregate reporting
 * across every shop, which is one query here and a fan-out under D103.
 *
 * > **That reversal is not yet signed off.** This module is written so the
 * > choice is one function rather than a rewrite: {@link createTenantDatabase}
 * > below is the entire difference between the two models. Swapping to per-shop
 * > files means implementing that one port against
 * > `services/api/src/admin/tenantRouting.ts`, which is already written.
 *
 * ## Why the registry is still populated
 *
 * A shared database does not need a registry to find a shop. The rows are
 * written anyway, for three reasons: the console's tenant screen reads them, so
 * an operator can see every shop and its state; `provisionMerchant` uses the
 * primary key as its **lock**, which is what stops two operators approving one
 * application into two shops; and keeping the registry current is what leaves
 * the door to D103 open. A registry populated from day one can be walked to
 * split the file later. One reconstructed afterwards is archaeology.
 */

import type { ProvisioningPorts } from '@telga/api';
import type { ConsoleDb } from './server';

export interface ProvisioningPortsOptions {
  readonly db: ConsoleDb;
  readonly now: () => string;
  /** The schema version this database is on. Recorded per tenant. */
  readonly schemaVersion: string;
}

/**
 * The name a shop's data would live under.
 *
 * Under the shared model nothing opens it, but it is still derived and stored:
 * `databaseNameFor()` re-validates it on every routing decision, and a registry
 * row without one could not be routed if the model changed.
 */
export function consoleProvisioningPorts(options: ProvisioningPortsOptions): ProvisioningPorts {
  const { db, now, schemaVersion } = options;

  return {
    now,
    schemaVersion,

    /**
     * The lock. `INSERT` without `ON CONFLICT`, deliberately: a second approval
     * of the same application must **throw** on the primary key rather than
     * quietly updating the row somebody else just claimed. `provisionMerchant`
     * turns that throw into `ALREADY_PROVISIONED`, which is a refusal and not an
     * error — the shop exists, which is what was wanted.
     */
    claimRegistryRow: (record) => {
      db.prepare(
        `INSERT INTO tenant_registry
           (merchant_id, database_name, schema_version, status, created_at, updated_at)
         VALUES (?, ?, ?, 'PROVISIONING', ?, ?)`,
      ).run(record.merchantId, record.databaseName, record.schemaVersion, record.at, record.at);
    },

    setTenantStatus: (merchantId, status, at) => {
      db.prepare(`UPDATE tenant_registry SET status = ?, updated_at = ? WHERE merchant_id = ?`).run(
        status,
        at,
        merchantId,
      );
    },

    /**
     * **The one function that decides the storage model.**
     *
     * Under the shared model there is no file to create and no migration to
     * run: the shop's rows go into the database already open, which is already
     * at `schemaVersion`. So this reports the version it is on and creates
     * nothing.
     *
     * It is not a no-op by accident, and it must not become one by neglect. If
     * D103 is reinstated, this becomes: create the file, run `MIGRATIONS`
     * against it, return the version reached — and every other line in this
     * file and in `provisioning.ts` stays as it is.
     */
    createTenantDatabase: () => ({ schemaVersion }),

    /**
     * The merchant row.
     *
     * `merchants` carries `id`, `status` and `mode` only — there are no name
     * columns on it, and adding some would be a migration against a running
     * deployment. The legal name, trading name and locality stay on the
     * application row, which `linkApplication` ties to this merchant, so nothing
     * is lost and nothing is duplicated into a second place it could drift from.
     *
     * `mode` is `TRAINING` because the schema's `CHECK` constraint permits
     * nothing else. A live shop cannot be provisioned by this path even by
     * mistake.
     */
    writeMerchantRecord: (input) => {
      db.prepare(
        `INSERT INTO merchants (id, status, mode, created_at, updated_at)
         VALUES (?, 'ONBOARDING', 'TRAINING', ?, ?)`,
      ).run(input.merchantId, input.at, input.at);
    },

    /**
     * Bookkeeping, and the last step.
     *
     * The application moves to `DEVICE_PENDING`: the shop exists and has no
     * device yet, which is exactly what the lifecycle in `admin/applications.ts`
     * says comes next. It does **not** become `ACTIVE_TRAINING` here — that
     * needs an enrolled device and a first PIN, neither of which provisioning
     * creates.
     */
    linkApplication: (applicationId, merchantId, at) => {
      db.prepare(
        `UPDATE merchant_applications
            SET merchant_id = ?, status = 'DEVICE_PENDING', updated_at = ?
          WHERE id = ?`,
      ).run(merchantId, at, applicationId);
    },
  };
}
