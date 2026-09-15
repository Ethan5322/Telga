/**
 * Migration 023 — the commission policy tables.
 *
 * The point of these tests is that the rules are enforced by the **database**,
 * not by the function that happens to write the row. Every assertion here is
 * one a future caller cannot talk its way past.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, runMigrations } from '@telga/persistence';

const NOW = '2026-09-14T10:00:00.000Z';
let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'telga-m023-'));
  db = new Database(join(dir, 'telga.sqlite'));
  db.pragma('foreign_keys = ON');
  runMigrations(db as never, NOW as never, MIGRATIONS as never);

  db.prepare(
    `INSERT INTO merchants (id, status, mode, created_at, updated_at)
     VALUES ('shop_a', 'ACTIVE', 'TRAINING', ?, ?)`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO devices (id, merchant_id, status, device_type, created_at, updated_at)
     VALUES ('dev_a', 'shop_a', 'ACTIVE', 'SMART_POS', ?, ?)`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO transactions
       (id, merchant_id, device_id, product_type, amount_minor, currency,
        recipient_masked, recipient_hash, state, idempotency_key,
        payload_fingerprint, mode, created_at, updated_at)
     VALUES ('txn_1', 'shop_a', 'dev_a', 'AIRTIME', 10000, 'ETB',
             '09****1234', 'hash', 'SUCCESSFUL', 'idem_1', 'fp', 'TRAINING', ?, ?)`,
  ).run(NOW, NOW);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const insertEntry = (over: Record<string, unknown> = {}): void => {
  const row = {
    id: 'ce_1',
    transaction_id: 'txn_1',
    merchant_id: 'shop_a',
    provider_id: 'prov_1',
    product_type: 'AIRTIME',
    transaction_amount_minor: 10_000,
    provider_commission_bps: 300,
    shop_share_bps: 7_000,
    provider_commission_minor: 300,
    shop_share_minor: 210,
    telga_share_minor: 90,
    card_fee_minor: 0,
    created_at: NOW,
    ...over,
  };
  db.prepare(
    `INSERT INTO commission_entries
       (id, transaction_id, merchant_id, provider_id, product_type,
        transaction_amount_minor, provider_commission_bps, shop_share_bps,
        provider_commission_minor, shop_share_minor, telga_share_minor,
        card_fee_minor, created_at)
     VALUES (@id, @transaction_id, @merchant_id, @provider_id, @product_type,
             @transaction_amount_minor, @provider_commission_bps, @shop_share_bps,
             @provider_commission_minor, @shop_share_minor, @telga_share_minor,
             @card_fee_minor, @created_at)`,
  ).run(row);
};

describe('the platform fee settings are platform-level', () => {
  it('has exactly one row, seeded with the founder’s figures', () => {
    const rows = db.prepare(`SELECT * FROM platform_fee_settings`).all() as Record<
      string,
      number
    >[];
    expect(rows).toHaveLength(1);
    expect(rows[0].default_commission_bps).toBe(300);
    expect(rows[0].shop_share_bps).toBe(7_000);
    // No card fee has been agreed with anybody. Zero, not a plausible figure.
    expect(rows[0].card_fee_bps).toBe(0);
  });

  it('refuses a second row', () => {
    expect(() =>
      db.prepare(`INSERT INTO platform_fee_settings (id, updated_at) VALUES (2, ?)`).run(NOW),
    ).toThrow();
  });

  it('has no column a merchant id could go in', () => {
    // This is the structural enforcement of "shops cannot decide": not a
    // hidden form field, but the absence of anywhere to record a per-shop rate.
    const columns = (
      db.prepare(`PRAGMA table_info(platform_fee_settings)`).all() as { name: string }[]
    ).map((c) => c.name);
    expect(columns).not.toContain('merchant_id');
    expect(columns).toContain('updated_by_admin_id');
  });

  it('refuses a rate outside 0–100%', () => {
    for (const bad of [-1, 10_001]) {
      expect(() =>
        db.prepare(`UPDATE platform_fee_settings SET shop_share_bps = ? WHERE id = 1`).run(bad),
      ).toThrow();
    }
  });
});

describe('provider rates', () => {
  it('starts empty, because no provider agreement exists', () => {
    const count = db.prepare(`SELECT COUNT(*) AS n FROM provider_commission_rates`).get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });

  const addRate = (id: string, provider: string, product: string | null, bps: number) =>
    db
      .prepare(
        `INSERT INTO provider_commission_rates
           (id, provider_id, product_type, commission_bps, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'test contract', ?, ?)`,
      )
      .run(id, provider, product, bps, NOW, NOW);

  it('allows one default and one per product for a provider', () => {
    addRate('r1', 'prov_1', null, 300);
    addRate('r2', 'prov_1', 'AIRTIME', 350);
    addRate('r3', 'prov_1', 'DATA', 200);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM provider_commission_rates`).get() as { n: number }).n,
    ).toBe(3);
  });

  it('refuses a second default for the same provider', () => {
    // SQLite treats NULLs as distinct in a plain unique index, so without the
    // partial index a provider could collect several "all products" rates and
    // which one won would depend on row order.
    addRate('r1', 'prov_1', null, 300);
    expect(() => addRate('r2', 'prov_1', null, 900)).toThrow();
  });

  it('refuses a second rate for the same provider and product', () => {
    addRate('r1', 'prov_1', 'AIRTIME', 300);
    expect(() => addRate('r2', 'prov_1', 'AIRTIME', 900)).toThrow();
  });

  it('defaults a new rate to NOT_YET_CONFIRMED', () => {
    addRate('r1', 'prov_1', 'AIRTIME', 300);
    const row = db.prepare(`SELECT status FROM provider_commission_rates WHERE id = 'r1'`).get() as {
      status: string;
    };
    expect(row.status).toBe('NOT_YET_CONFIRMED');
  });
});

describe('the commission ledger', () => {
  it('records the figures and the rates that produced them', () => {
    insertEntry();
    const row = db.prepare(`SELECT * FROM commission_entries WHERE id = 'ce_1'`).get() as Record<
      string,
      unknown
    >;
    expect(row.provider_commission_minor).toBe(300);
    expect(row.shop_share_minor).toBe(210);
    expect(row.telga_share_minor).toBe(90);
    expect(row.provider_commission_bps).toBe(300);
    expect(row.settlement_status).toBe('UNSETTLED');
    expect(row.reversal_status).toBe('NONE');
  });

  it('refuses a split that does not sum', () => {
    // Money invented at the point of sale, refused by the database rather
    // than by whichever function happened to write the row.
    expect(() => insertEntry({ shop_share_minor: 211, telga_share_minor: 90 })).toThrow();
    expect(() => insertEntry({ shop_share_minor: 210, telga_share_minor: 89 })).toThrow();
  });

  it('pays one sale exactly once', () => {
    insertEntry();
    expect(() => insertEntry({ id: 'ce_2' })).toThrow();
  });

  it('refuses a negative share', () => {
    expect(() =>
      insertEntry({
        provider_commission_minor: 0,
        shop_share_minor: -10,
        telga_share_minor: 10,
      }),
    ).toThrow();
  });
});

describe('the commission ledger is append-only', () => {
  beforeEach(() => insertEntry());

  it('refuses deletion', () => {
    expect(() => db.prepare(`DELETE FROM commission_entries WHERE id = 'ce_1'`).run()).toThrow(
      /append-only/,
    );
  });

  it('refuses an edit to any money figure', () => {
    for (const column of [
      'shop_share_minor',
      'telga_share_minor',
      'provider_commission_minor',
      'transaction_amount_minor',
      'card_fee_minor',
    ]) {
      expect(
        () => db.prepare(`UPDATE commission_entries SET ${column} = 1 WHERE id = 'ce_1'`).run(),
        `${column} must be immutable`,
      ).toThrow(/history/);
    }
  });

  it('refuses an edit to the rate a past sale was paid at', () => {
    expect(() =>
      db.prepare(`UPDATE commission_entries SET provider_commission_bps = 900 WHERE id = 'ce_1'`).run(),
    ).toThrow(/history/);
  });

  it('allows settlement to be recorded', () => {
    db.prepare(
      `UPDATE commission_entries
          SET settlement_status = 'SETTLED', settled_at = ?, settlement_reference = 'BNK-1'
        WHERE id = 'ce_1'`,
    ).run(NOW);
    const row = db.prepare(`SELECT settlement_status FROM commission_entries WHERE id = 'ce_1'`).get() as {
      settlement_status: string;
    };
    expect(row.settlement_status).toBe('SETTLED');
  });

  it('refuses to un-settle', () => {
    db.prepare(`UPDATE commission_entries SET settlement_status = 'SETTLED' WHERE id = 'ce_1'`).run();
    expect(() =>
      db.prepare(`UPDATE commission_entries SET settlement_status = 'UNSETTLED' WHERE id = 'ce_1'`).run(),
    ).toThrow(/cannot be undone/);
  });

  it('refuses to un-record a reversal', () => {
    db.prepare(`UPDATE commission_entries SET reversal_status = 'REVERSED' WHERE id = 'ce_1'`).run();
    expect(() =>
      db.prepare(`UPDATE commission_entries SET reversal_status = 'NONE' WHERE id = 'ce_1'`).run(),
    ).toThrow(/un-recorded/);
  });

  it('keeps settlement and reversal independent', () => {
    // A settled commission can still be reversed. Collapsing the two into one
    // status would lose which of them happened.
    db.prepare(
      `UPDATE commission_entries SET settlement_status = 'SETTLED' WHERE id = 'ce_1'`,
    ).run();
    db.prepare(
      `UPDATE commission_entries SET reversal_status = 'REVERSED', reversed_at = ? WHERE id = 'ce_1'`,
    ).run(NOW);
    const row = db.prepare(`SELECT * FROM commission_entries WHERE id = 'ce_1'`).get() as Record<
      string,
      string
    >;
    expect(row.settlement_status).toBe('SETTLED');
    expect(row.reversal_status).toBe('REVERSED');
  });
});

describe('what the migration leaves alone', () => {
  it('keeps PROFIT_PERCENT_BPS rows, because they are history', () => {
    // Section 13 invariant 1: the historical record is append-only. An old
    // training sale is explained by the rate that was stored when it happened.
    db.prepare(`INSERT INTO settings VALUES ('shop_a', 'PROFIT_PERCENT_BPS', '400', ?)`).run(NOW);
    const row = db
      .prepare(`SELECT value FROM settings WHERE merchant_id = 'shop_a' AND key = 'PROFIT_PERCENT_BPS'`)
      .get() as { value: string };
    expect(row.value).toBe('400');
  });
});
