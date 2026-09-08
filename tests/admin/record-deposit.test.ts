/**
 * A deposit arrives, and the right shop's balance goes up.
 *
 * **M3.** `fundingSubmission.ts` decides (D119) and this joins the decision to
 * the ledger and to a record of why. The tests are weighted towards the two
 * things that would be worst to get wrong: crediting the **wrong** shop, and
 * crediting **twice**.
 *
 * The ledger here is a real `SqliteLedgerDriver` over the same file, and
 * balances are read with `balanceFor` — the same function the POS shows an
 * operator. A test that asserted rows rather than balances could pass while a
 * shop's screen said something else.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, SqliteLedgerDriver, fundMerchant, runMigrations } from '@telga/persistence';
import { depositLookupFor, recordDeposit } from '@telga/api';
import type { DepositPorts } from '@telga/api';
import { fromBirr, postingId as toPostingId } from '@telga/domain';
import type { BankRecord, MerchantId } from '@telga/domain';

const AT = '2026-09-08T09:00:00.000Z';
const ACCOUNT = '1000123456789';
const CAP = 5_000_000; // 50,000 birr

let dir: string;
let driver: SqliteLedgerDriver;
let db: Database.Database;
let seq = 0;

/** Two shops, each with its own device key. */
const KEY_A = 'AAAAdevicekeyforshopalpha_0000000000000000A';
const KEY_B = 'BBBBdevicekeyforshopbeta__0000000000000000B';

function seedShop(merchantId: string, deviceId: string, key: string): void {
  db.prepare(
    `INSERT INTO merchants (id, status, mode, created_at, updated_at)
     VALUES (?, 'ACTIVE', 'TRAINING', ?, ?)`,
  ).run(merchantId, AT, AT);
  db.prepare(
    `INSERT INTO devices (id, merchant_id, status, device_type, created_at, updated_at)
     VALUES (?, ?, 'ACTIVE', 'SMART_POS', ?, ?)`,
  ).run(deviceId, merchantId, AT, AT);
  db.prepare(
    `INSERT INTO device_enrollments
       (device_id, merchant_id, enrollment_state, secret_hash, secret_salt,
        deposit_lookup, enrolled_at, created_at, updated_at)
     VALUES (?, ?, 'ENROLLED', 'hash', 'salt', ?, ?, ?, ?)`,
  ).run(deviceId, merchantId, depositLookupFor(key), AT, AT, AT);
}

const ports = (recordedBy = 'ops'): DepositPorts => ({
  now: () => AT,
  newId: (prefix) => `${prefix}_${String(++seq)}`,
  merchantForReference: (lookup) =>
    (
      db
        .prepare(`SELECT merchant_id FROM device_enrollments WHERE deposit_lookup = ?`)
        .get(lookup) as { merchant_id: string } | undefined
    )?.merchant_id,
  alreadyCredited: (bankReference) =>
    db
      .prepare(`SELECT 1 FROM funding_submissions WHERE bank_reference = ? AND status = 'CREDITED'`)
      .get(bankReference) !== undefined,
  insertSubmission: (row) => {
    db.prepare(
      `INSERT INTO funding_submissions
         (id, merchant_id, quoted_reference, bank_reference, claimed_amount_minor,
          bank_amount_minor, status, outcome_reason, evidence, currency,
          recorded_by, decided_by, decided_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ETB', NULL, NULL, ?, ?, ?)`,
    ).run(
      row.id,
      row.merchantId,
      row.quotedReference,
      row.bankReference,
      row.claimedAmountMinor,
      row.bankAmountMinor,
      row.status,
      row.outcomeReason,
      row.evidence,
      row.at,
      row.at,
      row.at,
    );
  },
  creditMerchant: (input) => {
    fundMerchant(driver, {
      merchantId: input.merchantId as MerchantId,
      amount: fromBirr(input.amountMinor / 100),
      at: input.at as never,
      correlationId: input.correlationId,
      postingId: toPostingId(input.postingId),
    });
  },
  linkPosting: (submissionId, postingId, at) => {
    db.prepare(`UPDATE funding_submissions SET posting_id = ?, updated_at = ? WHERE id = ?`).run(
      postingId,
      at,
      submissionId,
    );
  },
  ...(recordedBy === '' ? {} : {}),
});

const bank = (over: Partial<BankRecord> = {}): BankRecord => ({
  bankReference: 'FT26090812345',
  amountMinor: 100_000, // 1,000 birr
  creditedAccount: ACCOUNT,
  ...over,
});

const deposit = (
  key: string,
  over: { bankRecord?: BankRecord | undefined; bankReference?: string } = {},
) =>
  recordDeposit(ports(), {
    quotedReference: key,
    bankReference: over.bankReference ?? 'FT26090812345',
    bankRecord: 'bankRecord' in over ? over.bankRecord : bank({ bankReference: over.bankReference ?? 'FT26090812345' }),
    expectedAccount: ACCOUNT,
    autoCreditCapMinor: CAP,
    recordedBy: 'ops',
  });

const availableBirr = (merchantId: string): number =>
  driver.balanceFor(merchantId as MerchantId).available.minor / 100;

const submissions = (): Record<string, unknown>[] =>
  db.prepare(`SELECT * FROM funding_submissions`).all() as Record<string, unknown>[];

beforeEach(() => {
  seq = 0;
  dir = mkdtempSync(join(tmpdir(), 'telga-deposit-'));
  driver = new SqliteLedgerDriver({ file: join(dir, 'telga.sqlite') });
  runMigrations(driver.unsafeConnection, AT, MIGRATIONS);
  db = driver.unsafeConnection;
  seedShop('merchant_alpha', 'device_0001', KEY_A);
  seedShop('merchant_beta', 'device_0002', KEY_B);
  // Two admins, because `decided_by` and `approved_by` are foreign keys and the
  // separation-of-duties tests need two real people to be different.
  for (const id of ['ops', 'finance']) {
    db.prepare(
      `INSERT INTO admin_users
         (id, email, display_name, department, role, password_hash, password_salt,
          password_params, status, created_at, updated_at)
       VALUES (?, ?, ?, 'PLATFORM', 'OPERATIONS_ADMIN', 'h', 's', 'p', 'ACTIVE', ?, ?)`,
    ).run(id, `${id}@telga.example`, id, AT, AT);
  }
});

afterEach(() => {
  driver.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a verified deposit credits the shop that quoted the reference', () => {
  it('credits that shop, and only that shop', async () => {
    const before = availableBirr('merchant_beta');
    const outcome = deposit(KEY_A);

    expect(outcome.decision.kind).toBe('CREDIT');
    expect(availableBirr('merchant_alpha')).toBe(1_000);
    // The neighbour did not move.
    expect(availableBirr('merchant_beta')).toBe(before);
    expect(availableBirr('merchant_beta')).toBe(0);
  });

  it('records the deposit and links it to the posting that moved the money', async () => {
    const outcome = deposit(KEY_A);
    const row = submissions()[0];

    expect(row).toMatchObject({
      merchant_id: 'merchant_alpha',
      bank_reference: 'FT26090812345',
      bank_amount_minor: 100_000,
      status: 'CREDITED',
      currency: 'ETB',
    });
    // A credit can be traced back to the deposit that caused it.
    expect(row?.['posting_id']).toBe(outcome.postingId);
  });

  it('sends shop B’s deposit to shop B', async () => {
    deposit(KEY_A, { bankReference: 'FT-A' });
    deposit(KEY_B, { bankReference: 'FT-B' });

    expect(availableBirr('merchant_alpha')).toBe(1_000);
    expect(availableBirr('merchant_beta')).toBe(1_000);
    expect(submissions().map((r) => r['merchant_id']).sort()).toEqual([
      'merchant_alpha',
      'merchant_beta',
    ]);
  });
});

describe('the same deposit twice', () => {
  it('credits once and calls the second a duplicate', async () => {
    deposit(KEY_A);
    expect(availableBirr('merchant_alpha')).toBe(1_000);

    const second = deposit(KEY_A);
    expect(second.decision.kind).toBe('DUPLICATE');
    // The balance did not move, and no second posting exists.
    expect(availableBirr('merchant_alpha')).toBe(1_000);
    expect(second.postingId).toBeUndefined();
  });

  it('records the duplicate rather than discarding it', async () => {
    // A replayed slip is a thing that happened and somebody may ask about it.
    deposit(KEY_A);
    deposit(KEY_A);
    const rows = submissions();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r['status']).sort()).toEqual(['CREDITED', 'DUPLICATE']);
    expect(rows.find((r) => r['status'] === 'DUPLICATE')?.['outcome_reason']).toBe(
      'BANK_REFERENCE_ALREADY_CREDITED',
    );
  });
});

describe('what does not credit', () => {
  it('refuses when the bank has no such transaction', async () => {
    const outcome = deposit(KEY_A, { bankRecord: undefined });
    expect(outcome.decision).toMatchObject({ kind: 'REJECT', reason: 'NO_BANK_RECORD' });
    expect(availableBirr('merchant_alpha')).toBe(0);
    expect(submissions()[0]).toMatchObject({ status: 'REJECTED', outcome_reason: 'NO_BANK_RECORD' });
  });

  it('refuses a genuine deposit into the wrong account', async () => {
    const outcome = recordDeposit(ports(), {
      quotedReference: KEY_A,
      bankReference: 'FT-OTHER-ACCOUNT',
      bankRecord: bank({ bankReference: 'FT-OTHER-ACCOUNT', creditedAccount: '9999999999' }),
      expectedAccount: ACCOUNT,
      autoCreditCapMinor: CAP,
      recordedBy: 'ops',
    });
    expect(outcome.decision).toMatchObject({ kind: 'REJECT', reason: 'WRONG_ACCOUNT' });
    expect(availableBirr('merchant_alpha')).toBe(0);
  });

  it('never guesses a shop for an unknown reference', async () => {
    // The failure this rules out is one shop credited with another's money.
    const outcome = deposit('NOT-ANY-SHOPS-KEY');
    expect(outcome.decision).toMatchObject({
      kind: 'MANUAL_REVIEW',
      reason: 'REFERENCE_NOT_ASSIGNED',
    });
    expect(submissions()[0]?.['merchant_id']).toBeNull();
    expect(availableBirr('merchant_alpha')).toBe(0);
    expect(availableBirr('merchant_beta')).toBe(0);
  });

  it('holds a high-value deposit for a second approval instead of crediting it', async () => {
    // CLAUDE.md §20 and Funding Verification: the second approver is a second
    // *person*, and none is assigned. So it waits — which is correct, not a gap.
    const outcome = recordDeposit(ports(), {
      quotedReference: KEY_A,
      bankReference: 'FT-BIG',
      bankRecord: bank({ bankReference: 'FT-BIG', amountMinor: CAP + 1 }),
      expectedAccount: ACCOUNT,
      autoCreditCapMinor: CAP,
      recordedBy: 'ops',
    });

    expect(outcome.decision.kind).toBe('NEEDS_APPROVAL');
    expect(submissions()[0]).toMatchObject({ status: 'MATCHED', merchant_id: 'merchant_alpha' });
    // Recorded, matched to the right shop, and **not credited**.
    expect(availableBirr('merchant_alpha')).toBe(0);
    expect(submissions()[0]?.['posting_id']).toBeNull();
  });
});

describe('separation of duties, in the schema', () => {
  it('refuses a row where one person both decided and approved', async () => {
    // §20 requires the second approver to be a different person. The database
    // refuses it, so no code path can write one by forgetting to check.
    deposit(KEY_A);
    const id = String(submissions()[0]?.['id']);
    db.prepare(`UPDATE funding_submissions SET decided_by = NULL WHERE id = ?`).run(id);

    expect(() =>
      db
        .prepare(`UPDATE funding_submissions SET decided_by = 'ops', approved_by = 'ops' WHERE id = ?`)
        .run(id),
    ).toThrow(/CHECK constraint failed/);
  });

  it('allows two different people', async () => {
    deposit(KEY_A);
    const id = String(submissions()[0]?.['id']);
    expect(() =>
      db
        .prepare(
          `UPDATE funding_submissions SET decided_by = 'ops', approved_by = 'finance' WHERE id = ?`,
        )
        .run(id),
    ).not.toThrow();
  });
});

describe('one bank transaction, one credit', () => {
  it('is refused by the database, not only by the decision', async () => {
    // Belt and braces: even a code path that forgot `alreadyCredited` cannot
    // move the money twice for one bank transaction.
    deposit(KEY_A);
    expect(() =>
      db
        .prepare(
          `INSERT INTO funding_submissions
             (id, merchant_id, quoted_reference, bank_reference, status, created_at, updated_at)
           VALUES ('fund_x', 'merchant_alpha', ?, 'FT26090812345', 'CREDITED', ?, ?)`,
        )
        .run(KEY_A, AT, AT),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('still allows the attempt to be written down', async () => {
    // The distinction the index exists to draw. A replayed slip is recorded as
    // a DUPLICATE — refusing to write it would lose evidence while protecting
    // nothing, since it is the *credit* that must be unique.
    deposit(KEY_A);
    expect(() =>
      db
        .prepare(
          `INSERT INTO funding_submissions
             (id, merchant_id, quoted_reference, bank_reference, status, created_at, updated_at)
           VALUES ('fund_y', 'merchant_alpha', ?, 'FT26090812345', 'DUPLICATE', ?, ?)`,
        )
        .run(KEY_A, AT, AT),
    ).not.toThrow();
  });
});
