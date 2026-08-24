---
title: Recovery Configuration
type: engineering
status: draft
owner: telga
created: 2026-08-20
updated: 2026-08-20
tags:
  - telga
  - engineering
  - recovery
  - configuration
related:
  - "[[00 Home]]"
  - "[[Recovery Sweep]]"
  - "[[Recovery Sweep Runbook]]"
depends_on:
  - "[[Recovery Sweep]]"
implements: []
validates: []
decision_status: pending
---

# Recovery Configuration

Every threshold the recovery sweep uses is **injected**. There is no production default in the
service, and no `Date.now()` anywhere in it — a test asserts both.

## Settings

| Setting | Meaning | Test value | Production value |
|---|---|---|---|
| `recoveryAgeMs` | How old an in-flight transaction must be before the sweep touches it | 60 000 | **NOT YET CONFIRMED** |
| `pendingMaximumMs` | How long a transaction may stay unresolved before escalation | 300 000 | **NOT YET CONFIRMED** — assumption A7 |
| `maxStatusAttempts` | Status lookups before escalating regardless of the clock | 3 | **NOT YET CONFIRMED** |
| `claimLeaseMs` | How long a worker owns a claimed transaction | 30 000 | **NOT YET CONFIRMED** |
| `statusCheckIntervalMs` | Gap between lookups, written to `next_check_at` | 30 000 | **NOT YET CONFIRMED** |
| `batchLimit` | Transactions examined per sweep | 50 | **NOT YET CONFIRMED** |

`DEVELOPMENT_RECOVERY_POLICY` exists in code as a starting point and is named so that using it in
production is an obvious mistake.

## Per-provider policy

```ts
const config: RecoveryConfig = {
  ...base,
  perProvider: {
    'provider-a': { recoveryAgeMs: 600_000, pendingMaximumMs: 900_000 },
  },
};
```

"How long a silence means something" is a property of the provider, not of Telga. Once a provider
agreement states its own timeout and settlement semantics (terms 7 and 9 of the
provider agreement, which is commercial material kept outside this repository),
that number goes here rather than into code.

Any omitted field falls back to the base policy. The candidate query uses the **minimum** recovery
age across the base and every override, so a provider with a shorter threshold is not filtered out
before its own policy is consulted.

## Boundary behaviour

| Age relative to threshold | Behaviour |
|---|---|
| One second younger | **Not recovered** |
| Exactly at the threshold | **Recovered** — the comparison is inclusive |
| Older | Recovered |

Documented because "at the boundary" is exactly where an undocumented rule causes an argument at
3 a.m.

## Where the pending clock starts

`first_pending_at` is set to **when the transaction entered the in-flight state**, not when the
sweep noticed it. A transaction stuck for an hour does not get a fresh grace period because a
worker only just reached it — the merchant's money has already been held for that hour.

## Escalation triggers

A transaction escalates to `UNDER_REVIEW` when **either**:

- the pending deadline has passed (`first_pending_at + pendingMaximumMs`), **or**
- `attempts >= maxStatusAttempts`

The second exists because a provider that answers "still pending" instantly and forever would
otherwise never trip a clock-based rule in a low-traffic system.

## Alert thresholds

Separate from recovery policy, consumed by `evaluateAlerts`:

| Threshold | Meaning | Value |
|---|---|---|
| `maxSafeUnresolvedMs` | Beyond this, a held transaction is an incident | **NOT YET CONFIRMED** |
| `maxManualReviewQueue` | Queue size that means support is falling behind | **NOT YET CONFIRMED** |
| `maxRecoveryFailures` | Failures in one sweep that mean the worker is broken | **NOT YET CONFIRMED** |

## What must be decided before the pilot

All six recovery settings and all three alert thresholds are **NOT YET CONFIRMED**. They depend on
the provider's contracted behaviour and on real connectivity data from
the pilot baseline metrics (commercial material, kept outside this repository)  — neither of which exists. Tracked as assumptions A7 and A32 in
the pilot assumptions register (commercial material, kept outside this repository).

## Related

- [[Recovery Sweep]]
- [[Recovery Sweep Runbook]]

---
Back to [[00 Home]]
