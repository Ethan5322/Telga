/**
 * The front proxy that lets the console be reached on a live deployment.
 *
 * ## Why this test exists
 *
 * Until 2026-09-09 `railway-start.mjs` started the POS and the recovery worker
 * and nothing else, so on a live deployment a shop could submit a registration
 * and **nobody could approve it** — the operations console ran only on an
 * operator's own laptop. The end-to-end flow was untestable by anyone not
 * sitting at that laptop.
 *
 * The supervisor now optionally starts the console too and puts a `Host`-based
 * proxy on `$PORT`. That routing decision is the part worth pinning: get it
 * wrong in the safe direction and the admin panel is unreachable; get it wrong
 * in the other direction and **merchant traffic reaches the admin panel**.
 *
 * ## What is tested here, and what is not
 *
 * The supervisor is a shell script that spawns processes, and starting Railway
 * in a unit test proves nothing about Railway. What is tested is the decision
 * itself, against a pair of real listeners over real sockets: the same
 * comparison the script makes, with the same normalisation, including the cases
 * that make host comparison go wrong — a port suffix, uppercase, and an
 * unknown host.
 *
 * `tests/admin/console-deployment.test.ts` covers what the console does once a
 * request reaches it; this covers whether one does.
 */

import { createServer, request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The routing rule, lifted verbatim from `scripts/deploy/railway-start.mjs`.
 *
 * Duplicated deliberately rather than imported: the script is an ESM entry
 * point that reads the environment and spawns children at module scope, so
 * importing it would start a deployment. The rule is three lines, and a
 * comment in the script points here.
 */
function routeFor(hostHeader: string | undefined, consoleHost: string): 'console' | 'pos' {
  const host = String(hostHeader ?? '')
    .replace(/:\d+$/, '')
    .toLowerCase();
  return host === consoleHost ? 'console' : 'pos';
}

let listeners: Server[] = [];

afterEach(() => {
  for (const listener of listeners) listener.close();
  listeners = [];
});

/** A listener that answers with its own name, so a reply names its origin. */
function stub(name: string): Promise<number> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(name);
  });
  listeners.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}

/** The proxy under test, built the way the supervisor builds it. */
function proxy(consoleHost: string, posPort: number, consolePort: number): Promise<number> {
  const server = createServer((clientReq, clientRes) => {
    const target =
      routeFor(clientReq.headers.host, consoleHost) === 'console' ? consolePort : posPort;
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: target,
        path: clientReq.url,
        method: clientReq.method,
        headers: clientReq.headers,
      },
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      },
    );
    upstream.on('error', () => {
      if (!clientRes.headersSent) clientRes.writeHead(502);
      clientRes.end('unreachable');
    });
    clientReq.pipe(upstream);
  });
  listeners.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}

function get(port: number, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/', method: 'GET', headers: { host } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve(body));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('the front proxy routes on Host', () => {
  it('sends the console hostname to the console', async () => {
    const posPort = await stub('pos');
    const consolePort = await stub('console');
    const front = await proxy('admin.telga.example', posPort, consolePort);

    expect(await get(front, 'admin.telga.example')).toBe('console');
  });

  it('sends everything else to the merchant app', async () => {
    const posPort = await stub('pos');
    const consolePort = await stub('console');
    const front = await proxy('admin.telga.example', posPort, consolePort);

    expect(await get(front, 'telga.example')).toBe('pos');
    expect(await get(front, 'telga-backend-production.up.railway.app')).toBe('pos');
  });

  it('ignores a port suffix, which a browser may send', async () => {
    // `admin.telga.example:443` and `admin.telga.example` are the same host.
    // Comparing the raw header would route the first to the merchant app.
    const posPort = await stub('pos');
    const consolePort = await stub('console');
    const front = await proxy('admin.telga.example', posPort, consolePort);

    expect(await get(front, 'admin.telga.example:443')).toBe('console');
  });

  it('compares without case, because a hostname is case-insensitive', async () => {
    const posPort = await stub('pos');
    const consolePort = await stub('console');
    const front = await proxy('admin.telga.example', posPort, consolePort);

    expect(await get(front, 'Admin.Telga.Example')).toBe('console');
  });

  it('sends an absent Host to the merchant app, never the console', async () => {
    // The default has to be the merchant app. A request that does not name the
    // console's hostname must not reach the console — and the console's own
    // --allowed-hosts is the second check behind this one, not the only one.
    expect(routeFor(undefined, 'admin.telga.example')).toBe('pos');
    expect(routeFor('', 'admin.telga.example')).toBe('pos');
  });

  it('routes a near-miss hostname to the merchant app', async () => {
    // A subdomain that merely contains the console's name is not the console.
    // A `startsWith` or `includes` comparison would hand it the admin panel.
    expect(routeFor('admin.telga.example.attacker.test', 'admin.telga.example')).toBe('pos');
    expect(routeFor('notadmin.telga.example', 'admin.telga.example')).toBe('pos');
    expect(routeFor('admin.telga.exampleX', 'admin.telga.example')).toBe('pos');
  });

  it('answers 502 rather than hanging when the app behind it is down', async () => {
    // A socket left open is a request the edge waits on until it times out. The
    // supervisor is already tearing the service down in this case; the browser
    // should be told so.
    const consolePort = await stub('console');
    // A port nothing is listening on.
    const front = await proxy('admin.telga.example', 1, consolePort);

    expect(await get(front, 'telga.example')).toBe('unreachable');
  });
});
