---
title: Guards That Read Themselves
type: ux
status: accepted
owner: telga
created: 2026-09-16
updated: 2026-09-16
tags:
  - telga
  - ux
  - testing
  - decision
related:
  - "[[00 Home]]"
  - "[[Design System]]"
  - "[[Telga Launcher and Dashboard]]"
  - "[[Telga Pay Card Simulator]]"
  - "[[Decision Log]]"
depends_on:
  - "[[Design System]]"
validates:
  - "[[Telga Launcher and Dashboard]]"
  - "[[Telga Pay Card Simulator]]"
decision_status: accepted
---

# Guards That Read Themselves

A failure mode this repository has now produced **seven times**, written down in
one place so the eighth is recognisable before it ships.

> **A guard must read the code, never the prose about the code — and never one
> half of the code without asking whether the other half agrees.**

## The seven

| # | What the guard checked | What it should have checked |
|---|---|---|
| 1 | The comment naming the training banner | The banner element in the rendered screen |
| 2 | The comment above the profit query | The query |
| 3 | The comment describing the launcher CSS | The CSS |
| 4 | A `data-announce-` attribute named only in a comment | The attribute in the markup |
| 5 | The test recording lessons 1–4, which matched its own text | The source it was about |
| 6 | The stylesheet, for a selector the stylesheet declared | Whether anything renders that selector |
| 7 | `/dashboard` alone, for a rule stated about every screen | Every screen |

Numbers 1 to 5 are one shape: a regular expression matched the sentence
explaining the rule rather than the rule. The fix for those was mechanical —
strip comments before asserting, which every UI guard now does.

**Six and seven are the interesting ones**, because comment-stripping does not
catch either.

## Six: a selector that matched nothing

[[Decision Log]] D169 gave each service family an ink and filled the icon chip
of a working service with it, so a shopkeeper could find the two services that
work among sixteen. The rule was written:

```css
.dashboard__tile[data-status="AVAILABLE"] .dashboard__tile-icon { … }
```

The markup has never said `AVAILABLE`. `ServiceStatus` is
`'IMPLEMENTED' | 'COMING_SOON'`, and `serviceTileEl` writes it straight into the
attribute. The rule matched nothing, and Vouchers and Airtime shipped drawn like
the fourteen that do not work — which is the whole job D169 existed to do.

The guard read the stylesheet, pulled out the `AVAILABLE` block, and asserted
that block filled the chip with the family ink. **It did.** The test was true
about the file it read and said nothing about the screen.

**The fix is a direction, not a stricter pattern.** The test now starts from the
statuses the *source emits*, requires a rule for each, and separately refuses a
rule that paints a status nothing renders. Neither question can be answered by
one file alone, which is the property that makes it a guard.

## Seven: a rule about every screen, asked of one

The founder's device review ([[Decision Log]] D168) asked for the *"Telga
launcher"* link to be removed **from every screen**. The guard checked
`/dashboard`.

Telga Pay went on rendering it on three screens for a day. Worse, a second test
in the same file asserted the link **must** exist on `/pay` — so the file
contained two guards disagreeing about one control, and both were green.

Removing it alone would have stranded an operator inside Telga Pay, whose only
way out it was. The shared bottom bar went where the link had been.

## What to do instead

1. **Render the thing.** A guard that never produces the artefact is checking a
   file, and a file is not a screen.
2. **Cross the seam.** If a rule connects two files — a value written in one and
   matched in the other — the test has to read both. A test inside one file can
   only confirm that file is self-consistent.
3. **Ask the rule at its own scope.** A rule about every screen is asked of
   every screen; a rule about every submit counts them.
4. **Strip comments first.** Still true, still necessary, still not sufficient.

## Related

- [[Design System]] — the rules these guards defend
- [[Telga Launcher and Dashboard]] — where six shipped
- [[Telga Pay Card Simulator]] — where seven shipped
- [[Decision Log]] — D168, D169, D170

---
Back to [[00 Home]]
