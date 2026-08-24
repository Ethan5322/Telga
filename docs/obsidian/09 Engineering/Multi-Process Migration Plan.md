---
title: Multi-Process Migration Plan
type: engineering
status: draft
owner: telga
created: 2026-08-20
updated: 2026-08-20
tags:
  - telga
  - engineering
  - migrations
  - risk
related:
  - "[[00 Home]]"
  - "[[Migration Ownership]]"
  - "[[Migration Strategy]]"
  - "[[Deployment Runbook]]"
depends_on:
  - "[[Migration Ownership]]"
implements: []
validates: []
decision_status: pending
---

# Multi-Process Migration Plan

What it would take to close **A30**, and why it is not closed today.

## The open question

If two processes ran migrations against the same SQLite file at the same time, what happens?

The honest answer is **nobody here knows**, because it has never been run. What is known:

- Each migration executes inside one transaction, so a single migration is atomic.
- `schema_migrations.version` is a primary key, so a duplicate insert would be rejected.
- SQLite serialises writers, and `busy_timeout` is 5 seconds.

Those three facts make a good outcome *likely*. They do not make it *tested*, and the failure mode
— a partially migrated schema under a merchant ledger — is not one to discover in production.

## Today's position

The risk is **avoided rather than solved**: the worker refuses to start against an unmigrated
database, and migrations are applied by one explicit `--migrate` invocation. See
[[Migration Ownership]].

That is enough for a single-worker deployment, which is all that exists.

## What closing A30 would require

In the order it should be done:

1. **A migration lock.** A dedicated row or table claimed with an atomic conditional update, the same shape as the recovery claim lease: one winner, everyone else waits or exits.
2. **A lock timeout**, so a process that dies mid-migration does not block deployment forever — and a documented procedure for what to do when one does.
3. **A genuine child-process test**, in the shape of the ones that closed A37: spawn two processes against one unmigrated file, assert exactly one applies each migration, the other waits or exits cleanly, the schema is complete, and `schema_migrations` has no duplicates.
4. **A crash-mid-migration test**: kill a migrating process and assert the next one either completes the work or refuses clearly — never silently leaves a half-migrated schema.
5. **Then**, and only then, allow more than one process to attempt migration.

Steps 3 and 4 are now cheap: [[Build Pipeline]] produces a runnable artifact, and the
child-process test harness already exists.

## Why it is not done now

It is not on the critical path. One worker is the current deployment shape, the single-writer
procedure covers it, and the guard is enforced in code rather than in a runbook. Building a lock
that nothing needs yet would be speculative work on the part of the system that handles money.

**A30 stays OPEN**, with the mitigation documented and enforced.

## What must never be done in the meantime

| Action | Why |
|---|---|
| Running `--migrate` from more than one process | The untested case |
| Reverting to migrate-on-open | It made every worker a migrator |
| Assuming SQLite "probably handles it" | That is the assumption A30 exists to record |
| Adding a destructive reset to work around a half-migrated schema | Nothing in this repository may destroy a ledger |

## Related

- [[Migration Ownership]]
- [[Migration Strategy]]
- [[Deployment Runbook]]

---
Back to [[00 Home]]
