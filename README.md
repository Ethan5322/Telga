# Telga

The merchant digital-vending platform of **MuleSoo Digital Services**, Ethiopia. First product:
airtime vending.

> **TRAINING MODE — NO REAL VALUE.**
> No live provider is connected, no live money is enabled, and **0 of 10 launch gates** in
> `docs/obsidian/07 Governance/Launch Gates.md` have been cleared. Every regulated capability is
> disabled in UI, API, roles and deployment.

The authoritative instruction set is [CLAUDE.md](CLAUDE.md). The project knowledge base is the
Obsidian vault in [docs/obsidian/](docs/obsidian/), starting at `00 Home.md`.

## Requirements

- Node.js 20 or later (developed on 25.9.0)
- npm 11 or later

No global compiler is needed; everything runs from the repository's own dependencies.

## Getting started

```bash
npm install
npm run typecheck
npm test
```

## Commands

| Command | What it does |
|---|---|
| `npm run typecheck` | Type-checks every package and test, no emit |
| `npm test` | The full suite — 417 tests |
| `npm run build` | Compiles every package to its own `dist/` |
| `npm run build:clean` | Removes every `dist/`, then builds |
| `npm run clean` | Removes every `dist/` |
| `npm run docs:validate` | Checks the vault for broken links, orphans and frontmatter |

## Build output

Each package compiles to its own `dist/` in dependency order: domain → persistence →
mock-airtime → api → worker.

The build emits **CommonJS**. The sources use extensionless relative imports (`./errors`), which
Node's ESM resolver refuses — it requires a real file path. Rather than append `.js` to every
import across five packages, the build targets CommonJS, whose resolver handles extensionless
specifiers natively, and writes `{"type":"commonjs"}` into each `dist/package.json` so Node parses
the output correctly. Full reasoning and the alternatives considered are in
`docs/obsidian/09 Engineering/Build Pipeline.md`.

`dist/` is generated and git-ignored. The build refuses to finish if any TypeScript source leaks
into the output — nothing under `dist/` may be needed at runtime except JavaScript.

## Running the recovery worker

The worker is the only long-running process in the system. It finds transactions left in flight and
drives them to a determinate state, or holds them and escalates. See
`docs/obsidian/09 Engineering/Recovery Worker.md`.

```bash
npm run build

# One sweep, then exit — the mode used by operators and by the child-process tests
node services/worker/dist/cli.js --db ./telga.sqlite --once --json

# Supervised loop, until SIGTERM or SIGINT
node services/worker/dist/cli.js --db ./telga.sqlite
```

### Arguments

| Flag | Environment | Meaning |
|---|---|---|
| `--db <path>` | `TELGA_DB` | SQLite file. **Required** — the worker will not guess |
| `--worker-id <id>` | `TELGA_WORKER_ID` | Identifies this worker in claims and audit events |
| `--mode <mode>` | `TELGA_MODE` | Only `TRAINING` is accepted |
| `--once` | `TELGA_RUN_ONCE` | One sweep, release claims, exit |
| `--json` | `TELGA_JSON` | Emit one machine-readable result line |
| `--status <outcome>` | `TELGA_MOCK_STATUS` | Script the mock provider's status lookup |
| `--behaviour <name>` | `TELGA_MOCK_BEHAVIOUR` | Mock provider behaviour |
| `--<policySetting> <ms>` | `TELGA_<SETTING>` | Override any recovery policy value |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `2` | Bad arguments — for example a missing `--db` |
| `3` | Refused: mode is not `TRAINING` |
| `4` | Invalid worker configuration |
| `5` | Runtime failure |

### Training mode is enforced, not assumed

`--mode LIVE` exits `3` **before a database is opened**. Beneath that, the worker, the domain and
the database schema each refuse live-money data independently.

## Running the merchant POS

The training-mode counter screens. See `docs/obsidian/04 UX UI/Merchant POS Screens.md`.

```bash
npm run build

# Apply migrations once, with a single writer
node services/worker/dist/cli.js --db ./telga.sqlite --migrate

# Create an operator and enrol a device. Prints the device key ONCE.
node apps/merchant-pos/dist/cli.js --db ./telga.sqlite \
  --merchant merchant_alpha --operator operator_1 --device device_1 \
  --provision-pin 481502

# Then serve the POS over TLS
node apps/merchant-pos/dist/cli.js --db ./telga.sqlite --merchant merchant_alpha \
  --transport TRAINING_HTTPS \
  --tls-cert /etc/telga/tls/cert.pem --tls-key /etc/telga/tls/key.pem \
  --allowed-hosts telga-training.local
# TRAINING MODE — NO REAL VALUE. Internal training only.
# Telga POS on https://telga-training.local:4321/login
```

Without `--transport TRAINING_HTTPS` the server runs plain HTTP **bound to
loopback only** — a LAN binding is refused, not warned about. Telga never
generates a certificate: see `docs/obsidian/09 Engineering/Local Certificate Handling.md`.

Sign in with the operator id, the PIN, the device id and the device key. There is
**no merchant id in any URL**: the session decides the scope.

| Flag | Environment | Meaning |
|---|---|---|
| `--db <path>` | `TELGA_DB` | SQLite file. **Required** |
| `--merchant <id>` | `TELGA_MERCHANT` | The merchant whose counter this is. **Required** |
| `--port <n>` | `TELGA_POS_PORT` | Default 4321 |
| `--locale <en\|am>` | — | Default `en`. Amharic is an unreviewed draft |
| `--environment <name>` | `TELGA_ENVIRONMENT` | Shown in the banner |
| `--mode <mode>` | `TELGA_MODE` | Only `TRAINING` is accepted |
| `--behaviour <name>` | — | The mock provider's starting behaviour |
| `--provision-pin <pin>` | — | Create the operator, enrol the device, print the key once, exit |
| `--training-float <birr>` | — | Credit a clearly-simulated opening balance during provisioning |
| `--transport <mode>` | `TELGA_POS_TRANSPORT` | `TRAINING_HTTP_LOCAL` (default) or `TRAINING_HTTPS` |
| `--tls-cert`, `--tls-key` | `TELGA_TLS_CERT`, `TELGA_TLS_KEY` | Required for standalone HTTPS. Never generated |
| `--tls-termination <mode>` | — | `IN_PROCESS` (default) or `TRUSTED_PROXY` |
| `--trust-proxy <addrs>` | — | Addresses whose forwarding headers are believed. No "trust all" option |
| `--allowed-hosts <hosts>` | — | Hosts this deployment answers for |
| `--hsts <true\|false>` | — | Off by default; refused on plain HTTP |

Exit codes match the worker's, plus `6` for an unmigrated database. Like the worker, the POS
**does not migrate** — it refuses to start instead, naming the missing versions.

The POS changes no transaction state, posts no ledger entry, completes no reversal and calls no
provider. Its only write is a sale through `createSale` against the scripted mock.

**Authentication is implemented.** Identity comes from a server-side session bound to an enrolled
device; a merchant id supplied by a client authorises nothing and is refused when it disagrees with
the session. PINs and device keys are scrypt-hashed with per-user salts, sessions expire on both an
idle timeout and an absolute lifetime, browser writes carry a CSRF token, and login and sale rate
limits apply. See `docs/obsidian/09 Engineering/Authentication and Sessions.md`.

**HTTPS is implemented** for the controlled training deployment: real TLS, `Secure` cookies decided
per request from the client's scheme, a per-response CSP nonce with no `unsafe-inline`, host and
origin validation, and a trusted-proxy boundary that believes a forwarding header only from a
configured address. See `docs/obsidian/09 Engineering/Training HTTPS Deployment.md`.

It is still **training-grade**, not production-ready: the certificate is self-signed and so is not
production trust (A53), the device binding is not hardware attestation (A52), and there is no second
factor. Keep it on the controlled training machine.

## Repository layout

```text
packages/domain        pure types and functions — no I/O, no framework
packages/localization  English and draft Amharic strings
packages/pos-view-model  state-to-UI mapping, wire DTOs, presentation state — pure
packages/persistence   SQLite behind a LedgerDriver interface
services/api           transaction orchestration, recovery, and the training HTTP surface
services/worker        the supervised recovery worker and its CLI
services/provider-adapters/mock-airtime   the only provider implementation
apps/merchant-pos      the training-mode merchant POS
tests/                 domain · persistence · orchestration · recovery · worker · ui · build
docs/obsidian/         the project knowledge base
graphify-out/          the generated knowledge graph
```

## Testing

```bash
npm test                              # everything
npx vitest run tests/domain/          # one area
npx vitest run tests/ui/              # POS screens and the training HTTP surface
npx vitest run tests/auth/            # authentication, device binding, authorization, CSRF
npx vitest run tests/transport/       # TLS, proxy trust, security headers, a real HTTPS listener
npm run training:smoke                # the compiled binary over real TLS, end to end
npm run build:clean                   # ALWAYS before a stress run, and let it finish
npm run test:child-process:stress     # 100 multi-process iterations, artifacts preserved
npx vitest run tests/build/           # child-process tests (builds first)
```

`tests/build/` and the child-process cases in `tests/ui/cli.test.ts` spawn **real operating-system
processes** running the compiled output, to prove the claim lease holds across process boundaries
and that the POS entry point refuses what it should.

They check whether `dist/` is stale and rebuild only if it is, so they always test current output
without compiling every package in the middle of a test run — which on a small machine starved
Vitest's own reporter and tripped unrelated timeouts (assumption A51).

## Limitations worth knowing

- **No live provider exists.** There is no HTTP client anywhere in the repository; live integration is absent, not disabled.
- **No commission or price is configured.** The commission functions throw rather than return a plausible number.
- **Backup and restore are untested** — launch gate 10 is not cleared.
- **Concurrent multi-process migration is untested** (assumption A30). Migrate on a single writer.
- Amharic strings are drafts and **require native review before production**; fourteen keys have no Amharic at all.
- **Device binding is training-grade** (A52). A browser-supplied device id plus a server-issued key is not hardware attestation; a copied key on another machine is undetectable.
- **The training certificate is self-signed** (A53). It encrypts the wire; it proves nothing about who is on the other end.
- **Never run a build and the test suite concurrently** on a constrained machine (A55).
- UI tests are **component-level**: no browser, no CSS, no screen reader (A48).

## Deployment

The supported runtime is a **persistent host** running all of the following at once:

| Component | Why it must be persistent |
|---|---|
| Persistent SQLite file | The ledger is a local WAL-mode file; every invariant in `docs/obsidian/03 Domain/Ledger Invariants.md` assumes one shared file |
| Single-writer migration command | Exactly one process may apply migrations; both the worker and the POS refuse to start against an unmigrated database |
| POS server process | Serves the training counter screens over `TRAINING_HTTP_LOCAL` or `TRAINING_HTTPS` |
| Recovery worker process | The supervised sweep loop that drives in-flight transactions to a determinate state |
| HTTPS termination | Real TLS with an enumerable trusted-proxy list — see `docs/obsidian/09 Engineering/Training HTTPS Deployment.md` |
| Secure session storage | Sessions are DB rows checked on every request; they do not survive ephemeral storage |

See `docs/obsidian/09 Engineering/Training HTTPS Deployment.md` for how to run all of these
together.

> [!danger] Not currently deployable to Vercel — this is a blocking constraint, not a TODO
> **A GitHub push to this repository must never be treated as a production Vercel deployment of
> Telga**, and no automatic Vercel deployment should be left enabled against `main`/`master` while
> this holds.
>
> Ephemeral per-invocation storage would give concurrent requests *different* ledger files, which
> voids the claim lease that prevents duplicate recovery (A37/R16). A Vercel build of this
> repository is, at best, a build artifact — not a running Telga. If a Vercel project is already
> connected to this repository, **pause or disable its automatic production deployments** until a
> compatible deployment target exists (see "What a real Vercel migration would require" in the note
> below). Never represent a Vercel "successful deployment" as Telga running, and never add a
> `vercel.json`, placeholder API route, static export, serverless adapter, or SQLite workaround
> merely to make a deployment report success.
>
> Full reasoning: `docs/obsidian/09 Engineering/Vercel Deployment Limits.md`. Recorded as
> **A56 / R30 — OPEN, deployment-blocking**.

Open assumptions are tracked in [ASSUMPTIONS.md](ASSUMPTIONS.md); decisions in
`docs/obsidian/07 Governance/Decision Log.md`.
