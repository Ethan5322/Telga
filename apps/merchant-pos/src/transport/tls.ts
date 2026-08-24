/**
 * Loading TLS material, and refusing to start when it is wrong.
 *
 * ## What this file never does
 *
 * Generate a key. Write a key. Read a key out of the repository. Print a key,
 * or any part of one, into a message or a log line. A path may appear in an
 * error; the contents never do — including in the mismatch check, which
 * compares derived public keys rather than reporting anything about either
 * input.
 *
 * ## Why the mismatch check exists
 *
 * A certificate and a key that do not belong together produce a TLS handshake
 * that fails per-connection, at the worst possible moment, with an error a
 * browser renders as an unexplained failure. Checking at startup turns that
 * into one clear refusal before anything is served.
 */

import { readFileSync, statSync } from 'node:fs';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { TransportConfigError } from './config';

export interface TlsMaterial {
  /** PEM text, as `node:https` wants it. */
  readonly cert: string;
  readonly key: string;
  /** Safe, non-identifying facts for a startup line. Never key material. */
  readonly summary: TlsSummary;
}

export interface TlsSummary {
  readonly subject: string;
  readonly issuer: string;
  readonly validFrom: string;
  readonly validTo: string;
  /** True when issuer and subject match: a self-signed certificate. */
  readonly selfSigned: boolean;
  readonly fingerprintSha256: string;
  /** Set when the certificate is not currently valid. */
  readonly expiredOrNotYetValid: boolean;
  /** Set on a POSIX host when the key file is readable by group or others. */
  readonly privateKeyWorldReadable?: boolean;
}

function readOrThrow(path: string, what: string, reasonCode: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    // The path, and why it failed. Never the contents.
    throw new TransportConfigError(
      reasonCode,
      `Could not read the TLS ${what} at "${path}" (${code})`,
    );
  }
}

/**
 * Whether a private key file is readable beyond its owner.
 *
 * Reported rather than refused: on Windows the POSIX mode bits are not
 * meaningful, and refusing there would make the check a portability bug instead
 * of a security one. On a POSIX host it is a warning worth printing.
 */
function keyPermissionsWorrying(path: string): boolean | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    const mode = statSync(path).mode;
    // Any group or other bit set.
    return (mode & 0o077) !== 0;
  } catch {
    return undefined;
  }
}

/**
 * Load and validate a certificate and its key.
 *
 * Throws `TransportConfigError` — the CLI turns it into exit 4 — for a missing
 * file, an unparseable certificate, an unparseable key, or a pair that do not
 * belong together.
 */
export function loadTlsMaterial(certificatePath: string, privateKeyPath: string): TlsMaterial {
  const certPem = readOrThrow(certificatePath, 'certificate', 'TLS_CERTIFICATE_UNREADABLE');
  const keyPem = readOrThrow(privateKeyPath, 'private key', 'TLS_PRIVATE_KEY_UNREADABLE');

  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certPem);
  } catch {
    throw new TransportConfigError(
      'TLS_CERTIFICATE_INVALID',
      `The file at "${certificatePath}" is not a readable X.509 certificate`,
    );
  }

  let privatePublic: ReturnType<typeof createPublicKey>;
  try {
    privatePublic = createPublicKey(createPrivateKey(keyPem));
  } catch {
    // Deliberately says nothing about what the file contained.
    throw new TransportConfigError(
      'TLS_PRIVATE_KEY_INVALID',
      `The file at "${privateKeyPath}" is not a readable private key`,
    );
  }

  // The pair test: does this key actually correspond to this certificate?
  // Compared as DER-encoded public keys, so neither value is ever reported.
  const certPublicDer = certificate.publicKey.export({ type: 'spki', format: 'der' });
  const keyPublicDer = privatePublic.export({ type: 'spki', format: 'der' });
  if (!certPublicDer.equals(keyPublicDer)) {
    throw new TransportConfigError(
      'TLS_CERTIFICATE_KEY_MISMATCH',
      `The certificate at "${certificatePath}" was not issued for the key at "${privateKeyPath}"`,
    );
  }

  const now = Date.now();
  const notBefore = Date.parse(certificate.validFrom);
  const notAfter = Date.parse(certificate.validTo);
  const expiredOrNotYetValid =
    Number.isFinite(notBefore) && Number.isFinite(notAfter)
      ? now < notBefore || now > notAfter
      : false;

  return {
    cert: certPem,
    key: keyPem,
    summary: {
      subject: certificate.subject,
      issuer: certificate.issuer,
      validFrom: certificate.validFrom,
      validTo: certificate.validTo,
      selfSigned: certificate.issuer === certificate.subject,
      fingerprintSha256: certificate.fingerprint256,
      expiredOrNotYetValid,
      privateKeyWorldReadable: keyPermissionsWorrying(privateKeyPath),
    },
  };
}

/**
 * The lines a startup banner may print about a certificate.
 *
 * Subject, issuer, validity and a fingerprint. A fingerprint is a public value
 * — it is what an operator compares to confirm they are looking at the right
 * certificate — and nothing here is derived from the private key.
 */
export function describeTls(summary: TlsSummary): readonly string[] {
  const lines = [
    `  certificate: ${summary.subject}`,
    `  issuer:      ${summary.issuer}${summary.selfSigned ? ' (SELF-SIGNED)' : ''}`,
    `  valid:       ${summary.validFrom} .. ${summary.validTo}`,
    `  sha256:      ${summary.fingerprintSha256}`,
  ];
  if (summary.selfSigned) {
    lines.push(
      '  A self-signed certificate is NOT production trust. Browsers will warn, and',
      '  should. It encrypts the wire for the controlled training machine; it proves',
      '  nothing about who is on the other end.',
    );
  }
  if (summary.expiredOrNotYetValid) {
    lines.push('  WARNING: this certificate is expired or not yet valid.');
  }
  if (summary.privateKeyWorldReadable === true) {
    lines.push('  WARNING: the private key file is readable beyond its owner. Tighten it to 0600.');
  }
  return lines;
}
