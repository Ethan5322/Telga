# Changelog

All notable changes to Telga. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

> **Operating state: TRAINING MODE — NO REAL VALUE.**
> No live provider is connected, no live money is enabled, and 0 of 10 launch gates in
> `docs/obsidian/07 Governance/Launch Gates.md` have been cleared.

## 2026-09-09 — vendor registration from the app, and a suspension hole closed

**Still TRAINING MODE — NO REAL VALUE.** No live provider, no live money, 0 of 10 launch gates.

### Decided

- **Self-service vendor registration is opened** (D138), reversing the *registration* half of
  D113(b). The **device** half is untouched: a device still may not provision itself.
  Two accepted decisions had been contradicting each other — `Admin Operations Console`
  Decision 3 described an applicant registering from the app, D113(b) forbade it, the build
  followed D113(b), and `CLAUDE.md` described no registration flow at all.

### Added

- **`Register as Telga member` in the Telga app** — `GET`/`POST /register` on the merchant server,
  reachable with no session, in English and Amharic. A submission creates **one** application
  row and nothing else: no merchant, no operator, no device, no credential, no session.
- **Path B in the console** — *"Approve immediately — I have seen these documents"* on the
  Register Telga User form. Admin creation is the approval; the audit trail records
  `path: 'DIRECT'` so an approval with no second pair of eyes stays distinguishable.
- **Migration 018** — `merchant_applications.submitted_via` (`ADMIN` / `SELF_SERVICE`) and a
  `registration_attempts` throttle table storing a **salted hash** of the caller's address,
  never the address.
- **Feature flag `registration.self_service`**, gating `/register` as a tree. Its own flag, not
  part of `airtime.vending`: closing the one anonymous write surface must be one switch.
- **A `Source` column in the console's review queue**, showing **Unverified — from app** so a
  reviewer cannot mistake a stranger's typing for a folder an admin held.
- **22 tests** in `tests/admin/vendor-registration.test.ts`, over a real socket.

### Fixed

- **A suspended shop's operators could still sign in.** `signIn` read
  `merchant_users.status` and never `merchants.status`, so suspending a merchant stopped it
  selling — `createSale` already refused — while its operators kept signing in and holding live
  sessions until they chose to sign out. `signIn` now refuses `MERCHANT_NOT_ACTIVE`, and
  `authenticate` revokes a live session on the next request. Risk register **R40**.

### Changed

- **The application intake write is now one function.** `recordApplication` in
  `@telga/persistence`; the console's ~70 lines of inline SQL were replaced by a call to it.
  Two hand-written copies of an intake write is how the two drift.
- **`CLAUDE.md` §18 restructured** — §18.0 one app / one backend / one console, §18.1 vendor
  registration, §18.2 device registration (was §18.1), §18.3 shop-versus-device boundaries,
  §18.4 the honest position on 1000+ tenants. §27's repository tree corrected to the real
  directory names.

### Documentation corrected

- **`Phone and POS Install` claimed there is no Android application in this repository.**
  Written 2026-08-30; D106 built one on 2026-08-31. Corrected.
- **`Multi-Shop Onboarding`'s "no public route" caveat** superseded, and its "built but not
  reachable" warning narrowed: intake now has a route, **redemption still does not** —
  `redeemEnrollmentToken` is tested and has no HTTP caller, so first-run device pairing by
  activation code is not yet wired.

### Known limits, recorded rather than fixed

- The registration throttle's salt is **per-process**, so a restart empties every bucket (A106).
- Without `--trust-proxy`, every caller behind one edge shares a bucket (A106, R42).
- **No written review procedure exists for unverified applications** (A107).
- **D103 — per-shop databases versus one shared database — is still deferred**, and
  self-service registration shortens the runway to the second real shop that ends the
  deferral (§18.4).

## 2026-09-05 — deployment target decided, and a sizing claim corrected

**Local development only.** Nothing has been provisioned, deployed, subscribed
to or purchased. No domain configured.

### Decided

- **One Railway service with a persistent volume, keeping SQLite** (D108). The
  requested Supabase + Vercel plan was found already documented as
  deployment-blocking, and inspection confirmed it: the POS and console are Node
  HTTP servers, not static bundles, so Vercel cannot host them at all.
- **PostgreSQL/Supabase migration deferred** (D108), requiring its own plan and
  the founder's separate approval.

### Added

- **CIDR ranges in `--trust-proxy`** (D109), so a platform terminator whose
  address is drawn from an internal pool can be named. `0.0.0.0/0` and `::/0`
  are refused **in the parser**, so the trust-all setting cannot be spelled as a
  range; a malformed entry is refused at startup rather than silently matching
  nothing. **No hosting platform's range is built in.**
- **`PROXY_PEER_OBSERVED`** — an untrusted forwarding hop is reported once,
  naming the address, so a missing `--trust-proxy` entry is a log line instead
  of a sign-in that silently fails. Observing an address never trusts it.
- **`scripts/deploy/railway-start.mjs`** — migrates as a single writer, then
  runs the worker and the POS on one SQLite file, and stops both if either
  exits. Refuses a database path outside the mounted volume, a missing variable,
  or any mode but `TRAINING`.
- **`railway.json`**, pinned to one replica — a second replica is a second
  writer on the same file.
- 28 tests for range parsing, containment, startup refusal and the diagnostic.
- [[Localhost Setup]] and [[Railway Deployment Checklist]].

### Fixed

- **A sizing claim that was wrong and was being believed.** `driver/types.ts`
  and [[Vercel Deployment Limits]] both said moving to Postgres meant writing one
  more driver file "and changing nothing else". The interface has zero
  Promise-returning methods and a synchronous `transaction<T>(work: () => T): T`;
  the real cost is an async refactor across ~80 files and 21 transaction call
  sites, plus re-proving the claim lease on a new engine. Corrected in both
  places (A96).
- A separator bug in the new supervisor's volume check, found by its own test:
  it compared paths with a hard-coded `/`, so the guard misfired on Windows.

### Verified, not assumed

`npm test` — **88 files, 1385 tests, all passing**. Migrations 001–014 on a
fresh database, health and readiness, restart persistence, backup and restore
(identical checksum, `appendOnlyVerified`), a restored database serving traffic,
and the supervisor stopping the POS when the worker dies.

### Not done

Nothing is deployed. The Railway edge's forwarding range is unverified (A93),
the arrangement has never run on Railway (A94), and the ~$2.50/month estimate is
from published rates, not a dashboard (A95).

## 2026-09-06 — payment and voucher surface lockdown (B7)

Founder decision **D112**: the training scope is airtime vending simulation and
platform operations only.

### Changed

- **`card.simulated` and `product.data` are off.** Telga Pay and the data
  voucher flow are refused in UI, navigation, API and roles. Neither is deleted
  — the screens, ports and migration 009 stay in the tree, unreachable.
- **`card.simulated` now gates the whole `/pay` tree.** It previously gated
  `/pay/card` alone, which would have left nine Telga Pay routes answering
  normally with the flag off: buttons gone, every page reachable by address.
- **`deposits.training` now gates `/api/training/pay/deposits`.** It previously
  gated `/deposit`, a path no route in the system uses — so it gated nothing.
- Navigation entries for Telga Pay and data vouchers are conditional on their
  flags: the launcher tile, the dashboard payments tab, two top-up options and
  the voucher data category.

### Kept

- **`deposits.training` stays on**, audited against nine conditions: refuses any
  mode but `TRAINING` before reading an amount, bounded 10–50,000 birr, balanced
  append-only posting against `BANK_CLEARING`, audited, and importing no HTTP
  client or provider.

### Tests

- `tests/ui/card-screens.test.ts` rewritten from rendering the card screens to
  proving they are refused — all twelve Pay paths, for a signed-in operator, an
  unauthenticated caller, and a POST whose body is never read, with a ledger
  count asserting nothing was written. Card *flow* logic remains covered by
  `tests/application/card-payment.test.ts`.
- `tests/domain/feature-flags.test.ts` updated to the new register and asserts
  the two flags remain separate switches from `payments.acceptance`.

## 2026-08-30 — admin identity foundation (Phase C)

The schema and domain model for the Telga Operations Console. **Nothing reads
or writes these tables yet** — see `ASSUMPTIONS.md` A85–A88.

### Added

- **Migration 014** — `admin_users`, `admin_permissions`, `admin_sessions`,
  `tenant_registry`, `merchant_applications`. Five new tables; nothing existing
  altered, and a test asserts that `merchant_users`, `sessions`, `devices` and
  `merchants` are byte-identical before and after. (D102)
- **`packages/domain/src/admin.ts`** — seven administrative roles, 31
  permissions, individually switchable grants, step-up re-authentication with a
  five-minute window, and dual control. A suspended account has no permissions
  whatever its role says.
- 38 tests: 23 on the permission model, 15 on the migration.

### Decided

- **Admin identity is a separate table** (D102). `merchant_users.merchant_id`
  is `NOT NULL`, so a Telga admin could not exist; making it nullable was
  rejected because that constraint is what makes cross-shop leakage
  structurally impossible.
- **One database per shop** (D103). Owner decision after the CLAUDE.md §9
  comparison. Costs recorded: N backups, 12 × N migrations, and a
  platform-wide ledger residual that becomes a sum over tenants.
- **Public registration creates nothing** until an admin approves (D104).
- **Biometric is a device passkey, never a stored template** (D105).

### Not built

Admin login, MFA enrolment, WebAuthn, the console UI, the registration form,
tenant connection routing, per-tenant migrations, and N-backup tooling.

## 2026-08-29 — remediation batch 1, and the founder's counter reports

### Fixed

- **Today's profit went negative when profit was collected.** `profitForDay`
  summed the same ledger account a transfer debits, so earning on Monday and
  moving it on Tuesday showed Tuesday as a day of losses, and moving again made
  it worse. `ADJUSTMENT` entries are now excluded — a transfer is a movement
  between the shop's own buckets, not an un-earning. `REVERSAL` is still
  counted, because a reversed sale really is un-earned. (D95)
- **A pending sale was shown under a green tick.** The result card was
  hardcoded to the success card and ✅ for every outcome; the words underneath
  said the result was unknown. Icon, colour and words now all derive from the
  transaction's certainty. (D94)
- **A backup manifest recording missing migrations printed `[object Object]`**,
  so it said the schema was incomplete without saying what was missing.
- **A leak check for worker internals could never fail** — its `` word
  boundaries were literal backspace bytes, so the pattern matched nothing.
- **A dropped connection rendered a blank reason on screen.** An unchecked cast
  turned a network error into a failure whose `reasonCode` was `undefined`.
- **`Promise<unknown | 'TOO_LARGE'>` collapsed to `Promise<unknown>`**, so the
  caller's sentinel check was never verified by the compiler.
- The support contact was a fake Ethiopian phone number. Removed rather than
  replaced: a string shaped like a number is one an operator will dial.

### Added

- **Feature flags matching the vault register**, name for name, with UI, API
  and role enforcement. The API layer answers `404`/`FEATURE_DISABLED` before
  authentication or any body read. `money.live` requires ten cleared gates and
  two assigned approvers, so it cannot be enabled. A test reads the vault note
  and fails if the code disagrees. (D92, D93)
- **RFC 7239 `Forwarded` is parsed**, not merely detected. Two forwarding
  headers that disagree are both disbelieved. (16 tests)
- **`transaction_attempts` and `provider_health_events`** — migration 013, both
  additive, with the domain model for them. Nothing writes to them yet. (D99)
- **Four researched service tiles** — internet, school fees, insurance,
  government fees — all `COMING_SOON`. (D100)
- ESLint and Prettier, wired into the scripts. 152 findings → 0.

### Changed

- **The launcher is the Telga mark, and it opens.** One app called Telga;
  tapping the logo reveals Telga Vending and Telga Pay. (D96)
- **The figure is bone and the letter is teal** — separated by thickness, not
  by colour, with the render's own modelling preserved. Icons rebuilt. (D97)
- **Printed slips name `TELGA TRADING PLC`** from one shared constant. (D98)
- Risk register: the duplicate `R23` is renumbered `R33`; `R30`'s title names
  the risk and its blocking status moved into the mitigation column; `R32` now
  describes the card *ports* rather than claiming no card code exists.
- `Device Binding` records D74 — the device key now persists in an `httpOnly`
  cookie, and what that costs.

## [Unreleased]

### Added — the real logo, the launcher, the menu, and shop settings (2026-08-28)

**Migration 012** — nine preference keys on `settings`, plus `shifts` and `customers`. Five tests
(`tests/persistence/migration-012.test.ts`) prove every existing setting survives, the key CHECK
still refuses a typo, a shift closes exactly once and is never deleted, a saved customer's number
is stored masked, and neither new table accepts a live-mode row.

**The mark is the founder's artwork now** (D81), served from `/assets/telga-logo.png` and shown
as an `img`. Two earlier attempts redrew it as SVG paths and both were rejected. The
fall → catch → stand sequence is a CSS rotation that **rests upright** — the supplied render is
the middle of that sequence, which is why a still copy read as "still falling". It plays on the
splash and the launcher, never on a slip, and stops for `prefers-reduced-motion` and printing.

**The splash offers a door into each app** — Telga Vending and Telga Pay — carrying the choice
through sign-in so an operator lands where they picked.

**A three-bar menu on every authenticated screen** (D82): operator id, Statements, End shift,
Customer list, Learning, Settings, Help, Log out. A `<details>` element, so it works with
scripting off; every entry is a link or a CSRF-carrying form and the server re-checks permission
on arrival.

**A "+" beside the balance**, opening a top-up screen with Bank deposit, Telga Pay and Profit.

**Settings** gained in-app toggles (sound, hide balance, low-balance alert), admin-only options
(statements admin-only, print barcode, print lookup slip, require PIN to unlock), a configurable
screen-lock time, and links to About, Terms, Privacy and Cookie. Each toggle carries a hidden
`off` companion so an unchecked box still submits.

**Shifts and saved customers.** A shift is a labelled span of time carrying no money; closing is
single-winner and never deletes the row. A saved customer is a name beside a **masked** number
(D83) — deliberately, because a list of full numbers on a counter machine would be the largest
pool of personal data in the product.

**Policy and support text ship as marked placeholders** (D84). Each policy opens by saying it has
had no legal review and must be replaced. The support contact is a marked placeholder rather than
an invented number somebody might dial during a real dispute.

### Fixed — settings stopped loading entirely

`pinLockEnabled` on the settings response contained "pin", which `assertSafeForDisplay` refuses
by design — so **every settings read returned 500**, and with it the slip width, the shop
advertisement and the whole Settings screen. Renamed to `screenLockEnabled`; the screen still
*labels* it "Require PIN to unlock", which is what an owner calls it. The guard was not
weakened — that is the third time it has caught a key of mine, and each time it was right.

### Changed — a CSS colour, to keep a security test blunt

`#223049` is six digits, which tripped the "no six-digit run in a rendered page" guard that
exists to catch a leaked PIN. The colour moved one step to `#22304a` rather than the test being
loosened.

### Not built, and why

**"Change password"** — there is no password in Telga. Sign-in is operator id + PIN + device key;
no password exists in the schema, the auth code, or the login form. A button that changes nothing
would be worse than its absence. Change PIN exists and works. If a password is genuinely wanted
it is a new authentication factor — a schema change, a login-flow change, and a security
decision. Recorded as `ASSUMPTIONS.md` A76.

### Added — cover screen, profit transfer, owner PIN, corporate settings (2026-08-28)

**Migration 010** — `pending_orders.quantity` (1–20) and `total_minor = amount_minor * quantity`,
for bulk printing. **Migration 011** — six corporate keys on `settings`. Both rebuild their
table, as SQLite cannot alter a CHECK. 4 tests
(`tests/persistence/migration-010-011.test.ts`) prove every existing row survives byte-for-byte,
that pre-existing orders default to one voucher, that the new CHECKs refuse a mismatched total
and an out-of-range quantity, and that `integrity_check` and `foreign_key_check` stay clean.

**A cover screen** at `/splash` (D77) — public, shows the mark and one Sign-in action, and every
unauthenticated redirect now lands there. It carries no merchant, device, operator or balance:
none of that is known before sign-in.

**Moving profit into the selling balance** (D78). The dashboard Profit pill opens a screen with
one box; the ledger posts a balanced `ADJUSTMENT` pair. Bounded by **all-time profit not yet
moved**, checked and posted inside one database transaction. Owner-only, CSRF-protected,
rate-limited as a sale is, audited. It is a move, not a payout — nothing leaves Telga.

**Owner-changeable transaction PIN** (D79), requiring the current PIN: an open session is
deliberately not enough. A wrong current PIN counts as a `PIN_AUTH` failure and can never
contribute to a login lockout. The PIN reaches no log, response, audit metadata, cookie or
redirect URL.

**Corporate settings** (D80) — business name, address, phone, TIN, trade licence and a slip
footer, printed under the mark on every slip. Carried on `SlipStyle`, so a new slip type cannot
forget them. **Telga verifies none of them.**

**The Telga mark**, redrawn (D76). The first version was rejected for showing an upright T with
a figure beside it; the letter now tips as one rotated group, its foot lifts at the heel, the
ground slopes the way it is falling, and the figure is in a deep brace with both arms locked
into the stem. Verdigris on cut stone, transparent, with a flat mono variant because a thermal
head is one bit per dot.

### Fixed — a slip printed twenty-one stars where a phone number goes (2026-08-28)

Voucher sales written before the recipient fix stored the *mask of a placeholder*:
`VOUCHER-SALE-NO-RECIPIENT` masked down to `VO*********************NT`. On paper that is a row
of stars on a product that never had a phone number — and it was being read as a **masked
voucher PIN**, which is how one bug arrived as three separate retest failures ("PIN masked with
stars", "phone shown when it shouldn't", "on-screen slip looks wrong").

Fixed at read time rather than by a migration: the transaction table is history, and rewriting
what those rows say happened would be worse than declining to print a value that was never real.
Nothing is lost — there was no phone number to lose.

### Fixed — the Network line on every slip was truncated

`product_type.split('_')[0]` cut `NETWORK_A` down to `NETWORK`, because the network id contains
an underscore of its own. Replaced with `parseProductId`, which anchors on the product kind, in
the domain so the API and the POS cannot disagree. The Service line now reads `Airtime` rather
than `NETWORK_A_AIRTIME_2500`.

### Changed — navigation, and what the on-screen slip looks like

Close on a slip returns to `/dashboard` rather than the transaction list, and cancelling an
order does too. The dashboard's own "Account" tile pointed at `/`, the legacy POS home — a
one-tap route back to the screen the vending dashboard replaced; it now opens Settings.

The slip preview is drawn as paper: square corners, a perforated edge, and the mark in **black
rather than verdigris**, because the printer produces black and a preview that differs from the
print is not a preview.

### Verified, not changed

Three reported failures did not reproduce: the Telga Pay deposit slip renders with the mark, the
data slip carries the mark, and bulk printing already recorded each voucher as its own
transaction with its own code. All three are now pinned by tests
(`tests/ui/splash-logo-slips.test.ts`) so a regression would fail rather than need re-reporting.

### Fixed — the retest findings (2026-08-28)

**Home landed on the old sell page (retest item 1).** Two links still pointed at `/`, the legacy
POS home whose primary action opens the old single-screen `/sell` form. The shared navigation
bar's "Home" was one; the other — the one most likely hit — was the **Account tile in the
dashboard's own bottom nav**, a single tap from the dashboard straight back to the screen the
dashboard replaced. Home now goes to `/dashboard`, Account goes to `/settings`, the legacy
"Sell airtime" nav entry is gone, and the main menu's Home entry follows.

**Cancel and Close stranded the operator (items 3, 4).** Cancelling an order redirected to
`/vouchers`; closing a slip redirected to `/transactions`. Both now land on `/dashboard` —
the sale is over, and the operator wants the counter. A Reprint button now sits on the result
screen itself (item 10), beside Close, rather than only on the history screen an operator would
have to navigate to first.

**The recipient chain was broken end to end (items 5, 7, 11, 12).** `authorizeOrder` passed the
literal string `VOUCHER-SALE-NO-RECIPIENT` as the recipient of **every** voucher sale, including
top-ups and data bundles that had a real phone number attached. Masking that placeholder printed
`VOUC*******************ENT` on the slip — a long row of stars where a phone number goes, which
is what was read as "the PIN is masked". Three consequences, all now fixed:

  - the customer's phone number never reached the slip on a top-up or data bundle, and now does;
  - a counter voucher printed a starred line for a recipient it does not have, and now omits
    the line entirely;
  - the order row already holds the mask (masked at creation, full number never kept), so it is
    passed through rather than re-masked.

**`transactions.product_type` recorded nothing (item 9).** `createSale` wrote the literal
`AIRTIME` for every sale. The slip derives its Network line from the product id in that column,
so that line rendered as `NETWORK` — or not at all. Now stores `transaction.productId`, and the
Service line shows a readable name ("Airtime", "Data — MONTHLY 1GB 30D") rather than a database
key. The column has no CHECK constraint and never had one, so no schema change was needed.

`parseProductId` replaces `split('_')[0]`, which truncated `NETWORK_A` to `NETWORK` because
network ids contain underscores of their own. It anchors on the product kind instead.

### Added — bulk printing (2026-08-28)

**Migration 010.** `pending_orders` gains `quantity` (1–20) and `total_minor` becomes
`amount_minor * quantity`. Both are CHECK changes, so the table is rebuilt as in 008 and 009;
every existing row lands as `quantity = 1`, which is what it was.

One PIN, N vouchers — but **each voucher is still its own transaction**, with its own idempotency
key, reservation, ledger postings and simulated redemption code, because ten vouchers is ten
things a customer can hold and one row cannot carry ten PINs. The batch is found again by
re-deriving each voucher's client request id from the order, so nothing stores a list that could
disagree with what was created. Verified: a batch of four produced four transactions, four
distinct codes, 100 birr spent, 4 birr profit, ledger residual zero.

### Added — the Telga mark on every slip (2026-08-28)

Drawn as inline SVG, transparent by construction, in a mono variant for thermal paper — a
thermal head is one bit per dot, so the colour mark would print as a smear. It is a **stylised
redraw** of the supplied composition, not a trace of the photoreal render (D76, A70). Palette
moves from gold to aged verdigris bronze on a cut-stone ground, with light scratches on the T.

### Changed — what sign-out means (2026-08-28)

Per D74. An **idle timeout** now costs the operator their PIN alone: device, device key and
operator id are all remembered. **Closing or restarting** the app additionally forgets the
operator — the operator cookie carries no `Max-Age`, which is the whole mechanism, with no extra
branch deciding it. **Sign out** in Settings clears all four and needs a full re-login.

⚠️ This **reverses** the rule that the device key is never stored on the client. The cost is
real: possession of the browser profile becomes possession of the device key. Mitigations —
`httpOnly`, `SameSite=Strict`, `Secure` when the transport is, never in `localStorage`. The
**PIN is still never stored anywhere**, and server-side device revocation overrides every cookie.
Recorded as `ASSUMPTIONS.md` A69, open for review before any shared device or live money.

### Changed — two more receipt fields renamed for the display guard

`voucherPin` → `redemptionCode`, `tokenReference` → `redemptionReference`.
`assertSafeForDisplay` refuses any key containing `pin` or `token`, and returned 500s until
they were renamed. These are printed references, not secrets — but that guard is more valuable
blunt than clever, so the fields moved rather than the guard.

### Added — data vouchers, slip redemption codes, navigation fixes (2026-08-27)

Acting on the founder's Stage 1–2 retest findings.

**Migration 009** — `DATA` added to `pending_orders.product_type`. The table is rebuilt, as
in 008, because SQLite cannot alter a CHECK. 5 tests
(`tests/persistence/migration-009.test.ts`) seed real orders migrated only to 008 — `TOPUP`
and `recipient` values included — and prove every column is copied byte-for-byte, that `DATA`
is now accepted and everything else still refused, that both indexes survive, that **no table
is added or dropped**, and that `integrity_check` and `foreign_key_check` stay clean.

**Data bundles** (D72), training-only. Nine categories, each with bundles carrying a volume, a
validity and a price. Flow: network → category → package + phone → PIN → slip. A bundle
requires a phone number for the same reason a top-up does — it is delivered to a handset.

**Simulated redemption codes on the slip** (D73). Network, voucher PIN, token reference and
dial string, all derived from the transaction id by `simulatedVoucherCode()`. Derived rather
than stored, so a reprint prints the identical code, a recovery-resolved sale gets one without
the worker knowing about slips, and `lookupReceipt` stays a read that writes nothing. A boxed
`SIMULATED CODE — will not load airtime` notice is drawn by the slip card itself, beside the
code, so no caller can print one without it. A top-up prints no code — it has nowhere to
redeem, and printing one would invite somebody to try.

**Navigation.** The shared bar's "Home" now goes to `/dashboard` instead of `/`, which was the
legacy POS home whose primary action opened the old `/sell` form — the reported "Home takes me
to the old airtime page". The legacy "Sell airtime" nav entry is removed. A **Main** button is
now on every screen of the sale flow, including the slip an operator was previously stranded
on; where an order is already open it is a CSRF-carrying form that cancels the order on the way
out, with a confirmation prompt, rather than stranding it `OPEN`.

**Idle timeout** stays 60 seconds, as specified. No change was needed: the device already stays
enrolled through both idle expiry and explicit logout, the device id is prefilled on the login
screen from `telga_device`, and the device key is never remembered. Covered by four existing
tests in `tests/auth/idle-timeout.test.ts`.

### Fixed — `transactions.product_type` recorded nothing (2026-08-27)

`createSale` wrote the literal string `AIRTIME` for **every** sale, so the column carried no
information about what was sold. Two visible consequences: the slip's Network line, which
derives the network from the product id in that column, could never render; and no redemption
code could be derived. Now stores `transaction.productId`. The column has no CHECK constraint
and never had one (migration 001), so no schema change was required and no existing row is
invalid — rows written before today simply still read `AIRTIME`.

### Changed — two receipt fields renamed to satisfy the display guard

`voucherPin` → `redemptionCode` and `tokenReference` → `redemptionReference`.
`assertSafeForDisplay` refuses any key containing `pin` or `token`, and it was right to: these
are printed references rather than secrets, but that guard is far more valuable blunt than
clever, so the fields were renamed rather than the guard weakened. The slip still *labels* them
"Voucher PIN" and "Token reference", which is what a merchant calls them.

### Not done, and why

The founder's list asked for a `FreeMe` data category and for real carrier names
(`Ethio Telecom`, `MTN`) on the slip. `FreeMe` is a Vodacom trademark and Telga has no
agreement with any of those operators, so naming them would contradict D66 and CLAUDE.md §10.
The category is `All-Access`, networks stay `Network A–D (simulated)`, and a test asserts none
of those names appears anywhere in the flow. The `*805*PIN#` **shape** was kept for the dial
string; the digits are `*000*`, which belongs to no operator, because `*805*` is Ethio
Telecom's real recharge string.

### Added — Priority 3 Stages 2–5: top-up, profit, one slip, settings, training deposits (2026-08-27)

**Migration 008** (`packages/persistence/src/migrations/008_recipient_topup_settings.ts`).
Rebuilds `pending_orders` — SQLite cannot alter a CHECK constraint — to add a nullable
`recipient` column and widen `product_type` to `('AIRTIME','TOPUP')`, and adds a `settings`
table keyed on `(merchant_id, key)`. Seven tests
(`tests/persistence/migration-008.test.ts`) seed real rows migrated only to 007 and assert
every column survives byte-for-byte, pre-existing orders read `recipient IS NULL`, unknown
product types are still refused, only `settings` is added, integrity is `ok`, and re-running
is a no-op. **Not yet applied to the live training database** — see "How to roll back" below.

**Training profit** (D69). A sale of face value F moves the float by −F and credits a
configurable percentage of F to `TELGA_REVENUE` as a third leg of the same balanced posting.
The customer pays exactly F; the profit is never a surcharge. Each entry records the rate in
force as `rule_version: training-profit-<bps>bps`, and a day's profit is **summed from
entries** rather than recomputed — so changing the rate cannot restate an earlier sale. The
default 4% is **training configuration only**, not a commercial rate; `commission.ts` still
throws rather than returning one.

**Direct top-up.** A second product type beside airtime, carrying a customer phone number
that is masked at the boundary before it reaches the database. The field exists only on the
top-up screen — absent, not hidden — and the server refuses a `TOPUP` without one regardless.

**One slip for everything** (D71). Sale, top-up, reprint and Telga Pay deposit all render
through a single `slipCard`; the `TRAINING — NO REAL VALUE` line is drawn by that function
rather than passed to it, so no caller can print a receipt without it. Previously the voucher
result screen showed an order summary while history showed a slip — a sale and a reprint of
that sale produced two different-looking pieces of paper.

**Settings** (`settings` table, owner-only `POS_MANAGE_SETTINGS`). Slip width (58/80 mm), one
shop advertising line, and the training profit rate. An operator may read them, because a slip
has to print whoever is at the counter; only an owner may change them.

**Telga Pay training deposits** (D70). Reverses the earlier "Telga Pay is UI-only everywhere"
position for one path, in TRAINING mode only: an owner-only, CSRF-protected, rate-limited
endpoint posts a balanced `fundMerchant` credit to the *simulated* float, so a deposit
practised at the card screen becomes value a sale can reserve against. Bounded 10–50,000 birr,
idempotent through the posting id, audited as `TRAINING_DEPOSIT_CREDITED`. Not payment
acceptance: no card is read, no PAN exists, no processor is contacted. Purchase and Cashback
remain UI-only and still write nothing.

**The dashboard Profit pill now carries a real figure** read from the ledger, replacing "Not
yet available". Its guard test was inverted rather than deleted — what it pins is unchanged:
the pill never shows a number the ledger cannot account for.

### Fixed — custom voucher amounts were priced at zero on the running server (2026-08-27)

`optionsFrom` in `apps/merchant-pos/src/cli.ts` built the API-facing voucher catalog without
forwarding `isCustom`. The server therefore treated every custom entry as a fixed
denomination and took its placeholder `amountMinor: 0` as the price — an order for nothing.
Every test passed throughout, because `tests/ui/helpers.ts` sets the flag on its own fixture;
only the real CLI wiring dropped it. Fixed by forwarding the flag, and now covered by a UI
test that asserts a custom order's confirmation screen shows the amount ordered rather than
the catalog placeholder.

### How to roll back Stages 2–5

Migrations here are forward-fix-only by design — there is no `down`. To return to the
pre-Stage-2 state:

1. **Before applying 008:** nothing to undo. Delete the new files and revert the working tree.
2. **After applying 008 to a database:** restore that database from a backup taken before the
   migration (`npm run restore`), which is the supported path and the reason
   `npm run backup` exists. Migration 008 is additive — it adds a nullable column, widens a
   CHECK, and adds one table — so a database that has been migrated but never written to by
   Stage 3–5 code is functionally identical to one that has not.
3. **Feature-level rollback without touching the schema:** set `PROFIT_PERCENT_BPS` to `0`
   (no profit is credited, and the third posting leg is omitted entirely), leave `SLIP_ADVERT`
   empty, and remove the top-up entries from `TRAINING_VOUCHER_CATALOG` — the server validates
   orders against that catalog, so a product absent from it cannot be ordered.

### Added — health endpoints and backup/restore tooling, A61/A62 resolved (2026-08-24)

Two host-independent gaps from [[Persistent Host Runbook]], built and tested before any hosting
target is chosen.

**`GET /api/health/live` and `GET /api/health/ready`** (`services/api/src/http/health.ts`, closes
A62). Reuses `recoveryGauges`/`evaluateAlerts` — the same numbers the worker's own observability
already computes — rather than a second, possibly-conflicting definition of recovery health.
Readiness reports `NOT_READY`/`UNHEALTHY`/`DEGRADED`/`HEALTHY` from real checks: training mode,
database integrity and migration currency, ledger residual, recovery-queue lag, claim readability.
Neither route can mutate state, expose a secret, or read a proxy header. 17 tests
(`tests/ui/health.test.ts`), including real injected failures — a non-zero residual via a direct
unbalanced insert, a missing migration, a transaction stuck past the safe period.

**`@telga/backup`** (`services/backup/`, closes the implementation half of A61). `npm run backup`
and `npm run restore`. Backup checkpoints (`PRAGMA wal_checkpoint(TRUNCATE)`) before copying, so a
torn WAL-mode file is never captured; writes a manifest with a SHA-256 checksum, row counts, and
the ledger residual, never a full host path. Restore verifies the checksum against the backup file
itself **before** any copy — a corrupt backup produces no partial target — then, on the isolated
target only, verifies schema currency, integrity, that the append-only triggers still refuse a real
mutation, and that the residual is zero. Every session is revoked and every recovery claim released,
unconditionally, on restore (D61) — stronger than the runbook's original "expired only" framing.
Every path is checked against an explicit allow-list with no default. 27 tests
(`tests/backup/backup-restore.test.ts`) including a full round trip for a transaction deliberately
left `PROCESSING` by fault injection (the same technique used to reproduce A44), proving restore
neither resolves nor duplicates it — residual stays zero throughout. Plus 5 tests against the real
compiled CLI binary.

**Launch gate 10 stays OPEN.** Implementation is not the same as having run this against real
infrastructure — see the backup/restore implementation note (implemented separately) "What remains open": no chosen host, no
real backup schedule, no measured time-to-restore, no full worker-sweep-after-restore integration
test. Recorded as R31.

### Added — persistent training deployment evaluation and design (A60–A62) (2026-08-24)

Documentation and evaluation only — no infrastructure created, no account
opened, nothing purchased or deployed, no code changed.

Six new notes: [[Training Deployment Architecture]] (the smallest supported
shape — HTTPS termination, a persistent POS/API process, a persistent SQLite
database, a supervised recovery worker, all on one host),
[[Deployment Target Evaluation]] (five hosting categories compared against
nineteen criteria each, recommending a small VPS or a local/office machine —
category chosen, no vendor), [[Persistent Host Runbook]] (a prerequisite audit: what already
exists with a test behind it, what needs code, what needs infrastructure, what
is blocked by an unresolved decision — including a real gap found while
auditing: **no HTTP health-check route exists**, confirmed by reading the
full route table), [[Service Startup and Shutdown]] (the exact command
sequence, health checks, and shutdown order), [[Backup and Restore Runbook]]
(design only — checkpoint-before-copy, isolated restore, eleven acceptance
criteria — no script written, no restore ever run, launch gate 10 stays open),
and [[Security Deployment Checklist]] (a review distinguishing what deployment
security is already enforced in code, with a test, from what remains an open
limitation — A52 and A48 are not fixable by any deployment choice).

Recorded as A60 (deployment-target category, proposed not accepted — see
[[Decision Log]] D59), A61 (backup/restore design completeness is not
implementation completeness), and A62 (the missing health endpoint).

### Maintenance — Node 20 Actions deprecation warning resolved (A59) (2026-08-24)

Not a product, recovery, or CI-functionality fix — `actions/checkout` and `actions/setup-node` were
pinned at `v4`, both targeting the Node 20 runtime GitHub now retires, printing a warning on every
job (`d540200`, `9c784cf`). Upgraded both to `v5` (`node24` runtime, confirmed directly from each
action's own metadata) in a dedicated commit (`96b3d4e`), kept separate from any functional CI
change. No inputs, triggers, timeouts, reporters, or the Node matrix (`22.x`/`24.x`) changed.

Remote run [`32730213755`](https://github.com/Ethan5322/Telga/actions/runs/32730213755) — Success,
1m41s, every job green, Annotations panel confirmed empty by direct owner inspection of the
authenticated page.

### Fixed — CI verified green on the remote runner, after two real defects (A43, A57, A58) (2026-08-24)

CI executed on GitHub's hosted runners for the first time and reached a complete green result on
the third push (`d540200`): `verify (Node 22.x)`, `verify (Node 24.x)` and `recovery stress` all
passed. **A43 is resolved.** The first two pushes each failed on a genuine, distinct defect — full
account in [[CI Pipeline]].

**A57 — `.gitignore` shadowed a real source directory.** A bare `build/` pattern meant for generated
compiler output also matched `tests/build/`, so that directory was never tracked or committed
despite existing on disk and being referenced by CI and the README. Every local run passed regardless,
because Vitest reads the filesystem, not git state. Fixed by removing the pattern and adding
`scripts/check-ci-test-paths.mjs`, a new first CI step that fails fast if any workflow-referenced
test path has zero tracked files.

**A58 — a stress script ran the wrong scenario and reported it under the wrong name.**
`scripts/stress-recovery.mjs`'s soak pass ran its vitest config with no file argument, so the
shared `tests/stress/` glob silently also executed the unrelated A54 multi-process test — which
needs a compiled worker binary the `recovery stress` CI job never builds. Its failure was reported
as `soak-200`. The actual A44 escalation-to-manual-review scenario was never broken: verified
passing in every reproduction, including 3 consecutive isolated local runs. Fixed by scoping the
soak invocation to its own file, adding the same `--reporter=dot` mitigation
`stress-child-process.mjs` already had (A51), and classifying every failure as ASSERTION,
INFRASTRUCTURE, or HARNESS with full output printed to the job log.

| Evidence | Before | After |
|---|---|---|
| `verify (Node 22.x)`, `verify (Node 24.x)` | FAIL — "No test files found" | **PASS** |
| `recovery stress` — `soak-200` | FAIL — actually the unrelated A54 scenario | **PASS** — correctly scoped to the A44 scenario |
| `recovery stress` — 5 shuffled repeats | PASS throughout | PASS |
| Full remote run | — | <https://github.com/Ethan5322/Telga/actions/runs/32718640781>, 1m43s |

Neither defect was in the recovery worker, the ledger, or the domain layer. A44 stays open on its
own terms — it tracks a different, still-unreproduced failure shape.


### Fixed — A54: a deferred write transaction could fail un-waitably (2026-08-21)

**A real product defect in the persistence layer**, found by instrumenting
rather than by weakening a test.

`SqliteLedgerDriver.transaction()` used better-sqlite3's default `BEGIN`, which
is **deferred**: the transaction starts as a reader and upgrades on its first
write. In WAL mode, when another connection has committed since the read
snapshot began, that upgrade fails with **`SQLITE_BUSY_SNAPSHOT`** — an error
SQLite returns immediately, which `busy_timeout` does **not** wait out, and which
cannot be safely retried because the transaction's reads may be stale.

Every unit of work reaching that method writes. Two worker processes racing one
transaction is exactly the triggering condition; the full test suite was simply
what made two processes overlap often enough to be noticed.

**Fixed with `BEGIN IMMEDIATE`** — take the write lock at the start, so the
un-waitable failure becomes an ordinary wait. No retry wrapper was added: the fix
removes the error rather than surviving it, and a retry around an ambiguous
commit is what the ledger rules forbid.

| Evidence | Before | After |
|---|---|---|
| `test:child-process:stress`, 100 iterations × 2 scenarios | reproduced on **iteration 1** | **200 iterations clean** |
| The real test file, 3 consecutive runs | intermittent | clean |
| Full suite, 3 consecutive isolated runs | 2 failures in 8 | **817/817 × 3** |

### Fixed — the worker could report HEALTHY while recovery was failing

A zero ledger residual is **necessary, not sufficient**: it says the books are
consistent, not that recovery did its job. `healthLevel` now takes the last
sweep's outcome and returns `DEGRADED` when a recovery failed, or when work was
claimed and nothing was disposed of. A *skip* stays healthy — a contested claim
is normal operation.

### Added

- **`npm run test:child-process:stress`** — 100 iterations per racing scenario on
  a fresh database each, then 3 runs of the real file. **Refuses to build**, and
  exits 4 against stale output. Preserves a complete failing artifact — database
  rows, audit trail, both worker reports, both children's output — under
  `stress-logs/child-process/`.
- **`tests/recovery/failure-path.test.ts`** — 13 tests for what a failed recovery
  must do: nothing, visibly.
- **Worker JSON now carries** `skipped`, `recoveryFailures`, `stoppedEarly` and
  `failureReasonCodes`. Without them a sweep that claimed work and resolved none
  of it returned a row of zeroes and explained nothing.

### Still open

- **A55/D50** — never run a build and the test suite concurrently here. Now
  enforced by the stress script rather than only documented.
- **A43** CI, **A30** concurrent migration, **A52** device binding, **A53**
  self-signed TLS, **A48** browser coverage, **A44**, **A34/A41** — unchanged.
- **A44 and A51 are not closed by this.** A54 was a different defect.
- Launch gates remain **0 of 10**.


### Added — HTTPS for the controlled training deployment (2026-08-21)

Reduces **A53**: a session token is no longer readable in plaintext on the wire.
It does not close it — the certificate is self-signed, which is not production
trust.

- **`apps/merchant-pos/src/transport/`** — four modules: `config.ts` (three
  explicit modes and every unsafe combination refused), `tls.ts` (loading, the
  certificate/key pair check, expiry and permission reporting), `proxy.ts`
  (trusted-proxy scheme resolution, host and origin), `headers.ts` (the security
  header set and the CSP).
- **`TRAINING_HTTP_LOCAL` / `TRAINING_HTTPS` / `LIVE`.** Plain HTTP is
  **refused** on any non-loopback binding rather than warned about; `LIVE` is
  still rejected before a database is opened.
- **A per-response CSP nonce.** `unsafe-inline` is gone from both `script-src`
  and `style-src`.
- **`Permissions-Policy`, COOP, CORP, and `no-store`** on every session-sensitive
  response; HSTS available, off by default, refused on plain HTTP.
- **`scripts/https-smoke.mjs`** — fifteen steps, thirty-eight checks, against the
  **compiled** binary over real TLS on a real database.
- **`--training-float`** — a named, off-by-default flag for a clearly-simulated
  opening balance. Creating a balance is a money operation even when the money is
  simulated, so it is never a side effect of setting up an operator.
- **74 transport tests**, including 18 against a real `node:https` listener, and
  a dependency-free X.509 generator so no private key is ever committed.

### Changed

- Cookie `Secure` is decided **per request** from the client's scheme, not from a
  single startup flag — behind a TLS terminator the process speaks HTTP while the
  client used HTTPS.
- `Host` is validated against an allow-list; `Origin` is checked on
  state-changing methods.
- The startup banner prints the port **actually bound**, the trusted-proxy
  addresses, and the certificate fingerprint — never key material.

### Fixed

Both found by the smoke test, which the unit tests could not have caught:

- **Provisioning failed on a fresh database.** `--provision-pin` created an
  operator that references a merchant and a device, neither of which existed.
- **`--port 0` was rejected by the argument parser** although the transport
  validator allowed it. Port 0 asks the operating system to choose, which is what
  an ephemeral or supervised deployment uses.

### Still open

- **A53** — self-signed is not production trust; an active substitution attack is
  not addressed.
- **A54 (new)** — `tests/build/child-process.test.ts` reported zero recoveries in
  **2 of 5** full-suite runs while passing 18/18 in isolation. **Cause not
  identified.** Diagnostics attached to both assertions. Closes neither A44 nor
  A51.
- **A55 (new, resolved as a rule)** — test and build commands must never run
  concurrently on this two-core machine.
- **A52** device binding, **A48** browser coverage, **A44**, **A43**, **A30**,
  **A34/A41** — all unchanged.
- Launch gates remain **0 of 10**.


### Added — authentication and device binding (2026-08-21)

Closes **A49 / R22** for controlled internal training: the POS took its merchant
from a URL parameter, which any operator could edit. Identity now comes from a
server-side session and nothing else.

- **`packages/domain/src/auth.ts`** — the permission table, and the pure session
  and device *decisions*. Every role answers for every permission, the way
  `VALID_TRANSITIONS` answers for every state. `FORBIDDEN_TO_MERCHANT` is a
  second, independently consulted list covering the money controls.
- **Migration 006** — `merchant_users`, `device_enrollments`, `sessions`,
  `auth_attempts`. All STRICT. Operators are constrained to `TRAINING` at the
  schema level. **No column exists** that a raw PIN, session token or device key
  could be written to.
- **`services/api/src/auth/`** — scrypt derivation with per-user salts and
  recorded parameters, 256-bit tokens, constant-time comparison, sign-in,
  `authenticate`, sign-out, device enrolment and revocation, and authorization
  decisions as typed values.
- **`services/api/src/http/guard.ts`** — size, session, device, permission,
  CSRF, rate limit, merchant-hint consistency, in that order, before any handler
  runs. The permission is declared in the route table, so a route cannot be added
  without stating what it needs.
- **Four screens** — sign in, session ended, not allowed, enrol a device — plus
  an identity indicator and a sign-out **form** on every authenticated screen.
- **`--provision-pin`** — creates the operator, enrols the device, prints the
  device key once, exits.
- **126 tests** in `tests/auth/`, every clock injected.

### Changed

- **No merchant id in any URL, link, form field or navigation href.** A supplied
  one is a consistency check and is refused on mismatch (`MERCHANT_SCOPE_MISMATCH`).
- `POST /sales` no longer accepts `merchantId`, `deviceId` or `operatorId`; all
  three come from the session.
- Another merchant's transaction and a nonexistent one now produce **identical**
  404s, so ids cannot be enumerated from status codes.

### Fixed

- **The device check now outranks the session verdict.** Revoking a device
  revokes its sessions, so the next request reported `SESSION_REVOKED` — a 401
  that sent the operator to a sign-in they could not pass. It now reports the
  device reason as a 403. Found by a failing test.
- **A device refusal was not audited at all** once the session had already been
  revoked. Now audited exactly **once per session**, so a stolen POS retrying in
  a loop cannot flood the audit table.
- **`focusOrder` counted `type="hidden"` inputs as keyboard-reachable**, which
  would have let a focus-order assertion pass while the real tab order differed.

### Security note

The display-redaction gate refused the first sign-in handler, because it returned
the CSRF token in the JSON body and the gate rejects any body carrying a key that
names a token. The fix was to take it out of the body — it travels in its own
cookie — rather than to loosen the gate. Decision **D41**.

### Still open

- **A52** — device binding is **training-grade**. A browser-supplied identifier
  plus a server-issued key is not hardware attestation, and a copied key on
  another machine is undetectable. A test demonstrates this.
- **A53** — the training POS serves **plain HTTP**, so cookies are not `Secure`
  and a session token is exposed on the wire. Controlled machine only.
- **A48** — no browser, DOM, CSS or screen-reader coverage.
- **A44**, **A43**, **A30**, **A34/A41** — unchanged by this work.
- Launch gates remain **0 of 10**.


### Added — merchant POS, training mode only (2026-08-20)

- **`apps/merchant-pos/`** — five server-rendered screens: home, new sale, transaction detail,
  transaction history, and the pending / under-review queue. `node apps/merchant-pos/dist/cli.js`
  runs it. Exit codes match the worker's: `0` clean, `2` bad args, `3` not training mode,
  `4` invalid config, `5` runtime failure, `6` migrations not applied.
- **`services/api/src/http/`** — five routes under `/api/training/`, all over the existing
  application services. One write, `POST /sales`, through `createSale`. `HttpRequest` and
  `HttpResponse` are plain values, so every API test runs without opening a socket.
- **`packages/pos-view-model/`** — pure: the state-to-UI table, the wire DTOs, the presentation
  state machine (loading / empty / error / **stale**), the bounded polling loop, and
  `assertSafeForDisplay`, the last gate before anything reaches a screen.
- **`packages/localization/`** — English and draft Amharic. `translate()` reports an English
  fallback rather than hiding it; fourteen keys have no Amharic and stay missing rather than being
  machine-translated.
- **A training simulation control.** The sale form lets an operator choose which scripted provider
  outcome to practise. It re-scripts the **mock** — `MockAirtimeProvider.useBehaviour` — is
  validated against the mock's own list, and is only ever consulted in training mode.
- Docs: new `Merchant POS Screens`, `State To UI Mapping` and `POS API Surface` notes; seven notes
  updated; Decision Log D36–D39; Risk Register R20–R23.

### Safety properties this release adds

- **Only `SUCCESSFUL` is presented as a sale.** Only it carries a confirmed certainty and only it
  may offer a receipt — asserted exhaustively over all twelve states.
- **Funds status is derived from `VALUE_DISPOSITION`**, never restated, so a screen cannot claim
  funds were released while the ledger still holds them.
- **"Do not retry yet"** is rendered as an alert above the status detail for every uncertain
  state, repeated on every list row, and the refusal is stated in a sentence rather than left as a
  missing button.
- **A double press is one sale.** `clientRequestId` is generated when the form is built, so both
  presses derive the same idempotency key; the form is post/redirect/get so a refresh cannot
  resubmit either.
- **A transport failure never becomes a sale outcome.** An unreachable API leaves the transaction
  where it was, marked `STALE`, with the last known answer still on screen.
- **`PENDING` is an HTTP success** (201), not a 4xx — a 4xx would teach a client to treat an
  unknown outcome as an error.
- **No endpoint** sets a state, posts a ledger entry, releases a reservation, completes a reversal
  or credits a balance. The reversal path stays out until there is an authenticated supervisor
  session to check.

### Fixed — the suite failed while every test passed (A51)

Three full runs exited **1** while reporting `600 passed (600)`, on
`[vitest-worker]: Timeout calling "onTaskUpdate"`; one also timed out a **pre-existing** recovery
test at Vitest's 5-second default.

**Root cause: CPU starvation on a two-core machine.** `tests/build/child-process.test.ts` compiled
every package in a `beforeAll`, inside the test run, while other files executed in parallel — and
the suite had grown from 419 tests to 600, the build from five packages to eight.

- The build is now **conditional**: `distIsStale()` compares the newest source against the oldest
  emitted file and rebuilds only when the output is genuinely stale. CI builds first, so it is a
  no-op there.
- `testTimeout` is stated explicitly at 30s and `hookTimeout` at 60s — a **resource** budget for
  database-backed tests, not a loosened assertion. Every test remains deterministic.
- The POS child-process tests use async `spawn` rather than `execFileSync`. This was a first,
  **incorrect** diagnosis of the same symptom; it was kept because not blocking a worker thread is
  right, but it was not the cause.

Three consecutive clean runs afterwards: 600/600, exit 0, no unhandled errors — and faster
(224s / 217s / 280s against 301s / 441s).

### Still open

- **A49** — the POS has **no authentication**. Reads are merchant-scoped in SQL, but nothing
  establishes who the caller is. Training-only, on a controlled machine; **blocking before any
  merchant uses it**.
- **A48** — component-level UI tests only: no browser, no CSS, no screen reader.
- **A51** is now **resolved** — see above.


### Added — stability, CI and migration ownership (2026-08-20)

- **`npm run test:recovery:stress`** — a soak of the escalation scenario on fresh databases, then
  repeated shuffled runs of the recovery and worker suites. Exits non-zero and writes failing output
  to `stress-logs/`. The stress suite has its own config so it never slows an ordinary run.
- **`diagnose()`** — a safe state snapshot (ids, states, clock values, claim and pending status,
  balances, residual) attached to the assertion that flaked, so a recurrence reports what the system
  actually looked like. No recipient data, no credentials.
- **Migration ownership enforced in code.** The worker opens the database **without migrating** and
  exits `6` if any migration is missing, naming the versions. Migrations are applied once by a single
  writer with `--migrate`. Previously every worker migrated on startup — the untested concurrent
  case behind A30.
- **`.github/workflows/ci.yml`** — install from lockfile, secret and generated-file check, typecheck,
  clean build, each test area, full suite, documentation validation, log upload on failure; plus a
  stress job on the default branch. Node 22.x and 24.x matrix.
- **`scripts/check-committed.mjs`** — refuses tracked secrets or build output.
- Docs: new `CI Pipeline`, `Test Stability Runbook`, `Migration Ownership` and
  `Multi-Process Migration Plan` notes; nine notes updated; Decision Log D33-D35.

### Fixed

- **The child-process race test asserted the wrong invariant.** It required `claimed === 1`, but a
  second process may legitimately claim after the winner releases and then find the transaction
  terminal on re-read. The safety property is that a transaction is **resolved** once, not
  **claimed** once — guaranteed by the re-read under claim, not by the claim count. Diagnosed as a
  test defect; the product was correct.
- `stuckProcessing` helpers identified the new transaction by position; ids sort lexicographically,
  so neither the first nor the last row is reliably the newest. Now diffed by id.
- **The dead-worker lease test raced the wall clock.** It set a lease expiring 1.5 seconds out and
  expected a child process spawned within that window to be blocked; under load, spawning took
  longer than the lease. Fixed by removing the race rather than padding it — the lease is now long
  and is expired **explicitly** between the two child runs. Same property, no wall clock, no added
  delay.
- **A portability hazard in the same tests.** Harnesses seeded rows with a fixed fake clock while
  child processes read the real one, so eligibility depended on the time of day. Seeded rows are now
  backdated against real time.

### Still open

- **A44** — the original intermittent failure was **not reproduced** across a 200-iteration soak,
  5 shuffled repeats, repeated isolated runs and repeated full runs. Kept **OPEN** rather than
  closed on absence of evidence. The two flakes that *were* reproduced during the investigation
  (A45, A47) were both test defects and are fixed.
- **A43** — CI is authored but has **never run**: no git remote, no commits.
- **A30** — concurrent multi-process migration remains untested; the risk is avoided, not solved.

### Added — build pipeline and multi-process proof (2026-08-20)

- **A real build.** `npm run build` compiles every package to its own `dist/` in dependency order;
  `npm run clean` and `npm run build:clean` are cross-platform Node, not shell built-ins.
  - `tsconfig.build.base.json` plus a `tsconfig.build.json` per package.
  - Emits **CommonJS** with `{"type":"commonjs"}` stamped into each `dist/`, because the sources use
    extensionless relative imports that Node's ESM resolver rejects.
  - The build **fails** if any TypeScript source reaches the output. Current output: 58 `.js`,
    58 `.d.ts`, 0 `.ts`.
- **`services/worker/src/cli.ts`** — the runtime entry point. Arguments and environment for database
  path, worker id, mode, `--once`, policy overrides and mock scripting. Meaningful exit codes:
  `0` ok, `2` bad arguments, `3` not training mode, `4` invalid configuration, `5` runtime failure.
- **`tests/build/child-process.test.ts`** — 16 tests that spawn **real operating-system processes**
  running the compiled worker and race them for the same claim. Full suite now **417 tests**.
- **`README.md`** — build, run, test and worker operation instructions.
- Mock provider gained `statusOverride`, so a worker in a fresh process can be scripted to a
  determinate lookup outcome.
- Docs: new `Build Pipeline` note; nine notes updated; Decision Log D30-D32.

### Fixed

- **A37 resolved.** Multi-process worker safety is now proved rather than assumed: separate
  processes, asserted distinct pids, one winner per claim, one settlement, residual zero. Risk R16
  closed in the register.

### Added — supervised recovery worker (2026-08-20)

- **`services/worker`** — the supervised loop that runs the recovery sweep unattended.
  - `recoveryWorker.ts` — composition root; refuses any mode but `TRAINING`.
  - `workerLifecycle.ts` — the loop. **The only place in the system that reads real time.**
    Fixed-delay scheduling, overlap guard, graceful shutdown.
  - `workerConfig.ts` — three named policies. Production carries no numbers and never falls back.
  - `backoff.ts` — exponential backoff with bounded jitter, capped, reset on success.
  - `failures.ts` — seven failure categories; database and schema faults are fatal.
  - `workerHealth.ts` — status and health level, with the reasoning ordered most-severe first.
  - `shutdown.ts` — cooperative cancellation, SIGTERM/SIGINT, idempotent.
  - `observability.ts` — structured log events and 20 named metrics, with forbidden-key redaction.
- **Sweep cancellation boundary** — `recoverInFlight` now accepts `shouldContinue`, checked between
  transactions, and reports `stoppedEarly`. Nothing is ever cancelled mid-operation.
- **Owner-scoped claim release** — `releaseClaimsOwnedBy` and `countActiveClaims`.
- **82 worker tests** across 3 files. Full suite now **401 tests**.
- Docs: new `Recovery Worker`, `Worker Configuration`, `Worker Operations Runbook` and
  `Deployment Runbook` notes with six Mermaid diagrams; nine existing notes updated;
  Decision Log D25-D29.

### Notes

- **A31 remains resolved** — the sweep now also runs on a schedule rather than only on demand.
- **A37 remains open.** The concurrency tests use two separate SQLite connections to one file,
  which exercises the real atomic claim across connections, but both live in one process. A test
  asserts that limitation so the claim cannot quietly drift out of the documentation.

### Added — recovery sweep (2026-08-20)

- **`services/api/src/application/recovery/`** — unattended recovery for transactions left in flight.
  - `recoverInFlight.ts` — the sweep. Claims each transaction under a time-bounded lease, looks up
    its status, and drives it to a determinate state or holds it and escalates.
  - `config.ts` — every threshold injected; per-provider policy overrides; no production default.
  - `results.ts` — seven provider-outcome categories, of which only two may move money.
  - `metrics.ts` — standing gauges and alert evaluation.
- **Migration `005_recovery_claims`** — `recovery_claims` lease table, plus `next_check_at`,
  `last_outcome_category`, `current_state` and `manual_review_status` on `pending_resolutions`, and
  `approved_by` / `approved_at` on `support_cases`.
- **Supervisor approval enforced in code** — `completeReversal` refuses any role outside
  `OPS_APPROVER` and `ADMIN`, and records the approver on the support case.
- **11 recovery audit actions** so an unattended recovery leaves a complete trail.
- **61 recovery tests** across 3 files, including two-worker concurrency, expired-lease reclaim, and
  failure injection at seven points. Full suite now **319 tests**.
- Docs: new `Recovery Sweep`, `Recovery Configuration`, `Recovery Sweep Runbook` and
  `Manual Review Runbook` notes with seven Mermaid diagrams; twelve existing notes updated;
  Decision Log D20-D24.

### Fixed

- **A31 resolved.** A transaction stuck at `PROCESSING` is now recovered automatically rather than
  waiting for someone to notice. The manual procedure in `Transaction Failure Runbook` remains as
  the fallback when the sweep itself reports a failure.
- The sweep also covers `PENDING`. `resolvePending` only acts when something calls it, and an
  unattended system has nothing calling it — without this, a transaction the sweep moved to pending
  would have held merchant money indefinitely and the escalation deadline would never have fired.
- The pending clock now starts when a transaction entered the in-flight state rather than when the
  sweep noticed it, so a long-stuck transaction no longer receives a fresh grace period.

### Added — transaction orchestration (2026-08-20)

- **`services/api`** — the application layer binding domain, persistence and the mock provider.
  - `application/createSale.ts` — the seventeen-step sale. Two units of work either side of the
    provider call; typed results; no raw error ever reaches a merchant.
  - `application/resolvePending.ts` — status lookup, resolution, and time-based escalation to
    `UNDER_REVIEW` with an automatic support case.
  - `application/reversal.ts` — `requireReversal` and `completeReversal`.
  - `application/results.ts` — discriminated union of 6 outcome kinds and 9 rejection kinds, each
    carrying a `nextAction` and a `messageKey`.
  - `application/context.ts` — injected clock, ids, catalog and mode. Nothing reads the real time.
  - `application/rehydrate.ts` — row to domain `Transaction`; the full recipient is never restored.
- **Migration `004_pending_and_support`** — `pending_resolutions` (deadline, attempts, status) and
  `support_cases` (reference, reason, status).
- **74 orchestration tests** across 5 files, including failure injection at eight points in the
  unit of work. Full suite now **256 tests**.
- Docs: new `Transaction Orchestration`, `Create Sale Service`, `Mock Provider Behavior` and
  `Transaction Failure Runbook` notes with seven Mermaid diagrams; ten existing notes updated;
  Decision Log D16-D19.

### Known gap

- A transaction can stick at `PROCESSING` if the outcome unit of work fails after the provider was
  called. Value stays reserved and the ledger stays balanced, but **no automatic recovery sweep
  exists yet**. Manual procedure in `Transaction Failure Runbook`; tracked as assumption A31.

### Added — SQLite persistence layer (2026-08-20)

- **`packages/persistence`** — SQLite behind a `LedgerDriver` interface.
  - `driver/types.ts` — the swappable contract. Deliberately offers **no** `updateLedgerEntry` and
    **no** `deleteLedgerEntry`.
  - `sqlite/connection.ts` — PRAGMAs set and **read back**: WAL, `foreign_keys = ON`,
    `busy_timeout = 5000`, `synchronous = FULL`.
  - `sqlite/migrator.ts` — ordered, checksummed, one transaction per migration.
  - `sqlite/driver.ts` — `SqliteLedgerDriver`.
  - `repositories/` — merchants, transactions, ledger, reservations, audit. Parameterized queries
    throughout; every scoped read filters in SQL.
  - `operations.ts` — atomic reserve, release, finalize, move-to-under-review, release-from-review.
  - `privacy.ts` — recipient masking, salted hashing, metadata safety guard.
- **Migrations** — `001_initial_schema` (7 STRICT tables), `002_ledger_append_only`,
  `003_audit_append_only`.
- **Database-level append-only enforcement** — `BEFORE UPDATE` and `BEFORE DELETE` triggers on
  `ledger_entries` and `audit_events`. Tests attempt raw SQL and assert both abort.
- **79 persistence tests** across 5 files. Full suite now **182 tests**.
- Domain: added `MERCHANT_AVAILABLE`, `MERCHANT_RESERVED`, `MERCHANT_UNDER_REVIEW` account kinds so
  the balance buckets become auditable postings; `settledBalance` now sums all merchant-owned kinds.
- Docs: new `SQLite Persistence Layer`, `Migration Strategy`, `Database Operations Runbook` notes
  with four Mermaid diagrams; ten existing notes updated; Decision Log D12–D15.
- Toolchain: `better-sqlite3` ^13, `@types/node`, `@types/better-sqlite3`.

### Added — domain foundation (2026-08-20)

- **`packages/domain`** — the pure domain layer. No I/O, no database, no network, no framework.
  - `states.ts` — 12 transaction states, the transition map as data, terminal states, and a
    `VALUE_DISPOSITION` table assigning every state exactly one balance bucket.
  - `transaction.ts` — the immutable Transaction aggregate; every state change goes through
    `transitionTo`, which consults the map.
  - `idempotency.ts` — key derivation from request identity, payload fingerprinting, and the
    store that turns a retry into a replay instead of a second sale.
  - `ledger.ts` — append-only ledger with double-entry balance enforcement and account
    segregation. No update, no delete, no void.
  - `balance.ts` — reservations and the four derived views: available, reserved, under review, total.
  - `money.ts` — integer santim only; no float path into or out of the type.
  - `mode.ts` — `assertSimulated`, the structural guard that refuses anything marked LIVE.
  - `provider.ts` — the `AirtimeProvider` contract, with an outcome type that can express
    "I do not know".
  - `commission.ts` — rule placeholders whose compute functions **throw**, because no rate is confirmed.
  - `receipt.ts` — receipts and `recordReprint`, which returns an event and cannot touch the ledger.
  - `audit.ts` — append-only audit log.
  - `errors.ts` — 16 typed domain errors carrying stable codes.
- **`services/provider-adapters/mock-airtime`** — deterministic mock provider covering all eight
  required behaviours: success, failure, timeout, delayed success, delayed failure, malformed
  response, duplicate callback, outage. No `Math.random`, no `Date.now`, no `setTimeout`; a virtual
  clock advances only when a test says so. **No HTTP client exists in this package.**
- **`tests/`** — 103 tests across 6 files covering the state machine, idempotency, ledger
  invariants, balance model, reprints, audit events, merchant isolation, and the mock provider.
- **`ASSUMPTIONS.md`** — 21 assumptions mirrored from the pilot register, plus 4 introduced during
  implementation.
- Toolchain: TypeScript 5.9, Vitest 3.2, npm workspaces. Root `tsconfig.json` and `vitest.config.ts`.

### Changed

- `docs/obsidian/03 Domain/Transaction State Machine.md` — expanded to name all 12 states
  explicitly, with valid transitions, invalid transitions, terminal states, and the test case
  mapped to each transition.
- `docs/obsidian/03 Domain/Domain Glossary.md` — added the transaction states as first-class
  vocabulary.
- `docs/obsidian/09 Engineering/Testing Strategy.md` — added the test-to-transition mapping.
- `docs/obsidian/09 Engineering/Architecture.md` — added the implemented domain package layout.
- `docs/obsidian/07 Governance/Decision Log.md` — added D8–D11.

### Fixed

- `CREATED`, `VALIDATED`, `RESERVED` and `REVERSAL_REQUIRED` were isolated nodes in the knowledge
  graph: they appeared only in the state machine note and were named nowhere else. Now documented
  and tested explicitly.
- Idempotency key derivation originally hashed the whole payload, which made a payload mismatch
  undetectable — a tampered request would have produced a different key and looked like a new sale.
  The key now derives from request identity only, with the payload covered by a separate
  fingerprint. Found by writing the test the specification asked for.

## [0.1.0] — 2026-08-19

### Added — Obsidian and Graphify knowledge base (Phase 1)

- `CLAUDE.md` — the authoritative project instruction set, transcribed from the founder's
  `CLAUDE.pdf` (12 pages) into Obsidian- and Graphify-compatible Markdown.
- `docs/obsidian/` — 56-note vault across 11 folders: strategy, product, domain, UX, operations,
  partnerships, governance, pilot, engineering and templates.
- 13 Mermaid diagrams: roadmap, sale journey, transaction state machine, balance lifecycle,
  provider timeout and manual review, outage isolation, funding verification, complaint flow,
  system architecture, partner relationship map, pilot decision loop, and launch-gate dependencies.
- All eleven Phase 0 registers (A–K), deliberately empty and marked `NOT YET CONFIRMED` rather
  than pre-filled.
- Draft Amharic interface strings, every one marked
  **REQUIRES NATIVE AMHARIC REVIEW BEFORE PRODUCTION**.
- `graphify-out/` — knowledge graph: 95 nodes, 498 edges, 9 communities, 100% EXTRACTED.
- Vault validation: 0 broken links, 0 orphan notes, 0 missing frontmatter.

### Noted

- The source `CLAUDE.pdf` is clipped at the right page margin; eight vault-tree lines lost their
  tail mid-word. Reconstructed names confirmed by the founder and logged as an incident in
  `docs/obsidian/05 Operations/Source Specification Clipped In PDF.md`.

---

## Not in any release

The following remain deliberately unbuilt and unenabled: live provider integration, live money,
wallets, payment acceptance, cash-in/cash-out, lending, remittance, electricity tokens, general
bill payment, offline vending, independent settlement, and any real commission or price.

### Android app — a real, installable package (2026-08-31)

Telga now builds a genuine Android application, so it can be distributed
through Google Play rather than only added to a phone's home screen from a
browser. **The web app is unchanged**: `npm run training:serve` behaves exactly
as before and the PWA route still works. See [[Android Release and Play Store]]
and Decision Log D106.

- **`apps/mobile/`** — a Capacitor shell hosting a WebView pointed at a Telga
  server. It reimplements no screens, deliberately: a second implementation of
  the vending flow would be a second origin for a duplicate sale, and §13 makes
  duplicate prevention a ledger invariant rather than a preference.
- **`shell.config.json` is the single source** for which servers the app may
  reach. Capacitor reads it for `allowNavigation`; `npm run mobile:configure`
  generates the connect screen's copy from the same file. If those two lists
  disagreed in the permissive direction, Capacitor would hand the address to the
  system browser and a merchant would type a PIN into a tab with no Telga
  chrome — indistinguishable from a phishing page.
- **A bundled connect screen** asks for the server address once and keeps it.
  Bilingual, and carrying the training-mode banner. Set `defaultServer` and the
  screen disappears, which is the shape a production release takes.
- **Hardened**, verified in the packaged manifest rather than only in source:
  `allowBackup=false` plus Android 12 data-extraction rules, so a live session
  cannot be copied to Google Drive or transferred to another phone;
  `usesCleartextTraffic=false`; and `INTERNET` as the only permission.
- **Release signing** reads `keystore.properties`, which `.gitignore` refuses
  along with `*.jks`. `assembleRelease` and `bundleRelease` **fail with a named
  reason** when no key is configured, rather than emitting the unsigned APK that
  Play rejects and a phone will not install.
- **The app icon is Telga's own mark.** Capacitor scaffolds its logo into every
  mipmap and splash drawable, so the first build wore another project's brand.
  `npm run mobile:icons` rescales the founder's artwork from
  `apps/merchant-pos/assets/` — the same files the web app serves — so the phone
  icon and the browser icon are one picture. Nothing is redrawn, per `logo.ts`.
  The maskable variant becomes the adaptive foreground because it was drawn for
  Android's safe-zone rule; the full-bleed file would lose the T's crossbar to a
  round launcher's mask.
- **Toolchain note:** Android Studio's bundled JDK 25 cannot run Gradle 8.14.3
  (`Unsupported class file major version 69`). The build uses a separate Temurin
  JDK 21, unpacked from a zip, changing nothing about the system Java.

**Not yet shippable, and the reason is not the build.** There is no hosted Telga
server and no registered domain, so a Play Store download would install an app
with nothing to connect to. Recorded as `A89`; the domain blocker is the first
item on the release checklist.


### Release APK, signing, and why an install can still fail (2026-08-31)

The Android app is now built as a **signed release** rather than a debug build,
and there is a runbook for the case where a phone refuses it anyway. See
[[APK Install Troubleshooting]] and Decision Log D107.

- **`npm run mobile:package`** produces the APK a merchant is given: Gradle's
  release build (signed v2 + v3 with Telga's own key, not debuggable, R8
  shrunk — 1.7 MB against the debug build's 5.0 MB) plus a **v1 signature**
  added afterwards. AGP drops v1 above minSdk 23 and `apksigner` refuses it
  below `--min-sdk-version 21`; by the specification both are right, and it is
  added regardless because some OEM package managers have been fussier than
  stock Android and the whole cost is a slightly larger file.
- **`npm run mobile:diagnose`** asks Android why an install failed. "App not
  installed" is the installer's entire vocabulary — a signature conflict, a
  Play Protect block, a full disk and a truncated download look identical — and
  this prints the actual `INSTALL_FAILED_*` code with what it means.
- **The build was cleared of blame first, not last.** Signature, ABI, SDK
  range, required features and zip integrity were each checked, and the release
  APK installs and launches on Android 14: `Success`, MainActivity resumed, no
  fatal logs. What remains is on the device or in the transfer. Recorded as A92
  — **until an install is confirmed on real hardware, no claim that Telga runs
  on Android is supportable.**
- **`SECURITY.md` now exists.** `CLAUDE.md` §27 has always named it and it was
  never written: there was no route by which somebody could report a
  vulnerability. It states scope, what is deliberately not built (live money,
  the WebAuthn passkey), and what is enforced today.
- **Four undocumented deviations from §27 are now recorded** as `A91`:
  `packages/ledger`, `packages/design-system` and `infra/` do not exist, and
  `apps/android/` is `apps/mobile/`. The first three are defensible; that none
  had been written down was the actual finding, since an undocumented deviation
  is indistinguishable from an oversight.
- **Lint is clean again.** This session's Android work had introduced 18 errors:
  seventeen were ESLint trying to type-check generated Capacitor output, now
  ignored; one was a real `no-implied-eval` in the new connect-screen test,
  which now uses a `node:vm` context — a genuine sandbox rather than the
  Function constructor.

**Known, pre-existing, and not fixed here:** `npm run format:check` fails on
**630 files** — effectively the whole repository, including files untouched by
this work. Running Prettier across it would produce a diff too large to review
alongside anything else, so it is left for a commit of its own.

