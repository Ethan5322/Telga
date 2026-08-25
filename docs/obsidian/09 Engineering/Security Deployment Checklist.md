---
title: Security Deployment Checklist
type: engineering
status: draft
owner: telga
created: 2026-08-24
updated: 2026-08-24
tags:
  - telga
  - engineering
  - security
  - deployment
related:
  - "[[00 Home]]"
  - "[[Security Model]]"
  - "[[Threat Model]]"
  - "[[Training Deployment Architecture]]"
  - "[[Persistent Host Runbook]]"
- "the health endpoints note (implemented separately)"
depends_on:
  - "[[Security Model]]"
  - "[[Threat Model]]"
implements: []
validates: []
decision_status: draft
---

# Security Deployment Checklist

What is already true in code (with a test behind it), and what remains an
open limitation, for a real [[Training Deployment Architecture]]. This is a
review, not new controls — nothing here changes application behaviour.

> [!danger] The result is training-only, not production trust
> Every "already enforced" row below holds *within* the training-grade
> limitations already documented (A52, A53, A48). This checklist does not
> upgrade any of them. A self-signed certificate is not production trust
> regardless of how correctly it is deployed.

## HTTPS certificate trust

**Already enforced, training-grade only.** The CLI validates the certificate
and key match, checks expiry, and refuses a world-readable key file on POSIX
— see [[Local Certificate Handling]] and `tests/transport/tls.test.ts`. A
self-signed certificate is **not** production trust (A53) — it encrypts the
wire but proves nothing about who is on the other end. A CA-signed
certificate is a prerequisite for anything beyond the controlled training
machine.

## Secure cookies

**Already enforced.** The session cookie is marked `Secure` when the
request's actual scheme is HTTPS, decided per request rather than assumed —
see [[Authentication and Sessions]] and [[TLS and Proxy Configuration]].
Plain HTTP is refused on any non-loopback binding, so a cookie is never sent
`Secure` over a connection that isn't.

## Trusted proxy configuration

**Already enforced.** `TRUSTED_PROXY` termination requires an explicit
address list; there is deliberately no "trust all proxies" option
([[Decision Log]] D45). For a real deployment, the proxy address(es) must be
known and stable — a platform whose proxy addresses are not enumerable
cannot use this mode safely (this is the same reasoning that rules out
Vercel — see [[Vercel Deployment Limits]]).

## Host/origin allowlist

**Already enforced.** `--allowed-hosts` is required; a request naming an
unlisted host is refused. Cross-origin state-changing requests are refused
(CSRF protection) — see `tests/transport/https-server.test.ts` "refuses a
cross-origin state-changing request."

## Firewall / network exposure

**Needs infrastructure decision** — not something code enforces. See
[[Training Deployment Architecture]] "Network exposure": the deployment
should be reachable only from a defined operator network. This is a host/network
configuration step for whoever provisions the chosen target in
[[Deployment Target Evaluation]], not a code gap.

## Operator PIN handling

**Already enforced.** PINs are scrypt-hashed with per-user salts, never
stored raw, and lockout applies after a configured number of failures — see
[[Authentication and Sessions]] and `tests/auth/authentication.test.ts` "has
no raw PIN anywhere in the database file."

## Device binding — limitation A52

**Open limitation, not a deployment gap.** A browser-supplied device id plus
a server-issued key raises impersonation from "know the id" to "hold the
key," with enrolment, revocation, expiry and merchant assignment enforced on
every request — but it is **not hardware attestation**: a copied id and key
on another machine are indistinguishable from the original. This is a
property of the current design, not something a deployment choice can fix.
See [[Device Binding]].

## Browser security coverage — limitation A48

**Open limitation.** UI tests are component-level: no real browser, no CSS
rendering, no screen reader. A deployment does not change this — it is a
testing-coverage gap, not a deployment-configuration one. See A48 in
`ASSUMPTIONS.md`.

## Session expiry and revocation

**Already enforced.** Sessions expire on both an idle timeout and an
absolute lifetime; revoking a device or ending a session invalidates it
immediately, checked on every request — see [[Authentication and Sessions]]
and [[Device Binding]] "the binding is checked on every request."

## Backup confidentiality

**The backup tool now exists (the backup/restore implementation note (implemented separately)); its
file-level confidentiality is still not designed.** The manifest is
deliberately minimal — counts and a checksum, never row content, never a
full host path (see `sourceIdentifierOf`) — but the backup *file itself* is
a plain, unencrypted copy of the database, containing session fingerprints
and hashed credentials, never raw secrets. Backup file permissions,
encryption at rest, and retention remain undesigned and unimplemented —
`retentionCount` exists in the tool's configuration but deliberately does
nothing, see the backup/restore implementation note (implemented separately) "Configuration."

## Database file permissions

**Needs documentation.** No written guidance exists for the database file's
own filesystem permissions (as opposed to the certificate/key permission
checks, which are enforced in code). See [[Persistent Host Runbook]].

## Log redaction

**Already enforced.** `assertSafeLogDetail` refuses PINs, passwords,
secrets, tokens, credentials, authorization headers, and recipient/phone
numbers before they reach any log sink — a test asserts every forbidden key
is refused. See [[Observability]] "Never logged."

## Secret rotation

**Not designed.** The recipient-hash salt and the TLS key are the two
deployment secrets (see [[Security Model]]); no rotation procedure exists
for either. Flagged as an open item, not addressed by this checklist.

## Admin access

**Not applicable yet.** No admin role beyond `owner`/`operator` exists in
the current authorization model — see [[Authentication and Sessions]] and
`tests/auth/authorization.test.ts`. Nothing to review here until an admin
surface exists.

## Migration access

**Already enforced by design, needs a host-level access control.** Only one
process may apply migrations, enforced by the migrator itself
([[Migration Ownership]]) — but *who on the host is permitted to run the
migrate command* is a host-access-control question, not something the code
restricts. Belongs in whatever access-control policy the chosen host defines.

## Worker access

**Already enforced by design.** The worker requires explicit configuration
in production shape and refuses to run with development defaults; who may
start/stop it is, like migration access, a host-level access-control
question.

## Summary

| Area | Status |
|---|---|
| HTTPS certificate trust | Enforced, training-grade only (A53) |
| Secure cookies | Enforced |
| Trusted proxy configuration | Enforced |
| Host/origin allowlist | Enforced |
| Firewall/network exposure | Needs an infrastructure decision |
| Operator PIN handling | Enforced |
| Device binding | Open limitation (A52), not fixable by deployment choice |
| Browser security coverage | Open limitation (A48), not fixable by deployment choice |
| Session expiry and revocation | Enforced |
| Backup confidentiality | Not yet designed in detail |
| Database file permissions | Needs documentation |
| Log redaction | Enforced |
| Secret rotation | Not designed |
| Admin access | Not applicable yet |
| Migration access | Enforced in code; host access control still needed |
| Worker access | Enforced in code; host access control still needed |

## What this note does not do

- Does not upgrade A52, A53, or A48.
- Does not implement backup encryption, secret rotation, or file-permission
  documentation — flags them as open.
- Does not describe any certificate as production trust.

## Related

- [[Security Model]]
- [[Threat Model]]
- [[Training Deployment Architecture]]
- [[Persistent Host Runbook]]
- [[Backup and Restore Runbook]]
---
Back to [[00 Home]]
