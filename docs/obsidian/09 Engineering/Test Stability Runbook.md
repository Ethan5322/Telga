---
title: Test Stability Runbook
type: engineering
status: draft
owner: telga
created: 2026-08-20
updated: 2026-08-20
tags:
  - telga
  - engineering
  - testing
  - stability
related:
  - "[[00 Home]]"
  - "[[Testing Strategy]]"
  - "[[CI Pipeline]]"
  - "[[Recovery Sweep]]"
  - "[[Runbooks]]"
depends_on:
  - "[[Testing Strategy]]"
implements: []
validates: []
decision_status: confirmed
---

# Test Stability Runbook

How to handle an intermittent test failure, and the record of the four we have had.

> [!note] Three of the four were test defects. The fourth — A54 — was a real
> product defect in the persistence layer, found only because the instrumentation
> was improved twice rather than the test being weakened once.

> [!danger] The one rule
> **Never make a flaky test pass by weakening it.** No retries, no added delays, no skips, no
> loosened assertion that is not *more* true than the one it replaces. A flake in recovery code is
> a claim about money that sometimes fails to hold — it is either a real defect or a test that
> asserts the wrong thing, and both deserve to be found.

## Procedure

1. **Reproduce in isolation first.** `npx vitest run <file> -t "<name>"`, several times. Passing here means the scenario itself is deterministic and the cause is elsewhere.
2. **Soak it.** `npm run test:recovery:stress` runs the scenario hundreds of times on fresh databases, then repeats the recovery and worker suites with randomised order. Order dependence and leaked state only show up in the second pass.
3. **Reproduce under load.** Run the full suite; file-level parallelism and CPU contention are what most flakes need.
4. **Capture state, not guesses.** `diagnose()` in `tests/recovery/helpers.ts` returns a safe snapshot — ids, states, clock values, claim and pending status, balances, residual. Attach it to the failing assertion so a recurrence reports what the system actually looked like.
5. **Decide which kind it is.**
   - *Product defect* → fix the domain, application or persistence code.
   - *Test defect* → fix the assertion to state the real invariant, and say why in a comment.
6. **Prove it.** Stress plus at least three consecutive clean full runs.
7. **Write it up here.**

## What to check when a recovery test flakes

| Cause | How to check |
|---|---|
| Shared database state | Every harness must call `mkdtempSync`; assert distinct file paths |
| Test-order dependence | `--sequence.shuffle` with a recorded seed |
| Incomplete cleanup | `afterEach` closes drivers and removes temp directories |
| Concurrent worker interference | Assert claim `worker_id`, not just claim counts |
| Reused identifiers | Id factories are per-harness; ids sort lexicographically, so "first" and "last" row are not "oldest" and "newest" |
| Clock or deadline boundary | Every clock below the worker is injected; a real clock reaching that code is a defect |
| Non-deterministic mock state | The mock has no `Math.random`, no `Date.now`, no `setTimeout` |
| **CPU starvation** | Check whether the run does heavy work *inside* itself — a compile, a large spawn. A deterministic test can still miss a deadline it never competes for on a bigger machine |
| Unawaited async work | A missing `await` shows up as a pass that becomes a fail under load |

## Recorded flakes

### A44 — `marks manual review open on the pending row`

**Observed once**, in one of several full-suite runs on 2026-08-20:
`expected 'NONE' to be 'OPEN'`.

Investigation:

- 120-iteration soak on fresh databases: **passed**.
- Repeated isolated runs: **3/3 passed**.
- Repeat full-suite runs after instrumentation: **passed**.

**Not reproduced.** The scenario is deterministic — every clock on that path is injected — so a
timing dependency should not exist, which is exactly why it is worth watching rather than closing.

Actions taken:

- Diagnostics attached to the assertion, so a recurrence reports the full safe state.
- The test now asserts `report.recoveryFailures === 0` and `report.escalatedUnderReview === 1`
  **first**, which distinguishes "the escalation did not happen" from "a swallowed per-transaction
  failure prevented it" — the most plausible remaining mechanism.
- `stuckProcessing` now identifies the new transaction by diffing ids rather than taking `[0]`.

**Status: OPEN.** Kept open deliberately: passing after instrumentation is not proof of a fix when
the original failure was never reproduced.

### The child-process race — `exactly one claims it; the other records a conflict`

**Observed and diagnosed.** Failed under full-suite load, passed 5/5 in isolation.

**Root cause: a test defect, not a product defect.** The assertion was `claimed === 1`. Two
outcomes are both correct:

- the loser's claim is refused while the winner holds a live lease; or
- the winner **finishes and releases** before the loser reaches the claim, so the loser claims
  legitimately and then finds the transaction already terminal when it re-reads it under that claim.

Which happens depends on scheduling. The safety property is that the transaction is **resolved**
once, not **claimed** once — and that is guaranteed by the re-read under claim in `recoverOne`,
not by the claim count.

Fixed by asserting the real invariant: at least one process claims, exactly one recovery occurs,
exactly one settlement entry exists, residual stays zero.

**Status: RESOLVED.**

### The dead-worker lease test — `a worker that dies holding a lease blocks others only until the lease expires`

**Observed and diagnosed.** Failed under full-suite load, passed in isolation.

**Root cause: a real-time dependency in the test.** It set a lease expiring 1.5 seconds out, spawned
a child process expecting it to be blocked, slept two seconds, then spawned another expecting it to
reclaim. Under load, spawning the first child took longer than the lease, so by the time it reached
the claim the lease had already expired — it claimed legitimately, and the assertion failed.

Fixed by removing the race rather than padding it: the lease is now long, and it is **expired
explicitly** with a direct update to `recovery_claims.expires_at` between the two child runs. Same
property, no wall clock, and no added delay. A longer sleep would only have hidden the problem.

The same pass fixed a related portability hazard: the harness seeds transactions with a **fixed fake
clock**, while child processes read the **real** one. Eligibility therefore depended on what the
wall clock happened to say. Seeded rows are now backdated against real time, so the tests work at
any hour and on any machine — which also matters for [[CI Pipeline]].

**Status: RESOLVED.**

### A51 — the whole suite failed while every test passed

**Observed and diagnosed.** After the merchant POS was added, three consecutive full runs exited
**1** while reporting `600 passed (600)`. The cause was an unhandled error:

```text
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
```

One run also failed a **pre-existing** recovery test — `never creates a duplicate pending row for
one transaction` — with `Test timed out in 5000ms`.

**Root cause: CPU starvation on a two-core machine, not a race in anything.**

`tests/build/child-process.test.ts` compiled **every package** in a `beforeAll`, inside the test
run, while other test files executed in parallel. The suite had grown from 419 tests to 600 and
the build from five packages to eight, so that spike now saturated both cores. Two of Vitest's
five-second budgets were exceeded as a result: the reporter's `onTaskUpdate` round trip, and the
default per-test timeout of an unrelated database-backed test.

**A first attempt was wrong and is worth recording.** The initial diagnosis was that
`execFileSync` blocked the worker thread, and the new POS child-process tests were converted to an
async `spawn`. Three more runs failed identically. That change was kept — not blocking a worker
thread is still correct — but it was not the cause.

Fixed by removing the contention rather than widening a deadline:

- **The build is now conditional.** `distIsStale()` compares the newest `.ts` source against the
  oldest emitted `.js` and rebuilds only when the output is genuinely stale. The guarantee these
  tests need is that they run *current* output, not that a build happens every time; CI builds
  before the suite, so it is a no-op there.
- **`testTimeout` is stated explicitly** at 30s, with `hookTimeout` at 60s. This is a **resource**
  budget, not a loosened assertion: every test is deterministic, clocks and schedulers are
  injected, and nothing sleeps. Five seconds is a fair budget for a pure unit test on an idle
  machine and far too tight for a SQLite-backed one on a two-core box, where it fails on
  contention rather than on behaviour. No assertion changed, no retry was added, nothing was
  skipped.

**Evidence:** three consecutive clean runs, 600/600, **exit 0**, no unhandled errors — and the
suite got faster, 224s / 217s / 280s against 301s / 441s before.

**Status: RESOLVED.**

### A54 — zero recoveries from spawned workers — **RESOLVED**

**Root cause: `SQLITE_BUSY_SNAPSHOT`, caused by a deferred write transaction.**
A product defect, found by following the evidence rather than guessing.

#### How it was found

Three instruments, each added because the previous one was not enough:

1. **Diagnostics on the assertion.** The first attempt hand-picked field names
   and printed `-1` for two of them, hiding the fields that mattered. Lesson:
   **dump the object, do not guess keys.**
2. **The worker CLI was not reporting enough.** It projected a subset of the
   sweep report — no `skipped`, no `recoveryFailures`, no `stoppedEarly`. A
   sweep that claimed work and resolved none of it returned a row of zeroes and
   explained nothing. Those fields were added, and then `failureReasonCodes`.
3. **A dedicated stress harness that preserves the evidence.** The real test
   file deletes its database in `afterEach` — and the database is where the
   answer lived, because the recovery service already writes a
   `RECOVERY_ATTEMPT_FAILED` audit event carrying a safe code. Every failing run
   had thrown that away.

`npm run test:child-process:stress` reproduced it on **iteration 1**:

```json
{ "workerId": "w_a", "found": 1, "claimed": 1, "recoveredSuccessful": 0,
  "recoveryFailures": 1, "failureReasonCodes": ["SQLITE_BUSY_SNAPSHOT"],
  "ledgerResidualMinor": 0, "level": "DEGRADED" }
```

#### Why it happened

`SqliteLedgerDriver.transaction()` used better-sqlite3's default, which is
`BEGIN` — a **deferred** transaction. A deferred transaction starts as a
*reader* and upgrades on its first write. In WAL mode, if another connection has
written since the read snapshot began, that upgrade fails with
**`SQLITE_BUSY_SNAPSHOT`** — which SQLite returns **immediately** and which
`busy_timeout` does **not** wait out, because the transaction's own reads may
already be stale.

Every unit of work reaching that method writes. Two worker processes racing one
transaction is exactly the condition that triggers it, and the full suite is
simply what made two processes overlap often enough to notice.

#### The fix

`BEGIN IMMEDIATE`: take the write lock at the start, so the un-waitable failure
becomes an ordinary wait that `busy_timeout` handles. One line, in the one place
that decides how a unit of work begins.

**No retry wrapper was added.** A bounded retry was considered and rejected:
`BEGIN IMMEDIATE` removes the error rather than surviving it, and a retry around
an ambiguous commit is precisely the thing this codebase must not do.

#### Evidence

| Check | Before | After |
|---|---|---|
| `test:child-process:stress` (100 iterations × 2 scenarios) | reproduced on iteration 1 | **200 iterations clean** |
| The real test file, 3 consecutive runs | intermittent | clean |
| Full suite | 2 failures in 8 runs | see the report |

#### What else it exposed

The health policy said `HEALTHY` while reporting a recovery failure and zero
recoveries. A zero ledger residual is **necessary, not sufficient**: it says the
books are consistent, not that recovery did its job. `healthLevel` now takes the
sweep outcome and returns `DEGRADED` when a recovery failed, or when work was
claimed and nothing was disposed of. A *skip* stays healthy — a contested claim
is normal operation.

> [!danger] Never run a build and the test suite at the same time here
> A full run that overlapped `npm run build:clean` failed four tests whose output
> was truncated; isolated runs of the same suite passed. On this constrained
> two-core environment the two commands starve each other. `test:child-process:stress`
> now **refuses to run** against stale output rather than helpfully building.
> Recorded as **A55** and [[Decision Log]] **D50**.

### A51 — reporter starvation, distinguished from a real failure

Two different things wore the same face, and separating them was the fix.

**Build contention** (A55/D50) — resolved as a rule: `test:child-process:stress`
refuses to run against stale output and never builds.

**Reporter starvation** — a stress test is one task running for minutes without
yielding, and vitest's `onTaskUpdate` RPC times out under that on two cores. The
run fails **while every assertion passed**, no artifact is written, and it looks
exactly like a code failure to anyone reading the exit code.

Two changes, neither of which weakens a test:

1. `--reporter=dot` for the stress passes. Verbosity only.
2. The stress command **classifies** a non-zero exit:

| Exit | Meaning | Evidence |
|---|---|---|
| `1` | A test failed | An assertion, or an artifact under `stress-logs/child-process/` |
| `3` | The harness failed | Reporter RPC timeout or dead worker, **and** no assertion failed, **and** no artifact |

An artifact or a failed assertion is decisive: the code failed, whatever else
the reporter did on its way down. Only when neither is present is it called
infrastructure.

**Evidence after the change: 3 consecutive clean runs** — 600 iterations plus 9
runs of the real file. One reporter timeout was observed *before* the change.

**A51 stays OPEN.** The reporter limit is a property of this machine under load;
it can recur. What changed is that it can no longer be mistaken for a defect.

## The stability gate

Before work that depends on the suite:

```bash
npm run typecheck
npm run build:clean
npm run test:recovery:stress
npm test          # three consecutive clean runs
npm run docs:validate
```

It passes only when the stress passes, three consecutive full runs are clean, no test was weakened
or skipped, no retry wrapper was added, and any root cause is written up above.

## Related

- [[Testing Strategy]]
- [[CI Pipeline]]
- [[Recovery Sweep]]
- [[Runbooks]]

---
Back to [[00 Home]]
