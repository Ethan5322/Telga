---
title: Persistent Host Deployment Plan
type: operations
status: draft
owner: telga
created: 2026-08-25
updated: 2026-08-25
tags:
  - telga
  - operations
  - deployment
  - training
related:
  - "[[00 Home]]"
  - "[[Training Deployment Architecture]]"
  - "[[Deployment Target Evaluation]]"
  - "[[Persistent Host Runbook]]"
  - "[[Service Startup and Shutdown]]"
  - "[[Backup and Restore Runbook]]"
  - "[[Backup Restore Implementation]]"
  - "[[Health Endpoints]]"
  - "[[Security Deployment Checklist]]"
  - "[[Deployment Runbook]]"
  - "[[Launch Gates]]"
depends_on:
  - "[[Deployment Target Evaluation]]"
  - "[[Backup Restore Implementation]]"
  - "[[Health Endpoints]]"
implements: []
validates: []
decision_status: accepted
---

# Persistent Host Deployment Plan

**A category decision, not a deployment.** No account has been created, no service purchased, no
host provisioned, no DNS changed, no certificate generated, no provider connected, no live money
enabled. The project owner has selected **local/office machine** as the host category for
Phase 2/3 controlled training (§2) — nothing beyond that selection has executed.

> [!danger] Still 0 of 10 launch gates
> Health endpoints and backup/restore tooling are implemented and remotely verified (A61, A62 —
> see [[Health Endpoints]], [[Backup Restore Implementation]]). Neither has run against real
> infrastructure. **Choosing a host category does not change that.** Gate 10, A34/A41, and R31
> all stay OPEN until real evidence exists on the actual host, not a plan for gathering it. A60
> stays OPEN too — the category is selected, but host hardening, backup, restore, HTTPS,
> supervision, and real-infrastructure evidence remain unrecorded. See §2 and the checklist in
> §16.

## 1. Final comparison of the approved categories

[[Deployment Target Evaluation]] compared five categories against nineteen criteria each and
shortlisted two: a small VPS and a local/office machine. Narrowed to a direct comparison for a
final choice:

| Criterion | Local/office machine | Small VPS |
|---|---|---|
| Incremental cost | Lowest — hardware MuleSoo likely already owns | Low, but real and recurring — **NOT YET CONFIRMED**, no vendor chosen |
| Setup friction | None — no account, no payment method, no procurement delay | A vendor account and payment method must exist first |
| Power reliability | Only as good as the office's own supply — **confirmed reliable by the project owner, 2026-08-25** | Provider-grade, independent of the office |
| Network reliability | Only as good as the office's own connection — **confirmed reliable by the project owner, 2026-08-25** | Provider-grade, independent of the office |
| Already private | Yes, trivially — never internet-facing unless deliberately opened | No — reachable by IP unless firewalled deliberately |
| Who can administer it | Whoever has physical or local network access | Whoever holds the account credentials, from anywhere |
| Matches "internal staff only, controlled machine" ([[Training Operations Runbook]]) | Directly | Requires deliberately narrowing access back down to the same posture |
| Redundancy | None — a single point of failure with no backup site | None by default either, but easier to add a second instance later |
| Later production credibility | Poor — no professional operational guarantees | Better, but still not the credible long-term production shape (see [[Vercel Deployment Limits]] "If Vercel hosting is genuinely wanted later" — the real answer is eventually a managed database, not a bigger VPS) |

## 2. Recommendation — decided

> [!success] Decision recorded 2026-08-25
> **Selected category: local/office machine**, for Phase 2/3 controlled training deployment.
> **This is a conditional training decision, not production approval.** Recorded as accepted in
> [[Decision Log]] (D65).

The conditional recommendation below was written before the project owner confirmed the deciding
facts. It is kept for the record; the decision itself is now made.

- **If** the office has power and internet reliable enough to keep a machine reachable during
  training hours, and physical/administrative access is straightforward for whoever runs
  training sessions → recommend the local/office machine. It matches
  [[Training Deployment Architecture]] directly, costs nothing incremental, and needs no vendor
  relationship before Phase 2/3 work can start.
- **If** office power or internet is not reliable enough, or the training pilot needs to be
  reachable by someone not physically at the office → a small VPS, chosen only after MuleSoo
  selects and pays for a specific provider itself (see restriction below).

**The project owner has confirmed**: a reliable office computer is available; the office internet
connection is reliable; the computer can run Telga continuously; the intended use is controlled
training only; remote public access is not required at this stage. On that basis, the first
branch applies — **local/office machine selected.**

**No vendor or VPS is selected — none is needed for this branch.** Re-evaluate this category
choice once real merchant load and reliability data exist, or if remote/public access is ever
needed — Category 5 (managed database + separate host) remains the credible direction for actual
production, per [[Vercel Deployment Limits]] "If Vercel hosting is genuinely wanted later," not a
bigger version of either option here.

## 2a. Training deployment boundary

Selecting the local machine does **not**, by itself, satisfy any of the following — each remains
a separate, unevidenced requirement until the checklist in §16 is actually run:

- **Training-only.** Enforced in code (`--mode LIVE` refused before a database opens), not by the
  host — the host choice does not change this guarantee or weaken it.
- **Operator-network-only.** Not automatic — the host's firewall must be configured (§11); an
  unconfigured local machine on an office network is not automatically restricted to operators.
- **Non-publicly reachable unless separately approved.** Not automatic — depends entirely on the
  office network's own router/firewall configuration, which this plan has not inspected.
- **Isolated from live-money functionality.** Enforced in code and schema (mode is a `CHECK`
  constraint on every money-bearing table) — true regardless of host, not a property the host
  choice grants.
- **Protected by firewall rules.** Not yet configured — see §11 and checklist item 5.
- **Accessible only to authorized operators.** Enforced at the application layer (PIN, device
  binding, sessions) — the host choice does not substitute for this, and does not add to it.
- **Backed up to storage separate from the live machine.** Not yet true — `@telga/backup` exists
  and is tested, but no backup destination has been configured on this host (§8, checklist item
  11).
- **Subject to a tested restore procedure before Gate 10 can be reconsidered.** Not yet
  performed — see §15 and checklist items 12–14.

A local machine is a **location**, not a security posture. Everything above still has to be
configured and evidenced.

## 3. Required host specifications

No load test has been run against this codebase — these are starting-point specifications
appropriate for a handful of training operators, not a sized recommendation from real data.

| Resource | Starting point | Why |
|---|---|---|
| CPU | 2 cores | Matches the CI runner and this project's own dev machine — `test:child-process:stress` and `test:recovery:stress` were calibrated against exactly this (A51) |
| RAM | 1–2 GB | The POS and worker are both small Node processes over SQLite; no in-memory cache of significant size exists in the code |
| Disk | A few GB, growing slowly | The ledger is append-only; size grows with transaction volume, which in training is deliberately low |
| OS | Linux (matches the CI runner and how this codebase has actually been proven to run) or Windows (proven to work locally in this development environment) | Either works; Linux is the more-tested target since CI runs there |
| Network | One inbound port for HTTPS (443 or a chosen port); nothing else needs to be reachable | The worker makes no inbound connections at all |

**Exact figures are NOT YET CONFIRMED** — a real number requires a load test this project has not
run, against real operator counts MuleSoo has not stated.

## 4. Persistent storage requirements

One directory, on a real (not tmpfs/ephemeral) filesystem, holding:

- The SQLite database file (grows with transaction volume — see above)
- Its `-wal` and `-shm` siblings when present — **never** deleted by hand, see
  [[Database Operations Runbook]]
- Backup output from `npm run backup` (a separate directory, per
  [[Backup Restore Implementation]] — never inside the git repository, never committed)

No other durable state exists anywhere in this system — confirmed in
[[Backup and Restore Runbook]] ("What is backed up").

## 5. Process supervision plan

Two long-running processes, supervised independently — see [[Service Startup and Shutdown]] for
the exact commands:

1. **The POS/API process** (`apps/merchant-pos/dist/cli.js`)
2. **The recovery worker** (`services/worker/dist/cli.js`, without `--once`)

Neither depends on the other's process lifecycle, only on the database being migrated first.
**What supervises them is a host-specific choice, not defined by this repository** — `systemd` on
Linux, or an equivalent service wrapper on Windows. Both processes are safe to restart at any
point (every recovery step is idempotent), but the supervisor must not restart either in a tight
loop after a fatal failure — see [[Worker Operations Runbook]] "Procedure — worker is FAILED."

## 6. HTTPS termination plan

Two supported shapes, both already implemented — see [[TLS and Proxy Configuration]] and
[[Training HTTPS Deployment]]:

- **In-process** (`--tls-termination IN_PROCESS`, default): the POS serves TLS itself. Simplest —
  no separate proxy to install or configure. Recommended as the starting point for either host
  category.
- **Trusted proxy** (`--tls-termination TRUSTED_PROXY --trust-proxy <addrs>`): a real reverse
  proxy (nginx, Caddy) terminates TLS in front. There is **deliberately no "trust all proxies"
  option** ([[Decision Log]] D45) — the proxy's own address(es) must be known and stable, which
  rules this mode out for any platform whose proxy addresses are not enumerable.

Either way: a **CA-signed certificate is a prerequisite for anything beyond the controlled
training machine** — a self-signed certificate remains not production trust (A53). Certificate
procurement is out of scope for this plan and is not started here.

## 7. Migration ownership procedure

Exactly one process, once, before anything else starts:

```bash
node services/worker/dist/cli.js --db <path> --migrate --once
```

Neither the worker nor the POS will migrate on their own — both refuse to start (exit `6`)
against an unmigrated database. Concurrent multi-process migration is untested (A30) and stays
out of scope for a training deployment — see [[Migration Ownership]] and
[[Multi-Process Migration Plan]].

## 8. Backup destination and restore procedure

Implemented and tested locally and in CI (A61) — not yet run against real infrastructure.

- **Destination**: a directory outside the git repository, on the same host or (better, once
  practical) a separate volume/host — this plan does not yet specify one, since no host is
  chosen. `TELGA_BACKUP_ALLOWED_ROOTS` must name it explicitly; there is no default.
- **Schedule**: **not yet defined** — `@telga/backup` is a command, not a cron job. Choosing a
  cadence is a real decision, deferred until a host exists to run it on.
- **Procedure**: `npm run backup -- --db <path> --output <path>`, checkpoint-first, checksummed,
  manifest written — see [[Backup Restore Implementation]] for exactly what it does.
- **Restore**: `npm run restore -- --backup <path> --target <path>`, always into an isolated
  target, never the live path, with the session-revoke and claim-release policies from
  [[Backup and Restore Runbook]] (D61).
- **What closing gate 10 still needs**: a real schedule, a real restore performed on the chosen
  host, and a measured time-to-restore — see [[Backup Restore Implementation]] "What remains
  open." Nothing in this plan performs that restore.

## 9. Health-check integration

`GET /api/health/live` and `GET /api/health/ready` are implemented and tested (A62) — see
[[Health Endpoints]]. Once a host is chosen:

- Point the host's process supervisor or reverse proxy at `GET /api/health/ready` for a real
  readiness check (200 = safe to serve, 503 = not).
- `GET /api/health/live` is the right check for "is the process merely alive," if the supervisor
  distinguishes the two.
- Neither endpoint is authenticated, so exposure should be limited the same way the rest of the
  training deployment is — reachable only from the operator network, per
  [[Security Deployment Checklist]] "Firewall / network exposure."
- The worker itself has no HTTP surface; its health is read via
  `node services/worker/dist/cli.js --db <path> --once --json`, run manually or on a schedule the
  supervisor controls — see [[Observability]] "Reading a worker process."

## 10. Worker startup and shutdown order

Full detail in [[Service Startup and Shutdown]]. In outline: migrate → provision the first
operator and device → start the worker and the POS (either order, since neither depends on the
other being up) → confirm health → later, on shutdown, `SIGTERM` the POS first, then the worker,
confirming ledger residual is still zero before and after.

## 11. Firewall and network exposure

- The training deployment should be reachable **only from a defined operator network** — a VPN,
  an office LAN, or an allowlisted IP range. Never the open internet without a specific, separate
  decision to do so.
- Only the HTTPS port needs to be open inbound. The worker makes no inbound connections and needs
  no open port at all.
- **Exact firewall rules depend on the host chosen** — not specified further here, since no host
  exists yet.

## 12. Secret handling

Two deployment secrets exist in this system, per [[Security Model]]:

1. **The recipient-hash salt** — never stored beside the hashes it protects, never logged, never
   committed (`check-committed.mjs` would refuse it if it ever were).
2. **The TLS private key** — supplied by path, **never generated by Telga** — see
   [[Local Certificate Handling]].

Neither has a rotation procedure designed yet — flagged as open in
[[Security Deployment Checklist]] "Secret rotation." Storage mechanism (a local file with tight
permissions, or the host's own secret manager) depends on the host chosen.

## 13. Log rotation and monitoring

- Both processes log to stdout/stderr only — no file-logging path exists in the code today. **Log
  rotation is entirely a host/supervisor responsibility**, not something this repository
  implements — see [[Persistent Host Runbook]], classified "needs infrastructure."
- `evaluateAlerts` (in `@telga/api`) already computes real alert conditions
  (`LEDGER_RESIDUAL_NON_ZERO`, `RECOVERY_WORKER_FAILURES`, etc. — see [[Observability]]) but
  "knows nothing about a paging system" by design. Wiring it to a real alert channel is blocked on
  choosing that channel, which is not done here.
- Monitoring beyond the two health endpoints (§9) is not designed.

## 14. Rollback plan

Already defined and unchanged by this plan — see [[Deployment Runbook]] "Rollback": application
code rolls back safely on its own (the worker holds no state beyond leases, every recovery step
is idempotent). **Rolling back past a migration is not supported** — forward-fix only
([[Decision Log]] D14).

## 15. Restore acceptance test

Not performed by this plan. The full acceptance checklist — eleven items, eight already checked
by automated tests, three requiring real infrastructure — lives in [[Backup and Restore Runbook]]
"Acceptance criteria for closing launch gate 10." Performing the remaining three (a real restore
on the chosen host, a measured time-to-restore, a documented [[Incident]] note) is the concrete
next step **after** a host is chosen and approved — not part of this plan.

## 16. Exact training-only deployment checklist

Everything below must be true before the first real training session on the selected local/office
machine. **Nothing here is checked yet — the category decision in §2 does not evidence a single
one of these.** Documenting a step is not the same as having performed it; no box below may be
marked done merely because this plan describes it.

1. [ ] Confirm host operating system and supported Node runtime (`>=20`, developed on 25.x)
2. [ ] Apply operating-system security updates
3. [ ] Create a dedicated non-admin service account to run the POS and worker processes
4. [ ] Confirm disk capacity and the persistent storage location for the database (§4)
5. [ ] Configure host firewall for operator-network-only access (§11)
6. [ ] Confirm no public inbound exposure — test from outside the operator network
7. [ ] Configure process supervision and automatic restart for both processes (§5)
8. [ ] Configure log rotation and retention (§13)
9. [ ] Configure the two required deployment secrets securely — the recipient-hash salt and the TLS key (§12)
10. [ ] Confirm a secret rotation procedure — not yet designed anywhere in this vault (§12)
11. [ ] Configure a separate backup destination, outside the repository and ideally off the live disk (§8)
12. [ ] Run a real backup (`npm run backup`) and verify its manifest checksum
13. [ ] Perform a real restore on the training host or an approved isolated recovery location (§15)
14. [ ] Capture restore evidence in an [[Incident]] note, per [[Backup and Restore Runbook]]
15. [ ] Verify both health endpoints (`/api/health/live`, `/api/health/ready`) return real, expected results (§9)
16. [ ] Verify worker startup and clean shutdown order, including a real `SIGTERM` drain (§10)
17. [ ] Run the training-only acceptance test — mode refusal, banner text, mock-provider-only, no live money
18. [ ] Document outage and rollback steps for this specific host (§14)
19. [ ] Obtain review before any training use — reviewer **NOT YET ASSIGNED**, per [[Founders and Roles]]
20. [ ] Keep launch gates at 0 of 10 until the required evidence in items 1–19 actually exists

Checking every box above does **not** clear launch gate 10 or any other gate — see
[[Launch Gates]]. It establishes a working training deployment, which is a prerequisite to
gathering the gate-10 evidence, not the evidence itself. This plan does not check any of these
boxes on its own authority.

## 17. Cost and operational assumptions — NOT YET CONFIRMED

Every line below is explicitly unconfirmed. None is invented; none should be treated as a
commitment.

| Assumption | Status |
|---|---|
| Exact VPS provider and its current pricing | **NOT YET CONFIRMED** — no vendor selected; see [[Deployment Target Evaluation]] "No prices are claimed here" |
| Office machine's actual power/internet reliability | **Confirmed reliable by the project owner, 2026-08-25** — the specific machine, its specs, and who administers it day to day remain unconfirmed |
| Who administers the host day to day | **NOT YET CONFIRMED** — DevOps/SRE owner is "NOT YET ASSIGNED" per every runbook in this vault |
| Backup retention duration and destination | **NOT YET CONFIRMED** — `retentionCount` exists in `@telga/backup`'s configuration and deliberately does nothing yet, see [[Backup Restore Implementation]] |
| TLS certificate provider and renewal process | **NOT YET CONFIRMED** |
| Expected training operator count and session frequency | **NOT YET CONFIRMED** — drives the resource sizing in §3, which is a starting point, not a measurement |
| Monthly or annual budget for any paid option | **NOT YET CONFIRMED** — no pilot budget exists in this repository; recorded as the founder's own "NOT YET CONFIRMED" pilot-budget line in `ASSUMPTIONS.md` |

## What this plan does not do

- Does not select a vendor.
- Does not create an account or spend money.
- Does not provision, deploy, or change DNS.
- Does not generate or obtain a certificate.
- Does not connect a provider or enable live money.
- Does not close gate 10, R31, A34/A41, or A60.
- Does not change Vercel settings — A56/R30 remain unaffected and open.

## Related

- [[Training Deployment Architecture]]
- [[Deployment Target Evaluation]]
- [[Persistent Host Runbook]]
- [[Service Startup and Shutdown]]
- [[Backup and Restore Runbook]]
- [[Backup Restore Implementation]]
- [[Health Endpoints]]
- [[Security Deployment Checklist]]
- [[Deployment Runbook]]
- [[Launch Gates]]

---
Back to [[00 Home]]
