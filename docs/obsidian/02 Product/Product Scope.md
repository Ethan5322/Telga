---
title: Product Scope
type: product
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - product
  - scope
related:
  - "[[00 Home]]"
  - "[[Feature Flags]]"
  - "[[Roadmap]]"
  - "[[Definition of Done]]"
depends_on:
  - "[[Launch Gates]]"
implements:
validates: []
decision_status: confirmed
---

# Product Scope

## First live scope

Fourteen capabilities make up the first live release:

| # | Capability | Notes |
|---|---|---|
| 1 | Merchant onboarding, authentication, roles, device registration | [[Merchant Onboarding]], [[Security Model]] |
| 2 | Airtime catalog and vending workflow | [[User Journeys]] |
| 3 | Authorized provider adapter | [[API Contracts]] |
| 4 | Prepaid merchant selling balance | **Only under an approved structure** — [[Launch Gates]] |
| 5 | Transaction history and search | [[Screen Inventory]] |
| 6 | Net commission display and internal fee calculation | [[Ledger Invariants]] |
| 7 | Receipt preview, print abstraction, safe reprint | [[Receipt Specification]] |
| 8 | Provider health and outage isolation | [[Provider Health]] |
| 9 | Processing, pending, failed, reversal-required, reversed, under-review states | [[Transaction State Machine]] |
| 10 | Merchant support cases | [[Support and Disputes]] |
| 11 | Funding submission and manual verification | **Only when legally approved** — [[Funding Verification]] |
| 12 | Reconciliation and reports | [[Funding Verification]], [[Observability]] |
| 13 | English and Amharic localization | [[English Strings]], [[Amharic Strings]] |
| 14 | Audit logs and metrics | [[Security Model]], [[Observability]] |

## Disabled in the first live release

These are not "later features" — they are **actively blocked** in UI, API, roles, and deployment.
Enforcement is described in [[Feature Flags]].

- Electricity
- Data (unless separately approved)
- Wallets
- Payment acceptance
- Cash-in / cash-out
- Lending
- Remittance
- General bill payment
- Offline vending
- Independent custody and settlement

## Scope boundary

Telga is an authorized-provider merchant platform. Any capability that would make Telga a
custodian of customer money, a payment institution, a lender, or an independent settler is out of
scope until [[Launch Gates]] clears and an authorized-partner structure exists.

## Related

- [[Roadmap]]
- [[Feature Flags]]
- [[Definition of Done]]

---
Back to [[00 Home]]
