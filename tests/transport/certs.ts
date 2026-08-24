/**
 * A self-signed certificate generator, for tests only.
 *
 * ## Why this exists rather than a fixture file or an `openssl` call
 *
 * A committed certificate means a committed **private key**, and this
 * repository refuses to hold one — `check-committed.mjs` would reject it, and
 * rightly. Shelling out to `openssl` would make the TLS tests depend on a
 * binary that is present on this machine and not guaranteed on a runner, which
 * is the kind of dependency that turns into a skipped test.
 *
 * So the certificate is built here, in memory, from `node:crypto` alone: a
 * keypair, a hand-encoded X.509 body, and a signature over it. Nothing touches
 * the disk unless a test writes it to a temporary directory it then deletes.
 *
 * DER is not complicated — it is length-prefixed tags — and the subset a
 * self-signed certificate needs is small. What follows is that subset and
 * nothing more.
 *
 * **This is test scaffolding.** The application never generates a certificate:
 * `09 Engineering/Local Certificate Handling.md` says why, and
 * `transport/config.ts` refuses to start HTTPS without explicit paths.
 */

import { createSign, generateKeyPairSync } from 'node:crypto';

// --- minimal DER ------------------------------------------------------------

/** Encode a length in DER's short or long form. */
function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let value = n;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, body: Buffer): Buffer =>
  Buffer.concat([Buffer.from([tag]), len(body.length), body]);

const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));

/** A positive INTEGER. A leading zero is prepended when the top bit is set. */
function int(value: Buffer | number): Buffer {
  let body = typeof value === 'number' ? Buffer.from([value]) : value;
  if (body.length === 0) body = Buffer.from([0]);
  if ((body[0] as number) & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return tlv(0x02, body);
}

/** An OID, from its dotted form. */
function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const first = (parts[0] as number) * 40 + (parts[1] as number);
  const bytes: number[] = [first];
  for (const part of parts.slice(2)) {
    const chunks: number[] = [];
    let value = part;
    do {
      chunks.unshift(value & 0x7f);
      value >>>= 7;
    } while (value > 0);
    for (let i = 0; i < chunks.length - 1; i += 1) chunks[i] = (chunks[i] as number) | 0x80;
    bytes.push(...chunks);
  }
  return tlv(0x06, Buffer.from(bytes));
}

const nullDer = Buffer.from([0x05, 0x00]);
const utf8 = (value: string): Buffer => tlv(0x0c, Buffer.from(value, 'utf8'));
const bitString = (body: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), body]));
const octet = (body: Buffer): Buffer => tlv(0x04, body);
const bool = (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const explicitTag = (n: number, body: Buffer): Buffer => tlv(0xa0 | n, body);

/** `YYMMDDHHMMSSZ`, which is what UTCTime wants for dates before 2050. */
function utcTime(date: Date): Buffer {
  const p = (n: number, width = 2): string => String(n).padStart(width, '0');
  const text =
    p(date.getUTCFullYear() % 100) +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds()) +
    'Z';
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

const OID_COMMON_NAME = '2.5.4.3';
const OID_SHA256_RSA = '1.2.840.113549.1.1.11';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';

/** A Name containing a single common name. */
const commonName = (value: string): Buffer => seq(set(seq(oid(OID_COMMON_NAME), utf8(value))));

/** `dNSName` and `iPAddress` entries for the SAN extension. */
function subjectAltName(dnsNames: readonly string[], ipAddresses: readonly string[]): Buffer {
  const entries = [
    ...dnsNames.map((name) => tlv(0x82, Buffer.from(name, 'ascii'))),
    ...ipAddresses.map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number)))),
  ];
  return seq(oid(OID_SUBJECT_ALT_NAME), octet(seq(...entries)));
}

export interface GeneratedCertificate {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  /** A second, unrelated key — for the certificate/key mismatch test. */
  readonly otherPrivateKeyPem: string;
}

export interface CertificateOptions {
  readonly commonName?: string;
  readonly dnsNames?: readonly string[];
  readonly ipAddresses?: readonly string[];
  /** Offset from now, in milliseconds. Negative makes an already-expired cert. */
  readonly notBeforeMs?: number;
  readonly notAfterMs?: number;
}

const pem = (label: string, der: Buffer): string => {
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN ${label}-----\n${body}${body.endsWith('\n') ? '' : '\n'}-----END ${label}-----\n`;
};

/**
 * Generate a self-signed certificate and its key.
 *
 * RSA-2048 with SHA-256. Slower to generate than an EC key, but it is the pair
 * every TLS stack accepts without argument, and a test generates one or two.
 */
export function generateSelfSignedCertificate(
  options: CertificateOptions = {},
): GeneratedCertificate {
  const subject = options.commonName ?? 'telga-training.localhost';
  const dnsNames = options.dnsNames ?? ['localhost', subject];
  const ipAddresses = options.ipAddresses ?? ['127.0.0.1'];

  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const name = commonName(subject);
  const algorithm = seq(oid(OID_SHA256_RSA), nullDer);

  const now = Date.now();
  const notBefore = new Date(now + (options.notBeforeMs ?? -60_000));
  const notAfter = new Date(now + (options.notAfterMs ?? 24 * 60 * 60_000));

  const extensions = explicitTag(
    3,
    seq(
      // A leaf certificate: not a CA. Stated rather than left to a default.
      seq(oid(OID_BASIC_CONSTRAINTS), bool(true), octet(seq(bool(false)))),
      // digitalSignature | keyEncipherment
      seq(oid(OID_KEY_USAGE), bool(true), octet(tlv(0x03, Buffer.from([0x05, 0xa0])))),
      subjectAltName(dnsNames, ipAddresses),
    ),
  );

  const tbs = seq(
    explicitTag(0, int(2)), // v3
    int(Buffer.from([0x01, 0x00, 0x01])), // serial
    algorithm,
    name, // issuer — self-signed, so the same as the subject
    seq(utcTime(notBefore), utcTime(notAfter)),
    name, // subject
    spki,
    extensions,
  );

  const signature = createSign('sha256').update(tbs).sign(privateKey);
  const certificate = seq(tbs, algorithm, bitString(signature));

  return {
    certificatePem: pem('CERTIFICATE', certificate),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    otherPrivateKeyPem: other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
