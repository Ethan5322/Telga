---
title: Screen Inventory
type: ux
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - ux
  - screens
related:
  - "[[00 Home]]"
  - "[[Design System]]"
  - "[[User Journeys]]"
  - "[[Transaction State Machine]]"
  - "[[Merchant POS Screens]]"
  - "[[State To UI Mapping]]"
depends_on:
  - "[[Design System]]"
implements:
  - "[[Product Scope]]"
validates: []
decision_status: confirmed
---

# Screen Inventory

## The twenty-one required screens

| # | Screen | Primary action | Notes |
|---|---|---|---|
| 1 | Login / PIN | Sign in | Operator PIN on a registered device |
| 2 | Merchant home dashboard | Sell airtime | Shows the four balances and provider status |
| 3 | Airtime provider / network selection | Select network | Skipped if only one provider |
| 4 | Airtime amount selection | Select amount | Common denominations first, large targets |
| 5 | Recipient confirmation | Confirm number | Number shown large; re-entry to confirm |
| 6 | Sale confirmation | Confirm sale | Last point of no return; button disables on press |
| 7 | Processing | — | No retry control exists |
| 8 | Pending — "Do not retry yet" | — | Explicit block on retry |
| 9 | Success and receipt | Print receipt | Receipt per [[Receipt Specification]] |
| 10 | Failure | Return to home | States plainly that no charge was made |
| 11 | Under review | Contact support | Explains the funds are held, not lost |
| 12 | Balance summary | — | Available · reserved · under review · total |
| 13 | Transaction search | Search | By ID, receipt, time, amount, reference |
| 14 | Transaction details | Reprint receipt | Full state history and provider reference |
| 15 | Reprint receipt | Reprint | Marked as a reprint; **never a sale** |
| 16 | Provider unavailable | — | Airtime blocked only; other approved services stay live |
| 17 | Offline | — | History, settings, support remain available |
| 18 | Funding submission | Submit | **Simulated only** — [[Funding Verification]] |
| 19 | Merchant reports | — | Daily report, net commission |
| 20 | Support case | Raise case | [[Support and Disputes]] |
| 21 | Operations / admin review queue | Resolve | Internal; verification and under-review queues |

## The fourteen required states

**Every** operation must define all fourteen. A screen that handles only the first and the
successful one is not done — see [[Definition of Done]].

| State | What the merchant sees |
|---|---|
| Initial | The screen at rest |
| Loading | Work in progress, no action available |
| Empty | Nothing to show, and what to do about it |
| Validation error | Which field, and how to fix it |
| Provider unavailable | Which service is blocked, and that nothing was charged |
| Offline | Sales stopped; what still works |
| Processing | In flight, no retry |
| Pending | Outcome unknown, do not retry |
| Successful | Confirmed, with receipt |
| Failed | Confirmed failure, no charge |
| Under review | Held, escalated, funds protected |
| Reversal required | Being corrected by operations |
| Permission denied | This role cannot do this |
| Session expired | Re-authenticate; nothing was lost |

## Screen-to-state coverage

| Screen | States that must exist |
|---|---|
| Sale flow (3 → 9) | All fourteen |
| Balance summary | Initial, loading, empty, offline, session expired |
| Transaction search | Initial, loading, empty, validation error, offline, permission denied |
| Reprint | Initial, loading, failed (printer), permission denied |
| Funding submission | Initial, loading, validation error, offline, permission denied |
| Admin review queue | Initial, loading, empty, permission denied, session expired |

## What is built

Five of the twenty-one are implemented, in training mode only — see [[Merchant POS Screens]]:

| # | Screen | Built as |
|---|---|---|
| 2 | Merchant home dashboard | `/` |
| 1 | Login / PIN | `/login` — and it now carries the app's **second** option, *Register as Telga member* |
| — | Register as Telga member | `/register` — the applicant-facing form. Added by [[Decision Log]] D138; see [[Vendor Registration]] |
| — | Registration sent | `/register` on success — shows the reference number, and says plainly there is nothing to sign in to yet |
| 4–6 | Amount, recipient and confirmation | `/sell`, as one form |
| 7–8, 11–13 | Processing, pending, under review, failure, success | `/transactions/:id`, one screen driven by [[State To UI Mapping]] |
| 14–15 | Find transaction, details | `/transactions` and `/transactions/:id` |
| 21 | Review queue (merchant-facing part) | `/queue` |

Not built: provider selection, receipt printing and reprint, balance detail,
funding, verification queue, offline, support and reports.

> [!note] Two corrections to the line above — 2026-09-09
> **Login is built** (`/login`, with the four-parameter form and the operator PIN), and so is
> **the operations console**, which is its own application in `apps/operations-console/`. The
> "not built" list had not been revisited since those landed.
>
> The two **registration** screens are new with D138 and are numbered `—` because the founder's
> original twenty-one predates them: registration was named in `CLAUDE.md` §22 as a required
> screen and had never been designed. See [[Vendor Registration]].

## Screens that exist but are not reachable

Founder decision [[Decision Log]] **D112** switched off `card.simulated` and
`product.data`. The screens below are still in the source tree and still
render if called directly in a unit test, but **no route serves them** — every
path answers `404` with `FEATURE_DISABLED`, and nothing in the navigation links
to them.

| Screen | Path | Gated by |
|---|---|---|
| Telga Pay entry | `/pay` | `card.simulated` |
| Card present / authorize / result | `/pay/card`, `/pay/card/present`, `/pay/card/authorize`, `/pay/result` | `card.simulated` |
| Purchase, cash back | `/pay/purchase`, `/pay/cashback` | `card.simulated` |
| Training deposit and its slip | `/pay/deposit`, `/pay/deposit/slip` | `card.simulated` |
| Pay settings, statements, transactions | `/pay/settings`, `/pay/statements`, `/pay/transactions` | `card.simulated` |
| Data voucher categories | `/vouchers/data` | `product.data` |

**The deposit screen is the one to watch.** `deposits.training` is still on and
its endpoint still works, but its only screen lived under `/pay` — so in-app
top-up is currently unavailable. Recorded as `A100`.

## Mock data rules

Pilot and prototype screens use **realistic but clearly simulated** Ethiopian birr values and mock
airtime denominations. Every flow carries the **TRAINING MODE — NO REAL VALUE** banner.
No real customer data, no real phone numbers, no real merchant names.

## Related

- [[Design System]]
- [[User Journeys]]
- [[English Strings]]
- [[Receipt Specification]]

---
Back to [[00 Home]]
