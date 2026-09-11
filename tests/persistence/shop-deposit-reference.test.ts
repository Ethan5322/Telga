/**
 * A shop's own deposit reference — `CLAUDE.md` §20.1.
 *
 * ## The gap this closes
 *
 * A shop paying in **without** a printed slip quotes a per-shop code. The only
 * one that existed was `device_enrollments.deposit_lookup`, written by
 * `issueCredentials` and by nothing else — so every shop provisioned through
 * the CLI (which goes through `enrolDevice`) had **none**, and the fallback
 * resolved nothing at all. Verified against the running database on
 * 2026-09-11: two devices, no lookup on either.
 *
 * It failed in the safe direction — §20.1, *"a reference that does not resolve
 * goes to a person, never rounded to the nearest shop"* — so nobody was
 * credited wrongly. But an ordinary payment landed in manual review, which is
 * how a queue becomes a place nobody looks.
 *
 * This is also, at last, a **caller for `depositReference.ts`** — a module
 * written, tested, exported and never used, the third of four such found in
 * this codebase.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  MIGRATIONS,
  ensureDepositReference,
  findMerchantByDepositReference,
} from '@telga/persistence';
import {
  isValidDepositReference,
  newDepositReference,
  normalizeDepositReference,
} from '@telga/domain';

let dir: string;
let db: Database.Database;
const AT = '2026-09-11T10:00:00.000Z';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'telga-shopref-'));
  db = new Database(join(dir, 'telga.sqlite'));
  db.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS) db.exec(`BEGIN; ${migration.sql} COMMIT;`);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const shop = (id: string): void => {
  db.prepare(
    `INSERT INTO merchants (id, status, mode, created_at, updated_at)
     VALUES (?, 'ACTIVE', 'TRAINING', ?, ?)`,
  ).run(id, AT, AT);
};

const issue = (id: string): string =>
  ensureDepositReference(db as never, id as never, newDepositReference, normalizeDepositReference);

describe('every shop gets a reference, and it resolves back', () => {
  it('issues a well-formed one and finds the shop again', () => {
    shop('mch_a');
    const reference = issue('mch_a');

    // Well-formed by the domain's own rules: right length, right alphabet,
    // check character correct.
    expect(isValidDepositReference(reference)).toBe(true);
    expect(findMerchantByDepositReference(db as never, reference)?.id).toBe('mch_a');
  });

  it('gives a thousand shops a thousand different references', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `mch_${String(i).padStart(4, '0')}`);
    db.transaction(() => {
      for (const id of ids) shop(id);
    })();

    const issued: string[] = [];
    db.transaction(() => {
      for (const id of ids) issued.push(issue(id));
    })();

    // The same property the printed slip has, for the same reason: a shared
    // code is one shop credited with another shop's money.
    expect(new Set(issued).size).toBe(1000);
  });

  it('resolves a code typed the way a teller writes it', () => {
    shop('mch_a');
    const reference = issue('mch_a');
    const asTyped = `${reference.slice(0, 3)}-${reference.slice(3, 6)}-${reference.slice(6)}`.toLowerCase();
    expect(findMerchantByDepositReference(db as never, normalizeDepositReference(asTyped))?.id).toBe('mch_a');
  });

  it('resolves nothing for a code nobody was issued', () => {
    shop('mch_a');
    issue('mch_a');
    // Never rounded to the nearest shop — §20.1.
    expect(
      findMerchantByDepositReference(db as never, normalizeDepositReference(newDepositReference())),
    ).toBeUndefined();
  });
});

describe('a reference already given is never replaced', () => {
  it('returns the same one on a second call', () => {
    shop('mch_a');
    const first = issue('mch_a');
    const second = issue('mch_a');

    // Re-issuing would strand every payment quoting the old code. A shop has
    // read this down a phone line and may have it on a standing order.
    expect(second).toBe(first);
  });

  it('survives repeated provisioning of the same shop', () => {
    shop('mch_a');
    const first = issue('mch_a');
    for (let i = 0; i < 5; i += 1) issue('mch_a');
    expect(findMerchantByDepositReference(db as never, first)?.id).toBe('mch_a');
  });
});

describe('the database, not the generator, decides uniqueness', () => {
  it('draws again when a generator repeats itself', () => {
    shop('mch_a');
    shop('mch_b');
    const taken = normalizeDepositReference(newDepositReference());
    const fresh = normalizeDepositReference(newDepositReference());

    ensureDepositReference(db as never, 'mch_a' as never, () => taken, normalizeDepositReference);

    let call = 0;
    const repeats = (): string => {
      call += 1;
      return call === 1 ? taken : fresh;
    };
    const second = ensureDepositReference(
      db as never,
      'mch_b' as never,
      repeats,
      normalizeDepositReference,
    );

    expect(second).toBe(fresh);
    expect(findMerchantByDepositReference(db as never, taken)?.id).toBe('mch_a');
  });

  it('refuses loudly rather than looping when the generator is broken', () => {
    shop('mch_a');
    shop('mch_b');
    const stuck = normalizeDepositReference(newDepositReference());
    ensureDepositReference(db as never, 'mch_a' as never, () => stuck, normalizeDepositReference);

    expect(() =>
      ensureDepositReference(db as never, 'mch_b' as never, () => stuck, normalizeDepositReference),
    ).toThrow(/suspect the generator/i);
  });

  it('refuses a shop that does not exist', () => {
    expect(() => issue('mch_missing')).toThrow(/does not exist/i);
  });
});

describe('it is not a credential', () => {
  it('is stored in the clear, because it has to be readable', () => {
    shop('mch_a');
    const reference = issue('mch_a');
    const row = db.prepare(`SELECT deposit_reference FROM merchants WHERE id = 'mch_a'`).get() as {
      deposit_reference: string;
    };
    // The opposite of the device key, deliberately. An admin reads this to a
    // shopkeeper down a phone line, and a hash cannot be read back. What it
    // authorises is nothing — the worst a holder can do is give the shop money.
    expect(row.deposit_reference).toBe(reference);
  });

  it('creates no ledger entry', () => {
    shop('mch_a');
    issue('mch_a');
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ledger_entries`).get() as { n: number };
    expect(n.n).toBe(0);
  });
});
