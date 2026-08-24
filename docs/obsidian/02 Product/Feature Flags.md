---
title: Feature Flags
type: product
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - product
  - security
  - flags
related:
  - "[[00 Home]]"
  - "[[Product Scope]]"
  - "[[Security Model]]"
  - "[[Launch Gates]]"
depends_on:
  - "[[Launch Gates]]"
implements:
  - "[[Product Scope]]"
validates: []
decision_status: confirmed
---

# Feature Flags

## The rule

A disabled feature must be inaccessible in **UI, APIs, roles, and deployment** — not merely
hidden. Hiding a button while the endpoint still answers is a defect, and [[Testing Strategy]]
tests for exactly that.

Enforcement is four-layer:

| Layer | Enforcement |
|---|---|
| UI | The screen and its entry points do not render |
| API | The route returns `404` / `FEATURE_DISABLED`; no partial execution, no ledger write |
| Roles | No role in [[Security Model]] carries the capability, so no token can authorize it |
| Deployment | The module is not built into the deployed artifact |

## Flag register

| Flag | Default | Gate to enable |
|---|---|---|
| `airtime.vending` | **on** (simulated) | Live traffic requires provider agreement — [[Launch Gates]] |
| `money.live` | **off** | All ten launch gates, plus dual approval |
| `training.mode` | **on** | Turned off only when `money.live` is on |
| `product.electricity` | off | Separate provider authorization |
| `product.data` | off | Separate approval |
| `wallet` | off | Legal review — Telga is not a wallet |
| `payments.acceptance` | off | Payment-institution authorization |
| `cash.in_out` | off | Legal review |
| `lending` | off | Out of scope |
| `remittance` | off | Out of scope |
| `bills.general` | off | Separate provider authorization |
| `vending.offline` | off | **Not permitted in pilot** |
| `settlement.independent` | off | Banking partner structure |
| `funding.submission` | off | Approved funds structure — [[Funding Verification]] |

## Live money requires two keys

`money.live` is not a single switch. It requires:

1. All ten gates in [[Launch Gates]] documented as cleared, **and**
2. Dual approval recorded in [[Decision Log]] by two assigned owners from [[Founders and Roles]].

Since no owner is assigned yet, `money.live` **cannot** be enabled today. This is deliberate.

## Training mode

While `training.mode` is on, every screen carries the banner
**TRAINING MODE — NO REAL VALUE**, the ledger is a simulated ledger, and the boundary check
prevents any training transaction from reaching a provider adapter or a settlement path.
See [[Balance Model]].

## Related

- [[Product Scope]]
- [[Security Model]]
- [[Launch Gates]]
- [[Decision Log]]

---
Back to [[00 Home]]
