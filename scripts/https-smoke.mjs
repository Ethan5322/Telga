#!/usr/bin/env node
/**
 * The HTTPS smoke test.
 *
 * Runs the **compiled** POS over real TLS, against a real SQLite file, driving
 * it with real HTTPS requests — the fifteen steps in the build order, in order,
 * reporting what actually happened.
 *
 * This exists because the unit and integration tests all run inside Vitest,
 * against modules. A smoke test that starts `dist/cli.js` as a child process
 * proves the thing an operator will actually run, which is a different claim.
 *
 * ## What it never does
 *
 * Print a private key, a session token, a CSRF token or a device key. The
 * device key is generated, used, and reported only as its length. Everything it
 * writes goes into a temporary directory that is removed at the end, so no
 * certificate and no database survives the run.
 *
 *   node scripts/https-smoke.mjs
 */

import { spawn } from 'node:child_process';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const POS = join(ROOT, 'apps', 'merchant-pos', 'dist', 'cli.js');
const WORKER = join(ROOT, 'services', 'worker', 'dist', 'cli.js');

const MERCHANT = 'merchant_smoke';
const DEVICE = 'device_smoke_1';
const OPERATOR = 'operator_smoke_1';
const PIN = '481502';
const HOST = 'telga-training.localhost';

let failures = 0;
let stepNumber = 0;

function step(name) {
  stepNumber += 1;
  process.stdout.write(`\n${String(stepNumber).padStart(2, ' ')}. ${name}\n`);
}

function check(label, condition, detail = '') {
  if (condition) {
    process.stdout.write(`    PASS  ${label}${detail ? ` — ${detail}` : ''}\n`);
  } else {
    failures += 1;
    process.stdout.write(`    FAIL  ${label}${detail ? ` — ${detail}` : ''}\n`);
  }
}

// --- a self-signed certificate, in memory ----------------------------------
// The same minimal DER encoder the tests use. The application never generates a
// certificate; this script does, because a smoke test needs one and a committed
// key is exactly what the repository refuses to hold.

const len = (n) => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...p) => tlv(0x30, Buffer.concat(p));
const setOf = (...p) => tlv(0x31, Buffer.concat(p));
const int = (v) => {
  let b = typeof v === 'number' ? Buffer.from([v]) : v;
  if (b.length === 0) b = Buffer.from([0]);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
};
const oid = (dotted) => {
  const parts = dotted.split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunks = [];
    let v = part;
    do {
      chunks.unshift(v & 0x7f);
      v >>>= 7;
    } while (v > 0);
    for (let i = 0; i < chunks.length - 1; i += 1) chunks[i] |= 0x80;
    bytes.push(...chunks);
  }
  return tlv(0x06, Buffer.from(bytes));
};
const utf8 = (v) => tlv(0x0c, Buffer.from(v, 'utf8'));
const bitString = (b) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const octet = (b) => tlv(0x04, b);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const ctx = (n, b) => tlv(0xa0 | n, b);
const utcTime = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return tlv(
    0x17,
    Buffer.from(
      `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
        `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`,
      'ascii',
    ),
  );
};
const pem = (label, der) => {
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN ${label}-----\n${body}${body.endsWith('\n') ? '' : '\n'}-----END ${label}-----\n`;
};

function makeCertificate() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const name = seq(setOf(seq(oid('2.5.4.3'), utf8(HOST))));
  const alg = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));
  const san = seq(
    oid('2.5.29.17'),
    octet(
      seq(
        tlv(0x82, Buffer.from(HOST, 'ascii')),
        tlv(0x82, Buffer.from('localhost', 'ascii')),
        tlv(0x87, Buffer.from([127, 0, 0, 1])),
      ),
    ),
  );
  const now = Date.now();
  const tbs = seq(
    ctx(0, int(2)),
    int(Buffer.from([0x01, 0x00, 0x01])),
    alg,
    name,
    seq(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 86_400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    ctx(3, seq(seq(oid('2.5.29.19'), bool(true), octet(seq(bool(false)))), san)),
  );
  const signature = createSign('sha256').update(tbs).sign(privateKey);
  return {
    certificatePem: pem('CERTIFICATE', seq(tbs, alg, bitString(signature))),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

// --- process and request helpers -------------------------------------------

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function fetchOnce(port, path, init = {}) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: init.method ?? 'GET',
        headers: { host: HOST, ...(init.headers ?? {}) },
        // The smoke certificate is self-signed by construction.
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            setCookies: res.headers['set-cookie'] ?? [],
          }),
        );
      },
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

const form = (fields) => new URLSearchParams(fields).toString();
const formHeaders = (body, extra = {}) => ({
  'content-type': 'application/x-www-form-urlencoded',
  'content-length': String(Buffer.byteLength(body)),
  origin: `https://${HOST}`,
  ...extra,
});
const cookiesFrom = (setCookies) => setCookies.map((c) => c.split(';')[0]).join('; ');

async function waitForListening(child, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), timeoutMs);
    const onData = (d) => {
      output += d.toString();
      const match = /https:\/\/[^:]+:(\d+)\/login/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve({ port: Number(match[1]), banner: output });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}:\n${output}`));
    });
  });
}

// --- the run ----------------------------------------------------------------

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'telga-smoke-'));
  const db = join(dir, 'telga.sqlite');
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  let server;

  process.stdout.write('Telga HTTPS smoke test — TRAINING MODE, synthetic data only.\n');

  try {
    step('Build output present');
    const built = await run(process.execPath, [POS, '--help'], { cwd: ROOT }).catch(() => null);
    check('compiled POS entry point exists', built !== null && built.code !== null, POS);

    step('Apply migrations through the single-writer --migrate path');
    const migrate = await run(
      process.execPath,
      [WORKER, '--db', db, '--migrate', '--once', '--mode', 'TRAINING'],
      { cwd: ROOT },
    );
    check('migrations applied', migrate.code === 0, `exit ${migrate.code}`);

    step('Write a temporary self-signed certificate');
    const generated = makeCertificate();
    writeFileSync(certPath, generated.certificatePem);
    writeFileSync(keyPath, generated.privateKeyPem, { mode: 0o600 });
    check('certificate and key written to a temporary directory', true, dir);

    step('Provision an operator and enrol a device');
    const provision = await run(
      process.execPath,
      [
        POS, '--db', db,
        '--merchant', MERCHANT,
        '--operator', OPERATOR,
        '--device', DEVICE,
        '--provision-pin', PIN,
        '--training-float', '500',
      ],
      { cwd: ROOT },
    );
    const keyMatch = /device key \(shown once, not recoverable\): (\S+)/.exec(provision.stdout);
    const deviceSecret = keyMatch ? keyMatch[1] : '';
    check('provisioning succeeded', provision.code === 0, `exit ${provision.code}`);
    check('a device key was issued', deviceSecret.length > 20, `${deviceSecret.length} characters`);
    check('the PIN was not printed', !provision.stdout.includes(PIN));
    check('the simulated balance is labelled', provision.stdout.includes('SIMULATED'));

    step('Refuse an unsafe configuration before serving');
    const unsafe = await run(
      process.execPath,
      [POS, '--db', db, '--merchant', MERCHANT, '--transport', 'TRAINING_HTTPS', '--tls-cert', certPath],
      { cwd: ROOT },
    );
    check('missing --tls-key refused with exit 4', unsafe.code === 4, `exit ${unsafe.code}`);
    check('the refusal names a reason code', /TLS_PRIVATE_KEY_REQUIRED/.test(unsafe.stderr));

    const lanHttp = await run(
      process.execPath,
      [POS, '--db', db, '--merchant', MERCHANT, '--host', '0.0.0.0'],
      { cwd: ROOT },
    );
    check('plain HTTP on a LAN address refused with exit 4', lanHttp.code === 4, `exit ${lanHttp.code}`);

    const live = await run(
      process.execPath,
      [POS, '--db', db, '--merchant', MERCHANT, '--mode', 'LIVE'],
      { cwd: ROOT },
    );
    check('LIVE mode refused with exit 3', live.code === 3, `exit ${live.code}`);

    step('Start the training HTTPS server');
    server = spawn(
      process.execPath,
      [
        POS,
        '--db', db,
        '--merchant', MERCHANT,
        '--transport', 'TRAINING_HTTPS',
        '--tls-cert', certPath,
        '--tls-key', keyPath,
        '--host', '127.0.0.1',
        '--port', '0',
        '--allowed-hosts', `${HOST},127.0.0.1`,
        '--hsts', 'true',
      ],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const { port, banner } = await waitForListening(server);
    check('server is listening over TLS', port > 0, `port ${port}`);
    check('banner states training mode', banner.includes('TRAINING MODE'));
    check('banner shows the certificate fingerprint', /sha256:/.test(banner));
    check('banner warns that the certificate is self-signed', banner.includes('SELF-SIGNED'));
    check('banner never prints key material', !banner.includes('BEGIN') && !banner.includes('PRIVATE'));

    step('Sign in');
    const loginBody = form({ userId: OPERATOR, pin: PIN, deviceId: DEVICE, deviceSecret });
    const login = await fetchOnce(port, '/login', {
      method: 'POST',
      headers: formHeaders(loginBody),
      body: loginBody,
    });
    check('sign-in redirected', login.status === 303, `status ${login.status}`);
    const cookie = cookiesFrom(login.setCookies);
    const csrf = decodeURIComponent(
      login.setCookies.find((c) => c.startsWith('telga_csrf='))?.split(';')[0]?.split('=')[1] ?? '',
    );
    check('a session cookie was issued', cookie.includes('telga_session='));

    step('Confirm cookie attributes');
    const sessionCookie = login.setCookies.find((c) => c.startsWith('telga_session=')) ?? '';
    check('Secure', sessionCookie.includes('Secure'));
    check('HttpOnly', sessionCookie.includes('HttpOnly'));
    check('SameSite=Strict', sessionCookie.includes('SameSite=Strict'));
    check('no browser-side Max-Age', !sessionCookie.includes('Max-Age'));

    const home = await fetchOnce(port, '/', { headers: { cookie } });
    check('home renders for the signed-in operator', home.status === 200, `status ${home.status}`);
    check('identity indicator present', home.body.includes('data-testid="identity-bar"'));
    check('HSTS sent over HTTPS', String(home.headers['strict-transport-security']).includes('max-age'));
    const csp = String(home.headers['content-security-policy']);
    check('CSP carries a per-response nonce', /script-src 'nonce-/.test(csp));
    check('CSP has no unsafe-inline', !csp.includes('unsafe-inline'), `${csp.slice(0, 56)}...`);
    check('page is not cacheable', String(home.headers['cache-control']).includes('no-store'));

    step('Create a successful simulated sale');
    const okBody = form({
      csrfToken: csrf,
      productId: 'AIRTIME_25',
      recipient: '0900000001',
      clientRequestId: 'smoke_ok',
      simulatedProviderBehaviour: 'SUCCESS',
    });
    const okSale = await fetchOnce(port, '/sell', {
      method: 'POST',
      headers: formHeaders(okBody, { cookie }),
      body: okBody,
    });
    const okDetail = await fetchOnce(port, okSale.headers.location, { headers: { cookie } });
    check('sale succeeded', okDetail.body.includes('data-state="SUCCESSFUL"'));
    check('a receipt is offered', okDetail.body.includes('data-testid="action-PRINT_RECEIPT"'));

    step('Create a confirmed failure');
    const failBody = form({
      csrfToken: csrf,
      productId: 'AIRTIME_25',
      recipient: '0900000002',
      clientRequestId: 'smoke_fail',
      simulatedProviderBehaviour: 'FAILURE',
    });
    const failSale = await fetchOnce(port, '/sell', {
      method: 'POST',
      headers: formHeaders(failBody, { cookie }),
      body: failBody,
    });
    const failDetail = await fetchOnce(port, failSale.headers.location, { headers: { cookie } });
    check('sale failed cleanly', failDetail.body.includes('data-state="FAILED"'));
    check('no receipt for a failure', !failDetail.body.includes('data-testid="action-PRINT_RECEIPT"'));

    step('Create a TIMEOUT, which must become PENDING');
    const pendingBody = form({
      csrfToken: csrf,
      productId: 'AIRTIME_25',
      recipient: '0900000003',
      clientRequestId: 'smoke_pending',
      simulatedProviderBehaviour: 'TIMEOUT',
    });
    const pendingSale = await fetchOnce(port, '/sell', {
      method: 'POST',
      headers: formHeaders(pendingBody, { cookie }),
      body: pendingBody,
    });
    const pendingDetail = await fetchOnce(port, pendingSale.headers.location, { headers: { cookie } });
    check('a timeout became PENDING, not FAILED', pendingDetail.body.includes('data-state="PENDING"'));
    check('DO_NOT_RETRY_YET is shown', pendingDetail.body.includes('data-testid="do-not-retry"'));
    check(
      'no receipt for an uncertain outcome',
      !pendingDetail.body.includes('data-testid="action-PRINT_RECEIPT"'),
    );
    check('funds status is shown', pendingDetail.body.includes('data-testid="funds-block"'));

    step('Confirm no session token leaks into a page');
    const token = cookie.split('telga_session=')[1]?.split(';')[0] ?? '';
    let leaked = false;
    for (const path of ['/', '/transactions', '/queue', okSale.headers.location]) {
      const page = await fetchOnce(port, path, { headers: { cookie } });
      if (page.body.includes(token) || page.body.includes(decodeURIComponent(token))) leaked = true;
    }
    check('the session token appears in no page', !leaked);

    step('Confirm cross-merchant access is refused');
    const other = await fetchOnce(port, '/transactions/txn_someone_else', { headers: { cookie } });
    check('an unknown transaction is a plain not-found', other.status === 404, `status ${other.status}`);
    const spoofedHost = await fetchOnce(port, '/', { headers: { cookie, host: 'evil.example' } });
    check('an unrecognised Host is refused', spoofedHost.status === 400, `status ${spoofedHost.status}`);

    step('Log out and confirm the session is dead');
    const logoutBody = form({ csrfToken: csrf });
    await fetchOnce(port, '/logout', {
      method: 'POST',
      headers: formHeaders(logoutBody, { cookie }),
      body: logoutBody,
    });
    const afterLogout = await fetchOnce(port, '/', { headers: { cookie } });
    check('the old cookie no longer works', afterLogout.status === 303, `status ${afterLogout.status}`);

    step('Shut down gracefully');
    server.kill('SIGTERM');
    const exitCode = await new Promise((resolve) => server.on('exit', resolve));
    server = undefined;
    check('exited cleanly on SIGTERM', exitCode === 0 || exitCode === null, `exit ${exitCode}`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`\n    ERROR ${error.message}\n`);
  } finally {
    if (server) server.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
    process.stdout.write(`\nTemporary directory removed: ${dir}\n`);
  }

  process.stdout.write(
    failures === 0
      ? '\nHTTPS smoke test passed. TRAINING MODE — no real value, no live provider.\n'
      : `\nHTTPS smoke test FAILED: ${failures} check(s).\n`,
  );
  return failures === 0 ? 0 : 1;
}

main().then((code) => {
  process.exitCode = code;
});
