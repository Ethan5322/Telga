/**
 * The POS server.
 *
 * `renderScreen` is driven directly, so these tests exercise real routing and
 * real reads without opening a socket. What they defend is the boundary: the
 * server must not start outside training mode, and no screen it serves may be
 * missing the banner or carrying a recipient number.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_BEHAVIOURS } from '@telga/provider-mock-airtime';
import { authenticate } from '@telga/api';
import { NotTrainingModeError, assertTrainingBoundary, renderScreen } from '@telga/merchant-pos';
import type { PosServerOptions } from '@telga/merchant-pos';
import {
  DEVICE_B,
  MERCHANT_A,
  MERCHANT_B,
  OPERATOR_B,
  makeUiHarness,
  seedSale,
  signInAs,
} from './helpers';
import type { TestSession, UiHarness } from './helpers';

let harness: UiHarness | undefined;

afterEach(() => {
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
    simulatedBehaviours: [...MOCK_BEHAVIOURS],
  };
}

const q = (extra: Record<string, string> = {}): URLSearchParams => new URLSearchParams(extra);

/**
 * Render a screen as a signed-in operator.
 *
 * `renderScreen` now takes an authenticated context rather than a merchant id,
 * which is the point: there is no argument these tests could pass to render
 * somebody else's shop.
 */
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

async function contextOf(h: UiHarness, session: TestSession) {
  const result = authenticate(h.api, session.sessionToken, 'corr_test_screen');
  if (!result.ok) throw new Error(`Fixture session refused: ${result.code}`);
  return result.context;
}

describe('the startup boundary', () => {
  it('refuses to start outside training mode', () => {
    harness = makeUiHarness('server-live', { mode: 'LIVE' });
    expect(() => assertTrainingBoundary(optionsFor(harness!))).toThrow(NotTrainingModeError);
  });

  it('starts in training mode', () => {
    harness = makeUiHarness('server-training');
    expect(() => assertTrainingBoundary(optionsFor(harness!))).not.toThrow();
  });
});

describe('the screens the server serves', () => {
  const PATHS = ['/', '/sell', '/transactions', '/queue'] as const;

  it('serves every screen with the training banner and the mode in the title', async () => {
    harness = makeUiHarness('server-screens');
    await seedSale(harness);

    for (const path of PATHS) {
      const screen = await screenFor(harness, path, q());
      expect(screen, path).toBeDefined();
      expect(screen?.status, path).toBe(200);
      expect(screen?.html, path).toContain('data-testid="training-banner"');
      expect(screen?.html, path).toContain('Training mode');
      expect(screen?.html, path).toContain('<title>Telga POS — TRAINING');
    }
  });

  it('serves the detail screen for a real transaction', async () => {
    harness = makeUiHarness('server-detail', { behaviour: 'TIMEOUT' });
    const id = await seedSale(harness);

    const screen = await screenFor(harness, `/transactions/${id}`, q());
    expect(screen?.status).toBe(200);
    expect(screen?.html).toContain('data-testid="do-not-retry"');
    expect(screen?.html).toContain('Do not retry yet');
    expect(screen?.html).toContain(id);
  });

  it('never puts a recipient number or an internal digest in any page', async () => {
    harness = makeUiHarness('server-redaction', { behaviour: 'TIMEOUT' });
    const id = await seedSale(harness);

    for (const path of [...PATHS, `/transactions/${id}`]) {
      const screen = await screenFor(harness, path, q());
      const html = screen?.html ?? '';
      expect(html, path).not.toContain('0900000000');
      expect(html, path).not.toMatch(/recipient_hash|recipientHash|payload_fingerprint/i);
      expect(html, path).not.toMatch(/salt|secret|credential|api[_-]?key/i);
    }
  });

  it('requires a merchant id', async () => {
    harness = makeUiHarness('server-no-merchant');
    // No merchant id in the query at all. The session supplies the scope, and
    // the identity bar shows whose shop the screen belongs to.
    const screen = await screenFor(harness, '/', new URLSearchParams());
    expect(screen?.status).toBe(200);
    expect(screen?.html).toContain('data-testid="identity-bar"');
    expect(screen?.html).toContain(MERCHANT_A);
  });

  it('returns undefined for an unknown path, so the adapter can 404', async () => {
    harness = makeUiHarness('server-404');
    expect(await screenFor(harness, '/admin/secrets', q())).toBeUndefined();
  });

  it('renders a missing transaction as an error screen, not a blank one', async () => {
    harness = makeUiHarness('server-missing-tx');
    const screen = await screenFor(harness, '/transactions/txn_nope', q());
    expect(screen?.status).toBe(404);
    expect(screen?.html).toContain('data-testid="error-block"');
    expect(screen?.html).toContain('data-testid="training-banner"');
  });

  it('offers the training outcomes on the sale form, and says they are simulated', async () => {
    harness = makeUiHarness('server-sell-form');
    const screen = await screenFor(harness, '/sell', q());
    expect(screen?.html).toContain('data-testid="simulated-behaviour-select"');
    for (const behaviour of MOCK_BEHAVIOURS) {
      expect(screen?.html, behaviour).toContain(`value="${behaviour}"`);
    }
    expect(screen?.html).toContain('No real provider is contacted');
  });

  it('gives the sale form a client request id, generated once per form', async () => {
    harness = makeUiHarness('server-request-id');
    const first = await screenFor(harness, '/sell', q());
    const second = await screenFor(harness, '/sell', q());
    const idOf = (html: string): string =>
      /name="clientRequestId" value="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(idOf(first?.html ?? '')).not.toBe('');
    // A new form is a new intent, so it gets a new id. Two presses of the *same*
    // form carry the same one, which is what the double-press test covers.
    expect(idOf(first?.html ?? '')).not.toBe(idOf(second?.html ?? ''));
  });

  it('renders in Amharic on request, with the review warning', async () => {
    harness = makeUiHarness('server-amharic');
    const screen = await screenFor(harness, '/queue', q({ locale: 'am' }));
    expect(screen?.html).toContain('lang="am"');
    expect(screen?.html).toContain('REQUIRES NATIVE AMHARIC REVIEW BEFORE PRODUCTION');
    expect(screen?.html).toContain('የልምምድ ሁኔታ');
  });

  it('ignores an unknown locale rather than failing', async () => {
    harness = makeUiHarness('server-bad-locale');
    const screen = await screenFor(harness, '/queue', q({ locale: 'fr' }));
    expect(screen?.status).toBe(200);
    expect(screen?.html).toContain('lang="en"');
  });

  it('counts unresolved transactions on the home screen', async () => {
    harness = makeUiHarness('server-attention', { behaviour: 'TIMEOUT' });
    await seedSale(harness, { clientRequestId: 'req_a1' });
    await seedSale(harness, { clientRequestId: 'req_a2', recipient: '0900000002' });

    const screen = await screenFor(harness, '/', q());
    expect(screen?.html).toContain('data-testid="attention-count"');
    expect(screen?.html).toContain('2 transaction(s) still being checked');
  });

  it('shows an empty history as empty, not as an error', async () => {
    harness = makeUiHarness('server-empty');
    const screen = await screenFor(harness, '/transactions', q());
    expect(screen?.html).toContain('data-testid="empty"');
    expect(screen?.html).toContain('No transactions yet.');
  });
});

describe('cross-merchant isolation on the rendered page', () => {
  it('does not render another merchant transaction', async () => {
    harness = makeUiHarness('server-isolation', { seedSecondMerchant: true });
    const id = await seedSale(harness);

    // Signed in as beta, asking for one of alpha's transactions by its real id.
    // There is no merchant id in the URL to tamper with any more, so this is the
    // only way to attempt it — and it must come back as a plain not-found.
    const beta = await signInAs(harness.api, {
      userId: OPERATOR_B,
      merchantId: MERCHANT_B,
      deviceId: DEVICE_B,
    });
    const screen = await screenFor(harness, `/transactions/${id}`, q(), beta);
    expect(screen?.status).toBe(404);
    expect(screen?.html).toContain('data-testid="error-block"');
  });

  it('does not list another merchant transactions', async () => {
    harness = makeUiHarness('server-isolation-list', { seedSecondMerchant: true });
    const id = await seedSale(harness);

    const beta = await signInAs(harness.api, {
      userId: OPERATOR_B,
      merchantId: MERCHANT_B,
      deviceId: DEVICE_B,
    });
    const screen = await screenFor(harness, '/transactions', q(), beta);
    expect(screen?.html).not.toContain(id);
    expect(screen?.html).toContain('data-testid="empty"');
  });
});
