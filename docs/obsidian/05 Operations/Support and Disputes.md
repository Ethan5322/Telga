---
title: Support and Disputes
type: operations
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - operations
  - support
  - disputes
related:
  - "[[00 Home]]"
  - "[[Transaction State Machine]]"
  - "[[Provider Health]]"
  - "[[Runbooks]]"
depends_on:
  - "[[Transaction State Machine]]"
implements: []
validates: []
decision_status: confirmed
---

# Support and Disputes

The defining complaint is **"paid but no airtime"**. How Telga answers it is the product.

## Complaint flow

```mermaid
flowchart TD
    C(["Customer tells merchant:<br/>paid but no airtime"]) --> S["Merchant searches transaction<br/>ID · receipt · time · amount · reference"]
    S --> CHK["Check Telga state<br/>+ provider status"]

    CHK --> R{"Result"}

    R -->|"SUCCESSFUL"| OK["Show proof of delivery<br/>provider reference + receipt"]
    R -->|"CONFIRMED FAILED"| FAIL["No charge was made<br/>reservation released"]
    R -->|"PENDING"| PEND["Still being checked.<br/>Do not retry yet."]
    R -->|"UNDER REVIEW"| UR["Funds held and protected<br/>case escalated"]

    PEND --> PREL["Give immediate<br/>preliminary status"]
    UR --> PREL
    PREL --> T24{"Resolved within 24h?<br/>or faster provider SLA"}

    T24 -->|"Yes"| FIN["Final answer to merchant"]
    T24 -->|"No"| UPD["Update BEFORE the deadline:<br/>next deadline + protected-funds status"]
    UPD --> T24

    FIN --> CAUSE{"Responsible party"}
    CAUSE -->|"Verified provider-side non-delivery"| PROT["Telga temporarily protects merchant<br/>then recovers from provider<br/>where contractually possible"]
    CAUSE -->|"Wrong details, misuse, fraud,<br/>unrecorded payment"| EVID["Evidence required<br/>before any adjustment"]
    CAUSE -->|"Outcome genuinely unknown"| NOAUTO["NO automatic refund<br/>stays under review"]

    classDef ok fill:#d9f0dd,stroke:#2f7d3f,color:#10331a
    classDef bad fill:#f8d7da,stroke:#a33,color:#3a1114
    classDef hold fill:#fdf1cc,stroke:#9a7b12,color:#33280a
    class OK,FIN,PROT ok
    class FAIL,EVID bad
    class PEND,UR,PREL,UPD,NOAUTO hold
```

## Service commitments

| Commitment | Value |
|---|---|
| Preliminary status | Immediate |
| Final answer | Within **24 hours**, unless the provider SLA is faster |
| If unresolved | Update **before** the deadline, with the next deadline and the protected-funds status |

Missing a deadline silently is the failure that loses a merchant. An update that says "still
checking, next update by 14:00, your funds are held" keeps the relationship.

## Liability

| Cause | Telga's position |
|---|---|
| **Verified** provider-side non-delivery | Telga temporarily protects the merchant, then recovers from the responsible provider where contractually possible |
| Wrong recipient details entered | Evidence required; no automatic adjustment |
| Merchant misuse or fraud | Evidence required; case escalated to a dispute |
| Unrecorded payment (cash not entered) | Evidence required |
| Outcome genuinely unknown | **No automatic refund.** Stays `UNDER_REVIEW` |

> [!warning] Never auto-refund an unknown outcome
> Refunding on uncertainty is how a vending platform is drained. The transaction stays under
> review until the provider gives a determinate answer or the contractual reversal path resolves it.

Recovery from a provider depends on the reversal, refund and settlement terms in the provider
agreement — **NOT YET CONFIRMED**, tracked in the provider agreement terms (commercial material, kept outside this repository).

## Cases the machine opens for you

Most under-review cases are not raised by a merchant — the recovery sweep opens them
automatically when a transaction passes its pending deadline, with a reference the merchant can
quote before they have even called. Exactly one case per transaction; a repeated sweep reuses it.

How to work one is in [[Manual Review Runbook]]. The short version: age is not evidence, an
unknown outcome is never refunded, and a reversal needs a supervisor.

## Case record

Merchant · transaction · reported symptom · Telga state at report time · provider status ·
preliminary answer and time · final answer and time · responsible party · evidence ·
adjustment reference · operator.

## Escalation

Support escalation ownership is a launch gate and is **NOT YET ASSIGNED** — see
[[Founders and Roles]] and [[Launch Gates]].

## Related

- [[Transaction State Machine]]
- [[Provider Health]]
- [[Runbooks]]

---
Back to [[00 Home]]
