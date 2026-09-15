/**
 * The monthly software fee — charging it, and not charging it twice.
 *
 * Founder instruction, 2026-09-14: ETB 1,250 at every month end, from every
 * shop, whoever owns the hardware, taken from the selling balance without a
 * prompt, and visible on the Telga Vending statement.
 *
 * ## The two ways this goes wrong, and what stops each
 *
 * **Charging twice.** A worker restarted mid-run, a month-end job that fired on
 * two instances, or an administrator re-running it by hand. Each takes 1,250
 * birr from a shop that owes 1,250 birr. The unique index on
 * `(merchant_id, period)` refuses the second insert, and the insert happens in
 * the same transaction as the ledger posting — so a charge row and its debit
 * exist together or neither exists.
 *
 * **Overdrawing.** Section 20 is unambiguous: *"No overdraft."* A shop with 400
 * birr cannot be taken 1,250, because a negative selling balance is Telga
 * lending money, which section 2 keeps switched off until an authorised
 * structure exists. So the fee is charged only when the available balance
 * covers it in full; otherwise the charge is recorded as `ARREARS` — due,
 * visible, and collected the moment the shop has the balance.
 *
 * Partial collection is deliberately **not** done. Taking 400 of 1,250 leaves a
 * shop unable to sell anything and still owing 850, which is the worst of both
 * answers for a shop and for Telga.
 */

import type { MerchantId, Timestamp } from '@telga/domain';
import type { Db } from '../sqlite/connection';

/** ETB 1,250, in santim. The founder's figure. */
export const DEFAULT_SOFTWARE_FEE_MINOR = 125_000;

export type SoftwareFeeStatus = 'PAID' | 'ARREARS' | 'WAIVED';

export interface SoftwareFeeCharge {
  readonly id: string;
  readonly merchantId: string;
  readonly period: string;
  readonly amountMinor: number;
  readonly status: SoftwareFeeStatus;
  readonly postingId: string | null;
  readonly chargedAt: string | null;
  readonly createdAt: string;
}

/**
 * The period a timestamp falls in, as `YYYY-MM`.
 *
 * Taken from the ISO string rather than a `Date`, because a `Date` carries the
 * host's timezone and a month-end job run at 23:30 in Addis Ababa would
 * otherwise be charged to the wrong month on a server running UTC. Every
 * timestamp in this system is already a UTC ISO string; slicing it keeps one
 * answer.
 */
export function periodOf(at: Timestamp | string): string {
  return String(at).slice(0, 7);
}

/** The last calendar day of a period, as `YYYY-MM-DD`. */
export function periodEnd(period: string): string {
  const [year, month] = period.split('-').map(Number);
  // Day 0 of the next month is the last day of this one, and `Date.UTC` keeps
  // it in UTC rather than the host's zone.
  const last = new Date(Date.UTC(year, month, 0));
  return last.toISOString().slice(0, 10);
}

const rowToCharge = (r: {
  id: string;
  merchant_id: string;
  period: string;
  amount_minor: number;
  status: SoftwareFeeStatus;
  posting_id: string | null;
  charged_at: string | null;
  created_at: string;
}): SoftwareFeeCharge => ({
  id: r.id,
  merchantId: r.merchant_id,
  period: r.period,
  amountMinor: r.amount_minor,
  status: r.status,
  postingId: r.posting_id,
  chargedAt: r.charged_at,
  createdAt: r.created_at,
});

/**
 * Record a charge that was paid, or one that could not be.
 *
 * The **posting** lives in `operations.ts` alongside every other thing that
 * moves money, and calls these. Splitting it that way is not tidiness: the
 * ledger's account ids and the `ensureAccounts` bootstrap live there, and a
 * second place that writes `ledger_entries` by hand is a second place that can
 * get the account type wrong — which is exactly what the first draft of this
 * file did.
 */
export function insertPaidCharge(
  db: Db,
  input: {
    readonly id: string;
    readonly merchantId: MerchantId;
    readonly period: string;
    readonly amountMinor: number;
    readonly postingId: string;
    readonly at: Timestamp;
  },
): void {
  db.prepare(
    `INSERT INTO software_fee_charges
       (id, merchant_id, period, amount_minor, status, posting_id, charged_at, created_at)
     VALUES (?, ?, ?, ?, 'PAID', ?, ?, ?)
     ON CONFLICT (merchant_id, period) DO UPDATE
       SET status = 'PAID', posting_id = excluded.posting_id, charged_at = excluded.charged_at
       WHERE software_fee_charges.status = 'ARREARS'`,
  ).run(
    input.id,
    input.merchantId,
    input.period,
    input.amountMinor,
    input.postingId,
    input.at,
    input.at,
  );
}

/** Record that a fee was due and could not be taken. Moves no money. */
export function insertArrears(
  db: Db,
  input: {
    readonly id: string;
    readonly merchantId: MerchantId;
    readonly period: string;
    readonly amountMinor: number;
    readonly at: Timestamp;
  },
): void {
  db.prepare(
    `INSERT INTO software_fee_charges
       (id, merchant_id, period, amount_minor, status, created_at)
     VALUES (?, ?, ?, ?, 'ARREARS', ?)
     ON CONFLICT (merchant_id, period) DO NOTHING`,
  ).run(input.id, input.merchantId, input.period, input.amountMinor, input.at);
}

/** Every unpaid charge, oldest first: what Telga is owed. */
export function outstandingCharges(db: Db, merchantId?: MerchantId): readonly SoftwareFeeCharge[] {
  const rows =
    merchantId === undefined
      ? (db
          .prepare(
            `SELECT * FROM software_fee_charges WHERE status = 'ARREARS' ORDER BY period, merchant_id`,
          )
          .all() as Parameters<typeof rowToCharge>[0][])
      : (db
          .prepare(
            `SELECT * FROM software_fee_charges
              WHERE status = 'ARREARS' AND merchant_id = ? ORDER BY period`,
          )
          .all(merchantId) as Parameters<typeof rowToCharge>[0][]);
  return rows.map(rowToCharge);
}

/** One shop's charge history, newest first — what the statement reads. */
export function chargesFor(
  db: Db,
  merchantId: MerchantId,
  range?: { readonly from?: string; readonly to?: string },
): readonly SoftwareFeeCharge[] {
  const rows = db
    .prepare(
      `SELECT * FROM software_fee_charges
        WHERE merchant_id = @merchantId
          AND (@from IS NULL OR period >= @from)
          AND (@to   IS NULL OR period <= @to)
        ORDER BY period DESC`,
    )
    .all({
      merchantId,
      from: range?.from === undefined ? null : range.from.slice(0, 7),
      to: range?.to === undefined ? null : range.to.slice(0, 7),
    }) as Parameters<typeof rowToCharge>[0][];
  return rows.map(rowToCharge);
}

export function findCharge(
  db: Db,
  merchantId: MerchantId,
  period: string,
): SoftwareFeeCharge | undefined {
  const row = db
    .prepare(`SELECT * FROM software_fee_charges WHERE merchant_id = ? AND period = ?`)
    .get(merchantId, period) as Parameters<typeof rowToCharge>[0] | undefined;
  return row === undefined ? undefined : rowToCharge(row);
}

/**
 * Cancel an unpaid charge.
 *
 * A reason is required by this function rather than by the schema: a waiver
 * with no reason is a fee that vanished, and the next person to reconcile has
 * no way to tell it from a bug. A `PAID` charge cannot be waived — migration
 * 024 refuses it — because money that moved is corrected by an adjustment
 * entry, never by editing the record of it (section 13, invariant 8).
 */
export function waiveCharge(
  db: Db,
  input: {
    readonly merchantId: MerchantId;
    readonly period: string;
    readonly reason: string;
    readonly adminId: string;
  },
): boolean {
  if (input.reason.trim() === '') return false;
  const result = db
    .prepare(
      `UPDATE software_fee_charges
          SET status = 'WAIVED', waived_reason = ?, waived_by_admin_id = ?
        WHERE merchant_id = ? AND period = ? AND status = 'ARREARS'`,
    )
    .run(input.reason, input.adminId, input.merchantId, input.period);
  return result.changes > 0;
}
