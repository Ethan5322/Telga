---
title: Database Operations Runbook
type: operations
status: draft
owner: telga
created: 2026-08-20
updated: 2026-08-20
tags:
  - telga
  - operations
  - runbook
  - database
related:
  - "[[00 Home]]"
  - "[[Runbooks]]"
  - "[[SQLite Persistence Layer]]"
  - "[[Migration Strategy]]"
  - "[[Ledger Invariants]]"
depends_on:
  - "[[SQLite Persistence Layer]]"
implements: []
validates: []
decision_status: pending
---

# Database Operations Runbook

Owner: engineering and security — **NOT YET ASSIGNED** ([[Founders and Roles]]).

> [!danger] Standing rule
> **Never `UPDATE` or `DELETE` a ledger entry.** The database will refuse it, and the refusal is
> correct. A figure is corrected by posting an `ADJUSTMENT` entry — see [[Ledger Invariants]] rule 8.

## Health check

`driver.health()` reports: PRAGMA readback, applied migration count, `integrity_check`, and the
whole-ledger residual. Healthy means all of:

| Signal | Healthy value |
|---|---|
| `integrity_check` | `ok` |
| `foreign_keys` | `1` |
| `journal_mode` | `wal` |
| Ledger residual | `0` |

**A non-zero residual is the highest-severity signal Telga has.** It means double entry has broken
somewhere and merchant value is unaccounted for. Page immediately; see [[Observability]].

## Procedure — ledger residual is non-zero

1. **Stop new sales** for affected merchants. Do not attempt a correction first.
2. Capture the residual and the entry count. Do not modify anything.
3. Identify the unbalanced posting: group `ledger_entries` by `posting_id` and find the group whose signed sum is non-zero.
4. Determine the cause. A non-zero residual should be impossible — `assertBalanced` rejects an unbalanced posting before it is written — so a residual implies either a defect in that guard or direct SQL access.
5. Correct with an `ADJUSTMENT` posting, approved by a second person, recorded in [[Decision Log]].
6. Write an incident note from [[Incident]] and link it from [[Runbooks]].

## Procedure — migration failed at startup

1. The migration rolled itself back; the schema is at the previous version and nothing was half-applied.
2. Read the `MigrationFailedError` message for the failing version.
3. Fix the migration **only if it has never been applied anywhere**. If it has been applied in any environment, write a new forward migration instead — see [[Migration Strategy]].
4. Never edit an applied migration to make the checksum pass.

## Procedure — checksum mismatch at startup

An applied migration's contents have changed. This is a deployment integrity failure, not a
database fault.

1. Do not force it through.
2. Identify what changed — usually an edited migration file that should have been a new one.
3. Restore the original file, or write a new forward migration.

## Procedure — restore from backup

**Not yet exercised.** Launch gate 10 requires tested backups and recovery, and it is
**NOT CLEARED**. This section is a placeholder to be completed before the gate can close:

- [ ] Backup schedule defined
- [ ] Backup location and retention defined
- [ ] Restore procedure written
- [ ] Restore tested against a seeded database
- [ ] Time-to-restore measured

## WAL maintenance

The driver checkpoints the WAL (`wal_checkpoint(TRUNCATE)`) on clean shutdown. If the process is
killed, the `-wal` and `-shm` files remain beside the database; SQLite recovers from them on the
next open. **Never delete a `-wal` file by hand** — it may hold committed transactions not yet
folded into the main file.

## What must never be run

| Command | Why |
|---|---|
| `UPDATE ledger_entries ...` | Refused by trigger. Post an ADJUSTMENT |
| `DELETE FROM ledger_entries ...` | Refused by trigger |
| `UPDATE audit_events ...` | Refused by trigger |
| `PRAGMA writable_schema = ON` | Bypasses every constraint in this document |
| Any destructive reset | No such command exists in this repository, and none may be added |

## Related

- [[SQLite Persistence Layer]]
- [[Migration Strategy]]
- [[Runbooks]]
- [[Observability]]

---
Back to [[00 Home]]
