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
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const EXIT = { ok: 0, configuration: 4, childFailed: 5 };

/** Read a required environment variable, or fail loudly naming it. */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    console.error(
      `[telga] ${name} is not set. This deployment refuses to guess it — see ` +
        'docs/obsidian/05 Operations/Railway Deployment Checklist.md',
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

console.log('[telga] TRAINING MODE — NO REAL VALUE');
console.log(`[telga] database: ${dbPath}`);
console.log(`[telga] volume:   ${volumeRoot}`);

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

start('pos', [
  'apps/merchant-pos/dist/cli.js',
  '--db', dbPath,
  '--merchant', merchantId,
  '--host', '0.0.0.0',
  '--port', port,
  '--transport', 'TRAINING_HTTPS',
  // Railway terminates TLS at its edge and speaks HTTP to this container, so
  // the scheme is whatever the edge says it is — believed only from the
  // address range named in TELGA_TRUST_PROXY. There is no trust-all option and
  // no built-in range: see `apps/merchant-pos/src/transport/proxy.ts`.
  '--tls-termination', 'TRUSTED_PROXY',
  '--trust-proxy', trustProxy,
  '--allowed-hosts', allowedHosts,
]);

process.on('SIGTERM', () => shutdown('SIGTERM', EXIT.ok));
process.on('SIGINT', () => shutdown('SIGINT', EXIT.ok));
