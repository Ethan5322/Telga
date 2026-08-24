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
| 4–6 | Amount, recipient and confirmation | `/sell`, as one form |
| 7–8, 11–13 | Processing, pending, under review, failure, success | `/transactions/:id`, one screen driven by [[State To UI Mapping]] |
| 14–15 | Find transaction, details | `/transactions` and `/transactions/:id` |
| 21 | Review queue (merchant-facing part) | `/queue` |

Not built: login and PIN, provider selection, receipt printing and reprint, balance detail,
funding, verification queue, offline, support, reports and the operations console.

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
