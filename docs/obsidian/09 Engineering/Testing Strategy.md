---
title: Testing Strategy
type: engineering
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - engineering
  - testing
  - qa
related:
  - "[[00 Home]]"
  - "[[Transaction State Machine]]"
  - "[[Ledger Invariants]]"
depends_on:
  - "[[Transaction State Machine]]"
  - "[[Ledger Invariants]]"
implements: []
validates:
  - "[[Definition of Done]]"
decision_status: confirmed
---

# Testing Strategy

> **No happy-path-only feature is complete.**

## Implemented test map — state transitions

Each transition in [[Transaction State Machine]] maps to a named test in
`tests/domain/states.test.ts`. **All 12 states are covered by name**, including `CREATED`,
`VALIDATED`, `RESERVED` and `REVERSAL_REQUIRED`.

| Transition | Test name | File |
|---|---|---|
| `CREATED → VALIDATED` | `CREATED -> VALIDATED` | `tests/domain/states.test.ts` |
| `VALIDATED → RESERVED` | `VALIDATED -> RESERVED` | `tests/domain/states.test.ts` |
| `RESERVED → SUBMITTED` | `RESERVED -> SUBMITTED` | `tests/domain/states.test.ts` |
| `RESERVED → PROCESSING` | `RESERVED -> PROCESSING (adapter with no separate acknowledgement)` | `tests/domain/states.test.ts` |
| `PROCESSING → SUCCESSFUL` | `PROCESSING -> SUCCESSFUL` | `tests/domain/states.test.ts` |
| `PROCESSING → FAILED` | `PROCESSING -> FAILED` | `tests/domain/states.test.ts` |
| `PROCESSING → PENDING` | `PROCESSING -> PENDING (a timeout is never a failure)` | `tests/domain/states.test.ts` |
| `PENDING → SUCCESSFUL` | `PENDING -> SUCCESSFUL` | `tests/domain/states.test.ts` |
| `PENDING → FAILED` | `PENDING -> FAILED` | `tests/domain/states.test.ts` |
| `PENDING → UNDER_REVIEW` | `PENDING -> UNDER_REVIEW` | `tests/domain/states.test.ts` |
| `PENDING → REVERSAL_REQUIRED` | `PENDING -> REVERSAL_REQUIRED` | `tests/domain/states.test.ts` |
| `REVERSAL_REQUIRED → REVERSED` | `REVERSAL_REQUIRED -> REVERSED` | `tests/domain/states.test.ts` |
| `UNDER_REVIEW → REVERSAL_REQUIRED → REVERSED` | `UNDER_REVIEW -> REVERSAL_REQUIRED -> REVERSED` | `tests/domain/states.test.ts` |
| **All 18 legal pairs** | `accepts every pair present in the transition map` | `tests/domain/states.test.ts` |
| **All 126 illegal pairs** | `rejects every pair absent from the transition map` | `tests/domain/states.test.ts` |
| Terminal states | `has exactly four, and none of them can move` | `tests/domain/states.test.ts` |
| Value accounting | `assigns every state exactly one bucket` | `tests/domain/states.test.ts` |

## Implemented test map — invariants and behaviour

| Requirement | Test | File |
|---|---|---|
| Duplicate idempotency key | `a second register with the same payload replays rather than creating a sale` | `tests/domain/idempotency.test.ts` |
| Duplicate retry prevention | `ten rapid retries still produce exactly one transaction` | `tests/domain/idempotency.test.ts` |
| Same key, different payload | `throws rather than silently overwriting, when the amount changed` | `tests/domain/idempotency.test.ts` |
| Reservation and release | `releasing restores available exactly` | `tests/domain/balance.test.ts` |
| Successful final debit | `debits the merchant and clears the reservation` | `tests/domain/balance.test.ts` |
| Under review excluded from available | `are excluded from available balance` | `tests/domain/balance.test.ts` |
| Four views reconcile | `the four views always reconcile` | `tests/domain/balance.test.ts` |
| Append-only ledger | `refuses to re-post an existing posting id` | `tests/domain/ledger.test.ts` |
| Sum to zero (property) | `property: a mixed sequence of postings always sums to zero` | `tests/domain/ledger.test.ts` |
| Money is integer-only | `has no float rounding error across a hundred additions` | `tests/domain/ledger.test.ts` |
| Reprint is not a sale | `ten reprints still leave exactly one sale on the ledger` | `tests/domain/receipt-and-audit.test.ts` |
| Audit event creation | `a transition produces an audit event recording before and after` | `tests/domain/receipt-and-audit.test.ts` |
| Merchant isolation | `one merchant balance is unaffected by another activity` | `tests/domain/balance.test.ts` |
| Live money refused | `refuses to post a LIVE entry` | `tests/domain/ledger.test.ts` |
| Mock provider — 8 behaviours | one `describe` block per behaviour | `tests/provider/mock-airtime.test.ts` |

## Implemented test map — persistence

79 tests across five files. See [[SQLite Persistence Layer]] and [[Migration Strategy]].

| Requirement | Test | File |
|---|---|---|
| WAL mode active | `WAL journal mode is active on a file database` | `sqlite-behaviour.test.ts` |
| Foreign keys active **and enforced** | `foreign keys are actually enforced, not merely reported on` | `sqlite-behaviour.test.ts` |
| Busy timeout set | `busy timeout is set` | `sqlite-behaviour.test.ts` |
| Synchronous FULL | `synchronous is FULL — this is a ledger, not a cache` | `sqlite-behaviour.test.ts` |
| STRICT rejects text in money column | `reject text in an integer money column` | `sqlite-behaviour.test.ts` |
| STRICT rejects float in money column | `reject a float in an integer money column` | `sqlite-behaviour.test.ts` |
| No live-money rows | `reject a live-money row outright` | `sqlite-behaviour.test.ts` |
| Migrations run once | `run once and record every migration` | `sqlite-behaviour.test.ts` |
| Re-running migrations is safe | `re-running is safe and applies nothing` | `sqlite-behaviour.test.ts` |
| Failed migration rolls back | `rolls a failed migration back whole and does not record it` | `sqlite-behaviour.test.ts` |
| Checksum integrity | `refuses an applied migration whose contents later changed` | `sqlite-behaviour.test.ts` |
| Database closes cleanly | `closes cleanly and refuses use afterwards` | `sqlite-behaviour.test.ts` |
| Ledger append succeeds | `a funding posting writes two balanced entries` | `ledger-integrity.test.ts` |
| **Direct SQL UPDATE fails** | `a direct SQL UPDATE fails` | `ledger-integrity.test.ts` |
| **Direct SQL DELETE fails** | `a direct SQL DELETE fails` | `ledger-integrity.test.ts` |
| Adjustment entry remains possible | `a correction must be a new ADJUSTMENT entry, and that still works` | `ledger-integrity.test.ts` |
| Integer minor units preserved | `preserves integer minor units exactly` | `ledger-integrity.test.ts` |
| Double-entry invariant holds | `many interleaved postings leave the ledger balanced` | `ledger-integrity.test.ts` |
| BANK_CLEARING excluded from merchant balance | `balances the bookkeeping without appearing in a merchant balance` | `ledger-integrity.test.ts` |
| Merchant cannot read another's transactions | `merchant A cannot read merchant B's transaction` | `merchant-isolation.test.ts` |
| Merchant cannot read another's ledger | `merchant A cannot read merchant B's entries` | `merchant-isolation.test.ts` |
| Merchant cannot use another's reservation | `merchant A cannot use merchant B's reservation` | `merchant-isolation.test.ts` |
| Device ownership enforced | `device ownership is enforced` | `merchant-isolation.test.ts` |
| Same scoped key returns original transaction | `the same scoped key returns the original transaction` | `idempotency-and-audit.test.ts` |
| Same key, different merchant scopes correctly | `the same key from a different merchant is a separate record` | `idempotency-and-audit.test.ts` |
| Concurrent duplicates create one transaction | `concurrent duplicate requests create one logical transaction` | `idempotency-and-audit.test.ts` |
| Reservation moves value to reserved | `moves value from available to reserved` | `reservation-balance.test.ts` |
| Insufficient balance rejected | `rejects an amount above available balance` | `reservation-balance.test.ts` |
| Release restores available | `restores available value exactly` | `reservation-balance.test.ts` |
| Completion produces expected balances | `debits the merchant and credits provider settlement` | `reservation-balance.test.ts` |
| Under-review excluded from available | `moves value out of reserved and keeps it out of available` | `reservation-balance.test.ts` |
| **Failed transaction leaves no partial reservation** | `a throw inside a unit of work rolls back every write in it` | `reservation-balance.test.ts` |
| Repeated release cannot double-credit | `a repeated release cannot double-credit` | `reservation-balance.test.ts` |
| Repeated finalization cannot double-debit | `a repeated finalization cannot double-debit` | `reservation-balance.test.ts` |
| No invented commission | `writes no commission entry, because no commission rate is confirmed` | `reservation-balance.test.ts` |
| Balance-changing action creates audit event | `every balance-changing action creates an audit event` | `idempotency-and-audit.test.ts` |
| Actor and correlation id present | `carries actor and correlation id` | `idempotency-and-audit.test.ts` |
| Audit not silently modifiable | `audit events cannot be silently modified` | `idempotency-and-audit.test.ts` |
| Sensitive data not stored | `refuses to store sensitive metadata on an audit event` | `idempotency-and-audit.test.ts` |
| Recipient never stored in full | `stores a mask and a hash, never the full number` | `idempotency-and-audit.test.ts` |

## Implemented test map — orchestration

74 tests across five files in `tests/orchestration/`. See [[Transaction Orchestration]].

| Requirement | Test | File |
|---|---|---|
| Immediate success path | `walks CREATED to SUCCESSFUL and debits exactly once` | `create-sale.test.ts` |
| Finalizes exactly once | `finalizes the reservation exactly once` | `create-sale.test.ts` |
| No commission without a rate | `writes no commission entry, because no rate is configured` | `create-sale.test.ts` |
| Confirmed failure releases once | `releases the reservation and restores available exactly once` | `create-sale.test.ts` |
| Timeout holds value | `becomes PENDING with the reservation still held` | `create-sale.test.ts` |
| Timeout performs no debit | `performs no final debit` | `create-sale.test.ts` |
| Pending job scheduled | `creates a pending resolution job carrying the escalation deadline` | `create-sale.test.ts` |
| Malformed is never a false success | `a malformed provider response is pending, never a false success` | `create-sale.test.ts` |
| Outage blocks with no charge | `provider outage blocks before anything is created or charged` | `create-sale.test.ts` |
| Insufficient balance is clean | `insufficient balance leaves no transaction and no reservation` | `create-sale.test.ts` |
| LIVE refused at the door | `a non-training mode is refused at the door` | `create-sale.test.ts` |
| No raw errors to merchants | `never exposes a raw error to the merchant` | `create-sale.test.ts` |
| Recipient never stored in full | `never stores the full recipient number` | `create-sale.test.ts` |
| Delayed success finalizes once | `PENDING to SUCCESSFUL finalizes exactly once` | `pending-resolution.test.ts` |
| No second reservation or sale | `never creates a second reservation, debit or sale` | `pending-resolution.test.ts` |
| Repeated callback does not finalize twice | `a repeated callback does not finalize twice` | `pending-resolution.test.ts` |
| Delayed failure releases once | `PENDING to FAILED releases exactly once` | `pending-resolution.test.ts` |
| Repeated failure callback does not release twice | `a repeated failure callback does not release twice` | `pending-resolution.test.ts` |
| Status lookup creates no transaction | `a status lookup does not create a new transaction` | `pending-resolution.test.ts` |
| Escalation to under review | `moves value to the under-review bucket past the deadline` | `pending-resolution.test.ts` |
| Support case opened | `opens a support case with a reference the merchant can quote` | `pending-resolution.test.ts` |
| No automatic finalize/refund/release | `does not finalize, refund or release automatically` | `pending-resolution.test.ts` |
| Duplicate returns the original | `returns the original transaction rather than selling again` | `idempotency.test.ts` |
| Ten presses, one debit | `debits only once across ten rapid presses` | `idempotency.test.ts` |
| Concurrent duplicates | `concurrent duplicate requests produce one logical transaction` | `idempotency.test.ts` |
| Changed amount rejected | `rejects a changed amount` | `idempotency.test.ts` |
| Changed recipient rejected | `rejects a changed recipient` | `idempotency.test.ts` |
| Merchants scope independently | `two merchants may use the same client request id independently` | `idempotency.test.ts` |
| Timeout retry creates nothing new | `a retry does not create a new transaction` | `idempotency.test.ts` |
| Failure before reservation | `leaves no transaction, no reservation and no entries` | `unit-of-work.test.ts` |
| Failure after reservation, before submit | `rolls back the reservation with it` | `unit-of-work.test.ts` |
| Failure after success, before finalize | `leaves the value reserved rather than debited, and the ledger balanced` | `unit-of-work.test.ts` |
| Failure during ledger posting | `rolls back the whole outcome unit of work` | `unit-of-work.test.ts` |
| Failure during audit creation | `rolls back the balance change it accompanied` | `unit-of-work.test.ts` |
| Failure during idempotency result | `rolls back the finalization with it` | `unit-of-work.test.ts` |
| **Invariant across all eight failure points** | `the ledger always balances and the four views always reconcile` | `unit-of-work.test.ts` |
| Reversal returns the value | `UNDER_REVIEW to REVERSAL_REQUIRED to REVERSED returns the value` | `reversal-and-balances.test.ts` |
| Reversal is append-only | `posts the return as new append-only entries, never an edit` | `reversal-and-balances.test.ts` |
| Repeated reversal callback | `a repeated reversal callback does not reverse twice` | `reversal-and-balances.test.ts` |
| Illegal reversal refused | `refuses a reversal from a state the domain does not allow` | `reversal-and-balances.test.ts` |
| BANK_CLEARING invisible | `BANK_CLEARING never appears in a merchant-facing view` | `reversal-and-balances.test.ts` |
| Merchant isolation through a sale | `merchant A cannot read or affect merchant B balances through a sale` | `reversal-and-balances.test.ts` |
| Append-only after a full lifecycle | `the ledger remains append-only after a full lifecycle` | `reversal-and-balances.test.ts` |

## Implemented test map — recovery sweep

61 tests across three files in `tests/recovery/`. See [[Recovery Sweep]].

| Requirement | Test | File |
|---|---|---|
| Old PROCESSING + provider success | `old PROCESSING with provider success is recovered and finalized once` | `recover-in-flight.test.ts` |
| Old PROCESSING + provider failure | `old PROCESSING with provider failure releases exactly once` | `recover-in-flight.test.ts` |
| Old PROCESSING + unknown | `old PROCESSING with an unknown result holds the reservation` | `recover-in-flight.test.ts` |
| Old RESERVED, proven no submission | `old RESERVED with proven no submission releases the funds` | `recover-in-flight.test.ts` |
| Legal domain path out of RESERVED | `the never-submitted path takes only legal domain transitions` | `recover-in-flight.test.ts` |
| Recent PROCESSING ignored | `recent PROCESSING is ignored` | `recover-in-flight.test.ts` |
| Recent RESERVED ignored | `recent RESERVED is ignored` | `recover-in-flight.test.ts` |
| Terminal ignored | `terminal transactions are never touched` | `recover-in-flight.test.ts` |
| Boundary — one second young | `one second younger than the threshold is not recovered` | `recover-in-flight.test.ts` |
| Boundary — exact | `exactly at the threshold is recovered` | `recover-in-flight.test.ts` |
| Boundary — older | `older than the threshold is recovered` | `recover-in-flight.test.ts` |
| Provider-specific threshold | `a provider-specific threshold overrides the base policy` | `recover-in-flight.test.ts` |
| Pending maximum is configuration | `the pending maximum is configuration, not code` | `recover-in-flight.test.ts` |
| **No direct `Date.now()`** | `the service reads no wall clock of its own` | `recover-in-flight.test.ts` |
| Outcome classification (8 cases) | `classifies %s / %s as %s` | `recover-in-flight.test.ts` |
| Unavailable holds funds | `never releases funds on an unavailable provider` | `recover-in-flight.test.ts` |
| Malformed holds funds | `never releases funds on a malformed response` | `recover-in-flight.test.ts` |
| Unknown reference holds funds | `an unknown reference holds funds and does not fail the sale` | `recover-in-flight.test.ts` |
| Auth failure alerts, not blames | `an authorization failure raises an operational alert, not a customer failure` | `recover-in-flight.test.ts` |
| Only safe categories stored | `records only a safe outcome category, never a provider body` | `recover-in-flight.test.ts` |
| Escalation past deadline | `escalates past the pending deadline and opens exactly one case` | `recover-in-flight.test.ts` |
| Escalation on max attempts | `escalates once attempts are exhausted, even before the deadline` | `recover-in-flight.test.ts` |
| No refund of an unknown | `does not refund an unknown outcome` | `recover-in-flight.test.ts` |
| Pending metadata maintained | `maintains references, attempts, next check and deadline` | `recover-in-flight.test.ts` |
| No duplicate pending row | `never creates a duplicate pending row for one transaction` | `recover-in-flight.test.ts` |
| **Two workers, one winner** | `only one claims a transaction; the other is refused and records it` | `concurrency.test.ts` |
| Duplicate claim audited | `audits the prevented duplicate` | `concurrency.test.ts` |
| Lease released | `releases the claim so a later sweep can proceed` | `concurrency.test.ts` |
| Expired lease reclaimable | `an expired lease can be reclaimed by another worker` | `concurrency.test.ts` |
| No duplicate postings | `do not duplicate ledger postings` | `concurrency.test.ts` |
| No duplicate support cases | `do not duplicate support cases` | `concurrency.test.ts` |
| Terminal state unchanged | `do not change a terminal state` | `concurrency.test.ts` |
| Recovery + merchant retry | `recovery and a merchant retry cannot create two sales` | `concurrency.test.ts` |
| Recovery + duplicate callback | `recovery and a duplicate provider callback cannot finalize twice` | `concurrency.test.ts` |
| Failure during claim | `is reported, not hidden, and leaves nothing changed` | `rollback-and-metrics.test.ts` |
| Failure during lookup handling | `records a recovery failure and holds the funds` | `rollback-and-metrics.test.ts` |
| Failure during finalization | `rolls the settlement back and leaves the value reserved` | `rollback-and-metrics.test.ts` |
| Failure during release | `rolls back and keeps the reservation held` | `rollback-and-metrics.test.ts` |
| Failure during under-review posting | `rolls back and leaves the value where it was` | `rollback-and-metrics.test.ts` |
| Failure during support-case creation | `rolls back the escalation with it` | `rollback-and-metrics.test.ts` |
| Failure during audit creation | `rolls back whatever it accompanied` | `rollback-and-metrics.test.ts` |
| **Invariant at every injection point** | `holds at each injection point` | `rollback-and-metrics.test.ts` |
| Gauges | `counts transactions by state and finds the oldest unresolved` | `rollback-and-metrics.test.ts` |
| Manual-review queue gauge | `tracks the manual-review queue and awaiting resolutions` | `rollback-and-metrics.test.ts` |
| Alerts | `raises when a transaction is stuck beyond the safe period` | `rollback-and-metrics.test.ts` |
| Residual is critical | `treats a non-zero ledger residual as critical` | `rollback-and-metrics.test.ts` |

## Implemented test map — recovery worker

82 tests across three files in `tests/worker/`. See [[Recovery Worker]].

| Requirement | Test | File |
|---|---|---|
| Worker starts only when enabled | `does nothing when disabled` | `lifecycle.test.ts` |
| Disabled is logged, not raised | `logs why it did not start` | `lifecycle.test.ts` |
| Initial sweep is configurable | `sweeps immediately when configured to` / `waits one interval first when configured to` | `lifecycle.test.ts` |
| Interval respected | `respects the configured interval between sweeps` | `lifecycle.test.ts` |
| Jitter within bounds | `keeps jitter within the configured bound` | `lifecycle.test.ts` |
| No overlapping sweeps | `never runs two sweeps at once` | `lifecycle.test.ts` |
| Overlap recorded as skipped | `records an overlapping runOnce as skipped rather than running it` | `lifecycle.test.ts` |
| **No timer-drift runaway** | `a slow sweep does not cause a runaway loop` | `lifecycle.test.ts` |
| Safe boundary passed to sweep | `passes the shutdown check into the sweep as its safe boundary` | `lifecycle.test.ts` |
| Batch limit passed through | `passes the batch limit through to the sweep` | `worker-integration.test.ts` |
| First failure uses initial backoff | `backs off after a failure and records it` | `lifecycle.test.ts` |
| Repeated failures increase backoff | `increases backoff across repeated failures` | `lifecycle.test.ts` |
| Backoff capped | `is capped at the configured maximum` | `config-and-backoff.test.ts` |
| Jitter applied to backoff | `applies jitter within the configured bound` | `config-and-backoff.test.ts` |
| Success resets backoff | `resets backoff after a success` | `lifecycle.test.ts` |
| Provider failure classified | `classifies a provider failure and keeps going` | `lifecycle.test.ts` |
| Database failure stops the worker | `stops the worker on a database failure rather than retrying into it` | `lifecycle.test.ts` |
| Partial batch is still a success | `a sweep reporting per-transaction failures is still a successful sweep` | `lifecycle.test.ts` |
| Failures are never hidden | `never hides a failure` | `lifecycle.test.ts` |
| SIGTERM stops new work | `SIGTERM stops new work` | `lifecycle.test.ts` |
| SIGINT stops new work | `SIGINT stops new work` | `lifecycle.test.ts` |
| Shutdown is idempotent | `is idempotent — a second request keeps the first reason` | `lifecycle.test.ts` |
| Only own claims released | `releases only its own claims` / `a worker releases only its own claims on shutdown` | `lifecycle.test.ts`, `worker-integration.test.ts` |
| Database closed | `closes resources through onStopped` | `lifecycle.test.ts` |
| Survives a release failure | `survives a failure to release claims` | `lifecycle.test.ts` |
| Signal handlers uninstalled | `uninstalls its signal handlers on dispose` | `lifecycle.test.ts` |
| Health after success | `is healthy after a successful sweep` | `lifecycle.test.ts` |
| Degraded while backing off | `is degraded while backing off` | `lifecycle.test.ts` |
| Unhealthy on non-zero residual | `is unhealthy when the ledger residual is non-zero` | `lifecycle.test.ts` |
| Unhealthy on database fault | `is unhealthy when the database is unhealthy` | `lifecycle.test.ts` |
| Degraded when falling behind | `is degraded when the oldest unresolved transaction is too old` | `lifecycle.test.ts` |
| Survives a gauge failure | `survives a gauge read that throws` | `lifecycle.test.ts` |
| Metrics once per event | `emits each sweep metric once per sweep` | `lifecycle.test.ts` |
| Queue gauges published | `publishes queue gauges` | `lifecycle.test.ts` |
| Log identifiers present | `includes worker and sweep identifiers on log events` | `lifecycle.test.ts` |
| **Sensitive keys refused** | `refuses to log a sensitive key` | `lifecycle.test.ts` |
| Production configuration explicit | `production configuration must be explicit` | `config-and-backoff.test.ts` |
| Production has no numbers | `the production policy carries no numbers at all` | `config-and-backoff.test.ts` |
| No production fallback | `production never silently falls back to development values` | `config-and-backoff.test.ts` |
| Nine validation rules | `rejects %s` (parametrised) | `config-and-backoff.test.ts` |
| Training mode enforced | `refuses to build a worker outside training mode` | `worker-integration.test.ts` |
| 5I regression through the worker | `PROCESSING success finalizes exactly once` and five more | `worker-integration.test.ts` |
| Two connections, one claim | `only one claims a transaction; the other records a conflict` | `worker-integration.test.ts` |
| Conflict recorded and safe | `the losing worker continues safely and records the conflict metric` | `worker-integration.test.ts` |
| Live lease cannot be stolen | `a live unexpired lease cannot be stolen` | `worker-integration.test.ts` |
| Expired lease reclaimable | `an expired lease can be reclaimed across connections` | `worker-integration.test.ts` |
| **Multi-process is NOT proven** | `is documented as untested — these are connections, not processes` | `worker-integration.test.ts` |

> [!warning] What the concurrency tests do and do not prove
> They use two **separate SQLite connections to the same file**, which exercises the real atomic
> claim across connections. They run in one process. Multi-*process* safety is **not** proven, and
> assumption **A37 remains open** — a test asserts that claim rather than letting it drift.

## Implemented test map — build and multi-process

16 tests in `tests/build/child-process.test.ts`. These spawn **real operating-system processes**
running the compiled worker. See [[Build Pipeline]].

| Requirement | Test |
|---|---|
| Fresh build produces output | `beforeAll` runs `scripts/build.mjs` and fails the file if it errors |
| No TypeScript at runtime | `emits JavaScript and declarations, and no TypeScript` |
| CommonJS declared in output | `declares CommonJS in every dist so Node parses the emitted files correctly` |
| Compiled worker starts and connects | `the compiled worker starts, connects to SQLite, sweeps and exits cleanly` |
| No type stripping needed | `runs without TypeScript stripping — no loader flags are passed` |
| Missing database exits non-zero | `a missing database is a clear, non-zero failure` |
| Non-training mode refused | `a non-training mode is refused before the database is opened` |
| Invalid configuration exits non-zero | `invalid configuration exits non-zero rather than running` |
| **Two processes race one transaction** | `exactly one claims it; the other records a conflict` |
| No database lock failures | `neither process reports a database lock failure` |
| Two processes, two transactions | `two processes resolve two different transactions without corruption` |
| Live claim cannot be stolen | `a live claim held by another worker cannot be stolen` |
| Expired claim reclaimed | `an expired claim is reclaimed by another process` |
| Dead worker blocks only until expiry | `a worker that dies holding a lease blocks others only until the lease expires` |
| Killed process leaves database sound | `killing a process mid-run leaves the database sound` |
| Repeated startup does not duplicate | `does not duplicate a resolution` |
| No duplicate support case across processes | `does not duplicate a support case when escalating across processes` |

> [!note] These are genuinely separate processes
> Each test asserts the child's `pid` differs from the test runner's. Nothing here uses two
> connections in one process, and nothing mocks process separation. This is what closed
> assumption **A37**.

## UI and API-surface tests

`tests/ui/` covers the merchant POS and the training HTTP surface. Six areas:

| File | What it defends |
|---|---|
| `presentation.test.ts` | The state-to-UI table, exhaustively over every domain state |
| `api-surface.test.ts` | The training boundary, isolation, validation, redaction, correlation |
| `screens.test.ts` | Every screen carries the banner; no false success; the retry instruction; accessibility |
| `client.test.ts` | The typed client, the presentation state machine, the bounded polling loop |
| `flow.test.ts` | The whole counter journey, against a real database and a real recovery sweep |
| `server.test.ts`, `cli.test.ts`, `redaction.test.ts`, `localization.test.ts` | Routing, the entry point, the display gate, and the string tables against the vault |

Two rules shape them:

1. **No sleeps.** The scheduler is injected and driven by hand, and `PollController.settled()`
   lets a test await the attempt in flight rather than guessing how many microtasks a fetch takes.
   Guessing is what makes a UI test flake on a loaded machine — [[Test Stability Runbook]].
2. **Assert the rendered tree, not the view model.** A rendering mistake must not be able to pass
   by agreeing with itself.

The `cli.test.ts` cases spawn a **real child process** against `dist/`, so they fail if the build
is stale or the emitted module format is wrong — the same reasoning that closed A37.

**The honest limitation**: these are component-level tests. No browser, no CSS, no real screen
reader. See [[Merchant POS Screens]].

## Stability and stress

An intermittent failure is investigated, never retried away. `npm run test:recovery:stress` runs
the escalation scenario as a soak on fresh databases, then repeats the recovery and worker suites
with randomised order — order dependence and leaked state only appear in the second pass.

| Command | What it does |
|---|---|
| `npm run test:recovery:stress` | Soak plus shuffled repeats; exits non-zero on any failure |
| `npm run test:stress` | The soak alone |

`testTimeout` is stated explicitly at 30 seconds and `hookTimeout` at 60. That is a **resource**
budget for database-backed tests on a small machine, not permission for a slow test: every test is
deterministic, and a test that needs more time than this has a defect rather than a deadline
problem.

The stress suite lives under `tests/stress/` with its own config, so a long soak never slows an
ordinary run. Procedure and the record of all four observed flakes are in [[Test Stability Runbook]].

## Test database policy

Every persistence suite creates its **own database file** in its own temp directory and removes it
afterwards. `:memory:` is deliberately not the default: an in-memory database reports
`journal_mode = memory` and so could never prove WAL is on.

## Unit

State machine · idempotency · payload mismatch · reservations and releases · fees · limits ·
permissions · provider health · reprints.

| Test | Assertion |
|---|---|
| Transition table exhaustive | Every legal transition succeeds; **every illegal one throws** |
| Terminal states | No transition leaves `SUCCESSFUL`, `FAILED`, `REVERSED`, `REJECTED` |
| Timeout is not failure | `PROCESSING` + no response → `PENDING`, never `FAILED` |
| Money has no float path | No constructor or accessor accepts or returns a float |
| Reservation arithmetic | Reserve then release restores available **exactly** |
| Fee on success only | No fee on blocked, rejected, failed, pending, duplicate, reversed |
| Reprint | `ReprintEvent` emitted; ledger entry count **unchanged** |

## Contract — mock provider

Every behaviour is a contract test: `SUCCESS` · `FAILURE` · `TIMEOUT` · `DELAYED_SUCCESS` ·
`DELAYED_FAILURE` · `MALFORMED_RESPONSE` · `DUPLICATE_CALLBACK` · `OUTAGE`.

A malformed provider response must produce `PENDING`, never a crash and never a false success.

## Integration

Database integrity · ledger reconciliation · funding · support approvals · reporting ·
notifications.

| Test | Assertion |
|---|---|
| Append-only enforced | `UPDATE`/`DELETE` on `LedgerEntry` **fails at the database** |
| Sum to zero | Property test over random transaction sequences: entries sum to zero |
| Balance views agree | Available + reserved + under review = total, derived from entries |
| Transactional balance change | A failure mid-reservation leaves **no** partial state |
| Funding separation of duties | A verifier cannot approve their own high-value submission |

## End to end

| # | Scenario | Assertion |
|---|---|---|
| 1 | Successful sale and receipt | One debit, one commission, receipt available |
| 2 | Confirmed failure | Reservation released, no charge |
| 3 | Timeout → pending | Reservation held, retry blocked |
| 4 | Pending → successful | Debit applied **once** |
| 5 | Pending → failed | Reservation released **once** |
| 6 | Pending → under review | Value in under-review bucket, excluded from available |
| 7 | **Duplicate retry prevention** | One transaction, one debit, one receipt |
| 8 | Printer failure → safe reprint | Sale stands; reprint creates no sale |
| 9 | Outage isolates airtime | Airtime blocked, other approved services live, no charge |
| 10 | Offline → reconnect | Sales stop; history live; state synchronized |
| 11 | Ledger reconciliation | No mismatch after a mixed-outcome day |
| 12 | Merchant isolation | Merchant A cannot see or affect merchant B |

## Security

Unauthorized balance changes · cross-merchant access · privilege escalation · duplicate
submissions · forged and replayed callbacks · secret leakage · audit tampering.

## Accessibility

Contrast in both themes · touch-target size · **status never conveyed by colour alone** ·
Amharic layout does not truncate or overlap · screen-reader labels on status.

## Migration

Every migration is applied forward and rolled back against a seeded database, asserting no ledger
history is lost.

## The two tests that gate Phase 3

**E2E 7 (duplicate retry prevention)** and **integration sum-to-zero**. A failure in either blocks
the phase exit regardless of everything else passing — see the technical trial plan (commercial material, kept outside this repository).

## Reporting

Test results are reported as **actual output**, never as a claim. A run that fails is reported as
failing, with the output.

## Authentication and authorization tests — 2026-08-21

`tests/auth/` — **126 tests** in six files. Every clock is injected: session
expiry, lockout expiry and rate windows are exercised by advancing a fake clock,
never by sleeping.

| File | Tests | What it defends |
|---|---|---|
| `authentication.test.ts` | 27 | Sign-in, PIN policy, lockout, session lifetime, cookie attributes, session fixation, token never accepted from a URL or header |
| `device-binding.test.ts` | 18 | The pure decision, every enrolment state, revocation mid-session, re-enrolment, reassignment — **and a test that demonstrates the training-grade limitation** |
| `authorization.test.ts` | 24 | The permission table, merchant scoping, every route needing a session, tampering, and the absence of privileged routes |
| `csrf-and-abuse.test.ts` | 19 | CSRF in body and header, rate limits, body size, and the audit trail |
| `migration.test.ts` | 11 | Migration 006, and that it leaves the ledger byte-identical |
| `screens.test.ts` | 27 | The four auth screens, the identity indicator, keyboard order |

### Two properties worth naming

**A refused write creates nothing.** Several tests assert the transaction count
is unchanged *and* the ledger residual is still zero afterwards, because "the
request was refused" and "nothing happened" are different claims and only the
second protects a balance.

**Secrets are absent, not merely unused.** `authentication.test.ts` walks
**every string column of every table** looking for the test PIN.
`csrf-and-abuse.test.ts` serialises the whole audit trail and looks for the PIN,
the device key and both tokens. A future column that accidentally stored one
would fail these without anyone remembering to check.

### What these tests do not cover

They render an element tree, not a browser. No DOM, no CSS, no screen reader, no
real cookie jar. **A48 stays OPEN** — see [[Merchant POS Screens]].

## Transport tests — 2026-08-21

`tests/transport/` — **74 tests** in four files, plus a smoke test that runs the
compiled binary.

| File | Tests | What it defends |
|---|---|---|
| `config.test.ts` | 22 | Every unsafe configuration is refused with a stable reason code |
| `tls.test.ts` | 12 | Loading, mismatch detection, expiry and permission reporting — and that a message never carries key material |
| `proxy.test.ts` | 26 | Scheme resolution, **spoofed forwarding headers**, host and origin |
| `https-server.test.ts` | 18 | A **real** `node:https` listener: cookie attributes, headers, nonce freshness, the counter flow, logout, device revocation, shutdown |

### The certificate problem, and how it was solved

TLS tests need a certificate; a committed certificate means a committed private
key, which `check-committed.mjs` refuses — rightly. Shelling out to `openssl`
would make the tests depend on a binary not guaranteed on a runner, and a
skipped security test is worse than none because it looks like coverage.

So `tests/transport/certs.ts` builds one **in memory** from `node:crypto`, with a
hand-written minimal DER encoder. `node:crypto` can parse X.509 but not create
it, which is why the encoder exists. Nothing reaches disk except a temporary
directory that is deleted.

### The smoke test

`npm run training:smoke` runs the **compiled** `dist/cli.js` over real TLS
against a real SQLite file: fifteen steps, thirty-eight checks. It found two
defects the unit tests could not — provisioning failed on a fresh database
because it created no merchant or device row, and `--port 0` was rejected by the
argument parser though the transport validator allowed it.


## The child-process stress command — 2026-08-21

```bash
npm run build:clean            # first, and let it finish
npm run test:child-process:stress
```

Two passes: 100 iterations of each racing scenario from
`tests/stress/child-process.stress.test.ts`, then 3 runs of the real
`tests/build/child-process.test.ts`. Volume alone would not prove the file
passes; the file alone would not reach the volume.

**It refuses to build.** Compiling while worker children compete for two cores is
the A51 pattern and produced the truncated failure recorded as A55. The script
checks the output is present and current and **exits 4** otherwise, rather than
helpfully building.

**It preserves the evidence.** A failing iteration keeps its database and writes
a complete artifact to `stress-logs/child-process/`: seed, iteration, command
line, migration versions, transaction, claim, pending, audit and ledger rows,
the residual, both workers' full reports, both children's stdout, stderr, exit
code, signal, PID and timing. That is what found A54 — the answer was in the
audit trail all along, and `afterEach` had been deleting it.

`tests/recovery/failure-path.test.ts` — 13 tests pinning down what a **failed**
recovery must do: nothing. No settlement, no transition, no ledger movement,
residual zero, transaction left where the next sweep finds it, and the failure
visible in the report with a safe reason code.


## Related

- [[Transaction State Machine]]
- [[Ledger Invariants]]
- [[Definition of Done]]

---
Back to [[00 Home]]
