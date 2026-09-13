# Product

<!-- impeccable:product-schema 1 -->

## Platform

android

Delivered as **one Android app** — `et.mulesoo.telga`, a Capacitor shell in
`apps/mobile/` — installed on both merchant phones and smart-POS terminals.
There is no second "POS app" (`CLAUDE.md` §18.0, D68/D106).

**The design language is Android; the implementation is server-rendered HTML.**
The shell hosts screens rendered by `apps/merchant-pos/` and reached over HTTP;
there are no native widgets and no bundler. Recorded as `android` rather than
`web` because the founder chose Android motion and structure conventions
(2026-09-12) and because the artifact a merchant installs is an APK, not a site
they visit. Nothing here licenses a claim of native controls.

## Users

**Primary — the shop operator.** An Ethiopian shopkeeper or their assistant,
standing at a counter, selling airtime to a customer who is waiting. Often
one-handed, frequently holding the customer's phone in the other hand to read a
number off it. Works in daylight, sometimes outdoors. May be the owner or an
employee on a shared device; each device belongs to exactly one shop.

**Secondary — the shop owner.** Same app, different questions: what did we sell,
what is our balance, what did we earn, where is the money I deposited.

**Separate audience — Telga staff.** The operations console
(`apps/operations-console/`) is a different application for a different person:
an operations desk approving shops, verifying deposits, deciding transfers and
answering complaints. Different users, different auth, different threat model,
same backend and database (§18.0).

## Product Purpose

Ethiopian shops run digital vending on disconnected tools: Flash/Kazan-style
machines, phone apps, USSD, separate electricity systems, paper notebooks, manual
commission tracking. Telga replaces that with **one dependable workflow** for
selling, managing selling balance, tracking commission, printing and reprinting
receipts, finding transactions, surviving provider failures, reconciling funds,
and getting support.

Success is a shop that trades through a provider outage without losing money, can
answer "where did this transaction go" from the counter, and can see what it
earned without a notebook.

## Positioning

> **One machine. More services. Clearer business.**

Telga is an **authorized-provider merchant platform**. It is explicitly **not** a
bank, wallet, lender, payment institution, or custodian of customer money (§2).

The mechanism a neighbouring product could not truthfully copy: an append-only
double-entry ledger in integer minor units behind every merchant-facing number,
with idempotency and reversal handled as authorised corrections rather than
edits — so "clearer business" is an accounting property, not a dashboard.

**Never claim** "always instant", "never fails", or "first in the market" (§5).

## Operating Context

- **The counter.** Transactions happen with a customer present and waiting.
  Internal targets: Telga processing under 1s, a normal successful sale under 10s
  — internal targets, never public guarantees (§14).
- **Two device classes, equally weighted** (founder, 2026-09-12): a merchant's
  own Android phone (~390–430px, one-handed, thumb reach) and a smart-POS
  terminal on a counter (larger fixed screen, seen at arm's length and often at
  an angle, printer attached). The same screens must work well on both. POS
  hardware is **not yet chosen** (`ASSUMPTIONS` A101).
- **Printing.** Thermal roll, 58 mm or 80 mm, whichever the shop bought. Telga
  speaks no printer protocol; it hands the slip to the device's own print stack.
  Paper shortage is never a transaction failure (§18.5).
- **Bilingual.** English and Amharic. Amharic is currently a draft requiring
  native review before production.
- **Unreliable middle.** Provider outages isolate airtime while other approved
  services keep working; no offline vending in pilot (§16).

## Capabilities and Constraints

- **TRAINING MODE — NO REAL VALUE.** Every launch gate in §8 is open, so the
  platform runs simulated funds under an unconditional banner. `money.live` and
  `payments.acceptance` are off and asserted at start-up.
- **Scale target: 1000+ shops** on one backend, one console, one database, each
  shop a tenant record with no cross-tenant leakage (§18.4).
- **Money belongs to the shop, not the device.** Every till in a shop draws on
  one balance (§18.3). Any design assuming per-device balances is describing a
  different product.
- **Server-rendered, one response, no bundler.** Every screen is a function
  returning HTML. This is deliberate: a second implementation of the vending
  flow is a second place a duplicate sale can originate (§18.0).
- **~1970 tests assert on `data-testid` attributes.** They are part of the
  contract, not incidental markup.
- **Disabled until legal review:** electricity, data, wallets, payment
  acceptance, cash-in/out, lending, remittance, general bill payment, offline
  vending, independent custody and settlement (§7).

## Brand Commitments

- **Names:** Telga, by MuleSoo Digital Services. The Telga mark exists in
  `apps/merchant-pos/src/ui/logo.ts`.
- **The `TRAINING — NO REAL VALUE` banner is unconditional** on screen and on
  every printed slip, drawn by the shell rather than passed in by a caller, so
  no screen can omit it.
- **The console must remain visually distinct from the merchant app.** A Telga
  employee suspending a merchant and a shop assistant selling airtime must never
  be one keystroke from thinking they are in the other application (§18.0).
- **Released 2026-09-12:** the merchant app's look was previously "modelled on
  the reference terminal the founder supplied" — brand-colour field, white
  rounded cards, black pill actions. The founder has released that reference; it
  is now evidence and anti-reference rather than a constraint. The *name*, the
  *mark*, the banner and the console/app distinction remain binding.

## Evidence on Hand

- **The founder's brief**, 12 pages, transcribed 2026-08-19. Kept outside this
  repository.
- **An Obsidian vault** at `docs/obsidian/` — 107 published notes including
  `04 UX UI/Design System`, `Screen Inventory`, `English Strings`,
  `Amharic Strings`, `Receipt Specification`, and a Decision Log at D161.
- **No pilot data, no merchant interviews, no provider contract, and no
  commission figures exist.** Phase 0 is incomplete. Nothing may present a
  rate, a price, a provider name, or a legal approval as real (§30) — including
  in mock data on a screen.
- **No photography, illustration, or icon set** is on hand.

## Product Principles

1. **The ledger is the product.** Every number a merchant sees must be
   answerable from an append-only double-entry record. A screen that displays a
   figure the ledger cannot explain is a defect.
2. **Uncertainty is a state, never a guess.** Pending is not failure, a timeout
   is not a failure, and an unknown outcome is never auto-resolved in either
   direction.
3. **The counter sets the pace.** A customer is waiting. Fewer steps, one
   primary action, and no interaction that punishes a shopkeeper for moving
   fast.
4. **Say what is true, including when it is unflattering.** Training mode is
   announced, single-factor mode is announced, a relaxation nobody can see
   becomes an accident.
5. **Two applications, never one.** The merchant app and the staff console share
   a backend and must never share an appearance.

## Accessibility & Inclusion

- **Status is conveyed by text + icon + colour, never colour alone** (§22).
- **Large touch targets**: operated at speed, one-handed, by someone whose
  attention is on a customer.
- **Readable Amharic typography.** Ethiopic glyphs carry more strokes per
  character than Latin and are set for legibility first; Latin inherits the
  larger scale rather than the reverse.
- **High contrast**, for a screen used in daylight.
- Every destination reachable by keyboard, and no control that exists only as an
  icon without a name.
