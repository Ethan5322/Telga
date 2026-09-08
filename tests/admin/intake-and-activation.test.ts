/**
 * Two gaps in the onboarding chain, closed.
 *
 * **Intake** — nothing in the source inserted into `merchant_applications`, so
 * the review queue reviewed nothing. What is added is the rule for whether a
 * submission may be recorded at all: which documents an Ethiopian shop must
 * produce, and which of them lapse.
 *
 * **Activation** — the console could issue a one-time code and nothing could
 * redeem one. `normalizeEnrollmentToken` had no caller outside the tests, so a
 * shop could be read a code down the phone and had nowhere to type it.
 *
 * The document register is a **proposal awaiting legal review** (CLAUDE.md §8),
 * not a compliance claim. It is encoded so the requirement is applied
 * consistently, not because it is known to be sufficient.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  OPTIONAL_DOCUMENTS,
  REQUIRED_DOCUMENTS,
  ENROLLMENT_TOKEN_TTL_MS,
  enrollmentExpiryFrom,
  hashAdminSecret,
  missingDocuments,
  newEnrollmentToken,
  newSubmissionReference,
  normalizeEnrollmentToken,
  redeemEnrollmentToken,
  requiredDocumentsFor,
  submissionRejection,
} from '@telga/api';
import type { ApplicationSubmission, DocumentKind } from '@telga/api';
import type { DeviceId, Timestamp } from '@telga/domain';
import { DEVICE_A, MERCHANT_A, makeUiHarness } from '../ui/helpers';
import type { UiHarness } from '../ui/helpers';

const NOW = '2026-09-08T09:00:00.000Z';

let harness: UiHarness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

const document = (kind: DocumentKind): { kind: DocumentKind; reference: string; expiresAt?: string } =>
  kind === 'TRADE_LICENCE'
    ? { kind, reference: `REF-${kind}`, expiresAt: '2027-06-30T00:00:00.000Z' }
    : { kind, reference: `REF-${kind}` };

const submission = (over: Partial<ApplicationSubmission> = {}): ApplicationSubmission => ({
  legalName: 'Abebe Trading PLC',
  ownerName: 'Abebe Bekele',
  phone: '+251911000000',
  address: 'Bole Road 12',
  locality: 'Addis Ababa',
  entityType: 'SOLE_TRADER',
  documents: REQUIRED_DOCUMENTS.map(document),
  ...over,
});

describe('what a shop must produce', () => {
  it('accepts a complete sole-trader application', () => {
    expect(submissionRejection(submission(), NOW)).toBeUndefined();
  });

  it('requires each of the founder’s three, and names the omission', () => {
    for (const omitted of REQUIRED_DOCUMENTS) {
      const documents = REQUIRED_DOCUMENTS.filter((k) => k !== omitted).map(document);
      expect(submissionRejection(submission({ documents }), NOW), omitted).toBe('DOCUMENT_MISSING');
    }
  });

  it('demands the same three of a company as of a sole trader', () => {
    // The founder's form is one form. An earlier version of this module also
    // required a company's constitution and signing authority, which would have
    // refused registrations the specified form is meant to accept.
    const papers = REQUIRED_DOCUMENTS.map(document);
    expect(submissionRejection(submission({ documents: papers }), NOW)).toBeUndefined();
    expect(
      submissionRejection(submission({ entityType: 'COMPANY', documents: papers }), NOW),
    ).toBeUndefined();
    expect(requiredDocumentsFor('COMPANY')).toEqual(requiredDocumentsFor('SOLE_TRADER'));
  });

  it('accepts an optional document without ever demanding one', () => {
    // A shop that happens to bring a bank letter has it recorded; a shop that
    // does not is still registered.
    for (const optional of OPTIONAL_DOCUMENTS) {
      const documents = [...REQUIRED_DOCUMENTS.map(document), document(optional)];
      expect(submissionRejection(submission({ documents }), NOW), optional).toBeUndefined();
    }
    expect(missingDocuments(submission())).toEqual([]);
  });

  it('says which documents are missing, so an operator can ask for them', () => {
    const partial = submission({ documents: [document('TIN_CERTIFICATE')] });
    expect(missingDocuments(partial)).toEqual(
      REQUIRED_DOCUMENTS.filter((k) => k !== 'TIN_CERTIFICATE'),
    );
    expect(missingDocuments(submission())).toEqual([]);
  });

  it('refuses an expired trade licence rather than treating it as paperwork', () => {
    // Not a detail to fix after approval: the shop is not currently licensed.
    const expired = REQUIRED_DOCUMENTS.map((k) =>
      k === 'TRADE_LICENCE'
        ? { kind: k, reference: 'TL-1', expiresAt: '2026-01-01T00:00:00.000Z' }
        : document(k),
    );
    expect(submissionRejection(submission({ documents: expired }), NOW)).toBe(
      'LICENCE_ALREADY_EXPIRED',
    );
  });

  it('requires an expiry on the one document that lapses', () => {
    const noExpiry = REQUIRED_DOCUMENTS.map((k) =>
      k === 'TRADE_LICENCE' ? { kind: k, reference: 'TL-1' } : document(k),
    );
    expect(submissionRejection(submission({ documents: noExpiry }), NOW)).toBe(
      'LICENCE_EXPIRY_REQUIRED',
    );
  });

  it('refuses a document with no reference number, and a duplicated one', () => {
    const blank = REQUIRED_DOCUMENTS.map((k) =>
      k === 'TIN_CERTIFICATE' ? { kind: k, reference: '   ' } : document(k),
    );
    expect(submissionRejection(submission({ documents: blank }), NOW)).toBe(
      'DOCUMENT_REFERENCE_REQUIRED',
    );

    const twice = [...REQUIRED_DOCUMENTS.map(document), document('TIN_CERTIFICATE')];
    expect(submissionRejection(submission({ documents: twice }), NOW)).toBe('DOCUMENT_DUPLICATED');
  });

  it('requires the fields a shop cannot be contacted or found without', () => {
    expect(submissionRejection(submission({ legalName: '  ' }), NOW)).toBe('LEGAL_NAME_REQUIRED');
    expect(submissionRejection(submission({ ownerName: '' }), NOW)).toBe('OWNER_NAME_REQUIRED');
    expect(submissionRejection(submission({ phone: '' }), NOW)).toBe('PHONE_REQUIRED');
    expect(submissionRejection(submission({ address: '' }), NOW)).toBe('ADDRESS_REQUIRED');
    expect(submissionRejection(submission({ locality: '' }), NOW)).toBe('LOCALITY_REQUIRED');
  });

  it('accepts the ways an Ethiopian number is really written', () => {
    // A validator that encodes today's prefixes rejects a real shop the day a
    // new one is issued. Rejecting a real merchant is worse than accepting a
    // typo, which a callback catches within a day.
    for (const phone of ['+251911000000', '0911000000', '011 551 2345', '+251-91-100-0000']) {
      expect(submissionRejection(submission({ phone }), NOW), phone).toBeUndefined();
    }
    for (const phone of ['not-a-number', '123', '+251911000000000000']) {
      expect(submissionRejection(submission({ phone }), NOW), phone).toBe('PHONE_NOT_PLAUSIBLE');
    }
  });

  it('treats email as optional, but refuses one that cannot receive mail', () => {
    expect(submissionRejection(submission({ email: undefined }), NOW)).toBeUndefined();
    expect(submissionRejection(submission({ email: '' }), NOW)).toBeUndefined();
    expect(submissionRejection(submission({ email: 'abebe@example.et' }), NOW)).toBeUndefined();
    expect(submissionRejection(submission({ email: 'abebe-at-example' }), NOW)).toBe(
      'EMAIL_NOT_PLAUSIBLE',
    );
  });

  it('gives back a reference that cannot be guessed or counted', () => {
    // A sequential number would let anybody learn how many shops Telga has.
    const seen = new Set<string>();
    for (let i = 0; i < 1_000; i += 1) {
      const reference = newSubmissionReference();
      expect(reference).toMatch(/^TLG-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      seen.add(reference);
    }
    expect(seen.size).toBe(1_000);
  });

  it('requires exactly the three the founder’s form asks for', () => {
    expect(requiredDocumentsFor('SOLE_TRADER')).toEqual([
      'TRADE_LICENCE',
      'TIN_CERTIFICATE',
      'OWNER_PHOTO_ID',
    ]);
    // The three that were dropped from the required set are still accepted, and
    // still in migration 015's CHECK — widening that later would cost a
    // migration, so they stay.
    expect(OPTIONAL_DOCUMENTS).toContain('COMMERCIAL_REGISTRATION');
    expect(OPTIONAL_DOCUMENTS).toContain('PROOF_OF_ADDRESS');
    expect(OPTIONAL_DOCUMENTS).toContain('BANK_ACCOUNT_PROOF');
  });
});

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/** Put a device into the state the console leaves it in after issuing a code. */
async function issueCode(
  h: UiHarness,
  opts: { expiresAt?: string | null } = {},
): Promise<string> {
  const token = newEnrollmentToken();
  // Exactly what the console stores: the hash of the **normalized** code, not
  // the displayed grouping. See the note at `POST /devices/:id/enrollment-token`.
  const derived = await hashAdminSecret(normalizeEnrollmentToken(token));
  const at = h.api.now();
  h.api.driver.saveMerchant({ id: MERCHANT_A, status: 'ACTIVE', mode: 'TRAINING', at });
  h.api.driver.saveDevice({
    id: DEVICE_A,
    merchantId: MERCHANT_A,
    status: 'REGISTERED',
    deviceType: 'WEB_POS',
    at,
  });
  h.api.driver.saveDeviceEnrollment({
    deviceId: DEVICE_A,
    merchantId: MERCHANT_A,
    state: 'PENDING',
    secretHash: derived.hash,
    secretSalt: derived.salt,
    expiresAt: (opts.expiresAt === undefined
      ? enrollmentExpiryFrom(at)
      : (opts.expiresAt ?? undefined)) as Timestamp | undefined,
    at,
  });
  return token;
}

const redeem = (h: UiHarness, token: string, deviceId: DeviceId = DEVICE_A) =>
  redeemEnrollmentToken(h.api, { deviceId, token, correlationId: 'corr_activation' });

describe('redeeming an activation code', () => {
  it('exchanges the code for a device key and marks the device enrolled', async () => {
    harness = makeUiHarness('activation-ok');
    const token = await issueCode(harness);

    const result = await redeem(harness, token);
    expect(result.kind).toBe('ACTIVATED');
    if (result.kind !== 'ACTIVATED') return;

    // A 256-bit key, base64url — not the code that was read down the phone.
    expect(result.deviceSecret).toHaveLength(43);
    expect(result.deviceSecret).not.toBe(token);

    const enrolment = harness.api.driver.findDeviceEnrollment(DEVICE_A);
    expect(enrolment?.enrollment_state).toBe('ENROLLED');
  });

  it('accepts the code however the person wrote it down', async () => {
    harness = makeUiHarness('activation-format');
    const token = await issueCode(harness);
    const messy = ` ${token.toLowerCase().replace(/-/g, ' ')} `;
    expect((await redeem(harness, messy)).kind).toBe('ACTIVATED');
  });

  it('dies on redemption, so the same code cannot activate a second device', async () => {
    // Single use is structural: redeeming replaces the code's hash with the
    // key's, so there is nothing left for the code to verify against.
    harness = makeUiHarness('activation-single-use');
    const token = await issueCode(harness);
    expect((await redeem(harness, token)).kind).toBe('ACTIVATED');

    const second = await redeem(harness, token);
    expect(second).toMatchObject({ kind: 'REFUSED', reason: 'ACTIVATION_NOT_PENDING' });
  });

  it('refuses a wrong code', async () => {
    harness = makeUiHarness('activation-wrong');
    await issueCode(harness);
    const result = await redeem(harness, newEnrollmentToken());
    expect(result).toMatchObject({ kind: 'REFUSED', reason: 'ACTIVATION_REFUSED' });
    expect(harness.api.driver.findDeviceEnrollment(DEVICE_A)?.enrollment_state).toBe('PENDING');
  });

  it('gives an unknown device the same answer as a wrong code', async () => {
    // Otherwise this is a device-id oracle: an attacker with no code could
    // enumerate ids and learn which shops exist and which are mid-activation.
    harness = makeUiHarness('activation-oracle');
    const token = await issueCode(harness);
    const unknown = await redeem(harness, token, 'device_not_here' as DeviceId);
    const wrong = await redeem(harness, newEnrollmentToken());
    expect(unknown).toMatchObject({ kind: 'REFUSED', reason: 'ACTIVATION_REFUSED' });
    expect(wrong).toMatchObject({ kind: 'REFUSED', reason: 'ACTIVATION_REFUSED' });
  });

  it('tells an expired code apart, because the shop must ask for another', async () => {
    harness = makeUiHarness('activation-expired');
    const token = await issueCode(harness, {
      expiresAt: new Date(Date.parse(harness.api.now()) - 1_000).toISOString(),
    });
    expect(await redeem(harness, token)).toMatchObject({
      kind: 'REFUSED',
      reason: 'ACTIVATION_EXPIRED',
    });
  });

  it('refuses an expired code even when it is correct', async () => {
    // Expiry is checked before the hash, so a lapsed enrolment cannot be used
    // to test whether a code is right.
    harness = makeUiHarness('activation-expired-correct');
    const token = await issueCode(harness, { expiresAt: '2020-01-01T00:00:00.000Z' });
    expect((await redeem(harness, token)).kind).toBe('REFUSED');
    expect(harness.api.driver.findDeviceEnrollment(DEVICE_A)?.enrollment_state).toBe('PENDING');
  });

  it('will not re-activate a revoked device', async () => {
    // The case this most protects: a stolen POS whose enrolment was withdrawn
    // must stay withdrawn, whoever is holding an old code.
    harness = makeUiHarness('activation-revoked');
    const token = await issueCode(harness);
    const at = harness.api.now();
    harness.api.driver.saveDeviceEnrollment({
      deviceId: DEVICE_A,
      merchantId: MERCHANT_A,
      state: 'REVOKED',
      secretHash: 'x',
      secretSalt: 'y',
      at,
    });
    expect(await redeem(harness, token)).toMatchObject({
      kind: 'REFUSED',
      reason: 'ACTIVATION_NOT_PENDING',
    });
  });

  it('issues codes that last an hour', () => {
    // Long enough for an admin to read one to a shop; short enough that one
    // found in a drawer next year is worthless.
    expect(ENROLLMENT_TOKEN_TTL_MS).toBe(60 * 60 * 1000);
  });
});
