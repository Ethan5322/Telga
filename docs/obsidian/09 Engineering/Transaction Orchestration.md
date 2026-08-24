---
title: Transaction Orchestration
type: engineering
status: draft
owner: telga
created: 2026-08-20
updated: 2026-08-20
tags:
  - telga
  - engineering
  - orchestration
  - transactions
related:
  - "[[00 Home]]"
  - "[[Create Sale Service]]"
  - "[[Mock Provider Behavior]]"
  - "[[Transaction State Machine]]"
  - "[[SQLite Persistence Layer]]"
  - "[[Idempotency]]"
  - "[[Transaction Failure Runbook]]"
depends_on:
  - "[[SQLite Persistence Layer]]"
  - "[[Transaction State Machine]]"
implements:
  - "[[Architecture]]"
validates:
  - "[[Ledger Invariants]]"
decision_status: confirmed
---

# Transaction Orchestration

`services/api/src/application` — the layer that binds the domain state machine, the persistence
driver and the mock provider into one sale.

**Implemented and tested.** 74 orchestration tests. No live provider, no live money.

## Why there are two units of work, not one

The provider call sits **between** two database transactions, and it has to. A SQLite transaction
is synchronous; holding one open across a network call would block every other writer for as long
as the provider takes to answer — and the provider is exactly the component that might not answer
at all.

```mermaid
sequenceDiagram
    autonumber
    participant POS as Merchant POS
    participant SVC as createSale
    participant DOM as Domain
    participant DB as SQLite
    participant PRV as Mock provider

    POS->>SVC: SaleRequest (client request id)
    SVC->>DB: find merchant · device · idempotency record
    SVC->>SVC: validate product, amount, recipient
    SVC->>PRV: healthCheck()
    alt provider unhealthy
        PRV-->>SVC: healthy = false
        SVC-->>POS: PROVIDER_UNAVAILABLE — no transaction, no charge
    else healthy
        rect rgb(240,244,250)
            Note over SVC,DB: UNIT OF WORK 1 — atomic
            SVC->>DOM: createTransaction (CREATED)
            SVC->>DB: INSERT transaction
            SVC->>DOM: transition CREATED → VALIDATED
            SVC->>DB: balanceFor(merchant)
            SVC->>DOM: assertSufficientAvailable
            SVC->>DB: reserve — postings + reservation + audit
            SVC->>DOM: transition VALIDATED → RESERVED
            SVC->>DB: INSERT idempotency record
        end
        SVC->>DOM: transition RESERVED → PROCESSING
        SVC->>PRV: submit(request, context TRAINING)
        PRV-->>SVC: CONFIRMED_SUCCESS | CONFIRMED_FAILURE | INDETERMINATE
        rect rgb(240,244,250)
            Note over SVC,DB: UNIT OF WORK 2 — atomic
            SVC->>DOM: transition PROCESSING → outcome
            SVC->>DB: ledger operation + audit + idempotency result
        end
        SVC-->>POS: typed result with nextAction
    end
```

The gap between the two units of work is precisely why `PENDING` exists. If the process dies
mid-flight, the merchant's value is still held by unit of work 1, and the transaction's own state
is what [[Recovery Sweep]] finds — `RESERVED` proves the provider was never called, `PROCESSING`
means the outcome is unknown. That sweep is what makes this design safe to run unattended.

## Unit-of-work rollback

```mermaid
flowchart TD
    START(["Operation begins"]) --> BEGIN["BEGIN"]
    BEGIN --> W1["Write 1 — transaction row"]
    W1 --> W2["Write 2 — reservation"]
    W2 --> W3["Write 3 — ledger postings"]
    W3 --> W4["Write 4 — audit event"]
    W4 --> W5["Write 5 — idempotency result"]
    W5 --> COMMIT["COMMIT"]
    COMMIT --> OK(["Consistent: state · reservation · entries · audit · result"])

    W1 -->|throws| RB
    W2 -->|throws| RB
    W3 -->|throws| RB
    W4 -->|throws| RB
    W5 -->|throws| RB

    RB["ROLLBACK — every write in this unit discarded"] --> INV{"Invariants re-checked"}
    INV --> I1["Ledger residual = 0"]
    INV --> I2["available + reserved + under review = total"]
    INV --> I3["No partial reservation"]
    INV --> RAISE["Error propagates.<br/>NEVER reported as success."]

    classDef bad fill:#f8d7da,stroke:#a33,color:#3a1114
    classDef ok fill:#d9f0dd,stroke:#2f7d3f,color:#10331a
    class RB,RAISE bad
    class OK,I1,I2,I3 ok
```

Failures are injected at eight points in the tests — before reservation, after reservation before
submission, after provider success before finalization, during ledger posting, during audit
creation and during idempotency result storage. After every one, the ledger still balances and the
four views still reconcile.

**Nothing catches an error and reports success.** An unknown outcome becomes `PENDING`, which is an
honest answer, not a hopeful one.

## Idempotent retry

```mermaid
flowchart TD
    TAP(["Merchant presses Confirm"]) --> KEY["Derive key from<br/>merchant + device + client request id"]
    KEY --> LOOK{"Key already stored<br/>for this merchant?"}

    LOOK -->|"No"| NEW["Create ONE transaction<br/>reserve · submit"]
    LOOK -->|"Yes, same payload"| DUP["DUPLICATE_REQUEST<br/>return the original transaction and its current state"]
    LOOK -->|"Yes, different payload"| MIS["PAYLOAD_MISMATCH<br/>refuse. Never overwrite."]

    NEW --> OUT["Outcome recorded against the key"]
    DUP --> SHOW["POS shows the existing state"]

    subgraph GUARDS["What a second attempt hits"]
        G1["Idempotency PK (merchant_id, key)"]
        G2["Unique (merchant_id, idempotency_key) on transactions"]
        G3["Reservation WHERE status = 'HELD'"]
        G4["Pending job WHERE status = 'AWAITING'"]
    end

    DUP -.-> G1
    NEW -.-> G2

    classDef bad fill:#f8d7da,stroke:#a33,color:#3a1114
    classDef ok fill:#d9f0dd,stroke:#2f7d3f,color:#10331a
    class MIS bad
    class NEW,DUP ok
```

The key derives from **request identity**, not payload contents ([[Decision Log]] D11): if it
hashed the amount, changing the amount would change the key and a tampered request would look like
a brand new sale.

Ten rapid presses produce one transaction, one reservation and one debit. Tested.

## Services

| Service | Responsibility |
|---|---|
| `createSale` | The sale itself. See [[Create Sale Service]] |
| `resolvePending` | Status lookup for a PENDING transaction; escalation past the deadline |
| `requireReversal` | `PENDING`/`UNDER_REVIEW` → `REVERSAL_REQUIRED`, opens a support case |
| `completeReversal` | `REVERSAL_REQUIRED` → `REVERSED`, posts the returning adjustment. **Requires supervisor approval** |
| `recoverInFlight` | Unattended sweep for transactions left in flight — [[Recovery Sweep]] |

## Provider boundary

The orchestration calls only `submit`, `getStatus`, `healthCheck` and — through the mock contract
only — `reverse`. The context always carries `mode: 'TRAINING'`, and a non-TRAINING mode is refused
at the door before anything is read or written.

Preserved on every path: internal transaction id · provider reference · idempotency key ·
correlation id · simulated flag · provider outcome and a **coarse, safe** error category. Never a
raw provider body, never a credential.

## Related

- [[Create Sale Service]]
- [[Mock Provider Behavior]]
- [[Transaction Failure Runbook]]
- [[Transaction State Machine]]
- [[Idempotency]]
- [[SQLite Persistence Layer]]

---
Back to [[00 Home]]
