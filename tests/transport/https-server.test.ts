/**
 * A real HTTPS listener, real sockets, real cookies.
 *
 * Everything else in `tests/transport/` is a pure decision. This file starts an
 * actual `node:https` server on a real port and speaks to it, because the
 * questions it answers cannot be answered any other way:
 *
 *   - does a browser actually receive `Secure; HttpOnly; SameSite=Strict`?
 *   - does a session survive a TLS handshake and a redirect?
 *   - does a session token appear anywhere in a body, a URL or a header it
 *     should not?
 *   - does the listener close cleanly?
 *
 * `rejectUnauthorized: false` appears once, in the test client, because the
 * certificate is self-signed by construction. That is a statement about the
 * fixture, not about the server: nothing in the application relaxes trust.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_BEHAVIOURS } from '@telga/provider-mock-airtime';
import { createPosServer } from '@telga/merchant-pos';
import type { PosServerOptions, TransportConfig } from '@telga/merchant-pos';
import { generateSelfSignedCertificate } from './certs';
import {
  DEVICE_A,
  MERCHANT_A,
  OPERATOR_A,
  TEST_PIN,
  enrolTestDevice,
  makeUiHarness,
  provisionOperator,
} from '../auth/helpers';
import type { UiHarness } from '../auth/helpers';

let harness: UiHarness | undefined;
let server: Server | undefined;
let dirs: string[] = [];

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    server = undefined;
  }
  harness?.cleanup();
  harness = undefined;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

interface Response {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
  readonly setCookies: readonly string[];
}

/** One HTTPS request. No third-party client; `node:https` is enough. */
function fetchOnce(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: init.method ?? 'GET',
        headers: { host: 'telga-training.localhost', ...(init.headers ?? {}) },
        // The fixture certificate is self-signed by construction. Nothing in
        // the application relaxes trust; only this client does.
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString('utf8'),
            setCookies: res.headers['set-cookie'] ?? [],
          });
        });
      },
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

function tlsPaths(): { certPath: string; keyPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'telga-https-'));
  dirs.push(dir);
  const generated = generateSelfSignedCertificate();
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  writeFileSync(certPath, generated.certificatePem);
  writeFileSync(keyPath, generated.privateKeyPem);
  return { certPath, keyPath };
}

async function startHttps(name: string): Promise<{ port: number; h: UiHarness }> {
  harness = makeUiHarness(name);
  await provisionOperator(harness.api);
  const deviceSecret = await enrolTestDevice(harness.api);
  (harness as { deviceSecret?: string }).deviceSecret = deviceSecret;

  const { certPath, keyPath } = tlsPaths();
  const transport: TransportConfig = {
    trainingTransport: 'HTTPS',
    bindHost: '127.0.0.1',
    bindPort: 0,
    trustProxy: false,
    tlsTermination: 'IN_PROCESS',
    tlsCertificatePath: certPath,
    tlsPrivateKeyPath: keyPath,
    allowedHosts: ['telga-training.localhost', '127.0.0.1'],
    allowedOrigins: [],
    sessionCookieSecure: true,
    hstsEnabled: true,
    hstsMaxAgeSeconds: 15_552_000,
    gracefulShutdownTimeoutMs: 2_000,
  };

  const options: PosServerOptions = {
    api: { ...harness.api, authConfig: { ...harness.api.authConfig, secureCookies: true } },
    environment: 'test-https',
    catalog: [
      { productId: 'AIRTIME', label: 'Airtime 25 (simulated)', amountMinor: 2500, available: true },
    ],
    simulatedBehaviours: [...MOCK_BEHAVIOURS],
    transport,
  };

  server = createPosServer(options);
  const port = await new Promise<number>((resolve) => {
    server?.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
  return { port, h: harness };
}

const deviceSecretOf = (h: UiHarness): string => (h as { deviceSecret?: string }).deviceSecret ?? '';

const cookieHeaderFrom = (setCookies: readonly string[]): string =>
  setCookies.map((c) => c.split(';')[0]).join('; ');

async function signIn(port: number, h: UiHarness): Promise<{ cookie: string; csrf: string }> {
  const form = new URLSearchParams({
    userId: OPERATOR_A,
    pin: TEST_PIN,
    deviceId: DEVICE_A,
    deviceSecret: deviceSecretOf(h),
  }).toString();

  const response = await fetchOnce(port, '/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(form)),
      origin: 'https://telga-training.localhost',
    },
    body: form,
  });

  expect(response.status).toBe(303);
  const csrf =
    response.setCookies
      .find((c) => c.startsWith('telga_csrf='))
      ?.split(';')[0]
      ?.split('=')[1] ?? '';
  return { cookie: cookieHeaderFrom(response.setCookies), csrf: decodeURIComponent(csrf) };
}

describe('serving over real TLS', () => {
  it('starts, serves the sign-in screen, and closes cleanly', async () => {
    const { port } = await startHttps('https-basic');
    const response = await fetchOnce(port, '/login');

    expect(response.status).toBe(200);
    expect(response.body).toContain('data-testid="login-form"');
    expect(response.body).toContain('data-testid="training-banner"');
    expect(response.body).toContain('Internal training only');
  });

  it('sets Secure, HttpOnly and SameSite on the session cookie', async () => {
    const { port, h } = await startHttps('https-cookies');
    const form = new URLSearchParams({
      userId: OPERATOR_A,
      pin: TEST_PIN,
      deviceId: DEVICE_A,
      deviceSecret: deviceSecretOf(h),
    }).toString();

    const response = await fetchOnce(port, '/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(Buffer.byteLength(form)),
        origin: 'https://telga-training.localhost',
      },
      body: form,
    });

    const session = response.setCookies.find((c) => c.startsWith('telga_session='));
    expect(session).toBeDefined();
    expect(session).toContain('Secure');
    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Strict');
    expect(session).toContain('Path=/');
    // The server-side row owns both expiries; a browser-side lifetime would be
    // a second, weaker opinion that the client controls.
    expect(session).not.toContain('Max-Age');

    const csrf = response.setCookies.find((c) => c.startsWith('telga_csrf='));
    expect(csrf).toContain('Secure');
    // Not a credential: readable so a page can re-read it after a redirect.
    expect(csrf).not.toContain('HttpOnly');
  });

  it('keeps a session valid across requests over TLS', async () => {
    const { port, h } = await startHttps('https-session');
    const { cookie } = await signIn(port, h);

    const home = await fetchOnce(port, '/', { headers: { cookie } });
    expect(home.status).toBe(200);
    expect(home.body).toContain('data-testid="identity-bar"');
    expect(home.body).toContain(MERCHANT_A);
  });

  it('sends an unauthenticated request to sign in', async () => {
    const { port } = await startHttps('https-unauth');
    const home = await fetchOnce(port, '/');
    expect(home.status).toBe(303);
    expect(String(home.headers['location'])).toContain('/login');
  });
});

describe('security headers over TLS', () => {
  it('carries the full header set on a page', async () => {
    const { port } = await startHttps('https-headers');
    const response = await fetchOnce(port, '/login');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(String(response.headers['permissions-policy'])).toContain('camera=()');
    expect(String(response.headers['cache-control'])).toContain('no-store');
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
  });

  it('serves a nonce policy with no unsafe-inline', async () => {
    const { port } = await startHttps('https-csp');
    const response = await fetchOnce(port, '/login');
    const csp = String(response.headers['content-security-policy']);

    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");

    // The nonce in the header is the nonce on the page's own script and style.
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(response.body).toContain(`<script nonce="${nonce as string}">`);
    expect(response.body).toContain(`<style nonce="${nonce as string}">`);
  });

  it('issues a different nonce on every response', async () => {
    const { port } = await startHttps('https-nonce-fresh');
    const first = String((await fetchOnce(port, '/login')).headers['content-security-policy']);
    const second = String((await fetchOnce(port, '/login')).headers['content-security-policy']);
    // A reused nonce would be one an injected script could learn and replay.
    expect(first).not.toBe(second);
  });

  it('sends HSTS over HTTPS when it is enabled', async () => {
    const { port } = await startHttps('https-hsts');
    const response = await fetchOnce(port, '/login');
    expect(String(response.headers['strict-transport-security'])).toContain('max-age=15552000');
  });
});

describe('what never appears on the wire', () => {
  it('keeps the session token out of the body, the URL and every header but Set-Cookie', async () => {
    const { port, h } = await startHttps('https-no-token-leak');
    const { cookie } = await signIn(port, h);
    const token = cookie.split('telga_session=')[1]?.split(';')[0] ?? '';
    expect(token.length).toBeGreaterThan(10);

    for (const path of ['/', '/sell', '/transactions', '/queue']) {
      const response = await fetchOnce(port, path, { headers: { cookie } });
      expect(response.body, path).not.toContain(token);
      expect(response.body, path).not.toContain(decodeURIComponent(token));

      const headerText = JSON.stringify(
        Object.fromEntries(Object.entries(response.headers).filter(([k]) => k !== 'set-cookie')),
      );
      expect(headerText, path).not.toContain(token);
    }
  });

  it('keeps session-sensitive pages uncacheable', async () => {
    const { port, h } = await startHttps('https-no-cache');
    const { cookie } = await signIn(port, h);
    for (const path of ['/', '/transactions', '/queue']) {
      const response = await fetchOnce(port, path, { headers: { cookie } });
      expect(String(response.headers['cache-control']), path).toContain('no-store');
    }
  });

  it('refuses a host it was not told about', async () => {
    const { port } = await startHttps('https-bad-host');
    const response = await fetchOnce(port, '/login', { headers: { host: 'evil.example' } });
    expect(response.status).toBe(400);
    expect(response.body).toContain('data-testid="safe-error"');
  });

  it('refuses a cross-origin state-changing request', async () => {
    const { port } = await startHttps('https-bad-origin');
    const form = new URLSearchParams({ userId: 'x', pin: 'y', deviceId: 'z', deviceSecret: 'w' }).toString();
    const response = await fetchOnce(port, '/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(Buffer.byteLength(form)),
        origin: 'https://evil.example',
      },
      body: form,
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain('data-testid="access-denied"');
  });
});

describe('the counter flow over TLS', () => {
  it('sells, shows the result, and never offers a receipt for an uncertain one', async () => {
    const { port, h } = await startHttps('https-sale');
    const { cookie, csrf } = await signIn(port, h);

    // A timed-out sale: the honest uncertain case.
    h.setBehaviour('TIMEOUT');
    const form = new URLSearchParams({
      csrfToken: csrf,
      productId: 'AIRTIME',
      recipient: '0900000000',
      clientRequestId: 'req_https_1',
      simulatedProviderBehaviour: 'TIMEOUT',
    }).toString();

    const sale = await fetchOnce(port, '/sell', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(Buffer.byteLength(form)),
        origin: 'https://telga-training.localhost',
      },
      body: form,
    });

    expect(sale.status).toBe(303);
    const location = String(sale.headers['location']);
    expect(location).toContain('/transactions/');

    const detail = await fetchOnce(port, location, { headers: { cookie } });
    expect(detail.status).toBe(200);
    expect(detail.body).toContain('data-state="PENDING"');
    expect(detail.body).toContain('data-testid="do-not-retry"');
    // No receipt for an outcome nobody knows.
    expect(detail.body).not.toContain('data-testid="action-PRINT_RECEIPT"');
    expect(detail.body).toContain('data-testid="funds-block"');
  });

  it('sells successfully and offers a receipt', async () => {
    const { port, h } = await startHttps('https-sale-ok');
    const { cookie, csrf } = await signIn(port, h);

    const form = new URLSearchParams({
      csrfToken: csrf,
      productId: 'AIRTIME',
      recipient: '0900000001',
      clientRequestId: 'req_https_ok',
      simulatedProviderBehaviour: 'SUCCESS',
    }).toString();

    const sale = await fetchOnce(port, '/sell', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(Buffer.byteLength(form)),
        origin: 'https://telga-training.localhost',
      },
      body: form,
    });
    const detail = await fetchOnce(port, String(sale.headers['location']), { headers: { cookie } });

    expect(detail.body).toContain('data-state="SUCCESSFUL"');
    expect(detail.body).toContain('data-testid="action-PRINT_RECEIPT"');
    expect(detail.body).not.toContain('data-testid="do-not-retry"');
  });

  it('refuses a sale with no CSRF token, and creates nothing', async () => {
    const { port, h } = await startHttps('https-sale-csrf');
    const { cookie } = await signIn(port, h);
    const before = h.driver.findTransactionsByMerchant(MERCHANT_A).length;

    const form = new URLSearchParams({
      productId: 'AIRTIME',
      recipient: '0900000002',
      clientRequestId: 'req_https_csrf',
    }).toString();

    const sale = await fetchOnce(port, '/sell', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(Buffer.byteLength(form)),
        origin: 'https://telga-training.localhost',
      },
      body: form,
    });

    expect(sale.status).toBe(303);
    expect(String(sale.headers['location'])).toContain('error=CSRF_TOKEN_MISSING');
    expect(h.driver.findTransactionsByMerchant(MERCHANT_A).length).toBe(before);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  });
});

describe('ending a session over TLS', () => {
  it('invalidates the session on logout', async () => {
    const { port, h } = await startHttps('https-logout');
    const { cookie, csrf } = await signIn(port, h);

    const form = new URLSearchParams({ csrfToken: csrf }).toString();
    const out = await fetchOnce(port, '/logout', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(Buffer.byteLength(form)),
        origin: 'https://telga-training.localhost',
      },
      body: form,
    });
    expect(out.status).toBe(303);

    // The old cookie is now worthless.
    const after = await fetchOnce(port, '/', { headers: { cookie } });
    expect(after.status).toBe(303);
    expect(String(after.headers['location'])).toContain('/login');
  });

  it('blocks every later request once the device is revoked', async () => {
    const { port, h } = await startHttps('https-device-revoked');
    const { cookie } = await signIn(port, h);
    expect((await fetchOnce(port, '/', { headers: { cookie } })).status).toBe(200);

    h.driver.revokeDevice(DEVICE_A, 'REPORTED_STOLEN', h.clock.now());

    const after = await fetchOnce(port, '/', { headers: { cookie } });
    // 403, not a redirect to sign-in: signing in again would not help.
    expect(after.status).toBe(403);
    expect(after.body).toContain('data-testid="access-denied"');
    expect(after.body).toContain('DEVICE_REVOKED');
  });
});

describe('shutdown', () => {
  it('closes the listener and stops accepting connections', async () => {
    const { port } = await startHttps('https-shutdown');
    expect((await fetchOnce(port, '/login')).status).toBe(200);

    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    server = undefined;

    await expect(fetchOnce(port, '/login')).rejects.toThrow();
  });
});
