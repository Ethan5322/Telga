/**
 * The card screens, end to end through a live server.
 *
 * `card-payment.test.ts` proves the flow decides correctly. This proves the
 * screens render what it decided — in particular that a decline says what a
 * merchant should say out loud, and that a silent bank gets its own screen
 * rather than being dressed up as a decline.
 */

import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_BEHAVIOURS } from '@telga/provider-mock-airtime';
import { createPosServer } from '@telga/merchant-pos';
import { makeUiHarness, signInAs } from '../auth/helpers';
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

/** Present a card and authorise it, returning the rendered result page. */
async function pay(
  port: number,
  session: TestSession,
  lastFour: string,
  extra: Record<string, string> = {},
): Promise<string> {
  const form = new URLSearchParams({
    csrfToken: session.csrfToken,
    amountMinor: '12500',
    entryMode: 'INSERT',
    lastFour,
    clientRequestId: `req_${lastFour}`,
    ...extra,
  }).toString();
  const reply = await send(port, '/pay/card/authorize', {
    method: 'POST',
    cookie: session.cookieHeader,
    body: form,
  });
  return reply.body;
}

describe('presenting a card', () => {
  it('offers tap, insert and swipe, and shows the amount', async () => {
    harness = makeUiHarness('card-present');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const page = await send(port, '/pay/card/present?amount=12500', {
      cookie: session.cookieHeader,
    });
    expect(page.status).toBe(200);
    expect(page.body).toContain('data-testid="card-gesture-TAP"');
    expect(page.body).toContain('data-testid="card-gesture-INSERT"');
    expect(page.body).toContain('data-testid="card-gesture-SWIPE"');
    expect(page.body).toContain('data-testid="card-amount"');
    // The training-card chooser is fenced off and labelled, because a real
    // reader supplies the card and this block disappears with it.
    expect(page.body).toContain('data-testid="card-simulator"');
  });
});

describe('what the operator is told', () => {
  it('approves, and shows an authorisation reference', async () => {
    harness = makeUiHarness('card-approve');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const body = await pay(port, session, '4242');
    expect(body).toContain('data-testid="card-result"');
    expect(body).toContain('card__result--approved');
    expect(body).toContain('data-testid="card-auth-code"');
  });

  it('says "not enough money on the card" rather than a code', async () => {
    harness = makeUiHarness('card-declined');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const body = await pay(port, session, '0002');
    expect(body).toContain('card__result--declined');
    expect(body).toContain('Not enough money on the card');
    // The machine token must never be what a merchant reads aloud.
    expect(body).not.toContain('INSUFFICIENT_FUNDS');
  });

  it('tells the operator when another try is worth it', async () => {
    harness = makeUiHarness('card-retry');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const wrongPin = await pay(port, session, '0127');
    expect(wrongPin).toContain('data-testid="card-retryable"');

    const blocked = await pay(port, session, '9995');
    expect(blocked).not.toContain('data-testid="card-retryable"');
  });

  it('gives a silent bank its own screen, and says to stop', async () => {
    harness = makeUiHarness('card-silent');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const body = await pay(port, session, '0341');
    expect(body).toContain('data-testid="card-no-response"');

    // Checked on the element, not on the whole page: the stylesheet is
    // inlined into every response, so every result class name appears in the
    // CSS whatever the outcome was.
    const resultClass = /<div class="([^"]*card__result[^"]*)"/.exec(body)?.[1] ?? '';
    expect(resultClass).toContain('card__result--no_response');
    // Neither an approval nor a decline: the money may have moved.
    expect(resultClass).not.toContain('card__result--approved');
    expect(resultClass).not.toContain('card__result--declined');
  });

  it('shows only a masked card number, and never a CVV', async () => {
    harness = makeUiHarness('card-masked');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const body = await pay(port, session, '4242');
    expect(body).toContain('•••• •••• •••• 4242');

    // No field for one exists anywhere in Telga — PCI DSS forbids retaining a
    // verification code after authorisation, in any form.
    //
    // Scanned as *words*, in the body only. This assertion used to be a raw
    // `toContain('cvc')` over the whole document, which fails roughly one run
    // in eight hundred for a reason that has nothing to do with card data: the
    // `<head>` carries a random per-response CSP nonce, and a base64 nonce
    // eventually contains any three letters you care to look for. The same
    // trap already caught `mtn` inside a nonce in
    // `data-navigation-slipcodes.test.ts`, and it caught `cvc` here.
    //
    // Word boundaries are what make this precise rather than merely quieter.
    // `name="cvv"`, `CVV:` and `Enter CVC` all still match, because a quote,
    // colon or space is a non-word character. A nonce fragment like
    // `…j4umtnjcvcx…` does not, because it never is one. The control being
    // asserted is unchanged; only the false positives are gone.
    const bodyAt = body.indexOf('<body');
    const rendered = (bodyAt === -1 ? body : body.slice(bodyAt)).toLowerCase();
    expect(rendered).not.toMatch(/\bcvv\b/);
    expect(rendered).not.toMatch(/\bcvc\b/);
    expect(rendered).not.toMatch(/\bsecurity code\b/);

    // And the structural version of the same claim, which no amount of random
    // text can trip: the page offers no input for one. `CardRead` has no field
    // a verification code could be written to, so this is checking that the
    // screen has not grown one ahead of the type.
    expect(rendered).not.toMatch(/<input[^>]*\b(cvv|cvc|securitycode)\b/);
  });

  it('refuses an authorisation with no CSRF token', async () => {
    harness = makeUiHarness('card-csrf');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const reply = await send(port, '/pay/card/authorize', {
      method: 'POST',
      cookie: session.cookieHeader,
      body: new URLSearchParams({ amountMinor: '12500', lastFour: '4242' }).toString(),
    });
    expect(reply.status).toBe(303);
    expect(reply.location).toBe('/pay');
  });
});

describe('cash back', () => {
  it('shows the cash handed over alongside the amount', async () => {
    harness = makeUiHarness('card-cashback');
    const port = await start(harness);
    const session = await signInAs(harness.api);

    const body = await pay(port, session, '4242', {
      kind: 'CASHBACK',
      amountMinor: '20000',
      cashOutMinor: '5000',
    });
    expect(body).toContain('card__result--approved');
    expect(body).toContain('data-testid="card-cashout-value"');
  });
});
