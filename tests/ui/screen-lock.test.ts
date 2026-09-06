/**
 * The screen lock — the first Settings toggle that actually does something.
 *
 * "Require PIN to unlock" saved and changed nothing. It now decides whether
 * opening Telga demands the operator's PIN: on means it asks, off means it
 * never does. These tests pin both directions, and that locking is not the
 * same as signing out.
 */

import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_BEHAVIOURS } from '@telga/provider-mock-airtime';
import { createPosServer } from '@telga/merchant-pos';
import {
  MERCHANT_A,
  OWNER_USER,
  TEST_PIN,
  callWith,
  makeUiHarness,
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

interface Reply {
  status: number;
  location?: string;
  body: string;
}

function send(
  port: number,
  path: string,
  init: { method?: string; cookie?: string; body?: string } = {},
): Promise<Reply> {
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

/** Turn the lock on through the real settings API, as an owner would. */
async function setLock(h: UiHarness, on: boolean): Promise<void> {
  const owner = await signInAs(h.api, { userId: OWNER_USER, role: 'MERCHANT_OWNER' });
  const result = await callWith(h.api, 'POST', '/api/training/settings', {
    cookie: owner.cookieHeader,
    body: { csrfToken: owner.csrfToken, screenLockEnabled: on ? 'on' : 'off' },
  });
  if (!result.envelope.ok) throw new Error('could not write the setting');
}

const cookieOf = (s: TestSession): string => s.cookieHeader;

describe('the screen lock', () => {
  it('is off unless the shop turns it on', async () => {
    harness = makeUiHarness('lock-off');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const page = await send(port, '/dashboard', { cookie: cookieOf(session) });
    expect(page.status).toBe(200);
    expect(page.body, 'no lock was asked for').not.toContain('data-testid="lock-screen"');
  });

  it('demands the PIN once the shop turns it on', async () => {
    harness = makeUiHarness('lock-on');
    await setLock(harness, true);
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const page = await send(port, '/dashboard', { cookie: cookieOf(session) });
    expect(page.status).toBe(200);
    expect(page.body).toContain('data-testid="lock-screen"');
    expect(page.body).toContain('data-testid="lock-pin"');
    // The dashboard itself must not be behind it.
    expect(page.body).not.toContain('data-testid="dashboard-balance-pill"');
  });

  it('opens on the right PIN, and puts the operator back where they were', async () => {
    harness = makeUiHarness('lock-unlock');
    await setLock(harness, true);
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const form = new URLSearchParams({
      csrfToken: session.csrfToken,
      pin: TEST_PIN,
      returnTo: '/transactions',
    }).toString();
    const unlock = await send(port, '/unlock', {
      method: 'POST',
      cookie: cookieOf(session),
      body: form,
    });
    expect(unlock.status).toBe(303);
    expect(unlock.location).toBe('/transactions');

    // And the app is reachable again.
    const page = await send(port, '/dashboard', { cookie: cookieOf(session) });
    expect(page.body).not.toContain('data-testid="lock-screen"');
  });

  it('stays locked on a wrong PIN, and never puts it in the URL', async () => {
    harness = makeUiHarness('lock-wrong');
    await setLock(harness, true);
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const form = new URLSearchParams({
      csrfToken: session.csrfToken,
      pin: '000000',
      returnTo: '/dashboard',
    }).toString();
    const attempt = await send(port, '/unlock', {
      method: 'POST',
      cookie: cookieOf(session),
      body: form,
    });
    expect(attempt.status).toBe(303);
    expect(attempt.location).toContain('/lock');
    expect(attempt.location, 'a PIN must never reach a URL').not.toContain('000000');

    const page = await send(port, '/dashboard', { cookie: cookieOf(session) });
    expect(page.body).toContain('data-testid="lock-screen"');
  });

  it('records a wrong unlock as a PIN failure, not a login failure', async () => {
    harness = makeUiHarness('lock-scope');
    await setLock(harness, true);
    const port = await start(harness);
    const session = await signInAs(harness.api);

    await send(port, '/unlock', {
      method: 'POST',
      cookie: cookieOf(session),
      body: new URLSearchParams({
        csrfToken: session.csrfToken,
        pin: '000000',
        returnTo: '/dashboard',
      }).toString(),
    });

    // Guessing at the lock must never lock somebody out of *signing in*.
    const user = harness.deps.driver.findMerchantUser(session.userId, MERCHANT_A);
    expect(user?.failed_attempts).toBe(0);
    expect(user?.locked_until).toBeNull();
  });

  it('is a lock, not a sign-out — signing out stays reachable', async () => {
    harness = makeUiHarness('lock-signout');
    await setLock(harness, true);
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const page = await send(port, '/dashboard', { cookie: cookieOf(session) });
    // Whoever is holding the machine may not be the operator it wants.
    expect(page.body).toContain('data-testid="lock-signout"');

    const out = await send(port, '/logout', {
      method: 'POST',
      cookie: cookieOf(session),
      body: new URLSearchParams({ csrfToken: session.csrfToken }).toString(),
    });
    expect(out.status).toBe(303);
  });

  it('refuses an unlock without a CSRF token', async () => {
    harness = makeUiHarness('lock-csrf');
    await setLock(harness, true);
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const attempt = await send(port, '/unlock', {
      method: 'POST',
      cookie: cookieOf(session),
      body: new URLSearchParams({ pin: TEST_PIN, returnTo: '/dashboard' }).toString(),
    });
    expect(attempt.location).toContain('/lock');

    const page = await send(port, '/dashboard', { cookie: cookieOf(session) });
    expect(page.body, 'a correct PIN without CSRF must not unlock').toContain(
      'data-testid="lock-screen"',
    );
  });
});
