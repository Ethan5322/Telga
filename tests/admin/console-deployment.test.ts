/**
 * Serving the console beyond this machine.
 *
 * **M6.** The console has always refused to bind anywhere but loopback over
 * plain HTTP — `cli.ts` calls it *"the same refusal the POS makes, for a console
 * that can do considerably more damage"*. On a platform that terminates TLS at
 * its edge and speaks HTTP to the container there is no certificate to hand this
 * process, so that rule made the console undeployable.
 *
 * **The rule is not relaxed here; it is satisfied a third way.** Binding beyond
 * loopback still requires proof that something in front is doing TLS, and the
 * proof is a trusted-proxy range — the POS's own answer, reused rather than
 * reinvented ([[Decision Log]] D109).
 *
 * The tests below are almost entirely about what is still refused.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, runMigrations } from '@telga/persistence';
import { run } from '../../apps/operations-console/src/cli';
import { createConsoleServer } from '../../apps/operations-console/src/server';

let dir: string;
let dbPath: string;
let db: Database.Database;
let server: Server | undefined;
/** The connection the served console holds, so teardown can close it. */
let served: Database.Database | undefined;
let port = 0;

const lines: string[] = [];
const errors: string[] = [];
const write = (line: string): void => void lines.push(line);
const writeError = (line: string): void => void errors.push(line);

beforeEach(() => {
  lines.length = 0;
  errors.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'telga-console-deploy-'));
  dbPath = join(dir, 'telga.sqlite');
  db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  // `runMigrations`, not a bare `exec` loop: it **records** each migration in
  // `schema_migrations`, and the CLI refuses to start against a database whose
  // migrations are unrecorded. Applying the SQL without recording it produces a
  // database that looks migrated to a query and unmigrated to the console.
  runMigrations(db, new Date().toISOString(), MIGRATIONS);
  db.close();
});

afterEach(() => {
  server?.close();
  server = undefined;
  // Closed before the directory is removed. An open SQLite handle makes the
  // temp directory undeletable on Windows, which surfaces as EPERM in teardown
  // and looks like a permissions problem rather than a leaked connection.
  try {
    served?.close();
  } catch {
    // Already closed by the test.
  }
  served = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** Run the CLI with `--db` already supplied. */
const cli = (...argv: string[]): Promise<number> =>
  run(['--db', dbPath, ...argv], write, writeError);

describe('binding beyond loopback', () => {
  it('is still refused over plain HTTP with nothing in front', async () => {
    const code = await cli('--host', '0.0.0.0', '--port', '4899');
    expect(code).toBe(4);
    expect(errors.join(' ')).toContain('CONSOLE_MUST_BE_LOOPBACK');
  });

  it('names the two ways to serve beyond this machine', async () => {
    // An operator who hits this refusal needs to know what to do about it, not
    // only that they may not.
    await cli('--host', '0.0.0.0', '--port', '4899');
    const message = errors.join(' ');
    expect(message).toContain('--tls-cert');
    expect(message).toContain('--trust-proxy');
  });

  it('refuses a trust-all range, so there is no way to express it', async () => {
    // D45: there is no trust-all setting. `parseTrustedEntry` refuses a
    // zero-length prefix, and the console reuses it rather than writing a
    // second, more forgiving parser.
    for (const range of ['0.0.0.0/0', '::/0']) {
      errors.length = 0;
      const code = await cli('--host', '0.0.0.0', '--trust-proxy', range, '--port', '4899');
      expect(code, range).toBe(4);
      expect(errors.join(' '), range).toContain('CONSOLE_TRUST_PROXY_INVALID');
    }
  });

  it('refuses a malformed range rather than matching nothing', async () => {
    // A range that matches nothing looks identical to a working deployment
    // until the first sign-in fails.
    const code = await cli('--host', '0.0.0.0', '--trust-proxy', 'not-a-range', '--port', '4899');
    expect(code).toBe(4);
    expect(errors.join(' ')).toContain('CONSOLE_TRUST_PROXY_INVALID');
  });

  it('refuses a proxied console that was not told which hosts are its own', async () => {
    // The `Host` header is client-controlled. A console answering for any host
    // is a console serving somebody else's domain.
    const code = await cli('--host', '0.0.0.0', '--trust-proxy', '100.64.0.0/10', '--port', '4899');
    expect(code).toBe(4);
    expect(errors.join(' ')).toContain('CONSOLE_ALLOWED_HOSTS_REQUIRED');
  });

  it('still requires both halves of a TLS pair', async () => {
    const code = await cli('--host', '0.0.0.0', '--tls-cert', '/tmp/c.pem', '--port', '4899');
    expect(code).toBe(4);
    expect(errors.join(' ')).toContain('TLS_PAIR_REQUIRED');
  });

  it('accepts loopback with no proxy configuration at all, as before', async () => {
    // The existing local workflow is unchanged. This is the case an operator
    // running the console on their own laptop has always used.
    const code = await cli('--host', '127.0.0.1', '--port', '4899', '--create-owner', 'a@b.example', '--owner-password', 'a-very-long-password');
    expect(code).toBe(0);
  });
});

describe('the health endpoint', () => {
  const start = async (): Promise<void> => {
    served = new Database(dbPath);
    served.pragma('foreign_keys = ON');
    server = createConsoleServer({
      db: served as never,
      now: () => new Date().toISOString(),
      newId: (p) => `${p}_1`,
      schemaVersion: '016',
      allowedHosts: ['127.0.0.1', 'localhost'],
      secureCookies: false,
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        port = typeof address === 'object' && address !== null ? address.port : 0;
        resolve();
      });
    });
  };

  const call = (method = 'GET'): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: '/api/health/ready', method, headers: { host: '127.0.0.1' } },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => {
            body += c;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
        },
      );
      req.on('error', reject);
      req.end();
    });

  it('answers without a session, because a health check has none', async () => {
    await start();
    const reply = await call();
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({
      status: 'ok',
      service: 'operations-console',
      mode: 'TRAINING',
    });
  });

  it('carries the header set the rest of the surface uses', async () => {
    // `09 Engineering/Health Endpoints` names all three.
    await start();
    const reply = await call();
    expect(String(reply.headers['cache-control'])).toContain('no-store');
    expect(reply.headers['x-content-type-options']).toBe('nosniff');
    // `same-origin`, matching every other response. It was `no-referrer`, and
    // that is what made browsers send `Origin: null` on the sign-in form and
    // locked administrators out — see the opaque-origin tests below.
    expect(reply.headers['referrer-policy']).toBe('same-origin');
  });

  it('discloses nothing an attacker would want', async () => {
    // The one route reachable without signing in. Every field on it is a field
    // given away for free, so the test names what must not be there.
    await start();
    const reply = await call();
    const body = reply.body.toLowerCase();
    for (const leak of ['schema', 'version', 'admin', 'merchant', 'token', 'session', 'password', 'path', 'sqlite']) {
      expect(body, `${leak} must not appear`).not.toContain(leak);
    }
  });

  it('cannot be used to change anything', async () => {
    await start();
    const reply = await call('POST');
    expect(reply.status).toBe(405);
    expect(reply.headers['allow']).toBe('GET');
  });
});

describe('the origin check accepts the machine it is running on', () => {
  /**
   * Reported from a browser, 2026-09-09: signing in answered *"Refused:
   * cross-site request"*.
   *
   * The check read the host as `new URL(origin).host.split(':')[0]`, which
   * splits on the port separator — and an IPv6 address is full of colons. For
   * `http://[::1]:4800` that yielded `"["`, so **every** form posted from an
   * IPv6 loopback origin was refused as cross-site. The console would serve a
   * page and then reject everything submitted from it.
   *
   * Two things were wrong and both are fixed: the parsing (`hostname` instead
   * of splitting `host`), and the default allow-list, which omitted `::1` even
   * though `cli.ts` accepts `::1` as a bind host. The two definitions of "this
   * machine" have to agree.
   */
  const post = (origin?: string, secFetchSite?: string): Promise<{ status: number }> =>
    new Promise((resolve, reject) => {
      const body = 'email=nobody@telga.local&password=irrelevant';
      const headers: Record<string, string> = {
        host: '127.0.0.1',
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(Buffer.byteLength(body)),
      };
      if (origin !== undefined) headers['origin'] = origin;
      if (secFetchSite !== undefined) headers['sec-fetch-site'] = secFetchSite;
      const req = httpRequest(
        { host: '127.0.0.1', port, path: '/login', method: 'POST', headers },
        (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

  const serve = async (): Promise<void> => {
    served = new Database(dbPath);
    served.pragma('foreign_keys = ON');
    server = createConsoleServer({
      db: served as never,
      now: () => new Date().toISOString(),
      newId: (p) => `${p}_1`,
      schemaVersion: '017',
      secureCookies: false,
      // No `allowedHosts` — the default is what an operator running the console
      // locally actually gets, and it is the default that was broken.
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', () => {
        const address = server?.address();
        port = typeof address === 'object' && address !== null ? address.port : 0;
        resolve();
      });
    });
  };

  it('accepts every way a browser can name this machine', async () => {
    await serve();
    for (const origin of [
      'http://127.0.0.1:4800',
      'http://localhost:4800',
      'http://[::1]:4800',
      'https://localhost:4800',
    ]) {
      const reply = await post(origin);
      // 303 is the sign-in refusal redirect — the credentials are deliberately
      // wrong. What matters is that it is **not** 403: the origin was accepted
      // and the request reached the login logic.
      expect(reply.status, `${origin} must not be refused as cross-site`).not.toBe(403);
    }
  });

  it('still refuses a genuinely foreign origin', async () => {
    await serve();
    for (const origin of ['https://evil.example', 'http://192.168.1.50:4800']) {
      const reply = await post(origin);
      expect(reply.status, `${origin} must be refused`).toBe(403);
    }
  });

  /**
   * The opaque origin, which used to be refused flat — and which locked every
   * administrator out of the console.
   *
   * `null` is what a browser sends when the referrer policy suppresses the
   * referrer, which `no-referrer` did. So the console served a sign-in form and
   * then answered "Refused: cross-site request" to that same form. It was
   * invisible to every test here because `curl` and Node send a real `Origin`;
   * only a browser posting the actual form reproduced it.
   *
   * The header is fixed, and these pin the fallback: `null` is now judged on
   * `Sec-Fetch-Site`, which the browser sets and script cannot reach.
   */
  it('accepts an opaque origin only when the browser says it is same-origin', async () => {
    await serve();
    // Not 403: the origin was accepted and the request reached the login logic.
    expect((await post('null', 'same-origin')).status).not.toBe(403);
    // A typed or bookmarked navigation.
    expect((await post('null', 'none')).status).not.toBe(403);
  });

  it('still refuses an opaque origin that is actually cross-site', async () => {
    await serve();
    // A sandboxed iframe on another origin sends exactly this pair, and is the
    // case the null-origin refusal existed for.
    expect((await post('null', 'cross-site')).status).toBe(403);
    expect((await post('null', 'same-site')).status).toBe(403);
    // No Sec-Fetch-Site at all keeps the old answer. A client that sends
    // neither a usable Origin nor this header does not get the benefit of the
    // doubt on an admin console.
    expect((await post('null')).status).toBe(403);
  });

  it('does not send a referrer policy that causes the opaque origin', async () => {
    // The root cause, asserted directly. `no-referrer` here would reintroduce
    // the lockout on the next browser that follows the spec closely.
    await serve();
    const headers = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: '/login', method: 'GET' },
        (res) => {
          res.resume();
          resolve(res.headers as Record<string, unknown>);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(headers['referrer-policy']).toBe('same-origin');
  });

  it('still allows a form post that omits Origin, as browsers may', async () => {
    await serve();
    expect((await post()).status).not.toBe(403);
  });
});
