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

**Register H.** Owner: compliance and risk role ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â **NOT YET ASSIGNED**.

Scoring: likelihood ÃƒÆ’Ã¢â‚¬â€ impact, each 1ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“5. Anything scoring 15+ blocks the phase it affects.

## Open risks

| # | Risk | L | I | Score | Mitigation | Owner |
|---|---|---|---|---|---|---|
| R1 | **Duplicate vending** ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â a retry sells twice and debits twice | 4 | 5 | **20** | Idempotency key held across retries; no retry control in UI; duplicate-submission tests. [[Idempotency]] | NOT ASSIGNED |
| R2 | **Balance integrity loss** ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â value disappears between buckets | 3 | 5 | **15** | Derived balances, append-only ledger, sum-to-zero property test. [[Ledger Invariants]] | NOT ASSIGNED |
| R3 | **Provider cannot answer status queries** ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â pendings can never resolve | 3 | 5 | **15** | Hard gate in provider selection. the provider integration requirements (commercial material, kept outside this repository) | NOT ASSIGNED |
| R4 | **Live money enabled prematurely** | 2 | 5 | 10 | `money.live` off by default, dual approval, ten launch gates. [[Feature Flags]] | NOT ASSIGNED |
| R5 | **Regulatory breach** ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â operating without required authorization | 3 | 5 | **15** | No live activity before documented qualified review. [[Legal Questions]] | NOT ASSIGNED |
| R6 | **Merchant funds commingled** with Telga revenue or personal accounts | 2 | 5 | 10 | Segregated ledger accounts; no personal account rule. [[Funding Verification]] | NOT ASSIGNED |
| R7 | **Amharic mistranslation** causes a merchant to retry a pending sale | 3 | 4 | 12 | Native review before production; priority on do-not-retry strings. [[Amharic Strings]] | NOT ASSIGNED |
| R8 | **Provider outage mishandled** ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â merchant charged for a blocked request | 2 | 5 | 10 | No charge on blocked requests; no merchant override. [[Provider Health]] | NOT ASSIGNED |
| R9 | **Under-review backlog grows** beyond support capacity | 3 | 4 | 12 | Under-review age metric; escalation runbook. [[Observability]] | NOT ASSIGNED |
| R10 | **Single-provider dependency** ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â one provider outage stops all revenue | 4 | 3 | 12 | Adapter abstraction supports a second provider; no broad exclusivity. the provider agreement terms (commercial material, kept outside this repository) | NOT ASSIGNED |
| R11 | **Founder accountability undefined** ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â nobody can approve or sign | 5 | 4 | **20** | Confirm roles and signing authority. [[Founders and Roles]] | NOT ASSIGNED |
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
| R17 | **Concurrent migration** from two processes leaves a half-applied schema | 2 | 5 | 10 | Worker refuses to start unmigrated (exit 6); migrations applied by a single writer with `--migrate`. Untested beyond that ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â [[Multi-Process Migration Plan]] | NOT ASSIGNED |
| R18 | **An intermittent test masks a real defect** | 3 | 4 | 12 | Stress soak plus shuffled repeats; diagnostics attached to the assertion; no retries or skips permitted ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â [[Test Stability Runbook]] | NOT ASSIGNED |
| R19 | **The build has only ever run on one machine** | 3 | 3 | 9 | CI authored; **not yet executed** ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â [[CI Pipeline]] | NOT ASSIGNED |

## Added by the merchant POS

| # | Risk | L | I | Score | Mitigation | Owner |
|---|---|---|---|---|---|---|
| R20 | **A screen implies a sale succeeded when the provider has not said so** | 2 | 5 | 10 | Only `SUCCESSFUL` carries a confirmed certainty or a receipt; every uncertain state states in words that the result is not known; asserted exhaustively over all twelve states ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â [[State To UI Mapping]] | NOT ASSIGNED |
| R21 | **An operator retries an unresolved sale and charges the customer twice** | 3 | 5 | 15 | `doNotRetryYet` rendered as an alert above the status detail, repeated on every list row; the refusal is stated in a sentence; `clientRequestId` generated per form makes a double press idempotent; the POS has no control that resubmits an existing transaction ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â [[Merchant POS Screens]] | NOT ASSIGNED |
| R22 | **The POS has no authentication**, so a merchant id in a URL is all that scopes a screen | ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â | ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â | ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â | **CLOSED 2026-08-21.** Identity comes from a server-side session bound to an enrolled device. A client-supplied merchant id is refused on mismatch; cross-merchant reads and writes are refused, and a foreign transaction is indistinguishable from a nonexistent one. 126 tests in `tests/auth/`. Assumption A49 resolved | NOT ASSIGNED |
| R23 | **A response leaks a recipient hash or an internal digest** | 2 | 4 | 8 | `assertSafeForDisplay` on every successful body, plus the two checks already at write time; asserted on every rendered page as well as every API response | NOT ASSIGNED |

## Added by the authentication work

| # | Risk | L | I | Score | Mitigation | Owner |
|---|---|---|---|---|---|---|
| R33 | **A copied device key lets another machine act as an enrolled device** | 3 | 4 | 12 | Training-grade binding, stated and tested as such. Enrolment, revocation and expiry checked on every request; a stolen POS is stopped by revocation rather than by attestation ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â [[Device Binding]], A52, A69. **Renumbered from R23 on 2026-08-29**: two different risks carried that number, so a reference to "R23" was ambiguous. The recipient-hash leak keeps R23, being the older of the two | NOT ASSIGNED |
| R24 | **A session token is read off the wire** | 2 | 4 | 8 | **Reduced 2026-08-21.** `TRAINING_HTTPS` serves real TLS with `Secure` cookies, a nonce CSP and the full security-header set; plain HTTP is refused on any non-loopback binding. Residual: the certificate is self-signed, so an **active** substitution attack is not addressed ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â A53 stays open | NOT ASSIGNED |
| R25 | **An operator is locked out mid-shift** and cannot sell | 3 | 2 | 6 | Five attempts, five-minute lockout, and an unlock procedure in [[Training Operations Runbook]] | NOT ASSIGNED |

## Added by the HTTPS work

| # | Risk | L | I | Score | Mitigation | Owner |
|---|---|---|---|---|---|---|
| R26 | **A spoofed `X-Forwarded-Proto` makes an insecure deployment report itself secure** | 2 | 4 | 8 | A forwarding header is believed only from a configured trusted address; there is no "trust all proxies" setting. 26 tests, including the spoofing case ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â [[TLS and Proxy Configuration]] | NOT ASSIGNED |
| R27 | **A private key is committed or printed** | 2 | 5 | 10 | Telga never generates or writes key material; `check-committed.mjs` refuses `.pem` and `.key`; error messages carry paths and never contents, with a test asserting it ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â [[Local Certificate Handling]] | NOT ASSIGNED |
| R28 | **An intermittent multi-process test failure hides a real recovery defect** | ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â | ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â | ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â | **CLOSED 2026-08-21 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â and it *was* hiding one.** The cause was a deferred write transaction failing with `SQLITE_BUSY_SNAPSHOT` under concurrent writers; fixed with `BEGIN IMMEDIATE` (D51). 200 stress iterations clean. The investigation also fixed a health policy that reported `HEALTHY` while recovery was failing (D53) | NOT ASSIGNED |

## Added by the A54 investigation

| # | Risk | L | I | Score | Mitigation | Owner |
|---|---|---|---|---|---|---|
| R29 | **Write contention between worker processes grows with merchant volume** | 3 | 3 | 9 | `BEGIN IMMEDIATE` makes contention a bounded wait governed by `busy_timeout` rather than an immediate failure. A single SQLite file is still one writer at a time ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â [[SQLite Persistence Layer]]. Postgres remains the Phase 3 option | NOT ASSIGNED |

## Added by the Telga launcher and Telga Pay module

| # | Risk | L | I | Score | Mitigation | Owner |
|---|---|---|---|---|---|---|
| R32 | **A launcher tile is mistaken for a second real application, or the card simulator for a real card terminal** | 2 | 4 | 8 | Wording discipline enforced in code and docs ("module"/"tile"/"section", never "app"/"installed"); every Telga Pay screen carries an explicit training banner; card payments are built as two **ports** ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â `CardReader` and `PaymentProcessor` ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â whose only implementations in this repository are simulators (D87). No implementation performs network egress of any kind, so no code path can reach a real card network, processor, or bank; `payments.acceptance` is off and the build refuses to start with it on. The port exists so that connecting real hardware later is implementing an interface rather than rebuilding the product ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â it is **not** itself a connection. **Updated 2026-08-29**: the earlier wording claimed no code path existed, which read as "no card code exists" once the ports were written ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â see [[Telga Launcher and Dashboard]], [[Telga Pay Card Simulator]], A79 | NOT ASSIGNED |
| R32 | **A feature flag gates less than its name implies, so a disabled feature stays reachable** | 3 | 4 | 12 | Two live instances found while performing D112, both by switching a flag off and testing every path rather than by reading the table: `card.simulated` gated `/pay/card` and left **nine** Telga Pay routes served, and `deposits.training` gated `/deposit`, a path **no route uses**. Both are fixed and `tests/ui/card-screens.test.ts` now asserts refusal across the whole tree for an operator, an anonymous caller and a POST. **Not mitigated in general:** nothing checks that a `FEATURE_ROUTES` prefix corresponds to a route that exists, so the next dead entry will look identical to a working one. Recorded as `A99` | NOT ASSIGNED |
| R33 | **Telga is described as supporting multi-shop onboarding, which it does not** | 3 | 4 | 12 | There is no registration workflow and no automatic tenant creation: `merchant_applications` is written by nothing, and `provisionMerchant`/`merchantIdFor` have no callers. A merchant exists only through the CLI `provision()`, with **ids typed by whoever runs the command** rather than generated server-side. Deferred deliberately by D113 for the single-shop training deployment. **The risk is a claim, not a defect:** telling a merchant, partner or investor that shops self-register would be false. Isolation *between* shops that already exist is sound and tested. Recorded as `A85` | NOT ASSIGNED |
| R34 | **The admin console looks operational but cannot see operations** | 3 | 3 | 9 | The console has real authentication (password + RFC 6238 TOTP + step-up), an audit trail, and nine working screens - merchants, devices, applications, tenants, admins, audit. It has **no** view of transactions, receipts, balances, reports, support cases, provider health, pending/under-review items or training deposits, and `server.ts:901` says per-shop data is not readable from it. An operator handling a live merchant complaint would find nothing to work with. Mitigating today: the console **cannot** change balances, flags or transaction state - no mutation path exists - so the gap is blindness, not danger. Admin route authorization is being tested under B6 | NOT ASSIGNED |
| R35 | **A receipt is promised on paper and no printer implementation exists** | 4 | 4 | 16 | **Nothing prints.** No `ReceiptPrinter` port in code, no ESC/POS, no Bluetooth or USB support or permissions, no network printer client, no Android Print Framework, no vendor POS SDK, no printer settings, and not even a `window.print()` call - only `@media print` CSS on a screen. [[Receipt Specification]] and [[Architecture]] named a port that was never written, which is how this went unnoticed. CLAUDE.md requires a receipt a customer can be handed, and [[Merchant Onboarding]] has the merchant buying thermal paper for it. **Scored high because the gap is between the documentation and the product, not inside the code**, and because it cannot be closed without the smart-POS make and model - a built-in printer normally needs a vendor SDK. Recorded as `A101`; tracked as B8 | NOT ASSIGNED |
| R36 | **A build log names a cause that is not the cause, and successive fixes keep missing it** | 4 | 3 | 12 | **Three readings, two of them wrong, before the build was understood.** (1) The log printed `gyp info using node@24.10.0` beside the failure, inviting a Node pin that would have failed identically -- the real cause was an implicit `node-gyp rebuild` against an image with no Python, for a package that **already ships the binary it needed**. (2) The first fix then proposed `.nvmrc` as a durable Node pin, which Nixpacks ignores: it ranks `NIXPACKS_NODE_VERSION` above `package.json` `engines.node` above `.nvmrc`, and this repository declares `">=20"`. Caught only because the founder demanded a runtime proof. (3) The second fix changed `railway.json`'s `buildCommand` -- but Nixpacks generates its **own install phase** that runs first, so the failing command was never the one changed, and the next build failed the same way. **Raised from 9 to 12** because the pattern repeated under review rather than being caught by it. Now mitigated for this case by D115, which overrides the Nixpacks install phase in `nixpacks.toml` -- the phase that actually fails -- and adds a build-time assertion that the SQLite binding loads on the build host. **The class is not mitigated:** a build log is evidence, not a diagnosis, and a fix asserted without execution is a hypothesis. Recorded as `A103` | NOT ASSIGNED |

## Added by the first publication

| # | Risk | L | I | Score | Mitigation | Owner |
|---|---|---|---|---|---|---|
| R31 | **Host failure loses the entire ledger** ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â no backup has ever been restored on real infrastructure | 2 | 5 | 10 | `@telga/backup` implements checkpoint-before-copy, checksum verification, and isolated restore ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â tested against real synthetic data, 27 cases plus 5 against the compiled binary. See [[Backup Restore Implementation]]. A host **category** is now selected (local/office machine, 2026-08-25 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â see [[Decision Log]] D65, [[Persistent Host Deployment Plan]]); the specific machine is not yet hardened. **Not yet mitigated on real infrastructure**: no real backup schedule, no measured time-to-restore, launch gate 10 stays OPEN | NOT ASSIGNED |
| R30 | **A Vercel deployment is mistaken for a working or production Telga** | 3 | 5 | 15 | **DEPLOYMENT-BLOCKING ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â this risk gates any deployment, and is stated here rather than in the title so the title names the risk and nothing else.** The architecture is stateful and does not fit serverless: ephemeral storage would fork the ledger and void the claim lease. Documented in [[Vercel Deployment Limits]]; recorded as A56. A GitHub push must not be treated as a production Vercel deployment; if a Vercel project is connected, its automatic production deployments should be paused until a compatible target exists. A Vercel URL is training/preview only, never production. **Watch the Output Directory setting** ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â with no framework and no `public/`, some configurations serve the repository root. A persistent-host category has been recommended in [[Deployment Target Evaluation]] (proposed, not accepted ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â no vendor chosen, nothing deployed); this mitigates the risk only once actually running and verified, not before | NOT ASSIGNED |

## Highest risks today

R1, R11, then R2, R3 and R5 equally. **R11 is the one that blocks all the others** ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â the mitigations
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
