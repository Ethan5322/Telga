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

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import {
  adminLogin,
  authenticateAdmin,
  hashAdminSecret,
  newEnrollmentToken,
  beginMfaEnrolment,
  satisfyAdminMfa,
  stepUpAdmin,
  summariseResiduals,
  tenantsBehind,
  backupsOverdue,
  ENROLLMENT_NOTICE,
  enrollmentExpiryFrom,
  reviewRefusal,
  statusAfterReview,
} from '@telga/api';
import type { AdminAuthContext, AdminPermission } from '@telga/domain';
import { AdminAccessDeniedError, effectivePermissions, requireAdmin } from '@telga/domain';
import {
  clearAdminMfaSecret,
  listAdminUsers,
  revokeAdminSession,
  revokeAllAdminSessions,
  saveAdminUser,
} from '@telga/persistence';
import { recordAdminAction } from './audit';
import type { AdminAuditInput } from './audit';
import { CONTENT_SECURITY_POLICY, document } from './ui/page';
import type { ConsoleChrome } from './ui/page';
import {
  adminsScreen,
  applicationDetailScreen,
  applicationsScreen,
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
  /** Set `Secure` on the session cookie. False only for loopback HTTP. */
  readonly secureCookies?: boolean;
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
  'referrer-policy': 'no-referrer',
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
function originOk(request: IncomingMessage, allowedHosts: readonly string[]): boolean {
  const origin = request.headers['origin'];
  if (typeof origin !== 'string') return true; // Same-origin form posts may omit it.
  try {
    const host = new URL(origin).host.split(':')[0] ?? '';
    return allowedHosts.includes(host);
  } catch {
    return false;
  }
}

export function createConsoleServer(options: ConsoleOptions): Server {
  const allowedHosts = options.allowedHosts ?? ['localhost', '127.0.0.1'];
  const secure = options.secureCookies ?? false;
  const ports = { db: options.db as never, now: options.now, newId: options.newId };

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
  });

  return createServer((request, response) => {
    void handle(request, response).catch(() => {
      // An unhandled throw must not leak a stack trace to a browser. The
      // console is the one surface where an internal detail is most useful to
      // an attacker.
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
      respond(response, 403, document(deniedScreen(chromeFor(undefined, csrf), 'Refused: cross-site request.'), 'Refused'));
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
        location: '/mfa',
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

    if (!context.mfaSatisfied) {
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
        requireAdmin(context, permission, options.now() as never);
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

    const applicationMatch = /^\/applications\/([^/]+)$/.exec(path);
    if (applicationMatch && method === 'GET') {
      if (!guard('ADMIN_REVIEW_APPLICATION')) return;
      const found = applicationById(decodeURIComponent(applicationMatch[1]));
      if (found === undefined) {
        respond(response, 404, document(deniedScreen(chromeFor(context, csrf), 'No such application.'), 'Not found'));
        return;
      }
      screen(applicationDetailScreen(chromeFor(context, csrf), found, allowed, url.searchParams.get('error') ?? undefined), 'Application');
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
      response.writeHead(303, { location: `/applications/${encodeURIComponent(id)}` });
      response.end();
      return;
    }

    if (path === '/merchants') {
      if (!guard('ADMIN_VIEW_MERCHANT')) return;
      screen(merchantsScreen(chromeFor(context, csrf), merchants()), 'Merchants');
      return;
    }

    if (path === '/devices' && method === 'GET') {
      if (!guard('ADMIN_VIEW_DEVICE')) return;
      screen(devicesScreen(chromeFor(context, csrf), devices(), allowed), 'Devices');
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
      const derived = await hashAdminSecret(token);
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
    }>(`SELECT id, reference, status, legal_name, locality, created_at
          FROM merchant_applications ORDER BY created_at DESC`).map((r) => ({
      id: r.id,
      reference: r.reference,
      status: r.status,
      legalName: r.legal_name,
      locality: r.locality,
      createdAt: r.created_at,
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

  function merchants() {
    return rows<{ id: string; status: string; created_at: string; devices: number }>(
      `SELECT m.id, m.status, m.created_at,
              (SELECT COUNT(*) FROM devices d WHERE d.merchant_id = m.id) AS devices
         FROM merchants m ORDER BY m.created_at DESC`,
    ).map((r) => ({ id: r.id, status: r.status, devices: r.devices, createdAt: r.created_at }));
  }

  function devices() {
    return rows<{
      id: string;
      merchant_id: string;
      status: string;
      device_type: string;
      enrollment_state: string | null;
      last_seen_at: string | null;
    }>(
      `SELECT d.id, d.merchant_id, d.status, d.device_type,
              e.enrollment_state, e.last_seen_at
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

    // Per-shop databases mean the platform figure is a sum over tenants, and a
    // tenant that could not be read makes it a guess rather than a proof.
    const residual = summariseResiduals(registry.map((t) => ({ merchantId: t.merchantId, residualMinor: null })));

    return {
      applicationsAwaiting: one(
        `SELECT COUNT(*) AS n FROM merchant_applications WHERE status IN ('SUBMITTED','UNDER_REVIEW')`,
      ),
      merchantsActive: one(`SELECT COUNT(*) AS n FROM merchants WHERE status = 'ACTIVE'`),
      devicesActive: one(`SELECT COUNT(*) AS n FROM devices WHERE status = 'ACTIVE'`),
      tenantsBehind: behind.length,
      backupsOverdue: overdue.length,
      ledgerSound: registry.length === 0,
      ledgerNote:
        registry.length === 0
          ? 'No tenant databases registered, so there is nothing to reconcile yet.'
          : `Platform ledger residual cannot be proven: ${String(residual.tenantsUnreadable.length)} tenant database(s) ` +
            'are not yet readable from the console. Per-shop routing is not built — see ASSUMPTIONS.md A86.',
    };
  }
}
