/**
 * Migration 015 — registration documents, and the temporary-PIN flag.
 *
 * ## What is actually at risk here
 *
 * This is the first migration in this series that touches a table with rows in
 * it. `merchant_application_documents` is new and empty and carries no risk; the
 * `ALTER TABLE merchant_users ADD COLUMN` does not, because the training
 * deployment has an operator signed in against that table right now.
 *
 * So the tests below are weighted accordingly. Most of them are about the one
 * question that matters for a running system: **does an operator that existed
 * before this migration still work exactly as it did after it?** A column added
 * with the wrong default would not fail the migration — it would fail the next
 * sign-in, at a counter.
 *
 * The rest prove the constraints that make the documents table worth having
 * rather than being a bag of text: the type register, the expiry index, and the
 * uniqueness rule that stops one licence number being claimed by two shops.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '@telga/persistence';

let dir: string;
let file: string;
let open: Database.Database[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'telga-m015-'));
  file = join(dir, 'telga.sqlite');
  open = [];
});

afterEach(() => {
  for (const db of open) {
    try {
      db.close();
    } catch {
      // Already closed by the test itself.
    }
  }
  open = [];
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Apply migrations in `(after, upTo]`.
 *
 * `after` exists so a database can be built to 014, written to, closed, and then
 * upgraded — which is the only way to test what this migration does to rows that
 * already exist. Re-running 001 against a populated file just fails on
 * `table merchants already exists`, which proves nothing.
 */
function migrate(upTo = '015', after = '000'): Database.Database {
  const db = new Database(file);
  open.push(db);
  db.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS) {
    if (migration.version > upTo) break;
    if (migration.version <= after) continue;
    db.exec(`BEGIN; ${migration.sql} COMMIT;`);
  }
  return db;
}

const AT = '2026-09-08T09:00:00.000Z';

const columnsOf = (db: Database.Database, table: string): string[] =>
  (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map(
    (c) => c.name,
  );

function seedApplication(db: Database.Database, id = 'app_1'): string {
  db.prepare(
    `INSERT INTO merchant_applications
       (id, reference, status, legal_name, owner_name, phone, address, locality,
        created_at, updated_at)
     VALUES (?, ?, 'SUBMITTED', 'Abebe Trading PLC', 'Abebe Bekele',
             '+251911000000', 'Bole Road 12', 'Addis Ababa', ?, ?)`,
  ).run(id, `REF-${id}`, AT, AT);
  return id;
}

function seedOperator(db: Database.Database, id = 'operator_1'): void {
  db.prepare(
    `INSERT INTO merchants (id, status, mode, created_at, updated_at)
     VALUES ('merchant_alpha', 'ACTIVE', 'TRAINING', ?, ?)`,
  ).run(AT, AT);
  db.prepare(
    `INSERT INTO merchant_users
       (id, merchant_id, display_name, role, pin_hash, pin_salt, pin_params,
        status, mode, created_at, updated_at)
     VALUES (?, 'merchant_alpha', 'Operator One', 'MERCHANT_OWNER',
             'hash', 'salt', 'scrypt$N=16384,r=8,p=1', 'ACTIVE', 'TRAINING', ?, ?)`,
  ).run(id, AT, AT);
}

const addDocument = (
  db: Database.Database,
  over: Partial<{ id: string; application: string; kind: string; reference: string; status: string; expiresAt: string | null }> = {},
): void => {
  db.prepare(
    `INSERT INTO merchant_application_documents
       (id, application_id, kind, reference, status, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    over.id ?? 'doc_1',
    over.application ?? 'app_1',
    over.kind ?? 'TRADE_LICENCE',
    over.reference ?? 'TL-99887',
    over.status ?? 'SUPPLIED',
    over.expiresAt === undefined ? '2027-09-08T00:00:00.000Z' : over.expiresAt,
    AT,
    AT,
  );
};

describe('an operator that existed before the migration', () => {
  it('is unaffected, and its PIN is not treated as temporary', () => {
    // The whole risk of this migration in one test. The training deployment has
    // an operator signed in against this table; a column added with the wrong
    // default would lock them out at a counter rather than fail here.
    const db = migrate('014');
    seedOperator(db);
    db.close();

    // Only 015 runs, against the file the operator is already in.
    const upgraded = migrate('015', '014');
    const row = upgraded
      .prepare(`SELECT * FROM merchant_users WHERE id = 'operator_1'`)
      .get() as Record<string, unknown>;

    expect(row['must_change_pin']).toBe(0);
    // Nothing else moved.
    expect(row['status']).toBe('ACTIVE');
    expect(row['pin_hash']).toBe('hash');
    expect(row['merchant_id']).toBe('merchant_alpha');
  });

  it('adds exactly one column and removes none', () => {
    const before = columnsOf(migrate('014'), 'merchant_users');
    open.pop()?.close();
    rmSync(file, { force: true });
    const after = columnsOf(migrate('015'), 'merchant_users');

    expect(after).toEqual([...before, 'must_change_pin']);
  });

  it('accepts only 0 or 1, so the flag cannot become a third thing', () => {
    const db = migrate();
    seedOperator(db);
    expect(() =>
      db.prepare(`UPDATE merchant_users SET must_change_pin = 2 WHERE id = 'operator_1'`).run(),
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db.prepare(`UPDATE merchant_users SET must_change_pin = 1 WHERE id = 'operator_1'`).run(),
    ).not.toThrow();
  });
});

describe('the documents table', () => {
  it('records a document against an application', () => {
    const db = migrate();
    seedApplication(db);
    addDocument(db);

    const row = db
      .prepare(`SELECT * FROM merchant_application_documents WHERE id = 'doc_1'`)
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      application_id: 'app_1',
      kind: 'TRADE_LICENCE',
      reference: 'TL-99887',
      status: 'SUPPLIED',
    });
    // Null until somebody checks it. A document is supplied, not verified, on
    // arrival — and `verified_by` naming nobody is what says so.
    expect(row['verified_by']).toBeNull();
    expect(row['verified_at']).toBeNull();
  });

  it('stores no image, by design', () => {
    // CLAUDE.md §24 data minimisation. `document_uri` exists for a later,
    // deliberate retention decision and nothing writes it today.
    const columns = columnsOf(migrate(), 'merchant_application_documents');
    expect(columns).toContain('reference');
    expect(columns).toContain('document_uri');
    for (const forbidden of ['image', 'image_blob', 'scan', 'photo', 'file_bytes']) {
      expect(columns).not.toContain(forbidden);
    }
  });

  it('refuses a document type outside the register', () => {
    const db = migrate();
    seedApplication(db);
    expect(() => {
      addDocument(db, { kind: 'WHATEVER_THEY_BROUGHT' });
    }).toThrow(/CHECK constraint failed/);
  });

  it('accepts every type the proposal lists, and no more', () => {
    const db = migrate();
    seedApplication(db);
    const kinds = [
      'TRADE_LICENCE',
      'COMMERCIAL_REGISTRATION',
      'TIN_CERTIFICATE',
      'OWNER_PHOTO_ID',
      'PROOF_OF_ADDRESS',
      'BANK_ACCOUNT_PROOF',
      'MEMORANDUM_OF_ASSOCIATION',
      'SIGNING_AUTHORITY',
    ];
    kinds.forEach((kind, i) => {
      addDocument(db, { id: `doc_${String(i)}`, kind, reference: `REF-${kind}` });
    });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM merchant_application_documents`).get(),
    ).toMatchObject({ n: kinds.length });
  });

  it('refuses a document belonging to no application', () => {
    const db = migrate();
    expect(() => {
      addDocument(db, { application: 'app_that_does_not_exist' });
    }).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('refuses the same licence number claimed by two shops', () => {
    // The case that matters: a duplicate TIN across applications is the signal
    // that one person is opening shops under several names.
    const db = migrate();
    seedApplication(db, 'app_1');
    seedApplication(db, 'app_2');
    addDocument(db, { id: 'doc_a', application: 'app_1', reference: 'TIN-555' });
    expect(() => {
      addDocument(db, { id: 'doc_b', application: 'app_2', reference: 'TIN-555' });
    }).toThrow(/UNIQUE constraint failed/);
  });

  it('allows the same number for different document types', () => {
    // Uniqueness is per (kind, reference). A trade licence and a TIN that happen
    // to share digits are two different facts.
    const db = migrate();
    seedApplication(db);
    addDocument(db, { id: 'doc_a', kind: 'TRADE_LICENCE', reference: '12345' });
    expect(() => {
      addDocument(db, { id: 'doc_b', kind: 'TIN_CERTIFICATE', reference: '12345' });
    }).not.toThrow();
  });

  it('lets a document have no expiry, because some do not', () => {
    // A national ID and a TIN do not lapse the way a trade licence does.
    const db = migrate();
    seedApplication(db);
    expect(() => {
      addDocument(db, { kind: 'TIN_CERTIFICATE', reference: 'TIN-1', expiresAt: null });
    }).not.toThrow();
  });

  it('can answer "what lapses next month" from an index rather than a scan', () => {
    const db = migrate();
    seedApplication(db);
    addDocument(db, { id: 'd1', reference: 'A', expiresAt: '2026-10-01T00:00:00.000Z' });
    addDocument(db, {
      id: 'd2',
      kind: 'COMMERCIAL_REGISTRATION',
      reference: 'B',
      expiresAt: '2028-01-01T00:00:00.000Z',
    });

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id FROM merchant_application_documents
          WHERE status = 'SUPPLIED' AND expires_at < ?`,
      )
      .all('2026-11-01T00:00:00.000Z') as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' ')).toContain('idx_application_documents_expiry');

    const due = db
      .prepare(
        `SELECT id FROM merchant_application_documents
          WHERE status = 'SUPPLIED' AND expires_at < ? ORDER BY expires_at`,
      )
      .all('2026-11-01T00:00:00.000Z') as { id: string }[];
    expect(due.map((d) => d.id)).toEqual(['d1']);
  });

  it('refuses a status outside the four', () => {
    const db = migrate();
    seedApplication(db);
    expect(() => {
      addDocument(db, { status: 'PROBABLY_FINE' });
    }).toThrow(/CHECK constraint failed/);
  });
});

describe('the migration itself', () => {
  it('applies on top of a fully migrated database, in its place in the order', () => {
    const db = migrate();
    const applied = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as { name: string }[];
    expect(applied.map((t) => t.name)).toContain('merchant_application_documents');

    // Its position, not "the last one" — that assertion was true for an hour
    // and became a chore the moment 016 was added. What matters is that it is
    // present exactly once and that the list stays ordered, which is what makes
    // lexical order execution order.
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions.filter((v) => v === '015')).toHaveLength(1);
    expect([...versions].sort()).toEqual(versions);
  });

  it('leaves the ledger and audit tables untouched', () => {
    // The one promise a migration against a live ledger has to keep.
    const before = columnsOf(migrate('014'), 'ledger_entries');
    open.pop()?.close();
    rmSync(file, { force: true });
    expect(columnsOf(migrate('015'), 'ledger_entries')).toEqual(before);
  });
});
