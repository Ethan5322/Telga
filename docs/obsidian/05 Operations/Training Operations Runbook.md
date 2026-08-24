---
title: Training Operations Runbook
type: operations
status: draft
owner: telga
created: 2026-08-21
updated: 2026-08-21
tags:
  - telga
  - operations
  - runbook
  - training
  - security
related:
  - "[[00 Home]]"
  - "[[Runbooks]]"
  - "[[Authentication and Sessions]]"
  - "[[Device Binding]]"
  - "[[Deployment Runbook]]"
  - "[[Merchant POS Screens]]"
depends_on:
  - "[[Authentication and Sessions]]"
decision_status: draft
---

# Training Operations Runbook

Running the training POS: provisioning operators and devices, and handling the
things that go wrong.

> [!danger] Who may use this
> **Internal Telga staff, on the controlled training machine, only.** No
> merchant and no external operator has been authorised. The POS serves plain
> HTTP and the device binding is training-grade — see [[Threat Model]] T4 and T7.

## Before anything

```bash
npm run build:clean                              # compile
node services/worker/dist/cli.js --db ./telga.sqlite --migrate --once
```

Migrations are applied by **one writer**, once, with the worker's `--migrate`.
Neither the worker nor the POS migrates on startup; both exit `6` against an
unmigrated database, naming the missing versions. See [[Migration Ownership]].

## Provisioning an operator and a device

```bash
node apps/merchant-pos/dist/cli.js \
  --db ./telga.sqlite \
  --merchant merchant_alpha \
  --operator operator_1 \
  --device device_1 \
  --provision-pin 481502
```

Prints the **device key once** and exits. It is not recoverable.

> [!warning] Write the device key down before closing the terminal
> Telga stores only a scrypt hash. If it is lost, enrol the device again — which
> issues a new key and revokes any session using the old one.

PIN rules: 6–12 digits, not all the same digit, not sequential. A weak PIN is
refused by `--provision-pin` before anything is written.

## Starting the POS

```bash
node apps/merchant-pos/dist/cli.js --db ./telga.sqlite --merchant merchant_alpha
# TRAINING MODE — NO REAL VALUE. Internal training only.
# Telga POS on http://localhost:4321/login
# Cookies are NOT marked Secure: this server speaks plain HTTP.
```

Exit codes: `0` clean · `2` bad arguments · `3` not training mode · `4` invalid
configuration · `5` runtime failure · `6` migrations not applied.

There is **no merchant id in any URL**. Signing in decides the scope.

## Signing in

Operator id, PIN, device id, device key. All four.

| What the screen says | What it means | What to do |
|---|---|---|
| "Sign-in was refused" | Something was wrong. It will not say which — deliberately | Check all four; try again |
| "Locked out after repeated failed attempts" | 5 wrong PINs | Wait 5 minutes, or unlock (below) |
| "Too many sign-in attempts" | 10 attempts in a minute | Wait a minute |
| "This device is not enrolled" | No enrolment for this device id | Enrol it |
| "This device has been withdrawn" | Revoked | Investigate before re-enrolling |

## Runbook: an operator is locked out

1. Confirm it is a genuine lockout: `AUTH_LOCKED_OUT` in the audit trail.
2. Check the failures around it. A run of `AUTH_LOGIN_FAILED` from one device at
   one time is a forgotten PIN. Spread across devices or hours, treat it as an
   attempt to guess and **do not** unlock without asking who was at the machine.
3. Either wait out the five minutes, or clear it:

```sql
-- Training only. Records the decision in the audit trail first.
UPDATE merchant_users SET failed_attempts = 0, locked_until = NULL
 WHERE id = 'operator_1';
```

4. Write down who authorised it and why.

## Runbook: a device is lost or stolen

**Immediately.** A revoked device stops on its *next request*, not when its
session expires.

1. Revoke:

```ts
revokeDevice(api, {
  deviceId: 'device_1',
  merchantId: 'merchant_alpha',
  reason: 'REPORTED_STOLEN',
  actor: { userId: 'system', role: 'ADMIN' },
  correlationId: 'corr_incident_1',
});
```

2. Confirm `sessionsRevoked` matches what you expect. Zero means nobody was
   signed in; more than one means several sessions were live and all are gone.
3. Check the audit trail for `DEVICE_REJECTED` afterwards — that is somebody
   still trying to use it. Each session records its first refusal, and then stays
   quiet, so a handful of entries is normal and a flood is not possible.
4. Review the transactions made from that device before the report.
5. Do **not** re-enrol until the machine is physically recovered or written off.

> [!note] A merchant cannot revoke their own device
> `DEVICE_REVOKE` is not granted to any merchant role, including the owner. A
> stolen device is exactly the case where the holder must not be able to tidy up
> after themselves.

## Runbook: enrolling a replacement device

1. The `devices` row must exist first — enrolment is a fact about a **known**
   device, not a way to create one.
2. Enrol through the POS at `/enrol` (needs `DEVICE_ENROL`: owner or admin), or
   with `--provision-pin` for a fresh machine.
3. The key is shown **once**, on the page, and never redirected to — so it
   reaches no URL, no browser history and no access log.
4. Any session on the old enrolment is revoked automatically.

## Runbook: "I was signed out in the middle of a sale"

1. **The sale is not lost.** Session expiry does not touch a transaction. Sign in
   and open the transaction list.
2. If the transaction is `PENDING` or `UNDER_REVIEW`: **do not sell it again.**
   Follow [[Transaction Failure Runbook]].
3. If it is not there at all, the sale never started — no reservation, no ledger
   entry. Selling again is safe.

Two causes: 15 minutes idle, or 12 hours since signing in. Both are checked on
every request.

## Runbook: "Not allowed" instead of a sign-in screen

That screen means signing in again will **not** help. The reason code on it says
which:

| Code | Cause | Action |
|---|---|---|
| `DEVICE_REVOKED` | The device was withdrawn | Operations decision — do not re-enrol without asking why |
| `DEVICE_NOT_ENROLLED` | Never enrolled, or enrolment removed | Enrol it |
| `DEVICE_ENROLLMENT_EXPIRED` | Enrolment expiry passed | Re-enrol |
| `DEVICE_NOT_ASSIGNED_TO_MERCHANT` | Device belongs to another merchant | Reassign properly: revoke, then enrol |
| `PERMISSION_DENIED` | The role lacks the permission | Correct: a plain operator cannot enrol a device |
| `MERCHANT_SCOPE_MISMATCH` | A stale link or bookmark from another merchant | Navigate from the POS home |
| `CSRF_TOKEN_INVALID` | A stale form, usually left open across a sign-out | Reload and submit again |

## Runbook: rate limits

| Symptom | Limit | Training value |
|---|---|---|
| "Too many sign-in attempts" | Login attempts per window | 10 per minute per operator |
| A sale refused with 429 | Sales per session | 30 per minute |
| A 413 | Request body cap | 16 KB |

All are **training values**. Production thresholds are **NOT_YET_CONFIRMED**.
Raising one is a decision for [[Decision Log]], not a config tweak: the sale
limit is a duplicate-selling control as well as an abuse control.

## Daily checks

1. `AUTH_LOGIN_FAILED` and `AUTH_LOCKED_OUT` counts — a rising trend is either a
   confusing PIN policy or someone guessing.
2. `DEVICE_REJECTED` — should be empty unless a device was revoked.
3. `AUTH_RATE_LIMITED` — should be rare.
4. Ledger residual is zero: `driver.ledgerResidualMinor()`.
5. Anything `UNDER_REVIEW` older than the escalation deadline —
   [[Manual Review Runbook]].

## What this runbook does not cover

| Not covered | Where it goes |
|---|---|
| Live money, live provider | Neither exists. [[Launch Gates]] — 0 of 10 |
| Restoring from backup | **A34/A41 OPEN** — untested. [[Database Operations Runbook]] |
| HTTPS | **A53 OPEN**. Controlled machine only |
| Merchant self-service | Not built |
| Opening the POS to a merchant | **Not authorised** |

## Serving over HTTPS — 2026-08-21

The training deployment should now run `TRAINING_HTTPS`. Plain HTTP survives as
a loopback development fallback and is **refused** on any other binding.

```bash
npm run training:serve -- --db ./telga.sqlite --merchant merchant_alpha \
  --transport TRAINING_HTTPS \
  --tls-cert /etc/telga/tls/cert.pem --tls-key /etc/telga/tls/key.pem \
  --allowed-hosts telga-training.local
```

Certificates: see [[Local Certificate Handling]]. Telga never makes one for you.

### Runbook: the server will not start

Exit 4 means the transport configuration or the TLS material was refused. The
reason code says which:

| Code | Cause | Fix |
|---|---|---|
| `HTTP_MUST_BE_LOOPBACK` | Plain HTTP bound to a LAN address | Use `--transport TRAINING_HTTPS` |
| `TLS_CERTIFICATE_REQUIRED` / `TLS_PRIVATE_KEY_REQUIRED` | HTTPS without paths | Supply both. Telga never generates them |
| `TLS_CERTIFICATE_UNREADABLE` / `TLS_PRIVATE_KEY_UNREADABLE` | Wrong path or permissions | Check the path; the key must be readable by the service user |
| `TLS_CERTIFICATE_KEY_MISMATCH` | The pair do not belong together | A common result of regenerating one and not the other |
| `PROXY_TRUST_REQUIRED` | Proxy termination with no trusted list | Add `--trust-proxy <addresses>` |
| `PROXY_TRUST_WITHOUT_PROXY` | A trust list with in-process TLS | Remove one or the other |
| `SECURE_COOKIE_ON_HTTP` / `HSTS_ON_HTTP` | An HTTPS setting on a plain deployment | Switch transport, or drop the setting |

### Runbook: "your connection is not private"

Expected with a self-signed certificate, and correct: the browser cannot tell it
from an impostor's. Confirm the SHA-256 fingerprint in the startup banner
matches what the browser shows before proceeding. Use `mkcert` if the warning is
disruptive for training.

### Runbook: signed in, then immediately signed out

Almost always a `Secure` cookie over a connection that is not actually HTTPS.
Behind a proxy, check that `--trust-proxy` names the address the proxy connects
**from**, and that the proxy *sets* `X-Forwarded-Proto` rather than passing a
client's through. Telga will not believe the header from anywhere else, so the
symptom is a session that never sticks.

### Runbook: rotating a certificate

1. Write the new pair beside the old.
2. `SIGTERM` the POS — in-flight requests drain within `--shutdown-timeout-ms`.
3. Restart against the new paths and confirm the new fingerprint in the banner.

Sessions survive: they are server-side rows and have nothing to do with the
certificate.

### Verifying a deployment

```bash
npm run training:smoke
```

Fifteen steps against the compiled binary over real TLS, on a temporary database
and a temporary certificate, both deleted afterwards. Synthetic data only.


## Related

- [[Authentication and Sessions]]
- [[Device Binding]]
- [[Deployment Runbook]]
- [[Transaction Failure Runbook]]
- [[Manual Review Runbook]]
- [[Runbooks]]

---
Back to [[00 Home]]
