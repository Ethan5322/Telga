---
title: Phone and POS Install
type: operations
status: draft
owner: devops-sre
created: 2026-08-30
updated: 2026-08-30
tags: [telga, operations, deployment, training]
related: ["[[Training HTTPS Deployment]]", "[[Service Startup and Shutdown]]", "[[Telga Launcher and Dashboard]]"]
depends_on: ["[[TLS and Proxy Configuration]]"]
---

# Phone and POS Install

How to get Telga onto an Android phone and a smart-POS for testing.

## The honest starting point

> [!warning] This section was written on 2026-08-30 and was overtaken the next day
> It said *"There is no Android application in this repository"* and that Route B
> needed a toolchain that did not exist. **[[Decision Log]] D106 built it on
> 2026-08-31.** `apps/mobile/` is a Capacitor project with a real
> `AndroidManifest.xml`, and `npm run mobile:release` produces a signed APK and
> AAB. The original text is corrected below rather than left standing, because a
> note that denies the existence of a shipped app is worse than no note.

**There is one Telga Android application**, `et.mulesoo.telga`, in `apps/mobile/`.
It is a **Capacitor shell**: a WebView pointed at a Telga server, reimplementing
no screens. The **same APK installs on a phone and on POS hardware** — see
[[Platform Shape]]. `apps/merchant-pos/` is the *server* that renders what it
displays, not a second application.

So there are two routes, and they are not equivalent:

| | What it is | Ready today |
|---|---|---|
| **A. Install as a web app** | Chrome installs the page to the home screen. Real icon, no browser chrome, opens standalone | **Yes** |
| **B. Install the APK** | The Capacitor build in `apps/mobile/`, installed by sideload or from Play once listed | **Yes to build and sideload** — see [[Android Release and Play Store]] for what still blocks a listing |

Route A is what this note covers end to end, because it needs no toolchain at
all. Route B is covered by [[Android Release and Play Store]].

---

## Route A — install on a phone or POS

### 1. What the device needs

Same wi-fi as the machine running Telga. Nothing else — no Play Store, no
sideloading, no developer mode.

### 2. Plain HTTP will not work, and the refusal is deliberate

This is the first thing people hit. Running:

```
node .pps\merchant-pos\dist\cli.js --db .	elga.sqlite --merchant merchant_alpha ^
  --host 0.0.0.0 --transport TRAINING_HTTP_LOCAL --allowed-hosts 172.20.10.3
```

**exits 4** with:

> Refused: Plain HTTP training mode may bind only to loopback; refusing
> "0.0.0.0". Use --transport HTTPS to serve anything beyond this machine.
> [HTTP_MUST_BE_LOOPBACK]

**In PowerShell you may not see that message.** Node writes it to stderr, and
PowerShell renders a native command's stderr as error records that are easy to
miss or that scroll past. The window returns to the prompt and it looks like a
silent successful start. It is not — the process is gone.

To see what a command actually said:

```powershell
node .pps\merchant-pos\dist\cli.js --db .	elga.sqlite ... 2>&1 | Out-String
$LASTEXITCODE      # 0 = started, 4 = refused configuration, 3 = not TRAINING, 6 = unmigrated
```

Always check `$LASTEXITCODE`. It is the difference between "running" and "exited
without you noticing".

The refusal is right. A session cookie in clear text over a phone hotspot is
readable by anyone else on that hotspot, and a browser will not offer
"Install app" over plain HTTP either.

`--transport` accepts `TRAINING_HTTP_LOCAL` or `TRAINING_HTTPS`; the
`TRAINING_` prefix is optional (`HTTPS` works too). `HTTP_LOCAL` is loopback
only. **For a phone you need `TRAINING_HTTPS`.**

### 3. Find the machine's LAN address

```powershell
ipconfig
```

Take the **IPv4 Address** of the adapter actually on the phone's network — for
a phone hotspot that is the Wi-Fi adapter, typically `172.20.10.x`. Ignore
`vEthernet` / WSL adapters; those are virtual and the phone cannot reach them.

`localhost` will not work from the phone. On the phone, `localhost` is the
phone.

### 4. Make a certificate that names that IP

It **must** carry the IP in a Subject Alternative Name, or Android rejects it
outright — a `CN` alone is not enough for modern browsers.

```powershell
$ip = "172.20.10.2"
openssl req -x509 -newkey rsa:2048 -nodes -days 30 `
  -keyout key.pem -out cert.pem `
  -subj "/CN=$ip" `
  -addext "subjectAltName=IP:$ip,IP:127.0.0.1,DNS:localhost"
```

**In Git Bash, prefix that with `MSYS_NO_PATHCONV=1`.** Git Bash rewrites
`/CN=...` into a Windows path and openssl fails with "subject name is expected
to be in the format ...". PowerShell does not have this problem.

Check it before using it:

```powershell
openssl x509 -in cert.pem -noout -subject -ext subjectAltName
```

Keep `key.pem` out of the repository — `check-committed` refuses `.pem`.

### 5. Prepare the database, once

```powershell
node .\services\worker\dist\cli.js --db .	elga.sqlite --migrate --once --mode TRAINING

node .pps\merchant-pos\dist\cli.js --db .	elga.sqlite `
  --merchant merchant_alpha --operator operator_alpha --device device_alpha `
  --provision-pin 481502 --training-float 500
```

The second prints a **device key once and never again**. Write it down.

### 6. Start the two processes

**Window 1 — the worker.** It now announces itself; if it prints nothing and
returns to the prompt, it is not running:

```powershell
node .\services\worker\dist\cli.js --db .	elga.sqlite
```

Expect a line like:

```
worker_18020 pid=18020 watching .	elga.sqlite — sweeping every 30s. Ctrl+C to stop.
```

**Window 2 — the POS**, over HTTPS, bound to every interface:

```powershell
$ip = "172.20.10.2"
node .pps\merchant-pos\dist\cli.js --db .	elga.sqlite `
  --merchant merchant_alpha `
  --transport TRAINING_HTTPS --tls-cert .\cert.pem --tls-key .\key.pem `
  --host 0.0.0.0 --port 4321 `
  --allowed-hosts "$ip,127.0.0.1,localhost"
```

`--allowed-hosts` takes a **comma-separated list**, and the machine's own LAN IP
must be in it — Telga answers only for hosts it was told about and returns
**400** for anything else. Include `127.0.0.1` and `localhost` so the same
process still serves the computer's own browser.

Expect:

```
Telga POS on https://0.0.0.0:4321/login
Answering for hosts: 172.20.10.2, 127.0.0.1, localhost
```

### 6a. Let the port through Windows Firewall

`--host 0.0.0.0` makes Telga listen on every interface, and `netstat -ano |
findstr :4321` will show `0.0.0.0:4321 LISTENING` — but Windows Firewall can
still drop the phone's packets **silently**. There is no error on either side;
the phone simply times out.

Allow it once, from an **elevated** PowerShell:

```powershell
New-NetFirewallRule -DisplayName "Telga POS 4321" -Direction Inbound `
  -Protocol TCP -LocalPort 4321 -Action Allow -Profile Private
```

`-Profile Private` only. A hotspot should be a Private network; if Windows has
it as Public, either change the network to Private or you are opening the port
on untrusted networks, which you should not do.

To remove it afterwards:

```powershell
Remove-NetFirewallRule -DisplayName "Telga POS 4321"
```

### 7. Troubleshooting, in the order to try it

| Symptom | Cause | Fix |
|---|---|---|
| Window returns to the prompt, no output | The process **exited**. PowerShell hid the stderr line | Check `$LASTEXITCODE`. `4` = configuration refused, `3` = not TRAINING mode, `6` = database not migrated |
| `HTTP_MUST_BE_LOOPBACK` | Plain HTTP cannot bind a LAN address | Use `--transport TRAINING_HTTPS` with a cert and key |
| Worker prints nothing | It used to exit silently mid-sleep — fixed 2026-08-30 | Rebuild. A running worker now prints `watching … sweeping every 30s` |
| Computer loads it, phone times out | Windows Firewall | Add the inbound rule in §6a |
| Phone gets **400** | The machine's IP is not in `--allowed-hosts` | Add it, comma-separated |
| Phone: certificate error | Self-signed, and expected | Advanced → Proceed. Only for your own machine |
| Phone: `ERR_CERT_COMMON_NAME_INVALID` | The cert has no IP SAN | Regenerate with `-addext "subjectAltName=IP:…"` |
| `ipconfig` shows several IPv4 addresses | `vEthernet`/WSL adapters are virtual | Use the Wi-Fi adapter's address |
| Nothing listening | Check it is actually bound | `netstat -ano \| findstr :4321` should show `0.0.0.0:4321 LISTENING` |

### 8. On the phone



1. Open Chrome and go to `https://192.168.1.24:8443`.
2. It will warn about the certificate. That is correct — it is self-signed.
   Choose **Advanced → Proceed**. Do this only for your own machine.
3. Sign in: operator id, PIN, device key.
4. Chrome menu → **Install app** (or "Add to home screen").
5. Telga appears on the home screen with its own icon and opens without
   browser chrome, because the manifest declares `display: standalone`.

### 9. On the smart-POS

Identical, with two additions:

- If the POS browser offers no install option, a bookmark on the home screen
  behaves the same for testing.
- Set **Settings → Security → Lock the screen after** to something short. A POS
  sits on a counter unattended; the lock is what stops the next person picking
  up a live session.

### 10. Testing card payments on the phone

Telga Pay → **Purchase** → type an amount → **Pay now**. The card screen offers
tap, insert and swipe, and eight training cards:

| Card | What it does |
|---|---|
| 4242 | Approves |
| 0002 | Not enough money |
| 0127 | Wrong PIN |
| 0069 | Expired |
| 9995 | Blocked |
| 0051 | Over the limit |
| 0119 | Bank not answering |
| 0341 | No answer at all |

Every one of them prints a slip, including the refusals. `0341` is the one to
look at hardest: it must say **"No answer from the bank"** and never
"declined", because on that outcome the money may or may not have moved.

**The phone's own NFC is not used.** Nothing here reads a physical card — the
reader is a simulator behind the `CardReader` port. On a smart-POS with a real
reader, that port is implemented by the vendor SDK and nothing above it changes.

### 11. Testing the merchant flow on the POS

Sign in → Telga → **Telga Vending** → Airtime or Vouchers → amount → PIN →
result → print. Then: **Statement** for the day's totals, **Transactions** with
a date range, and **Reprint** on any row.

---

## Route B — a real APK, and what it would take

**This machine cannot build one.** Checked on 2026-08-30: no `java`, no
`JAVA_HOME`, no `ANDROID_HOME`, no Gradle. Those are installs on a developer
machine, not something a build script can conjure.

What it would involve:

1. Install a JDK (17 or newer) and Android Studio, which brings the SDK.
2. Add Capacitor and an `apps/android/` project.
3. Point `capacitor.config.ts` at the Telga server — a Capacitor shell still
   needs the server running somewhere, so it does **not** remove the LAN or
   hosting requirement above. It changes how the app is installed, not how it
   works.
4. `npx cap sync android`, then `./gradlew assembleRelease`.
5. Sign the APK with a keystore. That keystore is a real secret and must never
   enter this repository.

**Worth knowing before choosing this:** the resulting APK is a browser pointed
at the same server. The gain is a Play-Store-installable artefact and access to
native device APIs — including, eventually, a real NFC card reader. The cost is
a second build system, a signing key to manage, and a release process. Until
there is a hosted server and an acquirer, it buys packaging rather than
capability.

---

## What is not covered

- **No hosted deployment.** Everything above is a machine on the shop's own
  wi-fi. A public URL needs the host decision in [[Persistent Host Deployment Plan]].
- **No certificate authority.** A self-signed certificate means a warning on
  every new device, and an *active* attacker on the same network is not
  addressed — recorded as `A53`.
- **No mobile testing has been done.** These instructions are derived from the
  server's own refusals and its manifest, and the flow was verified over HTTP
  on loopback. Nobody has yet run them against a real phone.

## Related

- [[Training HTTPS Deployment]]
- [[TLS and Proxy Configuration]]
- [[Telga Pay Card Simulator]]

---
Back to [[00 Home]]
