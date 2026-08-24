---
title: Vercel Deployment Limits
type: engineering
status: draft
owner: telga
created: 2026-08-24
updated: 2026-08-24
tags:
  - telga
  - engineering
  - deployment
  - training
related:
  - "[[00 Home]]"
  - "[[Architecture]]"
  - "[[Deployment Runbook]]"
  - "[[Training HTTPS Deployment]]"
  - "[[SQLite Persistence Layer]]"
  - "[[Recovery Worker]]"
depends_on:
  - "[[Architecture]]"
decision_status: accepted
---

# Vercel Deployment Limits

The GitHub repository is connected to Vercel, so a push deploys. This note
records what that deployment can and cannot be.

> [!danger] Telga does not run on Vercel — this is deployment-blocking, not a gap to close casually
> The platform is a **stateful, long-running system**: a local SQLite ledger, a
> supervised recovery worker, server-side sessions, and single-writer migrations.
> Vercel runs **stateless, ephemeral functions**. These are not the same shape,
> and the mismatch is not a configuration problem.
>
> A Vercel deployment of this repository is a **build artifact, not a running
> Telga**. Treat any Vercel URL as training/preview only, and never as a merchant
> or production system.
>
> **A GitHub push to this repository must never be treated as a production
> Vercel deployment.** If a Vercel project is already connected, its automatic
> production deployments should be paused or disabled until a compatible
> deployment target exists (see *If Vercel hosting is genuinely wanted later*,
> below). Do not add a `vercel.json`, placeholder API route, static export,
> serverless adapter, or SQLite workaround merely to make a deployment report
> success — none of those change the underlying storage or process model.
> Recorded as **A56 / R30 — OPEN, deployment-blocking**.

## What Vercel would find in this repository

| Vercel looks for | Present? |
|---|---|
| `api/` serverless functions | **No** |
| `public/` static output | **No** |
| A framework preset (Next, Nuxt, Astro, SvelteKit, Remix) | **No** |
| `vercel.json` | **No** |
| A `build` script | **Yes** — `npm run build`, which runs `tsc` |

So Vercel would run the TypeScript build and then have nothing it recognises to
serve. `dist/` is git-ignored and is not a web root.

The likely outcomes are a **failed build** or an **empty deployment**. Both are
harmless. One outcome is worth watching for, in *What to watch for* below.

## Why the architecture does not fit

### The ledger is a local file

`better-sqlite3` opens a file on disk, in WAL mode. A serverless function gets an
ephemeral filesystem that is discarded when the instance is recycled, and two
concurrent invocations get **different** instances.

That is not "slow" or "lossy". It means two requests could each open their own
copy of the ledger and both believe they hold the truth. Every guarantee in
[[Ledger Invariants]] assumes one shared file.

### The claim lease assumes one shared database

`recovery_claims` is what stops two workers resolving the same transaction twice
— the property proved across real processes and recorded as A37 / R16. It works
because both processes write to **the same file**. Without that, the lease
protects nothing and duplicate recovery becomes possible: the exact failure the
whole design exists to prevent.

### The recovery worker is a supervised loop

It runs continuously, sweeping on a fixed delay, holding leases, backing off on
failure. Serverless has no long-running process. A scheduled function could
invoke a sweep, but it would still need a shared database, which is the problem
above.

**The worker is deliberately not part of any Vercel deployment.**

### Sessions live in the database

Authentication is a server-side `sessions` row, checked on every request
([[Authentication and Sessions]]). Ephemeral storage means a session written by
one invocation is invisible to the next: an operator would sign in and be
immediately signed out.

### Migrations require a single writer

[[Migration Ownership]] requires exactly one process to apply migrations, and
both the worker and the POS refuse to start against an unmigrated database.
Serverless offers no "one writer" to be.

### The trusted-proxy model cannot be configured for Vercel

This is the subtle one. `TRAINING_HTTPS` behind a terminator requires an
**explicit list of trusted proxy addresses** — there is deliberately no "trust
all proxies" setting, because that is what lets a spoofed `X-Forwarded-Proto`
make an insecure deployment report itself secure ([[Decision Log]] D45).

Vercel's proxy addresses are not enumerable. So on Vercel the choice would be
between refusing to trust the header — cookies never marked `Secure`, sign-in
broken — and trusting it blindly, which the design refuses. See
[[TLS and Proxy Configuration]].

## What a Vercel deployment may safely be

A **preview of the built artifact**. Nothing more, and only while:

- the mode is `TRAINING`;
- no live provider and no live money are configured;
- no merchant or external operator is given the URL;
- it is never described as merchant-ready.

## What to watch for after the first push

| Watch | Why |
|---|---|
| **Output Directory** in the Vercel project | With no framework and no `public/`, some configurations fall back to serving the repository root. That would publish the **source tree** at a Vercel URL. The set is sanitized — no secrets, no commercial material — so the exposure is source code, not credentials. Confirm the setting rather than assume |
| **Deployment visibility** | A private GitHub repository does **not** make a Vercel deployment private |
| **A "successful" deployment** | Success means the build ran. It does **not** mean Telga is running |
| Preview vs production | A preview URL is not a production system, and neither is production here |

## Running Telga properly

One persistent host — the controlled training machine — with a real filesystem:

```bash
node services/worker/dist/cli.js --db ./telga.sqlite --migrate --once
npm run training:provision -- --db ./telga.sqlite --merchant … --provision-pin …
npm run training:serve   -- --db ./telga.sqlite --transport TRAINING_HTTPS \
  --tls-cert … --tls-key … --allowed-hosts …
node services/worker/dist/cli.js --db ./telga.sqlite   # the recovery worker
```

See [[Training HTTPS Deployment]] and [[Deployment Runbook]].

## If Vercel hosting is genuinely wanted later

A separate design, not a refactor. It would need, at minimum:

| Need | Implication |
|---|---|
| A network database | Postgres, replacing the SQLite driver behind `LedgerDriver`. Already the Phase 3 option — [[SQLite Persistence Layer]] |
| A place for the worker | A container or scheduled job with a real connection, not a request handler |
| Session storage | Moves with the database |
| Migration ownership | A deliberate single-writer step in the deploy pipeline |
| A proxy-trust answer | Either a fixed ingress or a different scheme-detection design |

`LedgerDriver` was written so the storage engine can be replaced without touching
callers — that door is open. Walking through it is a project, and none of it is
justified before a provider agreement exists.

**Recorded as A56 / R30. Open.**

## Related

- [[Architecture]]
- [[Deployment Runbook]]
- [[Training HTTPS Deployment]]
- [[SQLite Persistence Layer]]
- [[Recovery Worker]]
- [[TLS and Proxy Configuration]]

---
Back to [[00 Home]]
