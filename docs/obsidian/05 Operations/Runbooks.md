---
title: Runbooks
type: operations
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - operations
  - runbook
  - incident
related:
  - "[[00 Home]]"
  - "[[Provider Health]]"
  - "[[Support and Disputes]]"
  - "[[Incident]]"
depends_on: []
implements: []
validates: []
decision_status: pending
---

# Runbooks

Operational procedures, and the permanent log of every fault found and fixed. **Every fix gets a
note here**, written from the [[Incident]] template and linked from this page and from [[00 Home]].
No incident note is an orphan.

## Required runbooks

| # | Runbook | Status |
|---|---|---|
| 1 | Provider outage | TO BE WRITTEN |
| 2 | Under-review backlog | TO BE WRITTEN |
| 3 | Funding verification exception | TO BE WRITTEN |
| 4 | Daily reconciliation mismatch | TO BE WRITTEN |
| 5 | Printer failure | TO BE WRITTEN |
| 6 | Device loss or theft | TO BE WRITTEN |
| 7 | Refund and reversal | TO BE WRITTEN |
| 8 | Incident response | TO BE WRITTEN |
| 9 | Restore from backup | TO BE WRITTEN — placeholder in [[Database Operations Runbook]] |
| 10 | Database operations — health, residual, migrations | **WRITTEN** — [[Database Operations Runbook]] |
| 11 | Transaction failure — triage, stuck sales, reversals | **WRITTEN** — [[Transaction Failure Runbook]] |
| 12 | Recovery sweep — daily checks, failures, worker contention | **WRITTEN** — [[Recovery Sweep Runbook]] |
| 13 | Manual review — working an under-review case | **WRITTEN** — [[Manual Review Runbook]] |
| 14 | Worker operations — health, backoff, restart, manual recovery | **WRITTEN** — [[Worker Operations Runbook]] |
| 15 | Deployment — sequence, rolling, rollback | **WRITTEN** — [[Deployment Runbook]] |

Each runbook must state: trigger, who owns it, immediate action, merchant communication,
escalation path, resolution criteria, and what gets recorded.

Owners cannot be assigned yet — see [[Founders and Roles]].

## Standing rules that apply to every runbook

1. **Never treat a timeout as a failure.** See [[Transaction State Machine]].
2. **Never auto-refund an unknown outcome.** See [[Support and Disputes]].
3. **Never edit the ledger.** Corrections are authorized adjustment entries. See [[Ledger Invariants]].
4. **Tell the merchant before the deadline, not after.** See [[Support and Disputes]].
5. **Record everything** — every operational action produces an `AuditEvent`.

## Incident log

Faults found and fixed during development and pilot. Newest first.

| Date | Incident | Severity | Status |
|---|---|---|---|
| 2026-08-19 | [[Source Specification Clipped In PDF]] | Low | Resolved — assumptions recorded |

## Related

- [[Provider Health]]
- [[Support and Disputes]]
- [[Incident]]
- [[Risk Register]]

---
Back to [[00 Home]]
