---
title: Recovery Sweep
type: engineering
status: draft
owner: telga
created: 2026-08-20
updated: 2026-08-20
tags:
  - telga
  - engineering
  - recovery
  - orchestration
related:
  - "[[00 Home]]"
  - "[[Transaction Orchestration]]"
  - "[[Recovery Configuration]]"
  - "[[Recovery Sweep Runbook]]"
  - "[[Manual Review Runbook]]"
  - "[[Transaction State Machine]]"
  - "[[Balance Model]]"
depends_on:
  - "[[Transaction Orchestration]]"
implements:
  - "[[Architecture]]"
validates:
  - "[[Ledger Invariants]]"
decision_status: confirmed
---

# Recovery Sweep

`services/api/src/application/recovery/` — unattended recovery for transactions left in flight.

**Implemented and tested.** 61 recovery tests. This is what closes assumption **A31**.

The sweep must be invoked. [[Recovery Worker]] is the supervised loop that invokes it unattended, with backoff, health and graceful shutdown.

## Why it exists

[[Transaction Orchestration]] puts the provider call between two units of work, which leaves a gap:
a crash in that gap leaves a transaction at `RESERVED` (provider never called) or `PROCESSING` (we
do not know). Before this service, both states held a merchant's money with nothing scheduled to
resolve them.

## The rule everything obeys

> **Only a determinate provider answer may move a merchant's money.**

Silence, an unreachable provider, a malformed body and a misconfigured credential all mean the
same thing operationally — *we do not know* — and every one of them holds the value exactly where
it is.

## Recovery scan

```mermaid
flowchart TD
    START(["recoverInFlight(deps)"]) --> AUDIT["Audit: RECOVERY_SCAN_STARTED"]
    AUDIT --> CUT["cutoff = now − minimum recovery age<br/>across base and per-provider policies"]
    CUT --> FIND["Find PROCESSING · RESERVED · PENDING<br/>where updated_at ≤ cutoff<br/>oldest first, up to batchLimit"]
    FIND --> LOOP{"Next candidate"}

    LOOP -->|"none"| REPORT(["SweepReport"])
    LOOP --> AGE{"age ≥ this provider's<br/>recovery age?"}
    AGE -->|"No"| SKIP["SKIPPED_TOO_RECENT"] --> LOOP
    AGE -->|"Yes"| CLAIM{"Claim the lease"}

    CLAIM -->|"lost"| PREV["SKIPPED_CLAIMED_BY_OTHER<br/>audit RECOVERY_DUPLICATE_WORKER_PREVENTED"] --> LOOP
    CLAIM -->|"won"| REC["recoverOne"]
    REC --> REL["Release the lease"] --> LOOP

    REC -->|"throws"| FAILED["RECOVERY_FAILED result<br/>audit RECOVERY_ATTEMPT_FAILED<br/>batch continues"] --> REL

    classDef ok fill:#d9f0dd,stroke:#2f7d3f,color:#10331a
    classDef bad fill:#f8d7da,stroke:#a33,color:#3a1114
    class REPORT ok
    class FAILED,PREV bad
```

`PENDING` is swept too. `resolvePending` handles a pending transaction when something calls it, but
an unattended system has nothing calling it — without `PENDING` here, a transaction the sweep
itself moved to pending would sit holding money forever and the escalation deadline would never be
enforced.

## Worker claim and concurrency

```mermaid
sequenceDiagram
    autonumber
    participant W1 as Worker 1
    participant DB as recovery_claims
    participant W2 as Worker 2

    W1->>DB: INSERT ... ON CONFLICT DO UPDATE<br/>WHERE status='RELEASED' OR expires_at ≤ now
    DB-->>W1: changes = 1 → claimed
    W2->>DB: same statement, same transaction
    DB-->>W2: changes = 0 → refused
    Note over W2: SKIPPED_CLAIMED_BY_OTHER<br/>audit RECOVERY_DUPLICATE_WORKER_PREVENTED

    W1->>W1: recover (provider lookup + one unit of work)
    W1->>DB: release lease

    Note over DB: A worker that dies never releases.<br/>The lease expires, so the transaction<br/>is reclaimable rather than stranded.
```

One atomic statement decides ownership. The `WHERE` clause on the conflict branch is the whole
mechanism: a live lease held by someone else leaves `changes = 0`.

## PROCESSING recovery

```mermaid
flowchart TD
    P(["PROCESSING, older than threshold"]) --> LOOK["getStatus using the ORIGINAL<br/>transaction id and idempotency key"]
    LOOK --> OUT{"Classified outcome"}

    OUT -->|"CONFIRMED_SUCCESS"| S["→ SUCCESSFUL<br/>finalize once · close pending · record result"]
    OUT -->|"CONFIRMED_FAILURE"| F["→ FAILED<br/>release once · close pending · record result"]
    OUT -->|"STILL_PROCESSING · UNKNOWN<br/>PROVIDER_UNAVAILABLE · MALFORMED<br/>AUTH_OR_CONFIG_FAILURE"| H["→ PENDING<br/>reservation stays HELD"]

    S --> NOCOMM["NO commission entry —<br/>no rate is configured"]

    classDef ok fill:#d9f0dd,stroke:#2f7d3f,color:#10331a
    classDef bad fill:#f8d7da,stroke:#a33,color:#3a1114
    classDef hold fill:#fdf1cc,stroke:#9a7b12,color:#33280a
    class S,NOCOMM ok
    class F bad
    class H hold
```

## RESERVED recovery — evidence, not assumption

```mermaid
flowchart TD
    R(["RESERVED, older than threshold"]) --> EV{"provider_reference present?"}

    EV -->|"No — proof it was never called"| PROVEN["Provider was never called.<br/>createSale moves to PROCESSING BEFORE it submits,<br/>so RESERVED means no submission happened."]
    PROVEN --> PATH["→ PROCESSING → FAILED<br/>(RESERVED → FAILED is not a legal edge)"]
    PATH --> RELEASE["Release the reservation.<br/>The only case where funds move<br/>without a provider answer."]

    EV -->|"Yes — uncertain"| UNC["Submission cannot be ruled out"]
    UNC --> TOPEND["→ PROCESSING → PENDING<br/>reservation preserved"]
    TOPEND --> LOOKUP["Status lookup, then the PROCESSING rules"]

    classDef ok fill:#d9f0dd,stroke:#2f7d3f,color:#10331a
    classDef hold fill:#fdf1cc,stroke:#9a7b12,color:#33280a
    class PROVEN,RELEASE ok
    class UNC,TOPEND,LOOKUP hold
```

**A `RESERVED` record is never treated as successfully submitted without evidence**, and a
`RESERVED` row that somehow carries a provider reference is treated as uncertain rather than as
proof of nothing having happened.

## Unknown outcome to PENDING

```mermaid
flowchart TD
    U(["Indeterminate lookup"]) --> STATE["Ensure state is PENDING"]
    STATE --> JOB["Ensure pending_resolutions row exists"]
    JOB --> CLOCK["first_pending_at = when the transaction<br/>entered the in-flight state,<br/>NOT when the sweep noticed"]
    CLOCK --> ATT["attempts += 1<br/>next_check_at = now + interval<br/>last_outcome_category = safe category"]
    ATT --> HOLD["Reservation stays HELD.<br/>No debit. No release. No refund."]
    ATT --> ALERT{"AUTH_OR_CONFIG_FAILURE?"}
    ALERT -->|"Yes"| OPS["operationalAlert = true<br/>audit RECOVERY_ATTEMPT_FAILED<br/>NOT shown as a failed sale"]
    ALERT -->|"No"| PEND["MOVED_TO_PENDING"]

    classDef hold fill:#fdf1cc,stroke:#9a7b12,color:#33280a
    classDef bad fill:#f8d7da,stroke:#a33,color:#3a1114
    class HOLD,PEND hold
    class OPS bad
```

A stuck transaction does not get a fresh grace period because a worker only just reached it — the
merchant's money has already been held for that time.

## PENDING to UNDER_REVIEW

```mermaid
flowchart TD
    P(["PENDING, still indeterminate"]) --> CHK{"Past deadline<br/>OR attempts ≥ max?"}
    CHK -->|"No"| WAIT["Stay PENDING · schedule next check"]
    CHK -->|"Yes"| ESC["→ UNDER_REVIEW"]

    ESC --> POST["DEBIT reserved · CREDIT under review<br/>balanced append-only postings"]
    POST --> EXCL["Excluded from available balance"]
    ESC --> CASE["Exactly one support case<br/>(reused if one already exists)"]
    CASE --> FLAG["manual_review_status = OPEN<br/>pending job = ESCALATED"]
    ESC --> NEVER["NO automatic refund.<br/>NOT marked failed without evidence.<br/>Resolution requires authorized support,<br/>and a reversal requires supervisor approval."]

    classDef hold fill:#fdf1cc,stroke:#9a7b12,color:#33280a
    classDef bad fill:#f8d7da,stroke:#a33,color:#3a1114
    class ESC,POST,EXCL,CASE,FLAG hold
    class NEVER bad
```

## Audit trail

Nobody was watching when an unattended recovery ran, so every step is recorded:
`RECOVERY_SCAN_STARTED` · `RECOVERY_CLAIMED` · `RECOVERY_DUPLICATE_WORKER_PREVENTED` ·
`RECOVERY_STATUS_LOOKUP` · `RECOVERY_OUTCOME_RECEIVED` · `RECOVERY_RECOVERED_SUCCESSFUL` ·
`RECOVERY_RECOVERED_FAILED` · `RECOVERY_MOVED_TO_PENDING` · `RECOVERY_ESCALATED_UNDER_REVIEW` ·
`RECOVERY_ATTEMPT_FAILED` · `MANUAL_REVIEW_CREATED`

Audit details carry a **safe outcome category** only — never a provider body, never a credential.

## Idempotency

Re-running a sweep cannot duplicate a debit, a release, a reversal or a support case. Four
independent guards make that true, and each has a test:

| Guard | Mechanism |
|---|---|
| Single ownership | `recovery_claims` atomic claim |
| Single finalization | Reservation update guarded on `HELD` |
| Single escalation | Pending job guarded on `AWAITING` |
| Single case | `findSupportCaseByTransaction` before create, plus a unique reference index |

## Related

- [[Recovery Configuration]]
- [[Recovery Sweep Runbook]]
- [[Manual Review Runbook]]
- [[Transaction Orchestration]]
- [[Transaction State Machine]]
- [[Observability]]

---
Back to [[00 Home]]
