---
title: CI Pipeline
type: engineering
status: draft
owner: telga
created: 2026-08-20
updated: 2026-08-24
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
decision_status: accepted
---

# CI Pipeline

`.github/workflows/ci.yml` — **executed successfully on a real remote runner.**

> [!success] A43 is RESOLVED, and this note is the evidence
> Commit `d540200` (`main`, pushed to `Ethan5322/Telga`) produced a complete green run on GitHub's
> hosted runners: <https://github.com/Ethan5322/Telga/actions/runs/32718640781> — `verify (Node
> 22.x)` PASS, `verify (Node 24.x)` PASS, `recovery stress` PASS, in 1m43s. That took three pushes
> to get right, and the two real defects the first two pushes surfaced are recorded below rather
> than smoothed over — a green run that hides how it got green is worth less than one that shows it.

## The road to green — two real defects, neither in the product

**First push (`b5d96c3`) failed both `verify` jobs** with `No test files found, exiting with code
1`. Root cause: `.gitignore` had a bare, unanchored `build/` pattern meant for generated compiler
output. It also matched `tests/build/` — a real source directory (the child-process build tests) —
so that directory was never tracked, staged, or committed, despite existing on disk and being
referenced by both this workflow and the README. Every local run passed regardless, because Vitest
reads the filesystem directly and the untracked file was still sitting on disk; only a fresh
checkout ever exposed the gap. **Fixed** (`1d06517`) by removing the pattern and adding
`scripts/check-ci-test-paths.mjs`, a new first CI step that fails fast if any `vitest run
tests/...` path the workflow references has zero files tracked by git — this exact class of defect
now cannot recur silently. Recorded as **A57**.

**Second push (`1d06517`) still failed `recovery stress`**, reporting `soak-200` as failed while all
five shuffled repeats passed. This one took real reproduction work to pin down, because the failure
message named the wrong scenario entirely. `scripts/stress-recovery.mjs`'s soak pass ran `vitest
--config vitest.stress.config.ts` with **no file argument**; that config's `include` glob matches
every file under `tests/stress/`, which is two unrelated scenarios — the intended A44
manual-review soak, and the A54 multi-process test, which needs a compiled worker binary. The
`recovery stress` job never runs `build:clean`. So every run was silently also executing the A54
scenario against a missing build, and reporting *its* failure under the `soak-200` label — a
scenario that was never actually broken. Confirmed by reproducing locally with the build removed:
`Test Files 1 failed | 1 passed (2)`, the failure entirely inside `child-process.stress.test.ts`,
while the real A44 soak passed cleanly (also verified in 3 isolated local runs, ~45-56s each, no
flakiness). **Fixed** (`d540200`) by scoping the soak invocation to its own file, adding
`--reporter=dot` to both passes (the same A51 mitigation `stress-child-process.mjs` already had),
and classifying every failure as `ASSERTION` / `INFRASTRUCTURE` / `HARNESS` with full output printed
to the job log rather than only saved to an artifact. Recorded as **A58** — deliberately a separate
ID from A44, which tracks a different, still-unreproduced failure shape and stays open on its own
terms.

## What the workflow runs

Triggered on pull requests and on pushes to the default branch. Status below is the verified result
of the `d540200` remote run, not a local inference.

| # | Step | Remote status (`d540200`, runs/32718640781) |
|---|---|---|
| 1 | Validate CI test paths against the repository (new, A57) | **Passes** |
| 2 | `npm ci` — install from the lockfile | **Passes** on Node 22.x and 24.x |
| 3 | `node scripts/check-committed.mjs` — secrets and generated output | **Passes** |
| 4 | `npm run typecheck` | **Passes** |
| 5 | `npm run build:clean` | **Passes** |
| 6 | Confirm `dist` is not tracked | **Passes** |
| 7 | Persistence / orchestration / recovery / worker / UI / auth / transport / recovery-failure-path / child-process build tests | **Passes** |
| 8 | Full suite | **Passes** |
| 9 | `npm run docs:validate` | **Passes** |
| 10 | Recovery stress (`soak-200` + 5 shuffled repeats) | **Passes** |

Three deprecation warnings appeared on this run (`actions/checkout@v4`, `actions/setup-node@v4`
being forced onto Node 24 because they target the deprecated Node 20): warnings only, did not fail
the run. **Resolved as A59**, in its own maintenance commit (`96b3d4e`), separate from any
functional CI fix: each action's actual `action.yml` was checked directly at both tags — `v4`
declares `node20`, `v5` declares `node24` — rather than trusting a summarized changelog page, which
had produced an internally inconsistent version history when tried first. Upgraded both actions to
`v5` in all four occurrences (`verify` job ×2, `stress` job ×2); no inputs, triggers, timeouts,
reporters, or the Node matrix (`22.x`/`24.x`) changed. Remote run
[`32730213755`](https://github.com/Ethan5322/Telga/actions/runs/32730213755) — Success, 1m41s, every
job green — and the Annotations panel confirmed empty by direct owner inspection of the
authenticated page.

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

## Portability — verified on `d540200`

Everything below was reviewed against the code, and is now **observed on Linux** via the successful
remote run.

| Concern | Assessment |
|---|---|
| Scripts | `build.mjs`, `stress-recovery.mjs`, `check-committed.mjs`, `check-ci-test-paths.mjs` are plain Node — no shell built-ins, no `rm -rf`. **Confirmed**: ran clean on `ubuntu-latest` |
| `better-sqlite3` | Installs from prebuilt binaries locally on Node 25/Windows. **Confirmed on Linux**: Node 22.x and 24.x both installed and ran without a source build in `npm ci` — the run's own step timings show no `node-gyp` compile step |
| Native module rebuild | Not needed on this runner image — see above. Still true in principle: if a prebuild were ever missing, `npm ci` would attempt a source build and need a toolchain |
| Signals | Worker tests use an injected signal source, so no real signal is sent. Real SIGTERM handling is only exercised in production |
| Child processes | Spawned via `process.execPath` — portable. **Confirmed**: the child-process build tests and the A54 multi-process tests both passed on Linux |
| Temporary databases | `mkdtempSync` under the OS temp dir, removed with `rmSync`. **Confirmed**: 200-iteration soak passed, no leftover state between iterations |
| Case-sensitive filesystem | All imports are lowercase-consistent; no case-mismatch failure occurred on Linux's case-sensitive filesystem |
| File paths | Built with `node:path`; no separator assumptions. **Confirmed** |

## What must not be done

| Action | Why |
|---|---|
| Marking A43 closed before CI runs | The instruction was explicit, and a green badge nobody has seen is not evidence — this is why A43 stayed open through two failing pushes before this one |
| Adding a lint or format step that runs nothing | It reads as a passing check |
| Installing Graphify in CI to make the pipeline look complete | An unpinned tool in CI is worse than a documented local step |
| Retrying a flaky job to get a green run | See [[Test Stability Runbook]] |
| Changing the workflow merely to silence the Node 20 deprecation warning | It is a warning, not a failure; the fix belongs in a separate, tested, reviewed action-version upgrade — not bundled into an unrelated change |
| Treating this green run as proof Telga can deploy on Vercel | CI verifies the code and tests, not the deployment target. See [[Vercel Deployment Limits]] — A56/R30 stay open regardless of CI status |

## Related

- [[Build Pipeline]]
- [[Test Stability Runbook]]
- [[Testing Strategy]]
- [[Deployment Runbook]]

---
Back to [[00 Home]]
