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
| `product.data` | **on** (training only) | Live traffic needs separate provider approval — [[Decision Log]] D72 |
| `wallet` | off | Legal review — Telga is not a wallet |
| `payments.acceptance` | off | Payment-institution authorization |
| `cash.in_out` | off | Legal review |
| `lending` | off | Out of scope |
| `remittance` | off | Out of scope |
| `bills.general` | off | Separate provider authorization |
| `vending.offline` | off | **Not permitted in pilot** |
| `settlement.independent` | off | Banking partner structure |
| `funding.submission` | off | Approved funds structure — [[Funding Verification]] |

### Additions beyond the original register

Two capabilities exist in the build that this register predates. They are recorded here rather
than left ungated:

| Flag | Default | Gate to enable | Why it is not the regulated flag next to it |
|---|---|---|---|
| `card.simulated` | **on** (simulated) | — | Gates the card **simulator**. Nothing behind it reaches a card network, processor or bank; `payments.acceptance` remains off and is what a real acquirer would need. [[Decision Log]] D87 |
| `deposits.training` | **on** (simulated) | — | Credits a **training** ledger against no bank reference. `funding.submission` — a real deposit — remains off. [[Decision Log]] D70 |

Keeping each pair as two switches is the point: turning the simulator on must never turn a
licence requirement on with it.

### On `product.data`

This register originally recorded `product.data` as off pending separate approval.
[[Decision Log]] **D72** is that approval, and it is scoped to **training only** — simulated
funds, simulated provider, no real bundle delivered. It is **not** approval for production, live
money, a real provider, or general availability; live data traffic still needs its own provider
authorization, exactly as airtime does.

## What is enforced, and what is not

The four-layer rule above is implemented in `packages/domain/src/featureFlags.ts` at **three**
layers. The fourth is named honestly rather than claimed:

| Layer | Status | Mechanism |
|---|---|---|
| UI | Implemented | Entry points check `isEnabled` before rendering |
| API | Implemented | `routeBlockedBy(path)` → `404` with `FEATURE_DISABLED`, before authentication, body read, or any ledger write |
| Roles | Implemented | `assertNoRoleCarriesDisabledCapability()` at start-up; `FEATURE_PERMISSIONS` maps a capability to the permission it would need |
| Deployment | **Not implemented** | Every disabled capability is *unbuilt* rather than *excluded* — there is no wallet module to leave out. This becomes real work the day one is written |

`assertNoLiveMoneyEnabled()` is the nearest honest substitute for the deployment layer: a
start-up refusal rather than a build-time exclusion.

The code register and this table are compared by `tests/domain/feature-flags.test.ts`, which
reads this note and fails if a name or a default disagrees. An earlier version of the module
used its own names and nothing failed — the note and the code simply drifted apart.

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
