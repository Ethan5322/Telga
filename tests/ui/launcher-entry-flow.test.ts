/**
 * The entry flow: sign in → Telga → the two modules → the one you chose.
 *
 * ## This order is the reverse of what it was
 *
 * It used to be launcher first: a public chooser showing both modules, each
 * leading to its own sign-in. That was replaced on 2026-08-30 (D101). The order
 * is now:
 *
 *   `/login` → `/launcher` (one Telga button) → `/launcher/apps` (📱 · 💳) →
 *   `/dashboard` or `/pay`
 *
 * Two things these tests hold in place, because both were explicit:
 *
 *   1. **Login is the first screen.** Nothing about Telga's modules is shown to
 *      whoever picks the machine up before they prove who they are.
 *   2. **The modules are on their own page.** Opening Telga *navigates*; it
 *      does not expand a panel underneath the button. A version that put the
 *      button and both modules on one screen reads as two things beside a logo
 *      rather than one product that opens.
 */

import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_BEHAVIOURS } from '@telga/provider-mock-airtime';
import { createPosServer, safeReturnTo } from '@telga/merchant-pos';
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

function get(
  port: number,
  path: string,
  cookie?: string,
): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (cookie !== undefined) headers['cookie'] = cookie;
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, location: res.headers.location, body }),
      );
    });
    req.on('error', reject);
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

const hrefOf = (html: string, testId: string): string =>
  (
    new RegExp(`href="([^"]*)"[^>]*data-testid="${testId}"`).exec(html)?.[1] ??
    new RegExp(`data-testid="${testId}"[^>]*href="([^"]*)"`).exec(html)?.[1] ??
    ''
  ).replace(/&amp;/g, '&');

describe('login is the first screen', () => {
  it('sends an anonymous visitor to sign in, not to a chooser', async () => {
    harness = makeUiHarness('entry-login-first');
    const port = await start(harness);

    const root = await get(port, '/');
    expect(root.status).toBe(303);
    expect(root.location).toContain('/login');
  });

  it('refuses the launcher to anyone without a session', async () => {
    // The launcher used to be public. A chooser shown before sign-in tells a
    // stranger holding the machine what Telga does and what it is worth.
    harness = makeUiHarness('entry-launcher-guarded');
    const port = await start(harness);

    for (const path of ['/launcher', '/launcher/apps']) {
      const reply = await get(port, path);
      expect(reply.status, `${path} must not be public`).toBe(303);
      expect(reply.location, path).toContain('/login');
    }
  });

  it('shows no module names or shop data before sign-in', async () => {
    harness = makeUiHarness('entry-login-clean');
    const port = await start(harness);

    const login = await get(port, '/login');
    expect(login.status).toBe(200);
    expect(login.body).not.toContain('data-testid="launcher-tile-telga"');
    expect(login.body).not.toContain('data-testid="launcher-tile-telgapay"');
    expect(login.body).not.toContain('data-testid="launcher-telga-button"');
    // The training banner is the one thing that belongs on every screen.
    expect(login.body.toLowerCase()).toContain('training');
  });

  it('lands on the service chooser after signing in', () => {
    // The default an operator gets with no explicit destination. It was
    // `/dashboard` once, which skipped Telga entirely; then `/launcher`, a card
    // that opened the chooser; and now the chooser itself — founder device
    // review, 2026-09-15 (D168).
    expect(safeReturnTo(undefined)).toBe('/launcher/apps');
    expect(safeReturnTo('')).toBe('/launcher/apps');
    // Old addresses normalise FORWARD rather than being refused. An APK
    // already in a shop's hands asks for both of these, and a 404 would strand
    // it at a dead page with no way on.
    expect(safeReturnTo('/splash')).toBe('/launcher/apps');
    expect(safeReturnTo('/launcher')).toBe('/launcher/apps');
    // Off-site destinations are still refused.
    expect(safeReturnTo('//evil.example')).toBe('/launcher/apps');
    expect(safeReturnTo('https://evil.example')).toBe('/launcher/apps');
  });
});

describe('the middle screen is gone', () => {
  /**
   * Three tests here asserted a screen that showed Telga as a single button,
   * carried the printed mark, and said "Tap Telga to open". It was built to the
   * founder's own description and removed after they used it (D168).
   *
   * Inverted rather than deleted. A deleted test leaves nothing saying the new
   * rule holds — and this session already found a defect that survived a fix
   * because a test was guarding the old behaviour rather than the new one.
   */
  it('opens the chooser at /launcher, not a card that opens the chooser', async () => {
    harness = makeUiHarness('entry-no-middle');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const launcher = await get(port, '/launcher', session.cookieHeader);
    expect(launcher.status, 'the address still answers').toBe(200);

    // The card is gone...
    expect(launcher.body).not.toContain('data-testid="launcher-telga-button"');
    expect(launcher.body).not.toContain('Tap Telga to open');
    // ...and what answers is the chooser itself.
    expect(launcher.body).toContain('data-testid="launcher-tile-telga"');
  });

  it('answers the Android shell default address the same way', async () => {
    // `/` is what the Android shell opens by default, and `/splash` is in old
    // bookmarks. Both go where they were trying to go rather than 404.
    harness = makeUiHarness('entry-root');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    for (const path of ['/', '/splash']) {
      const screen = await get(port, path, session.cookieHeader);
      expect(screen.status, `${path} must answer`).toBe(200);
      expect(screen.body, `${path} must open the chooser`).toContain(
        'data-testid="launcher-tile-telga"',
      );
    }
  });
});

describe('the modules are on their own page', () => {
  it('shows both modules, now that Telga Pay is back', async () => {
    harness = makeUiHarness('entry-apps');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const apps = await get(port, '/launcher/apps', session.cookieHeader);
    expect(apps.status).toBe(200);
    expect(apps.body).toContain('data-testid="launcher-tile-telga"');
    /**
     * One mark each — reversed on the founder's device review (D168).
     *
     * This asserted **no** emoji, on the reasoning that a glyph standing in for
     * a missing icon set is a placeholder that ships. That holds for a
     * catalogue of twelve services, where a row of emoji becomes noise. It does
     * not hold for **two** cards a shopkeeper chooses between all day: two
     * marks are an identifier, twelve are a placeholder.
     *
     * They are `aria-hidden`, so a screen reader announces the name alone.
     */
    expect(apps.body, 'the vending mark').toContain('\u{1F3EA}');
    expect(apps.body, 'the card mark').toContain('\u{1F4B3}');
    // Telga Pay came back on by founder decision **D124**, so its tile is drawn
    // again. The rule this pair has always enforced is unchanged: a tile
    // appears only when the screen behind it answers. A tile leading to a 404
    // would be the "inaccessible, not refused after the tap" failure CLAUDE.md
    // §7 forbids — and so would a working screen with no way in.
    expect(apps.body).toContain('data-testid="launcher-tile-telgapay"');
    // Inside Telga everything is Telga, so the mark cannot be what tells the
    // two modules apart — and it is not drawn here at all.
    expect(apps.body).not.toContain('/assets/app-vending.png');
    expect(apps.body).not.toContain('/assets/app-pay.png');
    expect(apps.body).not.toContain('data-testid="telga-glyph"');
  });

  it('does not repeat the Telga button an operator just pressed', async () => {
    harness = makeUiHarness('entry-no-repeat');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const apps = await get(port, '/launcher/apps', session.cookieHeader);
    expect(apps.body).not.toContain('data-testid="launcher-telga-button"');
  });

  it('sends each module to its own screen, with no second sign-in', async () => {
    // Both modules are inside one session. Neither starts a second
    // authentication flow — that was true before and stays true.
    harness = makeUiHarness('entry-destinations');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const apps = await get(port, '/launcher/apps', session.cookieHeader);
    expect(hrefOf(apps.body, 'launcher-tile-telga')).toBe('/dashboard');

    const reply = await get(port, '/dashboard', session.cookieHeader);
    expect(reply.status, '/dashboard').toBe(200);

    // Both halves for the second module too: a tile that leads somewhere, and
    // a screen that answers. Asserting only the tile is how a button to a 404
    // survives a suite; asserting only the screen is how a working feature ends
    // up with no way in.
    expect(hrefOf(apps.body, 'launcher-tile-telgapay')).toBe('/pay');
    const pay = await get(port, '/pay', session.cookieHeader);
    expect(pay.status, '/pay must be served').toBe(200);
  });

  it('offers no way back, because there is nothing behind it', async () => {
    // The BACK button led to the card this review removed. A button returning
    // an operator to a screen that no longer exists is worse than no button.
    harness = makeUiHarness('entry-back');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const apps = await get(port, '/launcher/apps', session.cookieHeader);
    expect(apps.body).not.toContain('data-testid="launcher-apps-back"');
  });
});
