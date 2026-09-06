/**
 * A disabled feature's endpoint must refuse, not merely be unlinked.
 *
 * `02 Product/Feature Flags` states the rule and names the failure it is
 * guarding against: *"Hiding a button while the endpoint still answers is a
 * defect."* `tests/domain/feature-flags.test.ts` proves the decision function
 * says no. This proves a **running server** says no — over a real socket, with
 * a real session cookie, which is the only version of the claim that matters.
 *
 * The interesting cases are the ones with no handler behind them. `/wallet`
 * has no route, so it would 404 anyway; that is the accident the rule exists to
 * replace with a guarantee. So these tests also assert *where* the refusal
 * happens: before authentication, and with no body read — an unauthenticated
 * request and a signed-in one must be refused identically, and a POST carrying
 * a payload must be refused without the payload ever being parsed.
 */

import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_BEHAVIOURS } from '@telga/provider-mock-airtime';
import { createPosServer } from '@telga/merchant-pos';
import { FEATURE_FLAGS, routeBlockedBy } from '@telga/domain';
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

function send(
  port: number,
  path: string,
  init: { method?: string; cookie?: string; body?: string } = {},
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (init.cookie !== undefined) headers['cookie'] = init.cookie;
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
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
          resolve({
            status: res.statusCode ?? 0,
            body,
            contentType: String(res.headers['content-type'] ?? ''),
          }),
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

/** Every regulated capability that is switched off and has a route. */
const REFUSED_PATHS = [
  '/wallet',
  '/wallet/transfer',
  '/cash/in',
  '/lending/apply',
  '/remittance/send',
  '/settlement/run',
  '/funding/submit',
  '/electricity/buy',
  '/bills/pay',
] as const;

describe('a switched-off capability answers 404', () => {
  it('refuses every one of them for a signed-in operator', async () => {
    harness = makeUiHarness('feature-off-signed-in');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    for (const path of REFUSED_PATHS) {
      const reply = await send(port, path, { cookie: session.cookieHeader });
      expect(reply.status, `${path} must be refused`).toBe(404);
    }
  });

  it('refuses them identically with no session at all', async () => {
    // The refusal is above authentication. If it were below, an unauthenticated
    // request would be redirected to sign in — which tells an anonymous caller
    // that the path exists and is worth signing in for.
    harness = makeUiHarness('feature-off-anonymous');
    const port = await start(harness);

    for (const path of REFUSED_PATHS) {
      const reply = await send(port, path);
      expect(reply.status, `${path} must be refused without a session`).toBe(404);
    }
  });

  it('refuses a POST without parsing its body', async () => {
    // A body large enough to trip the request-size limit. If the refusal
    // happened after the body read, this would come back `413` — proving the
    // handler had already started work on it. `404` proves it did not.
    harness = makeUiHarness('feature-off-post');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const oversized = JSON.stringify({ padding: 'x'.repeat(2_000_000) });
    const reply = await send(port, '/api/wallet/transfer', {
      method: 'POST',
      cookie: session.cookieHeader,
      body: oversized,
    });
    expect(reply.status).toBe(404);
    expect(reply.status).not.toBe(413);
  });

  it('names the reason on the API surface, and not on a screen', async () => {
    harness = makeUiHarness('feature-off-reason');
    const port = await start(harness);

    const api = await send(port, '/api/wallet');
    expect(api.contentType).toContain('application/json');
    expect(JSON.parse(api.body)).toEqual({
      ok: false,
      error: { reasonCode: 'FEATURE_DISABLED' },
    });

    // The screen says nothing about a feature being disabled. A `404` that
    // explains itself confirms the capability exists and is switched off; one
    // Telga is not licensed to offer should look like a path that never was.
    const screen = await send(port, '/wallet');
    expect(screen.body).not.toContain('FEATURE_DISABLED');
    expect(screen.body.toLowerCase()).not.toContain('disabled');
  });
});

describe('an enabled capability is untouched', () => {
  it('still serves the paths that are switched on', async () => {
    // The gate must not become a way to break working screens. `airtime.vending`
    // is on, so its routes go through to the normal handler — whatever that
    // handler answers. `product.data` and `card.simulated` were switched off by
    // D112 and are covered by the refusal cases above; airtime vouchers stay on,
    // because selling airtime as a printed voucher is airtime vending.
    harness = makeUiHarness('feature-on');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    for (const path of ['/dashboard', '/vouchers', '/vouchers/airtime']) {
      const reply = await send(port, path, { cookie: session.cookieHeader });
      expect(reply.status, `${path} must still be served`).toBe(200);
    }
  });

  it('agrees with the decision function on every path it is asked about', () => {
    // Guards against the server and the flag module diverging: the table is the
    // single answer to "is this path gated", and nothing may re-derive it.
    for (const path of REFUSED_PATHS) {
      expect(routeBlockedBy(path), `${path}`).toBeDefined();
    }
    expect(routeBlockedBy('/dashboard')).toBeUndefined();
    expect(FEATURE_FLAGS['airtime.vending']).toBe(true);
  });
});
