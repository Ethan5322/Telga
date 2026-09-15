---
title: Railway Build Failures
type: operations
status: accepted
owner: devops-sre
created: 2026-09-15
updated: 2026-09-15
tags: [telga, operations, runbook, deployment]
related: ["[[Runbooks]]", "[[Deployment Runbook]]", "[[Is This The Current Build]]", "[[Decision Log]]"]
validates: ["[[Deployment Runbook]]"]
decision_status: accepted
---

# Railway Build Failures

**Errors that name a file this repository does not contain.** Telga has no
`Dockerfile` — Nixpacks writes one — so a build error quoting a Dockerfile line
number is describing generated output, and the fix is never at that line.

## `ENV names can not be blank`

```
Build Failed: build daemon returned an error
failed to solve: dockerfile parse error on line 12: ENV names can not be blank
```

**Cause: a Railway service variable whose *name* is empty.** Nixpacks writes the
service's variables into the generated Dockerfile as `ENV` lines, and an empty
name produces `ENV =value`, which Docker refuses to parse.

**It is not in the repository.** Confirmed 2026-09-15: no tracked `Dockerfile`,
no committed `.env`, and neither `railway.json` nor `nixpacks.toml` declares any
variable. Searching the codebase for line 12 is wasted effort.

### The fix

1. Railway → the service → **Variables**
2. **Raw Editor**
3. Find a line whose left-hand side is empty — `=value`, a bare `=`, or
   whitespace before the `=`
4. Delete it, save, redeploy

### How it gets there

Pasting into the Raw Editor. A trailing blank line that carries an `=`, or a
copied block with one malformed row, is enough. Telga's variable list changes
often — `TELGA_CONSOLE_OWNER_RESET` and `TELGA_CONSOLE_SINGLE_FACTOR` are added
and removed deliberately, and the Chapa callback URLs were pasted in — so this
has more chances to happen here than on a service nobody touches.

### What it does NOT mean

**The code is fine.** This fails at Dockerfile *parse*: before install, before
build, before the binding check, before anything in this repository runs. A
green suite locally and a failed build here are not in tension.

**Nothing deployed.** The previous release is still serving. That is the answer
to "I pushed and the app still looks old" — see [[Is This The Current Build]],
which covers the same confusion from the other direction.

## Why a build error can name a file that does not exist

`railway.json` sets `"builder": "NIXPACKS"`. Nixpacks inspects the repository,
decides the phases, and **generates** a Dockerfile. `nixpacks.toml` overrides
the install and build phases and nothing else.

So there are three places a build can break, and only one of them is in this
repository:

| Symptom | Where it lives |
|---|---|
| Dockerfile parse error | Nixpacks output, from the service's variables |
| `npm ci` failure | `nixpacks.toml` install phase — see [[Decision Log]] D115 |
| Build or binding failure | `npm run build:clean`, `verify-binding.mjs` |

**Read which phase failed before reading the error.** Two earlier builds were
debugged against a command this repository never wrote, because the failing
phase was the one Nixpacks writes itself (D115).

## Related

- [[Deployment Runbook]] — how a commit reaches Railway
- [[Is This The Current Build]] — when a deploy succeeded and the device is behind
- [[Runbooks]]
- [[Decision Log]] — D115, the Nixpacks install phase

---
Back to [[00 Home]]
