---
title: Localhost Setup
type: operations
status: draft
owner: devops-sre
created: 2026-09-05
updated: 2026-09-05
tags: [telga, operations, deployment, training]
related:
  - "[[00 Home]]"
  - "[[Service Startup and Shutdown]]"
  - "[[Railway Deployment Checklist]]"
  - "[[Backup and Restore Runbook]]"
  - "[[Training Operations Runbook]]"
  - "[[Migration Ownership]]"
depends_on:
  - "[[Service Startup and Shutdown]]"
validates: ["[[Service Startup and Shutdown]]"]
decision_status: accepted
---

# Localhost Setup

**TRAINING MODE — NO REAL VALUE.** Every command here runs against a simulated
ledger with a mock provider. Nothing touches real money.

This is the whole local loop, as actually executed on 2026-09-05. Every command
below was run, and the *Verified* section records what came back — not what was
expected.

## Prerequisites

Node `>=20` (this run used v25.9.0) and npm. `better-sqlite3` is a native
module, so the first `npm ci` compiles it.

## The five steps

```bash
# 1. build — refuses to finish if TypeScript leaks into dist/
npm ci
npm run build:clean

# 2. migrate — ONE writer, to completion, before anything else starts
node services/worker/dist/cli.js --db ./telga.sqlite --migrate --once

# 3. provision the first operator and device (prints the device key ONCE)
node apps/merchant-pos/dist/cli.js --db ./telga.sqlite \
  --merchant merchant_alpha --operator operator_1 --device device_1 \
  --provision-pin 481502 --training-float 5000

# 4. the recovery worker (long-running)
node services/worker/dist/cli.js --db ./telga.sqlite

# 5. the POS / API (long-running), in another terminal
node apps/merchant-pos/dist/cli.js --db ./telga.sqlite \
  --merchant merchant_alpha --host 127.0.0.1 --port 4321
```

Then open `http://localhost:4321/login`.

Neither the worker nor the POS will migrate on its own: both exit `6` against
an unmigrated database ([[Migration Ownership]]). Step 2 is not optional.

> [!note] Plain HTTP is loopback-only, by refusal
> The POS refuses to bind beyond loopback over plain HTTP. The safety argument
> for HTTP is that nobody else can reach it, and a LAN binding removes that
> argument, so it is refused rather than warned about. For anything beyond this
> machine use `--transport TRAINING_HTTPS`.

## Running it the way the cloud will

The same supervisor a Railway service would run, exercised locally:

```bash
TELGA_DB_PATH=/abs/path/data/telga.sqlite \
RAILWAY_VOLUME_MOUNT_PATH=/abs/path/data \
TELGA_MERCHANT_ID=merchant_alpha \
TELGA_ALLOWED_HOSTS=127.0.0.1,localhost \
TELGA_TRUST_PROXY=127.0.0.1/32 \
PORT=4500 \
node scripts/deploy/railway-start.mjs
```

It migrates, then starts the worker and the POS, and stops **both** if either
one exits. See [[Railway Deployment Checklist]].

## Health

```bash
curl -s http://127.0.0.1:4321/api/health/live
curl -s http://127.0.0.1:4321/api/health/ready
```

## Backup and restore

The backup tool has **no default allow-list**: an unset
`TELGA_BACKUP_ALLOWED_ROOTS` refuses every path rather than guessing a root.

```bash
export TELGA_BACKUP_ALLOWED_ROOTS=/abs/path/to/workdir      # ';'-separated on Windows

node services/backup/dist/cli.js backup \
  --db ./telga.sqlite --output ./backups/telga-test.sqlite

node services/backup/dist/cli.js restore \
  --backup ./backups/telga-test.sqlite --target ./restored.sqlite
```

## Verified on 2026-09-05

Run on Windows 11, Node v25.9.0.

| Check | Result |
|---|---|
| `npm run typecheck` | passes, exit 0 |
| `npm test` | **88 files, 1385 tests, all passed** |
| `npm run build:clean` | 159 `.js`, 159 `.d.ts`, **0 `.ts`** |
| Migrations on a fresh database | 14 applied (`001`–`014`), 28 tables, `journal_mode=wal` |
| Provisioning | operator, device and a 5000 birr **simulated** float; device key printed once |
| `/api/health/live` | `200`, `{"status":"HEALTHY","mode":"TRAINING"}` |
| `/api/health/ready` | `HEALTHY` on `mode`, `database`, `ledger_residual`, `recovery_queue`, `recovery_claims` |
| Ledger residual | `0` — debits equal credits |
| Restart persistence | ledger entries, users and devices all survived; the restart itself was audited (7 → 8 events) |
| Backup | manifest with schema `014`, `ledgerResidualMinor: 0`, SHA-256 checksum |
| Restore to a new file | identical checksum, `integrityCheck: "ok"`, `appendOnlyVerified: true` |
| The restored database served traffic | POS started against it; readiness `HEALTHY` |
| Supervisor, worker killed | POS stopped too; exit `5`, as designed |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Exit `6` on start | Migrations not applied | Run step 2 |
| Exit `3` | Mode is not `TRAINING` | Nothing else is supported |
| `Refusing to use "…": it does not resolve inside an allowed training path` | `TELGA_BACKUP_ALLOWED_ROOTS` unset or too narrow | Set it to an absolute root containing both the database and the output |
| Signed in, then immediately signed out | A `Secure` cookie over a connection Telga thinks is HTTP | Behind a proxy, the hop is not trusted — look for `PROXY_PEER_OBSERVED` |
| `PROXY_TRUST_ENTRY_INVALID` at startup | A malformed `--trust-proxy` entry, or a `/0` prefix | Name a real address or range; `/0` is refused deliberately |
| `400` on every request | The `Host` header is not in `--allowed-hosts` | Add the host you are actually using |
| Port already in use | An earlier POS is still running | Stop it, or pass a different `--port` |

## Related

- [[Service Startup and Shutdown]]
- [[Railway Deployment Checklist]]
- [[Backup and Restore Runbook]]
- [[Training Operations Runbook]]

---
Back to [[00 Home]]
