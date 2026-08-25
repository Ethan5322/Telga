---
title: Decision Log
type: governance
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - governance
  - decision
related:
  - "[[00 Home]]"
  - "[[Launch Gates]]"
  - "[[Founders and Roles]]"
  - "[[Decision]]"
depends_on: []
implements: []
validates: []
decision_status: confirmed
---

# Decision Log

Every material decision, with its status. Use the [[Decision]] template for anything needing a
full record. `decision_status` values: `proposed` · `accepted` · `superseded` · `rejected` ·
`pending`.

## Accepted

| # | Date | Decision | Rationale | Recorded by |
|---|---|---|---|---|
| D1 | 2026-08-19 | `CLAUDE.md` at the repository root is the authoritative specification; `CLAUDE.pdf` is a rendering of it | The PDF is clipped at the right margin — see [[Source Specification Clipped In PDF]] | Claude Code |
| D2 | 2026-08-19 | Vault content lives in `docs/obsidian/`; the vault boundary stays the repository root | Notes and source share one Graphify graph; the repo root is already a registered Obsidian vault | Claude Code |
| D3 | 2026-08-19 | Full, unabbreviated note names throughout the vault | Founder instruction; abbreviated names break wiki links and graph nodes | Founder |
| D4 | 2026-08-19 | SQLite (WAL, STRICT) for the Phase 2 ledger, behind a driver interface; Postgres at Phase 3 | No Docker or Postgres on the build machine; SQLite gives real transactions and constraints now, and the interface makes the move a driver swap | Founder |
| D5 | 2026-08-19 | Responsive web POS / PWA as the first client surface; native Android deferred to Phase 3 | No JDK, Kotlin or Gradle on the build machine; the prototype's purpose is proving domain logic | Founder |
| D6 | 2026-08-19 | Money stored as integer santim (ETB minor units) | [[Ledger Invariants]] rule 9 — no binary floating point | Claude Code |
| D7 | 2026-08-19 | Default automatic pending maximum of 5 minutes | `CLAUDE.md` default, pending provider-specific rules from the provider agreement terms (commercial material, kept outside this repository) | Founder |
| D8 | 2026-08-20 | Add a `BANK_CLEARING` contra account alongside the five segregated buckets | Double entry requires a counter-side for a funding credit; without it a deposit cannot be posted without breaking invariant 2. It holds no merchant value and appears in no merchant-facing balance. | Claude Code |
| D9 | 2026-08-20 | `PENDING → REVERSAL_REQUIRED` is legal without passing through `UNDER_REVIEW` | A provider callback can state that value was taken and delivery did not happen; that needs no human determination first. Required by the founder's test list. | Founder |
| D10 | 2026-08-20 | `RESERVED → PROCESSING` is legal without passing through `SUBMITTED` | Adapters that do not acknowledge a submission separately need the direct edge. Required by the founder's test list. | Founder |
| D11 | 2026-08-20 | The idempotency key derives from **request identity** (merchant, device, client request id), not from payload contents | Found while writing the payload-mismatch test: if the key hashed the amount and recipient, changing them would change the key, so a mismatch could never be detected — a tampered request would look like a brand new sale. The payload is covered by a separate fingerprint. | Claude Code |
| D12 | 2026-08-20 | The three balance buckets are **real ledger accounts** (`MERCHANT_AVAILABLE`, `MERCHANT_RESERVED`, `MERCHANT_UNDER_REVIEW`), not figures derived from reservation rows | The founder's persistence brief describes moving value between buckets "through new ledger postings". Making each bucket an account means every movement is an auditable balanced posting rather than an inferred number, and the four views become simple sums. The in-memory `MERCHANT_FUNDS` form is retained and both sum to the same merchant total. | Claude Code |
| D13 | 2026-08-20 | `better-sqlite3` v13, WAL, STRICT, `synchronous = FULL` | Verified to load natively on Node 25 with prebuilt binaries — no compiler needed. `FULL` rather than the usual `NORMAL`: `NORMAL` can lose recent commits on power loss, and a lost commit here is a merchant's money unaccounted for. | Claude Code |
| D14 | 2026-08-20 | **Production rollback is forward-fix only.** No `down` migrations | A ledger cannot be un-migrated without risking history. The only rollback is the per-migration transaction at apply time. A schema mistake is corrected by a new forward migration; a data mistake by an `ADJUSTMENT` entry. | Claude Code |
| D15 | 2026-08-20 | Recipient numbers are stored **masked and salted-hashed**, never in full | Support needs to identify a transaction, not to hold every subscriber number in a database for years. An unsalted digest of a phone number is a rainbow-table lookup, so the hash is salted with a deployment secret. | Claude Code |
| D16 | 2026-08-20 | The provider call sits **between two units of work**, not inside one | A SQLite transaction is synchronous; holding one open across a network call would block every other writer for as long as the provider takes to answer, and the provider is the component that may not answer at all. That gap is why `PENDING` exists. | Claude Code |
| D17 | 2026-08-20 | A thrown provider call becomes `PENDING`, not `FAILED` | We do not know whether it delivered. Treating an exception as failure would release value on a sale that may have completed. | Claude Code |
| D18 | 2026-08-20 | Escalation to `UNDER_REVIEW` is **time-based**, driven by a `pending_resolutions` row carrying a deadline | Without a scheduled job, a silent provider leaves merchant value held with nothing chasing it. The row also carries an attempt count, an early signal of provider degradation. | Claude Code |
| D19 | 2026-08-20 | A failure in the outcome unit of work **propagates**; it is not converted into a result | The instruction was explicit: do not catch errors and return success. The cost is a transaction that can stick at `PROCESSING`, recorded as open risk A31. | Founder |

| D20 | 2026-08-20 | The recovery sweep also sweeps `PENDING`, not only `PROCESSING` and `RESERVED` | `resolvePending` acts only when something calls it. An unattended system has nothing calling it, so without `PENDING` in the sweep a transaction the sweep itself moved to pending would hold merchant money forever and the escalation deadline would never be enforced. | Claude Code |
| D21 | 2026-08-20 | `RESERVED` with no provider reference is **proof** the provider was never called | `createSale` transitions to `PROCESSING` before it submits. This is the only case where recovery releases funds without a provider answer, and it rests on evidence rather than assumption. A `RESERVED` row carrying a provider reference is treated as uncertain. | Claude Code |
| D22 | 2026-08-20 | The pending clock starts when the transaction entered the in-flight state, not when the sweep noticed it | A transaction stuck for an hour must not receive a fresh grace period because a worker only just reached it. The merchant's money has already been held for that hour. | Claude Code |
| D23 | 2026-08-20 | Recovery claims use a time-bounded lease, not a permanent lock | A worker that dies must not hold a merchant's money hostage. An expired lease is reclaimable; a permanent lock would need manual intervention exactly when nobody is watching. | Claude Code |
| D24 | 2026-08-20 | A refund, reversal or exceptional balance action requires supervisor approval, enforced in code | `completeReversal` refuses any role outside `OPS_APPROVER` and `ADMIN` and records the approver on the support case. A rule about moving money that lives only in a runbook is not a control. | Claude Code |

| D25 | 2026-08-20 | Sweeps are scheduled **fixed-delay**, from the end of the previous sweep, not fixed-rate | Fixed-rate scheduling degenerates into continuous execution the moment a sweep takes longer than its interval — the scheduler spends the rest of its life catching up on a backlog it can never clear. Fixed delay cannot run away. | Claude Code |
| D26 | 2026-08-20 | Database and schema failures are **fatal** to the worker; provider failures back off | Retrying into a broken connection or a wrong schema helps nobody and hides the fault. A provider being unreachable is a normal transient condition and is exactly what backoff is for. | Claude Code |
| D27 | 2026-08-20 | The production worker policy contains **no numbers at all**, and production never falls back to development values | Every value depends on provider timeout semantics and connectivity data that do not exist. A deployment missing a setting fails at startup rather than running a developer's numbers against merchant money. | Claude Code |
| D28 | 2026-08-20 | Real system time is read in exactly one place — `systemWorkerClock` at the worker boundary | Everything below takes time as an argument, which is what makes the recovery and domain layers testable. A test asserts the recovery service contains no `Date.now(`. | Claude Code |
| D29 | 2026-08-20 | A shutting-down worker releases **only its own claims**; everything else is left to expire | Touching another worker's claim would let two workers act on one transaction. An abandoned lease expires on its own, so nothing is stranded and no claim row is ever deleted. | Claude Code |

| D30 | 2026-08-20 | The build emits **CommonJS**, with `{"type":"commonjs"}` stamped into each `dist/` | The sources use extensionless relative imports, which Node's ESM resolver rejects. CommonJS resolves them natively, so no source changes were needed. The alternative — appending `.js` to ~60 imports across five packages — buys nothing else. `verbatimModuleSyntax` is disabled for the build only. | Claude Code |
| D31 | 2026-08-20 | Each package builds to **its own** `dist/`, and `main` points there | Cross-package `require('@telga/domain')` then resolves to built JavaScript at runtime, while Vitest aliases and tsconfig `paths` keep development on the sources. One mechanism, no duplication. | Claude Code |
| D32 | 2026-08-20 | The worker CLI has a `--once` mode that sweeps once, releases its claims and exits | An operator needs a way to run a single sweep by hand, and a test needs process separation without a supervised loop running forever. The same mode serves both. | Claude Code |

| D33 | 2026-08-20 | The worker **does not migrate**. It refuses to start against an unmigrated database (exit 6); migrations are applied once by a single writer with `--migrate` | `createSqliteDriver` migrated on open, which made every worker process a migrator — the untested concurrent case recorded as A30. One flag removes the risk without building a lock nothing needs yet. | Claude Code |
| D34 | 2026-08-20 | An intermittent test is investigated, never retried, delayed, skipped or loosened | A flake in recovery code is a claim about money that sometimes fails. It is either a real defect or a test asserting the wrong thing; both deserve finding. | Founder |
| D35 | 2026-08-20 | Graphify is **not** a CI step; `docs:validate` is the deterministic documentation gate | Graphify is a locally-installed tool, not a declared dependency. A CI step for it would install something unpinned or quietly no-op — worse than a documented local step. | Claude Code |

| D36 | 2026-08-20 | The POS screens are **pure functions returning an element tree**, with no UI framework, no bundler and no DOM emulator | What the UI tests must assert — the banner is present, an uncertain state renders no success affordance, the retry instruction exists as text, controls have accessible names — are properties of the tree, not of a layout engine. Same reasoning as D30. The limitation is stated: component-level, not browser-level. | Claude Code |
| D37 | 2026-08-20 | An unknown outcome is an **HTTP success**: `POST /sales` returns 201 with `kind: "PENDING"` | Making it a 4xx would teach a client to treat an unknown outcome as an error, which is the exact mistake the pending path exists to prevent. | Claude Code |
| D38 | 2026-08-20 | The POS exposes **no reversal endpoint** | `completeReversal` requires a supervisor approval. Exposing it without an authenticated supervisor session would be a way *around* that approval, not an implementation of it. | Claude Code |
| D39 | 2026-08-20 | Fourteen Amharic strings stay **missing** rather than machine-translated; `translate()` reports the English fallback | An unreviewed guess that looks finished is worse than a visible gap, and a native reviewer needs to see what is actually outstanding. | Founder |

| D40 | 2026-08-20 | The child-process tests build **only when `dist` is stale**, and `testTimeout` is stated explicitly at 30s | Compiling eight packages inside the test run saturated a two-core machine and tripped two of Vitest's five-second budgets — the reporter RPC and an unrelated test. The guarantee needed is that the tests run *current* output, not that a build happens every time. The timeout is a resource budget; no assertion was loosened, no retry added, nothing skipped. | Claude Code |

| D36 | 2026-08-21 | **Identity comes from a server-side session, never from a request.** A client-supplied merchant id is a consistency check and is refused on mismatch | A URL parameter is not an identity boundary. Anything a client can edit cannot decide what a client may read. | Founder |
| D37 | 2026-08-21 | **scrypt from `node:crypto`**, not argon2, for PINs and device keys | argon2 needs a native dependency and a build step to defend a six-digit PIN that is already defended by lockout and device binding. `N=16384` is real work with no supply-chain question. Production parameters NOT_YET_CONFIRMED. | Claude Code |
| D38 | 2026-08-21 | **The device is re-checked on every request**, not only at sign-in | The window that matters is between a POS being stolen and its session expiring. Checking at sign-in only would leave a revoked device working for up to 12 hours. | Claude Code |
| D39 | 2026-08-21 | **CSRF tokens in addition to `SameSite=Strict`** | `SameSite` is a browser behaviour, not a server guarantee; an old browser, a proxy or a same-site subdomain weakens it. A server-issued token does not depend on the client behaving. | Claude Code |
| D40 | 2026-08-21 | **A merchant role never holds `REVERSAL_APPROVE`, `FUNDS_RELEASE`, `TRANSACTION_FORCE_STATE`, `RECOVERY_CONFIGURE`, `PROVIDER_OVERRIDE_OUTCOME`, `ADMIN_DIAGNOSTICS` or `DEVICE_REVOKE`** — enforced by a second list consulted independently of the grant table | Every one is a money control. Two locks that must both fail is a materially different guarantee from one lookup. A stolen device is exactly the case where the holder must not be able to revoke it. | Founder |
| D41 | 2026-08-21 | **No response body carries a token or a secret**, with one deliberate exception: the device key at enrolment, which bypasses the display gate rather than weakening it | The redaction gate refused the first sign-in handler because it returned the CSRF token in the body. Loosening the gate for one response would have loosened it for all of them; the token travels in its own cookie instead. | Claude Code |
| D42 | 2026-08-21 | **A device refusal outranks a session refusal**, and is audited once per session | Revoking a device revokes its sessions, so the next request would report `SESSION_REVOKED` — a 401 sending the operator to a sign-in they cannot pass. Reporting the device reason keeps them out of a loop. Auditing once stops a stolen POS flooding the trail. | Claude Code |
| D43 | 2026-08-21 | **Training thresholds are named as training thresholds**: 6-digit PIN, 5 failures, 5-minute lockout, 15-minute idle, 12-hour lifetime, 30 sales/minute, 16 KB body | Real numbers depend on how a counter behaves over a shift, which nobody has measured. Naming them as training values keeps a production claim from being made by default. | Founder |

| D44 | 2026-08-21 | **The CSP allows inline script and style by per-response nonce**, never `unsafe-inline` | `unsafe-inline` permits any injected inline script, which is most of what a CSP exists to stop. A fresh 128-bit nonce per response cannot be read by injected markup. | Claude Code |
| D45 | 2026-08-21 | **A forwarding header is believed only from a configured trusted address**, and there is no "trust all proxies" option | Believing one from any client lets a plain HTTP request set a `Secure` cookie the browser never returns — and makes an insecure deployment report itself secure. That single setting would turn the control into a decoration. | Founder |
| D46 | 2026-08-21 | **Plain HTTP is refused on any non-loopback binding**, rather than warned about | The whole safety argument for plain HTTP is that nobody else can reach it. A LAN binding removes the argument, so a warning would be a note attached to an unsafe deployment. | Founder |
| D47 | 2026-08-21 | **Telga never generates or writes TLS key material.** `TRAINING_HTTPS` requires explicit paths | A tool that quietly creates a key creates one somewhere, and somewhere becomes a repository, a backup or an image. | Claude Code |
| D48 | 2026-08-21 | **Certificate and key are checked as a pair at startup** | A mismatched pair otherwise fails per-connection during the handshake, as an error a browser renders as an unexplained failure. One clear refusal beats that. | Claude Code |
| D49 | 2026-08-21 | **A simulated opening balance is a named flag** (`--training-float`), off by default | Creating a balance is a money operation even when the money is simulated. It should never be a side effect of setting up an operator. | Founder |
| D50 | 2026-08-21 | **Test and build commands are never run concurrently** on this two-core machine | An overlapping run produced four failures whose output was truncated; isolated runs of the same suite passed. Recorded as A55. | Founder |

| D51 | 2026-08-21 | **Every database unit of work begins `IMMEDIATE`**, not deferred | A deferred transaction upgrades from reader to writer on its first write, and in WAL mode that upgrade fails with `SQLITE_BUSY_SNAPSHOT` when another connection has written — an error `busy_timeout` does not wait out and which cannot be safely retried, because the transaction's reads may be stale. Taking the write lock up front converts it into an ordinary wait. | Founder |
| D52 | 2026-08-21 | **No retry wrapper around a failed unit of work.** The fix removes the error rather than surviving it | A retry around an ambiguous commit is exactly what the ledger rules forbid. `BEGIN IMMEDIATE` makes the contention waitable, so there is nothing left to retry. | Founder |
| D53 | 2026-08-21 | **Worker health reads the sweep outcome, not only the ledger residual** | A zero residual says the books are consistent; it says nothing about whether recovery worked. A sweep that claimed work and resolved none of it reported `HEALTHY`, which was the wrong answer twice over. | Founder |
| D54 | 2026-08-21 | **A stress harness preserves the failing database**, and the worker reports `skipped`, `recoveryFailures`, `stoppedEarly` and `failureReasonCodes` | The evidence already existed in the audit trail; the test deleted it, and the CLI did not surface it. Diagnosing A54 was impossible until both were fixed. | Claude Code |
| D55 | 2026-08-24 | **`.gitignore`'s generated-output patterns must be exact, not generic prefixes** — removed the bare `build/` pattern, keeping `dist/` | A pattern meant for compiler output silently matched `tests/build/`, a real source directory, so it was never committed. CI found "No test files found" on a fresh checkout while every local run passed, because Vitest reads the filesystem directly, not git state. Recorded as A57. | Claude Code |
| D56 | 2026-08-24 | **Added `scripts/check-ci-test-paths.mjs`** as the first CI step, failing fast if any workflow-referenced `tests/...` path has zero files tracked by git | A57 was invisible to every existing check because `check-committed.mjs` and `validate-vault.mjs` both reason from `git ls-files`, which is exactly what a shadowed directory is absent from. This is the same shape of gap those checks fill for secrets and boundary crossings, applied to CI test discovery. | Claude Code |
| D57 | 2026-08-24 | **Each stress script scopes its own vitest invocation to one named file**, never a shared directory glob | `stress-recovery.mjs`'s soak pass ran the whole `tests/stress/` glob unscoped, silently also executing the unrelated A54 scenario (which needs a build the `recovery stress` CI job never runs) and reporting its failure as `soak-200`. `stress-child-process.mjs` already scoped its own two invocations this way; the same discipline now applies to both scripts. Recorded as A58 — kept a distinct ID from A44, which tracks a different, unreproduced failure shape. | Claude Code |
| D58 | 2026-08-24 | **Upgraded `actions/checkout` and `actions/setup-node` from `v4` to `v5`**, in their own maintenance commit, separate from any functional CI fix | Both `v4` pins declare `node20` in their actual `action.yml`; GitHub now forces that onto Node 24 at runtime and warns on every job. Verified `v5` declares `node24` directly from each action's metadata file rather than a summarized changelog. No inputs, triggers, timeouts, reporters, or the Node matrix changed. Recorded as A59, resolved on remote run `32730213755` — Success, Annotations panel confirmed empty by direct owner inspection. | Claude Code |
| D60 | 2026-08-24 | **`GET /api/health/ready` reuses `recoveryGauges`/`evaluateAlerts`** rather than a second definition of recovery health | Those functions already existed and are what the worker's own observability computes from. A second, independent "is the queue fine" check would risk silently disagreeing with the one the worker already trusts. | Claude Code |
| D61 | 2026-08-24 | **Every session is revoked and every recovery claim is released, unconditionally, on restore** — not only ones already known-expired or known-revoked | A session or claim from a backup predates the restore point by definition; the restored copy's own timeline has no worker or operator legitimately holding either. Unconditional release is simpler than a conditional policy and cannot be half-applied. Operators sign in again; the next real sweep re-claims cleanly. Recorded in [[Backup and Restore Runbook]] and the backup/restore implementation note (implemented separately). | Claude Code |
| D62 | 2026-08-24 | **`@telga/backup` restores checksum-first, before any file copy to the target** | A corrupt backup must never produce even a partial target file. Checking the checksum against the backup file itself, before `copyFileSync` runs, makes a corrupt-backup refusal leave nothing behind to clean up. | Claude Code |
| D63 | 2026-08-24 | **Backup and restore refuse every path by default** — `TELGA_BACKUP_ALLOWED_ROOTS` has no default value | An unset allow-list must mean "nothing is permitted," not "anywhere is fine." Matches the same fail-closed posture as the trusted-proxy design (D45) — no "trust everything" option exists for either. | Claude Code |
| D64 | 2026-08-24 | **Backup and restore never migrate the database they open** — both use `new SqliteLedgerDriver()` directly, never `createSqliteDriver` | Migration is a single-writer startup procedure belonging to the worker or the POS ([[Migration Ownership]]). A backup or restore tool that silently migrated would be an unreviewed second writer — exactly the untested concurrent-migration shape recorded as A30. | Claude Code |

## Proposed

Not yet accepted. Recorded so the reasoning is visible before a founder decision, not after.

| # | Date | Decision | Rationale | Recorded by |
|---|---|---|---|---|
| D59 | 2026-08-24 | **Recommend a small VPS or a local/office machine** (category 1 or 4 of five evaluated) as the training deployment target — no vendor named, no account created, nothing purchased | Both categories fit [[Training Deployment Architecture]]'s persistent-host requirement directly, at low or no incremental cost, without the "ephemeral unless configured correctly" risk found in managed-container and PaaS categories. Category 5 (managed database + separate host) is the more credible eventual production path but is a distinct engineering project, not justified before a provider agreement and real load exist. Full comparison: [[Deployment Target Evaluation]]. Recorded as A60. | Claude Code |

## Pending — required from MuleSoo

| # | Decision | Blocks | Tracked in |
|---|---|---|---|
| P1 | **Confirm legal entity ownership, founder equity, signing authority, finance approvals, and operational accountability** | Provider signature, funding approval, both `money.live` keys, gates 8 and 9 | [[Founders and Roles]] |
| P2 | First airtime provider | Gates 2 and 5; adapter specifics | the provider assessment (commercial material, kept outside this repository) |
| P3 | Commission rates | Merchant economics, `CommissionRule` values | the provider agreement terms (commercial material, kept outside this repository) |
| P4 | Prices — platform fee, transaction fee, hardware | Merchant agreement, gate 4 | the pilot budget (commercial material, kept outside this repository) |
| P5 | Pilot budget | Gate 9 | the pilot budget (commercial material, kept outside this repository) |
| P6 | Banking and merchant-funds structure | Gates 3 and 6 | [[Legal Questions]] |
| P7 | Legal and payment authorization | Gates 1 and 4 | [[Legal Questions]] |
| P8 | Named Amharic reviewer and sign-off | Any production build with Amharic strings | [[Amharic Strings]] |
| P9 | Pilot area selection | the commercial pilot plan (commercial material, kept outside this repository) | strategic material maintained outside the source repository |
| P10 | Hardware and thermal-paper specification | Merchant onboarding terms | [[Merchant Onboarding]] |
| P11 | Merchant offboarding terms | Contract completeness | [[Merchant Onboarding]] |
| P12 | Brand colour values | [[Design System]] tokens are assumptions until then | [[Design System]] |
| P13 | Confirm "Kazan" refers to Kazang | Any external document naming it | strategic material maintained outside the source repository |

## Superseded

*None.*

## Rejected

*None.*

## How to add a decision

1. Copy [[Decision]] into the relevant folder, or add a row here for a small one.
2. State the decision, the alternatives considered, and the rationale.
3. Set `decision_status` in the affected notes' frontmatter.
4. Link the decision from the notes it changes.

## Related

- [[Launch Gates]]
- [[Founders and Roles]]
- [[Decision]]

---
Back to [[00 Home]]
