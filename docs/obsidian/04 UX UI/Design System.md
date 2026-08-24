---
title: Design System
type: ux
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - ux
  - design-system
related:
  - "[[00 Home]]"
  - "[[Screen Inventory]]"
  - "[[English Strings]]"
  - "[[Amharic Strings]]"
depends_on: []
implements: []
validates: []
decision_status: assumption
---

# Design System

Built for a busy counter: an Android phone or a small smart-POS screen, used standing up, often
one-handed, sometimes in bright daylight, by someone with a customer waiting.

## Principles

1. **Fast for counter service.** The common sale is reachable in the fewest taps that still allow confirmation.
2. **High contrast.** Legible in daylight and under a shop's fluorescent tube.
3. **One primary action per screen.** Everything else is visually secondary.
4. **Large touch targets.** Minimum 48 × 48 dp, with generous spacing between destructive and routine actions.
5. **Never colour alone.** Every status carries **text + icon + colour**. A red badge without words is a defect — see [[Screen Inventory]].
6. **Safe against accidental duplicate sales.** Confirm buttons disable on press; no retry control exists on processing or pending screens. See [[Idempotency]].
7. **Bilingual by construction.** No string is hard-coded; layouts tolerate Amharic's longer words.

## Colour tokens

Status colour is a *reinforcement*, never the message.

| Token | Role | Light | Dark |
|---|---|---|---|
| `--telga-brand` | Brand, primary action | `#F6C445` | `#F6C445` |
| `--status-success` | Successful | `#2F7D3F` | `#5FBF74` |
| `--status-failure` | Failed, rejected | `#B3261E` | `#F2836B` |
| `--status-pending` | Processing, pending | `#9A7B12` | `#E5C158` |
| `--status-review` | Under review | `#5B3FA8` | `#B9A2F0` |
| `--status-offline` | Offline, unavailable | `#5A6572` | `#A6B2C0` |
| `--training-banner` | Training mode | `#7A2E8F` | `#D9A6E8` |

Contrast target: **WCAG AA (4.5:1)** for body text, **3:1** for large text and status icons, in
both themes.

> [!note] Brand colour
> Yellow is taken from the founder's description of the Telga terminal. Exact brand values are an
> **assumption** until a brand decision is recorded in [[Decision Log]].

## Typography

| Use | Latin | Ethiopic |
|---|---|---|
| Family | System sans (Roboto) | Noto Sans Ethiopic |
| Body minimum | 16 sp | 17 sp |
| Numeric (amounts, IDs) | Tabular figures | Tabular figures |

Ethiopic glyphs are visually denser than Latin at the same point size; body Amharic is set one
step larger and with slightly increased line height. Amounts and transaction IDs are **always**
Latin numerals with tabular figures so columns align and digits cannot be misread.

## Spacing and layout

- Base unit 8 dp; touch targets 48 dp; primary action 56 dp tall, full width.
- Single-column layout on phones and POS alike — no side-by-side controls at the counter.
- The primary action sits at the **bottom**, in thumb reach, never beside a destructive one.

## Status presentation

| Status | Icon | Word (English) | Colour token |
|---|---|---|---|
| Processing | spinner | Processing | `--status-pending` |
| Pending | clock | Transaction pending | `--status-pending` |
| Successful | check | Transaction successful | `--status-success` |
| Failed | cross | Transaction failed | `--status-failure` |
| Under review | magnifier | Under review | `--status-review` |
| Provider unavailable | plug | Provider temporarily unavailable | `--status-offline` |
| Offline | cloud-off | Sales temporarily unavailable | `--status-offline` |

## Training mode banner

While `training.mode` is on, a persistent banner sits above all content on **every** screen:

> **TRAINING MODE — NO REAL VALUE**

It is not dismissible, and it uses `--training-banner` with white text.

## What the built POS implements

[[Merchant POS Screens]] applies these rules, and `tests/ui/screens.test.ts` asserts them on every
screen rather than on the screens someone remembered to check: one `h1`, an accessible name on
every focusable control, a `<label for>` on every visible field, `aria-current` on the current
navigation destination, status as text + icon + tone, and a decorative status icon marked
`aria-hidden`.

Colour is a hook only. `PENDING` and `UNDER_REVIEW` share a tone deliberately, and a test asserts
their **labels differ** — so the two are distinguishable with no colour at all.

## Related

- [[Screen Inventory]]
- [[English Strings]]
- [[Amharic Strings]]
- [[Receipt Specification]]

---
Back to [[00 Home]]
