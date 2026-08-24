---
title: Source Specification Clipped In PDF
type: operations
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - operations
  - incident
  - documentation
related:
  - "[[00 Home]]"
  - "[[Runbooks]]"
  - "[[Decision Log]]"
depends_on: []
implements: []
validates: []
decision_status: assumption
---

# Source Specification Clipped In PDF

**Severity:** Low · **Status:** Resolved, with assumptions recorded · **Found:** 2026-08-19

## What happened

The authoritative project specification was supplied as `CLAUDE.pdf` (12 pages). When its text was
extracted, the vault-structure listing on pages 4–5 was found to be **clipped at the right page
margin**. Eight of the ten folder lines lost their tail mid-word:

| Line in source PDF | Where it stops |
|---|---|
| `01 Strategy/{...` — strategy folder, contents withheld here | mid-word |
| `03 Domain/{Domain Glossary,Transaction State Machine,Ledger Invariants,Balance Mo` | mid-word |
| `04 UX UI/{Design System,Screen Inventory,English Strings,Amharic Strings,Receipt ` | mid-phrase |
| `05 Operations/{Merchant Onboarding,Funding Verification,Support and Disputes,Prov` | mid-word |
| `06 Partnerships/{...` — commercial folder, contents withheld here | mid-word |
| `07 Governance/{Founders and Roles,Risk Register,Legal Questions,Launch Gates,Deci` | mid-word |
| `08 Pilot/{...` — commercial folder, contents withheld here | mid-word |
| `09 Engineering/{Architecture,API Contracts,Security Model,Testing Strategy,Observ` | mid-word |

The clipping is in the source layout itself, not in the extraction — the characters are absent
from the content stream.

> [!note] Some rows are abbreviated here
> Three rows are abbreviated: the reconstructed names for the strategy and commercial folders are
> recorded in the vault on the working machine, not in this repository. Nothing technical depends
> on them.

## Impact

Without reconstruction, eight folders would have been created with abbreviated or missing note
names, and the wiki links between them would have broken. Because Graphify builds its graph from
these links, a truncated name would have produced a disconnected node.

## Resolution

Note names were reconstructed and confirmed by the founder on 2026-08-19:

| Folder | Reconstructed tail |
|---|---|
| 01 Strategy | strategic material maintained outside the source repository |
| 03 Domain | [[Balance Model]], [[Idempotency]] |
| 04 UX UI | [[Receipt Specification]] |
| 05 Operations | [[Provider Health]], [[Runbooks]] |
| 06 Partnerships | the provider agreement terms (commercial material, kept outside this repository) |
| 07 Governance | [[Decision Log]] |
| 08 Pilot | the pilot measurement record (commercial material, kept outside this repository) |
| 09 Engineering | [[Observability]] |

The founder instruction was explicit: *use clean, full note names; do not use abbreviated names.*
All folders now use full names.

## Prevention

1. `CLAUDE.md` at the repository root is now the authoritative, unclipped machine-readable source. The PDF is a rendering of it, not the other way round.
2. Any future specification supplied as PDF is checked for right-margin clipping before it is acted on.
3. Structural additions made during transcription are itemised in `ASSUMPTIONS.md`.

## Related

- [[Runbooks]]
- [[Decision Log]]
- [[Incident]]

---
Back to [[00 Home]]
