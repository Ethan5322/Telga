# Security

Telga is the merchant digital-vending platform of **MuleSoo Digital Services**.
It handles merchant credentials, transaction records and — once the gates in
`CLAUDE.md` §8 are met — money. Security reports are welcome and taken
seriously.

## Reporting a vulnerability

**Do not open a public issue.** Email **mulukenendashaw68@gmail.com** with:

- what you found, and where (file, endpoint, or screen)
- how to reproduce it — the smallest sequence that shows the problem
- what an attacker gets out of it
- anything you already know about a fix

You will get an acknowledgement within **3 working days** and an assessment
within **10**. If a report is valid we will tell you what we are doing about it
and when; if we disagree we will say why rather than go quiet.

Please give us a reasonable chance to fix an issue before describing it
publicly. Telga has merchants whose livelihoods depend on it, and a disclosed
hole in a payment-adjacent system is not an abstract risk to them.

### Please do not

- run tests against a live merchant's data or device
- attempt denial of service
- use social engineering against MuleSoo staff or merchants

Everything in this repository can be run locally — `npm run training:serve`
starts a full instance in training mode with simulated funds — so there is no
need to touch anybody's real installation to demonstrate a finding.

## Scope

**In scope:** authentication and session handling, authorization and RBAC,
device binding, merchant data isolation, the ledger and balance invariants,
idempotency and duplicate prevention, admin console access control, webhook
verification, injection of any kind, secret handling.

**Out of scope:** anything requiring physical possession of an unlocked
merchant device; findings that depend on a merchant deliberately sharing their
PIN; the deliberate absence of features listed as disabled in `CLAUDE.md` §7.

## What is deliberately not built yet

Stated plainly so nobody spends time reporting a known gap:

- **Live money is off.** Payment acceptance, wallets, cash-in/out, lending,
  remittance and independent settlement are disabled by feature flag and are
  not merely hidden. See `CLAUDE.md` §7 and `02 Product/Feature Flags`.
- **The WebAuthn passkey is not implemented.** The `admin_users` columns exist
  and TOTP is enforced, but no passkey ceremony is wired up. Tracked as `A88`.
- **No production deployment exists, and none is planned yet.** A **training
  deployment** to Railway is being prepared — one service, one replica, SQLite
  on a persistent volume, reachable only at a Railway-generated temporary HTTPS
  address. It runs in `TRAINING MODE — NO REAL VALUE` with a mock provider and
  simulated funds. It is **not** a production system, must not be described as
  one, and no merchant will be given the URL. The purchased domain
  `telga.pro` is deliberately **not** attached. Until that deployment exists
  and is verified, there is still no hosted Telga at all. Tracked as `A89`,
  `A94`; the deployment decision is Decision Log `D108`.

## What is enforced today

| | |
|---|---|
| Admin second factor | **TOTP, RFC 6238**, verified against the RFC's published test vectors. An admin cannot perform privileged work on a session that has not cleared it |
| Admin step-up | High-risk actions re-ask for the **password**, not the code — a code from a device on the same desk does not prove who is sitting there |
| Passwords | Derived only. There is no column a plaintext password could go in |
| Device enrolment | One-time tokens: 100 bits of entropy, single-use, stored hashed, one-hour expiry, never a permanent secret in the APK |
| Admin permissions | A grant table where **absence is denial** — least privilege by construction, switchable per admin |
| Ledger | Append-only. Corrections are authorised adjustment entries, never edits |
| Money | Integer minor units. Never binary floating point |
| Transport | The Android shell is HTTPS-only and refuses mixed content; there is no dialogue to click past a bad certificate |
| Session storage on device | Android backup and device-transfer are both **off**, so a live session cannot leave the phone it was authenticated on |
| Secrets | Never committed. `.gitignore` refuses `*.jks`, `*.keystore` and `keystore.properties` |

## Handling of your report

We will not take legal action against anyone who reports in good faith, follows
this policy, and gives us a chance to respond. If you would like credit for a
valid finding, say so and we will name you; if you would rather not be named,
that is fine too.

## Related documentation

- `docs/obsidian/09 Engineering/Security Model.md` — the threat model
- `docs/obsidian/09 Engineering/Security Deployment Checklist.md`
- `docs/obsidian/07 Governance/Risk Register.md`
- `CLAUDE.md` §24 — the standing security rules for this repository
