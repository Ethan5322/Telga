---
title: Domain Implementation Plan
type: engineering
status: draft
owner: telga
created: 2026-08-20
updated: 2026-08-20
tags:
  - telga
  - engineering
  - domain
  - plan
related:
  - "[[00 Home]]"
  - "[[Architecture]]"
  - "[[Transaction State Machine]]"
  - "[[Ledger Invariants]]"
  - "[[Testing Strategy]]"
  - "[[Decision Log]]"
depends_on:
  - "[[Domain Glossary]]"
  - "[[Architecture]]"
implements:
  - "[[Product Scope]]"
validates:
  - "[[Ledger Invariants]]"
decision_status: confirmed
---

# Domain Implementation Plan

The domain-first plan for the safe foundation. Written before application code, and kept as the
record of what was built and why.

**Status: implemented and tested.** 103 tests passing, typecheck clean.

## 1. Domain package boundaries

`packages/domain` is **pure**: no I/O, no database, no network, no framework, no clock, no
randomness. Callers pass time in as a `Timestamp`; identifiers are supplied, never generated.

| In | Out |
|---|---|
| Types, enums, transition rules | Persistence |
| Pure functions over those types | HTTP, sockets, retries |
| Invariant enforcement | Scheduling, workers |
| Typed errors | Logging, metrics |

**Why:** purity is what allows the transition table to be asserted exhaustively and the ledger
invariants to be proven without standing anything up. It is also what keeps the SQLite-to-Postgres
move a driver swap ([[Decision Log]] D4).

## 2. TypeScript types

Branded identifiers in `ids.ts`: `MerchantId`, `DeviceId`, `TransactionId`, `LedgerEntryId` and
the rest are distinct types at compile time even though all are strings at runtime. Passing a
`DeviceId` where a `MerchantId` belongs does not compile — merchant isolation begins in the type
system.

## 3. Transaction-state enum

Twelve states as a `const` tuple, with `TransactionState` derived from it. Adding a state to the
tuple forces every exhaustive `switch` and every table to be updated or fail to compile.

## 4. Valid transition map

`VALID_TRANSITIONS` is a frozen record from state to allowed successors — **data, not control
flow**. 18 legal pairs out of 144 ordered pairs; the other 126 throw.

`allValidTransitions()` and `allInvalidTransitions()` enumerate both sets, so the tests assert the
whole space rather than a sample.

`VALUE_DISPOSITION` assigns each state exactly one of `NONE`, `RESERVED`, `UNDER_REVIEW`,
`DEBITED`, `RELEASED` — the machine-checkable form of "no state leaves merchant value
unaccounted for".

## 5. Transaction aggregate

Immutable. `transitionTo` consults the map and returns a **new** frozen transaction with the move
appended to `history`; the original is untouched, including when the move is refused.
`transitionWithAudit` does the same and emits the `AuditEvent` in one step, so a state change
without an audit trail takes deliberate effort.

## 6. Idempotency record

The key derives from **request identity** — merchant, device, client request id — and the payload
is covered by a separate FNV-1a fingerprint ([[Decision Log]] D11).

| Situation | Result |
|---|---|
| Key unseen | `NEW`, record created |
| Key seen, same payload | `REPLAY` returning the original transaction id |
| Key seen, different payload | `IdempotencyPayloadMismatchError` |
| Key in flight, fresh sale attempted | `DuplicateInProgressError` |

## 7. Ledger account and ledger-entry model

Append-only. The class exposes no update, no delete, no void — correcting a figure means posting an
`ADJUSTMENT`, which leaves the original visible.

Every posting is balanced: `signedMinor` makes CREDIT positive and DEBIT negative, and
`assertBalanced` refuses a posting whose entries do not sum to zero.

Account kinds: `MERCHANT_FUNDS` · `TELGA_REVENUE` · `PROVIDER_SETTLEMENT` · `HARDWARE_DEPOSITS` ·
`REFUND_RESERVES` · `BANK_CLEARING` (contra only — [[Decision Log]] D8).

Entry ids derive from the posting id and index, so no randomness enters the ledger and a replay
produces identical ids.

## 8. Balance reservation model

`BalanceReservation` moves through `HELD → UNDER_REVIEW | RELEASED | SETTLED`. The four views in
[[Balance Model]] are **derived** from the ledger plus live reservations, never stored, so they
cannot drift:

```text
Total     = settled position of the merchant funds account
Available = Total − Reserved − UnderReview
```

## 9. Commission and fee placeholders

`CommissionRule` and `FeeRule` exist with `status: 'NOT_YET_CONFIRMED'`. `computeGrossCommission`
and `computeTelgaFee` **throw** `CommissionRateNotConfiguredError`.

This is deliberate. A plausible default rate that reached a merchant would be a fabricated
commercial term. What *is* implemented is `isFeeChargeable`, which returns true only for
`SUCCESSFUL` — the rule that holds whatever the rate turns out to be.

## 10. Provider adapter interface

`AirtimeProvider` exactly as specified: `submit`, `getStatus`, optional `reverse`, `healthCheck`.

`ProviderSubmissionOutcome` can express **"I do not know"** (`INDETERMINATE`). A boolean success
flag would force a timeout to be read as a failure, which is the one thing the platform must never
do. `stateForSubmission` maps `INDETERMINATE` and `DUPLICATE` to `PENDING`.

## 11. Audit-event model

`AuditEvent` carries id, time, action, actor with role and device, merchant, transaction, before
and after state. `AuditLog` is append-only and rejects a duplicate id.

## 12. Error model

16 errors extending `DomainError`, each with a stable `DomainErrorCode` so the API layer can map a
failure onto a merchant-facing string without matching on message text.

`LiveMoneyDisabledError` is the structural guard: `assertSimulated` is called by every
value-bearing constructor, so the domain refuses to operate on anything marked LIVE.

## 13. Test plan

Six files, 103 tests. Full mapping in [[Testing Strategy]]. The two that gate Phase 3 are
duplicate-retry prevention and the ledger sum-to-zero property test.

## 14. Migration strategy

**Implemented.** Three migrations — `001_initial_schema`, `002_ledger_append_only`,
`003_audit_append_only`. Full detail in [[Migration Strategy]]; the layer itself is described in
[[SQLite Persistence Layer]].

1. The ledger table carries database-level triggers against `UPDATE` and `DELETE`, so invariant 1 is
   enforced by the engine rather than by application code. ✅
2. Money columns are integer; there is no `REAL` column in the schema and every table is STRICT. ✅
3. Each migration runs inside a transaction, so a failure rolls back the DDL and its bookkeeping row
   together and a half-applied migration cannot exist. ✅
4. SQLite runs in **WAL** with `synchronous = FULL`, behind the driver interface ([[Decision Log]] D4, D13). ✅
5. **No `down` migrations.** Production rollback is forward-fix only ([[Decision Log]] D14).

## 15. Mock-provider strategy

`services/provider-adapters/mock-airtime` is the only `AirtimeProvider` implementation.

Deterministic: no `Math.random`, no `Date.now`, no `setTimeout`. A virtual clock advances only when
a test calls `advance()`, and seeded behaviour selection is a pure function of the idempotency key,
so a scenario replays exactly.

Eight behaviours: `SUCCESS` · `FAILURE` · `TIMEOUT` · `DELAYED_SUCCESS` · `DELAYED_FAILURE` ·
`MALFORMED_RESPONSE` · `DUPLICATE_CALLBACK` · `OUTAGE`. Every result carries `simulated: true`.

**No HTTP client exists in the package.** A feature flag can be flipped by mistake; missing code
cannot.

## 16. Orchestration

**Implemented.** `createSale`, `resolvePending`, `requireReversal` and `completeReversal` in
`services/api`. Two units of work either side of the provider call, typed results, and eight
injected-failure tests. See [[Transaction Orchestration]] and [[Create Sale Service]].

## Related

- [[Architecture]]
- [[Transaction State Machine]]
- [[Ledger Invariants]]
- [[Testing Strategy]]
- [[Decision Log]]

---
Back to [[00 Home]]
