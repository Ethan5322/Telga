---
title: Observability
type: engineering
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - engineering
  - metrics
  - monitoring
related:
  - "[[00 Home]]"
  - "[[Provider Health]]"
  - "[[Architecture]]"
depends_on:
  - "[[Architecture]]"
implements: []
validates: []
decision_status: draft
---

# Observability

What Telga measures about itself. The pilot scorecard view of the same data is
the pilot measurement record (commercial material, kept outside this repository).

## Latency

| Metric | Internal target |
|---|---|
| Telga processing, median | < 1 s |
| Telga processing, p95 | Tracked, no target set |
| Provider latency, median and p95 | < 5 s target |
| End-to-end successful sale | < 10 s target |

**Internal engineering targets, never public guarantees** — strategic material maintained outside the source repository.

## Transaction outcomes

Success rate · timeout rate · pending rate · under-review age (oldest and median) ·
resolution time · **duplicate prevention rate** · **ledger mismatches**.

The last two are integrity measures, not performance measures. Their only acceptable values are
100% and 0.

## Availability

Uptime · outage duration and count · provider health transitions · offline periods per device.

## Hardware and support

Printer failures · reprints · support response time · support resolution time · cases open beyond
24 hours.

## Merchant and commercial

Active merchants · repeat usage · merchant net earnings · Telga revenue · contribution ·
hardware, connectivity, support, reversal and fraud costs.

## Database health

`driver.health()` is the single call that answers "is the ledger sound?". It reports PRAGMA
readback, applied migration count, `integrity_check`, and the whole-ledger residual.

| Signal | Healthy | Meaning when unhealthy |
|---|---|---|
| `integrity_check` | `ok` | Database corruption — restore, do not repair in place |
| `foreign_keys` | `1` | Referential integrity is off; stop writes |
| `journal_mode` | `wal` | Concurrency and durability assumptions no longer hold |
| Ledger residual | `0` | **Double entry has broken. Merchant value is unaccounted for.** |

Procedures in [[Database Operations Runbook]].

## Orchestration signals

| Signal | Source |
|---|---|
| Pending rate | Share of sales reaching `PENDING` |
| Under-review age | Oldest `AWAITING` / `ESCALATED` row in `pending_resolutions` |
| Resolution attempts | `attempts` per pending job — a rising count means the provider is silent |
| Stuck `PROCESSING` count | Transactions that never reached a definitive state |
| Duplicate prevention | `DUPLICATE_REQUEST` results vs. transactions created |
| Open support cases | `support_cases` where status is `OPEN` |

**Stuck `PROCESSING` is the one to watch.** It means unit of work 2 failed after the provider was
called, and there is no automatic sweep yet — see [[Transaction Failure Runbook]].

## Reading a worker process

The CLI emits **one machine-readable line** per run with `--json`: worker id, process id, claimed,
conflicts, recovered, escalated, found, ledger residual, status and health level. That line is what
the child-process tests assert on, and what an operator reads after a manual sweep.

Exit codes carry meaning: `0` success, `2` bad arguments, `3` refused (not training mode), `4`
invalid configuration, `5` runtime failure, `6` migrations not applied. A non-zero exit is never
silent.

## Recovery metrics

Per-sweep counters live on the `SweepReport`; standing gauges come from `recoveryGauges`.

| Sweep counter | Gauge |
|---|---|
| `found` · `claimed` · `duplicateWorkersPrevented` | `processing` · `reserved` · `pending` |
| `recoveredSuccessful` · `recoveredFailed` | `underReview` · `reversalRequired` |
| `releasedNeverSubmitted` · `movedToPending` | `oldestUnresolvedAgeMs` |
| `escalatedUnderReview` · `recoveryFailures` | `openManualReviews` · `awaitingResolutions` |
| `operationalAlerts` · `providerLookupMs` | `ledgerResidualMinor` · `healthy` |

`evaluateAlerts` turns these into alerts rather than logging them, so this package knows nothing
about a paging system:

| Alert | Severity |
|---|---|
| `LEDGER_RESIDUAL_NON_ZERO` | **Critical** |
| `DATABASE_UNHEALTHY` | **Critical** |
| `TRANSACTION_STUCK_BEYOND_SAFE_PERIOD` | High |
| `RECOVERY_WORKER_FAILURES` | High |
| `PROVIDER_LOOKUP_FAILURE_SPIKE` | High |
| `MANUAL_REVIEW_QUEUE_GROWING` | Medium |
| `MULTIPLE_RECOVERY_ATTEMPTS` | Medium |

Thresholds are configuration, not code — see [[Recovery Configuration]].

## Worker metrics

Emitted by the worker loop; names are constants so they cannot drift between emit and assert.

| Group | Metrics |
|---|---|
| Lifecycle | `worker.starts` · `worker.stops` · `worker.shutdown.duration_ms` |
| Sweeps | `worker.sweep.started` · `.completed` · `.failed` · `.skipped_overlap` · `.duration_ms` |
| Transactions | `worker.transactions.found` · `.claimed` · `.recovered_successful` · `.recovered_failed` · `.moved_to_pending` · `.escalated_under_review` |
| Claims | `worker.claims.conflicts` · `.lease_expirations` · `.active` |
| Failures | `worker.provider.status_errors` · `worker.database.errors` · `worker.backoff.events` |
| Queues | `worker.oldest_unresolved_age_ms` · `worker.queue.pending` · `worker.queue.under_review` |

Every log event carries `workerId`, and where applicable `sweepId`, `correlationId`,
`transactionId`, `merchantId`, `providerId`, outcome category, error code and attempt number.

**Never logged:** PINs, passwords, secrets, tokens, credentials, authorization headers, recipient
numbers, phone numbers, or the recipient hash salt. `assertSafeLogDetail` refuses them before they
reach a sink, and a test asserts every forbidden key is refused.

## Alerts

| Condition | Why it pages |
|---|---|
| Any ledger mismatch | Balance integrity — the highest-severity signal Telga has |
| Any duplicate vend detected | The defect that blocks Phase 3 exit |
| Under-review age exceeds threshold | Merchant funds held too long |
| Provider health degraded | Outage isolation should have engaged |
| Support case approaching 24 h | The commitment in [[Support and Disputes]] |
| Failed backup or restore test | Launch gate 10 |

Thresholds are **NOT YET SET** — they need pilot data. Setting them before a baseline exists
invents a standard.

## Logging

Structured, with merchant, device, transaction, provider reference, state, and rule version.
**Never** log: PINs, secrets, full recipient numbers beyond what support requires, or provider
credentials. Redaction is a security test case — [[Security Model]].

## Audit vs metrics

| | Audit | Metrics |
|---|---|---|
| Purpose | Accountability | Operation |
| Retention | Long, per [[Legal Questions]] L15 | Shorter |
| Mutability | **Append-only** | Aggregatable |
| Contains identity | Yes | No |

## What the transport prints — 2026-08-21

The startup banner states the posture and nothing secret:

- the address actually bound — the port the OS chose, when `--port 0` was asked for;
- the mode, and for plain HTTP a plain warning that it is loopback-only and that
  cookies are not `Secure`;
- for a proxied deployment, **which addresses** are trusted;
- for standalone TLS, the certificate subject, issuer, validity and SHA-256
  fingerprint — the fingerprint is a public value and is what an operator
  compares to confirm the right certificate is loaded;
- a warning when the certificate is self-signed, expired, or when the key file
  is readable beyond its owner.

It never prints key material, a session token, a CSRF token or a device key. The
smoke test asserts the banner contains neither `BEGIN` nor `PRIVATE`.

Every response carries `X-Telga-Correlation-Id`, so a merchant quoting a support
code identifies a request across the POS, the API and the worker's own logs.


## The worker accounts for what it claimed — 2026-08-21

A sweep that claims transactions and resolves none of them used to report a row
of zeroes and explain nothing — which is exactly the state a supervised worker
most needs to account for. The JSON output now carries:

| Field | Answers |
|---|---|
| `found` | how many candidates the scan saw |
| `claimed` | how many this worker took |
| `duplicateWorkersPrevented` | how many another worker already held |
| `skipped` | how many were passed over, and therefore not failures |
| `recoveryFailures` | how many were claimed and then could not be resolved |
| `failureReasonCodes` | **why** — the safe, stable codes behind those failures |
| `stoppedEarly` | whether the sweep stopped at a safe boundary |
| `ledgerResidualMinor` | whether double entry still holds |

Added after a full-suite failure showed `claimed: 1` beside
`recoveredSuccessful: 0` with no field that could say why — see A54 and
[[Test Stability Runbook]]. Reason codes only: never a raw error message, never a
provider body.

## Related

- [[Provider Health]]
- [[Security Model]]
- [[Runbooks]]

---
Back to [[00 Home]]
