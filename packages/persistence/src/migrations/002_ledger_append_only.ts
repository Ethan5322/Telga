import type { Migration } from './index';

/**
 * Append-only enforcement for `ledger_entries`, at the database level.
 *
 * TypeScript already offers no way to mutate an entry — `AppendOnlyLedger` and
 * `LedgerDriver` expose no update or delete. These triggers close the gap that
 * remains: a migration, a console session, an ORM, or a future bug that reaches
 * the connection directly still cannot rewrite history.
 *
 * Ledger invariant 1 and 8: corrections are new ADJUSTMENT entries, never edits.
 */
export const m002LedgerAppendOnly: Migration = {
  version: '002',
  name: 'ledger_append_only',
  sql: `
CREATE TRIGGER ledger_entries_forbid_update
BEFORE UPDATE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only: UPDATE is forbidden. Post an ADJUSTMENT entry instead.');
END;

CREATE TRIGGER ledger_entries_forbid_delete
BEFORE DELETE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only: DELETE is forbidden. Post an ADJUSTMENT entry instead.');
END;
`,
};
