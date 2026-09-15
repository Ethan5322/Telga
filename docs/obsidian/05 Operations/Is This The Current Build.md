---
title: Is This The Current Build
type: operations
status: accepted
owner: devops-sre
created: 2026-09-15
updated: 2026-09-15
tags: [telga, operations, runbook, deployment]
related: ["[[Runbooks]]", "[[Decision Log]]", "[[Merchant POS Screens]]", "[[Deployment Runbook]]"]
validates: ["[[Decision Log]]"]
decision_status: accepted
---

# Is This The Current Build

**How to tell a defect that is still in the code from one that was fixed and
has not reached the device.** They look identical on a phone, and answering the
wrong one wastes a day.

## Why this note exists

On 2026-09-15 the founder reported three things on a merchant screen:

```
operator_1 · merchant_alpha · Device device_1
Sign out
Last updated from Telga: 2026-09-15T05:05:31.256Z
```

**Two had been fixed the day before. One had not. And a fourth defect was
sitting in the same screenshot that nobody had named.**

Nothing distinguished them by looking. The fixed ones had no test asserting they
stayed fixed, so re-reading the diff proved only that an edit had been made — not
that the screen a person was holding reflected it.

## The order to check, and why this order

### 1. Render the screen from source. Do this first.

Not "read the code". Not "check the diff". **Render it and search the output.**

```bash
# A throwaway test that dumps one screen, using the real render path.
npx vitest run tests/ui/header-footer-arrangement.test.ts
```

That test file exists precisely because of this incident. It renders
`/dashboard`, `/sell`, `/statements`, `/menu` and `/settings` and asserts what
must and must not appear.

**If a rendered screen still contains it, the code is wrong.** Stop here and fix
it. No amount of rebuilding will help.

**If the rendered screen is clean, the code is right** and the device is behind.
Continue.

> Reading the source is what made two of these look fixed when one of them was
> not. `page()` had stopped calling `identityBar`, which is what a diff shows —
> while the footer three lines below it still printed the clock, which only the
> output shows.

### 2. Is it deployed?

```bash
git log --oneline origin/main..HEAD   # anything here is NOT deployed
```

Commits that exist locally and not on `origin/main` have never reached Railway.
A green suite says nothing about what is serving traffic.

### 3. Is the APK current?

**This is the one that catches people.** The Telga app is a Capacitor shell
(§18.0) that loads the server's own screens — so *most* changes reach a device
the moment Railway deploys, with no rebuild at all.

**But not all of them.** The shell itself, its start-up configuration, and
anything cached by the web view do not. An APK built before a change to the
shell will keep showing the old behaviour however current the server is.

If the server renders it correctly and the device does not:

- Force-stop the app and reopen it (clears the web view's in-memory state).
- Clear the app's storage if that fails.
- Rebuild and reinstall the APK if it still differs.

## The rule this incident produced

> **A removal is not done until something asserts it stays removed.**

The header work was reported as complete with **no test covering any of it**. The
consequence was not only that one defect survived — it was that the founder's
report could not be triaged. "It is still there" and "your device is old" were
indistinguishable, and both were true of different lines in the same screenshot.

A test that renders the screen answers it in seconds, permanently, and for
everybody who asks later.

## Dead code counts as present

`identityBar` had no callers when the founder photographed the strip it draws.
It was still exported, still compiled, and one import away from returning.

**Delete the function, not just the call.** A reviewer reading the file sees a
function that renders the thing somebody asked to remove and reasonably concludes
it is still in use.

## A test can hold a defect in place

`launcher-dashboard-pay.test.ts` contained a test called *"shows the merchant
identifier"* which asserted the dashboard printed the raw merchant id. That is
why the id survived the first attempt at this work: the suite was **guarding**
it.

When a founder decision reverses a behaviour, **invert the test rather than
deleting it**. A deleted test leaves nothing saying the new rule holds; an
inverted one says it and keeps saying it.

## Related

- [[Runbooks]]
- [[Merchant POS Screens]] — what each screen carries
- [[Decision Log]] — D164 (training banner), D167 (header and footer)
- [[Deployment Runbook]] — how a commit reaches Railway

---
Back to [[00 Home]]
