---
title: Merchant Onboarding
type: operations
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - operations
  - onboarding
  - hardware
related:
  - "[[00 Home]]"
  - "[[Security Model]]"
depends_on: []
implements: []
validates: []
decision_status: pending
---

# Merchant Onboarding

## Hardware terms by merchant tier

| Tier | Approach | Commercial terms |
|---|---|---|
| Low-volume / new | Limited phone-first trial | NOT YET CONFIRMED |
| Trusted, cash-constrained | Staged deposit | NOT YET CONFIRMED |
| Established | Refundable deposit or lease-to-own POS | NOT YET CONFIRMED |
| Strategic | Sponsored placement with written performance terms | NOT YET CONFIRMED |

**No deposit amount, lease price, or sponsorship term may be quoted to a merchant** until
provider and operating-cost data exist. See the pilot budget (commercial material, kept outside this repository).

## Onboarding steps

1. **Qualify** — score the shop against the merchant selection criteria (commercial material, kept outside this repository) .
2. **Interview** — run [[Merchant Interview]] and record the baseline in the pilot baseline metrics (commercial material, kept outside this repository).
3. **Agree terms** — merchant agreement and fee disclosure. Both are a launch gate; see [[Launch Gates]]. **Neither document exists yet.**
4. **Register the merchant** — legal name, shop name, location, contact.
5. **Register users** — each operator gets their own PIN and role. Shared PINs are not permitted.
6. **Register and bind the device** — device ID bound to the merchant; see [[Security Model]].
7. **Train in training mode** — a full simulated day at the counter before any real value. See [[Balance Model]].
8. **Enable selling** — only once the merchant's funding structure is approved and their balance is credited through [[Funding Verification]].

## Device controls

Every deployed device supports:

| Control | Purpose |
|---|---|
| Operator PIN | Attribution of every sale to a person |
| Device ID | Binding to one merchant; blocks cross-merchant use |
| Remote stop of new sales | Halts selling **without deleting history** |
| Secure sync | State reconciliation after reconnect |
| Transaction and balance display | The four balances, always visible |
| Receipts and reprints | Per [[Receipt Specification]] |
| Low-paper warning | Warns before the roll runs out |
| Provider status | Plain-language service state |
| Support contact | One tap to raise a case |
| Daily report | End-of-day summary |
| Tamper and damage record | Device condition log |

> [!important] Remote stop never deletes history
> Stopping a device stops **new sales only**. Transaction history, receipts, reports and support
> stay available to the merchant. A merchant cut off from their own records would have no way to
> answer their own customers.

## Thermal paper

The merchant independently sources and pays for compatible thermal paper.
**A paper shortage is never a transaction failure** — see [[Receipt Specification]].
Compatible paper specification: NOT YET CONFIRMED, pending the hardware decision.

## Offboarding

Not yet specified. Must cover: device return or buyout, final reconciliation, balance return,
data retention, and receipt access after the relationship ends. **Open item** — logged in
[[Decision Log]].

## Related

- [[Funding Verification]]
- [[Security Model]]

---
Back to [[00 Home]]
