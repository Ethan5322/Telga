/**
 * What is allowed above the header and below the footer — and what is not.
 *
 * Founder instruction, 2026-09-14: *"sign out is everywhere, it must be on
 * settings only… anything before above header or below footer must be inside
 * setting, but the balance and profit always be on Telga Vending where its."*
 *
 * Reported again on 2026-09-15, from a running app, showing all three of the
 * things that were supposed to be gone:
 *
 * ```
 * operator_1 · merchant_alpha · Device device_1
 * Sign out
 * Last updated from Telga: 2026-09-15T05:05:31.256Z
 * ```
 *
 * The removal had been made in the source and asserted nowhere, so nothing
 * would have caught it coming back — and nothing could distinguish "the code is
 * wrong" from "the device is running an old build". These tests settle that
 * question against the code, permanently.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_BEHAVIOURS } from '@telga/provider-mock-airtime';
import { authenticate } from '@telga/api';
import { TRAINING_DATA_CATEGORIES, loginScreen, renderScreen, renderToHtml } from '@telga/merchant-pos';
import type { PosServerOptions } from '@telga/merchant-pos';
import { MERCHANT_A, makeUiHarness, signInAs } from '../auth/helpers';
import type { TestSession, UiHarness } from '../auth/helpers';
import { TEST_VOUCHER_CATALOG, TEST_VOUCHER_NETWORKS } from './helpers';

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
    voucherCatalog: TEST_VOUCHER_CATALOG.map((entry) => ({
      ...entry,
      label: `${entry.network} — ${entry.productId}`,
    })),
    voucherNetworks: [...TEST_VOUCHER_NETWORKS],
    dataCategories: [...TRAINING_DATA_CATEGORIES],
    simulatedBehaviours: [...MOCK_BEHAVIOURS],
  };
}

async function screenAt(h: UiHarness, path: string, s: TestSession): Promise<string> {
  const result = authenticate(h.api, s.sessionToken, 'corr_header_footer');
  if (!result.ok) throw new Error(`the fixture session was refused: ${result.code}`);
  const screen = await renderScreen(optionsFor(h), {
    path,
    query: new URLSearchParams(),
    context: result.context,
    cookieHeader: s.cookieHeader,
    csrfToken: s.csrfToken,
  });
  if (screen === undefined) throw new Error(`no screen rendered at ${path}`);
  return screen.html;
}


/** The screens a shopkeeper actually stands in front of all day. */
const EVERYDAY = ['/dashboard', '/sell', '/statements', '/menu'];

describe('the identity strip is not on every screen', () => {
  it('names no operator, merchant or device on the everyday screens', async () => {
    harness = makeUiHarness('chrome-identity');
    const session = await signInAs(harness.api);

    for (const path of EVERYDAY) {
      const html = await screenAt(harness, path, session);

      // The exact strip the founder photographed.
      expect(html, `${path} must not carry the identity bar`).not.toContain(
        'data-testid="identity-bar"',
      );
      expect(html, `${path} must not name the operator`).not.toContain(
        'data-testid="identity-operator"',
      );
      expect(html, `${path} must not name the device`).not.toContain(
        'data-testid="identity-device"',
      );
      // And not by accident of a missing test id, either. The raw id printed
      // under the dashboard title until 2026-09-15 — a shopkeeper's home
      // screen read "merchant_alpha".
      expect(html, `${path} must not print the merchant id`).not.toContain(MERCHANT_A);
    }
  });

  it('does not print the server timestamp under every screen', async () => {
    // "Last updated from Telga: 2026-09-15T05:05:31.256Z" — a raw ISO string
    // under every screen, which is a developer's diagnostic rather than
    // anything a shopkeeper reads, and the third line of the founder's report.
    harness = makeUiHarness('chrome-servertime');
    const session = await signInAs(harness.api);

    for (const path of EVERYDAY) {
      const html = await screenAt(harness, path, session);
      expect(html, `${path} must not carry the server clock`).not.toContain(
        'data-testid="server-time"',
      );
      expect(html, `${path} must not carry the phrase`).not.toContain('Last updated from Telga');
    }
  });
});

describe('the screens shown before anyone signs in', () => {
  /**
   * The gap this closes, found by fingerprinting the live site.
   *
   * `page()` lost its footer, the tests above proved it on four authenticated
   * screens, the suite went green and it deployed — and `/login` still printed
   * `Telga time: 2026-09-15T16:23:44.256Z`, because **the sign-in screens have
   * their own shell**. Worded differently from the sentence the founder quoted,
   * so a search for that sentence never found it.
   *
   * The first screen a shopkeeper sees was the last one still showing a raw ISO
   * timestamp. Every test above ran on screens that require a session; none of
   * them could ever have caught it.
   */
  /**
   * Rendered directly rather than through `renderScreen`, because the sign-in
   * screen is reachable with **no session** and the route renderer requires
   * one. That asymmetry is the whole reason the clock survived here: every
   * other test in this file needs a signed-in operator, so none of them could
   * ever have reached this screen.
   */
  const signIn = (): string =>
    renderToHtml(
      loginScreen({
        chrome: {
          locale: 'en',
          // The screen refuses to render in any other mode, which is the
          // guard `RefusedNonTrainingModeError` exists for. Supplied, not
          // bypassed.
          mode: 'TRAINING',
          serverTime: '2026-09-15T16:23:44.256Z',
          csrfToken: 'test-csrf',
        } as never,
      } as never),
    );

  it('shows no clock on the sign-in screen', () => {
    const html = signIn();
    expect(html, 'the first screen a shopkeeper sees').not.toContain(
      'data-testid="server-time"',
    );
    expect(html).not.toContain('Telga time:');
    expect(html).not.toContain('Last updated from Telga');
    // And not merely because the timestamp changed shape.
    expect(html).not.toContain('2026-09-15T16:23:44');
  });

  it('still renders the sign-in form itself', () => {
    // Without this, "the clock is gone" would also pass on a blank page.
    expect(signIn()).toContain('form');
  });
});

describe('sign out is in one place', () => {
  it('is absent from every everyday screen', async () => {
    harness = makeUiHarness('chrome-signout-absent');
    const session = await signInAs(harness.api);

    for (const path of EVERYDAY) {
      const html = await screenAt(harness, path, session);
      // The control that ends a shift must not sit beside the control that
      // makes a sale. A shopkeeper reaching for the sale must not be able to
      // reach past it.
      expect(html, `${path} must not offer sign out`).not.toContain('action="/logout"');
    }
  });

  it('is on Settings, where the founder put it', async () => {
    // The other half. Without this, "sign out appears nowhere" would also pass
    // — and an app a shopkeeper cannot sign out of is a worse defect than the
    // one being fixed.
    harness = makeUiHarness('chrome-signout-present');
    const session = await signInAs(harness.api);
    const html = await screenAt(harness, '/settings', session);

    expect(html).toContain('data-testid="settings-signout-form"');
    expect(html).toContain('action="/logout"');
  });
});

describe('the device review of 2026-09-15', () => {
  /**
   * The founder reviewed every screen on real hardware and asked for the
   * scaffolding to come off all of them at once. These assert the four global
   * rules on the everyday screens, so "I removed it from the one I looked at"
   * cannot happen again — which is exactly how the sign-in clock survived.
   */
  it('shows no training banner anywhere', async () => {
    harness = makeUiHarness('review-banner');
    const session = await signInAs(harness.api);
    for (const path of EVERYDAY) {
      const html = await screenAt(harness, path, session);
      // The rendered element, and the class it used — the stylesheet is
      // inlined into every page, so a surviving CSS rule would read as a
      // surviving banner and hide the opposite mistake just as well.
      expect(html, `${path} must not carry the training banner`).not.toContain(
        'banner--training',
      );
      expect(html, `${path} must not say TRAINING on screen`).not.toContain(
        'data-testid="training-banner"',
      );
      expect(html, `${path} must not print the environment`).not.toContain('Environment:');
    }
  });

  it('offers no way back to the launcher', async () => {
    harness = makeUiHarness('review-launcher-link');
    const session = await signInAs(harness.api);
    for (const path of EVERYDAY) {
      const html = await screenAt(harness, path, session);
      expect(html, `${path} must not link to the launcher`).not.toContain('href="/launcher"');
    }
  });

  it('draws no decorative band above the screen', async () => {
    // It was `main::before`, so it appeared on every page at once — which is
    // what made an ornament read as a defect.
    harness = makeUiHarness('review-band');
    const session = await signInAs(harness.api);
    const html = await screenAt(harness, '/dashboard', session);
    expect(html).not.toContain('repeating-linear-gradient(135deg, var(--telga-vellum-rubric)');
  });
});

describe('settings carries what the footer lost', () => {
  it('names the operator, the shop, the device and the last sync', async () => {
    // Removing the strip without rehoming it would delete information a
    // support call opens with, rather than relocating it. The chrome comment
    // claimed Settings carried this before Settings actually did.
    harness = makeUiHarness('chrome-settings-identity');
    const session = await signInAs(harness.api);
    const html = await screenAt(harness, '/settings', session);

    expect(html).toContain('data-testid="settings-identity"');
    expect(html).toContain('data-testid="settings-identity-operator"');
    expect(html).toContain('data-testid="settings-identity-shop"');
    expect(html).toContain('data-testid="settings-identity-synced"');
    // The shop id belongs here — this is the screen somebody reaches on
    // purpose, which is the only place it was ever any use.
    expect(html).toContain(MERCHANT_A);
  });

  it('shows the time in words a person can read back, not an ISO string', async () => {
    // The footer printed `2026-09-15T05:05:31.256Z`: a machine's notation,
    // shown to a shopkeeper. The date and the minute are what gets read down
    // a telephone; the milliseconds and the T never were.
    harness = makeUiHarness('chrome-settings-time');
    const session = await signInAs(harness.api);
    const html = await screenAt(harness, '/settings', session);

    expect(html).not.toMatch(/data-testid="settings-identity-synced">[^<]*T\d\d:\d\d:\d\d/);
    expect(html).not.toContain('.256Z');
    expect(html).toMatch(/data-testid="settings-identity-synced">\d{4}-\d\d-\d\d \d\d:\d\d</);
  });
});

describe('what stays on Telga Vending', () => {
  it('keeps the balance and the profit on the dashboard', async () => {
    // Founder instruction, asked twice: *"the balance and profit always be on
    // telga vending where its."* These were never the clutter — they are read
    // constantly — and a tidy-up that removed them would be a worse screen.
    harness = makeUiHarness('chrome-balance-stays');
    const session = await signInAs(harness.api);
    const html = await screenAt(harness, '/dashboard', session);

    expect(html).toContain('data-testid="dashboard-balance-pill"');
    expect(html, 'and the profit beside it').toContain('dashboard__pill');
  });
});
