---
title: Console Money Ports Incident
type: operations
status: draft
owner: telga
created: 2026-09-12
updated: 2026-09-12
tags:
  - telga
  - operations
  - runbook
  - incident
  - ledger
related:
  - "[[00 Home]]"
  - "[[Runbooks]]"
  - "[[Ledger Invariants]]"
  - "[[Admin Operations Console]]"
  - "[[Funding Verification]]"
  - "[[Decision Log]]"
depends_on:
  - "[[Ledger Invariants]]"
validates:
  - "[[Ledger Invariants]]"
decision_status: accepted
---

# Console Money Ports Incident

**2026-09-12.** Every money-moving control in the operations console refused any
amount that was not a whole number of birr, and said only that the operation
"could not be posted".

## What was reported

The founder, after the first deployment against `telga.pro`:

> *"Shop-to-shop transfer: I sent an amount from one shop to another yesterday,
> and it still hasn't arrived on the receiving shop, even though the device key
> matches."*

The first cause was a missing control: a transfer above the approval threshold
is stored `NEEDS_APPROVAL` with no ledger entry, and **no console route read
`shop_transfers` at all**. `listTransferQueue` had existed since migration 019
with no caller. That is the same shape as the stranded high-value deposit found
two days earlier, and both were found by asking which declared capability
nothing exercises.

This note is about the **second** cause, found while testing the fix.

## The defect

`apps/operations-console/src/cli.ts` built the ports that move money. Each read:

```ts
amount: fromBirr(input.amountMinor / 100)
```

`fromBirr` takes **whole birr** and refuses anything else deliberately — *"there
is no float path into Money by design"*. So 1 500.50 birr arrived as
`fromBirr(1500.5)` and threw `InvalidMoneyError`. The route caught it, rolled
back, and reported *"could not be posted"*.

Four call sites, all of them a control that moves money:

| Port | What failed |
|---|---|
| `postTransfer` — amount | A shop-to-shop transfer of anything but a round figure |
| `postTransfer` — fee | Any fee in santim |
| `postReversal` | Returning the value of a sale priced in santim |
| `creditMerchant` | **Approving a bank deposit** whose statement figure carried santim |

The last is the widest: §20.1 says the *bank's* figure wins, and a bank's figure
is whatever the customer actually paid.

## Why it survived

Every test passed. The ledger was never wrong — `postShopTransfer` and
`fundMerchant` take `Money` and had always handled santim correctly. The defect
lived in the **conversion at the boundary**, on a line no test crossed, because
the console tests stub these ports and the ledger tests call the operations
directly. Nothing exercised the seam between them.

This is the third time in this project that a thing was tested at both ends and
broken in the join.

## The fix

Stop converting. Every value crossing that boundary is **already minor units**,
so it goes to `money(minor)` unchanged. §13 invariant 9 — *"money uses integer
minor units, never binary floating point"* — was the rule the round-trip broke,
and the fix is to obey it rather than to widen `fromBirr`.

## How it is held

- `tests/persistence/shop-transfer-ledger.test.ts` — 1 500.50 birr lands to the
  santim, a single santim moves, the posting balances, a fee is charged to the
  sender only.
- A source guard in the same file fails if `fromBirr(… / 100)` returns to any
  console port. It **strips comments before matching**: on its first run it
  matched the explanatory comment above the ports and failed on its own
  documentation, which is the third guard in this repository to do that.
- `tests/admin/transfer-approval.test.ts` — 6 tests over HTTP against the real
  console: approving posts both sides once and settles, a replay is refused with
  one posting not two, refusing moves nothing and demands a reason, and an
  unauthenticated caller changes neither row nor money.

## If it recurs

A console control that reports *"could not be posted"* with nothing in the log
is almost always an exception inside a port, not a database problem. The route
writes the real error to stderr — `[telga-console]` — before it redirects. Read
that line before anything else; the message shown to the operator is
deliberately vague and will not tell you which of the four facts failed.

## What to watch

Any transfer, reversal or deposit attempted before 2026-09-12 that carried
santim was **refused, not half-applied** — the route rolls back and posts
nothing, so no ledger repair is needed. The rows are still in their pre-decision
status and can simply be decided again.
