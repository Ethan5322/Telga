/**
 * Top-up order rows — `CLAUDE.md` §20.1.
 *
 * This is where the founder's requirement is actually enforced: **however many
 * shops deposit the same amount at the same moment, every one of them quotes a
 * different reference.** Not because collisions are unlikely, but because the
 * database refuses one.
 */

import type { Db } from '../sqlite/connection';

export interface TopupOrderRow {
  id: string;
  method: string;
  provider_reference: string | null;
  provider_status: string | null;
  merchant_id: string;
  device_id: string;
  operator_id: string;
  reference: string;
  amount_minor: number;
  currency: string;
  status: 'OPEN' | 'PAID' | 'EXPIRED' | 'CANCELLED';
  funding_submission_id: string | null;
  correlation_id: string;
  mode: string;
  created_at: string;
  expires_at: string;
  updated_at: string;
}

/** SQLite's message when a `UNIQUE` index refuses a row. */
const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed/i.test(error.message);

export interface NewTopupOrder {
  readonly id: string;
  /**
   * How the shop chose to pay in — §20.2.
   *
   * Optional so every existing caller still compiles and still means what it
   * did: a slip carried to a bank counter.
   */
  readonly method?: 'BANK_COUNTER' | 'CHAPA';
  readonly merchantId: string;
  readonly deviceId: string;
  readonly operatorId: string;
  readonly amountMinor: number;
  readonly correlationId: string;
  readonly mode: 'TRAINING' | 'LIVE';
  readonly at: string;
  readonly expiresAt: string;
}

/**
 * How many fresh references to try before giving up.
 *
 * With ~1.1 × 10¹² codes and any realistic number of orders, the first draw
 * essentially always stands; a second is already astronomically unlikely. Five
 * exists so that a **bug** — a generator stuck returning one value, a clock or
 * entropy source failing — surfaces as a loud refusal instead of an infinite
 * loop holding a write transaction open.
 */
const REFERENCE_ATTEMPTS = 5;

export class ReferenceExhaustedError extends Error {
  readonly code = 'TOPUP_REFERENCE_EXHAUSTED';
  constructor() {
    super(
      `Could not draw an unused deposit reference in ${String(REFERENCE_ATTEMPTS)} attempts. ` +
        'This is not collision pressure at any plausible scale — suspect the generator.',
    );
  }
}

/**
 * Insert an order, drawing references until one is unused.
 *
 * ## Why the retry is here and not in the caller
 *
 * The uniqueness guarantee is *the index*. Asking "does this reference exist?"
 * and then inserting would be two statements with a gap between them, and two
 * tills printing at the same instant could both pass the check and then both
 * insert. The insert **is** the check: one of them fails, draws again, and
 * succeeds. Nothing is lost and nothing races.
 *
 * `newReference` is passed in rather than imported so this module stays free of
 * the domain package, and so a test can force a collision by handing it a
 * generator that repeats.
 *
 * Returns the reference that was actually stored — **normalised**, without the
 * display grouping, because that is the form everything compares against.
 */
export function saveTopupOrder(
  db: Db,
  input: NewTopupOrder,
  newReference: () => string,
  normalize: (raw: string) => string,
): string {
  const insert = db.prepare(
    `INSERT INTO topup_orders
       (id, merchant_id, device_id, operator_id, reference, amount_minor, currency,
        status, funding_submission_id, correlation_id, mode, method, created_at, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ETB', 'OPEN', NULL, ?, ?, ?, ?, ?, ?)`,
  );

  for (let attempt = 0; attempt < REFERENCE_ATTEMPTS; attempt += 1) {
    const reference = normalize(newReference());
    try {
      insert.run(
        input.id,
        input.merchantId,
        input.deviceId,
        input.operatorId,
        reference,
        input.amountMinor,
        input.correlationId,
        input.mode,
        input.method ?? 'BANK_COUNTER',
        input.at,
        input.expiresAt,
        input.at,
      );
      return reference;
    } catch (error) {
      // Only a duplicate reference is worth another draw. A foreign-key failure
      // or a CHECK violation is a real error and must not be retried into
      // silence.
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw new ReferenceExhaustedError();
}

/**
 * Whose reference is this?
 *
 * The lookup that makes a payment resolvable. It matches the **whole
 * reference** and nothing else — never the amount, never the date, never a
 * near match. §20.1: a reference that does not resolve goes to a person, and is
 * never rounded to the nearest shop.
 *
 * Every status is searched, including `EXPIRED`. A payment that arrives a day
 * late still belongs to the shop that ordered it; whether to credit it is a
 * decision for the funding rules, and they cannot make it if the reference has
 * already been thrown away.
 */
export const findTopupOrderByReference = (
  db: Db,
  reference: string,
): TopupOrderRow | undefined =>
  db.prepare(`SELECT * FROM topup_orders WHERE reference = ?`).get(reference) as
    | TopupOrderRow
    | undefined;

/**
 * The shop's live order **for one method**, if it has one.
 *
 * `OPEN` and not yet past its expiry. An order whose window has passed does not
 * block a new one — the shop is meant to start again, which is the whole reason
 * expiry exists.
 *
 * ## Why the method matters
 *
 * Reported from the deployment, 2026-09-12: *"Chapa payment button doesn't
 * process — when I enter an amount and confirm, it just asks me to enter the
 * amount again."*
 *
 * This originally matched on merchant alone, so **an unpaid bank slip blocked a
 * Chapa payment entirely**. The shop was refused with `ORDER_ALREADY_OPEN` and
 * bounced back to the amount screen.
 *
 * The one-at-a-time rule was written for §20.1 and is right *there*: two paper
 * slips is a shopkeeper at a bank counter guessing which reference to quote.
 * **It never applied across methods.** A slip in a pocket says nothing about
 * whether a shop may also pay by card, and the two settle by completely
 * separate paths.
 *
 * Omitting `method` keeps the old behaviour — any open order — which is what a
 * caller asking "is this shop waiting on anything" wants.
 */
export const findOpenTopupOrder = (
  db: Db,
  merchantId: string,
  nowIso: string,
  method?: 'BANK_COUNTER' | 'CHAPA',
): TopupOrderRow | undefined =>
  db
    .prepare(
      `SELECT * FROM topup_orders
        WHERE merchant_id = ? AND status = 'OPEN' AND expires_at > ?
          AND (? IS NULL OR method = ?)
        ORDER BY created_at DESC`,
    )
    .get(merchantId, nowIso, method ?? null, method ?? null) as TopupOrderRow | undefined;

/** A shop's own history, newest first. */
export const listTopupOrdersFor = (
  db: Db,
  merchantId: string,
  limit = 20,
): readonly TopupOrderRow[] =>
  db
    .prepare(
      `SELECT * FROM topup_orders WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(merchantId, limit) as TopupOrderRow[];

/**
 * Mark an order paid, naming the submission that credited it.
 *
 * `WHERE status = 'OPEN'` so a replayed settlement cannot re-mark a paid order
 * against a second submission. Returns rows changed: `0` means it was already
 * settled, which a caller should treat as "already done" rather than an error.
 *
 * **This does not move money.** The credit is `fundMerchant`'s balanced pair;
 * this only records which order the money answered.
 */
export function markTopupOrderPaid(
  db: Db,
  input: { readonly reference: string; readonly fundingSubmissionId: string; readonly at: string },
): number {
  return db
    .prepare(
      `UPDATE topup_orders
          SET status = 'PAID', funding_submission_id = ?, updated_at = ?
        WHERE reference = ? AND status = 'OPEN'`,
    )
    .run(input.fundingSubmissionId, input.at, input.reference).changes;
}

/**
 * Claim an order for settlement, **without** naming the submission yet.
 *
 * ## Why this is separate from {@link markTopupOrderPaid}
 *
 * `funding_submission_id` is a real foreign key, so an order cannot name a
 * submission before that submission exists. But the status update is the only
 * operation that reads and writes atomically, which makes it the only thing
 * that can decide a race between two concurrent settlements.
 *
 * Those two facts pull in opposite directions: the lock has to come first, and
 * the link cannot. So they are separated — claim, insert, then
 * {@link linkTopupOrderSubmission}.
 *
 * Returns `1` for the caller that won the claim and `0` for everyone else.
 * Losing is not an error: it means the payment was settled by another delivery
 * of the same webhook, which Chapa sends as a matter of course.
 */
export const claimTopupOrderForSettlement = (db: Db, reference: string, at: string): number =>
  db
    .prepare(
      `UPDATE topup_orders SET status = 'PAID', updated_at = ?
        WHERE reference = ? AND status = 'OPEN'`,
    )
    .run(at, reference).changes;

/** Name the submission that settled it, once that submission exists. */
export const linkTopupOrderSubmission = (
  db: Db,
  reference: string,
  fundingSubmissionId: string,
  at: string,
): number =>
  db
    .prepare(
      `UPDATE topup_orders SET funding_submission_id = ?, updated_at = ?
        WHERE reference = ? AND funding_submission_id IS NULL`,
    )
    .run(fundingSubmissionId, at, reference).changes;

/** The shop abandoned it before paying. */
export const cancelTopupOrder = (db: Db, id: string, at: string): number =>
  db
    .prepare(
      `UPDATE topup_orders SET status = 'CANCELLED', updated_at = ? WHERE id = ? AND status = 'OPEN'`,
    )
    .run(at, id).changes;

/**
 * Close out slips whose window has passed.
 *
 * A sweep rather than a read-time computation, so an operations desk can see
 * how many slips went unpaid. **The reference is not released** — it stays on
 * the row forever, so a late payment quoting it still resolves.
 */
export const expireTopupOrders = (db: Db, nowIso: string): number =>
  db
    .prepare(
      `UPDATE topup_orders SET status = 'EXPIRED', updated_at = ?
        WHERE status = 'OPEN' AND expires_at <= ?`,
    )
    .run(nowIso, nowIso).changes;

/**
 * Record what the payment provider last told us about an order — §20.2.
 *
 * **Evidence, not authority.** An operations desk asking *"why is this order
 * still open"* should be able to read the answer rather than call the gateway
 * again. Nothing credits from this column: §20.2 credits only on a fresh
 * server-to-server verification, and a stored status is a record of a
 * conversation that has already ended.
 */
export function recordTopupProviderOutcome(
  db: Db,
  input: {
    readonly reference: string;
    readonly providerReference: string;
    readonly providerStatus: string;
    readonly at: string;
  },
): number {
  return db
    .prepare(
      `UPDATE topup_orders
          SET provider_reference = ?, provider_status = ?, updated_at = ?
        WHERE reference = ?`,
    )
    .run(input.providerReference, input.providerStatus, input.at, input.reference).changes;
}
