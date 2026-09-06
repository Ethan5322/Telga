/**
 * Migration 014 — admin identity, the tenant registry, and applications.
 *
 * Five new tables, nothing existing altered. What these tests check is that
 * the constraints actually bite, and that the one thing this migration must
 * **not** do — touch merchant identity — it does not do.
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
  dir = mkdtempSync(join(tmpdir(), 'telga-m014-'));
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

function migrate(upTo = '014', at = file): Database.Database {
  const db = new Database(at);
  open.push(db);
  db.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS) {
    if (migration.version > upTo) break;
    db.exec(`BEGIN; ${migration.sql} COMMIT;`);
  }
  return db;
}

const AT = '2026-08-30T09:00:00.000Z';

const columnsOf = (db: Database.Database, table: string): string[] =>
  (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map(
    (c) => c.name,
  );

/** An owner to hang the other rows off. */
function seedOwner(db: Database.Database): void {
  db.prepare(
    `INSERT INTO admin_users
       (id, email, display_name, department, role, password_hash, password_salt,
        password_params, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'adm_owner',
    'owner@telga.example',
    'Owner',
    'PLATFORM',
    'PLATFORM_OWNER',
    'hash',
    'salt',
    'params',
    'ACTIVE',
    AT,
    AT,
  );
}

describe('the migration applies', () => {
  it('creates all five tables', () => {
    const db = migrate();
    const names = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
    ).map((t) => t.name);
    for (const table of [
      'admin_users',
      'admin_permissions',
      'admin_sessions',
      'tenant_registry',
      'merchant_applications',
    ]) {
      expect(names, `${table} missing`).toContain(table);
    }
    db.close();
  });

  it('leaves merchant identity completely alone', () => {
    // The whole reason admin identity is a new table: `merchant_users` keeps
    // its NOT NULL merchant key, which is what makes cross-shop leakage
    // structurally impossible rather than merely checked.
    const after = migrate();
    const before = migrate('013', join(dir, 'before.sqlite'));
    for (const table of ['merchant_users', 'sessions', 'devices', 'merchants']) {
      const a = before.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(table) as
        | { sql: string }
        | undefined;
      const b = after.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(table) as
        | { sql: string }
        | undefined;
      expect(b?.sql, `${table} was altered`).toBe(a?.sql);
    }
    before.close();
    after.close();
  });
});

describe('admin_users', () => {
  it('has nowhere to put a PIN', () => {
    // Structural, not conventional: CLAUDE.md §24 refuses a merchant PIN as an
    // administrative credential, and there is no column one could go in.
    const db = migrate();
    const columns = columnsOf(db, 'admin_users');
    expect(columns).not.toContain('pin_hash');
    expect(columns).not.toContain('pin');
    for (const column of ['email', 'password_hash', 'mfa_secret_hash', 'webauthn_public_key']) {
      expect(columns, `${column} missing`).toContain(column);
    }
    db.close();
  });

  it('refuses two admins with the same email', () => {
    const db = migrate();
    seedOwner(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO admin_users
             (id, email, display_name, department, role, password_hash, password_salt,
              password_params, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'adm_2',
          'owner@telga.example',
          'Impostor',
          'SALES',
          'SUPPORT_AGENT',
          'h',
          's',
          'p',
          'ACTIVE',
          AT,
          AT,
        ),
    ).toThrow(/UNIQUE/i);
    db.close();
  });

  it('refuses a role it does not know', () => {
    const db = migrate();
    expect(() =>
      db
        .prepare(
          `INSERT INTO admin_users
             (id, email, display_name, department, role, password_hash, password_salt,
              password_params, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'adm_x',
          'x@telga.example',
          'X',
          'PLATFORM',
          'SUPREME_LEADER',
          'h',
          's',
          'p',
          'ACTIVE',
          AT,
          AT,
        ),
    ).toThrow(/CHECK/i);
    db.close();
  });

  it('records who created and who approved an account', () => {
    // A sub-admin may only be created by the Platform Owner, and that claim
    // needs a record rather than a convention.
    const db = migrate();
    seedOwner(db);
    db.prepare(
      `INSERT INTO admin_users
         (id, email, display_name, department, role, password_hash, password_salt,
          password_params, status, created_by, approved_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'adm_sub',
      'sales@telga.example',
      'Sales One',
      'SALES',
      'DEPARTMENT_ADMIN',
      'h',
      's',
      'p',
      'ACTIVE',
      'adm_owner',
      'adm_owner',
      AT,
      AT,
    );
    const row = db
      .prepare(`SELECT created_by, approved_by FROM admin_users WHERE id = 'adm_sub'`)
      .get() as { created_by: string; approved_by: string };
    expect(row.created_by).toBe('adm_owner');
    expect(row.approved_by).toBe('adm_owner');
    db.close();
  });
});

describe('admin_sessions', () => {
  it('needs no device, unlike a merchant session', () => {
    // A console is used from a laptop. Requiring an enrolled POS terminal to
    // administer the platform is the wrong shape.
    const db = migrate();
    const columns = columnsOf(db, 'admin_sessions');
    expect(columns).not.toContain('device_id');
    expect(columns).toContain('mfa_satisfied');
    expect(columns).toContain('stepped_up_at');
    db.close();
  });

  it('starts with the second factor unsatisfied', () => {
    const db = migrate();
    seedOwner(db);
    db.prepare(
      `INSERT INTO admin_sessions
         (id, admin_user_id, role, csrf_hash, status, created_at, last_seen_at,
          idle_expires_at, absolute_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('sess_1', 'adm_owner', 'PLATFORM_OWNER', 'csrf', 'ACTIVE', AT, AT, AT, AT);
    const row = db
      .prepare(`SELECT mfa_satisfied FROM admin_sessions WHERE id = 'sess_1'`)
      .get() as { mfa_satisfied: number };
    expect(row.mfa_satisfied).toBe(0);
    db.close();
  });
});

describe('tenant_registry', () => {
  it('refuses two merchants sharing one database', () => {
    // Under a per-shop model this is what stops two shops silently writing to
    // the same file.
    const db = migrate();
    const insert = db.prepare(
      `INSERT INTO tenant_registry
         (merchant_id, database_name, schema_version, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run('merchant_a', 'merchant_a.sqlite', '014', 'ACTIVE', AT, AT);
    expect(() => insert.run('merchant_b', 'merchant_a.sqlite', '014', 'ACTIVE', AT, AT)).toThrow(
      /UNIQUE/i,
    );
    db.close();
  });

  it('records a schema version per tenant', () => {
    // With N databases a half-migrated tenant is a real state, and it has to be
    // detectable rather than assumed away.
    const db = migrate();
    db.prepare(
      `INSERT INTO tenant_registry
         (merchant_id, database_name, schema_version, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('merchant_c', 'merchant_c.sqlite', '013', 'MIGRATING', AT, AT);
    const row = db
      .prepare(
        `SELECT schema_version, status FROM tenant_registry WHERE merchant_id = 'merchant_c'`,
      )
      .get() as { schema_version: string; status: string };
    expect(row.schema_version).toBe('013');
    expect(row.status).toBe('MIGRATING');
    db.close();
  });

  it('refuses a tenant state it does not know', () => {
    const db = migrate();
    expect(() =>
      db
        .prepare(
          `INSERT INTO tenant_registry
             (merchant_id, database_name, schema_version, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('merchant_d', 'd.sqlite', '014', 'PROBABLY_FINE', AT, AT),
    ).toThrow(/CHECK/i);
    db.close();
  });
});

describe('merchant_applications', () => {
  const insertApplication = (db: Database.Database) =>
    db.prepare(
      `INSERT INTO merchant_applications
         (id, reference, status, legal_name, owner_name, phone, address, locality,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

  it('exists without any merchant, which is the point', () => {
    // An applicant has no account, no credentials and no database until an
    // admin approves. The application cannot depend on a merchant row, because
    // there is not one yet.
    const db = migrate();
    insertApplication(db).run(
      'app_1',
      'TG-4821',
      'SUBMITTED',
      'Hebron Supermarket PLC',
      'Abebe',
      '0911000000',
      'Bole',
      'Addis Ababa',
      AT,
      AT,
    );
    const row = db
      .prepare(`SELECT merchant_id, status FROM merchant_applications WHERE id = 'app_1'`)
      .get() as { merchant_id: string | null; status: string };
    expect(row.merchant_id).toBeNull();
    expect(row.status).toBe('SUBMITTED');
    db.close();
  });

  it('accepts all eleven lifecycle states and refuses an invented one', () => {
    const db = migrate();
    const insert = insertApplication(db);
    const states = [
      'DRAFT',
      'SUBMITTED',
      'UNDER_REVIEW',
      'APPROVED',
      'PROVISIONING',
      'DEVICE_PENDING',
      'READY_FOR_TRAINING',
      'ACTIVE_TRAINING',
      'LIVE_ELIGIBLE',
      'SUSPENDED',
      'CLOSED',
    ];
    expect(states).toHaveLength(11);
    states.forEach((state, i) => {
      insert.run(`app_${i}`, `TG-${1000 + i}`, state, 'Shop', 'Owner', '0911', 'Addr', 'AA', AT, AT);
    });
    expect(() =>
      insert.run('app_bad', 'TG-9999', 'DEFINITELY_FINE', 'Shop', 'Owner', '0911', 'Addr', 'AA', AT, AT),
    ).toThrow(/CHECK/i);
    db.close();
  });

  it('refuses two applications with the same reference', () => {
    // The reference is the only thing an applicant gets back. Two shops
    // sharing one would make a support call unanswerable.
    const db = migrate();
    const insert = insertApplication(db);
    insert.run('app_a', 'TG-5000', 'SUBMITTED', 'A', 'O', '09', 'Ad', 'AA', AT, AT);
    expect(() =>
      insert.run('app_b', 'TG-5000', 'SUBMITTED', 'B', 'O', '09', 'Ad', 'AA', AT, AT),
    ).toThrow(/UNIQUE/i);
    db.close();
  });

  it('cannot name a reviewer who is not an admin', () => {
    const db = migrate();
    expect(() =>
      db
        .prepare(
          `INSERT INTO merchant_applications
             (id, reference, status, legal_name, owner_name, phone, address, locality,
              reviewed_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'app_z',
          'TG-7000',
          'UNDER_REVIEW',
          'Z',
          'O',
          '09',
          'Ad',
          'AA',
          'not_an_admin',
          AT,
          AT,
        ),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });
});
