/**
 * Top-up orders, and the one property the founder asked for by name.
 *
 * > *"Even more than 1000+ people deposit the same amount of money at the same
 * > time, the reference unique number provided is not the same — so all persons
 * > that deposited have their own unique number, no matter how many people
 * > deposited the same amount. The unique number is connected to shop
 * > identity."*
 *
 * That is two claims, and they are tested separately because they can fail
 * separately:
 *
 * 1. **Every order gets a different reference**, regardless of amount.
 * 2. **A reference resolves to exactly one shop** — never to a second, never to
 *    a near match, never guessed from the amount.
 *
 * The second is the one that costs money if it breaks. Crediting nobody is an
 * annoyance; crediting the *wrong shop* is somebody else's deposit spent.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '@telga/persistence';
import {
  ReferenceExhaustedError,
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'telga-topup-'));
  db = new Database(join(dir, 'telga.sqlite'));
  db.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS) db.exec(`BEGIN; ${migration.sql} COMMIT;`);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A shop, because `merchant_id` is a real foreign key. */
function seedShop(id: string): void {
  db.prepare(
    `INSERT INTO merchants (id, status, mode, created_at, updated_at)
     VALUES (?, 'ACTIVE', 'TRAINING', ?, ?)`,
  ).run(id, AT, AT);
}

/**
 * Seed many shops in **one** transaction.
 *
 * A thousand separate inserts is a thousand commits, and this suite writes to a
 * real file because `Testing Strategy` refuses `:memory:` — so each one is a
 * flush. That is what made the first version of the thousand-shop test exceed
 * the 30-second budget, and the vault is explicit that the budget is not the
 * thing to change: *"a test that needs more time than this has a defect rather
 * than a deadline problem."* The defect was here.
 */
function seedShops(ids: readonly string[]): void {
  const insert = db.prepare(
    `INSERT INTO merchants (id, status, mode, created_at, updated_at)
     VALUES (?, 'ACTIVE', 'TRAINING', ?, ?)`,
  );
  db.transaction(() => {
    for (const id of ids) insert.run(id, AT, AT);
  })();
}

/** An operations admin, because `funding_submissions.recorded_by` is a real FK. */
function seedAdmin(id: string): void {
  db.prepare(
    `INSERT INTO admin_users
       (id, email, display_name, department, role, password_hash, password_salt,
        password_params, status, failed_attempts, otp_attempts, created_at, updated_at)
     VALUES (?, ?, 'Ops', 'FINANCE', 'FINANCE_VERIFIER', 'h', 's', 'p', 'ACTIVE', 0, 0, ?, ?)`,
  ).run(id, `${id}@telga.test`, AT, AT);
}

const order = (merchantId: string, amountMinor: number, seq: number): string =>
  saveTopupOrder(
    db,
    {
      id: `top_${merchantId}_${String(seq)}`,
      merchantId,
      deviceId: `device_${merchantId}`,
      operatorId: `op_${merchantId}`,
      amountMinor,
      correlationId: `corr_${String(seq)}`,
      mode: 'TRAINING',
      at: AT,
      expiresAt: EXPIRES,
    },
    newDepositReference,
    normalizeDepositReference,
  );

describe('a thousand shops depositing the identical amount', () => {
  it('gives every one of them a different reference', () => {
    const SHOPS = 1000;
    const SAME_AMOUNT = 250_000; // 2,500.00 ETB — the same figure for all of them

    const ids = Array.from({ length: SHOPS }, (_, i) => `mch_${String(i).padStart(4, '0')}`);
    seedShops(ids);

    const references: string[] = [];
    db.transaction(() => {
      ids.forEach((id, i) => references.push(order(id, SAME_AMOUNT, i)));
    })();

    expect(references).toHaveLength(SHOPS);
    // The property, stated directly: no repeats.
    expect(new Set(references).size).toBe(SHOPS);
  });

  it('resolves each reference back to its own shop and nobody else', () => {
    const SAME_AMOUNT = 250_000;
    const issued = new Map<string, string>();

    const ids = Array.from({ length: 200 }, (_, i) => `mch_${String(i).padStart(4, '0')}`);
    seedShops(ids);
    db.transaction(() => {
      ids.forEach((id, i) => issued.set(order(id, SAME_AMOUNT, i), id));
    })();

    for (const [reference, merchantId] of issued) {
      const found = findTopupOrderByReference(db, reference);
      expect(found?.merchant_id).toBe(merchantId);
      // Identical amounts throughout, so the amount cannot have been what
      // distinguished them.
      expect(found?.amount_minor).toBe(SAME_AMOUNT);
    }
  });

  it('does not resolve a reference nobody was issued', () => {
    seedShop('mch_solo');
    order('mch_solo', 250_000, 1);
    // Well-formed but never issued: the store answers "no", not "closest shop".
    expect(findTopupOrderByReference(db, normalizeDepositReference(newDepositReference()))).toBeUndefined();
  });
});

describe('the database, not the generator, is what guarantees uniqueness', () => {
  it('draws again when a generator hands back one already in use', () => {
    seedShop('mch_a');
    seedShop('mch_b');

    const first = normalizeDepositReference(newDepositReference());
    const second = normalizeDepositReference(newDepositReference());
    let call = 0;
    // Returns the same reference twice, then a fresh one — exactly the
    // collision the UNIQUE index exists to absorb.
    const repeats = (): string => {
      call += 1;
      return call <= 2 ? first : second;
    };

    // The first order must be inserted through the *same* repeating generator,
    // otherwise nothing occupies `first` and there is no collision to absorb.
    // The earlier version used the real generator here and then asserted the
    // row carried `first` — it never did, and the test was measuring nothing.
    const a = saveTopupOrder(
      db,
      {
        id: 'top_a',
        merchantId: 'mch_a',
        deviceId: 'device_a',
        operatorId: 'op_a',
        amountMinor: 100_000,
        correlationId: 'corr_a',
        mode: 'TRAINING',
        at: AT,
        expiresAt: EXPIRES,
      },
      repeats,
      normalizeDepositReference,
    );
    expect(a).toBe(first);

    const b = saveTopupOrder(
      db,
      {
        id: 'top_b',
        merchantId: 'mch_b',
        deviceId: 'device_b',
        operatorId: 'op_b',
        amountMinor: 100_000,
        correlationId: 'corr_b',
        mode: 'TRAINING',
        at: AT,
        expiresAt: EXPIRES,
      },
      repeats,
      normalizeDepositReference,
    );

    expect(b).toBe(second);
    expect(b).not.toBe(a);
  });

  it('refuses loudly rather than looping when the generator is broken', () => {
    seedShop('mch_a');
    seedShop('mch_b');
    const stuck = normalizeDepositReference(newDepositReference());

    // Occupy the reference with the same stuck generator, so the second insert
    // genuinely collides every time.
    saveTopupOrder(
      db,
      {
        id: 'top_first',
        merchantId: 'mch_a',
        deviceId: 'device_a',
        operatorId: 'op_a',
        amountMinor: 100_000,
        correlationId: 'corr_first',
        mode: 'TRAINING',
        at: AT,
        expiresAt: EXPIRES,
      },
      () => stuck,
      normalizeDepositReference,
    );
    // A generator that only ever returns one value is a bug, not collision
    // pressure. It must surface, not spin.
    expect(() =>
      saveTopupOrder(
        db,
        {
          id: 'top_stuck',
          merchantId: 'mch_b',
          deviceId: 'device_b',
          operatorId: 'op_b',
          amountMinor: 100_000,
          correlationId: 'corr_stuck',
          mode: 'TRAINING',
          at: AT,
          expiresAt: EXPIRES,
        },
        () => stuck,
        normalizeDepositReference,
      ),
    ).toThrow(ReferenceExhaustedError);
  });

  it('does not retry a failure that is not a duplicate reference', () => {
    // No shop seeded, so the foreign key refuses. Retrying that would hide a
    // real error behind five identical attempts.
    expect(() => order('mch_missing', 100_000, 1)).toThrow(/FOREIGN KEY/i);
  });

  it('stores the normalised form, so a hyphenated slip matches a typed code', () => {
    seedShop('mch_a');
    const reference = order('mch_a', 100_000, 1);
    expect(reference).not.toContain('-');
    // What a teller reads off the slip, grouped, lower case and spaced.
    const asTyped = `${reference.slice(0, 3)}-${reference.slice(3, 6)}-${reference.slice(6)}`.toLowerCase();
    expect(findTopupOrderByReference(db, normalizeDepositReference(asTyped))?.merchant_id).toBe('mch_a');
  });
});

describe('one slip at a time', () => {
  it('reports the open order, and stops reporting it once cancelled', () => {
    seedShop('mch_a');
    order('mch_a', 100_000, 1);

    expect(findOpenTopupOrder(db, 'mch_a', AT)).toBeDefined();
    cancelTopupOrder(db, 'top_mch_a_1', AT);
    expect(findOpenTopupOrder(db, 'mch_a', AT)).toBeUndefined();
  });

  it('stops blocking once the window has passed', () => {
    seedShop('mch_a');
    order('mch_a', 100_000, 1);

    expect(findOpenTopupOrder(db, 'mch_a', AT)).toBeDefined();
    // A day later the slip is stale and the shop may print another.
    expect(findOpenTopupOrder(db, 'mch_a', '2026-09-12T09:00:00.000Z')).toBeUndefined();
  });

  it('sweeps expired orders but never releases their references', () => {
    seedShop('mch_a');
    const reference = order('mch_a', 100_000, 1);

    expect(expireTopupOrders(db, '2026-09-12T09:00:00.000Z')).toBe(1);

    const found = findTopupOrderByReference(db, reference);
    expect(found?.status).toBe('EXPIRED');
    // The point: a payment arriving late still resolves to the shop that
    // ordered it.
    expect(found?.merchant_id).toBe('mch_a');
  });
});

describe('settling an order', () => {
  it('marks it paid once, and names the submission that credited it', () => {
    seedShop('mch_a');
    seedAdmin('adm_1');
    const reference = order('mch_a', 100_000, 1);
    db.prepare(
      `INSERT INTO funding_submissions
         (id, merchant_id, quoted_reference, bank_reference, claimed_amount_minor,
          bank_amount_minor, status, currency, recorded_by, created_at, updated_at)
       VALUES ('fund_1', 'mch_a', ?, 'CBE-1', 100000, 100000, 'CREDITED', 'ETB', 'adm_1', ?, ?)`,
    ).run(reference, AT, AT);

    expect(markTopupOrderPaid(db, { reference, fundingSubmissionId: 'fund_1', at: AT })).toBe(1);
    expect(findTopupOrderByReference(db, reference)).toMatchObject({
      status: 'PAID',
      funding_submission_id: 'fund_1',
    });

    // A replayed settlement changes nothing — "already done", not an error.
    expect(markTopupOrderPaid(db, { reference, fundingSubmissionId: 'fund_1', at: AT })).toBe(0);
  });

  it('creates no ledger entry — the slip is not money', () => {
    seedShop('mch_a');
    order('mch_a', 100_000, 1);
    const entries = db.prepare(`SELECT COUNT(*) AS n FROM ledger_entries`).get() as { n: number };
    expect(entries.n).toBe(0);
  });
});
