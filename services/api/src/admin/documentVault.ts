/**
 * Where a shop's licence and ID photographs are kept.
 *
 * ## Why this is its own module with its own rules
 *
 * The founder decided these are stored, for a legitimate and standard reason:
 * identifying an accountable person when a shop commits fraud. A know-your-
 * business file with no identity document is not one. [[Decision Log]] **D125**.
 *
 * What follows from that decision is **R37**: a photographed national ID or
 * passport is sensitive personal data by any standard, so holding it is not the
 * risk — holding it *carelessly* is. This module is the whole of the care:
 *
 *   - **Encrypted at rest**, AES-256-GCM, one random nonce per file.
 *   - **Refuses to store anything when no key is configured.** A missing key
 *     writing plaintext "for now" is how a store of passports ends up
 *     unencrypted on a volume nobody remembers provisioning.
 *   - **The ciphertext is authenticated**, so a file altered on disk fails to
 *     open rather than returning altered bytes.
 *   - **Nothing identifying is in the filename.** Names are random; which shop a
 *     file belongs to is in the database, behind the console's authorisation.
 *   - **The path is derived, never taken from input.** A caller supplies an id
 *     this module generated; it cannot supply a path.
 *
 * ## What this module deliberately does not decide
 *
 * Who may read a document, and whether that read is audited. Those belong to the
 * route, because they are authorisation questions and this is a storage
 * primitive. The route requires step-up re-authentication and writes an audit
 * event, so "who looked at whose passport" is answerable.
 *
 * ## Retention
 *
 * Not implemented here, and named so it is not forgotten: R37 requires a written
 * retention and deletion policy **before a second shop is onboarded**. Deletion
 * is `unlink` plus clearing `document_uri`; the hard part is the policy, not the
 * call.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** AES-256-GCM: 32-byte key, 12-byte nonce, 16-byte tag. */
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** What a scanned document may be. Anything else is refused unopened. */
export const ALLOWED_DOCUMENT_TYPES = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
} as const);

export type DocumentMediaType = keyof typeof ALLOWED_DOCUMENT_TYPES;

/**
 * Four megabytes.
 *
 * A photograph of a licence taken on a phone is comfortably under this. The cap
 * exists because an upload route with no limit is a way to fill the volume the
 * ledger lives on, which would stop every shop trading.
 */
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

export type DocumentStoreRefusal =
  | 'NO_ENCRYPTION_KEY'
  | 'KEY_WRONG_LENGTH'
  | 'MEDIA_TYPE_NOT_ALLOWED'
  | 'DOCUMENT_EMPTY'
  | 'DOCUMENT_TOO_LARGE';

export class DocumentStoreError extends Error {
  readonly code = 'DOCUMENT_STORE_REFUSED';
  constructor(readonly refusal: DocumentStoreRefusal) {
    super(`Refusing to store the document: ${refusal}.`);
    this.name = 'DocumentStoreError';
  }
}

export interface DocumentVaultOptions {
  /** Directory on the mounted volume. Created if absent. */
  readonly directory: string;
  /**
   * 32 bytes, hex or base64url. Supplied by the operator through the
   * environment and **never** committed, logged or defaulted.
   */
  readonly encryptionKey: string | undefined;
  readonly newId: (prefix: string) => string;
}

export interface StoredDocument {
  /** The opaque handle written to `merchant_application_documents.document_uri`. */
  readonly documentUri: string;
  readonly mediaType: DocumentMediaType;
  readonly bytes: number;
}

/**
 * Read the key, or refuse.
 *
 * Accepts hex or base64url so an operator can paste whatever their generator
 * produced, and checks the decoded length rather than the string's — a 64-char
 * hex key and a 32-char one look equally plausible to a person.
 */
function keyFrom(raw: string | undefined): Buffer {
  if (raw === undefined || raw.trim().length === 0) {
    throw new DocumentStoreError('NO_ENCRYPTION_KEY');
  }
  const trimmed = raw.trim();
  const decoded = /^[0-9a-fA-F]+$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64url');
  if (decoded.length !== KEY_BYTES) throw new DocumentStoreError('KEY_WRONG_LENGTH');
  return decoded;
}

export const isAllowedMediaType = (value: string): value is DocumentMediaType =>
  Object.prototype.hasOwnProperty.call(ALLOWED_DOCUMENT_TYPES, value);

/**
 * A vault over one directory.
 *
 * The key is read **once, when the vault is created**, so a deployment with no
 * key fails at startup rather than at the first upload — with an admin standing
 * in a shop holding a passport.
 */
export function createDocumentVault(options: DocumentVaultOptions): {
  store: (input: { readonly content: Buffer; readonly mediaType: string }) => StoredDocument;
  read: (documentUri: string, mediaType: DocumentMediaType) => Buffer;
} {
  const key = keyFrom(options.encryptionKey);
  mkdirSync(options.directory, { recursive: true });

  /**
   * The file for a handle.
   *
   * The handle is validated against the shape this module generates and then
   * joined — a path taken from input and joined is how a request for
   * `../../etc/passwd` gets served, and the same reasoning `tenants.ts` applies
   * to database names applies here.
   */
  const pathFor = (documentUri: string): string => {
    if (!/^doc_[A-Za-z0-9_-]{1,64}\.enc$/.test(documentUri)) {
      throw new Error(`Refusing an unsafe document handle: ${documentUri}`);
    }
    return join(options.directory, documentUri);
  };

  return {
    store: ({ content, mediaType }) => {
      if (!isAllowedMediaType(mediaType)) throw new DocumentStoreError('MEDIA_TYPE_NOT_ALLOWED');
      if (content.byteLength === 0) throw new DocumentStoreError('DOCUMENT_EMPTY');
      if (content.byteLength > MAX_DOCUMENT_BYTES) {
        throw new DocumentStoreError('DOCUMENT_TOO_LARGE');
      }

      // A fresh nonce per file. Reusing one across two files under the same key
      // is the one mistake GCM does not survive.
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      // The media type is authenticated but not encrypted: it is not a secret,
      // and binding it means a file cannot be re-labelled as another type
      // without the tag failing.
      cipher.setAAD(Buffer.from(mediaType, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(content), cipher.final()]);
      const tag = cipher.getAuthTag();

      // `nonce || tag || ciphertext`, and the media type alongside in the
      // database. Nothing in the filename says whose document this is.
      const documentUri = `${options.newId('doc')}.enc`;
      writeFileSync(pathFor(documentUri), Buffer.concat([nonce, tag, ciphertext]), {
        mode: 0o600,
      });

      return { documentUri, mediaType, bytes: content.byteLength };
    },

    /**
     * `mediaType` comes from the database row, not from the disk.
     *
     * It was bound as additional authenticated data at encryption, so passing a
     * different one fails the tag check. That is the point: a file relabelled in
     * the database — a passport recorded as a licence — does not open. The
     * caller cannot skip it, because the signature does not let them.
     */
    read: (documentUri, mediaType) => {
      const raw = readFileSync(pathFor(documentUri));
      const nonce = raw.subarray(0, NONCE_BYTES);
      const tag = raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
      const ciphertext = raw.subarray(NONCE_BYTES + TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAuthTag(tag);
      decipher.setAAD(Buffer.from(mediaType, 'utf8'));
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    },
  };
}

/**
 * A key an operator can put in the environment.
 *
 * Printed by a provisioning command and never stored by Telga. Losing it means
 * the documents cannot be read again — which is the correct failure, and the
 * reason it belongs in a password manager rather than a deploy script.
 */
export const newDocumentEncryptionKey = (): string => randomBytes(KEY_BYTES).toString('hex');
