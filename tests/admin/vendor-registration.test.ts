/**
 * *Register as vendor* — the app's own registration, end to end.
 *
 * Decision Log **D138** and `CLAUDE.md` §18.1. The founder's flow: the Telga
 * app opens on **Login** and **Register as vendor**; a shop taps the second and
 * submits; the submission lands in the operations console; an admin reviews and
 * approves; only then do credentials exist; only then can that shop sign in.
 *
 * ## What these tests are actually defending
 *
 * Not that the form works — that is the easy half. They defend the four claims
 * that would be expensive to get wrong, and each of them is a claim somebody
 * could break with a plausible-looking change:
 *
 *   1. **Submitting creates no account.** No merchant, no operator, no device,
 *      no credential. `Admin Operations Console` Decision 3 — *"no account
 *      until approved"* — is a structural claim, not a policy, and it stops
 *      being true the moment this route writes anything more than an
 *      application row.
 *   2. **A self-service submission is distinguishable from an admin-recorded
 *      one.** A reviewer who cannot tell them apart will assume somebody saw
 *      the documents. Migration 018 exists for this and nothing else.
 *   3. **The route is bounded.** It is the only surface an unauthenticated
 *      stranger may write through, so it must refuse the eleventh attempt as
 *      well as the first.
 *   4. **The shop's own status gates sign-in.** Suspension previously wrote
 *      `merchants.status` and stopped nothing at the door.
 */

import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_BEHAVIOURS } from '@telga/provider-mock-airtime';
import { createPosServer } from '@telga/merchant-pos';
import {
  REGISTRATION_MAX_PER_WINDOW,
  checkRegistrationThrottle,
  registrationSource,
} from '@telga/merchant-pos';
import { FEATURE_FLAGS, TRAINING_LOCKOUT_POLICY } from '@telga/domain';
import {
  enrollmentExpiryFrom,
  hashAdminSecret,
  newEnrollmentToken,
  normalizeEnrollmentToken,
} from '@telga/api';
import { MERCHANT_A } from '../ui/helpers';
import { makeUiHarness, signInAs } from '../auth/helpers';
import type { UiHarness } from '../auth/helpers';

let harness: UiHarness | undefined;
let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
  harness?.cleanup();
  harness = undefined;
});

interface Reply {
  readonly status: number;
  readonly body: string;
  readonly location: string;
}

function send(
  port: number,
  path: string,
  init: { method?: string; form?: Record<string, string>; cookie?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (init.form !== undefined) {
      body = new URLSearchParams(init.form).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['content-length'] = String(Buffer.byteLength(body));
      // Same-origin, so the origin check permits the post. A cross-site one is
      // refused before any of this, which `console-deployment` already pins.
      headers['origin'] = `http://127.0.0.1:${String(port)}`;
      headers['host'] = `127.0.0.1:${String(port)}`;
    }
    if (init.cookie !== undefined) headers['cookie'] = init.cookie;
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: text,
            location: String(res.headers['location'] ?? ''),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function start(h: UiHarness): Promise<number> {
  server = createPosServer({
    api: h.api,
    environment: 'test',
    catalog: [],
    simulatedBehaviours: [...MOCK_BEHAVIOURS],
  });
  return new Promise((resolve) => {
    server?.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}

/** A submission that should be accepted. Overridable one field at a time. */
const goodForm = (over: Record<string, string> = {}): Record<string, string> => ({
  legalName: 'Abebe Trading',
  ownerName: 'Abebe Bekele',
  phone: '+251911000000',
  email: '',
  address: 'Bole Road 12',
  locality: 'Addis Ababa',
  tradeLicence: 'TL-0001',
  // Far enough out that this suite does not start failing on a calendar date.
  tradeLicenceExpiry: '2099-06-30',
  tin: 'TIN-0001',
  photoId: 'ID-0001',
  ...over,
});

const db = (h: UiHarness) => h.deps.driver.unsafeConnection;

const count = (h: UiHarness, sql: string): number =>
  (db(h).prepare(sql).get() as { n: number }).n;

// ---------------------------------------------------------------------------
// The app's first screen
// ---------------------------------------------------------------------------

describe('the app opens on two options', () => {
  it('offers Register as vendor from the sign-in screen', async () => {
    harness = makeUiHarness('register-cta');
    const port = await start(harness);
    const reply = await send(port, '/login');
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('login-register-cta');
    expect(reply.body).toContain('href="/register"');
  });

  it('serves the registration form to a caller with no session at all', async () => {
    // The whole point: an applicant has no account, so the form cannot be
    // behind one. A redirect to sign in here would make registration
    // impossible for exactly the people it exists for.
    harness = makeUiHarness('register-anonymous');
    const port = await start(harness);
    const reply = await send(port, '/register');
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('register-form');
  });

  it('asks for no password anywhere on it', async () => {
    // No account is created here, so there is nothing for a password to open.
    // A password field would also train applicants to invent one and expect it
    // to work later, which it never would.
    harness = makeUiHarness('register-no-password');
    const port = await start(harness);
    const reply = await send(port, '/register');
    expect(reply.body).not.toContain('type="password"');
  });

  it('says plainly that approval is not automatic', async () => {
    harness = makeUiHarness('register-honest');
    const port = await start(harness);
    const reply = await send(port, '/register');
    expect(reply.body).toContain('Approval is not automatic');
    expect(reply.body).toContain('no account is created yet');
  });
});

// ---------------------------------------------------------------------------
// Submitting
// ---------------------------------------------------------------------------

describe('a submission becomes an application and nothing else', () => {
  it('records it as SUBMITTED, awaiting a human', async () => {
    harness = makeUiHarness('register-submit');
    const port = await start(harness);

    const reply = await send(port, '/register', { method: 'POST', form: goodForm() });
    expect(reply.status).toBe(201);

    const row = db(harness)
      .prepare('SELECT status, submitted_via, legal_name FROM merchant_applications')
      .get() as { status: string; submitted_via: string; legal_name: string };
    expect(row.status).toBe('SUBMITTED');
    expect(row.legal_name).toBe('Abebe Trading');
  });

  it('marks it SELF_SERVICE, so a reviewer knows nobody has seen the papers', async () => {
    harness = makeUiHarness('register-channel');
    const port = await start(harness);
    await send(port, '/register', { method: 'POST', form: goodForm() });

    const row = db(harness)
      .prepare('SELECT submitted_via FROM merchant_applications')
      .get() as { submitted_via: string };
    expect(row.submitted_via).toBe('SELF_SERVICE');
  });

  it('creates no merchant, no operator, no device and no enrolment', async () => {
    // Decision 3, as a structural claim rather than a promise. The counts are
    // taken before and after so a fixture that happens to seed a merchant
    // cannot make this pass by accident.
    harness = makeUiHarness('register-creates-nothing');
    const port = await start(harness);

    const before = {
      merchants: count(harness, 'SELECT COUNT(*) AS n FROM merchants'),
      users: count(harness, 'SELECT COUNT(*) AS n FROM merchant_users'),
      devices: count(harness, 'SELECT COUNT(*) AS n FROM devices'),
      enrolments: count(harness, 'SELECT COUNT(*) AS n FROM device_enrollments'),
      sessions: count(harness, 'SELECT COUNT(*) AS n FROM sessions'),
    };

    await send(port, '/register', { method: 'POST', form: goodForm() });

    expect(count(harness, 'SELECT COUNT(*) AS n FROM merchants')).toBe(before.merchants);
    expect(count(harness, 'SELECT COUNT(*) AS n FROM merchant_users')).toBe(before.users);
    expect(count(harness, 'SELECT COUNT(*) AS n FROM devices')).toBe(before.devices);
    expect(count(harness, 'SELECT COUNT(*) AS n FROM device_enrollments')).toBe(
      before.enrolments,
    );
    expect(count(harness, 'SELECT COUNT(*) AS n FROM sessions')).toBe(before.sessions);
  });

  it('returns a reference in the page and never in the URL', async () => {
    // The reference is the only thing the applicant gets back. A redirect would
    // put it in browser history on a shared counter phone, and in a referrer on
    // the way to anywhere else.
    harness = makeUiHarness('register-reference');
    const port = await start(harness);

    const reply = await send(port, '/register', { method: 'POST', form: goodForm() });
    expect(reply.status).toBe(201);
    expect(reply.location).toBe('');

    const stored = db(harness)
      .prepare('SELECT reference FROM merchant_applications')
      .get() as { reference: string };
    expect(stored.reference).toMatch(/^TLG-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(reply.body).toContain(stored.reference);
  });

  it('records the three documents against the application', async () => {
    harness = makeUiHarness('register-documents');
    const port = await start(harness);
    await send(port, '/register', { method: 'POST', form: goodForm() });

    const kinds = db(harness)
      .prepare('SELECT kind FROM merchant_application_documents ORDER BY kind')
      .all() as { kind: string }[];
    expect(kinds.map((k) => k.kind)).toEqual([
      'OWNER_PHOTO_ID',
      'TIN_CERTIFICATE',
      'TRADE_LICENCE',
    ]);
  });

  it('stores no document image, because the form cannot send one', async () => {
    // An unauthenticated upload endpoint is a way to put arbitrary bytes on
    // Telga's volume. The admin attaches scans at review, with the originals in
    // front of them.
    harness = makeUiHarness('register-no-uploads');
    const port = await start(harness);
    await send(port, '/register', { method: 'POST', form: goodForm() });

    const stored = count(
      harness,
      'SELECT COUNT(*) AS n FROM merchant_application_documents WHERE document_uri IS NOT NULL',
    );
    expect(stored).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('a submission that cannot be recorded is refused whole', () => {
  it('refuses an expired trade licence and writes nothing', async () => {
    harness = makeUiHarness('register-expired');
    const port = await start(harness);

    const reply = await send(port, '/register', {
      method: 'POST',
      form: goodForm({ tradeLicenceExpiry: '2020-01-01' }),
    });
    expect(reply.status).toBe(400);
    expect(reply.body).toContain('LICENCE_ALREADY_EXPIRED');
    expect(count(harness, 'SELECT COUNT(*) AS n FROM merchant_applications')).toBe(0);
  });

  it('refuses a missing document number and writes nothing', async () => {
    harness = makeUiHarness('register-missing-doc');
    const port = await start(harness);

    const reply = await send(port, '/register', {
      method: 'POST',
      form: goodForm({ tin: '' }),
    });
    expect(reply.status).toBe(400);
    expect(count(harness, 'SELECT COUNT(*) AS n FROM merchant_applications')).toBe(0);
  });

  it('gives the shopkeeper their typing back, so one bad field costs one fix', async () => {
    harness = makeUiHarness('register-repopulate');
    const port = await start(harness);

    const reply = await send(port, '/register', {
      method: 'POST',
      form: goodForm({ phone: 'not-a-number' }),
    });
    expect(reply.status).toBe(400);
    // The other six fields survive the round trip.
    expect(reply.body).toContain('Abebe Trading');
    expect(reply.body).toContain('Bole Road 12');
    expect(reply.body).toContain('TL-0001');
  });

  it('leaves no half-written application when a document number collides', async () => {
    // The unique index on (kind, reference) is what fires. The application row
    // must not survive it — a shop in the review queue with no papers, created
    // by the check meant to refuse it, is the exact failure the transaction
    // boundary exists for.
    harness = makeUiHarness('register-duplicate');
    const port = await start(harness);

    const first = await send(port, '/register', { method: 'POST', form: goodForm() });
    expect(first.status).toBe(201);

    const second = await send(port, '/register', {
      method: 'POST',
      form: goodForm({ legalName: 'Somebody Else Trading' }),
    });
    expect(second.status).toBe(409);

    // Exactly one application, and exactly its three documents.
    expect(count(harness, 'SELECT COUNT(*) AS n FROM merchant_applications')).toBe(1);
    expect(count(harness, 'SELECT COUNT(*) AS n FROM merchant_application_documents')).toBe(3);
  });

  it('does not tell a stranger whose licence number it already holds', async () => {
    // Saying "that TIN belongs to another shop" would turn this route into a
    // way to test licence numbers against Telga's merchant list.
    harness = makeUiHarness('register-no-disclosure');
    const port = await start(harness);
    await send(port, '/register', { method: 'POST', form: goodForm() });

    const second = await send(port, '/register', {
      method: 'POST',
      form: goodForm({ legalName: 'Somebody Else Trading' }),
    });
    expect(second.body).not.toContain('another shop');
    expect(second.body).toContain('Contact Telga');
  });
});

// ---------------------------------------------------------------------------
// The bound on an anonymous write
// ---------------------------------------------------------------------------

describe('the one anonymous write surface is bounded', () => {
  it('refuses once a source has spent its window', async () => {
    harness = makeUiHarness('register-throttle');
    const port = await start(harness);

    // Each attempt uses a fresh licence/TIN so it is the *throttle* that
    // refuses, not the duplicate index — otherwise this test would pass for
    // the wrong reason.
    let lastStatus = 0;
    let refusedAt = -1;
    for (let i = 0; i < REGISTRATION_MAX_PER_WINDOW + 2; i += 1) {
      const reply = await send(port, '/register', {
        method: 'POST',
        form: goodForm({
          tradeLicence: `TL-${String(i)}`,
          tin: `TIN-${String(i)}`,
          photoId: `ID-${String(i)}`,
        }),
      });
      lastStatus = reply.status;
      if (reply.location.includes('TOO_MANY_ATTEMPTS') && refusedAt === -1) refusedAt = i;
    }

    expect(refusedAt, 'the window must eventually close').toBeGreaterThan(-1);
    expect(refusedAt).toBe(REGISTRATION_MAX_PER_WINDOW);
    expect(lastStatus).toBe(303);
    expect(count(harness, 'SELECT COUNT(*) AS n FROM merchant_applications')).toBe(
      REGISTRATION_MAX_PER_WINDOW,
    );
  });

  it('counts a refused attempt too, so probing the validator is not free', () => {
    const attempts: { source: string; at: string }[] = [];
    const ports = {
      countRegistrationAttemptsSince: (source: string, since: string): number =>
        attempts.filter((a) => a.source === source && a.at > since).length,
      recordRegistrationAttempt: (source: string, _outcome: string, at: string): void => {
        attempts.push({ source, at });
      },
      pruneRegistrationAttempts: (): number => 0,
    };

    const now = '2026-09-09T12:00:00.000Z';
    for (let i = 0; i < REGISTRATION_MAX_PER_WINDOW; i += 1) {
      ports.recordRegistrationAttempt('src', 'REFUSED', now);
    }
    expect(checkRegistrationThrottle(ports, 'src', now).allowed).toBe(false);
  });

  it('never stores the caller address, only an opaque digest of it', () => {
    const transport = { trustProxy: [] } as never;
    const facts = { remoteAddress: '10.1.2.3', encryptedSocket: false, headers: {} };
    const source = registrationSource(transport, facts, 'salt-value');

    expect(source).not.toContain('10.1.2.3');
    expect(source).toMatch(/^[0-9a-f]{64}$/);
    // Same address, same bucket — which is the only property a throttle needs.
    expect(registrationSource(transport, facts, 'salt-value')).toBe(source);
    // A different address is a different bucket.
    expect(
      registrationSource(
        transport,
        { ...facts, remoteAddress: '10.1.2.4' },
        'salt-value',
      ),
    ).not.toBe(source);
  });

  it('ignores a forwarding header from an untrusted peer', () => {
    // Otherwise a caller mints a fresh bucket per request by inventing the
    // header, and the throttle stops being one. D45: there is no trust-all.
    const transport = { trustProxy: [] } as never;
    const base = { remoteAddress: '10.1.2.3', encryptedSocket: false };

    const withHeader = registrationSource(
      transport,
      { ...base, headers: { 'x-forwarded-for': '203.0.113.9' } },
      'salt',
    );
    const without = registrationSource(transport, { ...base, headers: {} }, 'salt');
    expect(withHeader).toBe(without);
  });
});

// ---------------------------------------------------------------------------
// The flag
// ---------------------------------------------------------------------------

describe('the route is one switch away from closed', () => {
  it('is on, and is its own flag rather than part of airtime vending', () => {
    // It is the only surface an unauthenticated stranger may write through. If
    // it ever needs closing — a flood, an abuse report, a regulator's question
    // — that must be one flag, not a deployment.
    expect(FEATURE_FLAGS['registration.self_service']).toBe(true);
    expect(FEATURE_FLAGS['registration.self_service']).not.toBe(
      FEATURE_FLAGS['payments.acceptance'],
    );
  });
});

// ---------------------------------------------------------------------------
// Approval gates sign-in
// ---------------------------------------------------------------------------

describe('registration is not access', () => {
  it('leaves the applicant with nothing to sign in with', async () => {
    harness = makeUiHarness('register-no-signin');
    const port = await start(harness);
    await send(port, '/register', { method: 'POST', form: goodForm() });

    // The application exists; no operator does. There is no locked account to
    // guard, which is Decision 3's argument: nothing to attack beats a guard
    // that must never be forgotten.
    const applicants = count(
      harness,
      "SELECT COUNT(*) AS n FROM merchant_users WHERE id LIKE 'operator_%'",
    );
    const applications = count(harness, 'SELECT COUNT(*) AS n FROM merchant_applications');
    expect(applications).toBe(1);
    expect(applicants).toBe(0);
  });

  it('refuses sign-in once the shop itself is suspended', async () => {
    // Before D138 this was a real hole: suspending a merchant wrote
    // `merchants.status` and sign-in never read it, so every till in a
    // suspended shop kept working until somebody signed out. `createSale`
    // refused, but the operator was still in.
    harness = makeUiHarness('register-suspended-shop');
    const h = harness;
    const session = await signInAs(h.api);
    expect(session.cookieHeader).toContain('telga_session');

    db(h).prepare("UPDATE merchants SET status = 'SUSPENDED'").run();

    const port = await start(h);
    const reply = await send(port, '/home', { cookie: session.cookieHeader });
    // Sent back to sign in rather than served the shop's screens.
    expect([302, 303, 401, 403]).toContain(reply.status);
  });
});


// ---------------------------------------------------------------------------
// Activating a machine that has never spoken to Telga
// ---------------------------------------------------------------------------


/**
 * Leave a device in exactly the state the console leaves it in after issuing a
 * code: a `PENDING` enrolment whose stored hash is of the **normalized** token,
 * not the displayed grouping.
 *
 * Uses the driver's own writers rather than hand-written SQL, so this seeds the
 * same rows the console does — a test that hand-rolls the insert can pass
 * against a schema the real code could not produce.
 */
async function issueCodeFor(
  h: UiHarness,
  deviceId: string,
): Promise<{ token: string; hash: string }> {
  const token = newEnrollmentToken();
  const derived = await hashAdminSecret(normalizeEnrollmentToken(token));
  const at = h.api.now();
  h.api.driver.saveMerchant({ id: MERCHANT_A, status: 'ACTIVE', mode: 'TRAINING', at });
  h.api.driver.saveDevice({
    id: deviceId as never,
    merchantId: MERCHANT_A,
    status: 'REGISTERED',
    deviceType: 'SMART_POS',
    at,
  });
  h.api.driver.saveDeviceEnrollment({
    deviceId: deviceId as never,
    merchantId: MERCHANT_A,
    state: 'PENDING',
    secretHash: derived.hash,
    secretSalt: derived.salt,
    expiresAt: enrollmentExpiryFrom(at) as never,
    at,
  });
  return { token, hash: derived.hash };
}

describe('a new machine can activate itself with a carried code', () => {
  it('offers the way in from the only screen it can reach', async () => {
    // A device with no key cannot sign in, so it cannot reach an authenticated
    // screen. If the link were anywhere else it would be reachable only by
    // devices that no longer need it.
    harness = makeUiHarness('activate-cta');
    const port = await start(harness);
    const reply = await send(port, '/login');
    expect(reply.body).toContain('login-activate-cta');
    expect(reply.body).toContain('href="/activate"');
  });

  it('serves the activation form with no session at all', async () => {
    harness = makeUiHarness('activate-anonymous');
    const port = await start(harness);
    const reply = await send(port, '/activate');
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('activate-form');
  });

  it('exchanges a real code for a device key, shown once and never redirected', async () => {
    harness = makeUiHarness('activate-exchange');
    const h = harness;
    const port = await start(h);

    // A device the console has created and issued a code for.
    const deviceId = 'device_new_till';
    const { token, hash } = await issueCodeFor(h, deviceId);
    expect(hash).toBeTruthy();

    const reply = await send(port, '/activate', {
      method: 'POST',
      form: { deviceId, token },
    });

    expect(reply.status).toBe(201);
    // A device key must never reach a URL, a history entry or a server log.
    expect(reply.location).toBe('');
    expect(reply.body).toContain('activated-key');

    // The enrolment is now ENROLLED, and the code's hash has been replaced by
    // the key's — which is what makes single use structural rather than a flag.
    const row = h.deps.driver.unsafeConnection
      .prepare('SELECT enrollment_state, secret_hash FROM device_enrollments WHERE device_id = ?')
      .get(deviceId) as { enrollment_state: string; secret_hash: string };
    expect(row.enrollment_state).toBe('ENROLLED');
    expect(row.secret_hash).not.toBe(hash);
  });

  it('refuses the same code a second time', async () => {
    harness = makeUiHarness('activate-replay');
    const h = harness;
    const port = await start(h);

    const deviceId = 'device_replay';
    const { token } = await issueCodeFor(h, deviceId);

    const first = await send(port, '/activate', { method: 'POST', form: { deviceId, token } });
    expect(first.status).toBe(201);

    const second = await send(port, '/activate', { method: 'POST', form: { deviceId, token } });
    expect(second.status).toBe(403);
  });

  it('answers an unknown device exactly as it answers a wrong code', async () => {
    // Otherwise this becomes a device-id oracle: an attacker with no code could
    // enumerate ids and learn which shops exist and which are mid-activation.
    harness = makeUiHarness('activate-oracle');
    const port = await start(harness);

    const unknown = await send(port, '/activate', {
      method: 'POST',
      form: { deviceId: 'device_does_not_exist', token: 'ABCDE-FGHJK-LMNPQ-RSTUV' },
    });
    expect(unknown.status).toBe(403);
    expect(unknown.body).toContain('ACTIVATION_REFUSED');
    expect(unknown.body).not.toContain('ACTIVATION_NOT_PENDING');
  });

  it('never echoes the code back on a refusal, but keeps the device id', async () => {
    harness = makeUiHarness('activate-no-echo');
    const port = await start(harness);
    const reply = await send(port, '/activate', {
      method: 'POST',
      form: { deviceId: 'device_typed_ok', token: 'WRONG-CODE-HERE-XXXXX' },
    });
    expect(reply.body).toContain('device_typed_ok');
    expect(reply.body).not.toContain('WRONG-CODE-HERE');
  });
});

// ---------------------------------------------------------------------------
// The founder's lockout
// ---------------------------------------------------------------------------

describe('four wrong PINs hold the account for five minutes', () => {
  it('is exactly what the training policy says', () => {
    // Founder instruction, 2026-09-09. Asserted on the policy rather than by
    // driving four sign-ins, because `authentication.test.ts` already proves
    // the policy is *applied* — this proves the numbers are the ones asked for.
    expect(TRAINING_LOCKOUT_POLICY.maxFailedAttempts).toBe(4);
    expect(TRAINING_LOCKOUT_POLICY.lockoutMs).toBe(5 * 60_000);
  });
});
