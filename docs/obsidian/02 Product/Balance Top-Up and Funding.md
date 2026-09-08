---
title: Balance Top-Up and Funding
type: product
status: draft
owner: product-strategist
created: 2026-09-08
updated: 2026-09-08
tags:
  - telga
  - product
  - operations
  - funding
related:
  - "[[00 Home]]"
  - "[[Funding Verification]]"
  - "[[Balance Model]]"
  - "[[Feature Flags]]"
  - "[[Product Scope]]"
  - "[[Launch Gates]]"
depends_on:
  - "[[Launch Gates]]"
  - "[[Decision Log]]"
validates:
  - "[[Ledger Invariants]]"
decision_status: proposed
---

# Balance Top-Up and Funding

> [!question] The question this note exists to answer
> *"After the balance is finished, where is the balance going to be added?"*
>
> It is the right question, it was asked by the founder, and until now the vault
> answered it only in fragments spread across [[Funding Verification]],
> [[Feature Flags]] and three decisions. This note is the single place.

## The short answer

**A merchant does not top up their own float by swiping a card at their own
counter.** They pay money into a bank account, and Telga credits the float after
an operator has verified it against the bank record. That is
[[Funding Verification]], it is already designed, and it is **launch gate 6**.

Telga Pay is not that mechanism and never was. The two got confused because they
share a menu.

## What Telga Pay actually is

> [!danger] Telga Pay is a drawing of a card terminal
> `apps/merchant-pos/src/ui/telgaPay.ts`, first paragraph:
>
> > *"Every screen here is UI-only: nothing in this file writes to the database,
> > calls a provider, or reaches the ledger."*
>
> No card number is collected — *"no card data exists to leak, since none is ever
> collected."* State passes between screens in the URL query string. Nothing
> reaches a card network, a processor or a bank.

So **switching `card.simulated` back on would not add one birr of top-up
capability.** It would restore a picture of a terminal, plus the entry point to
one screen that credits a *simulated* float with no counterparty.

If Telga Pay ever *did* take a customer's card for real, that is
`payments.acceptance` — which needs an acquirer, a licence, and CLAUDE.md §8's
gates. It is off for that reason, not by oversight.

## The three tiers, and which one is real

| Tier | Mechanism | Money | Status |
|---|---|---|---|
| **1. CLI float** | `provision --training-float`, `fundMerchant` | Simulated | **In use today.** D113(c) |
| **2. In-app training deposit** | `/pay/deposit` → `POST /api/training/pay/deposits` | Simulated | **Built, unreachable.** A100 |
| **3. Funding submission** | Bank deposit → operator verification → credit | **Real** | **Not built.** Gate 6 |

### Tier 1 — what the shop runs on now

`apps/merchant-pos/src/cli.ts` credits an opening balance through `fundMerchant`,
a balanced append-only posting against `BANK_CLEARING`. It requires shell access
to the machine holding the database. That is a deliberate barrier and an
auditable one, but it means **the merchant cannot top up without the founder**,
which does not survive contact with a second shop.

### Tier 2 — built, and switched off by accident of layout

`services/api/src/application/deposits.ts` is sound: it refuses any mode but
`TRAINING` before it reads an amount, bounds the credit to 10–50,000 birr, posts
through the same balanced entry as Tier 1, audits `TRAINING_DEPOSIT_CREDITED`,
and imports no HTTP client and no provider.

Its flag, `deposits.training`, is **on**. Its endpoint has its own route entry.
The only thing wrong is **where its screen lives**: `/pay/deposit`, inside the
tree `card.simulated` refuses. D112 said so plainly and left it as a separate
decision:

> *"If in-app top-up is wanted during training, the screen must be moved out of
> `/pay` — a separate decision, not done here."*

This is the smallest useful piece of work on the whole roadmap.

### Tier 3 — the one that answers the founder's question for real

[[Funding Verification]] already carries the full state machine:

`SUBMITTED` → `AWAITING_VERIFICATION` → `MATCHED` → `CREDITED`, with `REJECTED`,
`DUPLICATE` and `MANUAL_REVIEW` as the other exits, a second approval for
high-value deposits, and daily reconciliation by a **separate** reviewer.

Its absolute rules restate CLAUDE.md §20: **no overdraft, no personal account,
no screenshot-only credit, segregated accounts.**

The schema exists. The state machine is drawn. **The workflow is not written.**

## Why building Tier 3 in training mode is the correct next project

> [!important] It is launch gate 6
> *"Funding and reconciliation tested"* is one of the ten gates in CLAUDE.md §8,
> and `GATES_CLEARED` is empty. Of the ten, only two are engineering work rather
> than paperwork or legal review: **gate 6** and **gate 10** (backups and
> recovery, which now has evidence — R31).
>
> Building the funding workflow against simulated money is not a detour from
> launch. It is one of the two things engineering can do that moves a gate.

Three further reasons:

1. **The shape is identical live and in training.** A deposit claim, a verifier,
   a matched bank reference, a credit. Only the flag and the realness of the
   bank record change. Nothing built now is thrown away.
2. **The parts already exist.** `fundMerchant`, the append-only ledger, the
   audit event, [[Balance Model]]'s available/reserved split, and the operations
   console's approval screens. This is wiring, not invention.
3. **It forces the segregation question early**, while it is cheap. Which
   account, whose name, who verifies, who reconciles — [[Legal Questions]] and
   [[Funding Verification]] both need answers that only the founder can give,
   and it is better to need them now than the week before a pilot.

## What must not be claimed

- That Telga Pay is a payment system, a card terminal, or a way to add funds.
- That any deposit in the current build involves real money.
- That gate 6 is cleared. **Building the workflow does not clear it** — clearing
  it needs the workflow *plus* an approved funds structure *plus* a tested
  reconciliation, and the structure is NOT YET CONFIRMED.
- That a merchant may be given a bank account to pay into. No such account is
  approved.

## Related

- [[Funding Verification]] — the state machine and the separation of duties
- [[Balance Model]] — what available, reserved and under-review mean
- [[Feature Flags]] — why `deposits.training` and `funding.submission` are different flags
- [[Launch Gates]] — gate 6, and the nine others
- [[Decision Log]] — D70, D87, D112, D113, D117
- [[Product Scope]] — what the first live release contains
