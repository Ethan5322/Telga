---
title: Android Release and Play Store
type: operations
status: draft
owner: devops-sre
created: 2026-08-31
updated: 2026-08-31
tags: [telga, operations, mobile, release]
related:
  ["[[Phone and POS Install]]", "[[Architecture]]", "[[Security Model]]", "[[Decision Log]]"]
depends_on: ["[[Persistent Host Deployment Plan]]"]
---

# Android Release and Play Store

How Telga becomes an app a merchant installs from Google Play, what that
actually gets you, and what is still missing before it can happen.

> [!warning] The app cannot be published yet
> Not because the build is unfinished — it builds — but because **there is no
> hosted Telga server for it to talk to**. Everything on this page is ready and
> waiting on that one decision. See [[Persistent Host Deployment Plan]].

## What the Android app is

A **Capacitor shell**: an Android application whose whole job is to host a
WebView pointed at a Telga server. Telga's screens are rendered by the server,
exactly as they are in a browser, and the shell does not reimplement any of
them.

That restraint is deliberate rather than lazy. A second implementation of the
vending flow would be a second place a duplicate sale could originate from, and
`CLAUDE.md` §13 makes duplicate prevention a ledger invariant rather than a
nicety. One flow, one implementation, one place to fix it.

What the shell adds over the PWA route in [[Phone and POS Install]]:

| | PWA (add to home screen) | Android app |
|---|---|---|
| Install source | The browser, after visiting the site | Google Play |
| Discovery | Merchant must be told a URL | Searchable listing |
| Icon and task | Yes | Yes |
| Updates | Automatic, on next load | Play, with review latency |
| Works on a self-signed LAN server | Yes, past a warning | **No** — see below |
| Native device APIs (NFC, printers) | No | Available, none used yet |

The honest summary: today the app buys **distribution**, not capability. The
capability argument arrives when a real card reader or a native printer driver
is needed, and the shell is what makes that possible later.

## The layout

```text
apps/mobile/
├── package.json              # @telga/mobile — Capacitor only
├── capacitor.config.ts       # reads shell.config.json for allowNavigation
├── shell.config.json         # THE list of reachable servers
├── www/
│   ├── index.html            # the connect screen, bundled in the APK
│   ├── config.js             # GENERATED — never edit, never commit
│   └── icon.png
└── android/                  # generated native project — open THIS in Studio
```

**Android Studio opens `apps/mobile/android`.** Not the repository root, and not
`apps/mobile`. The file that proves it is the right folder is
`apps/mobile/android/settings.gradle`.

## Why the app asks for a server address

An app installed from Play lands on phones in shops MuleSoo has not met. A URL
baked into the build would mean a new APK, a new review and a new rollout every
time an address changed — and during the pilot the address genuinely is not
known when the build is made.

So `www/index.html` asks once, keeps the answer, and navigates. When production
has a single fixed address, set `defaultServer` in `shell.config.json` and the
screen disappears: the app opens straight into Telga.

### One list, two consumers

`shell.config.json` is the only place the reachable servers are named. Capacitor
reads it for `allowNavigation`; `npm run mobile:configure` writes the same list
into `www/config.js` for the connect screen's validation.

They must not drift. If the screen accepted an address the WebView would not
open, Capacitor would hand it to the **system browser** — and the merchant would
then be typing a PIN into a plain tab with no Telga chrome around it, which is
indistinguishable from a phishing page.

## HTTPS only, and what it costs

The shell sets `androidScheme: 'https'`, refuses mixed content, and the connect
screen rejects anything that is not `https://`. A merchant PIN and a session
cookie travel over this connection and a shop's wi-fi is not a trusted network.

**The cost, stated plainly: this app cannot talk to a LAN server with a
self-signed certificate.** The WebView rejects it and there is no dialogue to
click past. The correct response is a real certificate, **not** a trust
exception — an app that ignores certificate errors has no transport security at
all, and `CLAUDE.md` §24 does not have an exception for convenience. Self-signed
LAN use stays on the PWA route, where at least a human sees the warning and can
judge it.

## Building

### Prerequisites

|             | Required         | On this machine (2026-08-31)                     |
| ----------- | ---------------- | ------------------------------------------------ |
| JDK         | **21** (LTS)     | `%LOCALAPPDATA%\Programs\jdk-21\jdk-21.0.12.1+1` |
| Android SDK | platform 36      | `%LOCALAPPDATA%\Android\Sdk`                     |
| Gradle      | 8.14.3 (wrapper) | downloaded by the wrapper                        |
| AGP         | 8.13.0           | resolved by Gradle                               |

> [!note] Android Studio's bundled JDK does not work
> Studio ships **JDK 25**. Gradle 8.14.3 supports up to Java 24 and fails with
> `Unsupported class file major version 69`. Telga uses a separate Temurin
> **JDK 21**, unpacked from a zip so it changes nothing about the system Java.
> In Android Studio set **Settings → Build → Build Tools → Gradle → Gradle JDK**
> to that path.

### Commands

```powershell
$env:JAVA_HOME    = "$env:LOCALAPPDATA\Programs\jdk-21\jdk-21.0.12.1+1"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"

npm run mobile:configure        # regenerate www/config.js
npm run mobile:sync             # copy web assets into the native project
cd apps/mobile/android
./gradlew.bat assembleDebug     # → app/build/outputs/apk/debug/app-debug.apk
./gradlew.bat bundleRelease     # → app/build/outputs/bundle/release/app-release.aab
```

`bundleRelease` produces the **`.aab`**, which is what Play accepts. The `.apk`
is for sideloading onto a test phone.

The debug build installs as `et.mulesoo.telga.debug`, so it sits beside a store
build rather than replacing it and taking its saved server address along.

## The app icon is the Telga mark

Capacitor scaffolds **its own logo** into every mipmap and splash drawable. An
unmodified build therefore puts another project's mark on a merchant's home
screen — the kind of thing nobody notices until it is in a Play screenshot.

`npm run mobile:icons` replaces all of them with Telga's own artwork:

```powershell
npm run mobile:icons     # then mobile:sync to copy it into the build
```

It does not draw anything. The source is the mark already in the repository,
the same files the web app serves as its PWA icons, so the phone icon and the
browser icon are one picture at different sizes:

| Source | Becomes |
|---|---|
| `apps/merchant-pos/assets/icon-512.png` | the flat mipmaps (API 24-25) and the splash |
| `apps/merchant-pos/assets/icon-maskable-512.png` | the adaptive foreground (API 26+) |
| `apps/merchant-pos/assets/icon-192.png` | the connect screen's copy, byte-identical |

**The maskable file is the right source for the adaptive foreground.** Android
crops an adaptive icon to whatever shape the launcher uses — circle, squircle,
teardrop — and only the middle 72 of 108dp is guaranteed to survive. The
maskable variant was drawn for that rule, with the figure and the letter pulled
into the safe area. Using the full-bleed file would clip the T's crossbar on a
round launcher.

The background colour behind the adaptive icon is **sampled from the artwork's
own corner** (`#122E30`) rather than typed in, so the two cannot drift apart.

There is no image library in the repository and adding one to downscale a
handful of PNGs would be a poor trade, so `generate-icons.mjs` decodes with
Node's zlib and box filters **in linear light**. That detail is not decoration:
averaging raw sRGB bytes darkens the teal against the dark ground, and
nearest-neighbour sampling breaks the skeleton's ribs and the road's gravel
into noise at small sizes.

> [!note] What is still missing for a listing
> The icon is done. A Play listing also needs a feature graphic, screenshots,
> and a description in English and Amharic, none of which exist — `A90`.

## Signing

Release builds are signed from `apps/mobile/android/keystore.properties`, which
`.gitignore` refuses. Copy `keystore.properties.example` and fill it in.

```powershell
keytool -genkeypair -v -keystore telga-release.jks -keyalg RSA `
  -keysize 4096 -validity 10000 -alias telga
```

> [!danger] This key has exactly one point of failure
> Google Play binds the app's identity to it. **Lose it** and no update can ever
> be published for the listing again — the only remedy is a new listing, a new
> name, and no installed base. **Leak it** and somebody else can sign a package
> that installs over Telga on a merchant's phone.
>
> Keep the `.jks` outside this repository, back it up somewhere that is not this
> machine, and record who holds it in [[Founders and Roles]]. Enrolling in Play
> App Signing moves the ceiling key to Google and reduces — but does not remove
> — the consequence of losing the upload key.

`assembleRelease` and `bundleRelease` **fail** when no keystore is configured,
rather than emitting `app-release-unsigned.apk`. An unsigned build looks fine
locally and is rejected by Play, which is a slow way to learn something a build
error can say immediately.

## Before the listing can go live

Ordered by what blocks what. The first item blocks every other one.

- [ ] **A hosted Telga server with a real TLS certificate.** Without it a Play
      download opens an app that cannot connect to anything. → [[Persistent Host Deployment Plan]]
- [ ] **A registered domain.** `telga.et` / `mulesoo.et` are intended names, not
      owned ones — recorded as `A59`. Put the real one in `shell.config.json`.
- [ ] Google Play developer account (one-off fee, identity verification, and for
      an organisation account a D-U-N-S number — allow weeks, not days).
- [ ] Privacy policy at a public URL. Required, and it must describe what Telga
      actually collects.
- [ ] Data safety form. Telga's answers follow from [[Security Model]]: session
      cookie, merchant identifiers, transaction records. **No** card data — there
      is no field for a PAN or a CVV anywhere in the system.
- [ ] Target API level at or above Play's current floor. The project targets 36.
- [ ] Store listing: icon, feature graphic, screenshots, description in English
      and Amharic.
- [ ] **Financial-services policy review.** Play applies extra requirements to
      apps in this category, and some regions require documented licensing.
      `CLAUDE.md` §8 already forbids claiming compliance without qualified
      review — that applies to a store listing as much as to the product.
- [ ] Decide what the store listing says while the app is in **training mode**.
      The connect screen carries `TRAINING MODE — NO REAL VALUE`; a listing that
      implies live vending while the build refuses it would be a false claim
      under §5.

## What this does not change

- The web app is untouched. `npm run training:serve` behaves exactly as before,
  and the PWA install route still works.
- No live money. `money.live` still needs its ten gates and two approvers, and
  the shell has no way to affect that — it renders whatever the server allows.
- No native device APIs are used yet. NFC and native printing remain available
  and unimplemented.

## Related

- [[Phone and POS Install]] — the PWA route, and the LAN setup that still works
- [[Persistent Host Deployment Plan]] — the blocker for everything on this page
- [[Security Model]] — what the data safety form has to say
- [[Decision Log]] — D106
