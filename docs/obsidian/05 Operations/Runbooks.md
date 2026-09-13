---
title: Runbooks
type: operations
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - operations
  - runbook
  - incident
related:
  - "[[00 Home]]"
  - "[[Provider Health]]"
  - "[[Support and Disputes]]"
  - "[[Incident]]"
depends_on: []
implements: []
validates: []
decision_status: pending
---

# Runbooks

Operational procedures, and the permanent log of every fault found and fixed. **Every fix gets a
note here**, written from the [[Incident]] template and linked from this page and from [[00 Home]].
No incident note is an orphan.

## Required runbooks

| # | Runbook | Status |
|---|---|---|
| 1 | Provider outage | TO BE WRITTEN |
| 2 | Under-review backlog | TO BE WRITTEN |
| 3 | Funding verification exception | TO BE WRITTEN |
| 4 | Daily reconciliation mismatch | TO BE WRITTEN |
| 5 | Printer failure | TO BE WRITTEN |
| 6 | Device loss or theft | TO BE WRITTEN |
| 7 | Refund and reversal | TO BE WRITTEN |
| 8 | Incident response | TO BE WRITTEN |
| 9 | Restore from backup | **PROCEDURE TESTED LOCALLY 2026-09-05** — steps and evidence in [[Localhost Setup]]; a backup was restored to a new file with a matching SHA-256, `integrityCheck: "ok"`, `appendOnlyVerified: true`, and the restored database then served traffic with all health checks green. **Launch gate 10 stays OPEN**: this was a developer machine, not real infrastructure, and no restore has been timed or rehearsed on a host — see [[Backup and Restore Runbook]] and R31 |
| 10 | Database operations — health, residual, migrations | **WRITTEN** — [[Database Operations Runbook]] |
| 11 | Transaction failure — triage, stuck sales, reversals | **WRITTEN** — [[Transaction Failure Runbook]] |
| 12 | Recovery sweep — daily checks, failures, worker contention | **WRITTEN** — [[Recovery Sweep Runbook]] |
| 13 | Manual review — working an under-review case | **WRITTEN** — [[Manual Review Runbook]] |
| 14 | Worker operations — health, backoff, restart, manual recovery | **WRITTEN** — [[Worker Operations Runbook]] |
| 15 | Deployment — sequence, rolling, rollback | **WRITTEN** — [[Deployment Runbook]] |

## "Why has Telga Pay disappeared?"

Not a fault. Founder decision [[Decision Log]] **D112** switched off
`card.simulated` and `product.data`, so the Telga Pay tile, the dashboard
payments tab, the two Pay top-up options and the data voucher category are no
longer drawn, and every `/pay` and `/vouchers/data` address answers **404**.

| An operator reports | Answer |
|---|---|
| The Telga Pay tile is gone from the launcher | Correct. It is not part of the approved training scope |
| Typing `/pay` gives "no such screen" | Correct, and deliberate — refused, not hidden |
| Data bundles are missing from vouchers | Correct. **Airtime** vouchers are unaffected |
| I cannot top up the training float in the app | **Known gap, `A100`.** The deposit screen lived under `/pay`. Use `--training-float` at provision time, or the endpoint directly |

Nothing here indicates a defect, and none of it should be "fixed" by turning a
flag back on: that needs a founder decision, not a configuration change.

Each runbook must state: trigger, who owns it, immediate action, merchant communication,
escalation path, resolution criteria, and what gets recorded.

Owners cannot be assigned yet — see [[Founders and Roles]].

## Standing rules that apply to every runbook

1. **Never treat a timeout as a failure.** See [[Transaction State Machine]].
2. **Never auto-refund an unknown outcome.** See [[Support and Disputes]].
3. **Never edit the ledger.** Corrections are authorized adjustment entries. See [[Ledger Invariants]].
4. **Tell the merchant before the deadline, not after.** See [[Support and Disputes]].
5. **Record everything** — every operational action produces an `AuditEvent`.

## Incident log

Faults found and fixed during development and pilot. Newest first.

| Date | Incident | Severity | Status |
|---|---|---|---|
| 2026-09-09 | Console refused every sign-in as *"cross-site request"* | Medium | **Resolved** — see below |
| 2026-09-09 | A suspended shop's operators could still sign in | **High** | **Resolved** — see below |
| 2026-09-09 | `migration-008.test.ts` failed after migration 018 was added | Low | **Resolved — the test was right** — see below |
| 2026-09-09 | Console sign-in refused as cross-site **again**, from a browser | **High** | **Resolved — different cause from the first one** — see below |
| 2026-09-09 | `TRAINING_TRANSFER_POLICY` imported from the wrong package | Low | **Resolved** — see below |
| 2026-09-09 | **A newly registered shop could never sign in** | **High** | **Resolved** — see below |
| 2026-09-10 | §14.1 described a transition the code refused | Medium | **Resolved — and the first fix was also wrong** — see below |
| 2026-09-10 | An approved reversal never settled | **High** | **Resolved** — D152 |
| 2026-08-19 | [[Source Specification Clipped In PDF]] | Low | Resolved — assumptions recorded |

### 2026-09-09 — every console sign-in refused as cross-site

**Reported from a browser.** Signing in to the operations console answered
*"Not permitted — Refused: cross-site request."* No sign-in was possible.

**Two bugs in one check**, both in `originOk` in
`apps/operations-console/src/server.ts`, and the first hid the second.

1. **The host was read by splitting on a colon.** `new URL(origin).host.split(':')[0]`
   takes the part before the port — but an IPv6 address is made of colons, so
   `http://[::1]:4800` yielded `"["`. Every request from an IPv6 loopback origin
   was refused.
2. **`hostname` alone did not fix it.** It keeps the brackets a URL writes an
   IPv6 literal with — `"[::1]"`, not `"::1"` — while an allow-list, a
   `--allowed-hosts` flag and `isLoopback` all write it bare. Comparing the two
   forms still refused a host that had been explicitly allowed.

**Why it bit on Windows in particular:** browsers there commonly reach a local
server over IPv6 loopback, and `cli.ts` accepts `::1` as a bind host — so the
console served a page and then rejected every form posted back to it. The two
definitions of *"this machine"* disagreed.

**Fixed** by reading `hostname` and comparing with brackets stripped from both
sides, and by adding `::1` to the default allow-list so binding and accepting
agree. **The policy is unchanged** — `09 Engineering/TLS and Proxy
Configuration` says Telga answers only for the hosts it was told about, and it
still does; an unparseable origin, including the literal `null` a sandboxed
context sends, is still refused.

**Pinned by tests** in `tests/admin/console-deployment.test.ts`: all four ways a
browser can name this machine are accepted, a foreign origin and `null` are
still refused, and a form post with no `Origin` header still works.

### 2026-09-09 — a suspended shop's operators could still sign in

**Found while writing [[Vendor Registration]]**, not by a report. The founder's rule was
*"login blocked until that shop's status = ACTIVE"*, and checking whether the code did that
showed it did not.

**What was wrong.** `signIn` read `merchant_users.status` and **never** `merchants.status`. So
suspending a shop in the operations console wrote the merchant row and stopped nothing at the
door. `authenticate` had the same gap for sessions already open.

**Why it was not obvious.** The suspension was *partly* effective, which is the worst kind of
partly. `createSale` refuses `MERCHANT_NOT_ACTIVE` and always has, so a suspended shop **could
not sell** — the headline behaviour looked right. What still worked was signing in, opening the
dashboard, reading transaction history and holding a live session indefinitely. Anyone testing
"does suspension stop trading?" would have seen a pass.

**The tell was already in the codebase.** The console's device-stop route revokes sessions and
says why:

> *"a stopped device that kept a live session would still be usable, which is the opposite of
> stopped"*

That reasoning applies one level up, to a shop, and had not been applied there.

**Fixed** in `services/api/src/auth/sessions.ts`: `signIn` now refuses `MERCHANT_NOT_ACTIVE`
after checking the operator and before checking the device — so a suspended shop still costs an
attacker a device check before anything is disclosed, and the audit trail names the operator who
tried. `authenticate` revokes the session outright on the next request, so suspension takes
effect immediately rather than at the next voluntary sign-out. `MERCHANT_NOT_ACTIVE` is its own
failure code, distinct from `USER_SUSPENDED`, because the remedies differ: one operator is
reinstated by Telga staff, a suspended shop is a conversation about the shop.

**Pinned by** a test in `tests/admin/vendor-registration.test.ts` that signs in, suspends the
merchant underneath the live session, and asserts the next request is refused.

**Recorded as** [[Risk Register]] **R40** and [[Decision Log]] **D138**.

> [!tip] Recommendation — **carried out 2026-09-10**
> **Audit the other status columns the same way.** This bug's shape is *"a status is written in
> one place and read in another, and one reader was missed."* The same shape is available for
> `devices.status`, `tenant_registry.status` and the merchant lifecycle states. A test that
> suspends each entity and asserts every entry point refuses would catch the class, not just
> this instance.
>
> **Done:** `tests/auth/status-gates.test.ts` maps every status column to every door it is read
> at, and the map is in the file header so a new `CHECK` value forces somebody to say what it
> means. It found a third instance immediately — **R46**, a remotely stopped device that can
> still sign in — which is what the recommendation was for.

### 2026-09-09 — `migration-008.test.ts` failed after migration 018 was added

**Not a defect. The test did exactly what it exists to do**, and the entry is here because a
failing test that is *supposed* to fail is easy to "fix" wrongly by deleting the assertion.

**What happened.** Adding migration 018 (`registration_attempts`, and
`merchant_applications.submitted_via`) failed one assertion in `tests/persistence/migration-008.test.ts`:

```
- "provider_health_events",
+ "registration_attempts",
  "settings",
```

**Why the test is written that way.** It applies *every* pending migration to a database seeded
at 007 and asserts the exact list of tables that appear. Its own comment says why:

> *"this list grows as migrations are added — and that is the point: an unexpected new table
> fails here rather than appearing unnoticed."*

So the failure is the guard reporting a new table, which is the correct outcome for a change that
adds one.

**The wrong fix**, and it is the tempting one: relaxing the assertion to `toContain`, or sorting
and comparing loosely. That would turn a ledger of the schema into a smoke test and let the next
unintended table through silently.

**The right fix**, applied: add `registration_attempts` to the expected list, and add the
migration to the comment's inventory — including the note that `submitted_via` is a **column**
and therefore invisible to this guard, which is why migration-015 asserts its column directly.

**Standing rule this reinforces:** when this test fails, the question is *"did I mean to add that
table?"* — never *"how do I make this pass?"*

> [!tip] Recommendation
> **Columns are not covered by this guard**, and three migrations have now added one
> (`must_change_pin`, `deposit_lookup`, `submitted_via`). Only the first has a direct assertion.
> A companion guard over column lists would close the gap. Recorded here rather than done,
> because it is a test-design change and belongs with [[Testing Strategy]].

### 2026-09-09 — console sign-in refused as cross-site, the second cause

**Reported from a browser, with the same words as the first one**: *"Not
permitted — Refused: cross-site request."* The IPv6 fix earlier that day was
real and is still in place. This was a **different bug wearing the same
message**, and it is the more interesting of the two.

#### What it was

`Referrer-Policy: no-referrer`.

That header does not only strip the `Referer`. When the referrer policy
suppresses the referrer, a browser serialises the **`Origin` header of a form
POST as the literal `null`**. `originOk` then compared `null` against the
allow-list, failed, and refused — *a page rejecting a form it had served itself,
one keystroke earlier, on the same origin.*

The console's own code had a comment describing exactly this value and calling
it an attack:

> *"An unparseable origin, including the literal `null` a browser sends from a
> sandboxed or redirected context. Refused."*

Half right. A sandboxed iframe does send `null` and must stay refused. So does an
ordinary sign-in form under a header the console was setting on every response.

#### Why nothing caught it

**Everything that is not a browser sends a real `Origin`.** `curl`, Node, and
every test in `console-deployment.test.ts` construct the header by hand, so all
of them sailed through. The suite even asserted that `null` must be refused —
it had encoded the bug as the intended behaviour.

It was found by reproducing the round trip properly rather than by reading the
check again: serve the page, read the headers the server actually sends, and
post as the browser would.

#### The fix, in two parts

1. **Remove the cause.** `Referrer-Policy: same-origin`, on the console and on
   the merchant app. The privacy property that mattered is unchanged — no
   referrer leaves the origin, so no admin URL reaches a third party — while a
   same-origin navigation keeps the header the CSRF check depends on.
2. **Stop refusing an opaque origin blindly.** `null` is now judged on
   `Sec-Fetch-Site`, which the **browser** sets and script cannot reach, so a
   cross-site page cannot forge it. `same-origin` and `none` are accepted;
   `cross-site`, `same-site`, and *no header at all* are refused. A redirect, an
   embedded WebView or a future policy change can produce an opaque origin
   again, and the failure mode is a locked-out administrator.

#### What this revealed about the merchant app

The POS never showed the symptom because `checkOrigin` lets `null` through
**unconditionally** — a blanket allowance that also admits a sandboxed iframe.
That is a real if minor CSRF weakness, and it is **not tightened in this
change**: removing the referrer-policy cause means browsers stop sending `null`
to it at all, which makes the allowance mostly dead code and makes tightening it
later a low-risk edit that can be tested on real hardware. Tightening a deployed
merchant sign-in path blind, in the same change that fixes the console, is the
wrong order of operations. Recorded as [[Risk Register]] **R43**.

> [!tip] Recommendation
> **When a check refuses, test it through the thing that will actually call
> it.** Both console cross-site bugs shared one shape: a header or a parse that
> was correct against a hand-built request and wrong against a browser. A
> hand-built request is a model of a browser, and both times the model was the
> thing that was broken. The new tests now include the header the server sends
> as an assertion, not just the behaviour it produces.

### 2026-09-09 — a value imported from the package that does not own it

**Small, and worth the note because of what it says about layering.**
`shop-transfer.test.ts` imported `TRAINING_TRANSFER_POLICY` from `@telga/api`
alongside `settleShopTransfer`. It comes from `@telga/domain`. The import
resolved to `undefined` and three tests failed with
`Cannot read properties of undefined`.

**The fix is one line and the reason is the interesting part.** The policy is a
**rule** — limits and pricing — and rules live in the domain package. The api
package *applies* them. Importing it from `api` worked syntactically because
`api` re-exports plenty, and would have kept working if `api` had happened to
re-export the domain too. It failed loudly instead, which is the better outcome:
a policy reachable from two packages is a policy that will eventually differ
between them.

> [!tip] Recommendation
> **When an import fails to resolve, ask which package *owns* the value before
> reaching for a different import path.** The failure named a missing export;
> the actual finding was a layering question. Adding a domain re-export to
> `@telga/api` would have made this test pass and made the boundary meaningless.

### 2026-09-09 — the column guard the runbook asked for

**Not an incident. A recommendation from this log, carried out.**

The write-up on `migration-008.test.ts` ended:

> *"Columns are not covered by this guard, and three migrations have now added
> one (`must_change_pin`, `deposit_lookup`, `submitted_via`). Only the first has
> a direct assertion. A companion guard over column lists would close the gap."*

`tests/persistence/schema-columns.test.ts` closes it. It pins every column of
the tables it covers, names the three that earlier migrations added quietly, and
asserts the vocabulary `ledger_entries` is read through — a rename there would
be silent everywhere until a total came out wrong.

It pins **columns only**, not types or constraints: those belong to the
migration that declares them, and duplicating them would make every `CHECK`
widening a two-file edit for no extra safety.

**How to read a failure:** *"did I mean to change that?"* — never *"how do I make
this pass?"* A dropped column is the one that loses data.

### 2026-09-09 — a newly registered shop could never sign in

**The worst bug of the day, and one this session introduced.** Nobody reported
it: an end-to-end test found it before the founder's acceptance round did.

#### What it was

`provisioningPorts.ts` creates a merchant as **`ONBOARDING`** — correct, and
deliberate: the shop exists and has no operator, no device and no key, so it
cannot trade. **Nothing then moved it to `ACTIVE`.**

Earlier the same day, `signIn` gained a check refusing any merchant whose status
is not `ACTIVE` — closing a real hole where a *suspended* shop's operators kept
signing in (R40). The two together meant:

> register → approve → issue sign-in parameters → **first sign-in refused**

with a message about the shop not being active, for a shop that had just been
created. The founder's entire acceptance plan runs through that path.

#### Why nothing caught it

**Every unit passed.** Provisioning did the right thing. The sign-in check did
the right thing. `issueCredentials` did the right thing. The bug lived in the
*seam* between them, and no unit test can see a seam.

That is the whole argument for `tests/e2e/shop-onboarding-chain.test.ts`, which
walks register → approve → issue → status rather than testing each link. It is
the third seam failure in this repository — after the console refusing its own
sign-in form and `/deposits` answering 404 because a port was never supplied —
and the first one caught before a person hit it.

#### The fix

A shop becomes `ACTIVE` when its **credentials are issued**, inside the same
transaction.

**Not at approval**, which would make a shop active while it still has nothing
to sign in with. Issuing credentials is where it gets an operator, a device and
a key — which is exactly what "able to trade" means.

`WHERE status = 'ONBOARDING'` guards it, so re-issuing credentials to a
**suspended** shop cannot quietly reinstate it. Reinstating is a deliberate act
with its own control and its own audit event.

> [!tip] Recommendation
> **A status column that is written in one place and read in another needs a
> test that walks between them.** This is the same shape as R40, one level
> along: there, a status was written and never read; here, a status was read and
> never written. The standing recommendation to *"audit the other status
> columns"* — `devices.status`, `tenant_registry.status`, the merchant
> lifecycle — is now overdue, and this is the second bug from that family.

### 2026-09-10 — a transition the specification described and the code refused

**Not reported. Found while wiring reversal settlement.**

`CLAUDE.md` §14.1 was written on 2026-09-09 and describes the one way out of
`SUCCESSFUL`:

> `SUCCESSFUL --> REVERSAL_REQUIRED: token proven UNREDEEMED, within the window`

`VALID_TRANSITIONS` still read `SUCCESSFUL: Object.freeze([])`. **The flow the
authoritative file described was impossible.** Anything built against it would
have failed at the transition, and the specification would have looked right.

**This is D137's failure with the arrow reversed.** There, the mechanism was
built and the documentation described none of it — *"the documentation was
behind the code, which is the failure mode where somebody later fixes a
deliberate refusal."* Here the documentation ran ahead. Both end the same way:
somebody trusts a statement that is not true of the system.

#### The first fix was also wrong

I implemented the transition — added `SUCCESSFUL: ['REVERSAL_REQUIRED']` — and
the exhaustive terminal test failed immediately: `SUCCESSFUL` is in
`TERMINAL_STATES`, so it was now **non-terminal in one place and terminal in
another**. Two facts about one state, disagreeing.

Chasing that further would have meant removing `SUCCESSFUL` from
`TERMINAL_STATES`, which drives `blocksRetry` and keeps the recovery worker
away from settled sales. Both would have been damaged to make a diagram true.

**The diagram was what was wrong.** A settled sale *is* terminal. Returning its
value is an **authorised correction** under §13 invariant 8 — a compensating
credit posted with a supervisor's authorisation — not a step the state machine
offers to any caller. §14.1 now says that, and the table is unchanged.

So this entry records two mistakes, both mine: a specification written ahead of
the code, and then a fix aimed at the code when the specification was the thing
in error.

> [!tip] Recommendation
> **When code and specification disagree, establish which one is right before
> changing either.** The reflex is to make the code match the document, and here
> that reflex was wrong — the document described a model that would have broken
> two other guarantees. The exhaustive terminal test is what said so, which is
> the argument for having tests that assert *properties of the whole table*
> rather than individual transitions.
>
> **And: a specification change describing a state machine should land with the
> table in the same commit.** §14.1 and `VALID_TRANSITIONS` are one fact written
> twice and nothing reconciles them — unlike the feature-flag and string tables,
> which have reconciliation tests and would have caught this on day one.

### 2026-09-10 — a pattern in my own failures, written down

Six defects in two days were **introduced by me**, not inherited. They are
already logged individually above and in the register; what follows is what they
have in common, because the shape is more useful than the list.

| What I did | Where |
|---|---|
| Claimed a stopped device could sign back in — read the reader's inputs, never the writer | **R46**, withdrawn |
| Fixed R46 by adding a broad check *before* a narrow one, masking two precise refusals | device-binding tests |
| Added a sign-in check on `merchants.status` without checking what writes it — every new shop locked out | **R45** |
| Wrote §14.1 describing a transition, and never implemented it | this entry |
| Then "fixed" it in the code, when the specification was what was wrong | this entry |
| Left `APPROVED` in a decide clause, letting an approved reversal be flipped afterwards | D151 |

**Two habits produce all six.**

**Inferring instead of verifying.** R46 and R45 are the same mistake in opposite
directions: I read one side of a status column and reasoned about the other.
Both times the answer was one `grep` away, and both times I was *running an audit
whose entire purpose was to walk between writer and reader*.

**Writing a specification and treating it as evidence.** §14.1 was mine. Having
written it, I then trusted it over the code — twice, first by not implementing
it and then by implementing it wrongly rather than questioning it.

> [!tip] Recommendation
> **Before claiming a control does not work, read the code that writes it, not
> only the code that reads it.** Every one of these would have been caught by
> that single step, and it is cheaper than any of the fixes was.
>
> **Treat a document I wrote as a claim, not as evidence.** A specification is
> only as good as the last time somebody checked it against the system — and if
> I wrote it, I have not checked it, I have asserted it.

### 2026-09-10 — the vault told the founder four things that were not true

**Not reported by a test. Found by the founder reading the vault**, which is the
part that matters: *"i cant scan check manualy, use full scan and find out fix
issues."*

They quoted `⚠️ Written, **not exported**` beside `provisioning.ts` — exported
and called from two sites — and a list of "four gaps" of which three were closed.

A full scan found **nine** claims of that shape. Verified one at a time against
the code:

| Claim | Verdict |
|---|---|
| `provisioning.ts` not exported | Stale — exported, two callers |
| No route suspends or deactivates a shop | Stale — merchants, devices and operators all have suspend/reinstate |
| Monitoring is "counts only, no volume" | Stale — `/activity` computes volume |
| No application can be submitted | Stale — `/register` |
| Approval never calls `provisionMerchant()` | Stale — it does |
| No route redeems an activation code | Stale — `/activate` |
| No `must_change_pin` flag exists | Stale — migration 015, set and read |
| POS "trusts a `merchantId` in the URL" | **Stale and dangerous** |
| `tenantRouting.ts` has no callers | **True, and deliberate** — D120 |

The eighth is the one worth dwelling on. `04 UX UI/Merchant POS Screens.md`
stated the POS was **not a security boundary** and took the merchant id from the
URL. It has not for a long time: the id is session-derived, and isolation is
tested against a live server including URL and body tampering.

**A stale note claiming a security hole is worse than one claiming a missing
feature.** It invites somebody to "fix" a boundary that exists, or to treat a
sound deployment as unsafe.

> [!tip] Recommendation
> **A vault cannot be kept honest by re-reading it.** Nine stale claims
> accumulated across 124 notes, two of them already carrying earlier
> "corrections" that were themselves out of date by the time anybody looked.
> Every previous attempt at this was a human re-read, and every one decayed.
>
> `tests/docs/vault-claims.test.ts` now checks the **one claim that is
> mechanically decidable**: a note saying a route does not exist while that
> route is served. It reads the route table out of both servers and fails with
> the file and line.
>
> **What it deliberately does not do** is police prose. Design intent, deferred
> decisions and genuinely unbuilt things are left alone, and append-only records
> — the Decision Log, these Runbooks, the Risk Register — are exempt by name,
> because their value is saying what was true *then*. Forcing history to match
> the present would be the worse failure.
>
> The same shape as the feature-flag, string and migration-ledger reconciliations
> that already exist. It should have been written the first time a status table
> went stale.

### 2026-09-11 — a permission that guarded nothing was stranding deposits

**Not reported, and no test would have caught it.** Every test passed; the
feature was simply absent, and an absent feature has no failing assertion.

Found by asking a different question: *which declared admin permissions guard
no route?* Thirteen did. Four are deliberate — `ADMIN_VIEW_TRANSACTION` and
`ADMIN_REPRINT_RECEIPT` are switched off by D144 and §23.2 on purpose. Nine
were gaps, and one of them held money.

`ADMIN_SECOND_APPROVE_FUNDING`. §20 requires a second approval for a
high-value deposit. `recordDeposit` stored one as `MATCHED`, the deposits
screen counted it — *"N waiting for a decision"* — and **nothing in the system
could make that decision.** A shop that paid in more than the cap had its money
sit in a row: no error, no complaint path, no balance, no way for anybody to
notice except the shop ringing up to ask.

Two more absences found the same way: the console had **no rate limiting at
all**, and the session idle window was one minute, which expired between
reading a screen and pressing the button on it.

> [!tip] Recommendation
> **A permission that guards no route is a feature that was specified and never
> built.** It is a cheap query and it found a money-stranding gap that every
> test in the suite agreed was fine. Worth running whenever a permission table
> and a router drift apart — which is whenever either is edited.
>
> **The shape to watch for: a screen that counts something it cannot act on.**
> The deposits screen displayed the number of waiting rows, which looks like
> working software and is the strongest possible signal that an action is
> missing. A count with no verb beside it deserves suspicion.

### 2026-09-11 — the comment that caused the bug it explained

While raising the idle window, the test that refuses any six-digit run in a
rendered page began to fail. `15 * 60_000` is `900000` — six digits, and
indistinguishable from a PIN to a guard that cannot know which numbers are
innocent.

**The guard was right and stayed untouched.** A version that could tell a safe
six-digit number from a PIN is a version that misses a real one, so the page
stopped emitting six-digit numbers instead: the idle window is now published in
seconds, which is also the unit the shop's own lock setting uses.

Then the comment explaining that fix — written inside the client script —
**shipped to the browser containing the offending number**, and the guard fired
again on the explanation.

> [!tip] Recommendation
> **Comments inside the client-script template literal are published.** They
> are not source-only: they reach every browser, they count toward anything
> that inspects the page, and they cannot contain backticks either. Two
> separate bugs in that one literal now — this, and the backtick that ends the
> literal mid-parse. Anything written there is code that ships.

> [!warning] A third time, 2026-09-12
> A new guard on `cli.ts` — added to stop a float round-trip returning to the
> console's money ports — failed on its **own** explanatory comment, which
> quoted the expression it forbids. The lesson above now has three instances,
> so treat it as a rule rather than a curiosity: **a source-level guard must
> strip comments before it matches**, because the place a forbidden pattern is
> most likely to be written down is the note warning against it.
> See [[Console Money Ports Incident]].

## Related

- [[Console Money Ports Incident]]
- [[Provider Health]]
- [[Support and Disputes]]
- [[Incident]]
- [[Risk Register]]

---
Back to [[00 Home]]
