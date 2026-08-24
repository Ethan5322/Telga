/**
 * Loading TLS material.
 *
 * The certificates are generated in memory by `certs.ts` and written to a
 * temporary directory that is removed afterwards, so no private key ever
 * touches the repository — which is also what `check-committed.mjs` enforces.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TransportConfigError, describeTls, loadTlsMaterial } from '@telga/merchant-pos';
import { generateSelfSignedCertificate } from './certs';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

interface Written {
  readonly certPath: string;
  readonly keyPath: string;
  readonly otherKeyPath: string;
  readonly dir: string;
}

function writeCert(options: Parameters<typeof generateSelfSignedCertificate>[0] = {}): Written {
  const dir = mkdtempSync(join(tmpdir(), 'telga-tls-'));
  dirs.push(dir);
  const generated = generateSelfSignedCertificate(options);
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  const otherKeyPath = join(dir, 'other-key.pem');
  writeFileSync(certPath, generated.certificatePem);
  writeFileSync(keyPath, generated.privateKeyPem);
  writeFileSync(otherKeyPath, generated.otherPrivateKeyPem);
  return { certPath, keyPath, otherKeyPath, dir };
}

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof TransportConfigError) return error.reasonCode;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('a matching certificate and key', () => {
  it('loads and reports safe facts', () => {
    const { certPath, keyPath } = writeCert();
    const material = loadTlsMaterial(certPath, keyPath);

    expect(material.cert).toContain('BEGIN CERTIFICATE');
    expect(material.key).toContain('PRIVATE KEY');
    expect(material.summary.subject).toContain('telga-training.localhost');
    expect(material.summary.selfSigned).toBe(true);
    expect(material.summary.fingerprintSha256).toMatch(/^[0-9A-F:]+$/);
    expect(material.summary.expiredOrNotYetValid).toBe(false);
  });

  it('describes itself without ever printing key material', () => {
    const { certPath, keyPath } = writeCert();
    const lines = describeTls(loadTlsMaterial(certPath, keyPath).summary).join('\n');

    expect(lines).toContain('telga-training.localhost');
    expect(lines).toContain('SELF-SIGNED');
    // The description says plainly that self-signed is not production trust.
    expect(lines).toContain('NOT production trust');
    expect(lines).not.toContain('BEGIN');
    expect(lines).not.toContain('PRIVATE');
  });
});

describe('refusals', () => {
  it('refuses a missing certificate', () => {
    const { keyPath, dir } = writeCert();
    expect(reasonOf(() => loadTlsMaterial(join(dir, 'nope.pem'), keyPath))).toBe(
      'TLS_CERTIFICATE_UNREADABLE',
    );
  });

  it('refuses a missing key', () => {
    const { certPath, dir } = writeCert();
    expect(reasonOf(() => loadTlsMaterial(certPath, join(dir, 'nope.pem')))).toBe(
      'TLS_PRIVATE_KEY_UNREADABLE',
    );
  });

  it('refuses a file that is not a certificate', () => {
    const { keyPath, dir } = writeCert();
    const junk = join(dir, 'junk.pem');
    writeFileSync(junk, 'this is not a certificate\n');
    expect(reasonOf(() => loadTlsMaterial(junk, keyPath))).toBe('TLS_CERTIFICATE_INVALID');
  });

  it('refuses a file that is not a private key', () => {
    const { certPath, dir } = writeCert();
    const junk = join(dir, 'junk-key.pem');
    writeFileSync(junk, 'this is not a key\n');
    expect(reasonOf(() => loadTlsMaterial(certPath, junk))).toBe('TLS_PRIVATE_KEY_INVALID');
  });

  it('refuses a certificate and key that do not belong together', () => {
    // Otherwise this fails per-connection during the handshake, at the worst
    // possible moment, as something a browser renders as an unexplained error.
    const { certPath, otherKeyPath } = writeCert();
    expect(reasonOf(() => loadTlsMaterial(certPath, otherKeyPath))).toBe(
      'TLS_CERTIFICATE_KEY_MISMATCH',
    );
  });

  it('names the path but never the contents', () => {
    const { certPath, dir } = writeCert();
    const junk = join(dir, 'secretish.pem');
    writeFileSync(junk, '-----BEGIN PRIVATE KEY-----\nSUPERSECRETVALUE\n-----END PRIVATE KEY-----\n');
    try {
      loadTlsMaterial(certPath, junk);
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('secretish.pem');
      expect(message).not.toContain('SUPERSECRETVALUE');
    }
  });
});

describe('validity and permissions', () => {
  it('flags a certificate that has already expired', () => {
    const { certPath, keyPath } = writeCert({ notBeforeMs: -200_000, notAfterMs: -100_000 });
    const summary = loadTlsMaterial(certPath, keyPath).summary;
    expect(summary.expiredOrNotYetValid).toBe(true);
    expect(describeTls(summary).join('\n')).toContain('expired or not yet valid');
  });

  it('flags a certificate that is not valid yet', () => {
    const { certPath, keyPath } = writeCert({ notBeforeMs: 3_600_000, notAfterMs: 7_200_000 });
    expect(loadTlsMaterial(certPath, keyPath).summary.expiredOrNotYetValid).toBe(true);
  });

  it('reports a world-readable key on POSIX, and stays quiet on Windows', () => {
    const { certPath, keyPath } = writeCert();
    if (process.platform === 'win32') {
      // The POSIX mode bits are not meaningful here. Refusing would make this a
      // portability bug rather than a security check, so it reports nothing.
      expect(loadTlsMaterial(certPath, keyPath).summary.privateKeyWorldReadable).toBeUndefined();
      return;
    }
    chmodSync(keyPath, 0o644);
    const summary = loadTlsMaterial(certPath, keyPath).summary;
    expect(summary.privateKeyWorldReadable).toBe(true);
    expect(describeTls(summary).join('\n')).toContain('readable beyond its owner');

    chmodSync(keyPath, 0o600);
    expect(loadTlsMaterial(certPath, keyPath).summary.privateKeyWorldReadable).toBe(false);
  });
});
