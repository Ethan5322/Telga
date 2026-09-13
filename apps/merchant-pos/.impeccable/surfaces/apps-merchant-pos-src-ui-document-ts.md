---
version: 1
slug: "apps-merchant-pos-src-ui-document-ts"
primary_target: "apps/merchant-pos/src/ui/document.ts"
related_targets: ["apps/operations-console/src/ui/page.ts"]
---

Scope: the Telga merchant app screens (`apps/merchant-pos/src/ui/`) and the Telga
operations console (`apps/operations-console/src/ui/`). Visitor mode: **Operate**
on both — a shopkeeper completing a sale with a customer waiting, and a Telga
operations desk deciding a deposit, a transfer or a complaint.

Audience and job: an Ethiopian shop operator at a counter, one-handed, in
daylight, on either their own Android phone (~390px) or a smart-POS terminal —
both weighted equally. Their job is to sell, to know the shop's balance, and to
answer "where did that money go". Separately, Telga staff on the console, who
must never mistake one application for the other.

Constraints that bind the build: ~1970 tests assert on `data-testid`; the
`TRAINING — NO REAL VALUE` banner is unconditional on screen and on every slip;
58/80 mm thermal print styles must survive; no webfonts (CSP + a counter with
unreliable connectivity), so Ethiopic comes from the system stack; no invented
rates, prices, providers or legal claims anywhere, including in mock data.

## Direction contract

THESIS: This surface owns the idea that a shop's money is *scribally accounted
for* — every figure sits in a ruled register whose corrections are struck and
re-entered rather than erased, which is the append-only ledger made visible. It
refuses the fintech-dashboard arrangement the category ships: a big balance on a
tonal card, a gradient accent, a chart, and three bottom tabs.

OWN-WORLD: Ethiopian *mäṣḥaf* scribal practice, at its saturated end, not its
cream end. Five inks and no intermediate tones: goatskin tan ground, carbon
black text, vermilion rubrication, indigo, ochre-yellow. The console inverts to
the blind-tooled leather side of the same world — dark board, same vermilion.
Component language: hard black rules that reach the edge; a harag interlace band
opening each section; figures in fixed decimal positions; rubricated units and
labels; state as a named phase with its own pattern, never hue alone; a scribal
strike on anything worked or corrected.

STORY: The operator understands at a glance what the shop holds and what is
still unresolved; believes the number because its register is visible and its
corrections are legible rather than hidden; and acts by pressing one primary
action per screen.

FIRST VIEWPORT (merchant app, 390px): the training banner as a full-width
vermilion-ruled strip; beneath it a harag band the height of a cap; then the
shop's available balance at ~34px in tabular figures with the ETB unit
rubricated and set small beside it, sitting on a hard rule that reaches both
edges; under that, up to four ledger rows on hard rules — each carrying a
phase name, a pattern mark and an amount in fixed decimal positions; the primary
action (**Sell**) as a 56px vermilion-ruled block immediately above the tab bar;
the tab bar as three text destinations on a 60px band with the active one
inverted rather than tinted.

FORM: Ge'ez Scribal Rubrication — candidate 5 of my resonance-ordered grounded
list, which the roll assigned over my own top pick (the shop ledger notebook).
Seed key 3d0e1c67, scope direction, mode operate. Raised by five named
donations from the hands it beat: fixed decimal places (nixie), named phases
with patterns (cyclorama), a hard-capped palette (PC-98), pending as a rule
arrested short of the margin (depot blind), a persistent scribal strike on
worked rows (doujin). Signature interaction: a settling sale steps its rule to
the margin in one whole-line movement with a single overshoot, and a pending one
halts short of it.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved

- POS hardware is not chosen (`ASSUMPTIONS` A101), so the terminal rendition is
  built to hold from 390px to ~1024px rather than to a known panel.
- Amharic strings remain a draft needing native review before production; the
  type scale is set for Ethiopic regardless.
- Whether the console's leather rendition should also carry harag, or only the
  rule system, is open until the first review.
