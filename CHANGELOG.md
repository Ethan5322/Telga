# Changelog

All notable changes to Telga. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

> **Operating state: TRAINING MODE — NO REAL VALUE.**
> No live provider is connected, no live money is enabled, and 0 of 10 launch gates in
> `docs/obsidian/07 Governance/Launch Gates.md` have been cleared.

## [Unreleased]

### Fixed — A54: a deferred write transaction could fail un-waitably (2026-08-21)

**A real product defect in the persistence layer**, found by instrumenting
rather than by weakening a test.

`SqliteLedgerDriver.transaction()` used better-sqlite3's default `BEGIN`, which
is **deferred**: the transaction starts as a reader and upgrades on its first
write. In WAL mode, when another connection has committed since the read
snapshot began, that upgrade fails with **`SQLITE_BUSY_SNAPSHOT`** — an error
SQLite returns immediately, which `busy_timeout` does **not** wait out, and which
cannot be safely retried because the transaction's reads may be stale.

Every unit of work reaching that method writes. Two worker processes racing one
transaction is exactly the triggering condition; the full test suite was simply
what made two processes overlap often enough to be noticed.

**Fixed with `BEGIN IMMEDIATE`** — take the write lock at the start, so the
un-waitable failure becomes an ordinary wait. No retry wrapper was added: the fix
removes the error rather than surviving it, and a retry around an ambiguous
commit is what the ledger rules forbid.

| Evidence | Before | After |
|---|---|---|
| `test:child-process:stress`, 100 iterations × 2 scenarios | reproduced on **iteration 1** | **200 iterations clean** |
| The real test file, 3 consecutive runs | intermittent | clean |
| Full suite, 3 consecutive isolated runs | 2 failures in 8 | **817/817 × 3** |

### Fixed — the worker could report HEALTHY while recovery was failing

A zero ledger residual is **necessary, not sufficient**: it says the books are
consistent, not that recovery did its job. `healthLevel` now takes the last
sweep's outcome and returns `DEGRADED` when a recovery failed, or when work was
claimed and nothing was disposed of. A *skip* stays healthy — a contested claim
is normal operation.

### Added

- **`npm run test:child-process:stress`** — 100 iterations per racing scenario on
  a fresh database each, then 3 runs of the real file. **Refuses to build**, and
  exits 4 against stale output. Preserves a complete failing artifact — database
  rows, audit trail, both worker reports, both children's output — under
  `stress-logs/child-process/`.
- **`tests/recovery/failure-path.test.ts`** — 13 tests for what a failed recovery
  must do: nothing, visibly.
- **Worker JSON now carries** `skipped`, `recoveryFailures`, `stoppedEarly` and
  `failureReasonCodes`. Without them a sweep that claimed work and resolved none
  of it returned a row of zeroes and explained nothing.

### Still open

- **A55/D50** — never run a build and the test suite concurrently here. Now
  enforced by the stress script rather than only documented.
- **A43** CI, **A30** concurrent migration, **A52** device binding, **A53**
  self-signed TLS, **A48** browser coverage, **A44**, **A34/A41** — unchanged.
- **A44 and A51 are not closed by this.** A54 was a different defect.
- Launch gates remain **0 of 10**.


### Added — HTTPS for the controlled training deployment (2026-08-21)

Reduces **A53**: a session token is no longer readable in plaintext on the wire.
It does not close it — the certificate is self-signed, which is not production
trust.

- **`apps/merchant-pos/src/transport/`** — four modules: `config.ts` (three
  explicit modes and every unsafe combination refused), `tls.ts` (loading, the
  certificate/key pair check, expiry and permission reporting), `proxy.ts`
  (trusted-proxy scheme resolution, host and origin), `headers.ts` (the security
  header set and the CSP).
- **`TRAINING_HTTP_LOCAL` / `TRAINING_HTTPS` / `LIVE`.** Plain HTTP is
  **refused** on any non-loopback binding rather than warned about; `LIVE` is
  still rejected before a database is opened.
- **A per-response CSP nonce.** `unsafe-inline` is gone from both `script-src`
  and `style-src`.
- **`Permissions-Policy`, COOP, CORP, and `no-store`** on every session-sensitive
  response; HSTS available, off by default, refused on plain HTTP.
- **`scripts/https-smoke.mjs`** — fifteen steps, thirty-eight checks, against the
  **compiled** binary over real TLS on a real database.
- **`--training-float`** — a named, off-by-default flag for a clearly-simulated
  opening balance. Creating a balance is a money operation even when the money is
  simulated, so it is never a side effect of setting up an operator.
- **74 transport tests**, including 18 against a real `node:https` listener, and
  a dependency-free X.509 generator so no private key is ever committed.

### Changed

- Cookie `Secure` is decided **per request** from the client's scheme, not from a
  single startup flag — behind a TLS terminator the process speaks HTTP while the
  client used HTTPS.
- `Host` is validated against an allow-list; `Origin` is checked on
  state-changing methods.
- The startup banner prints the port **actually bound**, the trusted-proxy
  addresses, and the certificate fingerprint — never key material.

### Fixed

Both found by the smoke test, which the unit tests could not have caught:

- **Provisioning failed on a fresh database.** `--provision-pin` created an
  operator that references a merchant and a device, neither of which existed.
- **`--port 0` was rejected by the argument parser** although the transport
  validator allowed it. Port 0 asks the operating system to choose, which is what
  an ephemeral or supervised deployment uses.

### Still open

- **A53** — self-signed is not production trust; an active substitution attack is
  not addressed.
- **A54 (new)** — `tests/build/child-process.test.ts` reported zero recoveries in
  **2 of 5** full-suite runs while passing 18/18 in isolation. **Cause not
  identified.** Diagnostics attached to both assertions. Closes neither A44 nor
  A51.
- **A55 (new, resolved as a rule)** — test and build commands must never run
  concurrently on this two-core machine.
- **A52** device binding, **A48** browser coverage, **A44**, **A43**, **A30**,
  **A34/A41** — all unchanged.
- Launch gates remain **0 of 10**.


### Added — authentication and device binding (2026-08-21)

Closes **A49 / R22** for controlled internal training: the POS took its merchant
from a URL parameter, which any operator could edit. Identity now comes from a
server-side session and nothing else.

- **`packages/domain/src/auth.ts`** — the permission table, and the pure session
  and device *decisions*. Every role answers for every permission, the way
  `VALID_TRANSITIONS` answers for every state. `FORBIDDEN_TO_MERCHANT` is a
  second, independently consulted list covering the money controls.
- **Migration 006** — `merchant_users`, `device_enrollments`, `sessions`,
  `auth_attempts`. All STRICT. Operators are constrained to `TRAINING` at the
  schema level. **No column exists** that a raw PIN, session token or device key
  could be written to.
- **`services/api/src/auth/`** — scrypt derivation with per-user salts and
  recorded parameters, 256-bit tokens, constant-time comparison, sign-in,
  `authenticate`, sign-out, device enrolment and revocation, and authorization
  decisions as typed values.
- **`services/api/src/http/guard.ts`** — size, session, device, permission,
  CSRF, rate limit, merchant-hint consistency, in that order, before any handler
  runs. The permission is declared in the route table, so a route cannot be added
  without stating what it needs.
- **Four screens** — sign in, session ended, not allowed, enrol a device — plus
  an identity indicator and a sign-out **form** on every authenticated screen.
- **`--provision-pin`** — creates the operator, enrols the device, prints the
  device key once, exits.
- **126 tests** in `tests/auth/`, every clock injected.

### Changed

- **No merchant id in any URL, link, form field or navigation href.** A supplied
  one is a consistency check and is refused on mismatch (`MERCHANT_SCOPE_MISMATCH`).
- `POST /sales` no longer accepts `merchantId`, `deviceId` or `operatorId`; all
  three come from the session.
- Another merchant's transaction and a nonexistent one now produce **identical**
  404s, so ids cannot be enumerated from status codes.

### Fixed

- **The device check now outranks the session verdict.** Revoking a device
  revokes its sessions, so the next request reported `SESSION_REVOKED` — a 401
  that sent the operator to a sign-in they could not pass. It now reports the
  device reason as a 403. Found by a failing test.
- **A device refusal was not audited at all** once the session had already been
  revoked. Now audited exactly **once per session**, so a stolen POS retrying in
  a loop cannot flood the audit table.
- **`focusOrder` counted `type="hidden"` inputs as keyboard-reachable**, which
  would have let a focus-order assertion pass while the real tab order differed.

### Security note

The display-redaction gate refused the first sign-in handler, because it returned
the CSRF token in the JSON body and the gate rejects any body carrying a key that
names a token. The fix was to take it out of the body — it travels in its own
cookie — rather than to loosen the gate. Decision **D41**.

### Still open

- **A52** — device binding is **training-grade**. A browser-supplied identifier
  plus a server-issued key is not hardware attestation, and a copied key on
  another machine is undetectable. A test demonstrates this.
- **A53** — the training POS serves **plain HTTP**, so cookies are not `Secure`
  and a session token is exposed on the wire. Controlled machine only.
- **A48** — no browser, DOM, CSS or screen-reader coverage.
- **A44**, **A43**, **A30**, **A34/A41** — unchanged by this work.
- Launch gates remain **0 of 10**.


### Added — merchant POS, training mode only (2026-08-20)

- **`apps/merchant-pos/`** — five server-rendered screens: home, new sale, transaction detail,
  transaction history, and the pending / under-review queue. `node apps/merchant-pos/dist/cli.js`
  runs it. Exit codes match the worker's: `0` clean, `2` bad args, `3` not training mode,
  `4` invalid config, `5` runtime failure, `6` migrations not applied.
- **`services/api/src/http/`** — five routes under `/api/training/`, all over the existing
  application services. One write, `POST /sales`, through `createSale`. `HttpRequest` and
  `HttpResponse` are plain values, so every API test runs without opening a socket.
- **`packages/pos-view-model/`** — pure: the state-to-UI table, the wire DTOs, the presentation
  state machine (loading / empty / error / **stale**), the bounded polling loop, and
  `assertSafeForDisplay`, the last gate before anything reaches a screen.
- **`packages/localization/`** — English and draft Amharic. `translate()` reports an English
  fallback rather than hiding it; fourteen keys have no Amharic and stay missing rather than being
  machine-translated.
- **A training simulation control.** The sale form lets an operator choose which scripted provider
  outcome to practise. It re-scripts the **mock** — `MockAirtimeProvider.useBehaviour` — is
  validated against the mock's own list, and is only ever consulted in training mode.
- Docs: new `Merchant POS Screens`, `State To UI Mapping` and `POS API Surface` notes; seven notes
  updated; Decision Log D36–D39; Risk Register R20–R23.

### Safety properties this release adds

- **Only `SUCCESSFUL` is presented as a sale.** Only it carries a confirmed certainty and only it
  may offer a receipt — asserted exhaustively over all twelve states.
- **Funds status is derived from `VALUE_DISPOSITION`**, never restated, so a screen cannot claim
  funds were released while the ledger still holds them.
- **"Do not retry yet"** is rendered as an alert above the status detail for every uncertain
  state, repeated on every list row, and the refusal is stated in a sentence rather than left as a
  missing button.
- **A double press is one sale.** `clientRequestId` is generated when the form is built, so both
  presses derive the same idempotency key; the form is post/redirect/get so a refresh cannot
  resubmit either.
- **A transport failure never becomes a sale outcome.** An unreachable API leaves the transaction
  where it was, marked `STALE`, with the last known answer still on screen.
- **`PENDING` is an HTTP success** (201), not a 4xx — a 4xx would teach a client to treat an
  unknown outcome as an error.
- **No endpoint** sets a state, posts a ledger entry, releases a reservation, completes a reversal
  or credits a balance. The reversal path stays out until there is an authenticated supervisor
  session to check.

### Fixed — the suite failed while every test passed (A51)

Three full runs exited **1** while reporting `600 passed (600)`, on
`[vitest-worker]: Timeout calling "onTaskUpdate"`; one also timed out a **pre-existing** recovery
test at Vitest's 5-second default.

**Root cause: CPU starvation on a two-core machine.** `tests/build/child-process.test.ts` compiled
every package in a `beforeAll`, inside the test run, while other files executed in parallel — and
the suite had grown from 419 tests to 600, the build from five packages to eight.

- The build is now **conditional**: `distIsStale()` compares the newest source against the oldest
  emitted file and rebuilds only when the output is genuinely stale. CI builds first, so it is a
  no-op there.
- `testTimeout` is stated explicitly at 30s and `hookTimeout` at 60s — a **resource** budget for
  database-backed tests, not a loosened assertion. Every test remains deterministic.
- The POS child-process tests use async `spawn` rather than `execFileSync`. This was a first,
  **incorrect** diagnosis of the same symptom; it was kept because not blocking a worker thread is
  right, but it was not the cause.

Three consecutive clean runs afterwards: 600/600, exit 0, no unhandled errors — and faster
(224s / 217s / 280s against 301s / 441s).

### Still open

- **A49** — the POS has **no authentication**. Reads are merchant-scoped in SQL, but nothing
  establishes who the caller is. Training-only, on a controlled machine; **blocking before any
  merchant uses it**.
- **A48** — component-level UI tests only: no browser, no CSS, no screen reader.
- **A51** is now **resolved** — see above.


### Added — stability, CI and migration ownership (2026-08-20)

- **`npm run test:recovery:stress`** — a soak of the escalation scenario on fresh databases, then
  repeated shuffled runs of the recovery and worker suites. Exits non-zero and writes failing output
  to `stress-logs/`. The stress suite has its own config so it never slows an ordinary run.
- **`diagnose()`** — a safe state snapshot (ids, states, clock values, claim and pending status,
  balances, residual) attached to the assertion that flaked, so a recurrence reports what the system
  actually looked like. No recipient data, no credentials.
- **Migration ownership enforced in code.** The worker opens the database **without migrating** and
  exits `6` if any migration is missing, naming the versions. Migrations are applied once by a single
  writer with `--migrate`. Previously every worker migrated on startup — the untested concurrent
  case behind A30.
- **`.github/workflows/ci.yml`** — install from lockfile, secret and generated-file check, typecheck,
  clean build, each test area, full suite, documentation validation, log upload on failure; plus a
  stress job on the default branch. Node 22.x and 24.x matrix.
- **`scripts/check-committed.mjs`** — refuses tracked secrets or build output.
- Docs: new `CI Pipeline`, `Test Stability Runbook`, `Migration Ownership` and
  `Multi-Process Migration Plan` notes; nine notes updated; Decision Log D33-D35.

### Fixed

- **The child-process race test asserted the wrong invariant.** It required `claimed === 1`, but a
  second process may legitimately claim after the winner releases and then find the transaction
  terminal on re-read. The safety property is that a transaction is **resolved** once, not
  **claimed** once — guaranteed by the re-read under claim, not by the claim count. Diagnosed as a
  test defect; the product was correct.
- `stuckProcessing` helpers identified the new transaction by position; ids sort lexicographically,
  so neither the first nor the last row is reliably the newest. Now diffed by id.
- **The dead-worker lease test raced the wall clock.** It set a lease expiring 1.5 seconds out and
  expected a child process spawned within that window to be blocked; under load, spawning took
  longer than the lease. Fixed by removing the race rather than padding it — the lease is now long
  and is expired **explicitly** between the two child runs. Same property, no wall clock, no added
  delay.
- **A portability hazard in the same tests.** Harnesses seeded rows with a fixed fake clock while
  child processes read the real one, so eligibility depended on the time of day. Seeded rows are now
  backdated against real time.

### Still open

- **A44** — the original intermittent failure was **not reproduced** across a 200-iteration soak,
  5 shuffled repeats, repeated isolated runs and repeated full runs. Kept **OPEN** rather than
  closed on absence of evidence. The two flakes that *were* reproduced during the investigation
  (A45, A47) were both test defects and are fixed.
- **A43** — CI is authored but has **never run**: no git remote, no commits.
- **A30** — concurrent multi-process migration remains untested; the risk is avoided, not solved.

### Added — build pipeline and multi-process proof (2026-08-20)

- **A real build.** `npm run build` compiles every package to its own `dist/` in dependency order;
  `npm run clean` and `npm run build:clean` are cross-platform Node, not shell built-ins.
  - `tsconfig.build.base.json` plus a `tsconfig.build.json` per package.
  - Emits **CommonJS** with `{"type":"commonjs"}` stamped into each `dist/`, because the sources use
    extensionless relative imports that Node's ESM resolver rejects.
  - The build **fails** if any TypeScript source reaches the output. Current output: 58 `.js`,
    58 `.d.ts`, 0 `.ts`.
- **`services/worker/src/cli.ts`** — the runtime entry point. Arguments and environment for database
  path, worker id, mode, `--once`, policy overrides and mock scripting. Meaningful exit codes:
  `0` ok, `2` bad arguments, `3` not training mode, `4` invalid configuration, `5` runtime failure.
- **`tests/build/child-process.test.ts`** — 16 tests that spawn **real operating-system processes**
  running the compiled worker and race them for the same claim. Full suite now **417 tests**.
- **`README.md`** — build, run, test and worker operation instructions.
- Mock provider gained `statusOverride`, so a worker in a fresh process can be scripted to a
  determinate lookup outcome.
- Docs: new `Build Pipeline` note; nine notes updated; Decision Log D30-D32.

### Fixed

- **A37 resolved.** Multi-process worker safety is now proved rather than assumed: separate
  processes, asserted distinct pids, one winner per claim, one settlement, residual zero. Risk R16
  closed in the register.

### Added — supervised recovery worker (2026-08-20)

- **`services/worker`** — the supervised loop that runs the recovery sweep unattended.
  - `recoveryWorker.ts` — composition root; refuses any mode but `TRAINING`.
  - `workerLifecycle.ts` — the loop. **The only place in the system that reads real time.**
    Fixed-delay scheduling, overlap guard, graceful shutdown.
  - `workerConfig.ts` — three named policies. Production carries no numbers and never falls back.
  - `backoff.ts` — exponential backoff with bounded jitter, capped, reset on success.
  - `failures.ts` — seven failure categories; database and schema faults are fatal.
  - `workerHealth.ts` — status and health level, with the reasoning ordered most-severe first.
  - `shutdown.ts` — cooperative cancellation, SIGTERM/SIGINT, idempotent.
  - `observability.ts` — structured log events and 20 named metrics, with forbidden-key redaction.
- **Sweep cancellation boundary** — `recoverInFlight` now accepts `shouldContinue`, checked between
  transactions, and reports `stoppedEarly`. Nothing is ever cancelled mid-operation.
- **Owner-scoped claim release** — `releaseClaimsOwnedBy` and `countActiveClaims`.
- **82 worker tests** across 3 files. Full suite now **401 tests**.
- Docs: new `Recovery Worker`, `Worker Configuration`, `Worker Operations Runbook` and
  `Deployment Runbook` notes with six Mermaid diagrams; nine existing notes updated;
  Decision Log D25-D29.

### Notes

- **A31 remains resolved** — the sweep now also runs on a schedule rather than only on demand.
- **A37 remains open.** The concurrency tests use two separate SQLite connections to one file,
  which exercises the real atomic claim across connections, but both live in one process. A test
  asserts that limitation so the claim cannot quietly drift out of the documentation.

### Added — recovery sweep (2026-08-20)

- **`services/api/src/application/recovery/`** — unattended recovery for transactions left in flight.
  - `recoverInFlight.ts` — the sweep. Claims each transaction under a time-bounded lease, looks up
    its status, and drives it to a determinate state or holds it and escalates.
  - `config.ts` — every threshold injected; per-provider policy overrides; no production default.
  - `results.ts` — seven provider-outcome categories, of which only two may move money.
  - `metrics.ts` — standing gauges and alert evaluation.
- **Migration `005_recovery_claims`** — `recovery_claims` lease table, plus `next_check_at`,
  `last_outcome_category`, `current_state` and `manual_review_status` on `pending_resolutions`, and
  `approved_by` / `approved_at` on `support_cases`.
- **Supervisor approval enforced in code** — `completeReversal` refuses any role outside
  `OPS_APPROVER` and `ADMIN`, and records the approver on the support case.
- **11 recovery audit actions** so an unattended recovery leaves a complete trail.
- **61 recovery tests** across 3 files, including two-worker concurrency, expired-lease reclaim, and
  failure injection at seven points. Full suite now **319 tests**.
- Docs: new `Recovery Sweep`, `Recovery Configuration`, `Recovery Sweep Runbook` and
  `Manual Review Runbook` notes with seven Mermaid diagrams; twelve existing notes updated;
  Decision Log D20-D24.

### Fixed

- **A31 resolved.** A transaction stuck at `PROCESSING` is now recovered automatically rather than
  waiting for someone to notice. The manual procedure in `Transaction Failure Runbook` remains as
  the fallback when the sweep itself reports a failure.
- The sweep also covers `PENDING`. `resolvePending` only acts when something calls it, and an
  unattended system has nothing calling it — without this, a transaction the sweep moved to pending
  would have held merchant money indefinitely and the escalation deadline would never have fired.
- The pending clock now starts when a transaction entered the in-flight state rather than when the
  sweep noticed it, so a long-stuck transaction no longer receives a fresh grace period.

### Added — transaction orchestration (2026-08-20)

- **`services/api`** — the application layer binding domain, persistence and the mock provider.
  - `application/createSale.ts` — the seventeen-step sale. Two units of work either side of the
    provider call; typed results; no raw error ever reaches a merchant.
  - `application/resolvePending.ts` — status lookup, resolution, and time-based escalation to
    `UNDER_REVIEW` with an automatic support case.
  - `application/reversal.ts` — `requireReversal` and `completeReversal`.
  - `application/results.ts` — discriminated union of 6 outcome kinds and 9 rejection kinds, each
    carrying a `nextAction` and a `messageKey`.
  - `application/context.ts` — injected clock, ids, catalog and mode. Nothing reads the real time.
  - `application/rehydrate.ts` — row to domain `Transaction`; the full recipient is never restored.
- **Migration `004_pending_and_support`** — `pending_resolutions` (deadline, attempts, status) and
  `support_cases` (reference, reason, status).
- **74 orchestration tests** across 5 files, including failure injection at eight points in the
  unit of work. Full suite now **256 tests**.
- Docs: new `Transaction Orchestration`, `Create Sale Service`, `Mock Provider Behavior` and
  `Transaction Failure Runbook` notes with seven Mermaid diagrams; ten existing notes updated;
  Decision Log D16-D19.

### Known gap

- A transaction can stick at `PROCESSING` if the outcome unit of work fails after the provider was
  called. Value stays reserved and the ledger stays balanced, but **no automatic recovery sweep
  exists yet**. Manual procedure in `Transaction Failure Runbook`; tracked as assumption A31.

### Added — SQLite persistence layer (2026-08-20)

- **`packages/persistence`** — SQLite behind a `LedgerDriver` interface.
  - `driver/types.ts` — the swappable contract. Deliberately offers **no** `updateLedgerEntry` and
    **no** `deleteLedgerEntry`.
  - `sqlite/connection.ts` — PRAGMAs set and **read back**: WAL, `foreign_keys = ON`,
    `busy_timeout = 5000`, `synchronous = FULL`.
  - `sqlite/migrator.ts` — ordered, checksummed, one transaction per migration.
  - `sqlite/driver.ts` — `SqliteLedgerDriver`.
  - `repositories/` — merchants, transactions, ledger, reservations, audit. Parameterized queries
    throughout; every scoped read filters in SQL.
  - `operations.ts` — atomic reserve, release, finalize, move-to-under-review, release-from-review.
  - `privacy.ts` — recipient masking, salted hashing, metadata safety guard.
- **Migrations** — `001_initial_schema` (7 STRICT tables), `002_ledger_append_only`,
  `003_audit_append_only`.
- **Database-level append-only enforcement** — `BEFORE UPDATE` and `BEFORE DELETE` triggers on
  `ledger_entries` and `audit_events`. Tests attempt raw SQL and assert both abort.
- **79 persistence tests** across 5 files. Full suite now **182 tests**.
- Domain: added `MERCHANT_AVAILABLE`, `MERCHANT_RESERVED`, `MERCHANT_UNDER_REVIEW` account kinds so
  the balance buckets become auditable postings; `settledBalance` now sums all merchant-owned kinds.
- Docs: new `SQLite Persistence Layer`, `Migration Strategy`, `Database Operations Runbook` notes
  with four Mermaid diagrams; ten existing notes updated; Decision Log D12–D15.
- Toolchain: `better-sqlite3` ^13, `@types/node`, `@types/better-sqlite3`.

### Added — domain foundation (2026-08-20)

- **`packages/domain`** — the pure domain layer. No I/O, no database, no network, no framework.
  - `states.ts` — 12 transaction states, the transition map as data, terminal states, and a
    `VALUE_DISPOSITION` table assigning every state exactly one balance bucket.
  - `transaction.ts` — the immutable Transaction aggregate; every state change goes through
    `transitionTo`, which consults the map.
  - `idempotency.ts` — key derivation from request identity, payload fingerprinting, and the
    store that turns a retry into a replay instead of a second sale.
  - `ledger.ts` — append-only ledger with double-entry balance enforcement and account
    segregation. No update, no delete, no void.
  - `balance.ts` — reservations and the four derived views: available, reserved, under review, total.
  - `money.ts` — integer santim only; no float path into or out of the type.
  - `mode.ts` — `assertSimulated`, the structural guard that refuses anything marked LIVE.
  - `provider.ts` — the `AirtimeProvider` contract, with an outcome type that can express
    "I do not know".
  - `commission.ts` — rule placeholders whose compute functions **throw**, because no rate is confirmed.
  - `receipt.ts` — receipts and `recordReprint`, which returns an event and cannot touch the ledger.
  - `audit.ts` — append-only audit log.
  - `errors.ts` — 16 typed domain errors carrying stable codes.
- **`services/provider-adapters/mock-airtime`** — deterministic mock provider covering all eight
  required behaviours: success, failure, timeout, delayed success, delayed failure, malformed
  response, duplicate callback, outage. No `Math.random`, no `Date.now`, no `setTimeout`; a virtual
  clock advances only when a test says so. **No HTTP client exists in this package.**
- **`tests/`** — 103 tests across 6 files covering the state machine, idempotency, ledger
  invariants, balance model, reprints, audit events, merchant isolation, and the mock provider.
- **`ASSUMPTIONS.md`** — 21 assumptions mirrored from the pilot register, plus 4 introduced during
  implementation.
- Toolchain: TypeScript 5.9, Vitest 3.2, npm workspaces. Root `tsconfig.json` and `vitest.config.ts`.

### Changed

- `docs/obsidian/03 Domain/Transaction State Machine.md` — expanded to name all 12 states
  explicitly, with valid transitions, invalid transitions, terminal states, and the test case
  mapped to each transition.
- `docs/obsidian/03 Domain/Domain Glossary.md` — added the transaction states as first-class
  vocabulary.
- `docs/obsidian/09 Engineering/Testing Strategy.md` — added the test-to-transition mapping.
- `docs/obsidian/09 Engineering/Architecture.md` — added the implemented domain package layout.
- `docs/obsidian/07 Governance/Decision Log.md` — added D8–D11.

### Fixed

- `CREATED`, `VALIDATED`, `RESERVED` and `REVERSAL_REQUIRED` were isolated nodes in the knowledge
  graph: they appeared only in the state machine note and were named nowhere else. Now documented
  and tested explicitly.
- Idempotency key derivation originally hashed the whole payload, which made a payload mismatch
  undetectable — a tampered request would have produced a different key and looked like a new sale.
  The key now derives from request identity only, with the payload covered by a separate
  fingerprint. Found by writing the test the specification asked for.

## [0.1.0] — 2026-08-19

### Added — Obsidian and Graphify knowledge base (Phase 1)

- `CLAUDE.md` — the authoritative project instruction set, transcribed from the founder's
  `CLAUDE.pdf` (12 pages) into Obsidian- and Graphify-compatible Markdown.
- `docs/obsidian/` — 56-note vault across 11 folders: strategy, product, domain, UX, operations,
  partnerships, governance, pilot, engineering and templates.
- 13 Mermaid diagrams: roadmap, sale journey, transaction state machine, balance lifecycle,
  provider timeout and manual review, outage isolation, funding verification, complaint flow,
  system architecture, partner relationship map, pilot decision loop, and launch-gate dependencies.
- All eleven Phase 0 registers (A–K), deliberately empty and marked `NOT YET CONFIRMED` rather
  than pre-filled.
- Draft Amharic interface strings, every one marked
  **REQUIRES NATIVE AMHARIC REVIEW BEFORE PRODUCTION**.
- `graphify-out/` — knowledge graph: 95 nodes, 498 edges, 9 communities, 100% EXTRACTED.
- Vault validation: 0 broken links, 0 orphan notes, 0 missing frontmatter.

### Noted

- The source `CLAUDE.pdf` is clipped at the right page margin; eight vault-tree lines lost their
  tail mid-word. Reconstructed names confirmed by the founder and logged as an incident in
  `docs/obsidian/05 Operations/Source Specification Clipped In PDF.md`.

---

## Not in any release

The following remain deliberately unbuilt and unenabled: live provider integration, live money,
wallets, payment acceptance, cash-in/cash-out, lending, remittance, electricity tokens, general
bill payment, offline vending, independent settlement, and any real commission or price.
