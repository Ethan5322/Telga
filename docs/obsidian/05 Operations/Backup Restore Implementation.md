---
title: Backup Restore Implementation
type: operations
status: draft
owner: telga
created: 2026-08-24
updated: 2026-08-24
tags:
  - telga
  - operations
  - deployment
  - backup
related:
  - "[[00 Home]]"
  - "[[Backup and Restore Runbook]]"
  - "[[Persistent Host Runbook]]"
  - "[[Database Operations Runbook]]"
  - "[[Launch Gates]]"
depends_on:
  - "[[Backup and Restore Runbook]]"
implements: []
validates: []
decision_status: accepted
---

# Backup Restore Implementation

**Implemented, tested against real synthetic training data — launch gate 10
is still OPEN.** [[Backup and Restore Runbook]] is the design this
implements; read that first for the *why*. This note is the *what exists*.
Package: `@telga/backup` (`services/backup/`). Tests: `tests/backup/` (27
cases against real SQLite files) and `tests/build/backup-restore-cli.test.ts`
(5 cases against the real compiled binary).

> [!warning] Implementation completeness is not launch-gate completeness
> Every acceptance-criteria box in [[Backup and Restore Runbook]] is now
> checked by an automated test running against real files — but the gate
> also requires this to run against a real host, a real backup schedule, and
> a measured time-to-restore, none of which exist yet. See "What remains
> open" below.

## Commands

```bash
node services/backup/dist/cli.js backup  --db <path> --output <path> [--force]
node services/backup/dist/cli.js restore --backup <path> --target <path> [--allow-existing-target]

# or, once built:
npm run backup  -- --db <path> --output <path>
npm run restore -- --backup <path> --target <path>
```

Both refuse `--mode LIVE` before opening anything (matching the worker and
POS CLIs exactly), and both refuse to run at all unless
`TELGA_BACKUP_ALLOWED_ROOTS` names at least one directory — see
"Path safety" below.

## Backup — what it actually does

1. Refuses `LIVE` mode, before the database is opened.
2. Validates the source and destination paths against the allowed roots.
3. Refuses a missing source, and refuses to overwrite an existing backup
   unless `--force`.
4. Opens the source **directly** (`new SqliteLedgerDriver`, never
   `createSqliteDriver`) — a backup tool must never apply a migration; that
   is the worker's or the POS's single-writer startup procedure, not this
   tool's job.
5. `PRAGMA wal_checkpoint(TRUNCATE)` — the same checkpoint SQLite performs
   on a clean shutdown, folding the WAL back into the main file so the copy
   taken immediately after is one consistent file.
6. Reads the residual, the row counts, and the applied-migrations list —
   every read defensive against a table that does not exist yet (a database
   backed up before its first real migration has an honest count of zero,
   not a crash).
7. Copies the file. Refuses if it exceeds `maxBackupSizeBytes`, when
   configured.
8. Computes a SHA-256 of the written copy and writes a manifest sidecar,
   `<backup>.manifest.json`.
9. **Never deletes or mutates the source.**

## Restore — what it actually does

1. Refuses `LIVE` mode, before anything is opened.
2. **Verifies the checksum against the backup file itself, before any
   copy** — a corrupt backup never produces even a partial target file.
3. Refuses an existing target unless `--allow-existing-target`.
4. Copies the backup into the target path. The original backup file is
   never opened again after this point.
5. Opens the **target** directly (never `createSqliteDriver` — restore
   verifies the schema that is there, it does not silently upgrade it):
   - Migrations checked **first**, before anything that touches
     `ledger_entries` — `driver.health()` itself computes the ledger
     residual internally, which would otherwise surface an opaque "no such
     table" instead of a clear `SchemaMismatchError`.
   - Integrity check and `foreign_keys` pragma.
   - **Append-only triggers verified live**: attempts a real `UPDATE`
     against a `ledger_entries` row and requires it to be refused. If it is
     *not* refused, that is `AppendOnlyProtectionMissingError` — the most
     serious failure this tool can detect.
   - Ledger residual must be exactly zero.
   - Row counts compared against the manifest, table by table.
6. **Session policy: every session in the restored copy is revoked,
   unconditionally.** A session from a backup predates the restore point by
   definition; operators sign in again. Documented as a decision, not an
   oversight, in [[Backup and Restore Runbook]].
7. **Claim policy: every recovery claim in the restored copy is released,
   unconditionally.** The claim-lease mechanism (A37/R16) is already safe by
   construction, but a restored copy has no worker that legitimately holds
   any lease against it — the next real sweep re-claims cleanly.
8. On **any** verification failure, the target file (and its `-wal`/`-shm`
   siblings) are removed — a failed restore leaves nothing partial behind.
9. **Never starts a worker. Never calls a provider. Never touches the live
   database path — only ever the isolated target it creates.**

## Path safety

Every path an operator supplies is resolved to an absolute path and checked
against `TELGA_BACKUP_ALLOWED_ROOTS` (a `path.delimiter`-separated list —
`;` on Windows, `:` on POSIX) before anything touches disk. There is no
default: an unset environment variable allows nothing, refusing every path,
rather than falling back to "anywhere is fine." See `services/backup/src/
paths.ts`.

## Configuration — every field explicit, no hidden production default

| Field | Env var | Default if unset |
|---|---|---|
| Allowed roots | `TELGA_BACKUP_ALLOWED_ROOTS` | None — every path refused |
| Max backup size | `TELGA_BACKUP_MAX_SIZE_BYTES` | No limit enforced |
| Checkpoint timeout | `TELGA_BACKUP_CHECKPOINT_TIMEOUT_MS` | 30 000 ms |
| Retention count | `TELGA_BACKUP_RETENTION_COUNT` | **Not implemented — see below** |

**Retention is deliberately not implemented.** The field exists in
`BackupRestoreConfig` so a real pruning step can be wired to it later,
deliberately — automatic deletion of an operator's only backup is exactly
the kind of silent, destructive action this repository's safety rules
refuse to take without an explicit, reviewed decision. Setting it today
does nothing.

**A guarded "replace the live database" restore mode is deliberately not
implemented.** Restore only ever writes to an isolated target path. The
runbook names this as future work ("unless an explicit, guarded replacement
mode is later designed") — it is not designed here, and no flag exists that
comes close to it.

## Verified safety properties, each with a test

- No duplicate settlement, no state change: a transaction left `PROCESSING`
  by a fault-injected failure (the same technique
  `tests/stress/recovery-manual-review.stress.test.ts` uses to reproduce
  A44) survives a full backup/restore round trip in exactly the same state,
  exactly once, with residual still zero
  (`tests/backup/backup-restore.test.ts`, "does not release uncertain funds
  or create duplicate settlement").
- No worker started, no provider called: a structural guarantee, not just a
  runtime one — `@telga/backup`'s only dependencies are `@telga/domain` and
  `@telga/persistence` (see `services/backup/package.json`), so it cannot
  import a provider adapter or the worker package even by mistake.
- Repeated restore of the same backup into two different targets produces
  identical row counts, residual, and checksum — deterministic.
- The original backup file's checksum is unchanged after a restore.
- A corrupt backup (a single flipped byte, or wholly different content) is
  refused before any target is created.

## What remains open

| Item | Status |
|---|---|
| Runs against a real chosen host | Not started — see [[Deployment Target Evaluation]], not yet selected |
| A real backup schedule | Not designed — this is a CLI, not a cron job |
| Time-to-restore measured on real infrastructure | Not measured — only measured against local temp-directory SQLite files in tests |
| Backup file encryption at rest | Not implemented — flagged as open in [[Security Deployment Checklist]] |
| Secret rotation for the recipient-hash salt | Out of scope for this tool entirely |
| Automatic retention / pruning | Deliberately not implemented, see above |
| Launch gate 10 | **Still OPEN** — implementation is necessary, not sufficient |

## Related

- [[Backup and Restore Runbook]]
- [[Persistent Host Runbook]]
- [[Database Operations Runbook]]
- [[Launch Gates]]

---
Back to [[00 Home]]
