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
import { OTP_TTL_MS, hashAdminSecret, sendSignInCode } from '@telga/api';
import {
  SqliteLedgerDriver,
  assertMigrationsApplied,
  fundMerchant,
  postReversalAdjustment,
  postShopTransfer,
  findAdminUserByEmail,
  saveAdminUser,
  setAdminPassword,
} from '@telga/persistence';
import { isEnabled, money, postingId } from '@telga/domain';
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

/**
 * Is this a usable trusted-proxy range?
 *
 * [[Decision Log]] **D109** sets the rule and this enforces it: *"A zero-length
 * prefix (`0.0.0.0/0`, `::/0`) is refused at startup"*, and **no platform range
 * is hardcoded** — the operator observes their edge's address and configures it.
 *
 * ## Why this is not `parseTrustedEntry` from the POS
 *
 * It was, for an hour. Importing `@telga/merchant-pos` to reuse that parser
 * pulled in the POS package index, which re-exports `./cli`, whose entry guard
 * is `process.argv[1]?.endsWith('cli.js')` — and **this console's entry is also
 * named `cli.js`**, so starting the console ran the POS's `main()` and printed
 * `--merchant is required`. Reuse was the right instinct and the wrong import.
 *
 * The POS bug is real and is reported separately; patching a deployed component
 * to make an admin tool convenient is the wrong order of operations.
 *
 * ## What this checks, and what it deliberately does not
 *
 * The console uses the range as a **declaration** that something in front is
 * terminating TLS — it is what permits a non-loopback bind and what makes the
 * session cookie `Secure`. It does not match forwarded headers against the
 * range the way the POS does, because the console reads no `X-Forwarded-*`
 * header at all. So this validates shape and refuses the one value that would
 * mean "trust everything"; it is not, and does not claim to be, a full CIDR
 * matcher.
 */
function usableTrustRange(entry: string): boolean {
  const slash = entry.lastIndexOf('/');
  if (slash === -1) return false;
  const address = entry.slice(0, slash).trim();
  const prefixText = entry.slice(slash + 1).trim();
  if (address.length === 0 || !/^\d+$/.test(prefixText)) return false;

  const prefix = Number(prefixText);
  const isIpv6 = address.includes(':');
  // A zero-length prefix matches every address. D45: there is no trust-all
  // setting, and refusing it in the parser is where it cannot be forgotten.
  if (prefix <= 0) return false;
  if (prefix > (isIpv6 ? 128 : 32)) return false;

  if (isIpv6) return /^[0-9a-fA-F:]+$/.test(address);
  const octets = address.split('.');
  if (octets.length !== 4) return false;
  return octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);
}

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
   * {@link usableTrustRange} checks the claim: it refuses a zero-length prefix
   * (`0.0.0.0/0`, `::/0`), so "trust everything" cannot be expressed here any
   * more than it can in the POS. A malformed range is refused at start-up
   * rather than silently matching nothing, because a range that matches nothing
   * looks identical to a working deployment until the first sign-in fails.
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
    if (!usableTrustRange(entry)) {
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

  /**
   * Report an administrator's state, then exit — why sign-in is refused.
   *
   * ## Why this exists
   *
   * `/login` answers **one sentence for three different refusals**, on purpose:
   * a wrong password, an unknown email and a suspended account must look
   * identical or the form becomes a way to discover which administrators exist.
   * That is right for the browser and useless for the operator, who then cannot
   * tell a typo from a lockout from an account that was never created.
   *
   * A Railway container has no shell, so "just look at the row" was not
   * available either. This prints the state to the deployment log, where only
   * the project's own people can read it.
   *
   * ## It prints no secret
   *
   * No hash, no salt, no session token, no MFA secret — only whether each
   * exists. Everything here is operational fact an administrator needs to
   * unstick themselves.
   */
  const statusFor = values.get('admin-status');
  if (statusFor !== undefined && statusFor !== 'true') {
    const found = findAdminUserByEmail(connection, statusFor);
    const at = now();
    if (found === undefined) {
      write(`No administrator holds ${statusFor}.`);
      write('Every sign-in with this email answers "Sign in refused" and always will.');
      write('Set TELGA_CONSOLE_OWNER_EMAIL and TELGA_CONSOLE_OWNER_PASSWORD, then redeploy.');
      connection.close();
      return EXIT.ok;
    }
    const locked =
      found.locked_until !== null && Date.parse(found.locked_until) > Date.parse(at);
    write(`Administrator ${found.email} (${found.id})`);
    write(`  status           ${found.status}`);
    write(`  role             ${found.role}`);
    write(`  failed attempts  ${String(found.failed_attempts)}`);
    write(`  held             ${locked ? `YES, until ${String(found.locked_until)}` : 'no'}`);
    write(`  second factor    ${found.mfa_secret_hash === null ? 'not enrolled' : 'enrolled'}`);
    write(`  last sign-in     ${found.last_login_at ?? 'never'}`);
    write(`  password set at  ${found.updated_at}`);

    // The point of the command: say which refusal this account would produce.
    if (locked) {
      write('');
      write('SIGN-IN IS REFUSED BECAUSE THE ACCOUNT IS HELD.');
      write('The correct password is refused too while a hold stands.');
      // Which tier they are on changes what they should do: wait ten minutes,
      // or stop waiting and reset.
      write(
        found.failed_attempts >= 6
          ? 'This is the 24-hour hold — six failures. Waiting is not practical; reset instead.'
          : 'This is the 10-minute hold — four failures. Two more tries follow it, then 24 hours.',
      );
      write('Set TELGA_CONSOLE_OWNER_RESET=true with TELGA_CONSOLE_NEW_PASSWORD to clear it now.');
    } else if (found.status !== 'ACTIVE') {
      write('');
      write(`SIGN-IN IS REFUSED BECAUSE THE ACCOUNT IS ${found.status}.`);
      write('It is refused identically to a wrong password, which is why it looks like one.');
    } else if (found.failed_attempts > 0) {
      write('');
      write(`Not held, but ${String(found.failed_attempts)} failed attempt(s) stand against it.`);
      write(
        found.failed_attempts >= 4
          ? 'In the grace window: two tries after the 10-minute hold, then 24 hours.'
          : `${String(4 - found.failed_attempts)} more failure(s) starts a 10-minute hold.`,
      );
      write('The password last set at the time above is the only one that will work.');
    }
    connection.close();
    return EXIT.ok;
  }

  /**
   * Set an existing administrator's password, then exit — the way back in.
   *
   * ## The gap this closes
   *
   * Reported after the first deployment: *"Admin console login refuses my
   * email/password every time — never lets me in."*
   *
   * There was no way to change an admin password **anywhere in this product**.
   * The console has no account screen, `saveAdminUser` only inserts, and the
   * Railway boot step that creates the first owner is a no-op ever after
   * because the email is unique. A Railway container has no shell. So an
   * administrator whose password did not match had no path back in, and nobody
   * could give them one — the deployment was one forgotten password away from
   * being permanently unadministrable.
   *
   * ## The password is read from the environment, never from a flag
   *
   * `--owner-password` above takes it as an argument, which puts it in shell
   * history, in `ps` output, and in the argv captured by a crash reporter. This
   * path does not repeat that: it reads `TELGA_CONSOLE_NEW_PASSWORD`, so the
   * secret is in the process environment and nowhere a bystander or a log
   * scraper can read it.
   *
   * ## What it deliberately does not do
   *
   * It does not create an account. An email that holds none is reported as
   * such, because silently creating a Platform Owner from a typo in an
   * environment variable is how an unintended administrator appears. Use
   * `--create-owner` for that, deliberately.
   */
  const setPasswordFor = values.get('set-password');
  if (setPasswordFor !== undefined && setPasswordFor !== 'true') {
    /**
     * Which variable holds the password, said out loud.
     *
     * **This ambiguity caused a real lockout**, 2026-09-12. Creating an account
     * reads `TELGA_CONSOLE_OWNER_PASSWORD`; resetting one read only
     * `TELGA_CONSOLE_NEW_PASSWORD`. On a boot where both steps ran, the create
     * used one value and the reset immediately overwrote it with the other —
     * so the operator typed the password they had just set and was refused,
     * with nothing in the log to say two different secrets were in play.
     *
     * `TELGA_CONSOLE_NEW_PASSWORD` still wins when set, because a deliberate
     * reset should be able to differ from the seed. But it now **falls back**
     * to the owner password rather than failing, and the log always names the
     * variable it used — never the value.
     */
    const explicit = process.env['TELGA_CONSOLE_NEW_PASSWORD'] ?? '';
    const seeded = process.env['TELGA_CONSOLE_OWNER_PASSWORD'] ?? '';
    const next = explicit.length > 0 ? explicit : seeded;
    const source =
      explicit.length > 0 ? 'TELGA_CONSOLE_NEW_PASSWORD' : 'TELGA_CONSOLE_OWNER_PASSWORD';

    if (next.length < 12) {
      writeError(
        'Set TELGA_CONSOLE_NEW_PASSWORD (or TELGA_CONSOLE_OWNER_PASSWORD) to the ' +
          'new password, 12+ characters. It is read from the environment, not ' +
          'passed as an argument, so it stays out of shell history and process ' +
          'listings.',
      );
      connection.close();
      return EXIT.badArguments;
    }

    if (explicit.length > 0 && seeded.length > 0 && explicit !== seeded) {
      // Not a refusal — but the operator must know which one they now type.
      write('WARNING: TELGA_CONSOLE_NEW_PASSWORD and TELGA_CONSOLE_OWNER_PASSWORD differ.');
      write('  The account will hold TELGA_CONSOLE_NEW_PASSWORD. Sign in with that one.');
      write('  Remove TELGA_CONSOLE_NEW_PASSWORD to keep a single source of truth.');
    }
    const derived = await hashAdminSecret(next);
    const changed = setAdminPassword(connection, {
      email: setPasswordFor,
      passwordHash: derived.hash,
      passwordSalt: derived.salt,
      passwordParams: derived.params,
      at: now(),
    });
    connection.close();
    if (changed === 0) {
      // Named plainly. This runs on a machine an operator already controls, so
      // there is nothing to disclose to an attacker and everything to gain
      // from saying which of the two things went wrong.
      writeError(`No administrator holds ${setPasswordFor}. Nothing was changed.`);
      return EXIT.configurationInvalid;
    }
    write(`Password set for ${setPasswordFor}, from ${source}.`);
    write('Any lockout and failed-attempt count were cleared, and the account is ACTIVE.');
    return EXIT.ok;
  }

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

  // `::1` included, matching `isLoopback` above. An operator who binds to IPv6
  // loopback must be able to post a form to the page they were just served.
  const allowedHosts = (allowedHostsRaw ?? 'localhost,127.0.0.1,::1')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);

  /**
   * Sign in with a password alone — [[Decision Log]] **D143**.
   *
   * The founder's instruction, 2026-09-09: an administrator who has just typed
   * a password should not be asked for a six-digit code again on every button.
   * Both the second factor and step-up re-authentication are switched off
   * together, because leaving one on would reproduce the complaint.
   *
   * ## What it does not touch
   *
   * **Permissions.** An administrator still cannot do anything their role does
   * not grant, and every action is still audited under their name. Relaxing how
   * hard identity is proved and widening what an identity may do are different
   * decisions; this is only the first.
   *
   * ## Why a flag and not a code change
   *
   * So that switching it back on for real money is one setting rather than a
   * rebuild, and so that its being off is visible in the deployment
   * configuration rather than buried in a diff. The console prints it at
   * start-up and shows a banner on **every page**, because a deliberate
   * relaxation that is invisible becomes an accidental one the first time
   * somebody copies the configuration somewhere it does not belong.
   */
  const singleFactorAuth =
    values.get('single-factor') === 'true' ||
    (process.env['TELGA_CONSOLE_SINGLE_FACTOR'] ?? '').toLowerCase() === 'true';

  if (singleFactorAuth) {
    /**
     * The combination that must never start — §23.1, §8.
     *
     * *"It must be off before live money. §8's security and permissions gate
     * cannot close while it is on."* That was a sentence in a document, and a
     * sentence in a document is not a control: the only thing standing between
     * a training relaxation and a live-money console was somebody remembering
     * to drop a flag from a deploy command.
     *
     * Now the two refuse to coexist. `assertNoLiveMoneyEnabled()` above already
     * refuses a live-money build outright; this refuses the narrower and more
     * likely mistake — a real deployment that keeps the convenient flag.
     */
    if (isEnabled('money.live')) {
      throw new ConsoleArgumentError(
        'Refusing to start: --single-factor cannot be used while money.live is on. ' +
          'CLAUDE.md §23.1 — the relaxation is for a training deployment only, and ' +
          "§8's security gate cannot close while it is on.",
      );
    }
    write('SINGLE-FACTOR MODE: password only. No second factor, no step-up.');
    write('Training configuration. This must be off before any real money.');
  }

  /**
   * The bank account a merchant deposit is expected to land in.
   *
   * ## Why this is required rather than defaulted
   *
   * `verifyDeposit` compares the account named on the bank record against this
   * value and **rejects `WRONG_ACCOUNT`** when they differ — a genuine slip for
   * a deposit into some other account is still not this deposit.
   *
   * The server option existed and the CLI never set it, so `expectedAccount`
   * was always the empty string. Every deposit naming an account was therefore
   * rejected as `WRONG_ACCOUNT`, and one naming none was rejected as
   * `NO_BANK_RECORD` — **there was no path to `CREDITED` at all**, and the
   * screens, the route and the ledger wiring all worked perfectly on either
   * side of a gap nobody could cross. The same shape as `creditMerchant` being
   * unwired, one release earlier.
   *
   * It is **not** defaulted to a plausible account number. Inventing the
   * account that merchant money is checked against is exactly the kind of
   * confident guess that §30 forbids: an operator who never set it would get a
   * console that credits deposits against an account MuleSoo does not hold.
   * Unset means deposits still refuse — the safe direction — and say why.
   */
  const depositAccount = (
    values.get('deposit-account') ??
    process.env['TELGA_DEPOSIT_ACCOUNT'] ??
    ''
  ).trim();

  if (depositAccount.length === 0) {
    write('No --deposit-account set. Deposits will be refused until one is configured.');
    write('Set --deposit-account <account> or TELGA_DEPOSIT_ACCOUNT to the account');
    write('merchant transfers are paid into.');
  } else {
    write(`Deposits are checked against account ${depositAccount}.`);
  }

  /**
   * A driver over the same file, for the one operation that posts to the ledger.
   *
   * The console works in raw SQL against `connection` because it reads admin,
   * tenant and application tables that the ledger driver knows nothing about.
   * Crediting a deposit is different: it must go through `fundMerchant`, which
   * writes a **balanced pair** inside the driver's transaction, because a
   * deposit posted with hand-written SQL is how a ledger stops balancing.
   *
   * ## Why it is given the console's own connection
   *
   * It used to open its own, with a comment claiming that was *"safe here —
   * WAL, and SQLite serialises writers"*.
   *
   * **It was not safe, and it failed every time.** Recording a deposit opens a
   * write transaction on `connection` and then credits the merchant inside it.
   * On a second connection that credit is a different writer, against a file
   * whose write lock the first connection is still holding — and it cannot
   * wait for a transaction that is itself waiting for the credit to return.
   * Every deposit that reached the crediting step died on
   * `SQLITE_BUSY: database is locked`. That writers are serialised is precisely
   * the problem: one process cannot queue behind itself.
   *
   * Sharing the connection makes the credit part of the transaction enclosing
   * it, which is what the ledger wants anyway: `driver.transaction()` is
   * `better-sqlite3`'s helper, and it issues a `SAVEPOINT` rather than a
   * `BEGIN` when the connection is already in a transaction. The balanced pair
   * still rolls back as a unit, and the deposit row and its ledger entries
   * commit together or not at all.
   */
  const ledgerDriver = new SqliteLedgerDriver({ file: db, connection: connection as never });

  /**
   * Emailing the sign-in code — §23.1.
   *
   * ## Environment only, never a flag
   *
   * A secret passed on a command line is in the shell history, in the process
   * list, and in any crash report that captures `argv` (§24). The deposit
   * account above is a flag because it is not a secret; this is.
   *
   * ## Both parts, or neither
   *
   * Resend refuses a `from` address on an unverified domain, so a key without a
   * sender is a key that cannot send. Half a configuration would produce a
   * console that looks ready and fails at the one moment an administrator needs
   * it — announced here instead.
   */
  const resendKey = (process.env['RESEND_API_KEY'] ?? '').trim();
  const resendFrom = (process.env['RESEND_FROM'] ?? '').trim();
  const emailNamed = [resendKey, resendFrom].filter((part) => part.length > 0).length;

  if (emailNamed === 1) {
    throw new ConsoleArgumentError(
      'Email sign-in codes are half configured. Set RESEND_API_KEY and RESEND_FROM ' +
        'together, or neither. A key with no verified sender cannot send anything.',
    );
  }

  const emailSecondFactor = emailNamed === 2;

  if (emailSecondFactor) {
    write(`Sign-in codes will be emailed from ${resendFrom}.`);
    write(`A code expires in ${String(Math.round(OTP_TTL_MS / 1000))} seconds.`);
  } else if (!singleFactorAuth) {
    // Worth saying out loud: without this, the second factor is an authenticator
    // app, and an administrator without one enrolled cannot get in at all.
    write('No RESEND_API_KEY set. The second factor is an authenticator app only.');
  }

  const handler = createConsoleServer({
    db: connection as never,
    now,
    newId,
    schemaVersion: values.get('schema-version') ?? '016',
    /**
     * Absent means no emailed second factor, and the console says so at
     * start-up. A build that looked configured and silently sent nothing would
     * leave an administrator staring at an inbox.
     */
    ...(emailSecondFactor
      ? {
          sendSignInCode: (to: string, code: string, minutes: number) =>
            sendSignInCode({ apiKey: resendKey, from: resendFrom }, to, code, minutes),
        }
      : {}),
    allowedHosts,
    // Secure when this process serves TLS, **and** when a trusted proxy does it
    // in front. Getting the second case wrong is the failure that looks like
    // nothing: the cookie is sent without `Secure`, everything appears to work,
    // and the session travels in clear text on the last hop.
    secureCookies: wantsTls || behindProxy,
    singleFactorAuth,
    // Empty when unset, which `verifyDeposit` will never match, so deposits
    // refuse rather than credit against an account nobody configured.
    depositAccount,
    /**
     * The deposit screens, wired to the ledger they claim to post to.
     *
     * They had a route, a screen and a navigation entry, and `creditMerchant`
     * was never supplied — so `/deposits` answered **404** and the Deposits link
     * led nowhere. The option is optional by design, and its own comment says
     * why: *"its absence closes the deposit screens entirely rather than letting
     * them record a credit that never posted."* That was the right guard, and
     * the CLI simply never satisfied it.
     *
     * `fundMerchant` posts a **balanced, append-only** pair against
     * `BANK_CLEARING` — the same call the deposit tests drive — so a recorded
     * deposit and the shop's balance cannot disagree. Nothing here reaches a
     * bank: this credits a training float, and `funding.submission` (a real
     * deposit against a real bank reference) remains off.
     */
    /**
     * Return the value of a settled sale — §17.1, D152.
     *
     * `postReversalAdjustment` posts a **compensating credit** and never edits
     * the original entries: §13 invariant 8, and the ledger is append-only, so
     * the history of what happened stays readable after the correction.
     */
    /**
     * Both sides of an approved shop transfer — §19.1.
     *
     * One balanced posting: the sender debited the amount plus any fee, the
     * recipient credited the amount. A transfer that debited without crediting
     * is money destroyed, which is why `postShopTransfer` does both inside one
     * driver transaction rather than leaving the caller to remember.
     */
    /**
     * Every amount crossing this boundary is already **minor units**, so it is
     * handed to `money()` unchanged.
     *
     * These four ports read `fromBirr(minor / 100)` until 2026-09-12, which
     * **threw on any amount carrying santim**: `fromBirr` requires whole birr
     * by design — *"there is no float path into Money"* — so 1 500.50 birr
     * became `fromBirr(1500.5)` and an `InvalidMoneyError`. The route caught it
     * and said *"could not be posted"*, so a transfer, a reversal or a deposit
     * of anything but a round figure was simply undecidable, with nothing in
     * the message to say why. §13 invariant 9 is the rule it broke.
     */
    postTransfer: (input) => {
      postShopTransfer(ledgerDriver, {
        senderMerchantId: input.senderMerchantId as never,
        recipientMerchantId: input.recipientMerchantId as never,
        amount: money(input.amountMinor),
        fee: money(input.feeMinor),
        at: input.at as never,
        correlationId: input.correlationId,
        postingId: postingId(input.postingId),
      });
    },
    postReversal: (input) => {
      postReversalAdjustment(ledgerDriver, {
        merchantId: input.merchantId as never,
        amount: money(input.amountMinor),
        at: input.at as never,
        correlationId: input.correlationId,
        postingId: postingId(input.postingId),
        transactionId: input.transactionId as never,
      });
    },
    creditMerchant: (input) => {
      fundMerchant(ledgerDriver, {
        merchantId: input.merchantId as never,
        amount: money(input.amountMinor),
        at: input.at as never,
        correlationId: input.correlationId,
        postingId: postingId(input.postingId),
      });
    },
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
