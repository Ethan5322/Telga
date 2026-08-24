---
title: Worker Configuration
type: engineering
status: draft
owner: telga
created: 2026-08-20
updated: 2026-08-20
tags:
  - telga
  - engineering
  - worker
  - configuration
related:
  - "[[00 Home]]"
  - "[[Recovery Worker]]"
  - "[[Recovery Configuration]]"
  - "[[Deployment Runbook]]"
depends_on:
  - "[[Recovery Worker]]"
implements: []
validates: []
decision_status: pending
---

# Worker Configuration

Three named policies, and a hard rule between them.

> [!danger] Production never falls back
> `productionPolicyFrom` reads explicit configuration and **throws for anything missing**. A
> deployment that forgot a setting fails at startup rather than quietly running a developer's
> numbers against a merchant's money. `assertNotDevelopmentPolicyInProduction` refuses the named
> development and test policies outright.

## The three policies

| Policy | Use | Values |
|---|---|---|
| `DEVELOPMENT_RECOVERY_WORKER_POLICY` | Local work | Short intervals so the loop is visible |
| `TEST_RECOVERY_WORKER_POLICY` | Tests | Short and deterministic |
| `PRODUCTION_RECOVERY_WORKER_POLICY` | Production | **Every field is the literal `NOT_YET_CONFIRMED`** |

The production policy deliberately carries no numbers. Every value depends on provider timeout
semantics (terms 7 and 9 of the provider agreement, which is commercial material
kept outside this repository) and on real connectivity data from
the pilot baseline metrics (commercial material, kept outside this repository) , neither of which exists. A test asserts that no field of it is a number.

## Settings

| Setting | Meaning | Development | Production |
|---|---|---|---|
| `recoveryWorkerEnabled` | The worker does nothing unless explicitly true | `true` | **NOT YET CONFIRMED** |
| `recoveryIntervalMs` | Gap between sweeps | 30 000 | **NOT YET CONFIRMED** |
| `recoveryJitterMs` | Bounded random added to the delay | 5 000 | **NOT YET CONFIRMED** |
| `recoveryBatchLimit` | Transactions examined per sweep | 50 | **NOT YET CONFIRMED** |
| `recoveryAgeMs` | Age before a transaction is swept | 60 000 | **NOT YET CONFIRMED** |
| `pendingMaximumMs` | Unresolved time before escalation | 300 000 | **NOT YET CONFIRMED** |
| `maxStatusAttempts` | Lookups before escalating regardless of clock | 5 | **NOT YET CONFIRMED** |
| `claimLeaseMs` | How long a worker owns a claim | 30 000 | **NOT YET CONFIRMED** |
| `statusCheckIntervalMs` | Gap between status lookups | 30 000 | **NOT YET CONFIRMED** |
| `failureBackoffInitialMs` | First backoff | 1 000 | **NOT YET CONFIRMED** |
| `failureBackoffMaximumMs` | Backoff cap | 60 000 | **NOT YET CONFIRMED** |
| `failureBackoffMultiplier` | Growth per failure | 2 | **NOT YET CONFIRMED** |
| `gracefulShutdownTimeoutMs` | Wait for an in-flight sweep | 10 000 | **NOT YET CONFIRMED** |
| `runInitialSweepOnStart` | Sweep immediately, or wait one interval | `true` | **NOT YET CONFIRMED** |

## Configuration source

Production reads environment-style keys, screaming-snake with a `TELGA_` prefix:

```
TELGA_RECOVERY_WORKER_ENABLED=true
TELGA_RECOVERY_INTERVAL_MS=30000
TELGA_CLAIM_LEASE_MS=30000
...
```

Missing or non-numeric values raise a typed `WorkerConfigurationError` naming the setting.

## Validation at startup

Checked before the loop starts; the first problem throws.

| Rule | Error code |
|---|---|
| Durations are positive | `NOT_POSITIVE` |
| Jitter is not negative | `NEGATIVE` |
| Batch limit is at least 1 | `BATCH_LIMIT_TOO_SMALL` |
| Maximum backoff ≥ initial backoff | `BACKOFF_MAXIMUM_BELOW_INITIAL` |
| Backoff multiplier ≥ 1 | `BACKOFF_MULTIPLIER_TOO_SMALL` |
| Interval ≥ the safe minimum | `INTERVAL_TOO_SHORT` |
| Lease comfortably exceeds one operation | `CLAIM_LEASE_TOO_SHORT` |
| Pending maximum ≥ recovery age | `PENDING_MAXIMUM_BELOW_RECOVERY_AGE` |
| No development policy in production | `PRODUCTION_FALLBACK_REFUSED` |

**Why a lease must exceed one operation:** a lease shorter than the work it protects expires
mid-recovery, and a second worker walks in on a transaction that is already being resolved.

**Why the pending maximum must not sit below the recovery age:** it would escalate transactions the
sweep has not even looked at yet. Override it only with a documented reason, using
`allowPendingMaximumBelowRecoveryAge`.

## Enabling the worker

The worker is off unless `recoveryWorkerEnabled` is explicitly true. There is no implicit default,
and disabled is treated as a normal state — logged, not raised as a failure.

## What must be decided before the pilot

All fourteen production values, plus the alert thresholds in [[Recovery Configuration]]. Tracked as
assumptions A7, A32 and A34 in the pilot assumptions register (commercial material, kept outside this repository).

## Related

- [[Recovery Worker]]
- [[Recovery Configuration]]
- [[Deployment Runbook]]
- [[Worker Operations Runbook]]

---
Back to [[00 Home]]
