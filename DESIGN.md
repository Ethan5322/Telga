# Design

<!-- impeccable:design-schema 1 -->

The visual world of the Telga merchant app and the Telga operations console,
recorded from the built result on 2026-09-12. Product truth lives in
`PRODUCT.md`; this file owns durable visual decisions only.

## The world

**Ge'ez scribal rubrication.** Ethiopian manuscript practice at its saturated
end — goatskin ground, carbon ink, vermilion rubrication, harag interlace as a
section opening. Chosen over six alternatives (seed `3d0e1c67`, direction
scope, operate mode) and locked by the founder.

Two renditions of one world:

| Surface | Rendition | Why |
|---|---|---|
| Merchant app | The **pages**: goatskin vellum, light | Read at a counter in daylight, sometimes with sun on the screen |
| Operations console | The **binding**: blind-tooled leather, dark | Read indoors through long sessions, often beside a bright counter screen |

They must stay tellable apart at a glance — §18.0: a Telga employee suspending
a merchant and a shop assistant selling airtime must never think they are in
the other application. Relatives, not twins: same vermilion, opposite ground.

**Not taken:** the cream-paper-and-serif reading of a manuscript. That is the
softest possible rendition of this world and the first one any model reaches
for. A real *mäṣḥaf* is thick skin in warm ochre-tan with vivid minium red.

**No religious iconography.** The scribal *system* — ruling, rubrication,
harag as structure — carries the design. No crosses, no liturgical ornament:
this is a till, and the surviving tradition being overwhelmingly religious is
the honest risk this constraint answers.

## Tokens

All values live in `packages/design-system/src/tokens.ts` and reach both
surfaces through `cssVariables(scope)`. **A surface that names a token this
file does not declare fails a test** — CSS resolves an undefined custom
property to nothing and carries on, which is the failure mode a stylesheet is
worst at reporting.

### Colour — capped at five inks per surface

No intermediate tones are invented. A lighter or darker value is a *named
ground*, so it can be counted.

**Vellum (merchant app)**

| Token | Value | Use |
|---|---|---|
| `--telga-vellum-ground` | `#E2CBA3` | The page. There are no cards |
| `--telga-vellum-ground-pale` | `#EDDCBC` | A scraped band; the tab bar |
| `--telga-vellum-ground-deep` | `#D3B98C` | A sunken or inactive region |
| `--telga-vellum-ink` | `#1A1410` | Text, and every major rule |
| `--telga-vellum-ink-thin` | `#6B5636` | Secondary text — the same ink thinned |
| `--telga-vellum-rubric` | `#C0341F` | Units, section marks, the primary action |
| `--telga-vellum-indigo` | `#23375E` | Second structural ink |
| `--telga-vellum-ochre` | `#C98A14` | Third; never for text |
| `--telga-vellum-rule` | `#A8916A` | The faint ruling laid before writing |

**Leather (console)**

`--telga-leather-ground` `#2A1D14` · `-ground-raised` `#382718` ·
`-ground-deep` `#1E140D` · `-ink` `#EFDFC4` · `-ink-thin` `#B49A72` ·
`-rubric` `#E0604A` · `-indigo` `#7A93C8` · `-ochre` `#D9A83C` ·
`-rule` `#5A4231`

**Secondary text is tinted from its ground, never greyed.** Grey on a warm
ground reads as dirt. A test asserts both thinned inks keep a channel spread a
neutral grey would not have.

### Type

- Display: `'Noto Serif Ethiopic', 'Abyssinica SIL', 'Noto Serif', Georgia, serif`
- Body: `'Noto Sans Ethiopic', 'Abyssinica SIL', system-ui, …`
- Base **17px**, set for Amharic; Latin inherits the larger size.
- **No webfont.** The CSP forbids one and a counter's connectivity cannot be
  relied on — a sign-in screen that cannot draw its own labels is worse than
  one set in a system face. A test asserts no stack contains a URL.
- Money is `tabular-nums` with `tnum` on, so a figure never changes width as it
  changes and a column lines up digit for digit.

### Space, size, shape

4px grid (`--telga-space-xs` … `-xxl`). **Touch floor 48px** — Android's
minimum, not the web's 44, because this ships as an Android app. Primary action
56px. App bar 56px, tab bar 60px.

Corners are nearly square (2–4px): a folio is cut, not rounded. The radius only
stops a rule looking chipped where two meet.

Rules are tokens, because they are the structural element of this world:
`--telga-size-rule-hair|major|heavy`.

### Depth

Almost none. A manuscript has ruling and impression, not drop shadows. The two
shadows that exist give a fixed bar an edge over scrolling content, and each
carries a real offset and blur rather than a zero-offset halo.

### Motion

Android durations and easing. `--telga-motion-standard`
`cubic-bezier(0.2, 0, 0, 1)`; `--telga-motion-overshoot` for the signature
movement.

**The signature interaction: the stepped rule.** A settling entry moves its
rule to the margin in one whole-line step with a single overshoot; a pending one
**halts short of the margin**. Nothing glides continuously — a scribe lifts the
hand and sets it down. Everything is inert under `prefers-reduced-motion`,
which Android's *Remove animations* sets.

## Components

**There are no cards.** The page is the skin and ruling separates content. A
card would be a second material this world does not contain, and same-size
cards as page structure is the category default this refuses.

- **Rules reach the page edge.** A rule that stops short *means* something here.
- **Harag band** opens a section, full-bleed, drawn from the three structural
  inks. The one ornament, and it is structural.
- **The balance leads.** The available figure is the largest thing on the
  merchant home screen, its unit **rubricated** and set small beside it. Red ink
  marks what kind of thing a number is, which is what rubrication is for.
- **Primary action**: a rubricated block seated on a heavy rule, one per screen.
  Not a pill — this world rules and fills, it does not round.
- **Active tab is inverted, not tinted.** Rank is inversion here, and inversion
  survives a monochrome screen where a tint does not.
- **Console navigation** is a horizontally scrolling snap strip: fourteen
  destinations cannot fit a bottom bar, and they are not rankable.
- **Console tables scroll sideways rather than restacking.** Column
  relationships are what a reconciliation screen is read across.

## Phases — never colour alone

§22 requires status as text + icon + colour. Here a phase is **a name, a rule
pattern and an ink** — three carriers, and the pattern survives a monochrome
thermal print, a photocopied statement, and a reader who cannot separate red
from green.

| Phase | Pattern | Ink |
|---|---|---|
| Settled | solid, full width | rubric |
| Working | dotted | indigo |
| Pending | dashed, **stops short of the margin** | indigo |
| Under review | double | ochre |
| Failed | solid + struck | ink |
| Reversed | double + struck | rubric |

Tests assert no two phases share a pattern, and that **pending never borrows
failure's ink** — §15 is explicit that a timeout is not a failure.

Struck-and-re-entered is the ledger's own grammar: §13 invariant 8, corrections
are authorised adjustment entries, never silent edits.

## Browser surfaces

Selection, caret, accent and focus ring are themed from the palette on both
surfaces. Focus is a 3px rubricated outline at 2px offset. These ship with
browser defaults that belong to no design system, and theming them is the
cheapest signal a page was built rather than assembled.

## Constraints this world must keep

- The `TRAINING — NO REAL VALUE` banner is unconditional, on screen and on
  every printed slip, and outranks every layer.
- 58 mm / 80 mm thermal print styles survive: the shell, the tab bar and the
  harag band are all `display: none` in print. Ornament costs thermal ink.
- Every `data-testid` is contract, not incidental markup.
- English and Amharic; Amharic readability sets the type scale.

## Known open

- The app bar carries only the menu control. It has room for the Telga mark and
  does not yet use it.
- Ledger-row phase rules are implemented and token-backed but not yet used by
  the transaction screens, which still render their own status vocabulary.
- Amharic strings remain a draft needing native review before production.
