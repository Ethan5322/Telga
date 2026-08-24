---
title: Receipt Specification
type: ux
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - ux
  - receipt
  - printing
related:
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

## Related

- [[Screen Inventory]]
- [[Transaction State Machine]]
- [[Ledger Invariants]]
- [[Merchant Onboarding]]

---
Back to [[00 Home]]
