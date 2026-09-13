/**
 * Single-service supervisor for a Railway deployment.
 *
 * TRAINING MODE — NO REAL VALUE. This script starts nothing that touches real
 * money, and refuses to start if the mode is anything but TRAINING.
 *
 * ## Why a supervisor at all
 *
 * Railway runs one command per service, and Telga is three things in a fixed
 * order (`05 Operations/Service Startup and Shutdown.md`):
 *
 *   1. migrate — exactly one writer, to completion, before anything else runs
 *   2. the recovery worker — a supervised sweep loop
 *   3. the POS/API listener
 *
 * ...and, **only when `TELGA_CONSOLE_HOST` is set**, two more:
 *
 *   4. the operations console — the admin panel where applications are approved
 *   5. a front proxy on `$PORT` that routes by `Host` between the two
 *
 * ## Why the console can now be served, and why it is opt-in
 *
 * Until 2026-09-09 this script started the POS and the worker and nothing else,
 * so on a live deployment a shop could submit a registration and **nobody could
 * approve it** — the console ran only on an operator's own laptop. That makes
 * the end-to-end flow untestable by anyone who is not sitting at that laptop.
 *
 * It stays **off unless `TELGA_CONSOLE_HOST` is set**, and when it is off this
 * file behaves exactly as it did: the POS binds `$PORT` directly and no proxy
 * exists. An admin panel is not something to switch on by accident.
 *
 * ## Why routing by Host and not by path
 *
 * A path prefix (`/admin/...`) would mean rewriting every absolute link, form
 * action and redirect in the console — 50-odd places — and **one missed link is
 * a silently half-working admin panel**, which is worse than no admin panel.
 * Routing on `Host` needs no rewriting at all: each app sees itself at the root,
 * its cookies scope to its own hostname, and its own origin check keeps working
 * unchanged.
 *
 * The cost is that the operator must attach a second domain to the service in
 * Railway and name it in `TELGA_CONSOLE_HOST`. That is one setting, and it buys
 * a separation that is real: an admin panel on its own hostname cannot be
 * reached by a link that merely guesses a path.
 *
 * Steps 2 and 3 are long-running and share one SQLite file, which is why they
 * belong in **one** service with **one** volume rather than two services that
 * would each need their own copy of a file that must not be copied. Order
 * between 2 and 3 does not matter; both refuse to start against an unmigrated
 * database, so step 1 genuinely has to finish first.
 *
 * ## The failure rule
 *
 * If either child exits, the other is stopped and this process exits non-zero.
 * A half-running Telga is worse than a stopped one: a POS with no worker takes
 * sales and never resolves the pending ones, and `Ledger Invariants` assumes
 * something is sweeping. Railway's restart policy then restarts the whole
 * service, which re-runs the migration check and starts a matched pair.
 *
 * ## What this script deliberately does not do
 *
 * It does not provision, does not create an operator or device, does not
 * enable a feature flag, and does not choose a trusted-proxy range. Those are
 * operator decisions and are made with explicit flags and environment
 * variables — see `05 Operations/Railway Deployment Checklist.md`.
 */

import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const EXIT = { ok: 0, configuration: 4, childFailed: 5 };

/**
 * Read a required environment variable, or fail loudly naming it.
 *
 * ## Why the refusal reports what it *did* receive
 *
 * The first version printed only "X is not set", which is true and nearly
 * useless: an operator who has just checked the dashboard and seen the variable
 * sitting there has no way to tell which of these it is —
 *
 *   - the variable is on a different **environment**;
 *   - the variable is on the **project** as a shared variable and was never
 *     linked into this service;
 *   - the change was staged in the editor and never **applied**;
 *   - the name differs from the one the code reads.
 *
 * Each has a different fix and they are indistinguishable from outside, so the
 * question can only be settled by another deploy — and then another. This
 * prints the **names** the container actually received, which answers it in
 * one.
 *
 * `Observability` requires the startup banner to state the posture and nothing
 * secret. **Names only, never values.** A variable name is not a secret — it is
 * already written in the deployment checklist — but its value may be, and
 * `TELGA_RECIPIENT_SALT` in particular must never reach a log.
 */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    console.error(
      `[telga] ${name} is not set. This deployment refuses to guess it — see ` +
        'docs/obsidian/05 Operations/Railway Deployment Checklist.md',
    );

    const telga = Object.keys(process.env)
      .filter((key) => key.startsWith('TELGA_'))
      .sort();
    // Railway injects its own variables into every container. If these are
    // present and the TELGA_ ones are not, the platform is working and the
    // variables are simply not attached to *this* service or environment —
    // which is a dashboard problem, not a deployment one.
    const railway = Object.keys(process.env).filter((key) => key.startsWith('RAILWAY_')).length;

    console.error(
      `[telga] TELGA_* variables this container received (${String(telga.length)}): ` +
        `${telga.length > 0 ? telga.join(', ') : '(none)'}`,
    );
    console.error(
      `[telga] RAILWAY_* variables present: ${String(railway)}. ` +
        (railway > 0 && telga.length === 0
          ? 'Railway is injecting variables, so the TELGA_ ones are attached to a different ' +
            'service or environment, or were staged and never applied.'
          : 'Names only are listed above; no value is ever printed.'),
    );
    process.exit(EXIT.configuration);
  }
  return value.trim();
}

const mode = process.env.TELGA_MODE ?? 'TRAINING';
if (mode !== 'TRAINING') {
  console.error(`[telga] refusing to start: TELGA_MODE is "${mode}", and only TRAINING is supported.`);
  process.exit(EXIT.configuration);
}

// The database must live on the mounted volume. A path under the image's own
// filesystem would look identical at boot and be silently discarded on every
// redeploy, taking the ledger with it.
const dbPath = resolve(required('TELGA_DB_PATH'));
const volumeRoot = resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH ?? '/data');
// `relative` rather than a string prefix: the separator differs by platform,
// and `/data-old` must not count as inside `/data`.
const insideVolume = (() => {
  const rel = relative(volumeRoot, dbPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
})();
if (!insideVolume) {
  console.error(
    `[telga] refusing to start: TELGA_DB_PATH (${dbPath}) is not inside the mounted volume ` +
      `(${volumeRoot}). Data written there would be lost on the next deploy.`,
  );
  process.exit(EXIT.configuration);
}
if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true });

const merchantId = required('TELGA_MERCHANT_ID');
const allowedHosts = required('TELGA_ALLOWED_HOSTS');
const trustProxy = required('TELGA_TRUST_PROXY');
const port = process.env.PORT ?? '4321';

/**
 * The hostname the operations console answers on, or undefined for "not served".
 *
 * Set it to a domain attached to this Railway service. Anything arriving with
 * that `Host` goes to the console; everything else goes to the POS.
 */
const consoleHost = (process.env.TELGA_CONSOLE_HOST ?? '').trim().toLowerCase();
const serveConsole = consoleHost.length > 0;

/**
 * Internal ports, bound to loopback inside the container.
 *
 * Only the proxy is reachable from outside. Neither app binds a public
 * interface when the console is being served, so there is no way to reach
 * either one except through the routing decision below.
 */
const POS_INTERNAL_PORT = '4321';
const CONSOLE_INTERNAL_PORT = '4800';

console.log('[telga] TRAINING MODE — NO REAL VALUE');
console.log(`[telga] database: ${dbPath}`);
console.log(`[telga] volume:   ${volumeRoot}`);
console.log(
  serveConsole
    ? `[telga] console:  serving on Host "${consoleHost}"`
    : '[telga] console:  not served (set TELGA_CONSOLE_HOST to enable)',
);

/** Run a command to completion. Resolves with its exit code. */
function run(args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('exit', (code, signal) => {
      resolveRun(code ?? (signal ? 1 : 0));
    });
  });
}

// --- 1. migrate, single writer, before anything else --------------------------
console.log('[telga] applying migrations (single writer)…');
const migrateCode = await run([
  'services/worker/dist/cli.js',
  '--db',
  dbPath,
  '--migrate',
  '--once',
]);
if (migrateCode !== 0) {
  console.error(`[telga] migration failed with exit ${migrateCode}; refusing to start.`);
  process.exit(migrateCode);
}
console.log('[telga] migrations applied.');

// --- 2 and 3. the two long-running processes ---------------------------------
const children = new Map();
let shuttingDown = false;
/** The front listener, when the console is being served. */
let proxyListener;

function start(label, args) {
  const child = spawn(process.execPath, args, { stdio: 'inherit' });
  children.set(label, child);
  child.on('exit', (code, signal) => {
    children.delete(label);
    if (shuttingDown) return;
    console.error(`[telga] ${label} exited (code=${code} signal=${signal}); stopping the service.`);
    // A POS with no worker leaves pending sales unresolved; a worker with no
    // POS serves nobody. Neither half is worth keeping alive on its own.
    shutdown('child-exit', EXIT.childFailed);
  });
  return child;
}

function shutdown(reason, code) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[telga] shutting down (${reason})…`);
  // Stop accepting before the children are asked to stop, so a request cannot
  // arrive for a process that is already draining.
  if (proxyListener !== undefined) proxyListener.close();
  for (const [label, child] of children) {
    console.log(`[telga] stopping ${label}`);
    // Both CLIs handle SIGTERM: stop accepting, finish in-flight work, release
    // claims, close the database. See their `--shutdown-timeout-ms`.
    child.kill('SIGTERM');
  }
  const deadline = Number(process.env.TELGA_SHUTDOWN_TIMEOUT_MS ?? '15000');
  const timer = setTimeout(() => {
    for (const [label, child] of children) {
      console.error(`[telga] ${label} did not stop in time; killing.`);
      child.kill('SIGKILL');
    }
    process.exit(code);
  }, deadline);
  timer.unref();

  const wait = setInterval(() => {
    if (children.size === 0) {
      clearInterval(wait);
      clearTimeout(timer);
      process.exit(code);
    }
  }, 200);
}

start('worker', ['services/worker/dist/cli.js', '--db', dbPath]);

/**
 * Where the POS listens, and what it will believe about the client.
 *
 * **Without the console** it binds `$PORT` on every interface, exactly as
 * before, and trusts only `TELGA_TRUST_PROXY` — Railway's edge.
 *
 * **With the console** it binds loopback on an internal port, and the proxy in
 * front of it is a second hop. So loopback is added to its trusted set: the
 * proxy is inside this container, it is the only thing that can reach the
 * port, and it forwards the edge's own `X-Forwarded-*` headers unchanged. The
 * edge's range stays in the list too, so the app's view of "who may tell me the
 * client's scheme" is still an explicit list and still has no trust-all entry
 * (D45, D109).
 */
const posHost = serveConsole ? '127.0.0.1' : '0.0.0.0';
const posPort = serveConsole ? POS_INTERNAL_PORT : port;
const posTrust = serveConsole ? `${trustProxy},127.0.0.1/32,::1/128` : trustProxy;

start('pos', [
  'apps/merchant-pos/dist/cli.js',
  '--db', dbPath,
  '--merchant', merchantId,
  '--host', posHost,
  '--port', posPort,
  '--transport', 'TRAINING_HTTPS',
  // Railway terminates TLS at its edge and speaks HTTP to this container, so
  // the scheme is whatever the edge says it is — believed only from the
  // address range named in TELGA_TRUST_PROXY. There is no trust-all option and
  // no built-in range: see `apps/merchant-pos/src/transport/proxy.ts`.
  '--tls-termination', 'TRUSTED_PROXY',
  '--trust-proxy', posTrust,
  '--allowed-hosts', allowedHosts,
]);

if (serveConsole) {
  /**
   * The first administrator, so somebody can actually sign in.
   *
   * A fresh volume has no admin user, and the console has no sign-up: without
   * this, the panel deploys and nobody on earth can open it. There is no shell
   * on a Railway container to run the CLI by hand, so the supervisor runs it.
   *
   * ## Why this is safe to run on every boot
   *
   * `saveAdminUser` inserts, and the email is unique — so the **second** and
   * every later attempt fails and changes nothing. It cannot overwrite an
   * existing owner, reset a password, or reinstate a suspended account. A
   * non-zero exit here is therefore the normal case after the first deploy, and
   * it is logged rather than treated as a failure.
   *
   * The trade this accepts: a genuine refusal (a malformed email, a password
   * under twelve characters) looks the same as "already exists" from here. The
   * console prints its own reason to stderr and Railway keeps it, so the
   * distinction is one log line away rather than invisible.
   *
   * ## What it does not grant
   *
   * A password alone opens nothing. The console requires a second factor to be
   * enrolled before any screen works, so an environment variable that leaked
   * would still not be an admin session. Change the password after first
   * sign-in regardless — it has been in a deployment variable, which is not
   * where a credential should live permanently.
   */
  const ownerEmail = (process.env.TELGA_CONSOLE_OWNER_EMAIL ?? '').trim();
  const ownerPassword = process.env.TELGA_CONSOLE_OWNER_PASSWORD ?? '';
  if (ownerEmail.length > 0 && ownerPassword.length > 0) {
    console.log(`[telga] ensuring a Platform Owner exists (${ownerEmail})…`);
    const ownerCode = await run([
      'apps/operations-console/dist/cli.js',
      '--db', dbPath,
      '--create-owner', ownerEmail,
      '--owner-password', ownerPassword,
      '--owner-name', process.env.TELGA_CONSOLE_OWNER_NAME ?? ownerEmail,
    ]);
    console.log(
      ownerCode === 0
        ? '[telga] Platform Owner created. Sign in and enrol a second factor.'
        : '[telga] no Platform Owner created — it already exists, or the console refused it above.',
    );
  } else {
    console.log(
      '[telga] TELGA_CONSOLE_OWNER_EMAIL/PASSWORD not set — no administrator will be created.',
    );
  }

  /**
   * Set an administrator's password, when the operator explicitly asks.
   *
   * ## Why this is here
   *
   * The step above cannot do it: `saveAdminUser` inserts, and the email is
   * unique, so it is a no-op ever after. There is no shell on a Railway
   * container and no account screen in the console, so without this an
   * administrator who cannot sign in has no route back and nobody can give
   * them one.
   *
   * ## Why it is gated on its own variable
   *
   * Because a reset that ran on every boot would silently re-apply whatever is
   * in the environment, forever, and would quietly undo a password changed by
   * any other means later. `TELGA_CONSOLE_OWNER_RESET` must be set to `true`
   * deliberately; **remove it once you are in**, so the next deploy does not
   * reset the password again.
   *
   * The new password travels in `TELGA_CONSOLE_NEW_PASSWORD` and is read by the
   * console from its own environment — it is never passed as an argument, so it
   * does not appear in a process listing.
   */
  if ((process.env.TELGA_CONSOLE_OWNER_RESET ?? '').toLowerCase() === 'true') {
    const resetEmail = (process.env.TELGA_CONSOLE_OWNER_EMAIL ?? '').trim();
    if (resetEmail.length === 0) {
      console.log('[telga] TELGA_CONSOLE_OWNER_RESET is set but TELGA_CONSOLE_OWNER_EMAIL is not — nothing to reset.');
    } else {
      console.log(`[telga] TELGA_CONSOLE_OWNER_RESET is on — setting the password for ${resetEmail}…`);
      const resetCode = await run([
        'apps/operations-console/dist/cli.js',
        '--db', dbPath,
        '--set-password', resetEmail,
      ]);
      console.log(
        resetCode === 0
          ? '[telga] password set. REMOVE TELGA_CONSOLE_OWNER_RESET now, or the next deploy will set it again.'
          : '[telga] password NOT set — the console printed the reason above.',
      );
    }
  }

  /**
   * Say why sign-in would be refused, on every boot.
   *
   * `/login` gives one sentence for a wrong password, an unknown email and a
   * suspended account, because telling them apart in the browser would turn the
   * form into a way to discover which administrators exist. That leaves the
   * operator with nothing to work from, and there is no shell here to inspect
   * the row.
   *
   * So the state goes to the deployment log, which only this project's people
   * can read: whether the account exists, whether it is locked, whether a
   * second factor is enrolled. No hash, no token, no secret of any kind.
   *
   * Unconditional, because the one time it is wanted is the time nobody can get
   * in to switch it on.
   */
  if (ownerEmail.length > 0) {
    await run([
      'apps/operations-console/dist/cli.js',
      '--db', dbPath,
      '--admin-status', ownerEmail,
    ]);
  }

  start('console', [
    'apps/operations-console/dist/cli.js',
    '--db', dbPath,
    '--host', '127.0.0.1',
    '--port', CONSOLE_INTERNAL_PORT,
    // The console refuses a non-loopback bind without proof that something in
    // front is terminating TLS. It binds loopback here, and the range is what
    // makes its session cookie `Secure` — which it must be, because the
    // connection from the browser to Railway's edge is HTTPS.
    '--trust-proxy', `${trustProxy},127.0.0.1/32,::1/128`,
    // Its own hostname, not the POS's. The console answers only for the host it
    // was told about, and that host is what the proxy routes on.
    '--allowed-hosts', consoleHost,
    /**
     * Single-factor, when the operator asked for it — D143.
     *
     * Passed through rather than decided here: the console owns the meaning of
     * the flag, prints it at start-up and shows a banner on every page. This
     * script only relays the setting, so there is exactly one place that
     * decides what "single factor" means.
     *
     * Absent means strict. A deployment that forgets the variable gets a second
     * factor, which is the only safe direction for a default to fail in.
     */
    ...((process.env.TELGA_CONSOLE_SINGLE_FACTOR ?? '').toLowerCase() === 'true'
      ? ['--single-factor', 'true']
      : []),
  ]);

  startProxy();
}


/**
 * The front door: one listener on `$PORT`, routing on `Host`.
 *
 * ## What it does and does not touch
 *
 * It forwards the request unchanged — method, path, body, and **every header**,
 * including the `X-Forwarded-*` set Railway's edge already wrote. It adds
 * nothing to them: rewriting `X-Forwarded-For` here would replace the client's
 * address with the proxy's own, and both apps use that value (the POS to
 * throttle registration by source, both to decide the client's scheme). The one
 * header it must preserve above all is `Host`, because that is what each app's
 * own allow-list checks.
 *
 * ## Why an unknown Host goes to the POS
 *
 * Because that is the merchant-facing app and the safe default: a request that
 * does not name the console's hostname must never reach the console. The
 * console's own `--allowed-hosts` would refuse it anyway — this is the first of
 * two checks, not the only one.
 *
 * ## What it is not
 *
 * Not a load balancer, not a cache, not a TLS terminator. Railway's edge does
 * TLS; this speaks plain HTTP to loopback inside one container.
 *
 * The routing decision below is pinned by `tests/admin/console-routing.test.ts`,
 * which duplicates it against real listeners — including the near-miss
 * hostnames a `startsWith` or `includes` comparison would hand the admin panel
 * to. This file cannot be imported by a test: it reads the environment and
 * spawns children at module scope, so importing it would start a deployment.
 */
function startProxy() {
  const listener = createServer((clientReq, clientRes) => {
    const rawHost = String(clientReq.headers.host ?? '');
    // Compared without the port, and lowercased: a browser may send
    // `admin.example.com:443` and an allow-list is written bare.
    const host = rawHost.replace(/:\d+$/, '').toLowerCase();
    const target = host === consoleHost ? CONSOLE_INTERNAL_PORT : POS_INTERNAL_PORT;

    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: target,
        path: clientReq.url,
        method: clientReq.method,
        headers: clientReq.headers,
      },
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      },
    );

    upstream.on('error', (error) => {
      // The app behind this is starting, or has just died — in which case the
      // supervisor is already tearing the service down. Answer plainly rather
      // than hanging: a socket left open is a request the edge waits on until
      // it times out.
      console.error(`[telga] proxy: upstream :${target} unreachable (${error.message})`);
      if (!clientRes.headersSent) clientRes.writeHead(502, { 'content-type': 'text/plain' });
      clientRes.end('Telga is starting or restarting. Try again in a moment.\n');
    });

    clientReq.pipe(upstream);
  });

  listener.on('error', (error) => {
    console.error(`[telga] proxy failed to bind :${port} (${error.message})`);
    shutdown('proxy-failed', EXIT.childFailed);
  });

  listener.listen(Number(port), '0.0.0.0', () => {
    console.log(`[telga] proxy listening on :${port}`);
    console.log(`[telga]   Host ${consoleHost} -> console :${CONSOLE_INTERNAL_PORT}`);
    console.log(`[telga]   everything else    -> pos     :${POS_INTERNAL_PORT}`);
  });

  proxyListener = listener;
}

process.on('SIGTERM', () => shutdown('SIGTERM', EXIT.ok));
process.on('SIGINT', () => shutdown('SIGINT', EXIT.ok));
