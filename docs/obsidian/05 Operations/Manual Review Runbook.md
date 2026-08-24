---
title: Manual Review Runbook
type: operations
status: draft
owner: telga
created: 2026-08-20
updated: 2026-08-20
tags:
  - telga
  - operations
  - runbook
  - manual-review
related:
  - "[[00 Home]]"
  - "[[Runbooks]]"
  - "[[Support and Disputes]]"
  - "[[Recovery Sweep]]"
  - "[[Balance Model]]"
  - "[[Founders and Roles]]"
depends_on:
  - "[[Recovery Sweep]]"
implements: []
validates: []
decision_status: pending
---

# Manual Review Runbook

What to do with a transaction the machine could not resolve.

Owner: hardware, POS, printer and support operations, with finance for approvals — **BOTH NOT YET
ASSIGNED** ([[Founders and Roles]]).

## What an UNDER_REVIEW case means

The provider never gave a determinate answer within the configured window. The merchant's value
sits in the **under-review bucket**: excluded from available balance, still part of their total,
and **not** written off.

| Fact | Value |
|---|---|
| Merchant value | Held, not lost |
| Available balance | Reduced by the held amount |
| Support case | Open, with a reference the merchant can quote |
| Automatic refund | **Never** |
| Automatic failure | **Never** without evidence |

## Working a case

1. **Answer the merchant first.** Immediate preliminary status, final answer within 24 hours — [[Support and Disputes]].
2. **Gather the evidence.** Transaction id, provider reference, correlation id, the pending job's `attempts` and `last_outcome_category`, and the audit trail for the transaction.
3. **Ask the provider directly.** The automated lookup has already failed; this is the human escalation the provider agreement is supposed to define (those terms are commercial material, kept outside this repository term 10).
4. **Record what the provider says**, with who said it and when.

## Resolving a case

| Determination | Action | Who may authorize |
|---|---|---|
| Provider confirms **delivered** | Resolve to `SUCCESSFUL`; value settles | Authorized support |
| Provider confirms **not delivered**, no value taken | Resolve to `FAILED`; value returns to available | Authorized support |
| Provider confirms **value taken, not delivered** | `REVERSAL_REQUIRED` → `REVERSED` | **Supervisor approval required** |
| Provider still cannot say | Case stays open. Keep the merchant updated before each deadline | — |

> [!danger] Supervisor approval
> A refund, a reversal or any exceptional balance action requires a supervisor. `completeReversal`
> refuses any role outside `OPS_APPROVER` and `ADMIN`, and records the approver on the support
> case. This is enforced in code, not by convention — there is a test for the refusal and a test
> that the approver is recorded.

## What must never be done

| Action | Why |
|---|---|
| Refunding because the case is old | Age is not evidence. An old unknown is still unknown |
| Marking it failed to close the queue | The provider may have delivered; the customer got their airtime |
| Releasing value to keep a merchant happy | That is a decision about money, and it needs a supervisor and a record |
| Editing a ledger entry | Refused by trigger. Corrections are `ADJUSTMENT` entries |
| Resolving without recording who decided and why | The audit trail is the only defence in a dispute |

## Queue health

`openManualReviews` should be flat or falling. A growing queue means one of:

- the provider is degraded — check [[Provider Health]]
- the pending maximum is too short, escalating healthy transactions — [[Recovery Configuration]]
- support capacity is short of demand

Do not fix a growing queue by lengthening the pending maximum. That hides held merchant money
rather than resolving it.

## Related

- [[Support and Disputes]]
- [[Recovery Sweep]]
- [[Recovery Sweep Runbook]]
- [[Balance Model]]
- [[Runbooks]]

---
Back to [[00 Home]]
