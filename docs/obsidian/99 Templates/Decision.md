---
title: Decision
type: governance
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - template
  - decision
related:
  - "[[00 Home]]"
  - "[[Decision Log]]"
depends_on: []
implements: []
validates: []
decision_status: confirmed
---

# Decision — template

Copy this note, rename it to the decision, and fill it in. Add a row to [[Decision Log]] and link
it from every note the decision changes. **A decision note that nothing links to is an orphan and
will be missed.**

---

```markdown
---
title: <Decision name>
type: governance
status: draft
owner: telga
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags:
  - telga
  - decision
related:
  - "[[Decision Log]]"
depends_on: []
implements: []
validates: []
decision_status: proposed
---

# <Decision name>

**Date:** YYYY-MM-DD
**Decided by:** <named person — a role alone is not enough for anything touching money, law, or a contract>
**Status:** proposed | accepted | superseded | rejected

## Context

What situation forced a choice. What was already true.

## Decision

One sentence. What we are doing.

## Alternatives considered

| Option | Pros | Cons | Why not chosen |
|---|---|---|---|

## Consequences

What this makes easier, what it makes harder, and what it forecloses.

## Reversibility

Reversible | Costly to reverse | Irreversible.
If irreversible, name who approved it.

## Affects

- [[Note this changes]]

## Review

When this should be revisited, and what evidence would overturn it.

---
Back to [[00 Home]]
```

## Related

- [[Decision Log]]
- [[Launch Gates]]

---
Back to [[00 Home]]
