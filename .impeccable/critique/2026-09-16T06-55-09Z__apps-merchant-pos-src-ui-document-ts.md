---
target: the Telga merchant app
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 4
target_identity: "file:C:\\Users\\mule\\OneDrive\\Desktop\\Telga\\apps\\merchant-pos\\src\\ui\\document.ts"
target_fingerprint: "sha256:19039690777ba7cee705e348d143f9a2a5bd90d400b32d50121413f44bdff16b"
target_path: "C:\\Users\\mule\\OneDrive\\Desktop\\Telga\\apps\\merchant-pos\\src\\ui\\document.ts"
timestamp: 2026-09-16T06-55-09Z
slug: apps-merchant-pos-src-ui-document-ts
---
**Method: dual-agent** (A: design review, isolated · B: detector + live browser evidence, isolated)

# Design Critique — Telga merchant app

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | **3** | `status.ts` is exemplary — uncertainty stated *in words*, `do-not-retry` rendered first with `role="alert"`. But 14 of 16 dashboard tiles give no status until after the tap; the only signal is a 9.6px badge measured live at **3.24:1** |
| 2 | Match System / Real World | **3** | "Do not retry yet" is exactly right. Against it: nav labels are terminal jargon (`Prepaid`, `Re-print`), and sign-in asks a shopkeeper for a "Device key" — a 256-bit secret — as a daily credential |
| 3 | User Control and Freedom | **2** | Back is inconsistent by screen. The 404 page is **85 bytes** — no shell, no links, no route back, just `No such screen.` |
| 4 | Consistency and Standards | **1** | Three parallel nav systems; two bottom tabs with identical href and identical label; two design systems stacked in one stylesheet; four different focus-ring specifications |
| 5 | Error Prevention | **2** | Strong server-side (no pre-checked radio, `data-once`, server re-derives). Undercut by seven 13×13px checkboxes on Settings — including `screenLockEnabled`, a security control |
| 6 | Recognition Rather Than Recall | **2** | `Vouchers` and `Airtime` are adjacent tiles; `/vouchers` is a list containing exactly one item — Airtime |
| 7 | Flexibility and Efficiency | **2** | Real accelerators exist. But a sale is nine screens against §14's 10-second target |
| 8 | Aesthetic and Minimalist Design | **2** | Result screen stacks ten slips above five near-identical actions. Every tile label is underlined; "pills" render as 173×132px ellipses |
| 9 | Error Recovery | **3** | `REFUSAL_TEXT` distinguishes "this operator" from "this shop". Excellent copy — with no styling at all: `.notice` and `.field__hint` have no CSS rule |
| 10 | Help and Documentation | **3** | Learning module, Help in menu, well-judged PIN hint. No help on Vouchers vs Airtime |
| **Total** | | **23/40** | **Acceptable — significant improvements needed** |

Diverges from Assessment A by one point on Error Prevention (A gave 3): a 13×13px checkbox controlling screen lock is an error the design invites rather than prevents.

## Design Specificity Verdict

**Authored — but the authored part is largely not on the screens a shopkeeper uses.**

**LLM assessment.** `tokens.ts` records its own contrast arithmetic inline; `ochre` is split into decorative and readable inks because the TRAINING banner "spent one deploy at 1.87". The phase system gives every state a pattern as well as an ink, and pending's rule stops at 62% of the width.

The stylesheet is two design systems stacked, and the old one wins on most screens. Lines 239–1078 are the abandoned reference-terminal system that PRODUCT.md says was released as an anti-reference; 1079–1463 are the scribal shell, appended rather than substituted. The old system still owns four `card`-named classes in a world whose DESIGN.md says "There are no cards", and a `border-radius: 999px` pill holding the balance in a world that says "Not a pill".

`#122E30`, the released reference teal, is still the `theme-color` meta — so Android paints the status bar and task-switcher card in a colour the design system abandoned.

**Deterministic scan.** 3 findings, one rule, one file: `side-tab` at document.ts:411, 833, 841. Two are false positives (833/841 are drawn arrowhead glyphs). The third is real and was introduced 2026-09-15 — the `border-left: 4px solid rubric` on the service cards is exactly the pattern that rule catches. Verified complete with `--no-config --no-design-system --no-inline-ignores`.

`.impeccable/design.json` is stale against tokens.ts — records `rubric: #C0341F` and `inkThin: #6B5636`, lacks `ochreInk`. The detector grades against a superseded palette.

**Visual overlays: none.** Both browser MCP servers failed to connect. Assessment B obtained live evidence anyway via headless Chrome over raw CDP, provisioning a training shop in a scratch database and measuring computed styles at 390×844. No overlay was injected. The live pass corrected its own static maths: 5.86:1 became 3.24:1 once browser opacity compounding (0.7 × 0.72) was measured.

## Overall Impression

The engineering judgment is better than the interface. Uncertainty is a first-class state, the ledger grammar reaches the visual system, and nearly every questionable line has a correct comment above it.

Biggest opportunity: the prose is better than the CSS it sits above. DESIGN.md states one primary per screen, no cards, no pills, a 13px type floor, real inks rather than opacity — each violated somewhere, always with a paragraph nearby stating the rule correctly.

## What's Working

1. **`status.ts`** — `CERTAINTY_TEXT` puts certainty in words; `doNotRetryYet` is emitted before the status detail with `role="alert"` so it is first for a screen reader; `RESULT_CARD` maps on certainty rather than state so a new state cannot fall through to a tick.

2. **The phase system** — three carriers per state. The pattern survives monochrome thermal print, photocopy, and red-green colour blindness; "pending must not borrow failure's ink" is enforced at token level.

3. **`slipCard` drawing its own banner** — drawn inside the function, not passed as a parameter, so no caller can print without it. The code notice sits beneath the code because a customer reading a PIN needs the warning next to the PIN.

## Priority Issues

### [P0] Cancel renders in the same vermilion as Confirm
document.ts:1244 declares `.pos main button[type="submit"], .button--primary` at specificity 0,2,2. Modifiers `.voucher__button--cancel` and `--print` are 0,1,0 and lose. Every submit inside `<main>` becomes the one-per-screen primary. On the PIN screen: three identical vermilion blocks (Confirm, Cancel order, Main). It inverts §18.5 — Reprint is a submit, so the button that appends an audit record is the loudest on the slip screen.
**Fix:** restrict the selector to `.button--primary, .voucher__button--primary`; tag the genuine primary per screen; add a test for at most one primary per rendered screen.
**Command:** `/impeccable polish`

### [P1] Seven 13×13px checkboxes on Settings, one a security control
document.ts:1317 excludes checkboxes by name from the 48px floor. Measured live at 13×13px with 22px sibling labels. Affects `screenLockEnabled`, `hideBalance`, `statementsAdminOnly`, `printBarcode`, `printLookupSlip`, `lowBalanceAlert`, `soundEnabled`.
**Fix:** wrap in the label and give the label the floor, or style to 24px with a 48px hit area.
**Command:** `/impeccable audit`

### [P1] No text input in the app uses the Ethiopic font
Every input renders `font-family: "Arial"` with a UA inset border. `font-family` is not inherited by form controls and document.ts:1317 sets only min-height and font-size. The type system exists for Ethiopic legibility; Amharic typed into any field renders in the fallback face.
**Fix:** `font: inherit` on the input rule.
**Command:** `/impeccable typeset`

### [P1] `.field` has no CSS rule, so every form is unstyled
Only `.lock .field` exists. `.field__hint` and `.notice` have no rule. Label and 48px input sit on the same line with no gap or boundary — on sign-in (four groups, two secrets), PIN, settings, registration, and the Amharic draft warning.
**Fix:** add `.field { display:flex; flex-direction:column; gap: var(--telga-space-xs) }` plus hint and notice rules to the scribal section.
**Command:** `/impeccable layout`

### [P1] Ethiopic at 10.4px and 9.6px, and the grid runs the wrong way at phone width
`rem` resolves against the 16px root, not body's 17px, so 0.65rem/0.6rem are 10.4px and 9.6px — below `--telga-type-xs` (13px). The badge compounds two opacities to 3.24:1. `@media (max-width: 26rem)` drops to 3 columns below 416px — the common Android width — making sixteen tiles six rows and pushing the balance below the fold.
**Fix:** floor at 13px, drop opacity stacking for `ink-thin`, move the breakpoint to 4 columns at 390px.
**Command:** `/impeccable typeset`

## Persona Red Flags

**Casey (one-handed, 390px)** — `pin-clear` is a `type="reset"` immediately left of `pin-confirm`, wiping a half-typed PIN with no undo, within a thumb's width on a wrapping flex row. Three vermilion blocks on that screen. Bottom nav labels wrap to two lines at 62×96px; two of five tabs share a destination and a word. Balance sits below a six-row grid.

**Sam (screen reader, keyboard, contrast)** — `.dashboard__add` focus ring measures 2.52:1 against its own ink ground, below the 3:1 non-text minimum. Four ring specifications coexist. `.card__result--*` distinguishes three outcomes by background hue alone, twenty lines above the `[data-phase]` system that solves it. `.dashboard__reveal summary` has no accessible name. `.menu__panel` promises `role="menu"` arrow-key navigation that is not implemented. Opacity is the de-emphasis mechanism in eight places, against the launcher's own comment.

**Jordan (first-timer)** — Four sign-in values, two secrets, one a 256-bit device key transcribed from paper into an obscured field with no reveal toggle. The refusal never says which field was wrong; four attempts is a five-minute lockout. Then sixteen tiles of which two work, distinguished only by an illegible badge.

## Minor Observations

- dashboard.ts header and document.ts:539 say "twelve" tiles; the array holds sixteen.
- Dead CSS ships for the screen removed 2026-09-15: `.launcher__single`, `.launcher__telga*`, `.launcher__back-row`, holding all five verdigris rgba literals. `.banner__*` and `.pos__identity`/`.pos__footer` also survive their deleted elements.
- Dead modifier classes ship in the DOM on every tile with no matching rule.
- 13 hard-coded colour literals outside the token system.
- Every screen reserves ~66px bottom padding for a tab bar the vending flow never renders.
- The logo animation appears nowhere in the authenticated app.
- `prefers-reduced-motion` coverage is complete — four blocks, every keyframe neutralised.
- Undefined custom properties: none. All 43 consumed tokens resolve.
- `SAFE` in tokens.ts is never emitted by `cssVariables()` — a latent trap.

**Not audited:** pending/under-review/reversal states (need a posted sale and PIN per screen), and the entire Amharic locale — the largest remaining gap given inputs render in Arial.

## Questions to Consider

1. The balance is the one number a shop opens the app for — why is `balance__lead` only reachable on `/home`, a URL nothing links to? Is the tile grid a design decision or the released reference terminal under a new palette?
2. Fourteen of sixteen tiles advertise products with no provider or route, qualified by a badge at 9.6px and 3.24:1. If the disclaimer is illegible, is the tile still qualified?
3. What would change if each careful comment were a test? One primary per screen, no colour literal outside tokens, no font-size below `--telga-type-xs`, no two nav entries sharing an href.
