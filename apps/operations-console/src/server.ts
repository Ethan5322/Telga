/**
 * The Telga Operations Console server.
 *
 * A **separate application** from the merchant POS. Different port, different
 * session cookie, different identity table, different shell. A merchant
 * session cannot reach it and an admin session cannot reach the POS — not
 * because a check says so, but because the two systems share no session store.
 *
 * ## The order every request goes through
 *
 *   1. Origin, on anything that changes state.
 *   2. Session — else the sign-in screen.
 *   3. Second factor — else the code screen, whatever was asked for.
 *   4. Permission, from the domain model.
 *   5. Step-up, for the high-risk ones.
 *
 * Nothing renders before all five pass. A screen that omits a control the
 * admin cannot use is a courtesy; the refusal is the route's job.
 */

import { randomInt } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import {
  adminLogin,
  authenticateAdmin,
  assessRegistration,
  deviceKeyFingerprint,
  hashAdminSecret,
  labelFor,
  verifyDeviceKey,
  newEnrollmentToken,
  beginMfaEnrolment,
  satisfyAdminMfa,
  stepUpAdmin,
  tenantsBehind,
  backupsOverdue,
  ENROLLMENT_NOTICE,
  enrollmentExpiryFrom,
  normalizeEnrollmentToken,
  reviewRefusal,
  statusAfterReview,
  ProvisioningError,
  provisionMerchant,
  newSubmissionReference,
  submissionRejection,
  boundaryOf,
  createDocumentVault,
  isAllowedMediaType,
  issueCredentials,
  recordDeposit,
  parseMultipart,
  MAX_DOCUMENT_BYTES,
} from '@telga/api';
import type { DocumentMediaType, MultipartFile } from '@telga/api';
import type { AdminAuthContext, AdminAuthPolicy, AdminPermission } from '@telga/domain';
import {
  AdminAccessDeniedError,
  STRICT_ADMIN_AUTH,
  effectivePermissions,
  requireAdmin,
} from '@telga/domain';
import {
  ApplicationWriteError,
  clearAdminMfaSecret,
  listAdminUsers,
  recordApplication,
  decideReversalRequest,
  recordComplaintVerdict,
  revokeAdminSession,
  revokeAllAdminSessions,
  saveAdminUser,
} from '@telga/persistence';
import {
  activityScreen,
  complaintDetailScreen,
  complaintsScreen,
  reversalsScreen,
  issuedPinScreen,
  operatorsScreen,
  providerHealthScreen,
} from './ui/opsScreens';
import { recordAdminAction } from './audit';
import type { AdminAuditInput } from './audit';
import { consoleProvisioningPorts } from './provisioningPorts';
import { CONTENT_SECURITY_POLICY, document } from './ui/page';
import type { ConsoleChrome } from './ui/page';
import {
  adminsScreen,
  applicationDetailScreen,
  applicationsScreen,
  registerShopScreen,
  handoverScreen,
  depositsScreen,
  recordDepositScreen,
  auditScreen,
  dashboardScreen,
  deniedScreen,
  devicesScreen,
  enrollmentTokenScreen,
  merchantsScreen,
  mfaEnrolScreen,
  mfaScreen,
  signInScreen,
  stepUpScreen,
  tenantsScreen,
} from './ui/screens';

/** Everything the console needs from the outside. */
export interface ConsoleOptions {
  /** The platform database — the one holding admins and the tenant registry. */
  readonly db: ConsoleDb;
  readonly now: () => string;
  readonly newId: (prefix: string) => string;
  /** The schema version tenants are expected to be on. */
  readonly schemaVersion: string;
  /** Hosts the console will answer for. Anything else is refused. */
  readonly allowedHosts?: readonly string[];
  /**
   * Sign in with a password alone, and never ask again — [[Decision Log]] D143.
   *
   * **Absent means strict**, which is the only safe default: a deployment that
   * forgets to set this gets a second factor and step-up re-authentication, not
   * the relaxation.
   *
   * Turning it on skips *identity proof* and nothing else. Permissions are
   * unchanged, every action is still audited with the administrator's name, and
   * a banner appears on every page so nobody has to guess which mode a console
   * is running in.
   *
   * **It must be off before real money.** `CLAUDE.md` §8 gate "security and
   * permissions tested" cannot close with this on.
   */
  readonly singleFactorAuth?: boolean;
  /** Set `Secure` on the session cookie. False only for loopback HTTP. */
  readonly secureCookies?: boolean;
  /**
   * Where scanned registration documents are kept, and the key they are
   * encrypted with.
   *
   * **Optional, and its absence is a refusal rather than a fallback.** With no
   * vault configured the console still records registrations by reference
   * number — which is what M1a did — and refuses uploads. It never writes an
   * unencrypted passport because a key was missing, which is exactly how a
   * store of identity documents ends up in the clear on a volume nobody
   * remembers provisioning. See D125 and R37.
   */
  readonly documents?: {
    readonly directory: string;
    readonly encryptionKey: string | undefined;
  };
  /**
   * How a verified deposit is credited to a shop.
   *
   * A port rather than a driver, so the console does not acquire a second
   * opinion about how the ledger works. In production it is `fundMerchant` over
   * the same connection.
   *
   * **Optional, and its absence closes the deposit screens entirely** rather
   * than letting them record a credit that never posted. A `funding_submissions`
   * row saying `CREDITED` when no money moved is worse than no deposit feature:
   * it is a false record of a shop's balance, and every later reconciliation
   * would start from it.
   */
  readonly creditMerchant?: (input: {
    readonly merchantId: string;
    readonly amountMinor: number;
    readonly correlationId: string;
    readonly postingId: string;
    readonly at: string;
  }) => void;
  /** The account shops are told to pay into. Checked against every deposit. */
  readonly depositAccount?: string;
  /** Above this, a second approver is required. Defaults to 50,000 birr. */
  readonly autoCreditCapMinor?: number;
}

type Statement = {
  all: (...args: readonly unknown[]) => unknown[];
  get: (...args: readonly unknown[]) => unknown;
  run: (...args: readonly unknown[]) => unknown;
};
export interface ConsoleDb {
  prepare: (sql: string) => Statement;
}

const SESSION_COOKIE = 'telga_admin_session';
const CSRF_COOKIE = 'telga_admin_csrf';

const parseCookies = (header: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
};

/**
 * The whole body, or `undefined` when it exceeds the cap.
 *
 * Separate from {@link readForm} because a multipart body is bytes, not text:
 * decoding a JPEG as UTF-8 and re-encoding it produces a file of exactly the
 * right length that will not open. The cap is applied while reading, so an
 * oversized upload is abandoned rather than buffered and then rejected.
 */
async function readBody(request: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > limit) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readForm(request: IncomingMessage, limit = 64 * 1024): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    // A console form is a handful of short fields. Anything larger is not one.
    if (size > limit) return {};
    chunks.push(buffer);
  }
  const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  return Object.fromEntries(params.entries());
}

/**
 * Where a step-up may send an admin afterwards.
 *
 * `returnTo` arrives in a form field, so it is attacker-controlled. Redirecting
 * to it unchecked is an open redirect, and this is the worst possible place for
 * one: the admin has just typed their password, so a page that opens straight
 * afterwards saying "that didn't work, sign in again" is extremely convincing.
 * Found by reading the console's own audit trail, which recorded a `returnTo`
 * that was plainly not a console path.
 *
 * Only a path on this console is allowed. Rejected: absolute URLs, anything
 * protocol-relative (`//evil.example`, which a browser resolves off-site), and
 * backslashes, which some browsers normalise to slashes. Anything refused falls
 * back to the dashboard rather than erroring — the admin's step-up succeeded,
 * and the only thing lost is where they land.
 */
export function safeReturnTo(candidate: string | undefined): string {
  if (candidate === undefined || candidate.length === 0) return '/';
  if (!candidate.startsWith('/')) return '/';
  // `//evil.example` and `/\evil.example` are both resolved off-site by a
  // browser, despite starting with a slash.
  if (candidate.includes('\\')) return '/';
  if (candidate.startsWith('//')) return '/';
  // A control character can truncate the header. It has no place in a path.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return '/';
  return candidate;
}

const headers = (secure: boolean) => ({
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': CONTENT_SECURITY_POLICY,
  /**
   * `same-origin`, not `no-referrer` — and the difference was a sign-in bug.
   *
   * `no-referrer` looks like the strictly safer choice and reads that way. It
   * is not, because it does not only strip the `Referer`: when the referrer
   * policy suppresses the referrer entirely, browsers serialise the **`Origin`
   * header of a form POST as the literal `null`**. The console then compared
   * `null` against its allow-list, failed, and answered *"Refused: cross-site
   * request"* — to a form it had served itself, one keystroke earlier, on the
   * same origin.
   *
   * That is why the bug was invisible to every test and every command-line
   * check: `curl` and Node send a real `Origin` and are let straight through.
   * Only a browser submitting the actual form reproduced it.
   *
   * `same-origin` keeps the privacy property that mattered — **no referrer
   * ever leaves this origin**, so no admin URL reaches a third party — while
   * letting a same-origin navigation carry the header the CSRF check depends
   * on. The merchant app carries the same change, for the same reason.
   */
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  // A console page is per-admin and privileged. It must not sit in a cache.
  'cache-control': 'no-store, private',
  ...(secure ? { 'strict-transport-security': 'max-age=31536000' } : {}),
});

const cookie = (name: string, value: string, secure: boolean): string =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;

/**
 * Whether a state-changing request came from the console itself.
 *
 * Checked before the session, because a cross-site request that is going to be
 * refused should be refused without touching the database.
 */
/**
 * `[::1]` and `::1` are the same host written two ways.
 *
 * A URL brackets an IPv6 literal so the colons cannot be read as a port
 * separator; an allow-list, a command-line flag and a loopback check all write
 * it bare. Nothing else is touched — a name or an IPv4 address passes through
 * unchanged.
 */
const unbracket = (host: string): string =>
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

function originOk(request: IncomingMessage, allowedHosts: readonly string[]): boolean {
  const origin = request.headers['origin'];
  if (typeof origin !== 'string') return true; // Same-origin form posts may omit it.

  /**
   * An opaque origin, judged on `Sec-Fetch-Site` instead of being refused flat.
   *
   * A browser sends `Origin: null` in more situations than the obvious one. A
   * sandboxed iframe does — and must stay refused. But so does a plain form
   * POST under a referrer policy that suppresses the referrer, which is what
   * this console used to send, and that is a page refusing a form it served
   * itself. The header above is fixed; this is the belt to that braces, because
   * a redirect, an embedded WebView or a future policy change can produce an
   * opaque origin again and the failure mode is a locked-out administrator.
   *
   * `Sec-Fetch-Site` is set **by the browser** and is unreachable from script,
   * so it cannot be spoofed by the cross-site page this check exists to stop.
   * A cross-site form POST arrives as `cross-site`; a sandboxed iframe on
   * another origin arrives as `cross-site`. Neither is accepted here.
   *
   *   - `same-origin` — the console's own page posting to itself.
   *   - `none` — a user-initiated navigation, typed or bookmarked.
   *
   * Anything else, and any request whose browser did not send the header at
   * all, keeps the old answer: refused. An older client that sends neither a
   * usable `Origin` nor `Sec-Fetch-Site` is exactly the case that should not be
   * given the benefit of the doubt on an admin console.
   */
  if (origin === 'null') {
    const site = request.headers['sec-fetch-site'];
    return site === 'same-origin' || site === 'none';
  }
  try {
    // `hostname`, not `host.split(':')[0]`.
    //
    // The old form split on the port separator, which an IPv6 address is full
    // of: `http://[::1]:4800` has host `[::1]:4800`, and splitting it on `:`
    // yields `"["`. Every request from an IPv6 loopback origin was therefore
    // refused as cross-site — and since `cli.ts` accepts `::1` as a bind host,
    // the console would serve a page it then refused every form post from.
    //
    // Reported from a browser on 2026-09-09: *"Refused: cross-site request"* on
    // sign-in. `hostname` is the parsed host without the port, and it is
    // correct for IPv6 (`::1`), IPv4 and names alike.
    // Brackets stripped from both sides before comparing.
    //
    // `hostname` keeps the brackets an IPv6 literal is written with in a URL —
    // `new URL('http://[::1]:4800').hostname` is `"[::1]"`, not `"::1"` — while
    // an allow-list is written bare, the way `--allowed-hosts ::1` or an
    // `isLoopback` check spells it. Comparing the two forms directly refuses a
    // host that was explicitly allowed, which is the second half of the same
    // bug: fixing the port-splitting alone still left IPv6 broken.
    const host = unbracket(new URL(origin).hostname);
    return allowedHosts.some((allowed) => unbracket(allowed) === host);
  } catch {
    // An unparseable origin, including the literal `null` a browser sends from
    // a sandboxed or redirected context. Refused: the allow-list is the policy
    // (`09 Engineering/TLS and Proxy Configuration` — Telga answers only for
    // the hosts it was told about), and a header that cannot be read is not a
    // host that was allowed.
    return false;
  }
}

export function createConsoleServer(options: ConsoleOptions): Server {
  // `::1` belongs here because `cli.ts`'s `isLoopback` already accepts it as a
  // bind host. Without it the console would bind to IPv6 loopback and then
  // refuse every form posted to it — the two definitions of "this machine" have
  // to agree, or the console serves a page it will not accept input from.
  const allowedHosts = options.allowedHosts ?? ['localhost', '127.0.0.1', '::1'];
  const secure = options.secureCookies ?? false;

  /**
   * The identity policy this console runs under, decided once at construction.
   *
   * Read from the option rather than consulted per request, so it cannot differ
   * between the guard and the screens that decide what to render — a console
   * that hid a button its guard would have allowed, or offered one it would
   * refuse, is worse than either mode on its own.
   */
  const adminPolicy: AdminAuthPolicy =
    options.singleFactorAuth === true
      ? { requireMfa: false, requireStepUp: false }
      : STRICT_ADMIN_AUTH;
  const ports = { db: options.db as never, now: options.now, newId: options.newId };

  /**
   * The document vault, created **once at startup** or not at all.
   *
   * Building it eagerly means a console configured with a missing or malformed
   * key fails here, on the operator's screen, rather than at the first upload —
   * with an admin standing in a shop holding somebody's passport.
   */
  const documentVault =
    options.documents === undefined
      ? undefined
      : createDocumentVault({
          directory: options.documents.directory,
          encryptionKey: options.documents.encryptionKey,
          newId: options.newId,
        });

  const respond = (response: ServerResponse, status: number, body: string, extra: string[] = []): void => {
    response.writeHead(status, {
      ...headers(secure),
      ...(extra.length > 0 ? { 'set-cookie': extra } : {}),
    });
    response.end(body);
  };

  const chromeFor = (context: AdminAuthContext | undefined, csrf: string | undefined): ConsoleChrome => ({
    adminName: context?.user.displayName,
    adminRole: context?.user.role,
    department: context?.user.department,
    csrfToken: csrf,
    serverTime: options.now(),
    mfaSatisfied: context === undefined ? undefined : context.mfaSatisfied,
    singleFactorAuth: options.singleFactorAuth === true,
  });

  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      // An unhandled throw must not leak a stack trace to a browser. The
      // console is the one surface where an internal detail is most useful to
      // an attacker.
      /**
       * Say what went wrong, to the operator's terminal.
       *
       * The browser gets "Something went wrong." and nothing more — this is the
       * one surface where an internal detail is most useful to an attacker. But
       * a 500 with no trace anywhere costs an hour: this exact handler swallowed
       * a `no such column: revoked_reason` while the operator screen showed
       * only a polite refusal, and the same shape of blindness is what
       * `TELGA_DB_PATH is not set` and the cross-site refusal both had to be
       * fixed for. To stderr, where whoever started the console can see it.
       */
      process.stderr.write(`[telga-console] unhandled: ${String(error)}
`);
      respond(response, 500, document(deniedScreen({ serverTime: options.now() }, 'Something went wrong.'), 'Error'));
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://console.local');
    const path = url.pathname;
    const method = request.method ?? 'GET';
    const cookies = parseCookies(request.headers['cookie']);
    const csrf = cookies[CSRF_COOKIE];

    // One correlation id per request, so the several events a single action
    // produces can be read back as one action rather than as scattered lines.
    const correlationId = options.newId('req');
    const record = (input: Omit<AdminAuditInput, 'correlationId'>): void =>
      recordAdminAction(options.db, options.newId, options.now, { ...input, correlationId });

    if (method !== 'GET' && !originOk(request, allowedHosts)) {
      /**
       * Say what was refused, to the operator's terminal.
       *
       * [[Decision Log]] **D116**: *"what found it was not a better theory but
       * a better failure message."* Three rounds of diagnosis went into a
       * browser reporting "cross-site request" with no way to tell which origin
       * had been rejected or what the console was willing to accept — the same
       * shape of blindness as `TELGA_DB_PATH is not set`, and fixed the same
       * way.
       *
       * **To stderr, not to the page.** The origin is attacker-controlled, and
       * the refusal screen is the wrong place to reflect input. The operator
       * running the console sees this in the terminal they started it from,
       * which is exactly who needs it.
       */
      const refused = request.headers['origin'];
      process.stderr.write(
        `[telga-console] refused a ${method} to ${path}: Origin ` +
          `${typeof refused === 'string' ? JSON.stringify(refused) : '(absent)'} ` +
          `is not one of [${allowedHosts.join(', ')}]. ` +
          'Start the console with --allowed-hosts to add it.\n',
      );
      respond(response, 403, document(deniedScreen(chromeFor(undefined, csrf), 'Refused: cross-site request.'), 'Refused'));
      return;
    }

    /**
     * Liveness, for a platform health check.
     *
     * Public and unauthenticated, because a health check has no session — and
     * therefore it says as little as possible. `ok`, the mode, and whether the
     * database answers. **No version, no schema number, no counts, no admin
     * names**: this is the one endpoint reachable without signing in, and every
     * field on it is a field an attacker gets for free.
     *
     * It reports `degraded` rather than lying when the database will not
     * answer. A health check that returns `ok` while the console cannot read
     * anything is worse than none — the platform keeps the container in
     * rotation and nobody is told.
     */
    if (path === '/api/health/ready') {
      // `09 Engineering/Health Endpoints`: the route table registers GET only,
      // and anything else is refused rather than answered. A health check that
      // could be POSTed is a health check that could be made to do something.
      if (method !== 'GET') {
        response.writeHead(405, { allow: 'GET', 'cache-control': 'no-store' });
        response.end();
        return;
      }

      let databaseOk = true;
      try {
        options.db.prepare('SELECT 1 AS ok').get();
      } catch {
        databaseOk = false;
      }

      // The same header set as the rest of the training HTTP surface, and a
      // **stable reason code** rather than an exception message — the vault is
      // explicit that a failure must never carry a raw database error or a file
      // path, because this is the one route reachable without signing in.
      response.writeHead(databaseOk ? 200 : 503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'same-origin',
      });
      response.end(
        JSON.stringify({
          status: databaseOk ? 'ok' : 'degraded',
          service: 'operations-console',
          mode: 'TRAINING',
          ...(databaseOk ? {} : { reasonCode: 'DATABASE_UNREACHABLE' }),
        }),
      );
      return;
    }

    // --- sign in, the only public routes ---------------------------------
    if (path === '/login' && method === 'GET') {
      respond(response, 200, document(signInScreen(chromeFor(undefined, csrf), url.searchParams.get('error') ?? undefined), 'Sign in'));
      return;
    }

    if (path === '/login' && method === 'POST') {
      const form = await readForm(request);
      const result = await adminLogin(ports, {
        email: form['email'] ?? '',
        password: form['password'] ?? '',
      });
      if (result.kind === 'REFUSED') {
        record({
          event: 'ADMIN_SIGN_IN_REFUSED',
          // No admin id: refusing an unknown email must not confirm it exists,
          // and the trail should not record one either.
          actorId: 'unknown',
          actorRole: 'ANONYMOUS',
          entityType: 'ADMIN_SESSION',
          metadata: { reason: result.reason },
        });
        // One message for every failure. Which of the three it was goes to the
        // audit trail, not to the browser.
        //
        // A single `writeHead`. An earlier version called `respond` and then
        // wrote the head again, which throws mid-response and drops the socket
        // — the browser saw a connection reset instead of a refusal. Found by
        // signing in with a wrong password against the running console.
        response.writeHead(303, { location: '/login?error=Sign+in+refused.' });
        response.end();
        return;
      }
      record({
        event: 'ADMIN_SIGNED_IN',
        actorId: result.user.id,
        actorRole: result.user.role,
        entityType: 'ADMIN_SESSION',
        entityId: result.user.id,
        // The password is cleared but the session can still do nothing.
        metadata: { mfaSatisfied: result.mfaSatisfied },
      });
      response.writeHead(303, {
        // Straight to the dashboard under single-factor (D143). Sending an
        // administrator to a second-factor page that nothing is waiting on
        // would be the same complaint in a different place: the session already
        // has every permission its role grants.
        location: adminPolicy.requireMfa === false ? '/' : '/mfa',
        'set-cookie': [
          cookie(SESSION_COOKIE, result.sessionToken, secure),
          cookie(CSRF_COOKIE, result.csrfToken, secure),
        ],
      });
      response.end();
      return;
    }

    // --- everything below needs a session --------------------------------
    const auth = authenticateAdmin(ports, cookies[SESSION_COOKIE]);
    if (!auth.ok) {
      response.writeHead(303, { location: '/login' });
      response.end();
      return;
    }
    const context = auth.context;

    if (path === '/logout' && method === 'POST') {
      revokeAdminSession(options.db as never, auth.sessionId, options.now(), 'SIGNED_OUT');
      record({
        event: 'ADMIN_SIGNED_OUT',
        actorId: context.user.id,
        actorRole: context.user.role,
        entityType: 'ADMIN_SESSION',
        entityId: context.user.id,
      });
      response.writeHead(303, { location: '/login' });
      response.end();
      return;
    }

    // --- the second factor, before anything else -------------------------
    const screen = (body: ReturnType<typeof dashboardScreen>, title: string): void =>
      respond(response, 200, document(body, title));

    // --- enrolling a second factor ---------------------------------------
    //
    // The one thing a password-only session may do. An admin has to be able to
    // sign in once in order to set one up, and after that this route is closed
    // to them because they already have a secret.
    if (path === '/mfa/enrol') {
      if (context.user.mfaEnrolled) {
        response.writeHead(303, { location: '/mfa' });
        response.end();
        return;
      }
      const enrolment = beginMfaEnrolment(ports, context.user.id, context.user.email);
      record({
        event: 'ADMIN_MFA_ENROLLED',
        actorId: context.user.id,
        actorRole: context.user.role,
        entityType: 'ADMIN_USER',
        entityId: context.user.id,
        // The secret itself is never recorded. That an enrolment happened, and
        // when, is the part an investigation needs.
      });
      screen(mfaEnrolScreen(chromeFor(context, csrf), enrolment), 'Set up your authenticator');
      return;
    }

    if (path === '/mfa') {
      if (method === 'POST') {
        const form = await readForm(request);
        const ok = await satisfyAdminMfa(ports, auth.sessionId, context.user.id, form['code'] ?? '');
        record({
          event: ok ? 'ADMIN_MFA_CONFIRMED' : 'ADMIN_MFA_REFUSED',
          actorId: context.user.id,
          actorRole: context.user.role,
          entityType: 'ADMIN_SESSION',
          entityId: context.user.id,
          // The code is not recorded — a refused code is one digit from a
          // working one, and the trail is readable by more people than the
          // admin it belongs to.
          metadata: { enrolled: context.user.mfaEnrolled },
        });
        if (ok) {
          response.writeHead(303, { location: '/' });
          response.end();
          return;
        }
        respond(
          response,
          200,
          document(
            mfaScreen(
              chromeFor(context, csrf),
              context.user.mfaEnrolled
                ? 'That code was not right. Codes change every 30 seconds — check your device clock.'
                : 'No authenticator is set up for this account yet.',
              context.user.mfaEnrolled,
            ),
            'Confirm',
          ),
        );
        return;
      }
      // No code is shown. It is derived on the admin's own device from the
      // secret shared once at enrolment — there is nothing here to display.
      respond(
        response,
        200,
        document(mfaScreen(chromeFor(context, csrf), undefined, context.user.mfaEnrolled), 'Confirm'),
      );
      return;
    }

    /**
     * The second-factor gate.
     *
     * Skipped entirely under single-factor (D143). Not "satisfied by default" —
     * **skipped**, so `mfa_satisfied` on the session stays false and the audit
     * trail never records a second factor that was not presented. The console
     * says which mode it is in on every page, so nobody has to infer it.
     */
    if (adminPolicy.requireMfa !== false && !context.mfaSatisfied) {
      response.writeHead(303, { location: '/mfa' });
      response.end();
      return;
    }

    if (path === '/step-up' && method === 'POST') {
      const form = await readForm(request);
      const ok = await stepUpAdmin(ports, auth.sessionId, context.user.id, form['password'] ?? '');
      const destination = safeReturnTo(form['returnTo']);
      record({
        event: ok ? 'ADMIN_STEPPED_UP' : 'ADMIN_STEP_UP_REFUSED',
        actorId: context.user.id,
        actorRole: context.user.role,
        entityType: 'ADMIN_SESSION',
        entityId: context.user.id,
        // What the admin was trying to reach. A refused step-up against a
        // high-risk route is the shape of a borrowed session.
        metadata: { returnTo: destination },
      });
      response.writeHead(303, { location: ok ? destination : '/step-up?error=1' });
      response.end();
      return;
    }

    if (path === '/step-up' && method === 'GET') {
      respond(
        response,
        200,
        document(
          stepUpScreen(
            chromeFor(context, csrf),
            url.searchParams.get('for') ?? '/',
            url.searchParams.has('error') ? 'That password was not right.' : undefined,
          ),
          'Confirm',
        ),
      );
      return;
    }

    const allowed = {
      has: (permission: AdminPermission): boolean =>
        effectivePermissions(context.user).includes(permission),
    };

    /** Refuse unless permitted, turning a step-up into a redirect rather than an error. */
    const guard = (permission: AdminPermission): boolean => {
      try {
        requireAdmin(context, permission, options.now() as never, adminPolicy);
        return true;
      } catch (error) {
        if (error instanceof AdminAccessDeniedError && error.reason === 'STEP_UP_REQUIRED') {
          response.writeHead(303, { location: `/step-up?for=${encodeURIComponent(path)}` });
          response.end();
          return false;
        }
        respond(
          response,
          403,
          document(chromeFor(context, csrf) && deniedScreen(chromeFor(context, csrf), 'You do not have permission for that.'), 'Not permitted'),
        );
        return false;
      }
    };

    // --- screens ----------------------------------------------------------
    if (path === '/') {
      if (!guard('ADMIN_VIEW_MERCHANT')) return;
      screen(dashboardScreen(chromeFor(context, csrf), counts()), 'Dashboard');
      return;
    }

    if (path === '/applications' && method === 'GET') {
      if (!guard('ADMIN_VIEW_MERCHANT')) return;
      screen(applicationsScreen(chromeFor(context, csrf), applications(), allowed), 'Applications');
      return;
    }

    // Must be tested before `/applications/:id`, or "new" is read as an id and
    // answers "no such application".
    if (path === '/applications/new' && method === 'GET') {
      if (!guard('ADMIN_REVIEW_APPLICATION')) return;
      screen(registerShopScreen({ chrome: chromeFor(context, csrf) }), 'Register Telga User');
      return;
    }

    /**
     * Record a registration an admin took at a shop.
     *
     * Creates an **application**, and nothing else: no merchant, no operator, no
     * device, no credentials. `Admin Operations Console` Decision 3 — *"no
     * account until approved"* — so there is nothing here for an unvetted
     * applicant to attack, rather than a locked account guarded on every route.
     *
     * Approving is what creates a shop, and that path already exists (D120).
     */
    if (path === '/applications' && method === 'POST') {
      if (!guard('ADMIN_REVIEW_APPLICATION')) return;

      // The form posts `multipart/form-data` when it carries scans and
      // urlencoded when it does not, so both are accepted. A body cap sized for
      // three documents plus the text fields is applied before a byte is
      // parsed — a parser with no bound in front of it is a way to exhaust
      // memory from a socket.
      const boundary = boundaryOf(request.headers['content-type']);
      let form: Record<string, string>;
      let uploads: readonly MultipartFile[] = [];
      if (boundary === undefined) {
        form = await readForm(request);
      } else {
        const raw = await readBody(request, 3 * MAX_DOCUMENT_BYTES + 64 * 1024);
        if (raw === undefined) {
          screen(
            registerShopScreen({ chrome: chromeFor(context, csrf), error: 'UPLOAD_TOO_LARGE' }),
            'Register Telga User',
          );
          return;
        }
        try {
          const parsed = parseMultipart(raw, boundary);
          form = parsed.fields;
          uploads = parsed.files;
        } catch {
          screen(
            registerShopScreen({ chrome: chromeFor(context, csrf), error: 'UPLOAD_NOT_READABLE' }),
            'Register Telga User',
          );
          return;
        }
      }

      // Refused before anything is written, so a registration is never recorded
      // with its documents silently dropped.
      if (uploads.length > 0) {
        if (documentVault === undefined) {
          screen(
            registerShopScreen({
              chrome: chromeFor(context, csrf),
              error: 'DOCUMENT_STORE_NOT_CONFIGURED',
              values: form,
            }),
            'Register Telga User',
          );
          return;
        }
        const badType = uploads.find((file) => !isAllowedMediaType(file.mediaType));
        if (badType !== undefined) {
          screen(
            registerShopScreen({
              chrome: chromeFor(context, csrf),
              error: 'DOCUMENT_TYPE_NOT_ALLOWED',
              values: form,
            }),
            'Register Telga User',
          );
          return;
        }
      }

      const at = options.now();

      const submission = {
        legalName: form['legalName'] ?? '',
        ownerName: form['ownerName'] ?? '',
        phone: form['phone'] ?? '',
        email: form['email'] ?? '',
        address: form['address'] ?? '',
        locality: form['locality'] ?? '',
        entityType: 'SOLE_TRADER' as const,
        documents: [
          {
            kind: 'TRADE_LICENCE' as const,
            reference: form['tradeLicence'] ?? '',
            // A bare date from a `type="date"` input. Compared against `now`,
            // which is an ISO timestamp, so it is widened to one — a licence
            // expiring today has not expired yet.
            expiresAt:
              (form['tradeLicenceExpiry'] ?? '').length > 0
                ? `${form['tradeLicenceExpiry'] ?? ''}T23:59:59.999Z`
                : '',
          },
          { kind: 'TIN_CERTIFICATE' as const, reference: form['tin'] ?? '' },
          { kind: 'OWNER_PHOTO_ID' as const, reference: form['photoId'] ?? '' },
        ],
      };

      const rejection = submissionRejection(submission, at);
      if (rejection !== undefined) {
        // The form comes back filled in. An admin standing at a counter with a
        // folder should fix one field, not retype seven.
        screen(
          registerShopScreen({
            chrome: chromeFor(context, csrf),
            error: rejection,
            values: form,
          }),
          'Register Telga User',
        );
        return;
      }

      const applicationId = options.newId('app');
      const reference = newSubmissionReference();

      /**
       * One transaction, through the **shared** recorder.
       *
       * This used to be ~70 lines of inline SQL here, and its own comment
       * recorded what happened when the write was not atomic: the application
       * row was written first and the documents after it, so a document that
       * collided on the unique `(kind, reference)` index left the application
       * behind — *a shop in the review queue with no papers, created by the
       * very check meant to refuse it.*
       *
       * D138 added a second caller — the app's own *Register as Telga member* — and
       * two hand-written copies of an intake write is how the two drift: one
       * gains a validation the other does not, one wraps its documents in the
       * transaction and the other does not, and the difference is found by a
       * shop whose papers vanished. So the SQL moved to
       * `@telga/persistence`'s `recordApplication` and both callers pass
       * through it. The encryption still happens **inside** the transaction —
       * that is what `resolve` is for.
       */
      const fileFor: Readonly<Record<string, string>> = {
        TRADE_LICENCE: 'tradeLicenceFile',
        TIN_CERTIFICATE: 'tinFile',
        OWNER_PHOTO_ID: 'photoIdFile',
      };

      try {
        recordApplication(options.db as never, {
          id: applicationId,
          reference,
          // An admin recorded this from documents a shop brought in, so a
          // reviewer may assume somebody saw the originals. A self-service
          // submission carries `SELF_SERVICE` and no such assumption.
          submittedVia: 'ADMIN',
          legalName: submission.legalName,
          ownerName: submission.ownerName,
          phone: submission.phone,
          email: submission.email,
          address: submission.address,
          locality: submission.locality,
          at,
          documents: submission.documents.map((document) => ({
            id: options.newId('doc'),
            kind: document.kind,
            reference: document.reference,
            ...((document.expiresAt ?? '').length > 0
              ? { expiresAt: document.expiresAt as string }
              : {}),
            resolve: () => {
              const upload = uploads.find((file) => file.name === fileFor[document.kind]);
              if (upload === undefined || documentVault === undefined) return undefined;
              return documentVault.store({
                content: upload.content,
                mediaType: upload.mediaType,
              });
            },
          })),
        });
      } catch (error) {
        // The unique index on (kind, reference) is the one that fires here: a
        // licence or TIN already registered to another shop. That is a finding,
        // not a validation error — one person opening shops under several names
        // is exactly what it was added to catch.
        const refusal =
          error instanceof ApplicationWriteError ? error.refusal : 'REGISTRATION_NOT_SAVED';
        screen(
          registerShopScreen({
            chrome: chromeFor(context, csrf),
            error: refusal,
            values: form,
          }),
          'Register Telga User',
        );
        return;
      }

      record({
        event: 'ADMIN_APPLICATION_RECORDED',
        actorId: context.user.id,
        actorRole: context.user.role,
        entityType: 'MERCHANT_APPLICATION',
        entityId: applicationId,
        // The reference and the shop, never a document number: an audit trail
        // that carries identity-document numbers turns every reader of the
        // audit screen into a holder of them.
        metadata: { reference, locality: submission.locality.trim() },
      });

      /**
       * **Path B**: admin creation is the approval. D138.
       *
       * Runs the same two steps the review screen runs — record the decision,
       * then provision — rather than a second creation path. A shop created
       * here and a shop approved from the queue must be the same shop, with the
       * same audit trail and the same tenant row; two ways of making one would
       * be two things to keep in step.
       *
       * `ADMIN_APPROVE_MERCHANT` is checked **now**, separately from the
       * `ADMIN_REVIEW_APPLICATION` that let the form be posted. An admin who
       * may record a registration but not approve one gets the application
       * recorded and the approval refused — which is the correct outcome, and
       * the reason this is not folded into the guard at the top.
       */
      const approveNow = (form['approveNow'] ?? '').length > 0;
      if (approveNow) {
        if (!guard('ADMIN_APPROVE_MERCHANT')) return;
        const found = applicationById(applicationId);
        if (found !== undefined) {
          options.db
            .prepare(
              `UPDATE merchant_applications
                  SET status = 'APPROVED', decision_reason = ?, reviewed_by = ?,
                      reviewed_at = ?, updated_at = ?
                WHERE id = ?`,
            )
            .run(
              'Registered and approved at the counter by the recording admin.',
              context.user.id,
              at,
              at,
              applicationId,
            );
          record({
            event: 'ADMIN_APPLICATION_DECIDED',
            actorId: context.user.id,
            actorRole: context.user.role,
            entityType: 'MERCHANT_APPLICATION',
            entityId: applicationId,
            // `path: 'DIRECT'` is what distinguishes this in the trail from an
            // approval that went through the queue. Both are approvals; only
            // one had a second pair of eyes, and the trail must say which.
            metadata: { outcome: 'APPROVE', status: 'APPROVED', path: 'DIRECT' },
          });
          try {
            const result = provisionMerchant(
              consoleProvisioningPorts({
                db: options.db,
                now: options.now,
                schemaVersion: options.schemaVersion,
              }),
              { ...found, status: 'APPROVED' },
            );
            record({
              event: 'ADMIN_MERCHANT_PROVISIONED',
              actorId: context.user.id,
              actorRole: context.user.role,
              entityType: 'MERCHANT',
              entityId: result.merchantId,
              metadata: {
                applicationId,
                databaseName: result.databaseName,
                schemaVersion: result.schemaVersion,
              },
            });
          } catch {
            // As on the review path: a refusal is not a crash. The approval
            // stands and is auditable, and the application screen shows where
            // provisioning stopped.
            response.writeHead(303, {
              location: `/applications/${encodeURIComponent(applicationId)}?error=PROVISIONING_FAILED`,
            });
            response.end();
            return;
          }
        }
      }

      response.writeHead(303, { location: `/applications/${encodeURIComponent(applicationId)}` });
      response.end();
      return;
    }

    /**
     * Look at a scanned identity document.
     *
     * **R37's other half.** The vault encrypts; this decides who may open one
     * and makes sure the opening is answerable.
     *
     * ## Why `ADMIN_EXPORT_DATA` and not `ADMIN_REVIEW_APPLICATION`
     *
     * Reading the queue and taking a copy of somebody's passport are different
     * acts, and the second one **is** a data export. Using the export permission
     * says so, keeps the reviewing role narrow, and brings **step-up
     * re-authentication** with it for free — `STEP_UP_REQUIRED` already lists
     * it, so the password must have been typed *now* rather than at the start of
     * a shift. That is the difference between an authorised person and an
     * unattended laptop, and inventing a second step-up check here would have
     * duplicated the window logic that `requireAdmin` already owns.
     *
     * The audit event is written **before** the bytes are sent, so a read that
     * happened is recorded even if the response never completes. The media type
     * comes from the row and is bound into the decryption, so a document re-filed
     * in the database as another type does not open.
     */
    const documentMatch = /^\/applications\/([^/]+)\/documents\/([^/]+)$/.exec(path);
    if (documentMatch && method === 'GET') {
      if (!guard('ADMIN_EXPORT_DATA')) return;

      const applicationId = decodeURIComponent(documentMatch[1]);
      const documentId = decodeURIComponent(documentMatch[2]);
      const row = options.db
        .prepare(
          `SELECT id, kind, document_uri, media_type FROM merchant_application_documents
            WHERE id = ? AND application_id = ?`,
        )
        .get(documentId, applicationId) as
        | { id: string; kind: string; document_uri: string | null; media_type: string | null }
        | undefined;

      // A document belonging to another application answers exactly as a
      // missing one does: the id is scoped, so this cannot be used to walk the
      // store.
      if (row === undefined || row.document_uri === null || row.media_type === null) {
        respond(response, 404, document(deniedScreen(chromeFor(context, csrf), 'No such document.'), 'Not found'));
        return;
      }
      if (documentVault === undefined) {
        respond(response, 404, document(deniedScreen(chromeFor(context, csrf), 'No such document.'), 'Not found'));
        return;
      }

      record({
        event: 'ADMIN_DOCUMENT_VIEWED',
        actorId: context.user.id,
        actorRole: context.user.role,
        entityType: 'MERCHANT_APPLICATION_DOCUMENT',
        entityId: documentId,
        // Which kind of document, and whose application. Never the reference
        // number — an audit trail carrying passport numbers turns every reader
        // of the audit screen into a holder of them.
        metadata: { applicationId, kind: row.kind },
      });

      let plaintext: Buffer;
      try {
        plaintext = documentVault.read(row.document_uri, row.media_type as DocumentMediaType);
      } catch {
        // The tag failed: the file was altered, the key changed, or the row was
        // re-filed as another type. None of those should render as an image.
        respond(response, 409, document(deniedScreen(chromeFor(context, csrf), 'This document could not be opened. It may have been altered.'), 'Unreadable'));
        return;
      }

      response.writeHead(200, {
        'content-type': row.media_type,
        // Never rendered inline and never cached: a passport left in a browser
        // cache on a shared laptop outlives the session that opened it.
        'content-disposition': `attachment; filename="${row.kind.toLowerCase()}"`,
        'cache-control': 'no-store, private',
        'content-security-policy': "default-src 'none'; sandbox",
        'x-content-type-options': 'nosniff',
      });
      response.end(plaintext);
      return;
    }

    const applicationMatch = /^\/applications\/([^/]+)$/.exec(path);
    if (applicationMatch && method === 'GET') {
      if (!guard('ADMIN_REVIEW_APPLICATION')) return;
      const found = applicationById(decodeURIComponent(applicationMatch[1]));
      if (found === undefined) {
        respond(response, 404, document(deniedScreen(chromeFor(context, csrf), 'No such application.'), 'Not found'));
        return;
      }
      /**
       * The paperwork, assessed, alongside the application.
       *
       * This screen rendered **no documents at all** — a reviewer approved a
       * shop without seeing whether it had supplied a licence, a TIN or an ID,
       * or whether any were in date. The rows existed the whole time.
       *
       * Read here rather than in `applicationById`, because the queue does not
       * need them: one screen wanting more is not a reason to make every list
       * pay for it.
       */
      const supplied = rows<{
        id: string;
        kind: string;
        reference: string;
        expires_at: string | null;
        document_uri: string | null;
      }>(
        `SELECT id, kind, reference, expires_at, document_uri
           FROM merchant_application_documents WHERE application_id = ?`,
        found.id,
      );

      const readiness = assessRegistration(
        supplied.map((d) => ({
          id: d.id,
          kind: d.kind,
          reference: d.reference,
          expiresAt: d.expires_at,
          documentUri: d.document_uri,
        })),
        options.now(),
      );

      screen(
        applicationDetailScreen(
          chromeFor(context, csrf),
          {
            ...found,
            readiness: {
              verdict: readiness.verdict,
              reasons: readiness.reasons,
              documents: readiness.documents.map((d) => ({
                kind: d.kind,
                label: labelFor(d.kind),
                required: d.required,
                state: d.state,
                reference: d.reference,
                expiresAt: d.expiresAt,
                daysToExpiry: d.daysToExpiry,
                documentId: d.documentId,
              })),
            },
          },
          allowed,
          url.searchParams.get('error') ?? undefined,
        ),
        'Application',
      );
      return;
    }

    const pickUpMatch = /^\/applications\/([^/]+)\/pick-up$/.exec(path);
    if (pickUpMatch && method === 'POST') {
      if (!guard('ADMIN_REVIEW_APPLICATION')) return;
      const id = decodeURIComponent(pickUpMatch[1]);
      options.db
        .prepare(
          `UPDATE merchant_applications
              SET status = 'UNDER_REVIEW', reviewed_by = ?, updated_at = ?
            WHERE id = ? AND status = 'SUBMITTED'`,
        )
        .run(context.user.id, options.now(), id);
      record({
        event: 'ADMIN_APPLICATION_PICKED_UP',
        actorId: context.user.id,
        actorRole: context.user.role,
        entityType: 'MERCHANT_APPLICATION',
        entityId: id,
      });
      response.writeHead(303, { location: `/applications/${encodeURIComponent(id)}` });
      response.end();
      return;
    }

    const decideMatch = /^\/applications\/([^/]+)\/decide$/.exec(path);
    if (decideMatch && method === 'POST') {
      if (!guard('ADMIN_APPROVE_MERCHANT')) return;
      const id = decodeURIComponent(decideMatch[1]);
      const form = await readForm(request);
      const found = applicationById(id);
      if (found === undefined) {
        respond(response, 404, document(deniedScreen(chromeFor(context, csrf), 'No such application.'), 'Not found'));
        return;
      }
      const decision = {
        outcome: (form['outcome'] ?? 'REJECT') as 'APPROVE' | 'REJECT' | 'RETURN_FOR_CORRECTION',
        reason: form['reason'] ?? '',
        reviewedBy: context.user.id,
      };
      const refusal = reviewRefusal(found.status as never, decision);
      if (refusal !== undefined) {
        response.writeHead(303, {
          location: `/applications/${encodeURIComponent(id)}?error=${encodeURIComponent(refusal)}`,
        });
        response.end();
        return;
      }
      const next = statusAfterReview(decision);
      options.db
        .prepare(
          `UPDATE merchant_applications
              SET status = ?, decision_reason = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(next, decision.reason, context.user.id, options.now(), options.now(), id);
      record({
        event: 'ADMIN_APPLICATION_DECIDED',
        actorId: context.user.id,
        actorRole: context.user.role,
        entityType: 'MERCHANT_APPLICATION',
        entityId: id,
        // The outcome and the status it produced. The reason is free text a
        // merchant may see, so it stays on the application, not in the trail.
        metadata: { outcome: decision.outcome, status: next, from: found.status },
      });

      // Approval used to end here, which meant an `APPROVED` application and a
      // shop that could trade were unrelated facts — somebody had to run a CLI
      // by hand, and nothing said so. Provisioning now runs in the same request,
      // so the decision and its consequence cannot drift apart.
      //
      // It runs *after* the decision is recorded, deliberately: if provisioning
      // fails, the approval still stands and is auditable, and the tenant row is
      // left `FAILED` for an operator to see. The reverse order would risk a
      // provisioned shop with no record of who approved it.
      if (next === 'APPROVED') {
        try {
          const result = provisionMerchant(
            consoleProvisioningPorts({
              db: options.db,
              now: options.now,
              schemaVersion: options.schemaVersion,
            }),
            // `found` still carries the status the row had *before* the update.
            // `provisionMerchant` refuses anything but APPROVED/PROVISIONING, so
            // it is given the status the row now has rather than the stale one.
            { ...found, status: next },
          );
          record({
            event: 'ADMIN_MERCHANT_PROVISIONED',
            actorId: context.user.id,
            actorRole: context.user.role,
            entityType: 'MERCHANT',
            entityId: result.merchantId,
            metadata: {
              applicationId: id,
              databaseName: result.databaseName,
              schemaVersion: result.schemaVersion,
            },
          });
        } catch (error) {
          // A refusal is not a crash. `ALREADY_PROVISIONED` in particular means
          // the shop exists — which is what was wanted — and the operator needs
          // to be told which of the five refusals happened rather than seeing a
          // 500 with no explanation.
          const refusal = error instanceof ProvisioningError ? error.refusal : 'DATABASE_FAILED';
          record({
            event: 'ADMIN_MERCHANT_PROVISION_REFUSED',
            actorId: context.user.id,
            actorRole: context.user.role,
            entityType: 'MERCHANT_APPLICATION',
            entityId: id,
            metadata: { refusal },
          });
          response.writeHead(303, {
            location: `/applications/${encodeURIComponent(id)}?error=${encodeURIComponent(refusal)}`,
          });
          response.end();
          return;
        }
      }

      response.writeHead(303, { location: `/applications/${encodeURIComponent(id)}` });
      response.end();
      return;
    }

    /**
     * Issue the four sign-in parameters for a provisioned shop.
     *
     * The founder's Steps 5 and 6. A `POST` because it is the only screen that
     * displays a secret: a `GET` would put a device key in browser history and
     * bring it back on a press of the back button.
     *
     * `ADMIN_REGISTER_DEVICE` carries step-up with it (`STEP_UP_REQUIRED`), so
     * the password was typed *now* — creating a device that can trade for a
     * shop's money is not something an unattended laptop should be able to do.
     *
     * **Repeatable on purpose.** A shop that has lost its device key needs new
     * parameters, not a new shop. Each issue creates a fresh operator and device
     * rather than overwriting: the ledger references devices, and rewriting one
     * would re-point history at a machine that did not make it.
     */
    const issueMatch = /^\/merchants\/([^/]+)\/credentials$/.exec(path);
    if (issueMatch && method === 'POST') {
      if (!guard('ADMIN_REGISTER_DEVICE')) return;
      const merchantId = decodeURIComponent(issueMatch[1]);

      const merchant = options.db
        .prepare(`SELECT id FROM merchants WHERE id = ?`)
        .get(merchantId) as { id: string } | undefined;
      if (merchant === undefined) {
        respond(response, 404, document(deniedScreen(chromeFor(context, csrf), 'No such merchant.'), 'Not found'));
        return;
      }

      // One transaction: an operator with no device, or a device with no
      // enrolment, is a shop that looks provisioned and cannot sign in.
      options.db.prepare('BEGIN').run();
      let issued;
      try {
        issued = await issueCredentials(
          {
            now: options.now,
            highestNumberFor: (prefix) => {
              const row = options.db
                .prepare(
                  prefix === 'operator'
                    ? `SELECT MAX(CAST(SUBSTR(id, 10) AS INTEGER)) AS n FROM merchant_users WHERE id LIKE 'operator_%'`
                    : `SELECT MAX(CAST(SUBSTR(id, 8) AS INTEGER)) AS n FROM devices WHERE id LIKE 'device_%'`,
                )
                .get() as { n: number | null } | undefined;
              return row?.n ?? 0;
            },
            saveDevice: (input) => {
              options.db
                .prepare(
                  `INSERT INTO devices (id, merchant_id, status, device_type, created_at, updated_at)
                   VALUES (?, ?, 'ACTIVE', 'SMART_POS', ?, ?)`,
                )
                .run(input.id, input.merchantId, input.at, input.at);
            },
            saveEnrolment: (input) => {
              options.db
                .prepare(
                  `INSERT INTO device_enrollments
                     (device_id, merchant_id, enrollment_state, secret_hash, secret_salt,
                      deposit_lookup, enrolled_at, created_at, updated_at)
                   VALUES (?, ?, 'ENROLLED', ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                  input.deviceId,
                  input.merchantId,
                  input.secretHash,
                  input.secretSalt,
                  input.depositLookup,
                  input.at,
                  input.at,
                  input.at,
                );
            },
            saveOperator: (input) => {
              // `must_change_pin = 1`: a PIN Telga staff have read out is a
              // shared secret, not the shop's credential. Migration 015.
              options.db
                .prepare(
                  `INSERT INTO merchant_users
                     (id, merchant_id, display_name, role, pin_hash, pin_salt, pin_params,
                      status, failed_attempts, locked_until, last_login_at, mode,
                      must_change_pin, created_at, updated_at)
                   VALUES (?, ?, ?, 'MERCHANT_OWNER', ?, ?, ?, 'ACTIVE', 0, NULL, NULL,
                           'TRAINING', 1, ?, ?)`,
                )
                .run(
                  input.id,
                  input.merchantId,
                  input.displayName,
                  input.pinHash,
                  input.pinSalt,
                  input.pinParams,
                  input.at,
                  input.at,
                );
            },
          },
          { merchantId: merchantId as never },
        );

        /**
         * The shop starts trading here.
         *
         * `provisioningPorts.ts` creates the merchant as **ONBOARDING** — the
         * shop exists and cannot yet sell — and until now *nothing moved it
         * on*. Combined with the sign-in check added the same day (a merchant
         * that is not ACTIVE is refused), a freshly registered shop could
         * **never sign in**: register, approve, issue parameters, and the first
         * sign-in is refused with no explanation the operator could act on.
         *
         * Found by `tests/e2e/shop-onboarding-chain.test.ts`, which walks the
         * whole chain rather than each link. Every unit along it passed.
         *
         * **Issuing credentials is the right moment**, not approval: this is
         * where the shop gets an operator, a device and a key, which is
         * precisely what it needs to trade. A shop made ACTIVE at approval
         * would be a shop with nothing to sign in with.
         *
         * **Inside the same transaction**, so a shop is never left holding
         * credentials it cannot use, nor marked active with none.
         *
         * `WHERE status = 'ONBOARDING'` so re-issuing credentials to a
         * **suspended** shop does not quietly reinstate it — reinstating is a
         * deliberate act with its own control and its own audit event.
         */
        options.db
          .prepare(
            `UPDATE merchants SET status = 'ACTIVE', updated_at = ?
              WHERE id = ? AND status = 'ONBOARDING'`,
          )
          .run(options.now(), merchantId);

        options.db.prepare('COMMIT').run();
      } catch {
        options.db.prepare('ROLLBACK').run();
        respond(response, 500, document(deniedScreen(chromeFor(context, csrf), 'The sign-in parameters could not be created. Nothing was changed.'), 'Not issued'));
        return;
      }

      record({
        event: 'ADMIN_CREDENTIALS_ISSUED',
        actorId: context.user.id,
        actorRole: context.user.role,
        entityType: 'MERCHANT',
        entityId: merchantId,
        merchantId,
        // The identifiers, which are not secrets. **Never the key or the PIN** —
        // those exist in the response about to be rendered and nowhere else.
        metadata: { operatorId: issued.operatorId, deviceId: issued.deviceId },
      });

      screen(
        handoverScreen({
          chrome: chromeFor(context, csrf),
          merchantId,
          operatorId: issued.operatorId,
          deviceId: issued.deviceId,
          deviceKey: issued.deviceKey,
          temporaryPin: issued.temporaryPin,
        }),
        'Sign-in parameters',
      );
      return;
    }

    /**
     * Suspend a shop, or reinstate one.
     *
     * **This is not a display change.** `createSale.ts` refuses a merchant whose
     * status is not `ACTIVE`, so suspending here stops that shop selling on
     * every device it owns, immediately.
     *
     * `ADMIN_SUSPEND_MERCHANT` carries step-up: stopping a shop trading is a
     * decision with a shop's livelihood on the other side of it.
     *
     * **Nothing is deleted.** `05 Operations/Merchant Onboarding` and
     * `09 Engineering/Security Model` both state the rule — *"halts selling
     * without deleting history"* — and it holds here because only one column
     * moves. Transactions, ledger entries, receipts and the audit trail are
     * untouched, and reinstating restores exactly what was there.
     */
    const suspendMatch = /^\/merchants\/([^/]+)\/(suspend|reinstate)$/.exec(path);
    if (suspendMatch && method === 'POST') {
      if (!guard('ADMIN_SUSPEND_MERCHANT')) return;
      const merchantId = decodeURIComponent(suspendMatch[1]);
      const action = suspendMatch[2];
      const next = action === 'suspend' ? 'SUSPENDED' : 'ACTIVE';

      const form = await readForm(request);
      const reason = (form['reason'] ?? '').trim();
      // A suspension with no reason is not a decision somebody can answer for.
      // Reinstating does not need one: the shop is being returned to normal.
      if (action === 'suspend' && reason.length === 0) {
        response.writeHead(303, { location: '/merchants?error=REASON_REQUIRED' });
        response.end();
        return;
      }

      const changed = options.db
        .prepare(`UPDATE merchants SET status = ?, updated_at = ? WHERE id = ? AND status <> ?`)
        .run(next, options.now(), merchantId, next) as { changes: number };

      if (changed.changes === 0) {
        // Already in that state, or no such shop. Neither is an error worth a
        // stack trace, and both are answered the same way so this cannot be
        // used to discover which merchant ids exist.
        response.writeHead(303, { location: '/merchants?error=NOT_CHANGED' });
        response.end();
        return;
      }

      record({
        event: action === 'suspend' ? 'ADMIN_MERCHANT_SUSPENDED' : 'ADMIN_MERCHANT_REINSTATED',
        actorId: context.user.id,
        actorRole: context.user.role,
        entityType: 'MERCHANT',
        entityId: merchantId,
        merchantId,
        // The reason a shop was stopped is the thing an operator will be asked
        // about, so it goes in the trail rather than only on a screen.
        ...(reason.length > 0 ? { metadata: { reason } } : {}),
      });

      response.writeHead(303, { location: '/merchants' });
      response.end();
      return;
    }

    /**
     * Remote stop for one device.
     *
     * `05 Operations/Merchant Onboarding`: *"halts selling without deleting
     * history"*. Two things move together, which is why this is one route and
     * not two: the device stops being `ACTIVE`, so `createSale` refuses it, and
     * every session it was carrying is revoked — a stopped device that kept a
     * live session would still be usable, which is the opposite of stopped.
     *
     * The shop keeps trading on its other devices. That is the difference
     * between this and suspending a merchant, and it is the case R14 describes:
     * one machine lost or stolen, a shop still open.
     */
    /**
     * Check a device key a shop has read out.
     *
     * The founder asked to see device keys in the console. Telga cannot show
     * one — a key is stored only as a scrypt hash (§18.2) — so this answers the
     * question behind the request instead: *is the key this shop is holding the
     * right one?*
     *
     * ## What it does not do
     *
     * Store, log or echo the submitted key. The answer is one of three words
     * and the key is discarded. The audit event records **that** a check
     * happened, by whom, against which device, and the outcome — never the
     * value, because an audit trail carrying credentials turns every reader of
     * the audit screen into a holder of them.
     *
     * ## Why an unknown device and a wrong key answer differently here
     *
     * The opposite choice to `/activate`, and deliberately. There, the caller is
     * anonymous and telling them apart would build a device-id oracle. Here the
     * caller is a signed-in administrator who can already list every device on
     * the platform, so `NOT_ENROLLED` discloses nothing they cannot read on the
     * previous screen — and it saves them checking a key against a device that
     * was never activated.
     */
    if (path === '/devices/verify-key' && method === 'POST') {
      if (!guard('ADMIN_VIEW_DEVICE')) return;
      const form = await readForm(request);
      const deviceId = (form['deviceId'] ?? '').trim();
      const enrolment = options.db
        .prepare('SELECT secret_hash, secret_salt FROM device_enrollments WHERE device_id = ?')
        .get(deviceId) as { secret_hash: string; secret_salt: string } | undefined;

      const result = await verifyDeviceKey(enrolment, form['deviceKey'] ?? '');

      record({
        event: 'ADMIN_DEVICE_KEY_CHECKED',
        actorId: context.user.id,
        actorRole: context.user.role,
        entityType: 'DEVICE',
        entityId: deviceId,
        // The outcome, never the key.
        metadata: { result },
      });

      const said =
        result === 'MATCH'
          ? 'That is the correct key for this device.'
          : result === 'NO_MATCH'
            ? 'That is not the key for this device.'
            : 'That device has never been activated, so it has no key yet.';
      response.writeHead(303, {
        location: `/devices?notice=${encodeURIComponent(said)}`,
      });
      response.end();
      return;
    }

    /**
     * Undo a remote stop.
     *
     * Stopping a device did not have a way back. A machine reported lost and
     * then found needed a whole new device record and a new activation code,
     * for no reason other than the missing route.
     *
     * ## What it restores, and what it deliberately does not
     *
     * The **device row** returns to `ACTIVE`, so it may sell and — since R46 —
     * sign in again.
     *
     * The **enrolment stays revoked.** Stopping sets `enrollment_state =
     * 'REVOKED'`, and this does not undo that: the device key may have been
     * read off a machine that was out of the shop's hands, and a control whose
     * whole purpose is "this device is not where it should be" must not hand
     * the same credential back. The shop is issued a **new activation code**,
     * which is one console click and re-pairs the machine in a minute.
     *
     * So reinstating is not the inverse of stopping, and saying so is the
     * point: it returns the *machine*, never the *credential*.
     */
    const reinstateDeviceMatch = /^\/devices\/([^/]+)\/reinstate$/.exec(path);
    if (reinstateDeviceMatch && method === 'POST') {
      if (!guard('ADMIN_REMOTE_STOP_SALES')) return;
      const deviceId = decodeURIComponent(reinstateDeviceMatch[1]);
      const changed = options.db
        .prepare(`UPDATE devices SET status = 'ACTIVE', updated_at = ? WHERE id = ? AND status <> 'ACTIVE'`)
        .run(options.now(), deviceId) as { changes: number };

      if (changed.changes === 0) {
        // Already active, or no such device. Both answered the same way, so
        // this cannot be used to discover which device ids exist.
        response.writeHead(303, { location: '/devices?notice=Nothing%20changed.' });
        response.end();
        return;
      }

      record({
        event: 'ADMIN_DEVICE_REINSTATED',
        actorId: context.user.id,
        actorRole: context.user.role,
        entityType: 'DEVICE',
        entityId: deviceId,
      });

      response.writeHead(303, {
        location:
          '/devices?notice=' +
          encodeURIComponent(
            'Device reinstated. Its old key stays revoked — issue a new activation code so the shop can pair it again.',
          ),
      });
      response.end();
      return;
    }

    const stopMatch = /^\/devices\/([^/]+)\/stop$/.exec(path);
    if (stopMatch && method === 'POST') {
      if (!guard('ADMIN_REMOTE_STOP_SALES')) return;
      const deviceId = decodeURIComponent(stopMatch[1]);
      const at = options.now();

      options.db.prepare('BEGIN').run();
      try {
        options.db
          .prepare(`UPDATE devices SET status = 'STOPPED', updated_at = ? WHERE id = ?`)
          .run(at, deviceId);
        options.db
          .prepare(
            `UPDATE device_enrollments SET enrollment_state = 'REVOKED', revoked_at = ?,
                    revocation_reason = 'REMOTE_STOP', updated_at = ?
              WHERE device_id = ?`,
          )
          .run(at, at, deviceId);
        options.db
          .prepare(
            // `revocation_reason`, not `revoked_reason` — the column name in
            // migration 006. Typecheck cannot see inside a SQL string, which is
            // why this was read from the schema rather than assumed.
            `UPDATE sessions SET status = 'REVOKED', revoked_at = ?,
                    revocation_reason = 'DEVICE_STOPPED'
              WHERE device_id = ? AND status = 'ACTIVE'`,
          )
          .run(at, deviceId);
        options.db.prepare('COMMIT').run();
      } catch {
        options.db.prepare('ROLLBACK').run();
        respond(response, 500, document(deniedScreen(chromeFor(context, csrf), 'The device could not be stopped. Nothing was changed.'), 'Not stopped'));
        return;
      }

      record({
        event: 'ADMIN_DEVICE_STOPPED',
        actorId: context.user.id,
        actorRole: context.user.role,
        entityType: 'DEVICE',
        entityId: deviceId,
      });

      response.writeHead(303, { location: '/devices' });
      response.end();
      return;
    }

    // --- deposits ------------------------------------------------------------
    //
    // Closed entirely when no credit port is configured. A deposit screen that
    // could record `CREDITED` without money moving would be a false record of a
    // shop's balance, and every later reconciliation would start from it.
    if (path.startsWith('/deposits') && options.creditMerchant === undefined) {
      respond(response, 404, document(deniedScreen(chromeFor(context, csrf), 'Deposits are not configured on this console.'), 'Not found'));
      return;
    }

    if (path === '/deposits' && method === 'GET') {
      if (!guard('ADMIN_REVIEW_FUNDING')) return;
      screen(depositsScreen(chromeFor(context, csrf), deposits(), allowed), 'Deposits');
      return;
    }

    if (path === '/deposits/new' && method === 'GET') {
      // `ADMIN_APPROVE_FUNDING` carries step-up and dual control. Recording a
      // deposit moves a shop's money, so it is not a viewing permission.
      if (!guard('ADMIN_APPROVE_FUNDING')) return;
      screen(recordDepositScreen({ chrome: chromeFor(context, csrf) }), 'Record a deposit');
      return;
    }

    if (path === '/deposits' && method === 'POST') {
      if (!guard('ADMIN_APPROVE_FUNDING')) return;
      const form = await readForm(request);

      const birrToMinor = (raw: string): number | undefined => {
        const trimmed = raw.trim();
        if (trimmed.length === 0) return undefined;
        // Integer minor units throughout — CLAUDE.md §13.9. Parsed from birr
        // because that is what a person reads off a statement.
        const value = Number(trimmed);
        if (!Number.isFinite(value) || value <= 0) return undefined;
        return Math.round(value * 100);
      };

      const bankAmount = birrToMinor(form['bankAmountBirr'] ?? '');
      const claimedAmount = birrToMinor(form['claimedAmountBirr'] ?? '');
      const bankReference = (form['bankReference'] ?? '').trim();
      const creditedAccount = (form['creditedAccount'] ?? '').trim();

      if (bankReference.length === 0) {
        screen(
          recordDepositScreen({
            chrome: chromeFor(context, csrf),
            error: 'BANK_REFERENCE_REQUIRED',
            values: form,
          }),
          'Record a deposit',
        );
        return;
      }

      // Empty bank fields are a legitimate answer meaning "the bank has no such
      // transaction", and `verifyDeposit` turns that into a rejection. They are
      // only passed as a record when **all three** are present: a partial one
      // would be a claim wearing a bank record's clothes.
      const bankRecord =
        bankAmount !== undefined && creditedAccount.length > 0
          ? { bankReference, amountMinor: bankAmount, creditedAccount }
          : undefined;

      const at = options.now();
      options.db.prepare('BEGIN').run();
      let outcome;
      try {
        outcome = recordDeposit(
          {
            now: options.now,
            newId: options.newId,
            merchantForReference: (lookup) =>
              (
                options.db
                  .prepare(`SELECT merchant_id FROM device_enrollments WHERE deposit_lookup = ?`)
                  .get(lookup) as { merchant_id: string } | undefined
              )?.merchant_id,
            alreadyCredited: (reference) =>
              options.db
                .prepare(
                  `SELECT 1 FROM funding_submissions WHERE bank_reference = ? AND status = 'CREDITED'`,
                )
                .get(reference) !== undefined,
            insertSubmission: (row) => {
              options.db
                .prepare(
                  `INSERT INTO funding_submissions
                     (id, merchant_id, quoted_reference, bank_reference, claimed_amount_minor,
                      bank_amount_minor, status, outcome_reason, evidence, currency,
                      recorded_by, decided_by, decided_at, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ETB', ?, ?, ?, ?, ?)`,
                )
                .run(
                  row.id,
                  row.merchantId,
                  row.quotedReference,
                  row.bankReference,
                  row.claimedAmountMinor,
                  row.bankAmountMinor,
                  row.status,
                  row.outcomeReason,
                  row.evidence,
                  row.recordedBy,
                  row.decidedBy,
                  row.at,
                  row.at,
                  row.at,
                );
            },
            creditMerchant: (input) => {
              (options.creditMerchant as NonNullable<typeof options.creditMerchant>)(input);
            },
            linkPosting: (submissionId, postingId, when) => {
              options.db
                .prepare(`UPDATE funding_submissions SET posting_id = ?, updated_at = ? WHERE id = ?`)
                .run(postingId, when, submissionId);
            },
          },
          {
            quotedReference: (form['quotedReference'] ?? '').trim(),
            bankReference,
            bankRecord,
            // Computed once. Calling `birrToMinor` twice to test it and then use
            // it invited a cast, and a cast in the middle of parsing a money
            // field is the wrong shape of code to have there.
            ...(claimedAmount === undefined ? {} : { claimedAmountMinor: claimedAmount }),
            ...((form['evidence'] ?? '').trim().length === 0
              ? {}
              : { evidence: (form['evidence'] ?? '').trim() }),
            expectedAccount: options.depositAccount ?? '',
            // 50,000 birr, matching the training deposit ceiling.
            autoCreditCapMinor: options.autoCreditCapMinor ?? 5_000_000,
            recordedBy: context.user.id,
          },
        );
        options.db.prepare('COMMIT').run();
      } catch {
        options.db.prepare('ROLLBACK').run();
        screen(
          recordDepositScreen({
            chrome: chromeFor(context, csrf),
            error: 'DEPOSIT_NOT_RECORDED',
            values: form,
          }),
          'Record a deposit',
        );
        return;
      }

      record({
        event: 'ADMIN_DEPOSIT_RECORDED',
        actorId: context.user.id,
        actorRole: context.user.role,
        entityType: 'FUNDING_SUBMISSION',
        entityId: outcome.submissionId,
        ...(outcome.decision.kind === 'CREDIT' || outcome.decision.kind === 'NEEDS_APPROVAL'
          ? { merchantId: outcome.decision.merchantId }
          : {}),
        // The outcome and the bank reference. Never the quoted reference: under
        // D125 that is the shop's device key, and an audit screen carrying it
        // would hand a credential to every reader.
        metadata: { status: outcome.status, bankReference, at },
      });

      response.writeHead(303, { location: '/deposits' });
      response.end();
      return;
    }

    if (path === '/merchants') {
      if (!guard('ADMIN_VIEW_MERCHANT')) return;
      screen(merchantsScreen(chromeFor(context, csrf), merchants(), allowed), 'Merchants');
      return;
    }

    if (path === '/devices' && method === 'GET') {
      if (!guard('ADMIN_VIEW_DEVICE')) return;
      screen(
        devicesScreen(
          chromeFor(context, csrf),
          devices(),
          allowed,
          url.searchParams.get('notice') ?? undefined,
        ),
        'Devices',
      );
      return;
    }

    const tokenMatch = /^\/devices\/([^/]+)\/enrollment-token$/.exec(path);
    if (tokenMatch && method === 'POST') {
      if (!guard('ADMIN_ISSUE_ENROLLMENT_TOKEN')) return;
      const deviceId = decodeURIComponent(tokenMatch[1]);
      const token = newEnrollmentToken();
      const expiresAt = enrollmentExpiryFrom(options.now());
      // Only the hash is stored. The plaintext exists in this response and
      // nowhere else — not in the database, not in a log.
      //
      // **Hashed in its normalized form**, not as displayed. The code is shown
      // grouped in fives so a person can read it aloud without losing their
      // place, and whoever types it back may include the hyphens or not. Hashing
      // the displayed form made the grouping part of the secret, so a shop that
      // typed the code without hyphens would have been refused with no way to
      // tell why. Nothing redeemed a code until now, so the mismatch had never
      // had a chance to show itself — see `admin/redeemEnrollment.ts`, which
      // normalizes on the way in.
      const derived = await hashAdminSecret(normalizeEnrollmentToken(token));
      options.db
        .prepare(
          `UPDATE device_enrollments
              SET secret_hash = ?, secret_salt = ?, enrollment_state = 'PENDING',
                  expires_at = ?, updated_at = ?
            WHERE device_id = ?`,
        )
        .run(derived.hash, derived.salt, expiresAt, options.now(), deviceId);
      record({
        event: 'ADMIN_ENROLLMENT_TOKEN_ISSUED',
        actorId: context.user.id,
        actorRole: context.user.role,
        entityType: 'DEVICE',
        entityId: deviceId,
        // The token is not recorded anywhere, here included. That one was
        // issued, to which device, by whom and until when is the whole of what
        // an investigation needs.
        metadata: { expiresAt },
      });
      screen(
        enrollmentTokenScreen(chromeFor(context, csrf), {
          deviceId,
          token,
          expiresAt,
          notice: ENROLLMENT_NOTICE,
        }),
        'Activation code',
      );
      return;
    }

    if (path === '/tenants') {
      if (!guard('ADMIN_VIEW_MERCHANT')) return;
      screen(tenantsScreen(chromeFor(context, csrf), tenants(), options.schemaVersion), 'Tenants');
      return;
    }

    if (path === '/admins' && method === 'GET') {
      if (!guard('ADMIN_VIEW_OPERATOR')) return;
      screen(
        adminsScreen(
          chromeFor(context, csrf),
          admins(),
          allowed,
          url.searchParams.get('error') ?? undefined,
        ),
        'Administrators',
      );
      return;
    }

    if (path === '/admins' && method === 'POST') {
      // Only the Platform Owner holds this, and it needs a step-up.
      if (!guard('ADMIN_MANAGE_ADMINS')) return;
      const form = await readForm(request);
      const derived = await hashAdminSecret(form['password'] ?? '');
      const createdId = options.newId('adm');
      try {
        saveAdminUser(options.db as never, {
          id: createdId,
          email: form['email'] ?? '',
          displayName: form['displayName'] ?? '',
          department: form['department'] ?? 'PLATFORM',
          role: form['role'] ?? 'AUDITOR',
          passwordHash: derived.hash,
          passwordSalt: derived.salt,
          passwordParams: derived.params,
          // PENDING, not ACTIVE: a new admin must enrol a second factor before
          // the account does anything.
          status: 'PENDING',
          createdBy: context.user.id,
          approvedBy: context.user.id,
          at: options.now(),
        });
      } catch (error) {
        // Say which of the likely causes it was and redisplay the form.
        //
        // This used to redirect to a blank `/admins` and say nothing, so an
        // admin who mistyped a role got a page that looked like it had worked
        // and a table with nobody new in it. The database's CHECK constraints
        // are the real authority on roles and departments, so the message is
        // derived from what it refused rather than re-listing them here.
        const detail = error instanceof Error ? error.message : '';
        const reason = detail.includes('admin_users.email')
          ? 'An administrator with that email already exists.'
          : detail.includes('CHECK') && detail.includes('role')
            ? 'That is not a role this console recognises.'
            : detail.includes('CHECK') && detail.includes('department')
              ? 'That is not a department this console recognises.'
              : 'That administrator could not be created. Check every field and try again.';
        record({
          event: 'ADMIN_CREATED',
          actorId: context.user.id,
          actorRole: context.user.role,
          entityType: 'ADMIN_USER',
          entityId: createdId,
          // A refused creation is worth recording too: repeated attempts to
          // create an admin are the shape of somebody probing what they can do.
          metadata: { outcome: 'REFUSED', role: form['role'] ?? 'AUDITOR' },
        });
        response.writeHead(303, { location: `/admins?error=${encodeURIComponent(reason)}` });
        response.end();
        return;
      }
      record({
        event: 'ADMIN_CREATED',
        actorId: context.user.id,
        actorRole: context.user.role,
        entityType: 'ADMIN_USER',
        entityId: createdId,
        // Who was given what. Creating an administrator is the single most
        // consequential thing this console does, so the role granted is
        // recorded alongside the fact of the creation.
        metadata: {
          role: form['role'] ?? 'AUDITOR',
          department: form['department'] ?? 'PLATFORM',
          status: 'PENDING',
        },
      });
      response.writeHead(303, { location: '/admins' });
      response.end();
      return;
    }

    // --- recovering a lost authenticator ----------------------------------
    //
    // Without this, an admin whose phone is lost or replaced is locked out for
    // good, and the pressure that creates — borrowing a colleague's account, or
    // editing `admin_users` by hand — is worse than a reset that is permissioned,
    // stepped up and recorded.
    //
    // The reset only clears. It issues no replacement secret, so the admin doing
    // the reset never learns the new one; the locked-out admin enrols it
    // themselves at the next sign-in. Their live sessions are revoked in the
    // same breath, because a session that already cleared MFA would otherwise
    // keep running on a factor that no longer exists.
    const resetMfaMatch = /^\/admins\/([^/]+)\/reset-mfa$/.exec(path);
    if (resetMfaMatch && method === 'POST') {
      if (!guard('ADMIN_MANAGE_ADMINS')) return;
      const targetId = decodeURIComponent(resetMfaMatch[1]);
      const target = admins().find((a) => a.id === targetId);
      if (target === undefined) {
        respond(response, 404, document(deniedScreen(chromeFor(context, csrf), 'No such administrator.'), 'Not found'));
        return;
      }
      clearAdminMfaSecret(options.db as never, targetId, options.now());
      const revoked = revokeAllAdminSessions(
        options.db as never,
        targetId,
        options.now(),
        'MFA_RESET',
      );
      record({
        event: 'ADMIN_MFA_RESET',
        actorId: context.user.id,
        actorRole: context.user.role,
        entityType: 'ADMIN_USER',
        entityId: targetId,
        // Who was reset, and how many live sessions that ended. A reset of an
        // account that was mid-session is a different event from a reset of a
        // dormant one, and the trail should let a reviewer tell them apart.
        metadata: { targetRole: target.role, sessionsRevoked: revoked, self: targetId === context.user.id },
      });
      response.writeHead(303, { location: '/admins' });
      response.end();
      return;
    }

    // --- shop activity, aggregates only ------------------------------------
    //
    // A transaction list and a detail page lived here for about an hour on
    // 2026-09-09 and were removed by founder decision **D144**: Telga staff see
    // aggregates and performance, never a shop's individual sales.
    //
    // **The routes are gone, not hidden.** `/transactions` and
    // `/transactions/:id` answer 404 like any unknown path — the feature-flag
    // work already had to learn once that hiding a button while the endpoint
    // still answers is a defect, not a control.
    //
    // The cost is real and recorded rather than absorbed: §17's "search by
    // transaction ID" cannot be done from this console (R44).

    if (path === '/activity' && method === 'GET') {
      if (!guard('ADMIN_VIEW_MERCHANT')) return;

      // Grouped in SQL rather than in memory. At 1000+ shops the alternative is
      // reading every transaction row into this process to count them, which is
      // the shape of query that works in training and falls over in a pilot.
      const perShop = rows<{
        merchant_id: string; status: string; sales: number; volume: number;
        successful: number; pending: number; under_review: number; failed: number;
        last_sale: string | null;
      }>(
        `SELECT m.id AS merchant_id,
                m.status AS status,
                COUNT(t.id) AS sales,
                COALESCE(SUM(CASE WHEN t.state = 'SUCCESSFUL' THEN t.amount_minor ELSE 0 END), 0) AS volume,
                COALESCE(SUM(CASE WHEN t.state = 'SUCCESSFUL' THEN 1 ELSE 0 END), 0) AS successful,
                COALESCE(SUM(CASE WHEN t.state = 'PENDING' THEN 1 ELSE 0 END), 0) AS pending,
                COALESCE(SUM(CASE WHEN t.state = 'UNDER_REVIEW' THEN 1 ELSE 0 END), 0) AS under_review,
                COALESCE(SUM(CASE WHEN t.state IN ('FAILED','REJECTED','REVERSED') THEN 1 ELSE 0 END), 0) AS failed,
                MAX(t.created_at) AS last_sale
           FROM merchants m
           LEFT JOIN transactions t ON t.merchant_id = m.id
          GROUP BY m.id, m.status
          ORDER BY sales DESC, m.id`,
      );

      const shaped = perShop.map((r) => ({
        merchantId: r.merchant_id,
        status: r.status,
        sales: r.sales,
        volumeMinor: r.volume,
        successful: r.successful,
        pending: r.pending,
        underReview: r.under_review,
        failed: r.failed,
        lastSaleAt: r.last_sale,
      }));

      screen(
        activityScreen({
          chrome: chromeFor(context, csrf),
          rows: shaped,
          totals: {
            // Shops that have actually traded, not shops that exist. "12 shops
            // trading" and "12 shops registered" are different facts and the
            // second one is already on the dashboard.
            shops: shaped.filter((r) => r.sales > 0).length,
            sales: shaped.reduce((n, r) => n + r.sales, 0),
            volumeMinor: shaped.reduce((n, r) => n + r.volumeMinor, 0),
            pending: shaped.reduce((n, r) => n + r.pending, 0),
            underReview: shaped.reduce((n, r) => n + r.underReview, 0),
          },
        }),
        'Shop activity',
      );
      return;
    }

    // --- operators ---------------------------------------------------------
    //
    // The people who actually sign in at a counter. Suspending one and
    // resetting a forgotten PIN were CLI-only, which meant a shop with a locked
    // operator had to wait for somebody with shell access.

    if (path === '/operators' && method === 'GET') {
      if (!guard('ADMIN_VIEW_OPERATOR')) return;
      const found = rows<{
        id: string; merchant_id: string; display_name: string; role: string; status: string;
        locked_until: string | null; last_login_at: string | null; must_change_pin: number;
      }>(
        `SELECT id, merchant_id, display_name, role, status, locked_until, last_login_at,
                must_change_pin
           FROM merchant_users ORDER BY merchant_id, display_name`,
      );
      const now = options.now();
      screen(
        operatorsScreen({
          chrome: chromeFor(context, csrf),
          allowed,
          error: url.searchParams.get('error') ?? undefined,
          notice: url.searchParams.get('notice') ?? undefined,
          rows: found.map((r) => ({
            id: r.id,
            merchantId: r.merchant_id,
            displayName: r.display_name,
            role: r.role,
            status: r.status,
            // Only a lock that is still in the future. A stale timestamp shown
            // as a live lock sends somebody to reset a PIN that works.
            lockedUntil: r.locked_until !== null && r.locked_until > now ? r.locked_until : null,
            lastLoginAt: r.last_login_at,
            mustChangePin: r.must_change_pin === 1,
          })),
        }),
        'Operators',
      );
      return;
    }

    const operatorToggle = /^\/operators\/([^/]+)\/(suspend|reinstate)$/.exec(path);
    if (operatorToggle && method === 'POST') {
      if (!guard('ADMIN_SUSPEND_OPERATOR')) return;
      const id = decodeURIComponent(operatorToggle[1]);
      const next = operatorToggle[2] === 'suspend' ? 'SUSPENDED' : 'ACTIVE';
      const changed = options.db
        .prepare(`UPDATE merchant_users SET status = ?, updated_at = ? WHERE id = ? AND status <> ?`)
        .run(next, options.now(), id, next) as { changes: number };

      if (changed.changes === 0) {
        response.writeHead(303, { location: '/operators?error=Nothing%20changed.' });
        response.end();
        return;
      }

      // Suspending must also end the session the operator is holding. A
      // suspension that waited for a voluntary sign-out would leave the till
      // working — the same reasoning the device-stop route already applies.
      if (next === 'SUSPENDED') {
        options.db
          .prepare(
            // The same three columns the device-stop route sets, read from the
            // schema rather than assumed: a session is revoked by moving its
            // `status`, not only by stamping `revoked_at`. Setting the timestamp
            // alone would leave `status = 'ACTIVE'`, and `authenticate` reads
            // the status — so the session would have kept working.
            `UPDATE sessions SET status = 'REVOKED', revoked_at = ?,
                    revocation_reason = 'OPERATOR_SUSPENDED'
              WHERE user_id = ? AND status = 'ACTIVE'`,
          )
          .run(options.now(), id);
      }

      record({
        event: next === 'SUSPENDED' ? 'ADMIN_OPERATOR_SUSPENDED' : 'ADMIN_OPERATOR_REINSTATED',
        actorId: context.user.id,
        actorRole: context.user.role,
        entityType: 'MERCHANT_USER',
        entityId: id,
      });
      response.writeHead(303, { location: '/operators' });
      response.end();
      return;
    }

    const operatorReset = /^\/operators\/([^/]+)\/reset-pin$/.exec(path);
    if (operatorReset && method === 'POST') {
      if (!guard('ADMIN_RESET_OPERATOR_PIN')) return;
      const id = decodeURIComponent(operatorReset[1]);
      const exists = options.db
        .prepare('SELECT id FROM merchant_users WHERE id = ?')
        .get(id) as { id: string } | undefined;
      if (exists === undefined) {
        response.writeHead(303, { location: '/operators?error=No%20such%20operator.' });
        response.end();
        return;
      }

      // Six digits from `randomInt`, never `Math.random`: this is a credential.
      const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const derived = await hashAdminSecret(pin);
      options.db
        .prepare(
          `UPDATE merchant_users
              SET pin_hash = ?, pin_salt = ?, pin_params = ?, must_change_pin = 1,
                  failed_attempts = 0, locked_until = NULL, updated_at = ?
            WHERE id = ?`,
        )
        .run(derived.hash, derived.salt, derived.params, options.now(), id);

      record({
        event: 'ADMIN_OPERATOR_PIN_RESET',
        actorId: context.user.id,
        actorRole: context.user.role,
        entityType: 'MERCHANT_USER',
        entityId: id,
        // Never the PIN. An audit trail carrying credentials turns every reader
        // of the audit screen into a holder of them.
      });

      // Rendered, not redirected: a PIN must never reach a URL or a log.
      respond(
        response,
        201,
        document(issuedPinScreen({ chrome: chromeFor(context, csrf), operatorId: id, pin }), 'Temporary PIN'),
      );
      return;
    }

    // --- provider health ---------------------------------------------------
    //
    // §16 requires outage isolation and §26 asks for outage duration as a pilot
    // metric. The events were written and nothing read them.

    if (path === '/provider-health' && method === 'GET') {
      if (!guard('ADMIN_VIEW_PROVIDER_HEALTH')) return;
      const current = rows<{
        provider_id: string; status: string; previous_status: string | null; at: string; detail: string | null;
      }>(
        `SELECT provider_id, status, previous_status, at, detail
           FROM provider_health_events
          WHERE at = (SELECT MAX(at) FROM provider_health_events inner_e
                       WHERE inner_e.provider_id = provider_health_events.provider_id)
          ORDER BY provider_id`,
      );
      const history = rows<{
        provider_id: string; status: string; previous_status: string | null; at: string; detail: string | null;
      }>(
        `SELECT provider_id, status, previous_status, at, detail
           FROM provider_health_events ORDER BY at DESC LIMIT 100`,
      );
      const shape = (r: {
        provider_id: string; status: string; previous_status: string | null; at: string; detail: string | null;
      }) => ({
        providerId: r.provider_id,
        status: r.status,
        previousStatus: r.previous_status,
        at: r.at,
        detail: r.detail,
      });
      screen(
        providerHealthScreen({
          chrome: chromeFor(context, csrf),
          current: current.map(shape),
          history: history.map(shape),
        }),
        'Provider health',
      );
      return;
    }

    // --- support and disputes — §17.2, and the answer to R44 ---------------

    if (path === '/complaints' && method === 'GET') {
      if (!guard('ADMIN_VIEW_SUPPORT_CASE')) return;
      const open = rows<{
        id: string;
        support_case_id: string;
        merchant_id: string;
        description: string;
        verdict: string | null;
        created_at: string;
        reference: string | null;
        transaction_id: string | null;
      }>(
        `SELECT r.id, r.support_case_id, r.merchant_id, r.description, r.verdict, r.created_at,
                c.reference, c.transaction_id
           FROM complaint_reviews r
           JOIN support_cases c ON c.id = r.support_case_id
          WHERE r.verdict IS NULL
          ORDER BY r.created_at`,
      );
      screen(
        complaintsScreen({
          chrome: chromeFor(context, csrf),
          notice: url.searchParams.get('notice') ?? undefined,
          rows: open.map((r) => ({
            id: r.id,
            caseId: r.support_case_id,
            reference: r.reference ?? r.support_case_id,
            merchantId: r.merchant_id,
            transactionId: r.transaction_id,
            description: r.description,
            verdict: r.verdict,
            createdAt: r.created_at,
          })),
        }),
        'Support and disputes',
      );
      return;
    }

    const complaintMatch = /^\/complaints\/([^/]+)$/.exec(path);
    if (complaintMatch && method === 'GET') {
      if (!guard('ADMIN_VIEW_SUPPORT_CASE')) return;
      const id = decodeURIComponent(complaintMatch[1]);
      const found = options.db
        .prepare(
          `SELECT r.id, r.support_case_id, r.merchant_id, r.description, r.verdict, r.created_at,
                  c.reference, c.transaction_id
             FROM complaint_reviews r
             JOIN support_cases c ON c.id = r.support_case_id
            WHERE r.id = ?`,
        )
        .get(id) as
        | {
            id: string; support_case_id: string; merchant_id: string; description: string;
            verdict: string | null; created_at: string; reference: string | null;
            transaction_id: string | null;
          }
        | undefined;

      if (found === undefined) {
        respond(response, 404, document(deniedScreen(chromeFor(context, csrf), 'No such complaint.'), 'Not found'));
        return;
      }

      /**
       * The one place Telga staff may see an individual transaction.
       *
       * **D144's exception, and the answer to R44.** Staff see aggregates and
       * never a shop's individual sales — except inside an open case the
       * merchant themselves opened, about one sale they themselves named.
       * §17 requires checking the state of *that* transaction, and a reviewer
       * who cannot see it cannot answer within the 24 hours §17 commits to.
       *
       * Scoped three ways: to this case, to the one transaction the case names,
       * and to the merchant that opened it. There is no way to reach a second
       * sale from here.
       *
       * **Audited.** Reading a merchant's transaction is a thing somebody did,
       * and the trail records which case it was done under.
       */
      let transaction;
      if (found.transaction_id !== null) {
        const tx = options.db
          .prepare(
            `SELECT id, state, amount_minor, recipient_masked, provider_reference, created_at
               FROM transactions WHERE id = ? AND merchant_id = ?`,
          )
          .get(found.transaction_id, found.merchant_id) as
          | {
              id: string; state: string; amount_minor: number; recipient_masked: string;
              provider_reference: string | null; created_at: string;
            }
          | undefined;

        if (tx !== undefined) {
          record({
            event: 'ADMIN_CASE_TRANSACTION_VIEWED',
            actorId: context.user.id,
            actorRole: context.user.role,
            entityType: 'TRANSACTION',
            entityId: tx.id,
            merchantId: found.merchant_id,
            // The case it was read under. Never the recipient.
            metadata: { caseReference: found.reference ?? found.support_case_id },
          });
          transaction = {
            id: tx.id,
            state: tx.state,
            amountMinor: tx.amount_minor,
            recipientMasked: tx.recipient_masked,
            providerReference: tx.provider_reference,
            createdAt: tx.created_at,
          };
        }
      }

      screen(
        complaintDetailScreen({
          chrome: chromeFor(context, csrf),
          complaint: {
            id: found.id,
            caseId: found.support_case_id,
            reference: found.reference ?? found.support_case_id,
            merchantId: found.merchant_id,
            transactionId: found.transaction_id,
            description: found.description,
            verdict: found.verdict,
            createdAt: found.created_at,
          },
          transaction,
        }),
        'Complaint',
      );
      return;
    }

    const decideComplaint = /^\/complaints\/([^/]+)\/decide$/.exec(path);
    if (decideComplaint && method === 'POST') {
      if (!guard('ADMIN_MANAGE_SUPPORT_CASE')) return;
      const id = decodeURIComponent(decideComplaint[1]);
      const form = await readForm(request);
      const verdict = form['verdict'] ?? '';
      const reason = (form['reason'] ?? '').trim();

      if (!['LEGITIMATE', 'SCAM', 'UNCERTAIN'].includes(verdict) || reason.length === 0) {
        // A verdict without a reason is not a review — the same rule the
        // application decide form applies.
        response.writeHead(303, {
          location: `/complaints/${encodeURIComponent(id)}?error=REASON_REQUIRED`,
        });
        response.end();
        return;
      }

      const at = options.now();
      const found = options.db
        .prepare(
          `SELECT r.merchant_id, c.transaction_id
             FROM complaint_reviews r JOIN support_cases c ON c.id = r.support_case_id
            WHERE r.id = ?`,
        )
        .get(id) as { merchant_id: string; transaction_id: string | null } | undefined;

      // The evidence as it stood when the verdict was recorded. Stored with the
      // verdict rather than re-read later, because a case must stay reviewable
      // against what was actually known at the time.
      const telgaState =
        found?.transaction_id == null
          ? null
          : (
              options.db
                .prepare('SELECT state FROM transactions WHERE id = ?')
                .get(found.transaction_id) as { state: string } | undefined
            )?.state ?? null;

      const changed = recordComplaintVerdict(options.db as never, {
        id,
        telgaState,
        // Not read from a provider: this build has no provider API to ask, and
        // recording a value nobody looked up would be inventing evidence.
        providerState: null,
        redemption: null,
        verdict: verdict as 'LEGITIMATE' | 'SCAM' | 'UNCERTAIN',
        reviewedBy: context.user.id,
        reason,
        at,
      });

      if (changed === 0) {
        response.writeHead(303, { location: '/complaints?notice=Already%20decided.' });
        response.end();
        return;
      }

      record({
        event: 'ADMIN_COMPLAINT_DECIDED',
        actorId: context.user.id,
        actorRole: context.user.role,
        entityType: 'SUPPORT_CASE',
        entityId: id,
        metadata: { verdict, telgaState: telgaState ?? 'unknown' },
      });

      response.writeHead(303, {
        location:
          '/complaints?notice=' +
          encodeURIComponent(
            verdict === 'LEGITIMATE'
              ? 'Recorded as legitimate. Reverse the sale to return the money — a verdict does not move it.'
              : verdict === 'UNCERTAIN'
                ? 'Recorded as uncertain. Escalate to the provider and tell the shop the next deadline.'
                : 'Recorded. Tell the shop the value was delivered.',
          ),
      });
      response.end();
      return;
    }

    // --- reversal requests — §17.1 ------------------------------------------

    if (path === '/reversals' && method === 'GET') {
      if (!guard('ADMIN_VIEW_MERCHANT')) return;
      const waiting = rows<{
        id: string; transaction_id: string; merchant_id: string; requested_by: string;
        reason: string; amount_minor: number; redemption: string; status: string;
        created_at: string; state: string | null;
      }>(
        `SELECT r.id, r.transaction_id, r.merchant_id, r.requested_by, r.reason,
                r.amount_minor, r.redemption, r.status, r.created_at, t.state
           FROM reversal_requests r
           LEFT JOIN transactions t ON t.id = r.transaction_id
          WHERE r.status IN ('REQUESTED','NEEDS_APPROVAL')
          ORDER BY r.created_at`,
      );
      screen(
        reversalsScreen({
          chrome: chromeFor(context, csrf),
          allowed,
          notice: url.searchParams.get('notice') ?? undefined,
          rows: waiting.map((r) => ({
            id: r.id,
            transactionId: r.transaction_id,
            merchantId: r.merchant_id,
            requestedBy: r.requested_by,
            reason: r.reason,
            amountMinor: r.amount_minor,
            redemption: r.redemption,
            status: r.status,
            createdAt: r.created_at,
            transactionState: r.state,
          })),
        }),
        'Reversal requests',
      );
      return;
    }

    /**
     * Decide a reversal request.
     *
     * ## What approving does here, and what it deliberately does not
     *
     * It records the **decision** and moves the request to `APPROVED`. It does
     * **not** post the ledger entry: settling a reversal is `completeReversal`
     * in the api package, which requires a supervisor role, writes the balanced
     * adjustment and moves the transaction to `REVERSED`.
     *
     * Splitting them is not indecision. A decision that is recorded and a
     * movement that is posted are different acts with different failure modes,
     * and §13 invariant 8 requires the authorisation to be visible separately
     * from the entry it authorised. A future step wires the settlement to this
     * approval; until it does, the queue shows what has been approved and not
     * yet settled, which is a state an operations desk can act on — rather than
     * a button that silently half-worked.
     */
    const reversalDecide = /^\/reversals\/([^/]+)\/(approve|refuse)$/.exec(path);
    if (reversalDecide && method === 'POST') {
      if (!guard('ADMIN_APPROVE_FUNDING')) return;
      const id = decodeURIComponent(reversalDecide[1]);
      const approving = reversalDecide[2] === 'approve';
      const form = await readForm(request);
      const reason = (form['reason'] ?? '').trim();

      if (reason.length === 0) {
        // A decision about somebody's money with no reason is not a decision
        // anybody can be asked about later.
        response.writeHead(303, { location: '/reversals?notice=A%20reason%20is%20required.' });
        response.end();
        return;
      }

      const changed = decideReversalRequest(options.db as never, {
        id,
        status: approving ? 'APPROVED' : 'REFUSED',
        decidedBy: context.user.id,
        reason,
        at: options.now(),
      });

      if (changed === 0) {
        response.writeHead(303, { location: '/reversals?notice=Already%20decided.' });
        response.end();
        return;
      }

      record({
        event: approving ? 'ADMIN_REVERSAL_APPROVED' : 'ADMIN_REVERSAL_REFUSED',
        actorId: context.user.id,
        actorRole: context.user.role,
        entityType: 'TRANSACTION',
        entityId: id,
        metadata: { outcome: approving ? 'APPROVED' : 'REFUSED' },
      });

      response.writeHead(303, {
        location:
          '/reversals?notice=' +
          encodeURIComponent(
            approving
              ? 'Approved. The adjustment is authorised and posts on settlement — the shop’s balance has not moved yet.'
              : 'Refused. Tell the shop why.',
          ),
      });
      response.end();
      return;
    }

    if (path === '/audit') {
      if (!guard('ADMIN_VIEW_AUDIT')) return;
      screen(auditScreen(chromeFor(context, csrf), audit()), 'Audit');
      return;
    }

    respond(response, 404, document(deniedScreen(chromeFor(context, csrf), 'No such screen.'), 'Not found'));
  }

  // --- reads --------------------------------------------------------------

  function rows<T>(sql: string, ...args: readonly unknown[]): T[] {
    return options.db.prepare(sql).all(...args) as T[];
  }

  function applications(): ReturnType<typeof applicationRows> {
    return applicationRows();
  }

  function applicationRows() {
    return rows<{
      id: string;
      reference: string;
      status: string;
      legal_name: string;
      locality: string;
      created_at: string;
      submitted_via: string;
    }>(`SELECT id, reference, status, legal_name, locality, created_at, submitted_via
          FROM merchant_applications ORDER BY created_at DESC`).map((r) => ({
      id: r.id,
      reference: r.reference,
      status: r.status,
      legalName: r.legal_name,
      locality: r.locality,
      createdAt: r.created_at,
      submittedVia: r.submitted_via,
    }));
  }

  function applicationById(id: string) {
    const row = options.db
      .prepare(`SELECT * FROM merchant_applications WHERE id = ?`)
      .get(id) as Record<string, string | null> | undefined;
    if (row === undefined) return undefined;
    return {
      id: String(row['id']),
      reference: String(row['reference']),
      status: String(row['status']),
      legalName: String(row['legal_name']),
      tradingName: row['trading_name'],
      ownerName: String(row['owner_name']),
      phone: String(row['phone']),
      email: row['email'],
      address: String(row['address']),
      locality: String(row['locality']),
      decisionReason: row['decision_reason'],
      createdAt: String(row['created_at']),
    };
  }

  /**
   * One row per shop, carrying **that shop's own** figures.
   *
   * Every column beyond the merchant row itself is a correlated subquery keyed
   * on `m.id`, so a shop's balance and sale count are computed from its rows and
   * nothing else. There is no aggregate here that spans shops, and no way to
   * write one by accident: remove the `WHERE ... = m.id` and the query stops
   * being valid rather than quietly returning a platform total.
   *
   * `available_minor` mirrors `balanceFor()` in `repositories/ledger.ts` —
   * `MERCHANT_AVAILABLE` and `MERCHANT_FUNDS`, credits positive. `BANK_CLEARING`
   * is deliberately absent from that list there and here, so the counterparty
   * side of a deposit can never appear as a shop's money.
   *
   * **Sales is a count, never the rows.** The brief requires shop-level
   * performance *and* forbids an administrator seeing individual transactions;
   * a count answers "is this shop trading" without disclosing what was sold, to
   * whom, or for how much.
   */
  function merchants() {
    return rows<{
      id: string;
      status: string;
      created_at: string;
      devices: number;
      available_minor: number;
      transactions: number;
    }>(
      `SELECT m.id, m.status, m.created_at,
              (SELECT COUNT(*) FROM devices d WHERE d.merchant_id = m.id) AS devices,
              (SELECT COALESCE(SUM(CASE le.direction
                                     WHEN 'CREDIT' THEN le.amount_minor
                                     ELSE -le.amount_minor END), 0)
                 FROM ledger_entries le
                WHERE le.merchant_id = m.id
                  AND le.account_type IN ('MERCHANT_AVAILABLE', 'MERCHANT_FUNDS')
              ) AS available_minor,
              (SELECT COUNT(*) FROM transactions t WHERE t.merchant_id = m.id) AS transactions
         FROM merchants m ORDER BY m.created_at DESC`,
    ).map((r) => ({
      id: r.id,
      status: r.status,
      devices: r.devices,
      createdAt: r.created_at,
      availableMinor: r.available_minor,
      transactions: r.transactions,
    }));
  }

  /** The deposit queue, newest first. */
  function deposits() {
    return rows<{
      id: string;
      merchant_id: string | null;
      bank_reference: string;
      bank_amount_minor: number | null;
      status: string;
      outcome_reason: string | null;
      decided_by: string | null;
      approved_by: string | null;
      created_at: string;
    }>(
      `SELECT id, merchant_id, bank_reference, bank_amount_minor, status,
              outcome_reason, decided_by, approved_by, created_at
         FROM funding_submissions ORDER BY created_at DESC, id DESC`,
    ).map((r) => ({
      id: r.id,
      merchantId: r.merchant_id,
      bankReference: r.bank_reference,
      bankAmountMinor: r.bank_amount_minor,
      status: r.status,
      outcomeReason: r.outcome_reason,
      decidedBy: r.decided_by,
      approvedBy: r.approved_by,
      createdAt: r.created_at,
    }));
  }

  function devices() {
    return rows<{
      id: string;
      merchant_id: string;
      status: string;
      device_type: string;
      enrollment_state: string | null;
      last_seen_at: string | null;
      secret_hash: string | null;
    }>(
      `SELECT d.id, d.merchant_id, d.status, d.device_type,
              e.enrollment_state, e.last_seen_at, e.secret_hash
         FROM devices d
         LEFT JOIN device_enrollments e ON e.device_id = d.id
        ORDER BY d.created_at DESC`,
    ).map((r) => ({
      id: r.id,
      merchantId: r.merchant_id,
      status: r.status,
      deviceType: r.device_type,
      enrollmentState: r.enrollment_state,
      lastSeenAt: r.last_seen_at,
      // Derived here and never leaving this map: the hash is read from the row
      // and turned into a fingerprint, so no caller downstream is ever handed
      // the stored hash itself. Absent for a device that has never activated.
      keyFingerprint: deviceKeyFingerprint(r.secret_hash),
    }));
  }

  function tenants() {
    return rows<{
      merchant_id: string;
      database_name: string;
      schema_version: string;
      status: string;
      last_backup_at: string | null;
    }>(`SELECT * FROM tenant_registry ORDER BY merchant_id`).map((r) => ({
      merchantId: r.merchant_id,
      databaseName: r.database_name,
      schemaVersion: r.schema_version,
      status: r.status,
      lastBackupAt: r.last_backup_at,
    }));
  }

  function admins() {
    return listAdminUsers(options.db as never).map((r) => ({
      id: r.id,
      email: r.email,
      displayName: r.display_name,
      department: r.department,
      role: r.role,
      status: r.status,
      mfaEnrolled: r.mfa_secret_hash !== null,
      lastLoginAt: r.last_login_at,
    }));
  }

  function audit() {
    return rows<{
      created_at: string;
      actor_id: string;
      event_type: string;
      entity_type: string;
      entity_id: string | null;
      merchant_id: string | null;
    }>(
      `SELECT created_at, actor_id, event_type, entity_type, entity_id, merchant_id
         FROM audit_events ORDER BY created_at DESC LIMIT 200`,
    ).map((r) => ({
      at: r.created_at,
      actor: r.actor_id,
      event: r.event_type,
      entity: `${r.entity_type} ${r.entity_id ?? ''}`.trim(),
      merchantId: r.merchant_id,
    }));
  }

  function counts() {
    const one = (sql: string): number => {
      const row = options.db.prepare(sql).get() as { n: number } | undefined;
      return row?.n ?? 0;
    };
    const registry = tenants().map((t) => ({
      merchantId: t.merchantId,
      databaseName: t.databaseName,
      schemaVersion: t.schemaVersion,
      status: t.status as never,
      lastBackupAt: t.lastBackupAt,
      lastRestoreAt: null,
    }));
    const behind = tenantsBehind(registry, options.schemaVersion);
    const overdue = backupsOverdue(registry, options.now(), 24 * 60 * 60 * 1000);

    // Under D120 every shop's entries are in this database, so the platform
    // residual is a single sum rather than a fan-out over tenant files. Every
    // posting must balance to zero — `Ledger Invariants` §13.2.
    const residualMinor = one(
      `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount_minor ELSE -amount_minor END), 0) AS n
         FROM ledger_entries`,
    );

    // The float every shop holds, added up. Mirrors `balanceFor` exactly —
    // `MERCHANT_AVAILABLE` and `MERCHANT_FUNDS`, credits positive, and
    // `BANK_CLEARING` absent so a deposit's counterparty side is never counted
    // as money a shop has.
    const totalFloatMinor = one(
      `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount_minor ELSE -amount_minor END), 0) AS n
         FROM ledger_entries
        WHERE merchant_id IS NOT NULL
          AND account_type IN ('MERCHANT_AVAILABLE', 'MERCHANT_FUNDS')`,
    );

    // Shops whose available float has fallen below a day's trading. A flat
    // threshold rather than a per-shop one: Telga has no evidence yet about what
    // a busy shop turns over, and inventing a per-shop figure would be exactly
    // the fabricated number CLAUDE.md §30 forbids. It becomes a setting when
    // pilot data exists.
    const shopsLowOnFloat = one(
      `SELECT COUNT(*) AS n FROM (
         SELECT m.id,
                COALESCE(SUM(CASE le.direction WHEN 'CREDIT' THEN le.amount_minor
                                               ELSE -le.amount_minor END), 0) AS float_minor
           FROM merchants m
           LEFT JOIN ledger_entries le
             ON le.merchant_id = m.id
            AND le.account_type IN ('MERCHANT_AVAILABLE', 'MERCHANT_FUNDS')
          WHERE m.status = 'ACTIVE'
          GROUP BY m.id
         HAVING float_minor < 10000
       )`,
    );

    return {
      applicationsAwaiting: one(
        `SELECT COUNT(*) AS n FROM merchant_applications WHERE status IN ('SUBMITTED','UNDER_REVIEW')`,
      ),
      merchantsActive: one(`SELECT COUNT(*) AS n FROM merchants WHERE status = 'ACTIVE'`),
      devicesActive: one(`SELECT COUNT(*) AS n FROM devices WHERE status = 'ACTIVE'`),
      tenantsBehind: behind.length,
      backupsOverdue: overdue.length,

      // Platform totals. A count and a sum — never a way into a shop's rows.
      totalSales: one(`SELECT COUNT(*) AS n FROM transactions WHERE state = 'SUCCESSFUL'`),
      totalVolumeMinor: one(
        `SELECT COALESCE(SUM(amount_minor), 0) AS n FROM transactions WHERE state = 'SUCCESSFUL'`,
      ),
      totalFloatMinor,

      depositsWaiting: one(
        `SELECT COUNT(*) AS n FROM funding_submissions WHERE status IN ('MATCHED','MANUAL_REVIEW')`,
      ),
      shopsLowOnFloat,
      // Expired, or expiring within thirty days. A licence that lapses must
      // raise a review rather than pass silently — migration 015.
      licencesExpiring: one(
        `SELECT COUNT(*) AS n FROM merchant_application_documents
          WHERE kind = 'TRADE_LICENCE' AND status = 'SUPPLIED' AND expires_at IS NOT NULL
            AND expires_at < datetime('now', '+30 days')`,
      ),

      // **Corrected under D120.** This used to report that the platform residual
      // "cannot be proven" because per-shop databases were unreadable from here.
      // Under the shared-database model every shop's entries are in this file,
      // so the residual is one query — and reporting it as unprovable would now
      // be the opposite failure: telling an operator nothing is known when it is.
      //
      // A non-zero residual means debits and credits do not cancel, which
      // `Ledger Invariants` §13.2 says must never happen.
      ledgerSound: residualMinor === 0,
      ledgerNote:
        residualMinor === 0
          ? 'Every posting balances: debits and credits cancel across the platform.'
          : `Ledger residual is ${String(residualMinor)} minor units. Debits and credits do not ` +
            'cancel, which Ledger Invariants §13.2 says must never happen. Investigate before trading.',
    };
  }
}
