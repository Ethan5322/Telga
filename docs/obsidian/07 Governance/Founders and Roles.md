---
title: Founders and Roles
type: governance
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - governance
  - roles
  - decision
related:
  - "[[00 Home]]"
  - "[[Decision Log]]"
  - "[[Launch Gates]]"
  - "[[Agent Roles]]"
depends_on: []
implements: []
validates: []
decision_status: pending
---

# Founders and Roles

## Confirmed

| Field | Value |
|---|---|
| Company name | **MuleSoo Digital Services** |
| Product brand | **Telga** |
| Country | **Ethiopia** |

## Not confirmed

**Founders, equity, exact roles, and equity split are NOT YET CONFIRMED.**

No founder name, equity percentage, salary, legal ownership share, or individual responsibility is
recorded anywhere in this vault, and none may be added without the founder's written confirmation.
This is a deliberate blank, not an oversight.

---

## Role charters

Seven roles must be owned before live money. Each charter below defines the role;
**the owner is a blank to be filled by MuleSoo.**

### 1. Product and business strategy

**Status: OWNER NOT YET ASSIGNED**

Owns scope, priorities, positioning, and the decision on when a phase exits. Approves what goes
into [[Product Scope]] and what stays behind a flag in [[Feature Flags]]. Final say on whether
pilot evidence justifies expansion.

### 2. Engineering and security

**Status: OWNER NOT YET ASSIGNED**

Owns [[Architecture]], [[Security Model]], and [[Testing Strategy]]. Accountable for the ledger
invariants holding under failure, for secrets never being committed, and for production access
being restricted. Holds one of the two keys required to enable `money.live`.

### 3. Merchant onboarding and field operations

**Status: OWNER NOT YET ASSIGNED**

Owns [[Merchant Onboarding]], merchant training, device deployment, and the field relationship.
Runs [[Merchant Interview]] and maintains the pilot baseline metrics (commercial material, kept outside this repository).

### 4. Airtime provider and banking partnerships

**Status: OWNER NOT YET ASSIGNED**

Owns the provider assessment (commercial material, kept outside this repository) , the provider engagement record (commercial material, kept outside this repository), and the provider agreement terms (commercial material, kept outside this repository) . Accountable
for obtaining written terms, and for never agreeing broad indefinite exclusivity.

### 5. Finance, funding verification, and reconciliation

**Status: OWNER NOT YET ASSIGNED**

Owns [[Funding Verification]] and daily reconciliation. **This role must be split across at least
two people**: the verifier who credits funding cannot be the reviewer who reconciles it, and
high-value deposits need a second approver. See the separation-of-duties table in
[[Funding Verification]].

### 6. Hardware, POS, printer, and support operations

**Status: OWNER NOT YET ASSIGNED**

Owns device sourcing, printer compatibility, the support queue, and the [[Runbooks]]. Accountable
for the 24-hour final-answer commitment in [[Support and Disputes]].

### 7. Compliance and risk

**Status: OWNER NOT YET ASSIGNED**

Owns [[Legal Questions]], [[Risk Register]], and [[Launch Gates]]. Accountable for the rule that
Telga never claims legal compliance without documented qualified review. Holds the second key
required to enable `money.live`.

---

## Decision required before live-money pilot

> [!danger] Blocking decision
> **Confirm legal entity ownership, founder equity, signing authority, finance approvals, and
> operational accountability.**
>
> Until this is confirmed:
> - no one can sign a provider agreement (the provider agreement terms (commercial material, kept outside this repository))
> - no one can approve a funding credit ([[Funding Verification]])
> - the dual approval required to enable `money.live` cannot be given ([[Feature Flags]])
> - three of the ten [[Launch Gates]] cannot be cleared
>
> This decision is tracked in [[Decision Log]] as `pending`.

## Coverage check

| Role | Owner | Blocks |
|---|---|---|
| Product and business strategy | NOT ASSIGNED | Phase exits |
| Engineering and security | NOT ASSIGNED | `money.live` key 1 |
| Merchant onboarding and field operations | NOT ASSIGNED | Pilot recruitment |
| Provider and banking partnerships | NOT ASSIGNED | Provider agreement |
| Finance, funding, reconciliation | NOT ASSIGNED | Funding gate |
| Hardware, POS, printer, support | NOT ASSIGNED | Support escalation gate |
| Compliance and risk | NOT ASSIGNED | `money.live` key 2 |

## Related

- [[Decision Log]]
- [[Launch Gates]]
- [[Agent Roles]]
- [[Funding Verification]]

---
Back to [[00 Home]]
