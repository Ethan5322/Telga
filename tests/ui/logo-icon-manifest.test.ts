/**
 * The mark, the app icons, and the installable manifest.
 *
 * The mark is the founder's own render, reworked — teal instead of gold, the
 * asphalt replaced with rock and bush, the letter tilted so its foot is off
 * the ground. These tests pin the things that would break it silently: that
 * the files are actually served, that `/assets/` cannot be walked out of, and
 * that the manifest names the icons that exist.
 */

import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_BEHAVIOURS } from '@telga/provider-mock-airtime';
import { createPosServer, renderToHtml, telgaLogo } from '@telga/merchant-pos';
import { makeUiHarness } from '../auth/helpers';
import type { UiHarness } from '../auth/helpers';

let harness: UiHarness | undefined;
let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
  harness?.cleanup();
  harness = undefined;
});

/** A raw request that keeps the response headers — the content type matters here. */
function rawRequest(
  port: number,
  path: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string>,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

async function startServer(h: UiHarness): Promise<number> {
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

describe('the mark', () => {
  it('is served from this origin, not inlined', () => {
    const html = renderToHtml(telgaLogo());
    expect(html).toContain('src="/assets/telga-logo.png"');
    // The page CSP is `img-src 'self'`, so a data: URI would be refused
    // outright — and 1.6 MB of base64 on every page would be worse anyway.
    expect(html).not.toContain('data:image');
  });

  it('plays the fall → catch → stand sequence only where asked', () => {
    expect(renderToHtml(telgaLogo({ animate: true }))).toContain('telga-logo--animate');
    expect(renderToHtml(telgaLogo())).not.toContain('telga-logo--animate');
  });
});

describe('assets and the manifest', () => {
  it('serves the mark and every icon the manifest names', async () => {
    harness = makeUiHarness('assets');
    const port = await startServer(harness);

    for (const name of [
      'telga-logo.png',
      'app-vending.png',
      'app-pay.png',
      'icon-32.png',
      'icon-180.png',
      'icon-192.png',
      'icon-512.png',
      'icon-maskable-192.png',
      'icon-maskable-512.png',
    ]) {
      const response = await rawRequest(port, `/assets/${name}`);
      expect(response.status, `${name} should be served`).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
    }
  });

  it('refuses anything not on the served list, and cannot be walked out of', async () => {
    harness = makeUiHarness('assets-traversal');
    const port = await startServer(harness);

    for (const path of [
      '/assets/../../package.json',
      '/assets/..%2f..%2fpackage.json',
      '/assets/telga.sqlite',
      '/assets/server.js',
      '/assets/../gpt.png',
    ]) {
      const response = await rawRequest(port, path);
      // The property that matters is that no file comes back — not which
      // refusal it is. A `..` walk is normalised to a path outside `/assets/`
      // before it ever reaches the route, so it meets the session guard and is
      // redirected to sign-in; an unlisted name inside `/assets/` is a 404.
      // Either way nothing is served.
      const served =
        response.status === 200 &&
        (response.headers['content-type'] ?? '').startsWith('image/');
      expect(served, `${path} must not be served`).toBe(false);
      expect(response.body, `${path} must not leak file contents`).not.toContain('"name":');
    }
  });

  it('publishes a manifest that opens into the launcher', async () => {
    harness = makeUiHarness('manifest');
    const port = await startServer(harness);
    const response = await rawRequest(port, '/manifest.webmanifest');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/manifest+json');

    const manifest = JSON.parse(response.body) as {
      start_url: string;
      display: string;
      icons: { src: string; purpose: string }[];
    };
    // The installed icon opens the two-app chooser, not wherever the browser
    // happened to be.
    expect(manifest.start_url).toBe('/launcher');
    expect(manifest.display).toBe('standalone');
    // Android crops a maskable icon to a circle; without one the mark loses
    // its corners.
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  });

  it('is reachable before sign-in — a browser fetches it with no session', async () => {
    harness = makeUiHarness('manifest-public');
    const port = await startServer(harness);
    for (const path of ['/manifest.webmanifest', '/assets/icon-192.png']) {
      const response = await rawRequest(port, path);
      expect(response.status, `${path} should not require a session`).toBe(200);
    }
  });
});
