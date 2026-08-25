---
title: Deployment Target Evaluation
type: engineering
status: draft
owner: telga
created: 2026-08-24
updated: 2026-08-24
tags:
  - telga
  - engineering
  - deployment
  - evaluation
related:
  - "[[00 Home]]"
  - "[[Training Deployment Architecture]]"
  - "[[Vercel Deployment Limits]]"
  - "[[Persistent Host Runbook]]"
  - "[[Decision Log]]"
depends_on:
  - "[[Training Deployment Architecture]]"
implements: []
validates: []
decision_status: proposed
---

# Deployment Target Evaluation

A comparison of deployment-target **categories** against
[[Training Deployment Architecture]]'s requirements, before any provider is
selected. No account has been created, nothing has been purchased, and
nothing has been deployed.

> [!warning] No prices are claimed here
> Category costs are given as relative tiers (low / medium / higher), not
> figures. Current pricing changes and must be checked against each vendor's
> own page at decision time, not assumed from training data or a general web
> search. The same caution applies to feature claims — where this note states
> a category "typically" supports something, verify it against the specific
> product before signing up.

## What is being evaluated against

From [[Training Deployment Architecture]]: one host running a persistent
POS/API process, a persistent SQLite file, a supervised recovery worker, and
TLS termination, all sharing one filesystem, for **training use only** — a
handful of internal operators, no live money, no production traffic.

## Categories

### 1. Small virtual private server (VPS)

A rented Linux VM with a persistent disk and root access.

| Criterion | Assessment |
|---|---|
| Persistent filesystem | Yes — a real disk, survives reboot |
| SQLite compatibility | Full — it is just a file on a real filesystem |
| Backup capability | Full control — snapshot the disk, or `cp`/`rsync` the file after a checkpoint |
| HTTPS/TLS | Either shape works: run the POS's own `TRAINING_HTTPS`, or a proxy (nginx/Caddy) in front |
| Private networking | Firewall rules or a VPN are the operator's own responsibility to configure |
| Process supervision | `systemd` (or equivalent) — standard, well-understood |
| Separate worker process | Trivial — a second `systemd` unit on the same host |
| Single-writer migration | Natural fit — one host, run the migrate command once |
| Session durability | Full — same disk as the database |
| Restart behaviour | Depends entirely on the supervisor config chosen |
| Log access | Direct — `journalctl` or plain files |
| Monitoring | Nothing built in; the operator adds it |
| Secret storage | A local `.env`-style file with tight permissions, or the host's own secret store |
| Cost | Low, for the smallest tier suitable for training load |
| Regional availability | Wide — most providers offer many regions |
| Can stay private | Yes — firewall to an allowlist, no public health page |
| Recovery after host failure | Only as good as the operator's own backup discipline — nothing automatic |
| Restore workflow | Manual: provision a new VM, restore the database file, redeploy the build |
| Training-only suitability | Good — simple, well-understood, matches the architecture directly |
| Later production suitability | Plausible with more rigor (managed backups, monitoring, a second host for failover) — not a given |

### 2. Managed container service with persistent volume support

A container platform (e.g. a managed Docker/container runner) where a
persistent volume is explicitly attached.

| Criterion | Assessment |
|---|---|
| Persistent filesystem | Only if a persistent volume is explicitly provisioned and mounted — the container's own filesystem is ephemeral by default, same failure mode as [[Vercel Deployment Limits]] describes for serverless |
| SQLite compatibility | Works if the volume is mounted at the database path and the platform guarantees the container isn't rescheduled to a different node without the volume following it |
| Backup capability | Depends on the platform's volume-snapshot support |
| HTTPS/TLS | Usually via the platform's own ingress/load balancer, which is a form of `TRUSTED_PROXY` termination — needs an explicit trusted-address configuration, not "trust everything" |
| Private networking | Varies by platform; some default to a private network, some require explicit configuration |
| Process supervision | The platform restarts the container on crash — but this must not silently restart into an unmigrated or torn database |
| Separate worker process | A second container/service definition, sharing the same volume |
| Single-writer migration | Needs explicit handling — a platform that scales replicas by default could start two writers unless migration is a separate, one-shot step |
| Session durability | Only if the volume genuinely persists across restarts and rescheduling |
| Restart behaviour | Platform-defined; verify it does not reset the volume |
| Log access | Usually a built-in log viewer |
| Monitoring | Often built in at a basic level (CPU, memory, restarts) |
| Secret storage | Usually a first-class feature (secret manager integration) |
| Cost | Low to medium, depending on the platform and whether the volume is billed separately |
| Regional availability | Varies by platform |
| Can stay private | Depends on platform — confirm the ingress isn't public by default |
| Recovery after host failure | Better than a bare VPS **if** volume snapshots are used; no better otherwise |
| Restore workflow | Depends entirely on the platform's own volume-restore tooling |
| Training-only suitability | Workable, but adds a layer of "does the volume really persist here" risk that a VPS does not have |
| Later production suitability | Reasonable, if the platform's persistence guarantees are verified, not assumed |

### 3. Platform-as-a-service (PaaS) with a persistent process and durable disk

A PaaS offering that explicitly supports a long-running process plus a
durable, attached disk (distinct from typical serverless/function PaaS
offerings, which do **not** qualify — see [[Vercel Deployment Limits]]).

| Criterion | Assessment |
|---|---|
| Persistent filesystem | Only on the subset of PaaS products that explicitly offer a durable disk add-on — most PaaS defaults are ephemeral, same as serverless |
| SQLite compatibility | Works only where that durable disk exists; otherwise this category has the exact problem Vercel has |
| Backup capability | Depends on the disk add-on's own snapshot support |
| HTTPS/TLS | Usually handled by the platform automatically — verify whether the origin behind it can still run `TRAINING_HTTPS` in-process, or must trust the platform's proxy, and whether that proxy's addresses are enumerable |
| Private networking | Often more limited than a VPS — many PaaS products assume public HTTP by default |
| Process supervision | Built in — the platform's own runtime |
| Separate worker process | Usually a separate "worker" process type, a standard PaaS pattern |
| Single-writer migration | Must be a deliberate release-time step, not automatic on every deploy/restart |
| Session durability | Only with the durable disk; otherwise sessions break exactly as described for serverless |
| Restart behaviour | Platform-defined; PaaS platforms commonly restart processes on deploy or on a schedule — confirm the disk survives that |
| Log access | Usually a built-in log stream |
| Monitoring | Often built in |
| Secret storage | Usually first-class |
| Cost | Low to medium for a single small persistent process plus disk |
| Regional availability | Varies |
| Can stay private | Depends on the platform; some require an add-on for network restriction |
| Recovery after host failure | Depends on the disk add-on |
| Restore workflow | Platform-specific |
| Training-only suitability | Workable **only** if the durable-disk variant is confirmed and selected deliberately — the default/free tier of most PaaS platforms is exactly the ephemeral shape this repository already documented as incompatible |
| Later production suitability | Uncertain without verifying the specific product's persistence and scaling model in detail |

### 4. Local or office training machine

A physical or virtual machine already inside MuleSoo's own network.

| Criterion | Assessment |
|---|---|
| Persistent filesystem | Yes, trivially |
| SQLite compatibility | Full |
| Backup capability | Full control, but entirely manual unless someone builds it |
| HTTPS/TLS | Same two shapes as a VPS |
| Private networking | Already private by construction — no public exposure unless explicitly opened |
| Process supervision | Whatever the OS offers (`systemd` on Linux, a service wrapper on Windows) |
| Separate worker process | Trivial |
| Single-writer migration | Trivial — one machine |
| Session durability | Full |
| Restart behaviour | Depends on configuration; an office machine may reboot unexpectedly (power, updates) with no supervisor watching |
| Log access | Direct, local |
| Monitoring | Nothing built in |
| Secret storage | Local file, local disk encryption if configured |
| Cost | Lowest — no recurring hosting fee, but real hardware and someone's time |
| Regional availability | N/A — fixed to wherever the office is |
| Can stay private | Trivially — it never needs to be internet-facing at all for internal-only training |
| Recovery after host failure | Poor unless backups are taken off the machine — a single point of failure with no redundancy |
| Restore workflow | Manual, and only as good as whatever backup discipline exists |
| Training-only suitability | **Very good** for exactly this phase — lowest cost, already private, matches "internal staff only" from [[Training Operations Runbook]] |
| Later production suitability | Poor — no redundancy, no professional operational guarantees, not a credible production target |

### 5. Managed database plus a separate application/worker host

Splitting the database onto a managed database service, with the POS and
worker on a separate compute host.

| Criterion | Assessment |
|---|---|
| Persistent filesystem | N/A in the SQLite sense — this category assumes moving off SQLite entirely, since managed database services are relational servers (e.g. Postgres), not a mountable SQLite file |
| SQLite compatibility | **Not applicable** — this is the "Phase 3 option" architecture change described in [[Vercel Deployment Limits]] ("If Vercel hosting is genuinely wanted later"), not a way to keep SQLite |
| Backup capability | Usually excellent — this is what managed database services are for |
| HTTPS/TLS | Same as any compute host |
| Private networking | Usually strong — private VPC peering between compute and database is a standard managed-database feature |
| Process supervision | Same as VPS/PaaS for the compute side |
| Separate worker process | Straightforward |
| Single-writer migration | The claim-lease design (A37/R16) would need re-verification against the new database engine; not a drop-in |
| Session durability | Good, and now also survives the compute host being replaced |
| Restart behaviour | Compute host restarts no longer risk the database at all — a real advantage |
| Log access | Varies |
| Monitoring | Usually strong on the managed-database side |
| Secret storage | Usually first-class |
| Cost | Medium to higher — two billed services instead of one |
| Regional availability | Varies |
| Can stay private | Yes, typically better than the other categories |
| Recovery after host failure | Best of the five categories — the database survives compute failure entirely |
| Restore workflow | Usually the managed service's own point-in-time restore |
| Training-only suitability | **Overbuilt for training** — this is real infrastructure investment for a problem training doesn't have yet |
| Later production suitability | The most credible long-term path, but it is a distinct engineering project — `LedgerDriver`'s interface exists precisely so this swap doesn't require rewriting callers, per [[Vercel Deployment Limits]] |

## Comparison summary

| Category | Fits the architecture as-is | Training-appropriate cost | Real risk |
|---|---|---|---|
| 1. Small VPS | Yes, directly | Low | Backup discipline is entirely manual |
| 2. Managed container + volume | Yes, if the volume is real | Low–medium | Ephemeral-by-default platforms make this easy to get wrong |
| 3. PaaS with durable disk | Yes, only on the durable-disk variant | Low–medium | Default/free tiers are the exact ephemeral shape already ruled out |
| 4. Local/office machine | Yes, directly | Lowest | Single point of failure, no supervisor by default |
| 5. Managed DB + separate host | No — requires the SQLite→Postgres migration, a separate project | Medium–higher | Overbuilt for training; real investment before it's justified |

## Recommendation

**Category 1 (small VPS) or Category 4 (local/office machine)** — whichever
MuleSoo already has the operational capacity to run. Both fit
[[Training Deployment Architecture]] directly with no ambiguity about
whether persistence is real, both keep cost at or near zero incremental
infrastructure spend, and both avoid the "ephemeral by default unless you
configure it correctly" trap that categories 2 and 3 carry. Category 5 is the
right *eventual* production direction but is not justified before a provider
agreement and real load exist — building it now would be exactly the kind of
premature infrastructure investment [[Vercel Deployment Limits]] already
warned against for a different platform.

This recommendation selects a **category**, not a vendor. No account has been
created and no purchase has been made. Selecting an actual provider within
the chosen category is the next decision, recorded in [[Decision Log]] as
**proposed**, not accepted.

## What this note does not do

- Does not name a specific vendor as final.
- Does not claim current pricing.
- Does not create an account or provision anything.
- Does not close [[Risk Register]] R30 or assumption A56 — those stay open
  regardless of which target is eventually chosen, until it is actually
  running and verified.

## Related

- [[Training Deployment Architecture]]
- [[Vercel Deployment Limits]]
- [[Persistent Host Runbook]]
- [[Decision Log]]

---
Back to [[00 Home]]
