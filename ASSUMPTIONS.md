# ASSUMPTIONS

Every belief Telga is built on that has **not** been verified. Mirrors
the pilot assumptions register, which is commercial material kept outside this
repository; that note and this file must be updated
together.

An assumption is not a risk. A risk is something that might go wrong; an assumption is something
we have decided to treat as true without evidence. Each one below names how it will be tested.

**Owner: NOT YET ASSIGNED** on every row — no role in
`docs/obsidian/07 Governance/Founders and Roles.md` has been filled.

**Status legend:** `OPEN` — unverified · `ACCEPTED` — a decision was taken on it ·
`CONFIRMED` — evidence exists.

---

## Market

### A1 — Shops run several disconnected vending tools and find it a problem
- **Confidence:** Medium
- **Impact:** Business. The entire product thesis. If merchants are content with their current tools, Telga has no wedge.
- **How it will be tested:** `99 Templates/Merchant Interview.md`, recorded outside this repository
- **Owner:** NOT YET ASSIGNED
- **Status:** OPEN

### A2 — Merchants will switch for reliability rather than commission
- **Confidence:** Medium
- **Impact:** Business. Determines whether Telga can win without out-bidding incumbents on rate.
- **How it will be tested:** Pilot retention over three months
- **Owner:** NOT YET ASSIGNED
- **Status:** OPEN

### A3 — The Flash/Kazang reseller model transfers to Ethiopia
- **Confidence:** Medium
- **Impact:** Business. The reference model behind the whole design.
- **How it will be tested:** Phase 4 commercial pilot
- **Owner:** NOT YET ASSIGNED
- **Status:** OPEN

### A4 — A single dependable workflow is worth a monthly fee
- **Confidence:** **Low**
- **Impact:** Business. One of three revenue streams; if false, the model rests on commission alone.
- **How it will be tested:** Pilot economics
- **Owner:** NOT YET ASSIGNED
- **Status:** OPEN

### A5 — Merchants will accept a training-mode day before live selling
- **Confidence:** Medium
- **Impact:** Operational. Training mode is the main defence against merchant error on day one.
- **How it will be tested:** Onboarding of the first pilot merchants
- **Owner:** NOT YET ASSIGNED
- **Status:** OPEN

## Operational

### A6 — Connectivity is good enough for pending states to resolve in minutes
- **Confidence:** **Low**
- **Impact:** Technical and operational. If false, most sales land in under review and support drowns.
- **How it will be tested:** Merchant baseline assessment (recorded outside this repository), then Phase 3
- **Owner:** NOT YET ASSIGNED
- **Status:** OPEN

### A7 — A 5-minute automatic pending maximum suits real provider behaviour
- **Confidence:** **Low**
- **Impact:** Technical. Sets when value moves to the under-review bucket. Too short floods the queue; too long strands merchant funds.
- **How it will be tested:** Provider agreement terms (recorded outside this repository), then Phase 3
- **Owner:** NOT YET ASSIGNED
- **Status:** OPEN — currently an **assumed default**, configurable in code

### A8 — Merchants can source compatible thermal paper themselves
- **Confidence:** Medium
- **Impact:** Operational. Paper shortage must never become a transaction failure.
- **How it will be tested:** Onboarding
- **Owner:** NOT YET ASSIGNED
- **Status:** OPEN

### A9 — Same-day field support is achievable in a compact area
- **Confidence:** Medium
- **Impact:** Operational. A disqualifier in the merchant scorecard depends on it.
- **How it will be tested:** Phase 4 pilot
- **Owner:** NOT YET ASSIGNED
- **Status:** OPEN

### A10 — Support can answer a complaint finally within 24 hours
- **Confidence:** **Low**
- **Impact:** Operational and reputational. The commitment in `05 Operations/Support and Disputes.md`.
- **How it will be tested:** Pilot resolution-time metric
- **Owner:** NOT YET ASSIGNED
- **Status:** OPEN

## Technical

### A11 — The first provider will offer status lookup by reference
- **Confidence:** Medium
- **Impact:** Technical. **Hard gate.** Without it a pending transaction can never resolve, and every silence becomes a human case.
- **How it will be tested:** Provider assessment (recorded outside this repository)
- **Owner:** NOT YET ASSIGNED
- **Status:** OPEN

### A12 — The provider will support a client-supplied reference or idempotency key
- **Confidence:** Medium
- **Impact:** Technical. Without it, provider-side duplicate protection is unavailable and Telga carries the whole risk.
- **How it will be tested:** Provider agreement terms (recorded outside this repository)
- **Owner:** NOT YET ASSIGNED
- **Status:** OPEN

### A13 — SQLite is sufficient for the Phase 2 prototype ledger
- **Confidence:** High
- **Impact:** Technical, reversible. Kept behind a driver interface, so Postgres is a driver swap.
- **How it will be tested:** Phase 3 load
- **Owner:** NOT YET ASSIGNED
- **Status:** ACCEPTED — Decision Log D4

### A14 — A web POS/PWA is sufficient to validate the domain before native Android
- **Confidence:** High
- **Impact:** Technical, reversible. Native Android is deferred, not cancelled.
- **How it will be tested:** Phase 3
- **Owner:** NOT YET ASSIGNED
- **Status:** ACCEPTED — Decision Log D5

### A15 — Thermal printing can be abstracted behind one port across device types
- **Confidence:** Medium
- **Impact:** Technical. Determines how much of the POS layer is device-specific.
- **How it will be tested:** Hardware selection, then Phase 3
- **Owner:** NOT YET ASSIGNED
- **Status:** OPEN

## Commercial

Commercial assumptions — revenue policy, pricing, hardware financing and the
merchant agreement — are maintained outside this repository and remain
**NOT YET CONFIRMED**. They are business decisions, not build inputs: nothing in
the source, tests, build, CI or runtime depends on any of them, and
`packages/domain/src/commission.ts` throws `CommissionRateNotConfiguredError`
rather than return a plausible default.

| # | Assumption | Status |
|---|---|---|
| A16-A18 | Commercial assumptions, recorded outside this repository | **OPEN** — owner NOT YET ASSIGNED |

## Documentation

### A19 — Reconstructed note names match founder intent where the source PDF was clipped
- **Confidence:** High
- **Impact:** Documentation. Eight folder lines in `CLAUDE.pdf` were cut mid-word.
- **How it will be tested:** Founder confirmation — given 2026-08-19
- **Owner:** Founder
- **Status:** CONFIRMED — see `05 Operations/Source Specification Clipped In PDF.md`

### A20 — Draft Amharic strings are usable after native review
- **Confidence:** Medium
- **Impact:** Product and financial. A mistranslated "do not retry yet" causes duplicate sales and real loss.
- **How it will be tested:** Named native Amharic reviewer, priority on the pending strings
- **Owner:** NOT YET ASSIGNED
- **Status:** OPEN — **blocks any production build containing Amharic**

### A21 — "Kazan" in the founder brief means Kazang
- **Confidence:** High
- **Impact:** Reputational. Affects any external document naming the reference model.
- **How it will be tested:** Founder confirmation
- **Owner:** Founder
- **Status:** OPEN

---

## Assumptions introduced by the domain implementation

Recorded here because they were taken during implementation on 2026-08-20 and are all reversible.
Each is also a row in `07 Governance/Decision Log.md`.

| ID | Assumption | Confidence | Impact | How tested | Status |
|---|---|---|---|---|---|
| A22 | A `BANK_CLEARING` contra account is acceptable alongside the five segregated buckets | High | Technical. Without a contra account a funding credit cannot balance. Holds no merchant value. | `tests/domain/ledger.test.ts` — "bank clearing holds no merchant value" | ACCEPTED — D8 |
| A23 | `PENDING → REVERSAL_REQUIRED` is legal without passing through `UNDER_REVIEW` | Medium | Technical. A provider callback can confirm value taken and not delivered with no human step. | `tests/domain/states.test.ts` | ACCEPTED — D9 |
| A24 | `RESERVED → PROCESSING` is legal without passing through `SUBMITTED` | High | Technical. Adapters that do not acknowledge separately need the direct edge. | `tests/domain/states.test.ts` | ACCEPTED — D10 |
| A25 | The idempotency key derives from request identity, not payload contents | High | Technical and financial. If the key hashed the payload, a payload mismatch could never be detected — a tampered request would look like a new sale. | `tests/domain/idempotency.test.ts` | ACCEPTED — D11 |
| A26 | The three balance buckets are real ledger accounts, not derived figures | High | Technical. Makes every bucket movement an auditable posting; the four views become simple sums. | `tests/persistence/reservation-balance.test.ts` | ACCEPTED — D12 |
| A27 | `synchronous = FULL` is the right durability trade for a merchant ledger | Medium | Technical. Slower writes; no loss of recent commits on power failure. Revisit if write throughput becomes a pilot constraint. | `synchronous is FULL — this is a ledger, not a cache` | ACCEPTED — D13 |
| A28 | Forward-fix-only migrations are acceptable in production | Medium | Operational. A bad schema change needs a new migration or a restore, and **restore is not yet tested** (launch gate 10). | Restore test, once written | ACCEPTED — D14 |
| A29 | A mask plus a salted hash is sufficient recipient data for support | Medium | Operational and legal. If support cannot resolve cases without the full number, this must be revisited with legal advice on retention (L14, L15). | Pilot support cases | OPEN — D15 |
| A30 | Single-writer migration at startup is sufficient | Low | Technical. Two processes migrating the same file concurrently is **untested**. | Not yet tested | OPEN |
| A31 | A transaction stuck at `PROCESSING` will be recovered by an operator | — | Operational and financial. | Superseded by the recovery sweep | **RESOLVED 2026-08-20** — `recoverInFlight` recovers `PROCESSING`, `RESERVED` and `PENDING` automatically. 61 tests. |
| A34 | The recovery thresholds chosen for the pilot are right | **Low** | Operational. Too short escalates healthy transactions into the review queue; too long strands merchant money. All six settings are NOT YET CONFIRMED. | Phase 3 trial | OPEN — see `Recovery Configuration` |
| A35 | A time-bounded claim lease is long enough for a recovery but short enough to reclaim | Medium | Technical. Too short lets two workers overlap; too long strands a transaction behind a dead worker. | `an expired lease can be reclaimed by another worker` | ACCEPTED — D23 |
| A36 | Classifying a lookup failure by error name and code is reliable enough | Medium | Technical. Reads `name` and `code` only, never the message, so a provider body cannot leak into a decision. An unrecognised failure falls back to `UNKNOWN`, which holds funds. | `classifies %s / %s as %s` | ACCEPTED |
| A37 | Multi-process worker safety | — | Operational. Two workers must never recover the same transaction. | 16 child-process tests spawning the compiled worker | **RESOLVED 2026-08-20** — real operating-system processes, real claim contention |
| A42 | CommonJS output is an acceptable runtime target | High | Technical, reversible. Chosen over rewriting ~60 imports; ESM remains available later by adding `.js` extensions. | `runs without TypeScript stripping — no loader flags are passed` | ACCEPTED — D30 |
| A43 | Building on the deployment target is acceptable | Medium | Operational. CI is now **authored** (`.github/workflows/ci.yml`) but has **never executed**: the repository has no git remote and zero commits. | CI on a real runner | **OPEN — CI authored, not run** |
| A44 | The test suite is deterministic under load | **Low** | Technical. Three intermittent failures observed on 2026-08-20 under full-suite load. Two were reproduced, diagnosed as test defects and fixed (A45, A47); the original — `marks manual review open on the pending row` — was **never reproduced** across a 200-iteration soak, 5 shuffled repeats and repeated isolated and full runs. | `npm run test:recovery:stress`; diagnostics now attached to the assertion | **OPEN** — not reproduced, deliberately not closed |
| A45 | The child-process race assertion described the real invariant | — | Technical. It asserted `claimed === 1`. A second process may legitimately claim after the winner releases, then find the transaction terminal on re-read. The safety property is one *resolution*, not one *claim*. | `exactly one claims it; the other records a conflict` | **RESOLVED 2026-08-20** — test defect, not a product defect |
| A46 | Refusing to start on an unmigrated database is sufficient protection for A30 | Medium | Operational. It removes migrate-on-open, so only an explicit `--migrate` migrates. It does not make concurrent migration safe — see [[Multi-Process Migration Plan]]. | `refuses to start when migrations have not been applied` | ACCEPTED — D33 |
| A47 | Child-process tests are independent of the wall clock | — | Technical. Two real-time dependencies found: a 1.5-second lease raced against process startup, and seeded rows carrying a fixed fake timestamp while children read the real clock. Both fixed without adding delay; the second also removes a CI portability hazard. | `a worker that dies holding a lease blocks others only until the lease expires` | **RESOLVED 2026-08-20** — test defect, not a product defect |
| A48 | A component-level UI test is sufficient assurance for the training POS | Medium | Technical. The screens are pure functions returning an element tree; tests assert the tree, not a rendered page. This does not exercise CSS, real focus behaviour, or a screen reader. `mount()` builds real DOM from the same tree, so a browser test can be added without rewriting the screens. | `tests/ui/screens.test.ts` | **OPEN** — accepted for training, revisit before a merchant uses it |
| A49 | The POS may take the merchant id from the URL because it is training-only | **High** | Security. **Superseded.** The merchant now comes from a server-side session; a client-supplied merchant id is a consistency check and is refused on mismatch. Authentication, device binding, CSRF, lockout and rate limits are implemented and tested. | `tests/auth/` — 126 tests | **RESOLVED 2026-08-21** for controlled internal training. See R22, and A52/A53 for what remains |
| A52 | A browser-supplied device id plus a server-issued key is adequate device identity | Medium | Security. It raises impersonation from *know the id* to *hold the key*, and enrolment, revocation, expiry and merchant assignment are enforced on **every** request. It is **not hardware attestation**: a copied id and key on another machine are indistinguishable from the original. | `tests/auth/device-binding.test.ts`, including a test that demonstrates the limitation | **OPEN — training-grade by design.** See [[Device Binding]] |
| A53 | A self-signed certificate is adequate transport security for controlled training | Medium | Security. **Reduced, not closed.** `TRAINING_HTTPS` now serves real TLS, so a passive listener no longer reads a session token off the wire, and cookies are `Secure`. A self-signed certificate is **not production trust**: it does nothing against an active attacker substituting their own, because nothing distinguishes theirs from ours. Plain HTTP remains available but is refused on any non-loopback binding. | `tests/transport/` — 74 tests including a real TLS listener; `npm run training:smoke` | **OPEN — reduced.** Needs a CA-signed certificate or a documented proxy for anything beyond the controlled machine. See [[Training HTTPS Deployment]] |
| A54 | The child-process tests are reliable under full-suite load | — | Technical. **Root cause found: a product defect.** `SqliteLedgerDriver.transaction()` used a **deferred** transaction, which begins as a reader and upgrades on first write; in WAL mode a concurrent writer makes that upgrade fail with `SQLITE_BUSY_SNAPSHOT`, which `busy_timeout` does **not** wait out. Two worker processes racing one transaction is exactly that condition. Fixed with `BEGIN IMMEDIATE`. No retry wrapper added. | `npm run test:child-process:stress` — reproduced on iteration 1 before the fix, **200 iterations clean** after | **RESOLVED 2026-08-21.** Closes neither A44 nor A51 |
| A55 | Test and build commands may run concurrently | — | Technical. They may not, on this constrained two-core environment. A full suite run that overlapped `npm run build:clean` failed 4 tests whose output was truncated; isolated runs of the same suite passed. | Observed 2026-08-21 | **RESOLVED as a working rule 2026-08-21** — never run `npm test` and a build at the same time here |
| A56 | A Vercel deployment of this repository is a running Telga | **High** | **Deployment-blocking.** It is not. Telga is stateful and long-running — a local SQLite ledger in WAL mode, a supervised recovery worker, server-side sessions, single-writer migrations — and Vercel is stateless and ephemeral. Two concurrent invocations would hold **different** ledger files, which defeats the claim lease that A37/R16 rest on. The trusted-proxy model also cannot be configured, because Vercel's proxy addresses are not enumerable and there is deliberately no trust-all option (D45). The repository contains no `api/`, no `public/`, no framework config and no `vercel.json`, so a deployment is a build artifact at most. A GitHub push must not be treated as a production deployment; if a Vercel project is connected, its automatic production deployments should be paused until a compatible target exists. | Inspection of the repository and the runtime shape; see [[Vercel Deployment Limits]] | **OPEN — deployment-blocking. A Vercel URL is training/preview only, never merchant or production** |
| A50 | Training denominations are not mistaken for prices | Low | Commercial. `TRAINING_CATALOG` uses 10/25/50/100 birr with every label suffixed "(simulated)". Real denominations and commission are NOT YET CONFIRMED. | `tests/ui/cli.test.ts` | ACCEPTED — labels asserted |
| A51 | The full suite passes on a small machine without being starved of CPU | Low | Technical. Two distinct effects, now separated. **(a) Build contention** — resolved as a rule: `test:child-process:stress` refuses to run against stale output and never builds (A55/D50). **(b) Reporter starvation** — a long-running task can outlast vitest's `onTaskUpdate` RPC on two cores, failing a run in which every assertion passed. Mitigated with a low-resource reporter, and the stress command now **classifies** the two: exit 1 a test failed, exit 3 the harness did. | `npm run test:child-process:stress` — **3 consecutive clean runs**, 600 iterations plus 9 real-file runs, after 1 reporter-timeout run before the reporter change | **OPEN — mitigated, not eliminated.** The reporter limit is a property of this machine; it can recur under load and is now unmistakable when it does |
| A38 | Fixed-delay scheduling is the right trade against a fixed rate | High | Technical. Fixed rate degenerates into continuous execution when a sweep outlasts its interval. | `a slow sweep does not cause a runaway loop` | ACCEPTED — D25 |
| A39 | Database and schema failures should stop the worker rather than back it off | Medium | Operational. Stopping surfaces the fault; retrying hides it behind a growing delay. The cost is that recovery halts until someone looks. | `stops the worker on a database failure rather than retrying into it` | ACCEPTED — D26 |
| A40 | A worker's own claims are safe to release on shutdown | High | Technical. Scoped to `worker_id`, so another worker's live claim is never touched. | `a worker releases only its own claims on shutdown` | ACCEPTED — D29 |
| A41 | The health thresholds distinguish degraded from unhealthy usefully | Low | Operational. Untested against real operational load; the boundaries are a guess until a pilot produces data. | Phase 3 trial | OPEN |

> **How A37 was closed.** The build step it was waiting on now exists. `tests/build/` spawns the
> compiled worker as separate operating-system processes — asserting the child `pid` differs from
> the runner's — and races them for one claim. One winner, one recorded conflict, one settlement,
> residual zero.
| A32 | A 5-minute pending maximum is short enough that merchants tolerate held funds, and long enough that the provider usually answers first | Low | Operational. Too short floods the under-review queue; too long strands merchant money. Same underlying unknown as A7. | Phase 3 trial | OPEN |
| A33 | Provider-side callback de-duplication is not required, because Telga's own guards suffice | Medium | Technical. A repeat is refused at four independent points, so a duplicate callback is harmless. | `a repeated callback does not finalize twice` | ACCEPTED |

---

*Last updated 2026-08-21. Mirrored by a pilot assumptions register kept outside this repository.*
