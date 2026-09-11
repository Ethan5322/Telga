---
title: Multi-Tenant Architecture Proposal
type: product
status: draft
owner: product-strategist
created: 2026-09-08
updated: 2026-09-08
tags:
  - telga
  - product
  - security
  - operations
related:
  - "[[00 Home]]"
  - "[[Multi-Shop Onboarding]]"
  - "[[Admin Operations Console]]"
  - "[[Device Binding]]"
  - "[[Merchant Onboarding]]"
  - "[[Funding Verification]]"
  - "[[Balance Top-Up and Funding]]"
  - "[[Legal Questions]]"
depends_on:
  - "[[Decision Log]]"
  - "[[Launch Gates]]"
validates:
  - "[[Security Model]]"
decision_status: proposed
---

# Multi-Tenant Architecture Proposal

> [!info] Status
> A **report and proposal** produced 2026-09-08 in response to a founder brief.
> **No code, configuration or deployment was changed.** The single-shop training
> system on Railway is untouched and running at commit `70a5766`.

## 1. What already exists — more than the brief assumes

The brief describes a system that is largely specified and substantially built.

| Brief requirement                                   | Status                       | Where                                                            |
| --------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------- |
| Merchant ID per shop                                | ✅ Built                      | `merchantIdFor()`, derived from the application id               |
| Operator IDs per shop                               | ✅ Built                      | `merchant_users`, `NOT NULL merchant_id`                         |
| Device IDs per shop                                 | ✅ Built                      | `devices` + `device_enrollments`                                 |
| **43-character device key**                         | ✅ **Exact match**            | `newToken(32)` → base64url = 43 chars, scrypt-hashed, shown once |
| **PIN 6–12, numeric, not all-same, not sequential** | ✅ **Exact match**            | `pinRejection()` in `packages/domain/src/auth.ts`                |
| All devices share one shop balance                  | ✅ Built                      | `balanceFor(merchantId)`                                         |
| Shop data isolation                                 | ✅ Built and tested           | Session-derived `merchantId`, never from the request body        |
| Admin identity separate from merchants              | ✅ Built                      | `admin_users`, migration 014                                     |
| Admin MFA and step-up re-auth                       | ✅ Built                      | `/mfa`, `/step-up`                                               |
| Application review and approval                     | ✅ Built                      | `/applications`                                                  |
| Suspend a shop                                      | ✅ Built                      | Lifecycle `SUSPENDED`, tenant status refusals                    |
| Auto-generated activation code                      | ✅ Built                      | 100-bit, base32 minus `I O 0 1`, 1-hour expiry, hashed           |
| Eleven-state merchant lifecycle                     | ✅ Built                      | `admin/applications.ts`                                          |
| Per-shop provisioning                               | ✅ Built and called           | `admin/provisioning.ts`, exported from `@telga/api`; called by `/applications/:id/decide` |
| Per-shop database routing                           | ⚠️ Written, **no callers**   | `admin/tenantRouting.ts` — deliberate, see below                 |

> [!warning] This section was stale, and is corrected here
> **Four of the five gaps below were closed and this note still described them
> as open.** Re-verified against the code on 2026-09-10, claim by claim, because
> a status table nobody re-checks is worse than no status table: it is read as
> current.
>
> This is the same defect that produced the §14.1 and §17 corrections in
> `CLAUDE.md` — documentation asserting a state of the system that stopped being
> true. It was found by the founder reading the vault, not by any test.

| Gap as recorded | Verified 2026-09-10 |
|---|---|
| *"no application can be submitted"* | **Closed.** `/register` `GET` and `POST` on the merchant server — D138, §18.1 Path A. Returns a reference; creates no account |
| *"approval never calls `provisionMerchant()`"* | **Closed.** `/applications/:id/decide` calls it in the same request, after the decision is recorded. Two call sites |
| *"no route redeems an activation code"* | **Closed.** `/activate` `GET` and `POST` — §18.2 step 6, reachable with no session because a device with no key cannot sign in |
| *"`tenantRouting.ts` has no callers"* | **Still true, and deliberate.** D113(a) deferred per-shop databases and D120 chose the shared model; wiring this would silently reinstate D103. It stays uncalled until that founder decision is taken — §18.4 |
| *"nothing forces a PIN change on first login"* | **Closed.** `merchant_users.must_change_pin`, migration 015. Set by `issueCredentials` — a PIN Telga staff read aloud has an unknown number of holders — and read by `changePin` |

**So one gap remains, not five**, and it is a decision rather than an omission.

## 2. What CLAUDE.md and the vault do **not** specify

| Missing | Consequence |
|---|---|
| **Shop registration documents** | Neither CLAUDE.md nor [[Merchant Onboarding]] lists any. §18 covers merchant *types* and device controls only. Proposed in §5 below |
| **Withdrawals** | Nowhere in CLAUDE.md or the vault. [[Funding Verification]] is deposit-only |
| **Aggregate cross-shop reporting** | [[Admin Operations Console]] lists it as "not decided" |
| **Kazang / Flash architecture** | Named once in [[Roadmap]] as a benchmark cohort. **No study exists.** P13 still asks whether "Kazan" even means Kazang |
| **Data retention for closed shops** | [[Admin Operations Console]] "not decided" |
| **Device credential type** | A52 open — the key is a bearer string, not hardware-attested |

## 3. Four conflicts that need a founder decision

> [!danger] These are not implementation details. Each one changes what gets built, and two touch law and money.

### 3.1 "Admin must NOT view individual shop transactions"

**This conflicts with CLAUDE.md §17.** Complaint handling *requires* it:

> *"Search by transaction ID, receipt, time, amount, or reference… Return one of:
> successful, pending, confirmed failed, under review. Target a final answer
> within 24 hours."*

A merchant phoning to say *"a customer paid and got no airtime"* cannot be helped
by someone who can only see totals. §20 also requires a **separate reviewer** to
reconcile daily, and the Auditor role exists to read audit logs.

**Proposed resolution — aggregates by default, break-glass by exception:**

| Access | Requires |
|---|---|
| Aggregate metrics, per-shop totals, balances, activity counts | Normal admin session |
| **An individual transaction** | **Step-up re-authentication + a recorded reason + a support case reference** |
| The access itself | Written to the audit trail and visible to the shop |

This honours privacy-by-design — nobody browses a shop's trade casually — while
keeping the §17 support obligation possible. **Pure aggregate-only would make
Telga unable to answer the complaint that matters most.**

### 3.2 Admin authentication: face + password + **PIN**

The brief requires a PIN. [[Admin Operations Console]] Decision 1 says:

> *"Authentication is **email + password + MFA, never a PIN**. CLAUDE.md §24 and
> the owner brief both forbid a merchant PIN as an administrative credential."*

And D105 already decided the biometric: **WebAuthn passkey**, where the phone
verifies the face and Telga stores **no image and no template**.

**Proposed:** password + **passkey (the face)** + TOTP code. That is three
factors and satisfies the brief's intent. A separate admin PIN adds a
memorised-number factor that is weaker than the passkey already present, and
reverses an accepted decision. **Founder's call.**

> Ethiopian context worth noting: NBE rules reportedly require two-factor —
> PIN, OTP or biometric — above 5,000 birr. Passkey + TOTP satisfies that class
> of requirement. **Not legal advice; see §6.**

### 3.3 Storage: the brief **relaxes** D103

The brief says data may be *"logically isolated, even if in the same database."*
**D103 chose physical per-shop database files** and called it *"the irreversible
choice."* D113 deferred it.

| | Shared DB, logical isolation (brief) | Per-shop files (D103) |
|---|---|---|
| Isolation | Session-derived `merchantId`; **11 isolation tests pass** | "The other shop's rows are not in the file" |
| **Admin aggregate reporting** | **One query** | **A fan-out and merge** |
| Backup | One file — gate 10 evidence already exists for this shape | N files + registry |
| Migrations | 12, once | 12 × N, versioned per tenant |
| Blast radius | One corrupt file affects all shops | One shop |
| Work to adopt | **None — this is today's shape** | Export 2 modules, wire routing, N-backup tooling |

**Recommendation: adopt the brief's model — shared database, logical isolation —
and formally supersede D103 rather than let it drift.** The brief's own admin
panel is the deciding argument: *"monitor system performance, aggregate metrics,
total transactions, total volume"* is a primary requirement, and D103 makes
exactly that expensive. Keep `tenant_registry` in place so splitting later
remains open.

**This must be an explicit reversal.** D103 was accepted after a full comparison;
it should not be dropped silently.

### 3.4 Withdrawals are a regulated feature

The brief adds *"per-shop withdrawals (shop owner withdraws balance)."* Nothing
in CLAUDE.md or the vault covers this. Paying money **out** is `cash.in_out` and
`settlement.independent` — both false, both in `MOVES_REAL_MONEY`, both gated.

**In training:** a simulated withdrawal reversing the training credit is safe and
useful. **In production:** it needs the gates, and it sharpens the question in §6.

## 4. Kazang and Flash — what the reference systems actually do

Researched 2026-09-08. **Neither had been studied before; the vault named them
once as a benchmark cohort.**

| Aspect | Kazang | Flash | Telga's position |
|---|---|---|---|
| Retailer balance | One **wallet per retailer**; products vend as soon as it is positive | Retailer balance on device | **Same** — `balanceFor(merchantId)` |
| Balance on device | Shown at top of screen; Reports section on device | On device | **Same** |
| Top-up | **Cash deposited into a Cash Connect vault**, no deposit fee | Cash / retail network | Bank deposit + verification — Telga has no vault network |
| **Credit / overdraft** | **Up to R5,000 for 48 hours** | *"Access balance now, pay back later"* | **Forbidden** — see below |
| Scale | ~90,000 devices | — | 1 device |
| Settlement | Same-day to the retailer's wallet | — | Not designed |

> [!danger] The one place Telga must **not** copy its benchmarks
> Both Kazang and Flash offer retailer **overdraft**. CLAUDE.md §20 forbids it
> absolutely — *"No overdraft. A merchant can never sell against value they do
> not have"* — and `lending` is false and gated. Extending credit to merchants is
> a lending product requiring its own authority.
>
> A founder benchmarking against these systems will notice the feature gap. It is
> **deliberate**, and it is a legal boundary, not a backlog item.

The structural lesson worth copying is the **wallet-per-retailer with a physical
cash-in network**. Telga's equivalent is the bank-deposit-plus-verification flow
already designed in [[Funding Verification]].

## 5. Proposed shop registration documents

> [!warning] A proposal, not a compliance statement
> CLAUDE.md §8: *"Never claim legal compliance without documented qualified
> review."* This list is drawn from publicly described Ethiopian business
> registration practice and general KYB norms. **It must be reviewed by an
> Ethiopian lawyer before a single shop is onboarded.** Recorded in
> [[Legal Questions]].

### Tier A — required to operate a business in Ethiopia

| Document | Why |
|---|---|
| **Trade / Business Licence** | The operating authority. Renewed annually |
| **Commercial Registration Certificate** | Mandatory before a trade licence is issued |
| **TIN Certificate** | Issued by the revenue authority; mandatory before any commercial activity |
| **Owner's government photo ID** — national ID (Fayda), passport, or driving licence | Identifies the natural person accountable |
| **Proof of trading address** — lease agreement or utility bill | Ties the shop to a place; supports dispute and fraud handling |

### Tier B — required by Telga to trade and be paid

| Document | Why |
|---|---|
| **Bank account details in the business's name** | Deposits must come from, and settlements go to, the business — never a personal account (§20) |
| **Contact details** — phone and email, verified | Support, outage notices, dispute deadlines |
| **Business type and category** | Product eligibility and risk tier |
| **Expected monthly transaction volume** | Sets limits; a shop trading 20× its declared volume is a fraud signal |
| **Signed merchant agreement and fee disclosure** | **Launch gate 4.** Does not exist yet |

### Tier C — for a company rather than a sole trader

Memorandum and Articles of Association, and evidence of signing authority for
whoever signs the merchant agreement.

### Handling rules

- **Store the decision and a reference, not the images**, wherever possible.
  CLAUDE.md §24 requires data minimisation, and an approved-documents store is a
  high-value target.
- **Every document has an expiry.** A licence lapsing must raise a review, not
  pass silently.
- **No document may be committed to the repository** or reach a log.
- The rejection reason is free text a merchant may see; keep it factual.

## 6. The question the founder should take to a lawyer first

Research surfaced a regulatory point that outranks every engineering decision here.

Ethiopia licenses **Payment Instrument Issuers** under Directive ONPS/01/2020, as
amended by **NPS/10/2025**, which reportedly raises minimum paid-up capital to
**ETB 100 million**. There is also a **Use of Agents Directive FIS/02/2020**.

**Why this matters to the architecture:** the brief asks Telga to hold a
per-shop balance that shops deposit into and withdraw from. Depending on how that
is structured, it may be **stored value** — which is the thing those directives
regulate. Structured instead as *prepaid purchase of airtime inventory from an
authorised distributor*, it may not be.

**That distinction decides whether the deposit/withdrawal model in this brief is
lawful without a licence Telga does not hold.** It is a question for a qualified
Ethiopian lawyer, and it is worth asking **before** the funding workflow is
built, not after.

**Nothing above is legal advice.** It is a flag, recorded because building the
wrong structure is expensive to unwind. Added to [[Legal Questions]].

## 6a. Automatic bank top-up — the founder's proposal, assessed

**The proposal (2026-09-08):** a shop owner deposits cash at CBE into Telga PLC's
account, writing **the device key** as the deposit reference. Telga detects the
deposit and credits that device automatically, with no manual step.

**The goal is right and worth building.** One correction is mandatory, and one
constraint is external.

### 🔴 The device key must never be the bank reference

`credentialsOf()` in `http/authHandlers.ts` requires exactly four fields to sign
in: `userId`, `pin`, `deviceId`, **`deviceSecret`**. The device key *is a
password*. [[Device Binding]] states what it buys:

> *"An unenrolled machine cannot sign in, even with a correct PIN."*

That protection is the key. Writing it on a deposit slip destroys it:

| Where the reference ends up | Who sees it |
|---|---|
| The paper deposit slip, both copies | The depositor, and anyone who handles the slip |
| Keyed into CBE's core banking system | Bank staff, permanently |
| Printed on statements and exports | Anyone with statement access |
| Parsed by Telga's importer | Very likely a log line |

So every top-up would publish the device's password to a third party and onto
paper. A52 already records that **a copied key is indistinguishable from the
original**, and D74 keeps the key in a cookie that is not rotated on use. Worse,
the reference is known to whoever makes the deposit — so a shop assistant sent to
the bank learns the credential and can sign in from their own machine.

### ✅ The fix: a Deposit Reference Code

A separate, purpose-built identifier that is **public by design**:

- Stable per merchant, optionally per device for branch attribution.
- Unguessable enough to avoid collision and mistyping, with a **check digit** —
  it is copied by hand by a teller.
- **Grants no access whatsoever.** The worst an attacker can do with it is pay
  money into someone else's float.
- Printed in the POS under "How to top up", on receipts, and in the shop profile.

It maps onto the `merchant_reference` field [[Funding Verification]] already
carries. **Nothing else about the proposal changes.**

### The external constraint: how Telga learns of the deposit

Researched 2026-09-08. **CBE publishes no merchant API for incoming-deposit
notification.** What exists:

| Mechanism | Viability |
|---|---|
| Bank host-to-host / corporate statement feed | **The right answer.** Requires a CBE corporate agreement — a question for the bank, not a coding task |
| Scheduled statement import (MT940/CSV) | Near-automatic; minutes of delay. A good first implementation |
| Third-party verification APIs | They verify *a reference the customer supplies*; one advertises extracting it **from screenshots**, which §20 forbids as sole evidence |
| SMS alert parsing | **Refuse.** Unauthenticated, spoofable, and not a bank record |

**Before any of this is built, CBE must confirm that a deposit slip's reference
field survives into the statement Telga would read.** If it does not, the whole
design has no key to match on.

### Reconciling "no manual touch" with §20

CLAUDE.md §20 requires a verifier, a second approval for high-value deposits, and
daily reconciliation by a **separate** reviewer; §8 forbids crediting from a
screenshot alone.

The *purpose* of that rule is to prevent crediting on unverified evidence. **An
authenticated feed from the bank is verification** — stronger than a person
reading a screenshot. So automatic credit is defensible, bounded:

| Case | Handling |
|---|---|
| Matched reference, amount within the per-deposit cap | **Auto-credit.** No human step |
| Above the cap, or an unusual pattern | **Held for approval** — §20 already requires this |
| Reference unmatched, ambiguous, or duplicated | `MANUAL_REVIEW`. **Never guess a shop** |
| Every day, regardless | Reconciliation by a separate reviewer. **Not automatable** |

**Idempotency:** the bank's own transaction id becomes the posting id, so
re-importing a statement cannot double-credit — the same guard `deposits.ts`
already uses with `clientRequestId`.

**Routing:** the credit lands on the **merchant**, never a device.
`balanceFor(merchantId)` is the only balance there is; a per-device reference
records *where the deposit came from*, not who owns it.

### What this proposal makes unavoidable

Money paid into Telga PLC's account and held as a shop's spendable balance is
Telga **holding third-party funds**. That is exactly the stored-value question in
§6 above, and this design removes any ambiguity about whether it applies.
It also assumes Telga PLC exists as a registered entity with a corporate account
— **P1 in [[Decision Log]] is still pending.**

## 6b. The admin panel, audited against the brief's seven capabilities

Read from `apps/operations-console/src/server.ts` on 2026-09-08, not from memory.

| # | Brief requires | State |
|---|---|---|
| 1 | Face biometry **+** password **+** PIN | ⚠️ **Password + TOTP + step-up.** No face, no PIN — see below. **And a training relaxation exists**: `--single-factor` (D143, §23.1) switches off both the second factor and step-up together, announced at start-up and bannered on every page. It must be off before live money — §8's security gate cannot close while it is on |
| 2 | Register new shops | ✅ Review, approve, and since D120 **provision** |
| 3 | Suspend or deactivate shops | ✅ **Built.** `/merchants/:id/suspend` and `/reinstate`, `/devices/:id/stop` and `/reinstate`, `/operators/:id/suspend` and `/reinstate`. Each writes the status **and** revokes live sessions — R40 was a status written and never read at sign-in |
| 4 | Monitor system performance | ✅ **Counts and volume.** `/activity` computes per-shop sales counts, counts by state, and **volume** (`SUM(amount_minor)` over successful sales), plus the platform totals. Still aggregates only — D144 keeps individual transactions out, and §23.2 records where that line sits |
| 5 | View shop-level performance | ✅ **Built 2026-09-08 — D123.** `/merchants` shows **each shop's own** available float and a count of its sales, as correlated subqueries keyed on the merchant. Proved on the rendered page, including that the two shops' figures never appear as their sum |
| 6 | **NOT** view individual transactions | ✅ **Satisfied for transactions** — no console query touches `transactions` or `ledger_entries`. ⚠️ But `/audit` returns 200 rows of `audit_events` carrying `entity_id` and `merchant_id`, so *which* shop did *what kind of thing, when* is visible even though amounts and recipients are not |
| 7 | Manage system configuration | ❌ **Not built.** Feature flags are frozen compile-time constants by design — changing one is a code change plus a decision, deliberately |

### Face biometry has a concrete blocker, not just an absence

D105 chose a **WebAuthn passkey** — the device verifies the face and releases a
key, and Telga stores no image and no template. `admin_users` already carries
`webauthn_credential_id` and `webauthn_public_key`. **Nothing implements it**,
and `services/api/src/auth/totp.ts` records why:

> *"WebAuthn is a JavaScript API, and the console serves `script-src 'none'` —
> it has no script at all, deliberately. Adding a passkey means giving the
> console a script surface, which is a real trade to make on purpose rather than
> in passing."*

**So face unlock costs the console its no-script posture.** That is a founder
decision about security architecture, not a feature to schedule. The current
three factors — password, TOTP, and step-up re-authentication before any
merchant- or device-changing action — are a defensible answer in the meantime,
and step-up is genuinely enforced (proved at HTTP level in
`tests/admin/provision-on-approve.test.ts`).

### The gap that matters most operationally

**Requirement 5.** An admin cannot see how a shop is doing. Under D120's shared
database that is one query away; under D103 it is a fan-out. It is the strongest
practical argument in favour of D118's storage recommendation, and it is
unbuilt either way.

## 7. Proposed build sequence

Each step is independently reviewable, and none touches the running system until
it is deployed deliberately.

| # | Step | Notes |
|---|---|---|
| 1 | **Export `provisioning` and `tenantRouting`** from the api package | One line. Unblocks everything |
| 2 | **Wire approve → `provisionMerchant()`** | The single highest-value change |
| 3 | **Application submission** — a public route accepting Tier A/B details and document references | Creates no account and no credentials (Decision 3) |
| 4 | **Activation-code redemption** — a route that accepts a typed code and issues the device key | Closes gap 3 |
| 5 | **Force PIN change on first login** | New `must_change_pin` column |
| 6 | **Admin aggregate reporting** + break-glass transaction access | Resolves §3.1 |
| 7 | **Deploy the console** as its own service with TLS | Separate security decision |
| 8 | Training deposit screen out of `/pay`; then withdrawals, simulated | Per [[Balance Top-Up and Funding]] |

**The current single-device POS is unaffected by steps 1–6.** It signs in the same
way, sells the same way, and keeps the same database shape.

## 8. What must not be claimed

- That multi-shop onboarding works today. **No shop can submit an application.**
- That the document list is legally sufficient. It is unreviewed.
- That Telga may hold merchant funds. That is §6's open question.
- That any of this clears a launch gate. **0 of 10 cleared.**
- That overdraft or credit will be offered. It is forbidden.

## Related

- [[Multi-Shop Onboarding]] — the four gaps, in detail
- [[Admin Operations Console]] — the four accepted decisions and the seven roles
- [[Device Binding]] — enrolment, revocation, and the A52 limitation
- [[Balance Top-Up and Funding]] — the three tiers of top-up
- [[Funding Verification]] — the deposit state machine
- [[Legal Questions]] — where §5 and §6 are tracked
- [[Decision Log]] — D103, D105, D108, D113, D118
