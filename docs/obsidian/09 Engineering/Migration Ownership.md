---
title: Migration Ownership
type: engineering
status: draft
owner: telga
created: 2026-08-20
updated: 2026-08-20
tags:
  - telga
  - engineering
  - migrations
  - deployment
related:
  - "[[00 Home]]"
  - "[[Migration Strategy]]"
  - "[[Multi-Process Migration Plan]]"
  - "[[Deployment Runbook]]"
  - "[[Recovery Worker]]"
depends_on:
  - "[[Migration Strategy]]"
implements: []
validates: []
decision_status: confirmed
---

# Migration Ownership

> **Database migrations run through a single-writer startup procedure. Multiple worker processes
> must not run migrations concurrently.**

That is the policy. This note records how it is enforced, not merely stated.

## The rule, enforced in code

The worker **opens the database without migrating** and refuses to start until every known
migration is applied:

| Behaviour | Result |
|---|---|
| Migrations missing, no `--migrate` | **Exit code 6**, with the missing versions named |
| `--migrate` passed | Applies migrations, then runs — this is the single writer |
| Migrations already applied | Runs normally |

```bash
# The single writer, once, at deploy time
node services/worker/dist/cli.js --db <path> --once --migrate

# Every other process
node services/worker/dist/cli.js --db <path>
```

Before this, `createSqliteDriver` migrated on open, which meant **every worker process migrated on
startup** — precisely the untested concurrent case recorded as assumption A30. Recorded as
[[Decision Log]] D33.

## Why not just let them race

SQLite would probably serialise them: each migration runs in its own transaction, and the
`schema_migrations` primary key would reject a duplicate. *Probably* is the problem. Nothing has
tested it, the failure mode is a half-applied schema on a ledger, and the cost of avoiding it is one
flag. See [[Multi-Process Migration Plan]] for what testing it would actually take.

## Who owns migrations

| Role | Responsibility |
|---|---|
| DevOps / SRE — **NOT YET ASSIGNED** | Runs the single-writer migration step at deploy time |
| Engineering and security — **NOT YET ASSIGNED** | Authors migrations; they are immutable once applied |

Until those roles are filled, migration ownership is a procedure without an owner. That is recorded
in [[Founders and Roles]] and is one reason no launch gate can clear.

## Rules that do not change

- Migrations are **forward-only**. There is no `down` — [[Decision Log]] D14.
- An applied migration is **immutable**; its checksum is verified on every startup, and editing one is refused.
- Each migration runs in **one transaction**, so a failure rolls back the DDL and its bookkeeping row together.
- **No destructive reset exists**, in any environment, and none may be added.

## Verified behaviour

| Property | Test |
|---|---|
| Worker refuses to start on an unmigrated database | `refuses to start when migrations have not been applied` |
| `--migrate` applies them, then a second process starts cleanly | `applies migrations only when explicitly asked, then runs` |
| Re-running migrations is safe | `re-running is safe and applies nothing` |
| A failed migration rolls back whole | `rolls a failed migration back whole and does not record it` |

## Related

- [[Migration Strategy]]
- [[Multi-Process Migration Plan]]
- [[Deployment Runbook]]
- [[Recovery Worker]]

---
Back to [[00 Home]]
