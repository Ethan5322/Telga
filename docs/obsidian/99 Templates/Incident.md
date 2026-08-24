---
title: Incident
type: operations
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - template
  - incident
  - runbook
related:
  - "[[00 Home]]"
  - "[[Runbooks]]"
  - "[[Risk Register]]"
depends_on: []
implements: []
validates: []
decision_status: confirmed
---

# Incident — template

**Every fault found and fixed gets one of these.** Copy, rename to the fault, add a row to the
incident log in [[Runbooks]], and link it from the component note it affects.
**No incident note is an orphan.**

---

```markdown
---
title: <What broke, in plain words>
type: operations
status: draft
owner: telga
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags:
  - telga
  - incident
related:
  - "[[Runbooks]]"
depends_on: []
implements: []
validates: []
decision_status: assumption
---

# <What broke, in plain words>

**Severity:** Critical | High | Medium | Low
**Status:** Open | Resolved | Monitoring
**Found:** YYYY-MM-DD · **Resolved:** YYYY-MM-DD
**Found by:**

## What happened

Observable behaviour. What a merchant or operator actually saw.

## Money impact

| Question | Answer |
|---|---|
| Was any balance affected? | |
| Was any transaction duplicated? | |
| Was any ledger entry incorrect? | |
| Were merchant funds at risk? | |
| Was a correction posted, and by whom? | |

> A correction is an authorized adjustment entry, **never** an edit — [[Ledger Invariants]].

## Root cause

Not "a bug in X" — the reason the bug was possible.

## Fix

What changed. Link the commit or file.

## Verification

How we know it is fixed. **Actual test output**, not a claim.

## Prevention

| Action | Owner | Status |
|---|---|---|

Add a regression test to [[Testing Strategy]] if one is missing.

## Related

- [[Runbooks]]
- [[Risk Register]]

---
Back to [[00 Home]]
```

## Severity guide

| Severity | Meaning |
|---|---|
| **Critical** | Duplicate vending, balance integrity loss, or merchant funds at risk |
| **High** | A merchant cannot sell, or cannot be told the truth about a transaction |
| **Medium** | Degraded operation with a workaround |
| **Low** | Cosmetic, documentation, or internal-only |

## Related

- [[Runbooks]]
- [[Risk Register]]
- [[Testing Strategy]]

---
Back to [[00 Home]]
