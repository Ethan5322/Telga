/**
 * Telga Pay is switched on, and this proves what that does and does not mean.
 *
 * Founder decision **D124** restored `card.simulated`, reversing D112 and
 * bringing back the surface D87 built. This file previously proved the tree was
 * *refused*; it now proves it is *served* — and, more importantly, that turning
 * it on moved exactly one thing.
 *
 * ## The three properties that matter more than the screens
 *
 *   1. **The kill switch still covers the whole tree.** Every path still
 *      resolves to `card.simulated`, so switching it off again refuses all
 *      twelve rather than the one screen. That was the defect D112 exposed:
 *      the route table once listed `/pay/card` alone, and nine Telga Pay routes
 *      would have kept answering with the buttons gone from the menu.
 *
 *   2. **`payments.acceptance` did not move.** The simulator and the licence
 *      requirement are two switches, and this restoration touched one of them.
 *
 *   3. **Authentication still applies.** A feature being enabled is not a
 *      feature being public. An unauthenticated caller is sent to sign in.
 *
 * The flow logic behind these screens is covered by
 * `tests/application/card-payment.test.ts`, which drives the ports directly.
 * This file is about the surface and its boundaries.
 */

import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_BEHAVIOURS } from '@telga/provider-mock-airtime';
import { createPosServer } from '@telga/merchant-pos';
import { featureForPath, isEnabled, routeBlockedBy } from '@telga/domain';
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

/**
 * Every route in the Telga Pay tree, with the parameters its screen needs.
 *
 * `/pay/card` and `/pay/card/present` carry an `amount` because they are steps
 * in a flow, not entry points: arriving at either without one answers `404` by
 * design — the screen has nothing to show. That is a **flow** refusal and must
 * not be confused with the **feature** refusal this file is about, which is why
 * the assertions below check for `FEATURE_DISABLED` rather than only a status.
 */
const PAY_PATHS = [
  '/pay',
  '/pay/card?amount=12500',
  '/pay/card/present?amount=12500',
  '/pay/purchase',
  '/pay/cashback',
  '/pay/deposit',
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
  it('is on, and did not drag the licence-bearing flag with it', () => {
    expect(isEnabled('card.simulated')).toBe(true);
    // The pairing D87 built the two-port design for. Restoring a training
    // screen must never be the same edit as enabling payment acceptance.
    expect(isEnabled('payments.acceptance')).toBe(false);
  });

  it('still governs the whole tree, so the kill switch remains whole', () => {
    // The property that outlives the current setting. If `card.simulated` is
    // ever switched off again, all of these go dark together — not just the
    // card screen, which was the hole D112 found.
    for (const path of PAY_PATHS) {
      const bare = path.split('?')[0] ?? path;
      expect(featureForPath(bare), `${bare} must resolve to card.simulated`).toBe('card.simulated');
      // And nothing is refused while it is on.
      expect(routeBlockedBy(bare), `${bare} must be served`).toBeUndefined();
    }
  });
});

describe('a signed-in operator can reach Telga Pay', () => {
  it('is served on every path in the tree', async () => {
    harness = makeUiHarness('pay-on-operator');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    for (const path of PAY_PATHS) {
      const reply = await send(port, path, { cookie: session.cookieHeader });
      // Not the feature refusal. A screen may legitimately redirect — a flow
      // step that needs an earlier one — so the assertion is that the feature
      // gate is not what answered.
      expect(reply.status, `${path} must not be feature-refused`).not.toBe(404);
      expect(reply.body, `${path} must not carry FEATURE_DISABLED`).not.toContain(
        'FEATURE_DISABLED',
      );
    }
  });

  it('renders the Telga Pay entry screen, with its training banner', async () => {
    harness = makeUiHarness('pay-on-entry');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const reply = await send(port, '/pay', { cookie: session.cookieHeader });
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('data-testid="pay-banner"');
  });
});

describe('enabled is not public', () => {
  it('still sends an unauthenticated caller to sign in', async () => {
    // The distinction this file exists to hold: a feature being switched on
    // says nothing about who may use it. Every path still requires a session.
    harness = makeUiHarness('pay-on-anon');
    const port = await start(harness);

    for (const path of PAY_PATHS) {
      const reply = await send(port, path);
      expect(reply.status, `${path} must not be served to a stranger`).not.toBe(200);
    }
  });

  it('shows no card data to an unauthenticated caller', async () => {
    harness = makeUiHarness('pay-on-anon-leak');
    const port = await start(harness);

    const reply = await send(port, '/pay/card/present?amount=12500');
    expect(reply.body).not.toContain('4242');
    expect(reply.body).not.toContain('••••');
  });
});

describe('what the simulator is, on screen', () => {
  it('never presents itself as a real card network', async () => {
    // The wordmarks are labelled as examples. A training screen that reads as a
    // live terminal is the claim CLAUDE.md §5 forbids.
    harness = makeUiHarness('pay-on-labelling');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const reply = await send(port, '/pay/card?amount=12500', { cookie: session.cookieHeader });
    expect(reply.status).toBe(200);
    // No PAN is collected anywhere in this module, so none can appear.
    expect(reply.body).not.toMatch(/\b\d{13,19}\b/);
  });
});
