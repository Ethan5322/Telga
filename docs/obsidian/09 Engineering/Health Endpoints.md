---
title: Health Endpoints
type: engineering
status: draft
owner: telga
created: 2026-08-24
updated: 2026-08-24
tags:
  - telga
  - engineering
  - deployment
  - health
related:
  - "[[00 Home]]"
  - "[[Observability]]"
  - "[[Persistent Host Runbook]]"
  - "[[Service Startup and Shutdown]]"
  - "[[Recovery Worker]]"
  - "[[API Contracts]]"
depends_on:
  - "[[Observability]]"
implements: []
validates: []
decision_status: accepted
---

# Health Endpoints

**Implemented and tested — this note records what exists, not a design.**
Closes the `A62` gap identified in [[Persistent Host Runbook]]. Source:
`services/api/src/http/health.ts`; tests: `tests/ui/health.test.ts` (17
cases) and the compiled routes exercised through the training HTTP surface.

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/health/live` | Public | Is the process alive and accepting connections |
| `GET /api/health/ready` | Public | Is it safe to serve an authenticated training request right now |

Both sit outside `/api/training/` deliberately — a process supervisor or
reverse proxy checks these without a session, and they must work identically
regardless of the training namespace. Both are wired through the existing
router (`services/api/src/http/router.ts`), reachable at the API's normal
`/api/` prefix — no change to `apps/merchant-pos/src/server.ts` was needed,
since it already forwards any `/api/` path to the router generically.

## Liveness — `GET /api/health/live`

Always `200 { status: "HEALTHY", mode, serverTime }` if reached at all.
**Never opens the database.** Reaching the handler already proves the
process is alive and the transport is accepting connections; there is
nothing further to check.

## Readiness — `GET /api/health/ready`

Every check is a **read**. None opens a transaction, creates a claim, or
calls a provider — verified by a dedicated test
(`tests/ui/health.test.ts`, "cannot mutate state").

| Check | Reuses | Fails when |
|---|---|---|
| `mode` | `deps.mode` | Not `TRAINING` → `NOT_READY`, code `NOT_TRAINING_MODE` |
| `database` | `driver.health()`, `MIGRATIONS` vs `appliedMigrations()` | Integrity check fails or a migration is missing → `UNHEALTHY` |
| `ledger_residual` | `recoveryGauges(...).ledgerResidualMinor` | Non-zero → `UNHEALTHY`, code `LEDGER_RESIDUAL_NON_ZERO` |
| `recovery_queue` | `evaluateAlerts(...)` — the same alert evaluation the worker's own observability uses | `TRANSACTION_STUCK_BEYOND_SAFE_PERIOD` or `MANUAL_REVIEW_QUEUE_GROWING` fires → `DEGRADED` |
| `recovery_claims` | `driver.countActiveClaims()` | The query itself fails → `UNHEALTHY` |

Deliberately **not duplicated**: `recoveryGauges` and `evaluateAlerts`
(`services/api/src/application/recovery/metrics.ts`) already existed and are
what the worker's own observability computes from — this endpoint reuses
them rather than defining a second, possibly-conflicting notion of "the
recovery queue is fine."

### What this process cannot see

The POS/API process and the recovery worker are **separate processes**
sharing only the database — there is no live channel between them. This
endpoint cannot report the worker's actual in-memory health (its backoff
state, its consecutive-failure count) the way
[[Recovery Worker]]'s own `workerHealth.ts` can from inside the worker
itself. Every readiness check is an **inference from persisted state**, not
a report from the worker. "Claim state" is reported as a count, not a
staleness verdict: whether a claim is stuck is already what the
recovery-queue's oldest-unresolved-age check answers, so a second staleness
check on claims would duplicate that signal rather than add one.

### Overall status and HTTP code

```
NOT_READY > UNHEALTHY > DEGRADED > HEALTHY   (most severe check wins)

HEALTHY, DEGRADED  → HTTP 200 (safe to serve)
UNHEALTHY, NOT_READY → HTTP 503
```

`DEGRADED` is still safe to serve — matches the worker's own `DEGRADED`
meaning ("running, but something is wrong"), not a reason to refuse traffic.

`STARTING` and `STOPPING` exist in the `HealthStatus` type for completeness
against the worker's own `WorkerStatus`, but this endpoint never emits
them: a request cannot reach the handler before the HTTP listener is
accepting connections, and the transport stops accepting new connections
before an in-flight shutdown would ever reach here. Documented rather than
built, because there is nothing for it to detect — see
`services/api/src/http/health.ts`'s `UNREACHABLE_STATUSES`.

## Safety properties, each with a test

- **No secrets, no sensitive transaction data.** Verified by scanning the
  full response body for PIN/secret/token/session/key substrings and any
  phone-number-shaped digit run.
- **`Cache-Control: no-store`** and the same safe header set as the rest of
  the training HTTP surface (`x-content-type-options: nosniff`,
  `referrer-policy: no-referrer`).
- **No raw database errors, no file paths.** Every failure carries a safe,
  stable `reasonCode` — `DATABASE_UNREACHABLE`, `MIGRATIONS_NOT_CURRENT`,
  `LEDGER_RESIDUAL_NON_ZERO`, `RECOVERY_QUEUE_LAGGING`,
  `RECOVERY_CLAIMS_UNREADABLE`, `NOT_TRAINING_MODE` — never an exception
  message.
- **Cannot mutate state.** `POST /api/health/ready` is refused with 405; the
  route table only registers `GET`.
- **Unaffected by a spoofed or malformed proxy header.** Health status
  never reads `X-Forwarded-*` at all.

## Thresholds

`DEFAULT_READINESS_THRESHOLDS` in `health.ts` matches the worker's own
`degradedOldestUnresolvedMs` (15 minutes, see
`services/worker/src/workerHealth.ts`) as a **value**, not an import —
`@telga/api` cannot depend on `@telga/worker`; the dependency runs the other
way. `maxManualReviewQueue` and `maxRecoveryFailures` have no existing
default anywhere in this repository; chosen as a first, conservative value
for a training deployment with a handful of operators, not derived from
pilot data that does not yet exist.

## Related

- [[Observability]]
- [[Persistent Host Runbook]]
- [[Service Startup and Shutdown]]
- [[Recovery Worker]]

---
Back to [[00 Home]]
