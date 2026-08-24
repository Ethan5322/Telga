---
title: Transaction Failure Runbook
type: operations
status: draft
owner: telga
created: 2026-08-20
updated: 2026-08-20
tags:
  - telga
  - operations
  - runbook
  - transactions
related:
  - "[[00 Home]]"
  - "[[Runbooks]]"
  - "[[Transaction Orchestration]]"
  - "[[Support and Disputes]]"
  - "[[Database Operations Runbook]]"
depends_on:
  - "[[Transaction Orchestration]]"
implements: []
validates: []
decision_status: pending
---

# Transaction Failure Runbook

Owner: hardware, POS, printer and support operations — **NOT YET ASSIGNED**
([[Founders and Roles]]).

> [!danger] Two standing rules
> **Never treat a timeout as a failure.** A `PENDING` transaction has an unknown outcome, not a bad
> one.
> **Never refund an unknown outcome.** Value stays held until a determination exists.

## Triage by state

| State | What it means | Action |
|---|---|---|
| `PROCESSING` | In flight, or the process died mid-sale | See *stuck in PROCESSING* below |
| `PENDING` | Provider silent, value held, job scheduled | Let the resolver work; tell the merchant not to retry |
| `UNDER_REVIEW` | Past the pending maximum, escalated | Work the support case; answer within 24 hours |
| `REVERSAL_REQUIRED` | Determined: value taken, not delivered | Complete the reversal |
| `FAILED` / `REVERSED` | Value returned | Confirm available balance restored |
| `SUCCESSFUL` | Delivered | Offer the receipt |

## Procedure — merchant says "paid but no airtime"

Follow [[Support and Disputes]]. The orchestration gives you the state directly; do not infer it
from the ledger.

1. Find the transaction by id, receipt, time, amount or reference.
2. Read its state. Give the merchant the **immediate preliminary status** that matches the table above.
3. If `PENDING` or `UNDER_REVIEW`, state plainly that the funds are held and protected.
4. Final answer within **24 hours** unless the provider SLA is faster. If unresolved, update *before* the deadline.

## Procedure — transaction stuck in PROCESSING

This means unit of work 2 failed after the provider was called. The value is still reserved and the
ledger still balances, but nothing is scheduled to resolve it.

1. Confirm: `state = PROCESSING`, reservation `HELD`, `ledgerResidualMinor() = 0`.
2. **Do not** assume the sale failed. Call `getStatus` through the resolver.
3. If the provider confirms an outcome, let the resolver drive it as normal.
4. If the provider cannot say, move it to `PENDING` so a resolution job exists, or escalate to `UNDER_REVIEW` if the pending maximum has already elapsed.
5. Log an incident from [[Incident]] — a stuck `PROCESSING` transaction is a defect, not routine.

> [!note] This is now automated
> [[Recovery Sweep]] finds `PROCESSING`, `RESERVED` and `PENDING` transactions older than a
> configured threshold and drives each to a determinate state, or holds it and escalates. The
> manual procedure above remains as the fallback when the sweep itself reports a failure — see
> [[Recovery Sweep Runbook]]. Assumption **A31 is resolved**.
>
> The sweep runs on a schedule under [[Recovery Worker]]. If transactions are not being
> recovered, check the worker is running before investigating individual transactions —
> [[Worker Operations Runbook]].

## Procedure — under-review backlog growing

1. Check the oldest `AWAITING` and `ESCALATED` rows in `pending_resolutions`.
2. Check provider health — a rising backlog usually means the provider is degraded, not that Telga is.
3. If the provider is down, confirm outage isolation engaged ([[Provider Health]]) so no new airtime sale is being accepted.
4. Every escalated transaction already has an open support case with a reference; work them oldest first.

## Procedure — completing a reversal

Only after a determination that value was taken and delivery did not happen.

1. `requireReversal` moves the transaction to `REVERSAL_REQUIRED` and opens or reuses a support case.
2. `completeReversal` posts the returning adjustment and moves it to `REVERSED`.
3. Confirm the merchant's available balance increased by exactly the sale amount, and that the residual is still zero.
4. The original entries are untouched — the return is **new** entries. Never edit.

## What must never be done

| Action | Why |
|---|---|
| Marking a `PENDING` transaction failed by hand | The outcome is unknown; the provider may still have delivered |
| Refunding an unknown outcome | Drains the platform. See [[Support and Disputes]] |
| Retrying a sale for a merchant "to be safe" | The idempotency guard will refuse it, and if it did not, it would double-vend |
| Editing a ledger entry | Refused by trigger. Post an `ADJUSTMENT` |
| Overriding a provider outage | Takes a customer's cash for a product that will not be delivered |

## Related

- [[Transaction Orchestration]]
- [[Support and Disputes]]
- [[Provider Health]]
- [[Database Operations Runbook]]
- [[Runbooks]]

---
Back to [[00 Home]]
