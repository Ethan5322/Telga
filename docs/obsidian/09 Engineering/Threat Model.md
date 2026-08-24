---
title: Threat Model
type: engineering
status: draft
owner: telga
created: 2026-08-21
updated: 2026-08-21
tags:
  - telga
  - engineering
  - security
  - risk
related:
  - "[[00 Home]]"
  - "[[Security Model]]"
  - "[[Authentication and Sessions]]"
  - "[[Device Binding]]"
  - "[[Risk Register]]"
  - "[[Ledger Invariants]]"
depends_on:
  - "[[Security Model]]"
decision_status: draft
---

# Threat Model

Who would attack Telga, what they would go for, and what actually stops them.

> [!warning] Scope
> This covers the **training** build: no live money, no live provider, one
> controlled machine, no merchant or external operator has access. A live
> deployment needs this rewritten against a real network, real funds and a real
> provider agreement, by a qualified reviewer. Nothing here is a compliance
> claim — see [[Legal Questions]].

## What is worth attacking

| Asset | Why | Current exposure |
|---|---|---|
| Merchant balance | It is money, even simulated | Ledger is append-only in code **and** in database triggers |
| Transaction history | Another shop's trade is commercially valuable | Merchant-scoped in SQL on every query |
| Recipient numbers | Personal data | Never stored whole — mask and salted hash only |
| Operator PINs | Reused elsewhere by real people | scrypt with per-user salt; never logged |
| Device keys | Grant a session | scrypt; shown once; never recoverable |
| Session tokens | Are a session | Only a SHA-256 is stored; the token lives in a cookie |
| Audit trail | Evidence for a dispute | Append-only triggers; refusals recorded too |

## Actors

| Actor | Capability assumed | Motivation |
|---|---|---|
| **Curious operator** | A valid session on an enrolled device | See another shop's numbers; retry a pending sale to get paid twice |
| **Dishonest operator** | The same, plus time and the machine unattended | Free airtime; hide a transaction; claim a sale failed |
| **Thief with the POS** | Physical possession, no PIN | Sell airtime on the merchant's balance |
| **Someone on the network** | Reads and writes the training LAN | Steal a session token |
| **Malicious web page** | The operator's browser visits it | Make the browser act as the operator |
| **Someone with database access** | The file | Extract PINs and sessions |
| **Provider** | Controls its own responses | Claim delivery that did not happen, or deny one that did |

## Threats and controls

### T1 · Cross-merchant access — **the one this build closed**

*An operator edits `?merchantId=` and reads another shop.*

Was live until this build (**A49 / R22**). Now the merchant comes only from the
session row; a client-supplied merchant id is a consistency check that is
**refused** on mismatch. Every read is merchant-scoped in SQL.

Another merchant's transaction and a nonexistent one produce the **identical**
404, so ids cannot be enumerated by reading status codes.

Tested: `authorization.test.ts` — URL tampering, body tampering, transaction-id
tampering, cross-merchant history, queue and balance, and the identical-refusal
property. **R22 CLOSED for training.**

### T2 · Double-selling a pending transaction

*A merchant retries an uncertain sale so the customer pays once and receives
twice, or the merchant is credited twice.*

Idempotency keyed on request identity: the same `clientRequestId` returns
`DUPLICATE_REQUEST`, never a second sale. The POS generates the id when the
confirmation screen opens, not on submit. `PENDING` renders
**DO_NOT_RETRY_YET** and offers no retry control. A CSRF failure followed by a
retry is still one sale.

### T3 · Stolen POS

*Someone takes the machine off the counter.*

A session dies after 15 minutes idle and 12 hours absolutely. Operations revokes
the device, which revokes its sessions **and stops the next request**, checked on
every request rather than at sign-in. A thief without the PIN has five attempts
before a five-minute lockout.

**Residual**: someone who takes the machine *while it is signed in* has up to
15 minutes. A PIN-on-wake lock is not built. Accepted for training on a
controlled machine.

### T4 · Session theft on the network — **open**

*Someone on the training LAN reads the session cookie.*

`HttpOnly` stops script access; `SameSite=Strict` stops cross-site sending.
Neither helps against a plaintext wire, and the training machine serves **plain
HTTP**, so the cookie is not marked `Secure`.

**Not mitigated. A53 OPEN.** The control is physical: keep the POS on the
controlled training machine. `--https true` behind a TLS terminator sets the
flag.

### T5 · Cross-site request forgery

*A page the operator visits posts a sale to Telga.*

`SameSite=Strict` means the session cookie is not sent cross-site at all. A
per-session CSRF token is the second lock, because `SameSite` is a browser
behaviour rather than a server guarantee. A CSRF failure creates no transaction
and no ledger entry — asserted, not assumed.

### T6 · Credential stuffing and PIN guessing

Five failures lock the account for five minutes; ten attempts per minute are
refused outright. The rate limit is checked **before** the user lookup and the
lockout **before** the PIN verification, so a locked account costs a database
read rather than a scrypt derivation. An unknown operator and a wrong PIN return
the identical code.

**Residual**: a six-digit PIN is weak in absolute terms. It is defended by
lockout and by the device binding, not by entropy. Production policy is
**NOT_YET_CONFIRMED**.

### T7 · Device impersonation — **open**

*A copied device identifier and key on a second machine.*

Not detectable. The binding is training-grade, deliberately. **A52 OPEN** — see
[[Device Binding]] for what closing it would cost.

### T8 · Privilege escalation

*A merchant operator approves a reversal or releases held funds.*

Two independent locks: the grant table does not give it, and `FORBIDDEN_TO_MERCHANT`
is consulted separately, so a mistaken grant still fails. **No HTTP route exists**
that completes a reversal, forces a state, releases funds or changes recovery
configuration — tested by asserting those paths return 404, meaning nothing is
there to be forbidden from.

### T9 · Database theft

*The SQLite file is copied.*

No raw PIN, session token, CSRF token or device key is in it. An attacker gets
scrypt hashes to grind and SHA-256 fingerprints of tokens that are useless
without the tokens.

**Residual**: transaction history, masked recipients and salted recipient hashes
are readable. Encryption at rest is not built.

### T10 · Audit tampering

*Someone edits history to hide a transaction.*

`audit_events` and `ledger_entries` both carry `BEFORE UPDATE` and
`BEFORE DELETE` triggers that abort. The persistence interface offers no update
or delete for either. Migration 006 does not weaken them — asserted directly.

**Residual**: someone with file access can drop the triggers. Off-machine backup
and log shipping are not built.

### T11 · A dishonest provider

*The provider claims a delivery it did not make, or denies one it did.*

Out of scope for training: the provider is a deterministic mock. The controls
that exist are structural — every attempt carries a provider reference, the
recovery sweep records each status lookup, and `UNDER_REVIEW` holds funds rather
than guessing. **No provider agreement exists**; see the provider agreement terms (commercial material, kept outside this repository).

### T12 · Denial of service

Per-session sale rate limit, login rate limit, 16 KB request cap enforced while
reading rather than after buffering. No global limit, no proxy, no WAF.
Acceptable for one controlled machine; not for anything reachable.

### T4 revisited — 2026-08-21

`TRAINING_HTTPS` now serves real TLS. A **passive** listener on the training LAN
no longer reads a session token: the wire is encrypted and the cookie is
genuinely `Secure`.

An **active** attacker substituting their own certificate is *not* addressed,
because the certificate is self-signed and nothing distinguishes theirs from
ours. That is why A53 is **reduced** and not closed.

Plain HTTP survives only as a loopback development fallback, refused on any
other binding (D46).

### T13 · A spoofed forwarding header — new

*A client sends `X-Forwarded-Proto: https` over a plain connection.*

Believed only from a configured trusted address. Without that rule the server
would mark a cookie `Secure` that the browser never returns — and, worse, would
**report itself secure while it was not**. There is deliberately no "trust all
proxies" setting. Tested directly, including the spoofing case.

### T14 · An injected inline script — new

*Something reaches the page and injects `<script>`.*

The CSP was `script-src 'unsafe-inline'`, which permitted exactly that. It is now
a **per-response nonce**: injected markup carries no nonce, does not run, and
cannot learn one. `object-src`, `worker-src`, `manifest-src` and `base-uri` are
all `'none'`; `frame-ancestors 'none'` handles framing.


## Summary

| # | Threat | Status |
|---|---|---|
| T1 | Cross-merchant access | **Closed for training** — R22 |
| T2 | Double-selling | Closed |
| T3 | Stolen POS | Mitigated; signed-in window remains |
| T4 | Session theft on the wire | **OPEN — A53**, no HTTPS |
| T5 | CSRF | Closed |
| T6 | PIN guessing | Mitigated; PIN entropy is low by design |
| T7 | Device impersonation | **OPEN — A52**, training-grade |
| T8 | Privilege escalation | Closed |
| T9 | Database theft | Partly — secrets safe, history readable |
| T10 | Audit tampering | Closed in the database; file access remains |
| T11 | Dishonest provider | Out of scope; no agreement exists |
| T12 | Denial of service | Basic limits only |

## Related

- [[Security Model]]
- [[Authentication and Sessions]]
- [[Device Binding]]
- [[Risk Register]]
- [[Ledger Invariants]]

---
Back to [[00 Home]]
