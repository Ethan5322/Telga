/**
 * "Lock the screen after N seconds" actually sets the window.
 *
 * Found by driving the running application, 2026-08-30. The setting saved
 * correctly — the field came back `value="45"` — and then did nothing, because
 * the page only ever emitted the **session** idle timeout.
 *
 * Two different windows had been collapsed into one number:
 *
 * | Attribute | Window | What happens |
 * |---|---|---|
 * | `data-lock-after-s` | the shop's setting | **Locks.** Session lives, a PIN reopens it |
 * | `data-idle-timeout-s` | the server's session config | **Signs out.** Session ends |
 *
 * A shop that set 45 seconds got the session's 60, and its own setting was
 * inert. These tests hold the two apart.
 *
 * The client timers are an enhancement either way: `screenIsLocked` re-checks
 * the lock window on the server for every request, so a page that never fires
 * them changes nothing that matters.
 */

import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_BEHAVIOURS } from '@telga/provider-mock-airtime';
import { createPosServer } from '@telga/merchant-pos';
import { OWNER_USER, makeUiHarness, signInAs } from '../auth/helpers';
import type { TestSession, UiHarness } from '../auth/helpers';

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

/**
 * Settings are an **owner** control.
 *
 * `POS_MANAGE_SETTINGS` is withheld from `MERCHANT_OPERATOR` on purpose — an
 * assistant at the counter sells; changing the printed slip, the displayed
 * margin or the lock window is the shop owner's decision. Signing in as the
 * default operator here made every save a silent refusal.
 */
const asOwner = (h: UiHarness) =>
  signInAs(h.api, { userId: OWNER_USER, role: 'MERCHANT_OWNER' });

const bodyTag = (html: string): string => /<body[^>]*>/.exec(html)?.[0] ?? '';

/** Save the shop's preferences, unlocking first if the lock is already on. */
async function savePreferences(
  port: number,
  session: TestSession,
  fields: Record<string, string>,
): Promise<void> {
  let settings = await send(port, '/settings', { cookie: session.cookieHeader });
  if (settings.body.includes('lock-screen')) {
    await send(port, '/unlock', {
      method: 'POST',
      cookie: session.cookieHeader,
      body: new URLSearchParams({
        csrfToken: session.csrfToken,
        pin: '481502',
        returnTo: '/settings',
      }).toString(),
    });
    settings = await send(port, '/settings', { cookie: session.cookieHeader });
  }
  const saved = await send(port, '/settings/preferences', {
    method: 'POST',
    cookie: session.cookieHeader,
    body: new URLSearchParams({ csrfToken: session.csrfToken, ...fields }).toString(),
  });
  // A refused save is silent — it redirects like a successful one — so the
  // helper asserts rather than letting the test fail later on a missing
  // attribute and send the reader looking in the wrong place.
  if (!settings.body.includes('settings-preferences-form')) {
    throw new Error(`settings page did not render the preferences form: ${settings.status}`);
  }
  if (saved.status !== 303) throw new Error(`preferences save returned ${saved.status}`);
  if ((saved.location ?? '').includes('error')) {
    throw new Error(`preferences save refused: ${saved.location ?? ''}`);
  }
}

/** A dashboard rendered with the lock cleared, so the body tag can be read. */
async function unlockedDashboard(port: number, session: TestSession): Promise<string> {
  const first = await send(port, '/dashboard', { cookie: session.cookieHeader });
  if (!first.body.includes('lock-screen')) return first.body;
  await send(port, '/unlock', {
    method: 'POST',
    cookie: session.cookieHeader,
    body: new URLSearchParams({
      csrfToken: session.csrfToken,
      pin: '481502',
      returnTo: '/dashboard',
    }).toString(),
  });
  return (await send(port, '/dashboard', { cookie: session.cookieHeader })).body;
}

describe('the shop’s lock window reaches the page', () => {
  it('emits the seconds the shop saved, not the session timeout', async () => {
    harness = makeUiHarness('lock-window-45');
    const port = await start(harness);
    const session = await asOwner(harness);

    await savePreferences(port, session, { screenLockEnabled: 'on', lockSeconds: '45' });
    const tag = bodyTag(await unlockedDashboard(port, session));

    // The bug: this said 60000, the session's window, whatever the shop chose.
    expect(tag).toContain('data-lock-after-s="45"');
  });

  it('keeps the sign-out window separate from the lock window', async () => {
    // Locking keeps the session and asks for a PIN. Signing out ends it. One
    // number cannot mean both, which is how the setting came to be ignored.
    harness = makeUiHarness('lock-window-separate');
    const port = await start(harness);
    const session = await asOwner(harness);

    await savePreferences(port, session, { screenLockEnabled: 'on', lockSeconds: '90' });
    const tag = bodyTag(await unlockedDashboard(port, session));

    expect(tag).toContain('data-lock-after-s="90"');
    expect(tag).toContain('data-idle-timeout-s=');
    expect(tag).not.toContain('data-lock-after-s="60"');
  });

  it('emits no lock window at all when the shop has the lock off', async () => {
    // An absent attribute, not a zero: the client reads `|| '0'` and skips the
    // timer, so "off" must mean the attribute is not there.
    harness = makeUiHarness('lock-window-off');
    const port = await start(harness);
    const session = await asOwner(harness);

    await savePreferences(port, session, { screenLockEnabled: 'off', lockSeconds: '45' });
    const tag = bodyTag(await unlockedDashboard(port, session));

    expect(tag).not.toContain('data-lock-after-ms');
    // The session sign-out is unaffected by the shop's lock setting.
    expect(tag).toContain('data-idle-timeout-s=');
  });

  it('honours a changed value rather than the first one saved', async () => {
    harness = makeUiHarness('lock-window-change');
    const port = await start(harness);
    const session = await asOwner(harness);

    await savePreferences(port, session, { screenLockEnabled: 'on', lockSeconds: '30' });
    expect(bodyTag(await unlockedDashboard(port, session))).toContain('data-lock-after-s="30"');

    await savePreferences(port, session, { screenLockEnabled: 'on', lockSeconds: '120' });
    expect(bodyTag(await unlockedDashboard(port, session))).toContain('data-lock-after-s="120"');
  });
});

describe('the server does not trust the page', () => {
  it('locks on its own clock, whatever the page was told', async () => {
    // The attribute is an enhancement. `screenIsLocked` re-checks the window
    // for every request, so a page edited to a longer one gains nothing.
    harness = makeUiHarness('lock-window-server');
    const port = await start(harness);
    const session = await asOwner(harness);

    await savePreferences(port, session, { screenLockEnabled: 'on', lockSeconds: '15' });
    // A fresh session has never been unlocked, so the server locks it.
    const fresh = await asOwner(harness);
    const screen = await send(port, '/dashboard', { cookie: fresh.cookieHeader });
    expect(screen.body).toContain('lock-screen');
  });
});
