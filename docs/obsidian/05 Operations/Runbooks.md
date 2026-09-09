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

> [!tip] Recommendation
> **Audit the other status columns the same way.** This bug's shape is *"a status is written in
> one place and read in another, and one reader was missed."* The same shape is available for
> `devices.status`, `tenant_registry.status` and the merchant lifecycle states. A test that
> suspends each entity and asserts every entry point refuses would catch the class, not just
> this instance. Not done — it is a piece of work, not a patch.

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

## Related

- [[Provider Health]]
- [[Support and Disputes]]
- [[Incident]]
- [[Risk Register]]

---
Back to [[00 Home]]
