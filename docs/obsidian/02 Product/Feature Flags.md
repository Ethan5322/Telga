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
| `product.data` | **off** | **Switched off by founder decision [[Decision Log]] D112**, reversing D72. Data vouchers are outside the approved training scope, which is airtime vending and platform operations. `/vouchers/data` and `/data` are refused; `/vouchers` and `/vouchers/airtime` stay, because selling airtime as a printed voucher is airtime vending |
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
| `card.simulated` | **on** | — | **Switched back on by founder decision [[Decision Log]] D124**, reversing D112 and restoring D87's surface (whose two-port design never changed). Gates the **whole `/pay` tree**, not just the card screen — an earlier entry gated `/pay/card` alone and left nine Telga Pay routes answering normally. Nothing behind it reaches a card network, processor or bank; `payments.acceptance` remains **off** and is what a real acquirer would need. Restoring it also restores `/pay/deposit`, the only in-app way to credit a training float |
| `deposits.training` | **on** (simulated) | — | Credits a **training** ledger against no bank reference. `funding.submission` — a real deposit — remains off. [[Decision Log]] D70. Retained under D112 after audit: `application/deposits.ts` refuses any mode but `TRAINING` before reading an amount, is bounded to 10–50,000 birr, posts a balanced append-only entry against `BANK_CLEARING`, audits `TRAINING_DEPOSIT_CREDITED`, and imports no HTTP client or provider. It now gates `/api/training/pay/deposits` — its real endpoint — instead of `/deposit`, which matched no route. **Its screen lives under `/pay` and is unreachable while `card.simulated` is off** |
| `registration.self_service` | **on** | — | **On by founder decision [[Decision Log]] D138**, reversing the *registration* half of D113(b). Gates `/register` — the app's **Register as Telga member** form — and nothing else. It is the **only surface on this platform an unauthenticated stranger may write through**, which is why it is its own switch rather than part of `airtime.vending`: closing it must be one flag, not a deployment. It approves nothing and creates no account: a submission enters `merchant_applications` as `SUBMITTED` with `submitted_via = 'SELF_SERVICE'`, and an admin must still approve it in the console before any credential exists. D113(b)'s **device** half is untouched — a device still may not provision itself. See [[Vendor Registration]] |
| `reversal.merchant_initiated` | **on** | — | **`CLAUDE.md` §17.1.** Gates a merchant *requesting* a reversal from the app, and nothing else. Completing one is a supervisor's act (`OPS_APPROVER` or `ADMIN`) with its own permission, so the worst this flag can produce is a queue item for a human. Off, merchants cannot file; who may approve is unchanged either way |
| `transfer.shop_to_shop` | **on** | Legal review · authorized-partner structure **before `money.live`** | **Switched on by founder decision [[Decision Log]] D146** for the training deployment, having been shown that moving value between two legal entities is regulated (§2, §7). **This flag was never what blocks real money:** `money.live` is false and `assertSafeStartup` refuses to boot if any `MOVES_REAL_MONEY` flag is on, so what this gates is the **simulation** — a training ledger, no counterparty, no bank, no network — exactly as `card.simulated` gates Telga Pay (D87/D124). Turning it on changes what a merchant can practise, not what can leave the building. Deliberately absent from `MOVES_REAL_MONEY`, because what sits behind it moves none, and adding it would make that list mean "features we are nervous about" rather than "features that move real money". **The regulated question returns in full the day `money.live` is considered.** See [[Decision Log]] D146 |

Keeping each pair as two switches is the point: turning the simulator on must never turn a
licence requirement on with it.

### On `product.data` — and why it is off again

This register originally recorded `product.data` as off pending separate approval.
[[Decision Log]] **D72** was that approval, scoped to training only.

**[[Decision Log]] D112 has switched it off again.** The founder narrowed the approved
training scope to airtime vending and platform operations, so data vouchers are out. D72 is
not withdrawn as *reasoning* — nothing about that flow ever reached a provider — but it no
longer describes what is switched on. The flow, its screens and migration 009 remain in the
tree; removing them would be a larger and riskier change than switching them off, and no
route serves them while the flag is false.

### On `card.simulated` — and the hole that switching it off exposed

**D87** built card payment as two ports so a certified reader and a real acquirer could be
dropped in later. That design stands. **D112** switched off the *surface*: Telga Pay is not
part of the approved training scope.

Switching it off revealed that the flag had never gated what it appeared to. The route table
listed `/pay/card` only, so `/pay`, `/pay/purchase`, `/pay/cashback`, `/pay/deposit`,
`/pay/deposit/slip`, `/pay/settings`, `/pay/statements`, `/pay/transactions` and
`/pay/result` — **nine routes** — would have kept answering normally with the flag off. The
entry is now `/pay`, which covers the tree. This is exactly the failure the "not merely
hidden" rule exists to prevent, and it was found by turning the flag off rather than by
reading the table.

`deposits.training` had the same class of fault: it gated `/deposit`, a path **no route in
the system uses**. The screen is `/pay/deposit` and the endpoint is
`/api/training/pay/deposits`, so the flag gated nothing whatever. It now names the endpoint.

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
