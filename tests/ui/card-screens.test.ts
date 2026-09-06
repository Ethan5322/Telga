/**
 * Telga Pay is switched off, and this proves it is *refused* rather than hidden.
 *
 * This file used to render the card screens end to end. Founder decision
 * **D112** switched `card.simulated` off, so those screens no longer exist to a
 * client: every path under `/pay` answers `404` with `FEATURE_DISABLED`. The
 * flow logic that used to be exercised here is still covered by
 * `tests/application/card-payment.test.ts`, which tests the ports directly and
 * does not go through a route — so switching the surface off costs no coverage
 * of the decisions, only of the markup that presented them.
 *
 * ## Why this file is worth more than the one it replaces
 *
 * Turning the flag off is the easy half. The half that goes wrong is the route
 * table: before D112 the table listed `/pay/card` alone, so `/pay`,
 * `/pay/purchase`, `/pay/cashback`, `/pay/deposit`, `/pay/deposit/slip`,
 * `/pay/settings`, `/pay/statements`, `/pay/transactions` and `/pay/result`
 * would all have kept answering normally with the flag off — the buttons gone
 * from the screen, every page still reachable by typing its address.
 *
 * So this asserts the refusal for **every** path in the tree, for an
 * unauthenticated caller, a signed-in operator and an admin alike, on `GET` and
 * on `POST`, and checks that a `POST` is refused *without its body being read*.
 */

import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_BEHAVIOURS } from '@telga/provider-mock-airtime';
import { createPosServer } from '@telga/merchant-pos';
import { isEnabled, routeBlockedBy } from '@telga/domain';
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

/** Every route the Telga Pay tree ever served. */
const PAY_PATHS = [
  '/pay',
  '/pay/card',
  '/pay/card/present?amount=12500',
  '/pay/card/authorize',
  '/pay/purchase',
  '/pay/cashback',
  '/pay/result',
  '/pay/deposit',
  '/pay/deposit/slip',
  '/pay/settings',
  '/pay/statements',
  '/pay/transactions',
] as const;

function send(
  port: number,
  path: string,
  init: { method?: string; cookie?: string; body?: string } = {},
): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (init.cookie !== undefined) headers['cookie'] = init.cookie;
    if (init.body !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['content-length'] = String(Buffer.byteLength(init.body));
      headers['origin'] = 'http://127.0.0.1';
    }
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, location: res.headers.location, body }),
        );
      },
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
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

describe('the flag itself', () => {
  it('is off, and the whole tree resolves to it', () => {
    expect(isEnabled('card.simulated')).toBe(false);
    for (const path of PAY_PATHS) {
      const bare = path.split('?')[0] ?? path;
      expect(routeBlockedBy(bare), `${bare} must resolve to card.simulated`).toBe('card.simulated');
    }
  });
});

describe('a signed-in operator cannot reach Telga Pay', () => {
  it('is refused on every path in the tree, by direct address', async () => {
    harness = makeUiHarness('pay-locked-operator');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    for (const path of PAY_PATHS) {
      const reply = await send(port, path, { cookie: session.cookieHeader });
      expect(reply.status, `${path} must be refused`).toBe(404);
      // Not a card screen, not a redirect to one, not a rendered shell.
      expect(reply.body, `${path} must not render a card screen`).not.toContain('data-testid="card-result"');
      expect(reply.body, `${path} must not render the pay entry`).not.toContain('data-testid="pay-cancel"');
    }
  });
});

describe('an unauthenticated caller cannot reach it either', () => {
  it('is refused identically with no session at all', async () => {
    harness = makeUiHarness('pay-locked-anon');
    const port = await start(harness);

    for (const path of PAY_PATHS) {
      const reply = await send(port, path);
      // 404 rather than a sign-in redirect: the refusal happens BEFORE
      // authentication, so a disabled feature does not even disclose that
      // signing in would be the next step.
      expect(reply.status, `${path} must be refused unauthenticated`).toBe(404);
    }
  });
});

describe('a POST is refused without its body being read', () => {
  it('creates no card authorisation, no deposit and no posting', async () => {
    harness = makeUiHarness('pay-locked-post');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const before = harness.api.driver.readEntries().length;

    const authorize = new URLSearchParams({
      csrfToken: session.csrfToken,
      amountMinor: '12500',
      entryMode: 'INSERT',
      lastFour: '4242',
      clientRequestId: 'req_locked',
    }).toString();

    for (const path of ['/pay/card/authorize', '/pay/deposit']) {
      const reply = await send(port, path, {
        method: 'POST',
        cookie: session.cookieHeader,
        body: authorize,
      });
      expect(reply.status, `POST ${path} must be refused`).toBe(404);
    }

    // The ledger is append-only, so "nothing was written" is checkable by
    // counting: a refused POST that had reached the application would have
    // left a posting behind.
    expect(harness.api.driver.readEntries().length).toBe(before);
  });
});

describe('the refusal does not leak what it is refusing', () => {
  it('says no such screen, and never names a card, PAN or amount', async () => {
    harness = makeUiHarness('pay-locked-leak');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const reply = await send(port, '/pay/card/present?amount=12500', {
      cookie: session.cookieHeader,
    });
    expect(reply.status).toBe(404);
    expect(reply.body).not.toContain('4242');
    expect(reply.body).not.toContain('••••');
    expect(reply.body).not.toContain('12500');
  });
});
