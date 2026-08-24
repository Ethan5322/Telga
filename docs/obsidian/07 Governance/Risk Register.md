---
title: Risk Register
type: governance
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - governance
  - risk
  - register
related:
  - "[[00 Home]]"
  - "[[Launch Gates]]"
  - "[[Legal Questions]]"
depends_on: []
implements: []
validates: []
decision_status: pending
---

# Risk Register

**Register H.** Owner: compliance and risk role — **NOT YET ASSIGNED**.

Scoring: likelihood × impact, each 1–5. Anything scoring 15+ blocks the phase it affects.

## Open risks

| # | Risk | L | I | Score | Mitigation | Owner |
|---|---|---|---|---|---|---|
| R1 | **Duplicate vending** — a retry sells twice and debits twice | 4 | 5 | **20** | Idempotency key held across retries; no retry control in UI; duplicate-submission tests. [[Idempotency]] | NOT ASSIGNED |
| R2 | **Balance integrity loss** — value disappears between buckets | 3 | 5 | **15** | Derived balances, append-only ledger, sum-to-zero property test. [[Ledger Invariants]] | NOT ASSIGNED |
| R3 | **Provider cannot answer status queries** — pendings can never resolve | 3 | 5 | **15** | Hard gate in provider selection. the provider integration requirements (commercial material, kept outside this repository) | NOT ASSIGNED |
| R4 | **Live money enabled prematurely** | 2 | 5 | 10 | `money.live` off by default, dual approval, ten launch gates. [[Feature Flags]] | NOT ASSIGNED |
| R5 | **Regulatory breach** — operating without required authorization | 3 | 5 | **15** | No live activity before documented qualified review. [[Legal Questions]] | NOT ASSIGNED |
| R6 | **Merchant funds commingled** with Telga revenue or personal accounts | 2 | 5 | 10 | Segregated ledger accounts; no personal account rule. [[Funding Verification]] | NOT ASSIGNED |
| R7 | **Amharic mistranslation** causes a merchant to retry a pending sale | 3 | 4 | 12 | Native review before production; priority on do-not-retry strings. [[Amharic Strings]] | NOT ASSIGNED |
| R8 | **Provider outage mishandled** — merchant charged for a blocked request | 2 | 5 | 10 | No charge on blocked requests; no merchant override. [[Provider Health]] | NOT ASSIGNED |
| R9 | **Under-review backlog grows** beyond support capacity | 3 | 4 | 12 | Under-review age metric; escalation runbook. [[Observability]] | NOT ASSIGNED |
| R10 | **Single-provider dependency** — one provider outage stops all revenue | 4 | 3 | 12 | Adapter abstraction supports a second provider; no broad exclusivity. the provider agreement terms (commercial material, kept outside this repository) | NOT ASSIGNED |
| R11 | **Founder accountability undefined** — nobody can approve or sign | 5 | 4 | **20** | Confirm roles and signing authority. [[Founders and Roles]] | NOT ASSIGNED |
| R12 | **Commission economics do not work** once real rates are known | 3 | 4 | 12 | No pricing committed before provider data. the pilot budget (commercial material, kept outside this repository) | NOT ASSIGNED |
| R13 | **Printer failure treated as sale failure** by staff | 3 | 3 | 9 | Explicit rule and training; reprint always available. [[Receipt Specification]] | NOT ASSIGNED |
| R14 | **Merchant device lost or stolen** with an open balance | 2 | 4 | 8 | Device binding, remote stop of new sales, PIN. [[Security Model]] | NOT ASSIGNED |
| R15 | **Connectivity too poor** for the pending model to resolve quickly | 3 | 3 | 9 | Measure in the pilot baseline metrics (commercial material, kept outside this repository)  during Phase 0 | NOT ASSIGNED |

## Closed by implementation

| # | Risk | Resolution |
|---|---|---|
| R16 | Two worker processes recover the same transaction and double-resolve it | **CLOSED 2026-08-20.** Proved across real operating-system processes: child-process tests spawn the compiled worker and race it for one transaction. Exactly one *recovery* occurs, one settlement is posted, residual stays zero. Assumption A37 resolved. |

## Added by the worker and build work

| # | Risk | L | I | Score | Mitigation | Owner |
|---|---|---|---|---|---|---|
| R17 | **Concurrent migration** from two processes leaves a half-applied schema | 2 | 5 | 10 | Worker refuses to start unmigrated (exit 6); migrations applied by a single writer with `--migrate`. Untested beyond that — [[Multi-Process Migration Plan]] | NOT ASSIGNED |
| R18 | **An intermittent test masks a real defect** | 3 | 4 | 12 | Stress soak plus shuffled repeats; diagnostics attached to the assertion; no retries or skips permitted — [[Test Stability Runbook]] | NOT ASSIGNED |
| R19 | **The build has only ever run on one machine** | 3 | 3 | 9 | CI authored; **not yet executed** — [[CI Pipeline]] | NOT ASSIGNED |

## Added by the merchant POS

| # | Risk | L | I | Score | Mitigation | Owner |
|---|---|---|---|---|---|---|
| R20 | **A screen implies a sale succeeded when the provider has not said so** | 2 | 5 | 10 | Only `SUCCESSFUL` carries a confirmed certainty or a receipt; every uncertain state states in words that the result is not known; asserted exhaustively over all twelve states — [[State To UI Mapping]] | NOT ASSIGNED |
| R21 | **An operator retries an unresolved sale and charges the customer twice** | 3 | 5 | 15 | `doNotRetryYet` rendered as an alert above the status detail, repeated on every list row; the refusal is stated in a sentence; `clientRequestId` generated per form makes a double press idempotent; the POS has no control that resubmits an existing transaction — [[Merchant POS Screens]] | NOT ASSIGNED |
| R22 | **The POS has no authentication**, so a merchant id in a URL is all that scopes a screen | — | — | — | **CLOSED 2026-08-21.** Identity comes from a server-side session bound to an enrolled device. A client-supplied merchant id is refused on mismatch; cross-merchant reads and writes are refused, and a foreign transaction is indistinguishable from a nonexistent one. 126 tests in `tests/auth/`. Assumption A49 resolved | NOT ASSIGNED |
| R23 | **A response leaks a recipient hash or an internal digest** | 2 | 4 | 8 | `assertSafeForDisplay` on every successful body, plus the two checks already at write time; asserted on every rendered page as well as every API response | NOT ASSIGNED |

## Added by the authentication work

| # | Risk | L | I | Score | Mitigation | Owner |
|---|---|---|---|---|---|---|
| R23 | **A copied device key lets another machine act as an enrolled device** | 3 | 4 | 12 | Training-grade binding, stated and tested as such. Enrolment, revocation and expiry checked on every request; a stolen POS is stopped by revocation rather than by attestation — [[Device Binding]], A52 | NOT ASSIGNED |
| R24 | **A session token is read off the wire** | 2 | 4 | 8 | **Reduced 2026-08-21.** `TRAINING_HTTPS` serves real TLS with `Secure` cookies, a nonce CSP and the full security-header set; plain HTTP is refused on any non-loopback binding. Residual: the certificate is self-signed, so an **active** substitution attack is not addressed — A53 stays open | NOT ASSIGNED |
| R25 | **An operator is locked out mid-shift** and cannot sell | 3 | 2 | 6 | Five attempts, five-minute lockout, and an unlock procedure in [[Training Operations Runbook]] | NOT ASSIGNED |

## Added by the HTTPS work

| # | Risk | L | I | Score | Mitigation | Owner |
|---|---|---|---|---|---|---|
| R26 | **A spoofed `X-Forwarded-Proto` makes an insecure deployment report itself secure** | 2 | 4 | 8 | A forwarding header is believed only from a configured trusted address; there is no "trust all proxies" setting. 26 tests, including the spoofing case — [[TLS and Proxy Configuration]] | NOT ASSIGNED |
| R27 | **A private key is committed or printed** | 2 | 5 | 10 | Telga never generates or writes key material; `check-committed.mjs` refuses `.pem` and `.key`; error messages carry paths and never contents, with a test asserting it — [[Local Certificate Handling]] | NOT ASSIGNED |
| R28 | **An intermittent multi-process test failure hides a real recovery defect** | — | — | — | **CLOSED 2026-08-21 — and it *was* hiding one.** The cause was a deferred write transaction failing with `SQLITE_BUSY_SNAPSHOT` under concurrent writers; fixed with `BEGIN IMMEDIATE` (D51). 200 stress iterations clean. The investigation also fixed a health policy that reported `HEALTHY` while recovery was failing (D53) | NOT ASSIGNED |

## Added by the A54 investigation

| # | Risk | L | I | Score | Mitigation | Owner |
|---|---|---|---|---|---|---|
| R29 | **Write contention between worker processes grows with merchant volume** | 3 | 3 | 9 | `BEGIN IMMEDIATE` makes contention a bounded wait governed by `busy_timeout` rather than an immediate failure. A single SQLite file is still one writer at a time — [[SQLite Persistence Layer]]. Postgres remains the Phase 3 option | NOT ASSIGNED |

## Added by the first publication

| # | Risk | L | I | Score | Mitigation | Owner |
|---|---|---|---|---|---|---|
| R30 | **DEPLOYMENT-BLOCKING.** A Vercel deployment is mistaken for a working or production Telga | 3 | 5 | 15 | The architecture is stateful and does not fit serverless: ephemeral storage would fork the ledger and void the claim lease. Documented in [[Vercel Deployment Limits]]; recorded as A56. A GitHub push must not be treated as a production Vercel deployment; if a Vercel project is connected, its automatic production deployments should be paused until a compatible target exists. A Vercel URL is training/preview only, never production. **Watch the Output Directory setting** — with no framework and no `public/`, some configurations serve the repository root | NOT ASSIGNED |

## Highest risks today

R1, R11, then R2, R3 and R5 equally. **R11 is the one that blocks all the others** — the mitigations
for every other risk require a named owner, and there are none.

## Review cadence

The register is reviewed at each phase exit, and whenever an incident is logged in [[Runbooks]].
**No review has occurred; this is the initial draft.**

## Related

- [[Launch Gates]]
- [[Legal Questions]]
- [[Runbooks]]

---
Back to [[00 Home]]
