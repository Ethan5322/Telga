/**
 * The Operations Console entry point.
 *
 * ```
 * node apps/operations-console/dist/cli.js --db ./telga.sqlite --port 4800
 * node apps/operations-console/dist/cli.js --db ./telga.sqlite --create-owner you@telga.example
 * ```
 *
 * ## Why it refuses to serve anything but loopback over HTTP
 *
 * The same rule the POS enforces, for a stronger reason. A POS session sells
 * airtime for one shop; a console session can suspend merchants, approve
 * funding and create administrators. Serving that in clear text on a shared
 * network is worse than doing it for the POS, so the refusal is not softened
 * here — it is the same check with a blunter message.
 *
 * ## Why creating the first owner is a command, not a screen
 *
 * There is no public registration and no bootstrap web page. A console that
 * could create its own first administrator over HTTP is a console anyone who
 * reaches it first can own. Creating one requires shell access to the machine
 * holding the database, which is a meaningful barrier and an auditable one.
 */

import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { hashAdminSecret } from '@telga/api';
// Reused, not reimplemented. `parseTrustedEntry` is the parser that refuses a
// zero-length prefix, which is what keeps D45's "there is no trust-all setting"
// true for the console as well as the POS.
import { parseTrustedEntry } from '@telga/merchant-pos';
import { assertMigrationsApplied, saveAdminUser } from '@telga/persistence';
import { createConsoleServer } from './server';

export const EXIT = Object.freeze({
  ok: 0,
  badArguments: 2,
  configurationInvalid: 4,
  migrationsNotApplied: 6,
});

export class ConsoleArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsoleArgumentError';
  }
}

function parse(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    // A bare flag is `true`; anything else takes the following value.
    if (next === undefined || next.startsWith('--')) {
      values.set(key, 'true');
    } else {
      values.set(key, next);
      i += 1;
    }
  }
  return values;
}

/** Loopback only, unless TLS is configured. */
const isLoopback = (host: string): boolean =>
  host === '127.0.0.1' || host === '::1' || host === 'localhost';

export async function run(
  argv: readonly string[],
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  writeError: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<number> {
  const values = parse(argv);
  const db = values.get('db');
  if (db === undefined || db === 'true') {
    writeError('Missing --db <path>. The console will not guess a database location.');
    return EXIT.badArguments;
  }

  const port = Number(values.get('port') ?? '4800');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    writeError('--port must be a whole number between 1 and 65535.');
    return EXIT.badArguments;
  }

  const host = values.get('host') ?? '127.0.0.1';
  const allowedHostsRaw = values.get('allowed-hosts');
  const certPath = values.get('tls-cert');
  const keyPath = values.get('tls-key');
  const wantsTls = certPath !== undefined || keyPath !== undefined;

  if (wantsTls && (certPath === undefined || keyPath === undefined)) {
    writeError('Both --tls-cert and --tls-key are required to serve HTTPS. [TLS_PAIR_REQUIRED]');
    return EXIT.configurationInvalid;
  }

  /**
   * The third way to serve beyond this machine: TLS terminated by a trusted
   * proxy.
   *
   * On a platform like Railway the edge terminates TLS and speaks **HTTP** to
   * the container, so there is no certificate to hand this process and the
   * loopback rule would otherwise make the console undeployable. The POS solved
   * exactly this and its answer is reused rather than reinvented — see
   * [[Decision Log]] **D109**.
   *
   * **The rule is not relaxed, it is satisfied differently.** Binding beyond
   * loopback still requires proof that something in front is doing TLS, and
   * `parseTrustedEntry` is what checks the claim: it refuses a zero-length
   * prefix (`0.0.0.0/0`, `::/0`), so "trust everything" cannot be expressed
   * here any more than it can in the POS. A malformed range is refused at
   * start-up rather than silently matching nothing, because a range that
   * matches nothing looks identical to a working deployment until the first
   * sign-in fails.
   */
  const trustProxyRaw = values.get('trust-proxy');
  const trustProxy =
    trustProxyRaw === undefined || trustProxyRaw === 'true'
      ? []
      : trustProxyRaw
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);

  for (const entry of trustProxy) {
    if (parseTrustedEntry(entry) === undefined) {
      writeError(
        `Refusing: "${entry}" is not a usable --trust-proxy range. A zero-length prefix ` +
          'trusts every address and is refused; so is a range that parses to nothing. ' +
          '[CONSOLE_TRUST_PROXY_INVALID]',
      );
      return EXIT.configurationInvalid;
    }
  }

  const behindProxy = trustProxy.length > 0;

  if (!wantsTls && !behindProxy && !isLoopback(host)) {
    // The same refusal the POS makes, for a console that can do considerably
    // more damage.
    writeError(
      `Refusing: the console may bind only to loopback over plain HTTP; refusing "${host}". ` +
        'Supply --tls-cert and --tls-key, or --trust-proxy <cidr> when TLS is terminated ' +
        'by a proxy in front. [CONSOLE_MUST_BE_LOOPBACK]',
    );
    return EXIT.configurationInvalid;
  }

  if (behindProxy && allowedHostsRaw === undefined) {
    // A console reachable from a network must know which names are its own.
    // The `Host` header is client-controlled, and answering for any of them is
    // how a console ends up serving somebody else's domain.
    writeError(
      'Refusing: --allowed-hosts is required with --trust-proxy. The console will not ' +
        'answer for a host it was not told about. [CONSOLE_ALLOWED_HOSTS_REQUIRED]',
    );
    return EXIT.configurationInvalid;
  }

  const connection = new Database(db);
  connection.pragma('foreign_keys = ON');
  try {
    assertMigrationsApplied(connection);
  } catch (error) {
    writeError(
      error instanceof Error ? error.message : 'Refusing to start: migrations not applied',
    );
    connection.close();
    return EXIT.migrationsNotApplied;
  }

  const now = (): string => new Date().toISOString();
  const newId = (prefix: string): string =>
    `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  // --- create the first administrator, then exit -------------------------
  const createOwner = values.get('create-owner');
  if (createOwner !== undefined && createOwner !== 'true') {
    const password = values.get('owner-password');
    if (password === undefined || password === 'true' || password.length < 12) {
      writeError('--owner-password is required with --create-owner, and must be 12+ characters.');
      connection.close();
      return EXIT.badArguments;
    }
    const derived = await hashAdminSecret(password);
    try {
      const id = newId('adm');
      saveAdminUser(connection, {
        id,
        email: createOwner,
        displayName: values.get('owner-name') ?? createOwner,
        department: 'PLATFORM',
        role: 'PLATFORM_OWNER',
        passwordHash: derived.hash,
        passwordSalt: derived.salt,
        passwordParams: derived.params,
        status: 'ACTIVE',
        at: now(),
      });
      write(`Created Platform Owner ${createOwner} (${id}).`);
      write('Sign in, then set up an authenticator before anything else works.');
      // The password was supplied on the command line, so it is in the shell
      // history. Saying so is more useful than pretending otherwise.
      write('This password is now in your shell history. Change it after first sign-in.');
    } catch (error) {
      writeError(
        `Could not create the owner: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      connection.close();
      return EXIT.configurationInvalid;
    }
    connection.close();
    return EXIT.ok;
  }

  const allowedHosts = (allowedHostsRaw ?? 'localhost,127.0.0.1')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);

  const handler = createConsoleServer({
    db: connection as never,
    now,
    newId,
    schemaVersion: values.get('schema-version') ?? '016',
    allowedHosts,
    // Secure when this process serves TLS, **and** when a trusted proxy does it
    // in front. Getting the second case wrong is the failure that looks like
    // nothing: the cookie is sent without `Secure`, everything appears to work,
    // and the session travels in clear text on the last hop.
    secureCookies: wantsTls || behindProxy,
  });

  const server = wantsTls
    ? createHttpsServer(
        {
          cert: readFileSync(certPath as string),
          key: readFileSync(keyPath as string),
        },
        // Reuse the request handler the HTTP server was built around.
        (request, response) => handler.emit('request', request, response),
      )
    : handler;

  // A listen failure must read like a sentence, not a stack trace. The most
  // common one by far is a console already running on the port, and an operator
  // who sees `EADDRINUSE` with ten frames of Node internals usually concludes
  // the app is broken rather than already open in another window.
  let listenFailure: string | undefined;
  // Held so the error handler can end the wait below. Without this the failed
  // listen leaves nothing keeping the event loop alive, Node drains and exits
  // 0, and the operator sees no output at all — the same silent-exit shape that
  // made the worker look like it had started when it had not.
  let finish: () => void = () => undefined;
  server.on('error', (error: NodeJS.ErrnoException) => {
    listenFailure =
      error.code === 'EADDRINUSE'
        ? `Port ${String(port)} is already in use — the console may already be running. ` +
          `Open http://${host}:${String(port)}/login, or start this one with a different --port.`
        : error.code === 'EACCES'
          ? `Not allowed to listen on port ${String(port)}. Ports below 1024 need elevation; ` +
            'pick a higher --port.'
          : `Could not start the console: ${error.message}`;
    server.close();
    finish();
  });

  server.listen(port, host, () => {
    const scheme = wantsTls ? 'https' : 'http';
    write('TELGA OPERATIONS CONSOLE — Telga staff only. Every action is recorded.');
    write(`Console on ${scheme}://${host}:${String(port)}/login`);
    write(`Answering for hosts: ${allowedHosts.join(', ')}`);
    if (!wantsTls) {
      write('PLAIN HTTP, LOOPBACK ONLY. Supply --tls-cert and --tls-key to serve the network.');
    }
  });

  // Resolves when the listener closes — on a signal, or on a failure to bind.
  await new Promise<void>((resolve) => {
    finish = resolve;
    const stop = (): void => {
      server.close(() => {
        resolve();
      });
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });

  connection.close();
  if (listenFailure !== undefined) {
    writeError(listenFailure);
    return EXIT.configurationInvalid;
  }
  return EXIT.ok;
}

async function main(): Promise<void> {
  process.exitCode = await run(process.argv.slice(2));
}

declare const require: { main?: unknown } | undefined;
declare const module: unknown;

if (typeof require !== 'undefined' && require.main === module) {
  void main();
}
