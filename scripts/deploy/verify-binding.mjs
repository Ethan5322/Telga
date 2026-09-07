/**
 * Fail the build if the SQLite binding does not actually load.
 *
 * ## Why this runs at build time
 *
 * Every previous attempt to fix the Railway build proved `better-sqlite3` on a
 * Windows machine and hoped the result held on Railway's Linux. It is the same
 * package but a different binary — `prebuilds/win32-x64.node` against
 * `prebuilds/linux-x64.node` — and the second had never been executed anywhere.
 *
 * So this runs on the build host, where it matters. A missing, wrong or
 * unloadable binding fails the build with a named error, instead of appearing
 * later as a broken sale on a running deployment.
 *
 * It is deliberately more than `require()`: it opens a database, creates a
 * STRICT table, runs a transaction and asserts `integrity_check` — the same
 * verdict [[Observability]] already treats as the database's own opinion of
 * itself. A binding that loads but cannot execute SQL fails here.
 *
 * ## What it does not prove, stated so nobody reads more into it
 *
 * This is an **in-memory** database, so `journal_mode` reports `memory`, not
 * `wal` — the pragma is exercised, the WAL file path is not. WAL on the mounted
 * volume is a runtime property, and the line that proves it is
 * `[telga] migrations applied.` in the startup log. Nor does this prove the
 * volume persists across a redeploy; that is a separate check.
 *
 * TRAINING MODE — NO REAL VALUE. Touches no file, no volume and no ledger, and
 * writes nothing that outlives the process.
 */

import Database from 'better-sqlite3';

const db = new Database(':memory:');

try {
  // Exercised for the pragma path, not for WAL itself: an in-memory database
  // cannot be in WAL and will report `memory`. See the note above.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, amount_minor INTEGER NOT NULL) STRICT');

  const insert = db.prepare('INSERT INTO t (amount_minor) VALUES (?)');
  // A balanced pair, so the sum is the same zero the ledger's residual must be.
  db.transaction(() => {
    insert.run(2500);
    insert.run(-2500);
  })();

  const residual = db.prepare('SELECT COALESCE(SUM(amount_minor), 0) AS s FROM t').get().s;
  const integrity = db.pragma('integrity_check', { simple: true });

  if (integrity !== 'ok') {
    console.error(`[telga] binding check FAILED: integrity_check returned "${integrity}"`);
    process.exit(1);
  }
  if (residual !== 0) {
    console.error(`[telga] binding check FAILED: residual ${String(residual)}, expected 0`);
    process.exit(1);
  }

  console.log(
    `[telga] better-sqlite3 verified on ${process.platform}-${process.arch}, ` +
      `node ${process.version}, journal_mode=${db.pragma('journal_mode', { simple: true })}`,
  );
} finally {
  db.close();
}
