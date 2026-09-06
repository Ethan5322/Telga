---
title: Receipt Specification
type: ux
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-28
tags:
  - telga
  - ux
  - receipt
  - printing
related:
  - "[[Bulk Printing and Sign Out]]"
  - "[[Data Vouchers and Slip Codes]]"
  - "[[Top Up Slips and Settings]]"
  - "[[00 Home]]"
  - "[[Screen Inventory]]"
  - "[[Transaction State Machine]]"
  - "[[Merchant Onboarding]]"
depends_on:
  - "[[Transaction State Machine]]"
implements: []
validates: []
decision_status: confirmed
---

# Receipt Specification

## Required contents

| Field | Notes |
|---|---|
| Telga identity | Product brand and MuleSoo Digital Services |
| Merchant identity | Shop name and merchant reference |
| Transaction ID | Telga's internal ID — the one support searches by |
| Provider reference | The provider's own reference, where returned |
| Product and amount | Network, denomination, value in birr |
| Date and time | Local time, with timezone |
| Result / status | Successful, failed, pending, or under review |
| Support contact | How to raise a case |
| Reprint indicator | Present **only** on a reprint |

## What must never print

- Customer personal data beyond the recipient number required for the sale
- Merchant balance, commission, or fee figures — a customer receipt is not a business statement
- Provider secrets, API references, or internal system identifiers
- Any legal or compliance claim

## Reprint behaviour

> **A reprint never creates a sale.**

| Rule | Enforcement |
|---|---|
| Reprint emits `ReprintEvent` only | No ledger entry — [[Ledger Invariants]] rule 5 |
| Reprint changes no transaction state | [[Transaction State Machine]] |
| Every reprint is marked on the paper | `receipt.reprint.notice` string |
| Every reprint is audited | Operator, device, time recorded |
| Reprint requires the transaction to exist | No reprint of an unknown ID |

## Printing by result

| State | Receipt available? | What it says |
|---|---|---|
| `SUCCESSFUL` | Yes | Confirmed sale |
| `FAILED` | Yes | Failed, **no charge was made** |
| `PENDING` | Yes, marked pending | Still being checked; do not retry |
| `UNDER_REVIEW` | Yes, marked under review | Being reviewed; balance protected |
| `REJECTED` | Optional | No charge was made |
| `REVERSED` | Yes | Reversed, with adjustment reference |

A pending receipt is deliberately printable — the merchant needs something to hand the waiting
customer that is honest about the state.

## Printer failure

**Printer failure is never a transaction failure.** If the sale succeeded and the paper jammed,
the sale stands and the receipt is reprintable.

| Situation | Behaviour |
|---|---|
| Print fails after a successful sale | Sale stands; `error.printer.failed` shown; reprint offered |
| Paper out | Low-paper warning raised; sale still completes; reprint when paper is loaded |
| Printer unreachable | Receipt viewable on screen; reprint queued |

The merchant sources and pays for their own compatible thermal paper — see [[Merchant Onboarding]].
**Paper shortage is never a transaction failure.**

## Print abstraction

The application never talks to a printer directly. A `ReceiptPrinter` port has one
screen-preview implementation for the prototype and device implementations later, so printer
failure can be injected in tests — see [[Testing Strategy]].

## Transaction history and reprint (implemented)

`GET /transactions` renders a structured table — date, time, service, amount, status, reference —
**newest first**, with the transaction id as a stable tie-break so equal timestamps cannot shuffle
between renders (`sortNewestFirst`, `ui/screens.ts`). Each completed row carries a Reprint action.

| Route | Purpose |
|---|---|
| `GET /transactions` | the list |
| `GET /transactions/:id/slip` | the slip preview (pure read) |
| `POST /transactions/:id/reprint` | records a reprint, then post/redirect/get back to the slip |
| `GET /api/training/transactions/:id/receipt` | receipt lookup |
| `POST /api/training/transactions/:id/reprint` | `recordReprint` wiring |

### A reprint never creates a sale

Enforced structurally in `services/api/src/application/reprint.ts`, not by care: that module has
no access to `createSale`, posts no ledger entry, touches no reservation, and changes no
transaction state. Its only durable effect is one append-only `RECEIPT_REPRINTED` audit event
carrying a sequence number and no credential. The slip always prints the **original** timestamp,
amount and reference — a reprint on a later day still shows the sale as it happened.

The reprint sequence is counted from the audit trail (`countAuditEvents`) rather than stored on
the transaction, so it needs no schema change and cannot drift from the events that produced it.
Sequence ≥ 1 renders a visible `REPRINT — not a new sale` marker, so a reprint can never be
mistaken for an original.

### Authorization and safety

Lookup and reprint both require `POS_VIEW_TRANSACTION` and are scoped in SQL by the session's
merchant, so another shop's transaction is an ordinary 404. Reprint is a write, so it also
carries CSRF. The slip renders no PIN, device key, session token, recipient hash, payload
fingerprint or idempotency key — the `ReceiptDto` has nowhere to put them. The recipient is the
mask the persistence layer stored; the full number was never saved.

The reprint button is marked `data-once`, which the enhancement script disables on submit so a
double click cannot fire two requests. With scripting off the form still works, and a duplicate
is harmless either way: it appends an audit line and touches nothing else.

Covered by `tests/ui/transactions-reprint.test.ts` (16 tests), including balance, transaction
count and timestamps being byte-identical across a reprint.

## Related

- [[Screen Inventory]]
- [[Transaction State Machine]]
- [[Ledger Invariants]]
- [[Merchant Onboarding]]

---
Back to [[00 Home]]
