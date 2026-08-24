---
title: Build Pipeline
type: engineering
status: draft
owner: telga
created: 2026-08-20
updated: 2026-08-20
tags:
  - telga
  - engineering
  - build
  - runtime
related:
  - "[[00 Home]]"
  - "[[Architecture]]"
  - "[[Recovery Worker]]"
  - "[[Deployment Runbook]]"
  - "[[Testing Strategy]]"
depends_on:
  - "[[Architecture]]"
implements: []
validates: []
decision_status: confirmed
---

# Build Pipeline

`npm run build` — compiles every package to its own `dist/`, in dependency order.

**Implemented and tested.** The build is what made the genuine multi-process test possible, and
therefore what closed assumption **A37**.

## Why a build was needed at all

Until now everything ran through Vitest, which transpiles TypeScript in memory. That was enough for
tests but not for a real deployment, and it was the exact blocker on proving process-level safety:
a child process could not load the worker, because

1. Node refuses to strip types inside `node_modules`, and the workspace packages resolve through
   `node_modules` symlinks; and
2. the sources use **extensionless relative imports** (`./errors`), which Node's ESM resolver
   rejects — it requires a real file path.

## The choice: CommonJS output

| Option | Verdict |
|---|---|
| Append `.js` to every relative import and emit ESM | Correct, but a mechanical edit across five packages and ~60 files, with no other benefit |
| A bundler | New dependency and a new failure mode, to solve a problem `module: commonjs` already solves |
| A custom Node loader | Fragile, and hides resolution failures rather than removing them |
| **Emit CommonJS** | **Chosen.** CommonJS resolves extensionless specifiers natively. No source changes |

Each package keeps `"type": "module"` for the TypeScript tooling, so the build writes
`{"type":"commonjs"}` into its `dist/package.json`. Node then reads the emitted `.js` correctly.
`verbatimModuleSyntax` is disabled **for the build only** — it forbids emitting CommonJS from ESM
syntax. Recorded as [[Decision Log]] D30.

## Configuration

```text
tsconfig.json              development and typecheck — ESM, Bundler resolution, noEmit
tsconfig.build.base.json   shared build settings — CommonJS, node10 resolution, declarations
<package>/tsconfig.build.json   rootDir src, outDir dist
```

Development tooling keeps using the sources: Vitest resolves `@telga/*` through aliases, and
`tsconfig.json` maps them through `paths`. Only the built runtime uses `main`.

## Build order

Declarations must exist before dependents compile:

```text
packages/domain
  → packages/persistence
  → services/provider-adapters/mock-airtime
    → services/api
      → services/worker
```

`scripts/build.mjs` runs them in that order, stamps each `dist/package.json`, then verifies the
output. It is plain Node with no shell built-ins — `rm -rf` does not exist on Windows.

## The output guarantee

The build **fails** if any `.ts` file other than a declaration appears under `dist/`. Nothing but
JavaScript may be needed at runtime, and a test asserts the same thing independently:
`emits JavaScript and declarations, and no TypeScript`.

Current output: **58 `.js`, 58 `.d.ts`, 0 `.ts`.**

`dist/` is generated and git-ignored.

## Runtime entry point

`services/worker/dist/cli.js` — see [[Recovery Worker]] and the README for arguments, environment
variables and exit codes.

## Commands

| Command | Effect |
|---|---|
| `npm run build` | Compile every package |
| `npm run clean` | Remove every `dist/` |
| `npm run build:clean` | Clean, then build |

All three work from a fresh checkout after `npm install`, using the repository's own TypeScript
rather than a global one.

## Continuous integration

`.github/workflows/ci.yml` runs this build on every pull request and push. It has **not yet
executed on a runner** — the repository has no remote and no commits. See [[CI Pipeline]].

## What this does not yet do

| Gap | Consequence |
|---|---|
| CI authored but never run | Nothing has verified the build on a machine other than this one — A43 |
| No artifact packaging | There is nothing to ship; `dist/` is built in place |
| No source-map upload | Stack traces from a deployed worker map only locally |
| Declaration maps emitted but unused | Harmless; useful once an editor consumes the built types |

## Related

- [[Architecture]]
- [[Recovery Worker]]
- [[Deployment Runbook]]
- [[Testing Strategy]]

---
Back to [[00 Home]]
