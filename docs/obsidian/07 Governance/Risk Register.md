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
| R33 | **A copied device key lets another machine act as an enrolled device** | 3 | 4 | 12 | Training-grade binding, stated and tested as such. Enrolment, revocation and expiry checked on every request; a stolen POS is stopped by revocation rather than by attestation — [[Device Binding]], A52, A69. **Renumbered from R23 on 2026-08-29**: two different risks carried that number, so a reference to "R23" was ambiguous. The recipient-hash leak keeps R23, being the older of the two | NOT ASSIGNED |
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

## Added by the Telga launcher and Telga Pay module

| # | Risk | L | I | Score | Mitigation | Owner |
|---|---|---|---|---|---|---|
| R32 | **A launcher tile is mistaken for a second real application, or the card simulator for a real card terminal** | 2 | 4 | 8 | Wording discipline enforced in code and docs ("module"/"tile"/"section", never "app"/"installed"); every Telga Pay screen carries an explicit training banner; card payments are built as two **ports** — `CardReader` and `PaymentProcessor` — whose only implementations in this repository are simulators (D87). No implementation performs network egress of any kind, so no code path can reach a real card network, processor, or bank; `payments.acceptance` is off and the build refuses to start with it on. The port exists so that connecting real hardware later is implementing an interface rather than rebuilding the product — it is **not** itself a connection. **Updated 2026-08-29**: the earlier wording claimed no code path existed, which read as "no card code exists" once the ports were written — see [[Telga Launcher and Dashboard]], [[Telga Pay Card Simulator]], A79 | NOT ASSIGNED |
| R32 | **A feature flag gates less than its name implies, so a disabled feature stays reachable** | 3 | 4 | 12 | Two live instances found while performing D112, both by switching a flag off and testing every path rather than by reading the table: `card.simulated` gated `/pay/card` and left **nine** Telga Pay routes served, and `deposits.training` gated `/deposit`, a path **no route uses**. Both are fixed and `tests/ui/card-screens.test.ts` now asserts refusal across the whole tree for an operator, an anonymous caller and a POST. **Not mitigated in general:** nothing checks that a `FEATURE_ROUTES` prefix corresponds to a route that exists, so the next dead entry will look identical to a working one. Recorded as `A99` | NOT ASSIGNED |
| R33 | **Telga is described as supporting multi-shop onboarding, which it does not** | 3 | 4 | 12 | There is no registration workflow and no automatic tenant creation: `merchant_applications` is written by nothing, and `provisionMerchant`/`merchantIdFor` have no callers. A merchant exists only through the CLI `provision()`, with **ids typed by whoever runs the command** rather than generated server-side. Deferred deliberately by D113 for the single-shop training deployment. **The risk is a claim, not a defect:** telling a merchant, partner or investor that shops self-register would be false. Isolation *between* shops that already exist is sound and tested. Recorded as `A85` | NOT ASSIGNED |
| R34 | **The admin console looks operational but cannot see operations** | 3 | 3 | 9 | The console has real authentication (password + RFC 6238 TOTP + step-up), an audit trail, and nine working screens - merchants, devices, applications, tenants, admins, audit. It has **no** view of transactions, receipts, balances, reports, support cases, provider health, pending/under-review items or training deposits, and `server.ts:901` says per-shop data is not readable from it. An operator handling a live merchant complaint would find nothing to work with. Mitigating today: the console **cannot** change balances, flags or transaction state - no mutation path exists - so the gap is blindness, not danger. Admin route authorization is being tested under B6 | NOT ASSIGNED |
| R35 | **A receipt is promised on paper and no printer implementation exists** | 4 | 4 | 16 | **Nothing prints.** No `ReceiptPrinter` port in code, no ESC/POS, no Bluetooth or USB support or permissions, no network printer client, no Android Print Framework, no vendor POS SDK, no printer settings, and not even a `window.print()` call - only `@media print` CSS on a screen. [[Receipt Specification]] and [[Architecture]] named a port that was never written, which is how this went unnoticed. CLAUDE.md requires a receipt a customer can be handed, and [[Merchant Onboarding]] has the merchant buying thermal paper for it. **Scored high because the gap is between the documentation and the product, not inside the code**, and because it cannot be closed without the smart-POS make and model - a built-in printer normally needs a vendor SDK. Recorded as `A101`; tracked as B8 | NOT ASSIGNED |
| R39 | **The POS CLI's entry guard fires for any script named `cli.js`** | 2 | 3 | 6 | `apps/merchant-pos/src/cli.ts` guards its top-level entry with `process.argv[1]?.endsWith('cli.js')`. That matches on filename, not identity — and the operations console's entry is **also** `cli.js`. Importing `@telga/merchant-pos` into the console (to reuse `parseTrustedEntry`) therefore ran the POS's `main()` on start-up, which printed `--merchant is required` before the console's own output. Found 2026-09-09 while starting the console for the first time. **Worked around, not fixed:** the console no longer imports the POS package, so nothing currently triggers it. The guard remains wrong and will bite the next `cli.js` in this repo. The fix is one line — compare resolved paths rather than a suffix — but it edits a **deployed** component, so it waits for founder approval rather than being slipped in. Likelihood is low because few things import the POS package; impact is moderate because the failure is loud and immediate rather than silent | Founder |
| R40 | **A suspended shop's operators could still sign in** | 2 | 4 | 8 | **Closed 2026-09-09 by D138.** `signIn` read `merchant_users.status` and never `merchants.status`, so suspending a shop in the console stopped it selling — `createSale` refused `MERCHANT_NOT_ACTIVE` — while its operators kept signing in, browsing history and holding live sessions until they chose to sign out. The console's device-stop route already revoked sessions for exactly this reason (*"a stopped device that kept a live session would still be usable"*); merchant suspension did not. `signIn` now refuses and `authenticate` revokes the session on the next request. Pinned by a test in `tests/admin/vendor-registration.test.ts` |
| R41 | **`apps/merchant-pos/` is a server, and its name says client** | 3 | 2 | 6 | The directory holding the **server** that renders every merchant screen is named as though it were the POS's own application, and `packages/pos-view-model` repeats it. This is how the "there is a POS app and an Android app" misreading keeps recurring, against D68's *"Telga is one application"*. The cost is not runtime but design: work gets planned as though a till and a phone need different builds. **Mitigated by documentation, not renamed** — [[Platform Shape]] states the correction, and `CLAUDE.md` §18.0 and §27 now name the real directories. A rename touches imports, build scripts, the Railway start path and the Capacitor config, so it is a change worth making deliberately rather than in passing |
| R42 | **The registration throttle resets on restart, and is coarse without a trusted proxy** | 3 | 2 | 6 | `POST /register` is the only surface an unauthenticated stranger may write through. Its per-source bucket is salted with `recipientSalt`, which is a **fresh UUID at process start**, so a restart empties every bucket; and when no `--trust-proxy` range is configured the forwarding header is ignored, so every request behind one edge shares a bucket. Both fail in the safe direction — a restart forgets who was throttled rather than throttling the innocent, and a shared bucket is coarse rather than absent — and both are real. **Mitigations:** configure `--trust-proxy` on the Railway deployment; the flag `registration.self_service` closes the route in one switch if it is abused. **A durable salt is an open deployment decision.** See [[Vendor Registration]] |
| R43 | **The merchant app accepts an opaque `Origin` unconditionally** | 2 | 3 | 6 | `checkOrigin` in `apps/merchant-pos/src/transport/proxy.ts` returns early on `origin === 'null'`, so a **sandboxed cross-site iframe** — which is exactly what sends an opaque origin — passes the CSRF check. It has never shown as a symptom because the app also sent `Referrer-Policy: no-referrer`, which made ordinary browsers send `null` too, so the allowance was load-bearing. **The cause is now removed** (the header is `same-origin` on both apps, 2026-09-09), which makes the allowance mostly dead code. **Deliberately not tightened in the same change:** the POS is the deployed merchant sign-in path, the console's own fix is what was urgent, and narrowing an authentication check blind — on hardware that cannot be tested from here — is how a pilot loses a morning. The console's approach (`Sec-Fetch-Site` must say `same-origin` or `none`) is the intended shape for it. **Fix when a real device is available to test on** | 
| R44 | **~~§17 complaint handling has no mechanism~~ — CLOSED by D150** | 1 | 1 | 1 | **Closed 2026-09-10.** Opened when D144 limited Telga staff to aggregates, leaving §17's obligation standing with no means: a merchant naming a transaction could not be answered. **The resolution is the third option that was offered and not taken at the time** — individual rows visible only inside an open support case, scoped to one shop. `/complaints` is that desk. A merchant reports from the app, the case carries the transaction they named, and a reviewer sees that one sale, audited, with the recipient still masked. General browsing stays closed. **What is still true and is not this risk:** a verdict moves no money. Returning it is a reversal, which is §17.1's own flow and has its own authorisation | 
| R45 | **Status columns written in one place and read in another** | 3 | 4 | 12 | **Two bugs from this family in one day**, in opposite directions. **R40**: `merchants.status` was written by the console's suspend route and **never read** at sign-in, so a suspended shop's operators kept trading. Then the fix for R40 produced the mirror image: `merchants.status` was **read** at sign-in and never written past `ONBOARDING`, so a newly registered shop could never sign in at all. **The class is not closed.** The same shape is available for `devices.status`, `tenant_registry.status`, `merchant_users.status` and the eleven-state merchant lifecycle — each is written by one route and read by several, and no test walks between them. **What would close it:** a test per entity that moves the status through every value and asserts what each entry point does, rather than testing writer and reader separately. The Runbooks have recommended this since R40 and it is now overdue. **Partially mitigated** by `tests/e2e/shop-onboarding-chain.test.ts`, which walks the merchant lifecycle end to end and is what caught the second bug — before a person did | 
| R46 | **~~A remotely stopped device can still sign in~~ — WITHDRAWN, the premise was wrong** | 1 | 1 | 1 | **Corrected 2026-09-10, same day it was raised.** The original claim was that the console's remote stop wrote `devices.status` while the sign-in path read only `device_enrollments.enrollment_state`, so a stopped device could sign back in. **The first half is true and the conclusion is false.** `deviceRejection` does read only the enrolment state — but the stop route writes **both**: it sets `devices.status = 'STOPPED'` *and* `enrollment_state = 'REVOKED'` *and* revokes live sessions, all in one transaction. A stopped device was already refused at sign-in, with `DEVICE_REVOKED`. **How the mistake was made:** the inputs to `deviceRejection` were read and the *writer* was not. That is precisely the failure the vault's own standing instruction warns against — *do not guess, find out* — committed while carrying out an audit whose entire purpose is to walk from writer to reader. The audit found the asymmetry correctly and the conclusion drawn from it was not checked. **What was kept:** sign-in now also reads `devices.status`. As defence in depth it is worth having — a future path that stops a device without revoking its enrolment would still be refused — but it closed **no hole that was open**, and must not be described as having done so. **Score reduced to 1×1.** | 
| R37 | **A store of photographed national IDs becomes a breach target** | 2 | 5 | 10 | **Accepted by the founder (D125) for a legitimate purpose** — identifying an accountable person when a shop commits fraud, which is why every regulated platform holds identity documents. The risk is not in holding them but in holding them carelessly, so the obligations are the mitigation: encrypted at rest; on the volume, never in the repository, a log, or an unencrypted off-platform backup; access behind step-up re-authentication **and itself audited**, so who looked at whose passport is answerable; never returned by any endpoint a merchant session can reach; and a written retention and deletion policy **before a second shop is onboarded**. Impact is 5 because the harm lands on shop owners rather than on Telga, and is not undoable. Needs local data-protection advice per CLAUDE.md §8 | Founder |
| R38 | **The Device Key is disclosed on every bank deposit slip** | 3 | 3 | 9 | **Accepted by the founder (D125) after being raised three times.** `credentialsOf()` requires `userId`, `pin`, `deviceId`, `deviceSecret`; a slip discloses the last two, removing the **device** factor and leaving the operator id and PIN alone. What is lost is precisely `Device Binding`'s claim that *"an unenrolled machine cannot sign in, even with a correct PIN"* — A52 already notes a copied key is indistinguishable from the original. **Not a full compromise:** a slip alone signs nobody in. Mitigations that keep the founder's flow intact: the matcher uses the reference only as a lookup key and never as authentication; a device whose slip was mishandled is re-enrolled, issuing a new key and revoking sessions; sign-ins from an unfamiliar context for a device are surfaced. **`depositReference.ts` (D119) is built and does the same job without disclosing a credential** — adopting it later is configuration, not redesign | Founder |
| R36 | **A change is asserted without verifying its own output** | 4 | 3 | 12 | **Four instances in one episode, three of them while trying to fix the previous one.** (1) The build log printed `gyp info using node@24.10.0` beside a failure caused by a missing Python, inviting a Node pin that would have failed identically. (2) The first fix proposed `.nvmrc` as a Node pin that Nixpacks ignores, because `engines` outranks it — caught only because the founder demanded a runtime proof before approval. (3) The second changed `railway.json`'s `buildCommand`, when Nixpacks generates its own `install` phase that runs first, so the failing command was never touched. (4) Then, editing the vault to record all of that, a PowerShell round-trip re-encoded four notes into double-encoded UTF-8, and the result was committed and pushed three times before anyone read it closely — one file reached 5,111 damaged sequences, because each later edit corrupted the corruption. **The common thread is not misreading evidence, it is not checking the result.** Every one would have been caught by looking at the output of the change immediately after making it. **Mitigations now in place, each turning a habit into a gate:** `verify-binding.mjs` fails the Railway build if the SQLite binding does not load; `railway-start.mjs` prints which variables the container actually received; `validate-vault.mjs` fails on double-encoded text, proved by injecting the exact corruption and watching it exit 1. **Not mitigated:** the general habit. A gate exists only where somebody thought to build one. | NOT ASSIGNED |

## Added by the first publication

| # | Risk | L | I | Score | Mitigation | Owner |
|---|---|---|---|---|---|---|
| R31 | **Host failure loses the entire ledger** — a backup has now been restored off the hosting platform | 2 | 5 | 10 | `@telga/backup` implements checkpoint-before-copy, checksum verification and isolated restore — 27 cases plus 5 against the compiled binary ([[Backup Restore Implementation]]). **Drilled end to end on 2026-09-07, on the real deployment:** a backup was taken on Railway against `/data/telga.sqlite` (`schemaVersion` 014, `ledgerResidualMinor` 0), transferred **off the platform**, and restored on different hardware. The SHA-256 matched exactly after transfer, the restore reported `integrityCheck: "ok"` and `appendOnlyVerified: true`, and the restored file was independently verified to contain transaction `txn_e0aa272973194cdd` and all fourteen migrations. **Volume persistence was proved separately** the same day: the balance and that transaction survived a `railway redeploy` that replaces the container. **What is still missing, and why gate 10 is not closed by this:** there is **no backup schedule** — the drill was manual, one file, moved by base64 over SSH because Railway offers no download command. That is a proof of concept, not an operational procedure: it will not scale past a small training database, and nothing runs it automatically. **Railway also deletes volume data 30 days after credits lapse**, so an unscheduled backup is a single missed renewal away from total loss. Scheduled backups to object storage remain unbuilt. | NOT ASSIGNED |
| R30 | **A Vercel deployment is mistaken for a working or production Telga** | 3 | 5 | 15 | **DEPLOYMENT-BLOCKING — this risk gates any deployment, and is stated here rather than in the title so the title names the risk and nothing else.** The architecture is stateful and does not fit serverless: ephemeral storage would fork the ledger and void the claim lease. Documented in [[Vercel Deployment Limits]]; recorded as A56. A GitHub push must not be treated as a production Vercel deployment; if a Vercel project is connected, its automatic production deployments should be paused until a compatible target exists. A Vercel URL is training/preview only, never production. **Watch the Output Directory setting** — with no framework and no `public/`, some configurations serve the repository root. A persistent-host category has been recommended in [[Deployment Target Evaluation]] (proposed, not accepted — no vendor chosen, nothing deployed); this mitigates the risk only once actually running and verified, not before | NOT ASSIGNED |

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
