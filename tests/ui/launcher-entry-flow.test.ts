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

  it('lands on the launcher after signing in, not on a dashboard', () => {
    // `safeReturnTo`'s default is what an operator gets with no explicit
    // destination. It used to be `/dashboard`, which skipped Telga entirely.
    expect(safeReturnTo(undefined)).toBe('/launcher');
    expect(safeReturnTo('')).toBe('/launcher');
    // An old `/splash` bookmark normalises to the launcher rather than being
    // silently redirected somewhere else.
    expect(safeReturnTo('/splash')).toBe('/launcher');
    // And the launcher is now a legitimate destination, not a loop to break.
    expect(safeReturnTo('/launcher')).toBe('/launcher');
    // Off-site destinations are still refused.
    expect(safeReturnTo('//evil.example')).toBe('/launcher');
    expect(safeReturnTo('https://evil.example')).toBe('/launcher');
  });
});

describe('the launcher is one Telga button', () => {
  it('offers Telga and nothing else', async () => {
    harness = makeUiHarness('entry-one-button');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const launcher = await get(port, '/launcher', session.cookieHeader);
    expect(launcher.status).toBe(200);
    expect(launcher.body).toContain('data-testid="launcher-telga-button"');

    // The modules are NOT on this page. That is the whole point of the change:
    // Telga is one thing you open, and a second choice here would undo it.
    expect(launcher.body).not.toContain('data-testid="launcher-tile-telga"');
    expect(launcher.body).not.toContain('data-testid="launcher-tile-telgapay"');
  });

  it('carries the real mark — the same artwork printed on a slip', async () => {
    // A drawn substitute was tried here and rejected: it read as a diagram of
    // the logo rather than the logo. The button an operator opens Telga with
    // and the mark on the paper they hand a customer are now the same thing.
    harness = makeUiHarness('entry-mark');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const launcher = await get(port, '/launcher', session.cookieHeader);
    const at = launcher.body.indexOf('data-testid="launcher-telga-button"');
    const button = launcher.body.slice(at, launcher.body.indexOf('</a>', at));
    expect(button).toContain('/assets/telga-logo.png');
    expect(button).toContain('data-testid="telga-logo"');
  });

  it('says what the button does', async () => {
    harness = makeUiHarness('entry-cue');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const launcher = await get(port, '/launcher', session.cookieHeader);
    expect(launcher.body).toContain('Tap Telga to open');
    expect(hrefOf(launcher.body, 'launcher-telga-button')).toBe('/launcher/apps');
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
    expect(apps.body).toContain('📱');
    // Telga Pay came back on by founder decision **D124**, so its tile is drawn
    // again. The rule this pair has always enforced is unchanged: a tile
    // appears only when the screen behind it answers. A tile leading to a 404
    // would be the "inaccessible, not refused after the tap" failure CLAUDE.md
    // §7 forbids — and so would a working screen with no way in.
    expect(apps.body).toContain('data-testid="launcher-tile-telgapay"');
    expect(apps.body).toContain('💳');
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

  it('offers a way back to the launcher', async () => {
    harness = makeUiHarness('entry-back');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const apps = await get(port, '/launcher/apps', session.cookieHeader);
    expect(hrefOf(apps.body, 'launcher-apps-back')).toBe('/launcher');
  });
});
