/**
 * The Telga launcher, the vending dashboard, and the Telga Pay module.
 *
 * One application, one login, one session — every assertion here defends
 * that: both module tiles are reached without a second authentication step,
 * every Coming Soon and hidden-service rule is enforced, and Telga Pay
 * (UI-only in this version) never creates a database row in any state.
 */

import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_BEHAVIOURS } from '@telga/provider-mock-airtime';
import { authenticate } from '@telga/api';
import { DASHBOARD_SERVICES, createPosServer, renderScreen, safeReturnTo } from '@telga/merchant-pos';
import type { PosServerOptions } from '@telga/merchant-pos';
import {
  DEVICE_A,
  MERCHANT_A,
  OPERATOR_A,
  TEST_PIN,
  enrolTestDevice,
  makeUiHarness,
  provisionOperator,
  seedSale,
  signInAs,
} from '../auth/helpers';
import type { TestSession, UiHarness } from '../auth/helpers';

let harness: UiHarness | undefined;
let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
  harness?.cleanup();
  harness = undefined;
});

function optionsFor(h: UiHarness): PosServerOptions {
  return {
    api: h.api,
    environment: 'test',
    catalog: [
      { productId: 'AIRTIME', label: 'Airtime 25 (simulated)', amountMinor: 2500, available: true },
    ],
    voucherCatalog: [],
    voucherNetworks: [],
    simulatedBehaviours: [...MOCK_BEHAVIOURS],
  };
}

const q = (extra: Record<string, string> = {}): URLSearchParams => new URLSearchParams(extra);

async function contextOf(h: UiHarness, session: TestSession) {
  const result = authenticate(h.api, session.sessionToken, 'corr_test_screen');
  if (!result.ok) throw new Error(`Fixture session refused: ${result.code}`);
  return result.context;
}

async function screenFor(
  h: UiHarness,
  path: string,
  query: URLSearchParams = q(),
  session?: TestSession,
): Promise<{ status: number; html: string } | undefined> {
  const s = session ?? (await signInAs(h.api));
  const auth = await contextOf(h, s);
  return renderScreen(optionsFor(h), {
    path,
    query,
    context: auth,
    cookieHeader: s.cookieHeader,
    csrfToken: s.csrfToken,
  });
}

// --- one small real-socket block, for the pre-session behaviour that
// `renderScreen` alone cannot exercise (it always receives an already
// authenticated context) -------------------------------------------------

function rawRequest(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; location?: string; setCookies: readonly string[]; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: init.headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            setCookies: res.headers['set-cookie'] ?? [],
            body,
          }),
        );
      },
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

async function startServer(h: UiHarness): Promise<number> {
  server = createPosServer(optionsFor(h));
  return new Promise((resolve) => {
    server?.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}

describe('post-login destination', () => {
  // Inverted **again**, and this is the order that stands (D101, 2026-08-30).
  //
  // It has been both ways round. It first defaulted to `/launcher`, which put
  // a second chooser after sign-in. That was changed to `/dashboard` with the
  // launcher moved in front of login. The founder then asked for login first
  // and the launcher behind it — so the default is the launcher once more, but
  // for the opposite reason: it is now the screen you *open Telga from*, not
  // the one you passed through on the way in.
  it('safeReturnTo defaults to the launcher, which is where signing in lands', () => {
    expect(safeReturnTo(undefined)).toBe('/launcher');
    expect(safeReturnTo(null)).toBe('/launcher');
    expect(safeReturnTo('')).toBe('/launcher');
    expect(safeReturnTo('not-a-path')).toBe('/launcher');
    // Off-site destinations are still refused — unchanged, and the reason this
    // function exists.
    expect(safeReturnTo('//evil.example.com')).toBe('/launcher');
    expect(safeReturnTo('https://evil.example.com')).toBe('/launcher');
    // `/splash` no longer exists; an old bookmark normalises to the launcher.
    expect(safeReturnTo('/splash')).toBe('/launcher');
    // And the launcher is a legitimate destination now, not a loop to break.
    expect(safeReturnTo('/launcher')).toBe('/launcher');
    // An explicit, safe returnTo is still honoured.
    expect(safeReturnTo('/sell')).toBe('/sell');
    expect(safeReturnTo('/pay')).toBe('/pay');
  });

  it('a real login lands on the launcher, not straight into a module', async () => {
    harness = makeUiHarness('launcher-login-redirect');
    await provisionOperator(harness.api);
    const deviceSecret = await enrolTestDevice(harness.api);
    const port = await startServer(harness);

    const form = new URLSearchParams({
      userId: OPERATOR_A,
      pin: TEST_PIN,
      deviceId: DEVICE_A,
      deviceSecret,
    }).toString();
    const response = await rawRequest(port, '/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(Buffer.byteLength(form)),
      },
      body: form,
    });

    expect(response.status).toBe(303);
    expect(response.location).toBe('/launcher');
  });

  it('/launcher needs a session — it is no longer the screen before sign-in', async () => {
    harness = makeUiHarness('launcher-unauthenticated');
    const port = await startServer(harness);

    // The reverse of what this asserted before. A chooser shown to whoever
    // picks the machine up tells them what Telga does before they prove who
    // they are, and the module names are shop information.
    const response = await rawRequest(port, '/launcher');
    expect(response.status).toBe(303);
    expect(response.location).toContain('/login');
    expect(response.body).not.toContain('data-testid="launcher-tile-telga"');
    expect(response.body).not.toContain('data-testid="launcher-tile-telgapay"');
  });
});

describe('the remembered device identifier', () => {
  it('is set on sign-in, prefills the login form, and never carries the device key', async () => {
    harness = makeUiHarness('device-cookie');
    await provisionOperator(harness.api);
    const deviceSecret = await enrolTestDevice(harness.api);
    const port = await startServer(harness);

    const form = new URLSearchParams({
      userId: OPERATOR_A,
      pin: TEST_PIN,
      deviceId: DEVICE_A,
      deviceSecret,
    }).toString();
    const login = await rawRequest(port, '/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(Buffer.byteLength(form)),
      },
      body: form,
    });
    expect(login.status).toBe(303);

    const deviceCookie = login.setCookies.find((c) => c.startsWith('telga_device='));
    expect(deviceCookie, 'the device id is remembered for the next sign-in').toBeDefined();
    expect(deviceCookie).toContain(DEVICE_A);

    // This assertion used to be the opposite: the key was never written to
    // any cookie. The founder specified that an idle timeout must cost an
    // operator their PIN and nothing else (D74), which cannot be true unless
    // the key is remembered. It is inverted rather than deleted, and what it
    // now guards is the mitigation: the cookie must be `httpOnly`, so page
    // script cannot read the key even though the browser holds it.
    const keyCookie = login.setCookies.find((c) => c.startsWith('telga_device_key='));
    expect(keyCookie, 'the device key is remembered (D74)').toBeDefined();
    expect(keyCookie).toContain(deviceSecret);
    expect(keyCookie?.toLowerCase(), 'script must never be able to read it').toContain('httponly');
    expect(keyCookie?.toLowerCase()).toContain('samesite=strict');

    // The operator is remembered too, but only for the browser session — no
    // `Max-Age`, so a restart asks who is at the counter while an idle
    // timeout does not.
    const operatorCookie = login.setCookies.find((c) => c.startsWith('telga_operator='));
    expect(operatorCookie).toBeDefined();
    expect(operatorCookie?.toLowerCase(), 'a restart must forget the operator').not.toContain(
      'max-age',
    );

    // The PIN is still never written anywhere. That has not changed and must not.
    for (const c of login.setCookies) expect(c).not.toContain(TEST_PIN);

    // Returning to sign-in after an idle timeout: device, key and operator
    // are all filled in, so the operator supplies a PIN alone.
    const page = await rawRequest(port, '/login?error=SESSION_IDLE_EXPIRED', {
      headers: {
        cookie: [
          `telga_device=${encodeURIComponent(DEVICE_A)}`,
          `telga_device_key=${encodeURIComponent(deviceSecret)}`,
          `telga_operator=${encodeURIComponent(OPERATOR_A)}`,
        ].join('; '),
      },
    });
    expect(page.body).toContain(`value="${DEVICE_A}"`);
    expect(page.body).toContain(`value="${OPERATOR_A}"`);
    expect(page.body, 'the key field is prefilled so only the PIN is retyped').toContain(
      `value="${deviceSecret}"`,
    );
    expect(page.body, 'the PIN is never prefilled').not.toContain(TEST_PIN);
  });

  /**
   * Also inverted. Signing out used to leave the device enrolled on the
   * grounds that it is an operator action, not an un-enrolment — and that is
   * still true of the *server* record, which only `revokeDevice` changes.
   * What changed is the founder's model (D74): sign-out is now the deliberate
   * "forget everything on this machine" action, which is what makes it the
   * right thing to press when a device changes hands.
   */
  it('clears every remembered credential, because that is what sign-out now means', async () => {
    harness = makeUiHarness('device-cookie-logout');
    await provisionOperator(harness.api);
    const deviceSecret = await enrolTestDevice(harness.api);
    const port = await startServer(harness);

    const form = new URLSearchParams({
      userId: OPERATOR_A,
      pin: TEST_PIN,
      deviceId: DEVICE_A,
      deviceSecret,
    }).toString();
    const login = await rawRequest(port, '/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(Buffer.byteLength(form)),
      },
      body: form,
    });
    const cookieHeader = login.setCookies.map((c) => c.split(';')[0]).join('; ');
    const csrf = decodeURIComponent(
      login.setCookies.find((c) => c.startsWith('telga_csrf='))?.split(';')[0]?.split('=')[1] ?? '',
    );

    const logoutBody = new URLSearchParams({ csrfToken: csrf }).toString();
    const out = await rawRequest(port, '/logout', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(Buffer.byteLength(logoutBody)),
        cookie: cookieHeader,
        origin: 'http://127.0.0.1:4321',
      },
      body: logoutBody,
    });

    // All four: session, CSRF, device, device key and operator.
    const cleared = out.setCookies.map((c) => c.split('=')[0]);
    for (const name of [
      'telga_session',
      'telga_csrf',
      'telga_device',
      'telga_device_key',
      'telga_operator',
    ]) {
      expect(cleared, `${name} must be cleared by an explicit sign-out`).toContain(name);
    }
    // Cleared means emptied, not merely re-sent.
    const keyCookie = out.setCookies.find((c) => c.startsWith('telga_device_key='));
    expect(keyCookie).not.toContain(deviceSecret);

    // The enrolment itself is untouched — only the browser forgot. Removing a
    // device from the merchant is still a separate server-side action.
    expect(harness?.deps.driver.findDeviceEnrollment(DEVICE_A)?.enrollment_state).toBe('ENROLLED');
  });
});

describe('the launcher', () => {
  // The post-sign-in launcher is gone: it was the second chooser. The public
  // one is covered by `launcher-entry-flow.test.ts`; what is left to check
  // here is that the authenticated tree no longer renders one.
  it('no longer offers a second app chooser after sign-in', async () => {
    harness = makeUiHarness('launcher-tiles');
    const dashboard = await screenFor(harness, '/dashboard');
    expect(dashboard?.status).toBe(200);
    expect(dashboard?.html, 'the chooser belongs before sign-in').not.toContain(
      'data-testid="launcher-tile-telga"',
    );
    expect(dashboard?.html).not.toContain('class="launcher__tile"');
  });

  it('both tiles are reachable from the same session with no re-authentication', async () => {
    harness = makeUiHarness('launcher-same-session');
    const session = await signInAs(harness.api);
    const telga = await screenFor(harness, '/dashboard', q(), session);
    const pay = await screenFor(harness, '/pay', q(), session);
    expect(telga?.status).toBe(200);
    expect(pay?.status).toBe(200);
  });
});

describe('the Telga vending dashboard', () => {
  /**
   * This test used to assert the opposite — that the Profit pill carried *no*
   * number — because until the training profit model existed there was no
   * honest figure to put there. There is one now (Decision Log D69), so the
   * assertion is inverted rather than deleted: what it guards is unchanged,
   * namely that the pill never shows a number the ledger cannot account for.
   */
  it('shows a Profit pill whose figure comes from the ledger, starting at zero', async () => {
    harness = makeUiHarness('dashboard-balance');
    const screen = await screenFor(harness, '/dashboard');
    const html = screen?.html ?? '';
    expect(html).toContain('data-testid="dashboard-balance-pill"');
    expect(html).toContain('ETB');
    expect(html).toContain('data-testid="dashboard-profit-pill"');
    // A shop that has sold nothing has earned nothing, and says so with a
    // figure rather than with the old "Not yet available".
    expect(html).toMatch(/Profit:\s*0\.00\s*ETB/);
  });

  it('shows exactly what the ledger credited, never a figure recomputed for display', async () => {
    harness = makeUiHarness('dashboard-profit-ledger');
    await seedSale(harness);

    const ledgerProfitMinor = harness.deps.driver.profitForDay(
      MERCHANT_A,
      harness.deps.now().slice(0, 10),
    );
    expect(ledgerProfitMinor, 'the sale should have credited a training profit').toBeGreaterThan(0);

    const screen = await screenFor(harness, '/dashboard');
    const shown = /Profit:\s*([\d,.]+)\s*ETB/.exec(screen?.html ?? '');
    expect(shown, 'the Profit pill should carry a formatted figure').not.toBeNull();
    expect(Number((shown?.[1] ?? '').replace(/,/g, ''))).toBe(ledgerProfitMinor / 100);
  });

  it('shows the merchant identifier', async () => {
    harness = makeUiHarness('dashboard-merchant');
    const screen = await screenFor(harness, '/dashboard');
    expect(screen?.html).toContain('data-testid="dashboard-merchant"');
    expect(screen?.html).toContain(MERCHANT_A);
  });

  it('the Airtime tile opens the approved voucher sequence', async () => {
    // Changed deliberately: Airtime used to open the legacy `/sell` form,
    // which is a direct airtime-to-cellphone flow, not the approved voucher
    // sequence. `/sell` is still reachable — it is simply no longer what the
    // Airtime tile means. See tests/ui/voucher-ux.test.ts.
    harness = makeUiHarness('dashboard-airtime-tile');
    const screen = await screenFor(harness, '/dashboard');
    expect(screen?.html).toContain('data-testid="service-tile-airtime"');
    expect(screen?.html).toContain('href="/vouchers/airtime"');

    const voucherEntry = await screenFor(harness, '/vouchers/airtime');
    expect(voucherEntry?.status).toBe(200);
    // `/sell` remains served.
    const sell = await screenFor(harness, '/sell');
    expect(sell?.status).toBe(200);
  });

  it('the Vouchers tile reaches the completed Stage 2 flow', async () => {
    harness = makeUiHarness('dashboard-vouchers-tile');
    const screen = await screenFor(harness, '/dashboard');
    expect(screen?.html).toContain('data-testid="service-tile-vouchers"');
    expect(screen?.html).toContain('href="/vouchers"');
    const vouchers = await screenFor(harness, '/vouchers');
    expect(vouchers?.status).toBe(200);
  });

  it('renders every declared service tile, and every tile has a working destination', async () => {
    harness = makeUiHarness('dashboard-classification');
    // One session for the whole test. Signing in per tile would exceed the
    // ten-logins-per-minute limit and fail as RATE_LIMITED — a fixture
    // problem masquerading as a dashboard problem.
    const session = await signInAs(harness.api);
    const screen = await screenFor(harness, '/dashboard', q(), session);
    const html = screen?.html ?? '';

    // Every tile in the declared array is rendered — the grid and the array
    // cannot drift apart.
    for (const tile of DASHBOARD_SERVICES) {
      expect(html, tile.id).toContain(`data-testid="service-tile-${tile.id}"`);
      expect(html, tile.id).toContain(`href="${tile.href}"`);
    }

    // And every destination actually resolves: no dead buttons.
    for (const tile of DASHBOARD_SERVICES) {
      const target = await screenFor(harness, tile.href, q(), session);
      expect(target?.status, `${tile.id} -> ${tile.href}`).toBe(200);
    }

    // The four bottom-nav destinations resolve too.
    for (const href of ['/dashboard', '/pay', '/', '/transactions']) {
      const target = await screenFor(harness, href, q(), session);
      expect(target?.status, `nav -> ${href}`).toBe(200);
    }
  });

  it('Re-print opens the transaction list, now that reprint has a real backend', async () => {
    harness = makeUiHarness('reprint-nav');
    const session = await signInAs(harness.api);

    const nav = await screenFor(harness, '/dashboard', q(), session);
    expect(nav?.html).toContain('data-testid="dashboard-nav-reprint"');
    expect(nav?.html).toContain('href="/transactions"');

    // Seeded, because an empty history correctly renders the empty state
    // rather than an empty table — the table only exists when there is
    // something to put in it.
    await seedSale(harness);
    const list = await screenFor(harness, '/transactions', q(), session);
    expect(list?.status).toBe(200);
    expect(list?.html).toContain('data-testid="transaction-table"');
  });

  it('Data Coming Soon creates no transaction and offers BACK/HOME', async () => {
    harness = makeUiHarness('dashboard-data-coming-soon');
    const before = harness.driver.findTransactionsByMerchant(MERCHANT_A).length;
    const screen = await screenFor(harness, '/dashboard/data');
    expect(screen?.status).toBe(200);
    expect(screen?.html).toContain('data-testid="coming-soon-message"');
    expect(screen?.html).toContain('href="/dashboard"');
    expect(screen?.html).toContain('href="/launcher"');
    expect(harness.driver.findTransactionsByMerchant(MERCHANT_A).length).toBe(before);
  });

  it('Electricity Coming Soon creates no transaction', async () => {
    harness = makeUiHarness('dashboard-electricity-coming-soon');
    const before = harness.driver.findTransactionsByMerchant(MERCHANT_A).length;
    const screen = await screenFor(harness, '/dashboard/electricity');
    expect(screen?.status).toBe(200);
    expect(harness.driver.findTransactionsByMerchant(MERCHANT_A).length).toBe(before);
  });

  it('has a working link back to /launcher', async () => {
    harness = makeUiHarness('dashboard-back-link');
    const screen = await screenFor(harness, '/dashboard');
    expect(screen?.html).toContain('data-testid="back-to-launcher"');
    expect(screen?.html).toContain('href="/launcher"');
  });
});

describe('Telga Pay — UI only', () => {
  it('always shows the training banner and never invents a number', async () => {
    harness = makeUiHarness('pay-banner');
    const screen = await screenFor(harness, '/pay');
    const html = screen?.html ?? '';
    expect(html).toContain('data-testid="pay-banner"');
    expect(html).toContain('no real processor connected');
    // No prior sale exists in this fresh harness, so the honest empty state shows.
    expect(html).toContain('data-testid="pay-no-transactions"');
  });

  it('labels a real sale as Telga sales, never as Telga Pay income', async () => {
    harness = makeUiHarness('pay-real-sales');
    await seedSale(harness);
    const screen = await screenFor(harness, '/pay');
    const html = screen?.html ?? '';
    if (html.includes('data-testid="pay-todays-sales"')) {
      expect(html).toContain("Today&#39;s Telga sales");
      expect(html).not.toContain('Telga Pay income');
    }
  });

  it('Purchase and Cashback amount screens render with keypad, note, Pay Now and Cancel', async () => {
    harness = makeUiHarness('pay-amount-screens');
    for (const path of ['/pay/purchase', '/pay/cashback']) {
      const screen = await screenFor(harness, path);
      const html = screen?.html ?? '';
      expect(html, path).toContain('data-testid="pay-amount-input"');
      expect(html, path).toContain('data-testid="pay-note-input"');
      expect(html, path).toContain('data-testid="pay-now"');
      expect(html, path).toContain('data-testid="pay-cancel"');
      expect(html, path).toContain('data-testid="pay-amount-clear"');
    }
  });

  it('Pay Now opens the card-acceptance simulator with the entered amount carried forward', async () => {
    harness = makeUiHarness('pay-card-carry');
    const screen = await screenFor(
      harness,
      '/pay/card',
      q({ flow: 'purchase', amount: '150', note: 'till float' }),
    );
    const html = screen?.html ?? '';
    expect(screen?.status).toBe(200);
    expect(html).toContain('data-testid="pay-card-prompt"');
    expect(html).toContain('Please Insert, Swipe or Tap Card');
    expect(html).toContain('data-testid="pay-card-tap"');
    expect(html).toContain('data-testid="pay-card-insert"');
    expect(html).toContain('data-testid="pay-card-swipe"');
    expect(html).toContain('amount=150');
    expect(html).toContain('Visa');
    expect(html).toContain('training examples only');
  });

  it.each(['tap', 'insert', 'swipe'] as const)(
    'the %s method leads to an approved, clearly-simulated result and creates no transaction',
    async (method) => {
      harness = makeUiHarness(`pay-approved-${method}`);
      const before = harness.driver.findTransactionsByMerchant(MERCHANT_A).length;
      const screen = await screenFor(
        harness,
        '/pay/result',
        q({ flow: 'purchase', amount: '100', note: '', outcome: 'approved' }),
      );
      expect(screen?.status).toBe(200);
      expect(screen?.html).toContain('data-outcome="approved"');
      expect(screen?.html).toContain('Training simulation only');
      expect(harness.driver.findTransactionsByMerchant(MERCHANT_A).length).toBe(before);
    },
  );

  it('declined creates no transaction and shows a clear decline message', async () => {
    harness = makeUiHarness('pay-declined');
    const before = harness.driver.findTransactionsByMerchant(MERCHANT_A).length;
    const screen = await screenFor(
      harness,
      '/pay/result',
      q({ flow: 'cashback', amount: '50', note: '', outcome: 'declined' }),
    );
    expect(screen?.html).toContain('data-tone="NEGATIVE"');
    expect(screen?.html).toContain('Declined');
    expect(harness.driver.findTransactionsByMerchant(MERCHANT_A).length).toBe(before);
  });

  it('read error is a clear red state, offers retry, and creates no transaction', async () => {
    harness = makeUiHarness('pay-read-error');
    const before = harness.driver.findTransactionsByMerchant(MERCHANT_A).length;
    const screen = await screenFor(
      harness,
      '/pay/result',
      q({ flow: 'purchase', amount: '75', note: '', outcome: 'read_error' }),
    );
    expect(screen?.html).toContain('data-tone="NEGATIVE"');
    expect(screen?.html).toContain('role="alert"');
    expect(screen?.html).toContain('data-testid="pay-retry"');
    expect(harness.driver.findTransactionsByMerchant(MERCHANT_A).length).toBe(before);
  });

  it('cancelled creates no transaction and returns safely with no stale data carried forward', async () => {
    harness = makeUiHarness('pay-cancelled');
    const before = harness.driver.findTransactionsByMerchant(MERCHANT_A).length;
    const screen = await screenFor(
      harness,
      '/pay/result',
      q({ flow: 'purchase', amount: '30', note: '', outcome: 'cancelled' }),
    );
    expect(screen?.html).toContain('Cancelled');
    expect(harness.driver.findTransactionsByMerchant(MERCHANT_A).length).toBe(before);
    // Returning to /pay afterward starts clean — no amount/note is echoed.
    const back = await screenFor(harness, '/pay');
    expect(back?.html).not.toContain('value="30"');
  });

  it('no card data or PIN appears anywhere: not in this module\'s URLs, and not in any rendered page', async () => {
    harness = makeUiHarness('pay-no-secrets');
    for (const path of ['/pay', '/pay/purchase', '/pay/cashback']) {
      const screen = await screenFor(harness, path);
      expect(screen?.html.toLowerCase(), path).not.toMatch(/\bpin\b.*input|card.?number|cvv/i);
    }
    const card = await screenFor(harness, '/pay/card', q({ flow: 'purchase', amount: '10', note: '' }));
    expect(card?.html).not.toMatch(/name="pin"|name="cardNumber"/);
  });

  it('every button on every Telga Pay screen either navigates or is a working control', async () => {
    harness = makeUiHarness('pay-no-dead-buttons');
    const entry = await screenFor(harness, '/pay');
    expect(entry?.html).toMatch(/href="\/pay\/purchase"/);
    expect(entry?.html).toMatch(/href="\/pay\/cashback"/);
    expect(entry?.html).toMatch(/href="\/launcher"/);
  });
});
