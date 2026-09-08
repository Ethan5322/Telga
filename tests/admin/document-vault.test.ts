/**
 * Storing a shop owner's passport photograph.
 *
 * The founder decided these are kept, to identify an accountable person when a
 * shop commits fraud ([[Decision Log]] D125). **R37** is what that decision
 * obliges, and this file is where most of it is proved: encrypted at rest,
 * refusing to store anything at all without a key, authenticated so an altered
 * file will not open, and with nothing identifying in a filename.
 *
 * The parts R37 leaves to the route — step-up re-authentication and an audit
 * entry for every read — are asserted in `register-shop-documents.test.ts`,
 * because they are authorisation questions rather than storage ones.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DocumentStoreError,
  MAX_DOCUMENT_BYTES,
  createDocumentVault,
  isAllowedMediaType,
  newDocumentEncryptionKey,
} from '@telga/api';

let dir: string;
let seq = 0;
const newId = (prefix: string): string => `${prefix}_${String(++seq)}`;
const KEY = newDocumentEncryptionKey();

/** A tiny but real JPEG header, so "bytes survive" means something. */
const PASSPORT = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

const vault = (over: { key?: string | undefined } = {}) =>
  createDocumentVault({
    directory: dir,
    encryptionKey: 'key' in over ? over.key : KEY,
    newId,
  });

beforeEach(() => {
  seq = 0;
  dir = mkdtempSync(join(tmpdir(), 'telga-docs-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a document goes in and comes back unchanged', () => {
  it('round-trips the exact bytes', () => {
    const store = vault();
    const stored = store.store({ content: PASSPORT, mediaType: 'image/jpeg' });
    expect(store.read(stored.documentUri, 'image/jpeg')).toEqual(PASSPORT);
    expect(stored.bytes).toBe(PASSPORT.byteLength);
  });

  it('accepts the three types a scanned document arrives as', () => {
    const store = vault();
    for (const mediaType of ['image/jpeg', 'image/png', 'application/pdf'] as const) {
      const stored = store.store({ content: PASSPORT, mediaType });
      expect(store.read(stored.documentUri, mediaType)).toEqual(PASSPORT);
    }
  });
});

describe('encrypted at rest', () => {
  it('writes no plaintext to the disk', () => {
    // The assertion R37 exists for. If this ever passes by accident, a volume
    // backup contains readable passports.
    const store = vault();
    const stored = store.store({ content: PASSPORT, mediaType: 'image/jpeg' });

    const onDisk = readFileSync(join(dir, stored.documentUri));
    expect(onDisk.includes(PASSPORT)).toBe(false);
    // Not even the JPEG magic number survives in the clear.
    expect(onDisk.includes(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false);
    expect(onDisk.byteLength).toBeGreaterThan(PASSPORT.byteLength);
  });

  it('produces different ciphertext for the same file twice', () => {
    // A fresh nonce per file. Reusing one across two files under one key is the
    // single mistake AES-GCM does not survive, and identical ciphertext would
    // also disclose that two shops filed the same document.
    const store = vault();
    const a = store.store({ content: PASSPORT, mediaType: 'image/jpeg' });
    const b = store.store({ content: PASSPORT, mediaType: 'image/jpeg' });
    expect(readFileSync(join(dir, a.documentUri))).not.toEqual(
      readFileSync(join(dir, b.documentUri)),
    );
  });

  it('will not open a file that was altered on disk', () => {
    const store = vault();
    const stored = store.store({ content: PASSPORT, mediaType: 'image/jpeg' });
    const path = join(dir, stored.documentUri);
    const raw = readFileSync(path);
    raw[raw.length - 1] ^= 0xff;
    writeFileSync(path, raw);

    expect(() => store.read(stored.documentUri, 'image/jpeg')).toThrow();
  });

  it('will not open under a different key', () => {
    const store = vault();
    const stored = store.store({ content: PASSPORT, mediaType: 'image/jpeg' });
    const other = createDocumentVault({
      directory: dir,
      encryptionKey: newDocumentEncryptionKey(),
      newId,
    });
    expect(() => other.read(stored.documentUri, 'image/jpeg')).toThrow();
  });

  it('will not open a document relabelled as another type', () => {
    // The media type is bound as additional authenticated data, so a passport
    // recorded in the database as a licence does not decrypt. A row edited by
    // anything that reaches the database cannot silently re-file a document.
    const store = vault();
    const stored = store.store({ content: PASSPORT, mediaType: 'image/jpeg' });
    expect(() => store.read(stored.documentUri, 'application/pdf')).toThrow();
  });
});

describe('what it refuses', () => {
  it('refuses to store anything at all with no key configured', () => {
    // The rule that matters most: a missing key must never mean "write it in
    // the clear for now". That is how a store of passports ends up unencrypted
    // on a volume nobody remembers provisioning.
    for (const key of [undefined, '', '   ']) {
      expect(() => vault({ key })).toThrow(DocumentStoreError);
      try {
        vault({ key });
      } catch (error) {
        expect((error as DocumentStoreError).refusal).toBe('NO_ENCRYPTION_KEY');
      }
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a key of the wrong length rather than stretching it', () => {
    // A 16-byte key and a 32-byte one look equally plausible to a person, so
    // the decoded length is checked, not the string's.
    expect(() => vault({ key: 'abcd1234' })).toThrow(DocumentStoreError);
  });

  it('accepts a key as hex or base64url, because an operator pastes either', () => {
    const raw = Buffer.from(newDocumentEncryptionKey(), 'hex');
    expect(() => vault({ key: raw.toString('hex') })).not.toThrow();
    expect(() => vault({ key: raw.toString('base64url') })).not.toThrow();
  });

  it('refuses a media type outside the three, unopened', () => {
    const store = vault();
    for (const mediaType of ['text/html', 'application/x-msdownload', 'image/svg+xml', '']) {
      expect(() => store.store({ content: PASSPORT, mediaType }), mediaType).toThrow(
        DocumentStoreError,
      );
      expect(isAllowedMediaType(mediaType)).toBe(false);
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses an empty file and one over the cap', () => {
    // No cap is a way to fill the volume the ledger lives on, which would stop
    // every shop trading.
    const store = vault();
    expect(() => store.store({ content: Buffer.alloc(0), mediaType: 'image/jpeg' })).toThrow(
      DocumentStoreError,
    );
    expect(() =>
      store.store({ content: Buffer.alloc(MAX_DOCUMENT_BYTES + 1), mediaType: 'image/jpeg' }),
    ).toThrow(DocumentStoreError);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('the handle', () => {
  it('says nothing about whose document it is', () => {
    // Which shop a file belongs to lives in the database, behind the console's
    // authorisation — not in a filename readable by anyone with the volume.
    const store = vault();
    const stored = store.store({ content: PASSPORT, mediaType: 'image/jpeg' });
    expect(stored.documentUri).toMatch(/^doc_[A-Za-z0-9_-]+\.enc$/);
    for (const leak of ['passport', 'jpeg', 'merchant', 'abebe', 'TIN']) {
      expect(stored.documentUri.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it('refuses a handle that tries to walk out of the directory', () => {
    // The path is derived from a validated handle, never joined from input.
    const store = vault();
    for (const handle of [
      '../../etc/passwd',
      'doc_1.enc/../../../etc/passwd',
      '/etc/passwd',
      'doc_1.txt',
      'doc_1',
      '..\\..\\windows\\system32',
    ]) {
      expect(() => store.read(handle, 'image/jpeg'), handle).toThrow(/unsafe document handle/);
    }
  });
});

describe('the key an operator generates', () => {
  it('is 32 bytes, random, and never the same twice', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const key = newDocumentEncryptionKey();
      expect(Buffer.from(key, 'hex')).toHaveLength(32);
      keys.add(key);
    }
    expect(keys.size).toBe(200);
  });
});
