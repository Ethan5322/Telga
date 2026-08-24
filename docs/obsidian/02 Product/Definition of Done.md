---
title: Definition of Done
type: product
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - product
  - quality
related:
  - "[[00 Home]]"
  - "[[Testing Strategy]]"
  - "[[Product Scope]]"
  - "[[Runbooks]]"
depends_on: []
implements: []
validates:
  - "[[Product Scope]]"
decision_status: confirmed
---

# Definition of Done

A feature is done **only** when every one of these exists. A missing row means the feature is not
done, regardless of whether it demonstrates correctly.

| # | Condition | Evidence lives in |
|---|---|---|
| 1 | Business rule stated | This vault, in the owning note |
| 2 | Domain model covers it | [[Domain Glossary]] |
| 3 | Authorization defined | [[Security Model]] |
| 4 | Ledger impact defined | [[Ledger Invariants]] |
| 5 | Idempotency defined | [[Idempotency]] |
| 6 | Failure and recovery states defined | [[Transaction State Machine]] |
| 7 | Audit event emitted | [[Security Model]] |
| 8 | English strings | [[English Strings]] |
| 9 | Amharic strings | [[Amharic Strings]] |
| 10 | Visual states — all 14 | [[Screen Inventory]] |
| 11 | Tests | [[Testing Strategy]] |
| 12 | Metrics | [[Observability]] |
| 13 | Logs | [[Observability]] |
| 14 | Documentation | This vault |
| 15 | Runbook | [[Runbooks]] |
| 16 | Feature-flag status recorded | [[Feature Flags]] |

## Three absolute conditions

- **No secrets** committed, logged, or exposed to a client.
- **No fake claims** — nothing asserted that pilot evidence does not support.
- **No unsafe live defaults** — anything touching real money defaults to off.

## The happy-path rule

> **No happy-path-only feature is complete.**

A feature that handles success but not timeout, outage, permission denial, or session expiry has
not been built; it has been sketched. The required states are listed in [[Screen Inventory]].

## Related

- [[Testing Strategy]]
- [[Screen Inventory]]
- [[Feature Flags]]
- [[Runbooks]]

---
Back to [[00 Home]]
