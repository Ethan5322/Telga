---
title: Idempotency
type: domain
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - domain
  - idempotency
  - safety
related:
  - "[[00 Home]]"
  - "[[Transaction State Machine]]"
  - "[[Ledger Invariants]]"
  - "[[API Contracts]]"
depends_on:
  - "[[Transaction State Machine]]"
implements: []
validates:
  - "[[Ledger Invariants]]"
decision_status: confirmed
---

# Idempotency

## The problem it solves

A merchant taps *Confirm*, the screen freezes, and nothing appears to happen. The instinct is to
tap again. On a naive system that sells airtime twice and debits twice — **duplicate vending**,
the single defect that blocks Phase 3 exit. See the technical trial plan (commercial material, kept outside this repository).

## The rule

> **An uncertain outcome is never retried as a new transaction.**
> The same logical transaction and the same idempotency key are reused.

## Key construction

The idempotency key is derived from the request, not generated per attempt:

| Component | Why |
|---|---|
| Merchant ID | Scopes the key; prevents cross-merchant collision |
| Device ID | Distinguishes two counters in one shop |
| Product and amount | Part of the logical request |
| Recipient | Part of the logical request |
| Client request ID | Generated once per *user intent*, held across retries |

The client generates the request ID **when the confirmation screen opens**, not when the button is
pressed — so a second press carries the same key.

## Server behaviour

| Situation | Response |
|---|---|
| Key unseen | Create `Transaction` + `IdempotencyRecord`, proceed |
| Key seen, same payload, transaction in flight | Return **current state**. No new attempt, no new reservation |
| Key seen, same payload, transaction terminal | Return the **stored result**. No new sale |
| Key seen, **different payload** | Reject with a payload-mismatch error. Never silently overwrite |

A payload mismatch on a known key means a client bug or an attack, and is an audited event.

## Provider-side idempotency

`TransactionAttempt` records each submission to a provider. Retrying a provider call reuses the
same provider reference where the provider supports it. Provider reference and idempotency
semantics are a **required term in the provider agreement** — see the provider agreement terms (commercial material, kept outside this repository) .
Actual provider capability is **NOT YET CONFIRMED**.

## Webhooks and callbacks

Provider callbacks are **idempotent**: a duplicate callback for a resolved transaction is
acknowledged and discarded, never re-applied. Callbacks are signature-verified and replay-protected
per [[Security Model]].

## UI protection

Protection is layered — the API rule above is the real guarantee, but the UI removes the
temptation:

1. The confirm button disables on first press.
2. The processing screen offers no retry control.
3. The pending screen states plainly: *This transaction is still being checked. Do not retry yet.*

## In the orchestration

`createSale` applies the rule end to end. A duplicate returns `DUPLICATE_REQUEST` carrying the
**original** transaction and its current state; a changed payload under the same identity returns
`PAYLOAD_MISMATCH` and writes nothing. Ten rapid presses produce one transaction, one reservation
and one debit. A retry during `PENDING` returns the pending state rather than starting a second
sale. See [[Transaction Orchestration]] and [[Create Sale Service]].

Four independent guards back it: the idempotency primary key `(merchant_id, key)`, the unique
index on `(merchant_id, idempotency_key)` in `transactions`, the reservation update guarded on
`HELD`, and the pending job guarded on `AWAITING`.

## Tests

[[Testing Strategy]] asserts: duplicate submission creates one transaction and one set of ledger
entries; duplicate callback applies once; payload mismatch is rejected; a retry during `PENDING`
returns state rather than selling again.

## Related

- [[Transaction State Machine]]
- [[Ledger Invariants]]
- [[API Contracts]]
- [[Testing Strategy]]

---
Back to [[00 Home]]
