/**
 * Identifying a device key without ever holding one.
 *
 * ## The request this answers
 *
 * The founder asked the console to show *"Device Key (masked)"*. Taken
 * literally that is not buildable: a device key is generated at activation,
 * shown once, and stored **only** as a scrypt hash (`CLAUDE.md` §18.2). There
 * is no ciphertext to decrypt and no plaintext to mask.
 *
 * Refusing there would have been useless, because the need is real. An
 * operations desk wants one question settled — *is the key this shop is holding
 * the right one?* — and two things answer it without Telga knowing a key:
 * a **fingerprint** derived from the stored hash, and a **check** against a key
 * the shop reads out.
 *
 * These tests pin the properties that make that safe.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deviceKeyFingerprint, hashAdminSecret, verifyDeviceKey } from '@telga/api';

const KEY = 'a-device-key-43-characters-long-for-testing';

describe('the fingerprint names a key without revealing it', () => {
  it('is stable for the same stored hash', async () => {
    const stored = await hashAdminSecret(KEY);
    expect(deviceKeyFingerprint(stored.hash)).toBe(deviceKeyFingerprint(stored.hash));
  });

  it('differs for different keys', async () => {
    // Two devices with different fingerprints hold different keys. That
    // comparison is most of what "see the key" was ever for.
    const a = await hashAdminSecret(KEY);
    const b = await hashAdminSecret('a-completely-different-device-key-value');
    expect(deviceKeyFingerprint(a.hash)).not.toBe(deviceKeyFingerprint(b.hash));
  });

  it('changes when a device is re-enrolled with a new key', async () => {
    // Re-enrolment issues a fresh key, so a case note from last month names a
    // fingerprint that no longer matches — which is the point.
    const before = await hashAdminSecret(KEY);
    const after = await hashAdminSecret(KEY);
    // Same key, different salt: scrypt output differs, so the fingerprint does.
    expect(before.hash).not.toBe(after.hash);
    expect(deviceKeyFingerprint(before.hash)).not.toBe(deviceKeyFingerprint(after.hash));
  });

  it('contains no character a person reliably mishears', async () => {
    // The activation code's alphabet, for the same reason: a misread
    // fingerprint gives a confident wrong answer.
    const stored = await hashAdminSecret(KEY);
    const fp = deviceKeyFingerprint(stored.hash) ?? '';
    expect(fp).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{3}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{3}$/);
    expect(fp).not.toMatch(/[IO01]/);
  });

  it('is not the stored hash, nor a prefix of it', async () => {
    const stored = await hashAdminSecret(KEY);
    const fp = deviceKeyFingerprint(stored.hash) ?? '';
    const bare = fp.replace('-', '');
    expect(stored.hash).not.toContain(bare);
    // And it is a second one-way step on top of the hash, not the hash itself.
    const naive = createHash('sha256').update(stored.hash).digest('hex');
    expect(naive).not.toContain(bare.toLowerCase());
  });

  it('cannot be computed by a shop from their own key alone', async () => {
    // Deliberate: a value a shop could compute is a value an attacker holding
    // one phished key could use to test it against other devices.
    const stored = await hashAdminSecret(KEY);
    const fromKeyAlone = deviceKeyFingerprint(
      createHash('sha256').update(KEY).digest('hex'),
    );
    expect(fromKeyAlone).not.toBe(deviceKeyFingerprint(stored.hash));
  });

  it('is absent for a device that has never been activated', async () => {
    // It has no key. Printing a fingerprint for one would invent a fact.
    expect(deviceKeyFingerprint(null)).toBeUndefined();
    expect(deviceKeyFingerprint(undefined)).toBeUndefined();
    expect(deviceKeyFingerprint('')).toBeUndefined();
  });
});

describe('checking a key the shop read out', () => {
  it('confirms the right key', async () => {
    const stored = await hashAdminSecret(KEY);
    const enrolment = { secret_hash: stored.hash, secret_salt: stored.salt };
    expect(await verifyDeviceKey(enrolment, KEY)).toBe('MATCH');
  });

  it('refuses the wrong one', async () => {
    const stored = await hashAdminSecret(KEY);
    const enrolment = { secret_hash: stored.hash, secret_salt: stored.salt };
    expect(await verifyDeviceKey(enrolment, 'not-the-key')).toBe('NO_MATCH');
  });

  it('tolerates the whitespace a person reading aloud produces', async () => {
    const stored = await hashAdminSecret(KEY);
    const enrolment = { secret_hash: stored.hash, secret_salt: stored.salt };
    expect(await verifyDeviceKey(enrolment, `  ${KEY}  `)).toBe('MATCH');
  });

  it('says plainly when a device has no key yet', async () => {
    // Unlike `/activate`, this caller is a signed-in administrator who can
    // already list every device — so distinguishing this discloses nothing and
    // saves them checking a key against a device that was never activated.
    expect(await verifyDeviceKey(undefined, KEY)).toBe('NOT_ENROLLED');
  });

  it('answers in three words and returns no key material', async () => {
    const stored = await hashAdminSecret(KEY);
    const enrolment = { secret_hash: stored.hash, secret_salt: stored.salt };
    const answer = await verifyDeviceKey(enrolment, KEY);
    expect(['MATCH', 'NO_MATCH', 'NOT_ENROLLED']).toContain(answer);
    expect(String(answer)).not.toContain(KEY);
  });
});
