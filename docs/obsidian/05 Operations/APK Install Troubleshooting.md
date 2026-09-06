---
title: APK Install Troubleshooting
type: operations
status: draft
owner: devops-sre
created: 2026-08-31
updated: 2026-08-31
tags: [telga, operations, mobile, runbook]
related:
  ["[[Android Release and Play Store]]", "[[Phone and POS Install]]", "[[Decision Log]]"]
validates: ["[[Android Release and Play Store]]"]
---

# APK Install Troubleshooting

A merchant taps the file and Android says **"App not installed"**. That message
is the installer's entire vocabulary: a signature conflict, a Play Protect
block, a full disk and a truncated download all look identical on the screen.
This is how to find out which one it actually is.

> [!important] Do not guess at this
> Every cause below has been mistaken for every other. `npm run mobile:diagnose`
> prints the real code in about ten seconds and ends the argument.

## First: are you installing the right file?

| File | Installs? | Why |
|---|---|---|
| `app-debug.apk` | **Often refused** | Carries `debuggable=true` and is signed with the Android debug key — the same key on every developer machine on earth. Play Protect blocks that combination *after* "Installing…" |
| `app-release.apk` | Yes | Signed with Telga's own key, not debuggable |
| `telga-app.apk` (from `npm run mobile:package`) | Yes — **use this one** | The release APK plus a v1 signature, for the widest device compatibility |

```powershell
npm run mobile:release     # gradle assembleRelease + bundleRelease
npm run mobile:package     # adds v1 signing, writes %USERPROFILE%\telga-app.apk
```

## Then: check the file survived the journey

`npm run mobile:package` prints a SHA-256. Check the same hash on the phone
before blaming the build.

**Gmail refuses `.apk` attachments outright**, and some messaging apps re-encode
what they forward. A different hash means the transfer broke the file and no
rebuild will fix it. Google Drive, a direct download, or USB all preserve bytes.

## Then: ask Android why

```powershell
npm run mobile:diagnose
```

Needs USB debugging: **Settings → About phone →** tap *Build number* seven times
**→ back → System → Developer options → USB debugging**, then replug and accept
the prompt on the phone.

It reports the phone's model, API level and ABI, lists any conflicting Telga
package, checks free space, then installs and prints the failure code.

## What each code means

| Code | Cause | Fix |
|---|---|---|
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | A Telga signed with a **different key** is already installed. Commonest after testing a debug build, then a release one | `adb uninstall et.mulesoo.telga` and `et.mulesoo.telga.debug`, then reinstall |
| `INSTALL_FAILED_VERIFICATION_FAILURE` | Play Protect blocked it | Play Store → profile → Play Protect → turn scanning off, install, turn it back on |
| `INSTALL_FAILED_INSUFFICIENT_STORAGE` | No room | Free space; Android wants roughly 3× the APK |
| `INSTALL_PARSE_FAILED_NO_CERTIFICATES` | The file was altered in transit | Re-copy and check the hash |
| `INSTALL_FAILED_OLDER_SDK` | Phone predates API 24 (Android 7) | Not supported. Use the PWA route in [[Phone and POS Install]] |
| `INSTALL_FAILED_USER_RESTRICTED` | The phone blocks sideloading — common on MIUI | Developer options → *Install via USB*; MIUI also needs the Xiaomi account signed in |
| `INSTALL_FAILED_NO_MATCHING_ABIS` | Wrong architecture | Cannot occur here: Telga ships **no native libraries** and is architecture-independent |

## What has been ruled out, and how

Recorded so the same ground is not covered twice:

| Suspicion | Verdict | Evidence |
|---|---|---|
| APK unsigned | **No** | `apksigner verify` — v1, v2 and v3 all present after `mobile:package` |
| Certificate expired | **No** | 10000 days from 2026-08-31 |
| Corrupt file | **No** | Zip integrity verified, 445 entries |
| Wrong architecture | **No** | Zero native libraries; nothing to mismatch |
| minSdk too high | **No** | 24, so Android 7 and later |
| targetSdk too high | **No** | A device ignores a target above its own API level |
| Missing required feature | **No** | Only `android.hardware.faketouch`, implied by default and satisfied by any touchscreen |
| The build itself | **No** | Installs and launches on Android 14 (API 34): `Success`, MainActivity resumed, no fatal logs |

Everything the build can control has been checked. What remains is on the
device or in the transfer, which is what the table above is for.

## Why v1 signing is added back

AGP drops v1 (JAR) signing once `minSdk` reaches 24, and `apksigner` refuses to
add it unless told `--min-sdk-version 21`. By the specification both are right:
v2 covers every Android that can run Telga.

`mobile:package` adds it anyway. "Correct by the specification" and "installs on
the phone in the shop" are not the same claim — several OEM package managers have
been fussier than stock Android about sideloaded packages, and the entire cost is
a slightly larger file and a slower verify. Against a merchant who cannot install
Telga and is told nothing about why, that is not a close call.

## Related

- [[Android Release and Play Store]] — building and signing
- [[Phone and POS Install]] — the PWA route, which needs no APK at all
