---
title: Security Model
type: engineering
status: draft
owner: telga
created: 2026-08-19
updated: 2026-08-19
tags:
  - telga
  - engineering
  - security
related:
  - "[[00 Home]]"
  - "[[Architecture]]"
  - "[[API Contracts]]"
  - "[[Testing Strategy]]"
depends_on:
  - "[[Architecture]]"
implements: []
validates: []
decision_status: draft
---

# Security Model

## Roles

| Role | Can | Cannot |
|---|---|---|
| `MERCHANT_OPERATOR` | Sell, search own transactions, reprint, raise a case | See another merchant's data; change balance; verify funding |
| `MERCHANT_OWNER` | All operator rights, plus reports, users, funding submission | Verify their own funding; change ledger |
| `OPS_VERIFIER` | Verify funding submissions | Approve high-value alone; perform reconciliation |
| `OPS_APPROVER` | Second approval on high-value funding | Perform reconciliation |
| `OPS_RECONCILER` | Daily reconciliation | Verify or approve funding |
| `OPS_SUPPORT` | Resolve cases, view transactions across merchants | Change balances directly |
| `ADMIN` | Configuration, flags, roles | Enable `money.live` alone — requires dual approval |

**No role can edit the ledger.** Corrections are adjustment entries, authorized and audited —
[[Ledger Invariants]] rule 8.

Separation of duties for funding is enforced by role, not by policy: `OPS_VERIFIER`,
`OPS_APPROVER` and `OPS_RECONCILER` are mutually exclusive on a single submission —
[[Funding Verification]].

## Authentication

| Control | Detail |
|---|---|
| Operator PIN | Per user, never shared. Rate-limited, lockout on repeated failure |
| Device binding | Every session bound to a registered `Device` and its merchant |
| Session revocation | Immediate, per user or per device |
| Remote stop | Stops new sales; **never deletes history** — [[Merchant Onboarding]] |

A PIN alone is not identity — a PIN **on a bound device** is. A correct PIN on an unregistered
device is refused.

## Data isolation

Every query is scoped by merchant at the data layer, not by a filter the caller supplies.
Cross-merchant access is a security test case, not a code-review hope — [[Testing Strategy]].

## Secrets

| Rule | Enforcement |
|---|---|
| Never commit secrets | Repository scanning; `SECURITY.md` |
| Never expose provider secrets to a client | Secrets are server-side only — [[Architecture]] |
| Rotate on suspicion | Runbook required — [[Runbooks]] |
| Restricted production access | Named individuals only; NOT YET ASSIGNED |

## Webhooks

Signature verification · replay protection with a bounded window · idempotent application ·
unknown-reference callbacks logged and discarded, never auto-creating a transaction.

## Audit

Every mutation emits an `AuditEvent`: actor, role, device, merchant, action, before/after state,
timestamp. Audit records are **append-only**; tampering is a security test case.

## Database-level controls

Implemented in [[SQLite Persistence Layer]]. These hold even when application code is bypassed.

| Control | Mechanism | Test |
|---|---|---|
| Ledger immutability | `BEFORE UPDATE` / `BEFORE DELETE` triggers abort | `a direct SQL UPDATE fails` |
| Audit immutability | Same triggers on `audit_events` | `audit events cannot be silently modified` |
| No live-money rows | `mode` CHECK constrained to `'TRAINING'` | `reject a live-money row outright` |
| No float money | STRICT tables, no `REAL` column in the schema | `reject a float in an integer money column` |
| Referential integrity | `foreign_keys = ON`, asserted by readback | `foreign keys are actually enforced, not merely reported on` |
| Merchant scoping | Every scoped query filters in SQL | `merchant A cannot read merchant B's transaction` |
| Idempotency scoping | PK `(merchant_id, key)` | `the same key from a different merchant is a separate record` |

## Recipient data minimization

A full recipient number is **never stored**. `transactions` holds a mask (`09******00`) and a
**salted** SHA-256 hash. The salt is a deployment secret, is not stored beside the hash, and never
appears in a log or on a receipt — an unsalted digest of a phone number is a rainbow-table lookup,
not a protection.

`assertSafeMetadata` refuses any metadata key resembling a PIN, password, secret, token,
credential, authorization header, recipient or phone number **before** it can reach a row. Blunt on
purpose: metadata columns are where sensitive values leak into a database by accident.

Retention period remains **NOT YET CONFIRMED** — see [[Legal Questions]] L15.

## Platform controls

Encryption in transit and at rest · input validation at every boundary · rate limiting on auth and
sales · security headers · dependency scanning · data minimization · retention and deletion policy
(**period NOT YET CONFIRMED**, see [[Legal Questions]] L15) · backups with tested restore.

## Threat notes

| Threat | Control |
|---|---|
| Duplicate submission to double-vend | Idempotency key + payload check — [[Idempotency]] |
| Forged or replayed provider callback | Signature + replay window |
| Client-side balance manipulation | Balance is server-derived; client figures are display only |
| Privilege escalation to approve own funding | Mutually exclusive ops roles |
| Stolen device | Device binding, PIN, remote stop |
| Secret leakage into logs | Redaction; no provider secrets client-side |
| Audit tampering | Append-only, tested |

## Implemented: authentication and device binding — 2026-08-21

The RBAC and session model described above is now **built and tested**, for
controlled internal training. Two notes carry the detail:

- [[Authentication and Sessions]] — sign-in, sessions, cookies, CSRF, lockout,
  rate limits, and what is stored versus what is never stored.
- [[Device Binding]] — enrolment, revocation, expiry, merchant assignment, and
  an honest account of what a browser-supplied device id is worth.

What changed in one sentence: **identity comes from a server-side session row,
never from a URL, a form field or a header the page could set.**

| Control | Status |
|---|---|
| RBAC | Permission table in `packages/domain/src/auth.ts`; every role answers for every permission |
| Merchant isolation | Enforced in SQL on every query, scoped by the session |
| Strong auth and PIN policy | 6–12 digits, not repeated, not sequential; scrypt with per-user salt |
| Device binding | Enrolment + server-issued key, checked on **every** request — training-grade, A52 |
| Session revocation | Logout, idle timeout, absolute lifetime, device revocation, operator reassignment |
| Webhook signatures | **Not built.** No provider callback endpoint exists yet |
| Encryption at rest | **Not built.** [[Threat Model]] T9 |
| Secret management | Recipient salt is per-run; no deployment secret store yet |
| Rate limiting | Login and sale, both configured, both training values |
| Audit logs | Every auth success and every refusal, with safe codes only |

Two locks on the money controls, not one: the grant table does not give a
merchant role `REVERSAL_APPROVE`, `FUNDS_RELEASE`, `TRANSACTION_FORCE_STATE`,
`RECOVERY_CONFIGURE`, `PROVIDER_OVERRIDE_OUTCOME`, `ADMIN_DIAGNOSTICS` or
`DEVICE_REVOKE`, **and** `FORBIDDEN_TO_MERCHANT` is consulted independently, so
a mistaken grant still fails. See [[Decision Log]] D40.

There is **no HTTP route** that completes a reversal, forces a state or releases
funds. The supervisor approval in `reversal.ts` has no UI path around it.

## Transport — 2026-08-21

| Control | Status |
|---|---|
| TLS in transit | **Implemented** for `TRAINING_HTTPS`; self-signed, so A53 is reduced not closed |
| Secure cookies | Derived per request from the client's scheme |
| CSP | `default-src 'none'` with a **per-response nonce**; `unsafe-inline` removed (D44) |
| Security headers | `nosniff`, `no-referrer`, `Permissions-Policy`, COOP, CORP, `no-store` on session-sensitive pages |
| HSTS | Available, off by default, refused on plain HTTP |
| Host allow-list | Enforced; an unrecognised `Host` is a 400 |
| Origin check | On state-changing methods; a missing `Origin` is accepted, a wrong one refused |
| Proxy trust | Explicit address list only; **no "trust all" setting** (D45) |
| Key management | Telga never generates or writes key material (D47) |

Details in [[Training HTTPS Deployment]], [[TLS and Proxy Configuration]] and
[[Local Certificate Handling]].


## Related

- [[Architecture]]
- [[API Contracts]]
- [[Testing Strategy]]
- [[Funding Verification]]

---
Back to [[00 Home]]
