---
title: CI Pipeline
type: engineering
status: draft
owner: telga
created: 2026-08-20
updated: 2026-08-20
tags:
  - telga
  - engineering
  - ci
  - build
related:
  - "[[00 Home]]"
  - "[[Build Pipeline]]"
  - "[[Testing Strategy]]"
  - "[[Test Stability Runbook]]"
  - "[[Deployment Runbook]]"
depends_on:
  - "[[Build Pipeline]]"
implements: []
validates: []
decision_status: pending
---

# CI Pipeline

`.github/workflows/ci.yml` — authored, **not yet executed on a runner**.

> [!danger] A43 is OPEN, and this note is the evidence
> The repository has **no git remote and zero commits**. `git log` reports
> *"your current branch 'master' does not have any commits yet"*. A workflow that has never run is
> not a passing workflow, so **A43 stays open** until CI completes on a real runner.
>
> Every individual step below has been run locally and passes. That is worth something, and it is
> not the same thing.

## What the workflow runs

Triggered on pull requests and on pushes to the default branch.

| # | Step | Local status |
|---|---|---|
| 1 | `npm ci` — install from the lockfile | Not run (needs a clean checkout) |
| 2 | `node scripts/check-committed.mjs` — secrets and generated output | **Passes** (trivially: 0 tracked files) |
| 3 | `npm run typecheck` | **Passes** |
| 4 | `npm run build:clean` | **Passes** — 58 `.js`, 58 `.d.ts`, 0 `.ts` |
| 5 | Confirm `dist` is not tracked | **Passes** |
| 6 | Persistence tests | **Passes** — 79 |
| 7 | Orchestration tests | **Passes** — 76 |
| 8 | Recovery tests | **Passes** — 61 |
| 9 | Worker tests | **Passes** — 82 |
| 10 | Child-process build tests | **Passes** — 18 |
| 11 | Full suite | **Passes** — 419 |
| 12 | `npm run docs:validate` | **Passes** |
| 13 | Upload logs on failure | Not exercised |

A second job runs the recovery stress soak, on pushes to the default branch only — a soak on every
pull request would cost more than it catches.

## Formatting and linting

Neither is configured in this repository, so neither has a CI step. Adding a step that runs nothing
would be worse than having none: it reads as a passing check.

## Why Graphify is not a CI step

Graphify is a locally-installed Python tool, not a declared dependency of this repository. A CI step
for it would either install an unpinned tool on every run or quietly do nothing.

`npm run docs:validate` is the deterministic documentation gate — broken links, orphan notes and
frontmatter — and it runs in every job. **Graphify export stays a documented local step**, run
after a batch of notes changes. That is a deliberate choice, recorded rather than hidden.

## Node versions

| Where | Version |
|---|---|
| Local development | 25.9.0 |
| CI matrix | 22.x and 24.x |

The matrix exists precisely because local is ahead of LTS: a version difference should surface here
rather than at deploy time. `package.json` declares `"node": ">=20"`.

## Portability — reviewed, unverified

Everything below was reviewed against the code; **none of it has been observed on Linux**, because
CI has not run.

| Concern | Assessment |
|---|---|
| Scripts | `build.mjs`, `stress-recovery.mjs`, `check-committed.mjs` are plain Node — no shell built-ins, no `rm -rf` |
| `better-sqlite3` | Installs from prebuilt binaries locally on Node 25/Windows. Linux prebuilds for Node 22/24 are expected but **unconfirmed** |
| Native module rebuild | If a prebuild is missing, `npm ci` will attempt a source build and CI needs a toolchain |
| Signals | Worker tests use an injected signal source, so no real signal is sent. Real SIGTERM handling is only exercised in production |
| Child processes | Spawned via `process.execPath` — portable |
| Temporary databases | `mkdtempSync` under the OS temp dir, removed with `rmSync` |
| Case-sensitive filesystem | All imports are lowercase-consistent, but a case mismatch would only surface on Linux |
| File paths | Built with `node:path`; no separator assumptions |

## What must not be done

| Action | Why |
|---|---|
| Marking A43 closed before CI runs | The instruction was explicit, and a green badge nobody has seen is not evidence |
| Adding a lint or format step that runs nothing | It reads as a passing check |
| Installing Graphify in CI to make the pipeline look complete | An unpinned tool in CI is worse than a documented local step |
| Retrying a flaky job to get a green run | See [[Test Stability Runbook]] |

## Related

- [[Build Pipeline]]
- [[Test Stability Runbook]]
- [[Testing Strategy]]
- [[Deployment Runbook]]

---
Back to [[00 Home]]
