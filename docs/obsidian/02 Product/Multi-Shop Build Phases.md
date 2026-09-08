---
title: Multi-Shop Build Phases
type: product
status: draft
owner: product-strategist
created: 2026-09-08
updated: 2026-09-08
tags:
  - telga
  - product
  - roadmap
related:
  - "[[00 Home]]"
  - "[[Multi-Tenant Architecture Proposal]]"
  - "[[Multi-Shop Onboarding]]"
  - "[[Admin Operations Console]]"
  - "[[Deposit Rail Options]]"
  - "[[Balance Top-Up and Funding]]"
depends_on:
  - "[[Decision Log]]"
  - "[[Launch Gates]]"
decision_status: proposed
---

# Multi-Shop Build Phases

The founder's multi-shop specification of 2026-09-08, turned into numbered
phases. **Each is independently approvable, independently testable, and ordered
so that shop #1 keeps working throughout.**

> [!info] Naming
> `M1`…`M9` — "M" for multi-shop, to avoid colliding with the earlier `B1`–`B8`
> series.

## The rule every phase obeys

Shop #1 keeps its merchant id, device key, operator, balance and history.
**Additive migrations only.** The isolation suite runs before and after every
phase, so *"shop 1 still works"* is a test result rather than a hope.

## Phase table

| # | Phase | Touches the deployment? | Depends on |
|---|---|---|---|
| **M0** | Telga Pay restored | ✅ Yes — **done**, D124 | — |
| **M1a** | Register Telga User — the form and route | No (console only) | ✅ **done**, D126 |
| **M1b** | Document images, encrypted (R37) | No (console only) | ✅ **done**, D127 |
| **M2** | Credential issue and hand-over | No (console only) | ✅ **done**, D128 |
| **M3a** | Deposit matching and credit (engine) | No (console only) | ✅ **done**, D130 |
| **M3b** | Deposit queue and record form (console) | No (console only) | ✅ **done**, D131 |
| **M3c** | The shop's own deposit reference, on the POS | Yes (POS screen) | M3b |
| **M4** | Shop control — suspend, reinstate, device stop | No (console only) | ✅ **done**, D132 |
| **M5** | Aggregates and alerts | No (console only) | ✅ **done**, D132 |
| **M6** | Deploy the console | Yes (new service) | M1–M5 |
| **M7** | Android self-registration | Yes (POS route) | M1, M6 |
| **M8** | Storage for 10,000 shops | Yes (major) | evidence |
| **M9** | Real money | Gated | all ten gates |

---

> [!important] What comes next — D134
> **Everything built in M0–M5 runs only on the founder's laptop.** The
> operations console is loopback-only by design, and is not started by
> `railway-start.mjs`. Registering a shop, issuing its parameters, recording a
> deposit and watching the balance move are all real, tested, and **unreachable
> from anywhere but one machine**.
>
> So the next step is **M6 — deploy the console**, because until it is deployed
> none of the rest can be used by anybody.
>
> Alongside it, two things that cost a decision rather than engineering:
>
> 1. **Assign the owners.** Seven rows in [[Founders and Roles]] read NOT
>    ASSIGNED. That one decision blocks gates 6, 8, 9, 10 and both `money.live`
>    keys, and it costs nothing.
> 2. **Settle the stored-value question** before building more money features —
>    see [[Multi-Tenant Architecture Proposal]] §6.
>
> **The backup schedule was ranked first and should not have been** — see the
> correction in D133. On a paid Hobby plan the volume is not deleted; the
> schedule is worth wiring, and it is not urgent.

> [!success] Every console-only phase is built
> **M0 through M5 are done.** What remains — M3c, M6, M7, M8, M9 — all touch the
> deployed POS, the deployment shape, or a launch gate, and each needs its own
> approval. Nothing below M5 can be reached by building more of the console.
>
> **The chain runs end to end today**, in one test: register a shop → review →
> approve → provision → issue four sign-in parameters → deposit quoting the
> device key → that shop's balance rises, and no other shop's moves.

## M0 — Telga Pay restored ✅ **DONE**

`card.simulated` on, `payments.acceptance` off. Recorded as **D124**. Restores
`/pay/deposit`, the only in-app way to credit a training float.

## M1 — "Register Telga User"

The admin form the founder specified: legal name, phone, business licence, TIN,
ID or passport, shop name, shop address. Submit → validate → provision.

**Already built:** the document table (migration 015), the intake validation
(`applicationIntake.ts`), and approve→provision (D120).
**To build:** the form, the route, and the field-list reconciliation in §Conflicts.

**Settled: images are stored** (D125). Migration 015's `document_uri` was
reserved for exactly this and is now claimed. So M1 splits:

| | | Touches deployment? |
|---|---|---|
| **M1a** | The form, the route, the seven fields, documents by **reference** | No |
| **M1b** | Image upload and encrypted storage, per **R37** | No |

M1a is buildable from what already exists — the document table, the intake
validation, and approve→provision. M1b is its own piece because handling
photographed identity documents well is a security task, not a form field:
encrypted at rest, on the volume and never in the repository or a log, access
behind step-up **and audited**, and a retention policy before shop #2.

> [!note] The seven fields versus migration 015's register
> The founder's form asks for legal name, phone, **business licence**, **TIN**,
> **ID or passport**, shop name, shop address. Migration 015's register also has
> `COMMERCIAL_REGISTRATION`, `PROOF_OF_ADDRESS` and `BANK_ACCOUNT_PROOF`.
> The founder's list is the one being built; the extra three stay available in
> the `CHECK` constraint as optional, because a `CHECK` is a migration to change
> and an unused enum value costs nothing. **Conflict 3 in the table below.**

## M2 — Credentials, issued and handed over

Generate and display **once**: Operator ID, Device ID, Device Key (43 chars),
temporary PIN. Sequential human-readable ids (`operator_0001`) as the founder
asked, with the unguessable secret kept in the key rather than the id.

**Already built:** `newToken(32)` → exactly 43 chars; PIN rules; `must_change_pin`;
activation-code redemption. **To build:** the issue screen and the "shown once"
hand-over page.

## M3 — Deposit and auto-credit

Shop deposits to Telga's account quoting a reference → system matches → the
shop's own balance is credited automatically.

**Already built:** the whole decision spine — `verifyDeposit()` cannot return a
credit without a bank record, credits the bank's figure, is idempotent on the
bank reference, and holds above-cap deposits for approval (D119).
**To build:** the reference on the shop's POS screen, the statement/webhook
importer, and the operations queue.

> [!danger] The reference must not be the device key
> The founder's spec says to use the Device Key as the bank reference. The device
> key is **one of four login credentials** (`credentialsOf()` requires `userId`,
> `pin`, `deviceId`, `deviceSecret`). On a deposit slip it reaches a teller, two
> paper copies, CBE's core system and every later statement — and A52 records
> that a copied key is indistinguishable from the original.
>
> **The Deposit Reference Code (D119) does exactly the same job**: it identifies
> the shop, auto-credits the right balance, and authorises nothing. The flow the
> founder described is unchanged; one string is different.

## M4 — Shop control

Suspend, reactivate, and stop new sales without deleting history (CLAUDE.md §18).

**Already built:** the lifecycle states and the tenant-status refusals.
**To build:** the routes that set them, each behind step-up re-authentication.

## M5 — Aggregates and alerts

Platform totals, per-shop performance, and alerts for low balance and unusual
activity.

**Already built:** per-shop balance and sale **count** on `/merchants` (D123),
which satisfies *"see performance, not transactions"*.
**To build:** platform totals, transaction volume, and the alert rules.

## M6 — Deploy the console

The console is loopback-only **by deliberate design** — it can suspend merchants
and create administrators. Making it reachable needs TLS, its own service, and a
decision about whether it faces the public internet at all.

**Not a coding task so much as a security decision.**

## M7 — Android self-registration

The founder's other path: a person registers from the phone, cannot sign in
until approved, and receives credentials by phone or email out of band.

**This matches [[Admin Operations Console]] Decision 3 exactly** — no account, no
credentials, no database until an admin approves. It lifts D113(b)'s deferral,
which should be an explicit decision rather than drift.

## M8 — Storage for 10,000 shops

**The recommendation changed when the number did.** For a handful of shops,
D118's shared SQLite was right. At 10,000 it is not:

| | 10 shops | 10,000 shops |
|---|---|---|
| Shared SQLite | Fine | **One writer.** Every sale queues |
| Per-shop SQLite (D103) | Fine | 10,000 files, 10,000 backups, migrations × 10,000 |
| PostgreSQL (D108) | Overkill | **The only one that survives** |

D108 is an async refactor across ~80 files and 21 `transaction()` call sites.
**It should be done on evidence — measured contention — not on a target number**,
and it must not be discovered as urgent after 200 shops are onboarded.

## M9 — Real money

All ten launch gates. Not an engineering phase.

---

## Conflicts to resolve before M1

| # | Conflict | Needs |
|---|---|---|
| 1 | ~~Document images~~ | ✅ **Settled — D125.** Store them, for fraud identification. Obligations recorded as **R37**: encrypted at rest, never in repo/log/unencrypted backup, access behind step-up and audited, retention policy before shop #2, never reachable from a merchant session |
| 2 | ~~Device Key as bank reference~~ | ✅ **Settled — D125.** Use the Device Key, as the founder specified. Accepted risk **R38**: it removes the device factor and leaves the operator id and PIN alone. `depositReference.ts` stays built and unused |
| 3 | **Founder's 7 fields** vs migration 015's 6 documents — no commercial registration, no proof of address, no bank proof in the founder's list | Reconcile the two lists |
| 4 | **Admin registers on-site** (this spec) vs **phone self-registration** (the founder's previous message) | Both, or one? M1 and M7 assume both |
| 5 | **"No individual transactions"** vs CLAUDE.md §17, which requires searching by transaction id to resolve a *"paid but no airtime"* complaint | Break-glass: step-up + recorded reason + audited |
| 6 | **Withdrawals** vs CLAUDE.md, which disables cash-in/out until legal review | Simulated in training; gated for real |
| 7 | **Face biometry** vs the console serving `script-src 'none'` | WebAuthn needs JavaScript. A real security trade |

## What must not be claimed

- That multi-shop onboarding works end to end. **No shop has ever been
  registered through the panel.**
- That the document list is legally sufficient. It is unreviewed.
- That 10,000 shops are supported. **Two have never run at once.**
- That any of this clears a launch gate. **0 of 10.**

## Related

- [[Multi-Tenant Architecture Proposal]] — the full evaluation and the KYB list
- [[Multi-Shop Onboarding]] — the four chain gaps and what closed them
- [[Deposit Rail Options]] — how a deposit could reach Telga at all
- [[Admin Operations Console]] — the four accepted decisions and seven roles

---
Back to [[00 Home]]
