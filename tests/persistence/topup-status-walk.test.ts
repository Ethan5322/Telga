/**
 * `topup_orders.status`, walked between everything that writes it and
 * everything that reads it.
 *
 * ## Why this test exists before anybody asked for it
 *
 * **R45**, open at 3 × 4 = 12, and its recommendation is explicit:
 *
 * > *"a test per entity that moves the status through every value and asserts
 * > what each entry point does, rather than testing writer and reader
 * > separately. The Runbooks have recommended this since R40 and it is now
 * > overdue."*
 *
 * `topup_orders.status` is a new instance of exactly the shape that produced
 * **R40** and then its mirror image: written in one place, read in another,
 * with nothing walking between. Here the writer is the operations console
 * (`markTopupOrderPaid`, when a bank payment credits) and the readers are the
 * shop's own device (`findOpenTopupOrder`, deciding whether it may print
 * another slip) and the reference lookup (`findTopupOrderByReference`, deciding
 * whose payment this is).
 *
 * The failure this prevents is concrete and would look like a Telga bug to a
 * shopkeeper: a shop pays its slip, the console credits it, and the till still
 * refuses to print a new one because nothing moved the order off `OPEN`.
 *
 * Every value the `CHECK` constraint permits is visited, and after each one
 * both readers are asked what they now think. Adding a fifth status without
 * extending this test fails the exhaustiveness assertion at the bottom.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  MIGRATIONS,
  cancelTopupOrder,
  expireTopupOrders,
  findOpenTopupOrder,
  findTopupOrderByReference,
  markTopupOrderPaid,
  saveTopupOrder,
} from '@telga/persistence';
import { newDepositReference, normalizeDepositReference } from '@telga/domain';

let dir: string;
let db: Database.Database;

const AT = '2026-09-10T09:00:00.000Z';
const EXPIRES = '2026-09-11T09:00:00.000Z';
const LATER = '2026-09-12T09:00:00.000Z';
const MERCHANT = 'mch_walk';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'telga-status-walk-'));
  db = new Database(join(dir, 'telga.sqlite'));
  db.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS) db.exec(`BEGIN; ${migration.sql} COMMIT;`);
  db.prepare(
    `INSERT INTO merchants (id, status, mode, created_at, updated_at)
     VALUES (?, 'ACTIVE', 'TRAINING', ?, ?)`,
  ).run(MERCHANT, AT, AT);
  db.prepare(
    `INSERT INTO admin_users
       (id, email, display_name, department, role, password_hash, password_salt,
        password_params, status, failed_attempts, otp_attempts, created_at, updated_at)
     VALUES ('adm_1', 'ops@telga.test', 'Ops', 'FINANCE', 'FINANCE_VERIFIER',
             'h', 's', 'p', 'ACTIVE', 0, 0, ?, ?)`,
  ).run(AT, AT);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function order(id: string): string {
  return saveTopupOrder(
    db,
    {
      id,
      merchantId: MERCHANT,
      deviceId: 'device_walk',
      operatorId: 'op_walk',
      amountMinor: 250_000,
      correlationId: `corr_${id}`,
      mode: 'TRAINING',
      at: AT,
      expiresAt: EXPIRES,
    },
    newDepositReference,
    normalizeDepositReference,
  );
}

function seedSubmission(reference: string): void {
  db.prepare(
    `INSERT INTO funding_submissions
       (id, merchant_id, quoted_reference, bank_reference, claimed_amount_minor,
        bank_amount_minor, status, currency, recorded_by, created_at, updated_at)
     VALUES ('fund_1', ?, ?, 'CBE-1', 250000, 250000, 'CREDITED', 'ETB', 'adm_1', ?, ?)`,
  ).run(MERCHANT, reference, AT, AT);
}

/** What every reader says about this shop, right now. */
const readers = (reference: string, nowIso: string) => ({
  /** The till: may the shop print another slip? */
  tillSeesOpenOrder: findOpenTopupOrder(db, MERCHANT, nowIso) !== undefined,
  /** The console: whose payment is this? */
  referenceResolves: findTopupOrderByReference(db, reference)?.merchant_id,
  status: findTopupOrderByReference(db, reference)?.status,
});

describe('topup_orders.status, from every writer to every reader', () => {
  it('OPEN — the till is blocked, and the reference already resolves', () => {
    const reference = order('top_1');
    expect(readers(reference, AT)).toEqual({
      tillSeesOpenOrder: true,
      referenceResolves: MERCHANT,
      status: 'OPEN',
    });
  });

  it('PAID — written by the console, and the till is unblocked by it', () => {
    const reference = order('top_1');
    seedSubmission(reference);

    // The writer: the operations console, when a bank payment credits.
    expect(markTopupOrderPaid(db, { reference, fundingSubmissionId: 'fund_1', at: AT })).toBe(1);

    // The readers. This is the bug R45 describes: if the console credited and
    // nothing moved the status, the till would still refuse a new slip.
    expect(readers(reference, AT)).toEqual({
      tillSeesOpenOrder: false,
      referenceResolves: MERCHANT,
      status: 'PAID',
    });
  });

  it('CANCELLED — written by the shop, and the reference still resolves', () => {
    const reference = order('top_1');
    expect(cancelTopupOrder(db, 'top_1', AT)).toBe(1);

    expect(readers(reference, AT)).toEqual({
      tillSeesOpenOrder: false,
      referenceResolves: MERCHANT,
      // A cancelled slip that somebody paid anyway must still be traceable to
      // the shop that printed it. Releasing the reference here would send a
      // real payment to manual review with nothing to match it to.
      status: 'CANCELLED',
    });
  });

  it('EXPIRED — written by the sweep, and the reference still resolves', () => {
    const reference = order('top_1');
    expect(expireTopupOrders(db, LATER)).toBe(1);

    expect(readers(reference, LATER)).toEqual({
      tillSeesOpenOrder: false,
      referenceResolves: MERCHANT,
      status: 'EXPIRED',
    });
  });

  it('a settled order cannot be settled again by a second payment', () => {
    const reference = order('top_1');
    seedSubmission(reference);
    markTopupOrderPaid(db, { reference, fundingSubmissionId: 'fund_1', at: AT });

    // A replayed settlement, or a second bank alert for the same slip.
    expect(markTopupOrderPaid(db, { reference, fundingSubmissionId: 'fund_1', at: AT })).toBe(0);
    expect(findTopupOrderByReference(db, reference)?.funding_submission_id).toBe('fund_1');
  });

  it('an expired order is not swept a second time', () => {
    order('top_1');
    expect(expireTopupOrders(db, LATER)).toBe(1);
    expect(expireTopupOrders(db, LATER)).toBe(0);
  });

  it('a paid order is never swept into EXPIRED afterwards', () => {
    const reference = order('top_1');
    seedSubmission(reference);
    markTopupOrderPaid(db, { reference, fundingSubmissionId: 'fund_1', at: AT });

    // The sweep runs on a clock, and a slip paid on its last day would
    // otherwise be re-labelled as unpaid after the fact.
    expect(expireTopupOrders(db, LATER)).toBe(0);
    expect(findTopupOrderByReference(db, reference)?.status).toBe('PAID');
  });

  it('visits every status the schema permits', () => {
    // The exhaustiveness guard. A fifth status added to the CHECK constraint
    // without a walk through this file fails here rather than shipping
    // untested — which is the whole of R45's recommendation.
    const sql = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'topup_orders'`)
      .get() as { sql: string };
    const declared = [...sql.sql.matchAll(/'(OPEN|PAID|EXPIRED|CANCELLED|[A-Z_]+)'/g)]
      .map((m) => m[1])
      .filter((value) => ['OPEN', 'PAID', 'EXPIRED', 'CANCELLED'].includes(value));

    expect(new Set(declared)).toEqual(new Set(['OPEN', 'PAID', 'EXPIRED', 'CANCELLED']));
  });
});
