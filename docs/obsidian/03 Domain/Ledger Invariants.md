---
title: Ledger Invariants
type: domain
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - domain
  - ledger
  - money
related:
  - "[[00 Home]]"
  - "[[Balance Model]]"
  - "[[Transaction State Machine]]"
  - "[[Funding Verification]]"
depends_on:
  - "[[Domain Glossary]]"
implements: []
validates:
  - "[[Transaction State Machine]]"
decision_status: confirmed
---

# Ledger Invariants

Nine rules. They are enforced by **tests**, not by convention — see [[Testing Strategy]]. A change
that breaks one of these is a defect even if every screen still works.

## The nine

| # | Invariant | How it is enforced |
|---|---|---|
| 1 | The historical ledger is **append-only** | No `UPDATE` or `DELETE` on `LedgerEntry`; enforced at the database layer |
| 2 | Every debit has a matching credit **or** a documented pending state | Property test: entries sum to zero once pending states are resolved |
| 3 | **Available** excludes reserved and under-review amounts | Balance is derived, never stored as a mutable field |
| 4 | Under-review funds are **not** available, **not** revenue, **not** final commission | Separate bucket in [[Balance Model]]; excluded from revenue reports |
| 5 | A reprint **never** creates a sale | `ReprintEvent` has no ledger effect; test asserts entry count unchanged |
| 6 | An uncertain retry reuses the same logical transaction and idempotency key | See [[Idempotency]] |
| 7 | Merchant, provider, and Telga references remain traceable | Every entry carries merchant, transaction, provider reference, and rule version |
| 8 | Corrections are **authorized adjustment entries**, never silent edits | Adjustment requires an approver and an audit event |
| 9 | Money uses **integer minor units** or safe decimal — never binary floating point | `Money` type has no float constructor and no float accessor |

## Enforced by the database, not only by TypeScript

Invariants 1 and 8 are enforced in **two independent layers**:

| Layer | Mechanism |
|---|---|
| TypeScript | `AppendOnlyLedger` and `LedgerDriver` expose no update, delete, void or setter |
| **Database** | Migration `002` installs `BEFORE UPDATE` and `BEFORE DELETE` triggers on `ledger_entries` that `RAISE(ABORT, ...)` |

The second layer covers what the first cannot: a console session, a future ORM, a migration, or a
bug that reaches the connection directly. Tests attempt raw SQL `UPDATE` and `DELETE` on the
connection and assert both fail — see [[SQLite Persistence Layer]].

`audit_events` carries the same pair of triggers (migration `003`), because an audit trail that
can be edited is not an audit trail.

Invariant 9 is enforced by the engine too: every table is **STRICT** and there is no `REAL` column
anywhere in the schema, so a float cannot be stored in a money column even by direct SQL.

## Held by the orchestration too

[[Transaction Orchestration]] adds a third layer to invariants 5 and 6: a repeated release cannot
double-credit and a repeated finalization cannot double-debit, because the reservation update is
guarded on its current status and changes one row or none. Eight injected-failure tests confirm
that the residual stays zero after a failure at any stage.

## Account segregation

Value never mixes between these accounts:

| Account | Holds |
|---|---|
| Merchant funds | Merchant selling balance |
| Telga revenue | Telga fees actually earned |
| Provider settlement | What is owed to or from a provider |
| Hardware deposits | Refundable device deposits |
| Refund reserves | Value held against expected reversals |

## Currency

Ethiopian birr (ETB), stored as **integer santim** (1 birr = 100 santim). All pilot values are
simulated. See [[Balance Model]].

## Commission and fee recording

The merchant's primary display shows **net commission**. The ledger stores more:

- gross commission
- Telga fee
- net commission
- calculation version (`CommissionRule` / `FeeRule` version)
- any adjustments

Storing the rule version is what makes a historical figure re-derivable after rates change.
**Actual rates are NOT YET CONFIRMED** — see the provider agreement terms (commercial material, kept outside this repository).

## Fee rules for the pilot

- A percentage service fee applies **only** to a successful completed sale.
- **No** ordinary fee for blocked, rejected, failed, pending, duplicate, or normally reversed requests.
- The customer pays the stated product value; **no undisclosed surcharge**.

## Related

- [[Balance Model]]
- [[Transaction State Machine]]
- [[Idempotency]]
- [[Funding Verification]]

---
Back to [[00 Home]]
