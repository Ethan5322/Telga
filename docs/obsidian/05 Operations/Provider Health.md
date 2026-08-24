---
title: Provider Health
type: operations
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - operations
  - provider
  - outage
related:
  - "[[00 Home]]"
  - "[[Transaction State Machine]]"
  - "[[Balance Model]]"
  - "[[Support and Disputes]]"
depends_on:
  - "[[Transaction State Machine]]"
implements: []
validates: []
decision_status: confirmed
---

# Provider Health

## Outage isolation

When Telga is online but an airtime provider is unavailable, **only airtime is blocked**. Other
approved healthy services stay available.

```mermaid
flowchart TD
    REQ(["Merchant requests a sale"]) --> T{"Is Telga online?"}

    T -->|"No"| OFF["ALL new sales stop<br/>history · settings · support remain<br/>NO offline vending"]
    OFF --> SYNC["Resume only after secure reconnect<br/>and state synchronization"]

    T -->|"Yes"| P{"Is the provider<br/>for this product healthy?"}

    P -->|"Yes"| SELL["Normal sale proceeds"]
    P -->|"No"| BLOCK["Block THIS product only"]

    BLOCK --> MSG["Plain-language status<br/>English and Amharic"]
    BLOCK --> NOCHG["NO charge · NO debit<br/>NO commission · NO customer transaction"]
    BLOCK --> EVT["Record ProviderHealthEvent<br/>internal only"]
    BLOCK --> OTHER["Other approved healthy services<br/>stay available"]

    BLOCK --> NOOVR["NO merchant override"]

    classDef ok fill:#d9f0dd,stroke:#2f7d3f,color:#10331a
    classDef bad fill:#f8d7da,stroke:#a33,color:#3a1114
    classDef info fill:#dde6f5,stroke:#3a5c94,color:#12203a
    class SELL,OTHER ok
    class BLOCK,OFF,NOOVR bad
    class MSG,EVT,NOCHG,SYNC info
```

> [!warning] No merchant override
> A merchant cannot force a sale through a provider Telga believes is down. An override is how a
> merchant takes a customer's cash for a product that will never be delivered.

## Telga offline

| Allowed while offline | Blocked while offline |
|---|---|
| Transaction history | All new sales |
| Settings | Funding submission |
| Support | Anything touching a provider |

**No offline vending in the pilot.** Selling resumes only after a secure reconnect and full state
synchronization — an in-flight transaction must be resolved against the server before the counter
reopens.

## Provider timeout and manual review

The path a transaction takes when a provider goes silent.

```mermaid
flowchart TD
    SUB(["Provider request submitted"]) --> PROC["PROCESSING<br/>reservation held"]

    PROC --> W{"Provider responds<br/>within timeout?"}
    W -->|"Success"| OK["SUCCESSFUL<br/>debit + commission"]
    W -->|"Confirmed failure"| F["FAILED<br/>reservation released"]
    W -->|"Silence"| PEND["PENDING<br/>reservation STILL held"]

    PEND --> MSG["Merchant sees:<br/>still being checked, do not retry yet"]
    PEND --> POLL["Background worker polls<br/>+ awaits callback"]

    POLL --> R{"Resolved?"}
    R -->|"Success"| OK
    R -->|"Failure"| F
    R -->|"Still unknown past<br/>provider pending maximum<br/>default 5 minutes"| UR["UNDER REVIEW<br/>value moves to under-review bucket"]

    UR --> ESC["Escalate to operations queue"]
    ESC --> OPS{"Operations determination"}
    OPS -->|"Delivered"| OK
    OPS -->|"Not delivered"| F
    OPS -->|"Value taken, not delivered"| REVREQ["REVERSAL_REQUIRED"]
    REVREQ --> REV["REVERSED<br/>authorized adjustment entry"]

    classDef ok fill:#d9f0dd,stroke:#2f7d3f,color:#10331a
    classDef bad fill:#f8d7da,stroke:#a33,color:#3a1114
    classDef hold fill:#fdf1cc,stroke:#9a7b12,color:#33280a
    class OK ok
    class F,REVREQ,REV bad
    class PEND,UR,ESC,POLL,MSG hold
```

**A timeout is never a failure.** The reservation is held for the whole of this path — the
merchant's value is never released on a guess, and never debited on a guess.

## When a lookup fails rather than answers

The recovery sweep classifies a failed status lookup rather than guessing at it. The distinction
matters because only two of these categories may move a merchant's money:

| Category | Meaning | Effect on funds |
|---|---|---|
| `CONFIRMED_SUCCESS` | Delivered | Settle |
| `CONFIRMED_FAILURE` | Definitely not delivered | Release |
| `STILL_PROCESSING` | Provider is still working | **Hold** |
| `UNKNOWN` | Provider does not recognise the reference | **Hold** |
| `PROVIDER_UNAVAILABLE` | Unreachable, refused, timed out | **Hold** |
| `MALFORMED_RESPONSE` | Body could not be understood | **Hold** |
| `AUTH_OR_CONFIG_FAILURE` | **Telga is misconfigured** | **Hold** + operational alert |

`AUTH_OR_CONFIG_FAILURE` is never presented to a merchant as a failed sale. It is a platform
fault, and it pages someone. See [[Recovery Sweep]].

## Health signals

| Signal | Source |
|---|---|
| `healthCheck()` result | Provider adapter |
| Submission error rate | `TransactionAttempt` outcomes |
| Response latency p95 | [[Observability]] |
| Pending rate | Share of transactions reaching `PENDING` |
| Under-review age | Oldest unresolved transaction |

Thresholds that trip a provider into "unhealthy" are **NOT YET CONFIRMED** — they depend on the
provider's contracted SLA. See the provider agreement terms (commercial material, kept outside this repository).

## Related

- [[Transaction State Machine]]
- [[Balance Model]]
- [[Support and Disputes]]
- [[Runbooks]]

---
Back to [[00 Home]]
