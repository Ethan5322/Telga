---
title: User Journeys
type: product
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - product
  - ux
  - journeys
related:
  - "[[00 Home]]"
  - "[[Transaction State Machine]]"
  - "[[Screen Inventory]]"
  - "[[Receipt Specification]]"
depends_on:
  - "[[Transaction State Machine]]"
implements:
  - "[[Product Scope]]"
validates: []
decision_status: confirmed
---

# User Journeys

## Merchant airtime sale journey

The counter-level flow. Seventeen steps from authentication to audit, as specified in `CLAUDE.md`.

```mermaid
flowchart TD
    A["1. Authenticate merchant<br/>operator PIN on registered device"] --> B["2. Select Airtime"]
    B --> C["3. Select provider<br/>if more than one"]
    C --> D["4. Select amount"]
    D --> E["5. Enter and confirm recipient"]
    E --> F["6. Server validates<br/>merchant · device · product · limits · capacity"]
    F -->|Rejected| REJ["Show reason<br/>NO charge, NO debit, NO commission"]
    F -->|Accepted| G["7. Create transaction<br/>+ idempotency record"]
    G --> H["8. Reserve balance"]
    H --> I["9. Submit provider request"]
    I --> J["10. Show PROCESSING"]

    J -->|Provider confirms success| K["11. Finalize debit<br/>+ commission"]
    J -->|Provider confirms failure| L["12. Release reservation"]
    J -->|No response| M["13. PENDING<br/>reservation held"]

    M --> N["14. Poll or callback resolves"]
    N -->|Confirmed| K
    N -->|Confirmed failure| L
    N -->|Still unresolved past provider maximum| O["15. UNDER REVIEW<br/>escalate to operations"]

    K --> P["16. Receipt available"]
    L --> P
    O --> P
    REJ --> Q
    P --> Q["17. Emit audit event + metrics"]

    classDef good fill:#d9f0dd,stroke:#2f7d3f,color:#10331a
    classDef bad fill:#f8d7da,stroke:#a33,color:#3a1114
    classDef wait fill:#fdf1cc,stroke:#9a7b12,color:#33280a
    class K,P good
    class L,REJ bad
    class M,O wait
```

> [!important] The merchant never sees a guess
> Between step 10 and step 14 the honest answer is "still being checked". The UI says exactly
> that, and blocks retry. See [[Idempotency]] and [[Amharic Strings]].

## Journey variants

| Journey | Entry | Notes |
|---|---|---|
| Reprint a receipt | Transaction details screen | Emits `ReprintEvent`, never a sale — [[Receipt Specification]] |
| Find a transaction | Transaction search | By ID, receipt, time, amount, or reference |
| Raise a support case | Transaction details or support screen | [[Support and Disputes]] |
| Submit funding | Funding screen | Simulated only — [[Funding Verification]] |
| Sale blocked by outage | Airtime selection | Airtime blocked, other approved services stay available — [[Provider Health]] |
| Device offline | Any screen | New sales stop; history, settings and support remain — [[Provider Health]] |

## Operations journeys

- **Verify a funding submission** — operations verifier, second approval for high-value; see [[Funding Verification]]
- **Resolve an under-review transaction** — operations reviewer; see [[Runbooks]]
- **Daily reconciliation** — a *separate* reviewer from the verifier; see [[Funding Verification]]

## Related

- [[Transaction State Machine]]
- [[Screen Inventory]]
- [[Support and Disputes]]
- [[Provider Health]]

---
Back to [[00 Home]]
