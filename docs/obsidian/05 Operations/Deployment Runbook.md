---
title: Deployment Runbook
type: operations
status: draft
owner: telga
created: 2026-08-20
updated: 2026-08-20
tags:
  - telga
  - operations
  - runbook
  - deployment
related:
  - "[[00 Home]]"
  - "[[Runbooks]]"
  - "[[Recovery Worker]]"
  - "[[Worker Configuration]]"
  - "[[Migration Strategy]]"
  - "[[Launch Gates]]"
depends_on:
  - "[[Worker Configuration]]"
implements: []
validates: []
decision_status: pending
---

# Deployment Runbook

Owner: DevOps / SRE — **NOT YET ASSIGNED** ([[Founders and Roles]]).

> [!danger] Nothing is deployable to production yet
> **0 of 10 [[Launch Gates]] are cleared**, no environment exists, and every production
> configuration value is `NOT_YET_CONFIRMED`. This runbook records the sequence and the constraints
> so they are decided deliberately rather than improvised on the day.

## Building the runtime

```bash
npm install
npm run build:clean
```

Each package compiles to its own `dist/`; the deployed entry point is
`services/worker/dist/cli.js`. The build refuses to finish if TypeScript leaks into the output, so
nothing but JavaScript is ever required at runtime. Details and the CommonJS rationale are in
[[Build Pipeline]].

`dist/` is generated and git-ignored — build on the target, or ship the built directory
deliberately.

## What exists to deploy

| Component | Status |
|---|---|
| Build output `dist/` | **Exists.** 58 `.js`, 58 `.d.ts`, 0 `.ts` |
| `packages/domain` | Library — no runtime |
| `packages/persistence` | Library — owns the SQLite file |
| `services/provider-adapters/mock-airtime` | **Mock only.** No live provider exists |
| `services/api` | Application services — no HTTP server yet |
| `services/worker` | The recovery worker — a long-running process |
| `apps/*` | **Not built** |

The worker is currently the only long-running process in the system.

## Deployment sequence

1. **Confirm configuration.** Every production value must be explicit; the worker refuses to start otherwise. See [[Worker Configuration]].
2. **Apply migrations first, on a single writer**, with `--migrate`. The worker now **refuses to start** (exit 6) against an unmigrated database, so this step cannot be skipped by accident — see [[Migration Ownership]]. Concurrent multi-process migration remains untested (A30) — [[Multi-Process Migration Plan]].
3. **Verify database health.** `driver.health()` must report `integrity_check = ok`, `foreign_keys = 1`, `journal_mode = wal`, and a **zero ledger residual**.
4. **Start the worker.** Confirm `status = RUNNING` and a first successful sweep.
5. **Watch the first few sweeps.** `lastSuccessfulSweepAt` advancing and `consecutiveFailures` at zero.

## Rolling a new version

1. Start the new worker before stopping the old one, or accept a gap — either is safe. Claims are leased, so an overlap produces conflicts rather than duplicate work.
2. Send SIGTERM to the old worker and let it drain. It stops scheduling, finishes its sweep at a safe boundary, releases only its own claims, and closes the database.
3. If the old worker is killed instead, its leases expire and the new worker reclaims them. No cleanup.

## Rollback

**Forward-fix only for schema** ([[Decision Log]] D14). There are no `down` migrations, and a ledger cannot be un-migrated without risking history.

For application code, rolling back the worker binary is safe on its own — the worker holds no state
beyond leases, and every recovery step is idempotent. Rolling back **past a migration** is not
supported.

## Environment separation

Production must not share a database file, a recipient hash salt, or configuration with any other
environment. The salt is a deployment secret: it is never stored beside the hashes it protects and
never appears in a log or on a receipt — see [[Security Model]].

## Before this runbook can be completed

| Gap | Blocks |
|---|---|
| No environment defined | Everything below |
| All worker configuration `NOT_YET_CONFIRMED` | Step 1 |
| Backup and restore untested | [[Launch Gates]] gate 10 |
| Multi-process migration untested (A30) | Step 2 at more than one instance |
| ~~Multi-process worker safety untested (A37)~~ | **Resolved** — proved with real child processes |
| CI authored but never executed (A43) | Confidence in any deploy |
| No monitoring or alerting wired | Steps 4 and 5 |

## What must never be done

| Action | Why |
|---|---|
| Deploying with development configuration | Refused in code |
| Running migrations from two processes at once | Untested — A30 |
| Deleting a `-wal` file by hand | It may hold committed transactions |
| Rolling back past a migration | No `down` path exists, by design |
| Marking a launch gate cleared to unblock a deploy | The gates are the control |

## Provisioning identity — 2026-08-21

A deployment now needs operators and enrolled devices before anyone can sign in.
There is no default account and no bootstrap password.

```bash
# 1. One writer applies migrations, once.
node services/worker/dist/cli.js --db ./telga.sqlite --migrate --once

# 2. Create the operator and enrol the device. Prints the device key ONCE.
node apps/merchant-pos/dist/cli.js --db ./telga.sqlite \
  --merchant merchant_alpha --operator operator_1 --device device_1 \
  --provision-pin 481502

# 3. Serve.
node apps/merchant-pos/dist/cli.js --db ./telga.sqlite --merchant merchant_alpha
```

Step 2 exits after printing. Capture the device key: Telga stores only a scrypt
hash of it and cannot show it again.

Migration **006** adds `merchant_users`, `device_enrollments`, `sessions` and
`auth_attempts`. It creates tables only — it alters nothing existing, drops
nothing, and leaves the ledger and its append-only triggers untouched. Asserted
directly in `tests/auth/migration.test.ts`.

> [!warning] `--https` is false by default
> The training machine serves plain HTTP, so session cookies are **not** marked
> `Secure` — claiming it over HTTP makes browsers drop them. Pass
> `--https true` only behind a real TLS terminator. Until then this is a
> single-machine deployment and nothing else. **A53 OPEN.**

Operational procedures — lockouts, lost devices, stale forms — are in
[[Training Operations Runbook]].


## Transport — 2026-08-21

See [[Training HTTPS Deployment]] for the full flag list, and
[[TLS and Proxy Configuration]] for the reverse-proxy boundary.

The deployment posture is now an **explicit choice**, and unsafe combinations
refuse to start with exit 4 rather than serving:

- plain HTTP bound to anything but loopback — refused;
- HTTPS without a certificate and key — refused;
- a certificate and key that do not match — refused, at startup;
- proxy termination without an explicit trusted-address list — refused.

> [!warning] A self-signed certificate is not production trust
> It encrypts the wire for the controlled training machine. It proves nothing
> about who is on the other end. **A53 stays open.**

Certificates are supplied by path and never generated. `check-committed.mjs`
refuses to let `.pem` or `.key` be tracked.


## Related

- [[Recovery Worker]]
- [[Worker Configuration]]
- [[Worker Operations Runbook]]
- [[Migration Strategy]]
- [[Database Operations Runbook]]
- [[Launch Gates]]

---
Back to [[00 Home]]
