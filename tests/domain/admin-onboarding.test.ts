/**
 * Registration, enrollment tokens, and the tenant registry.
 *
 * Three things the owner brief is specific about, and the tests are mostly
 * about the refusals:
 *
 *   - an application cannot jump states, and a rejection needs a reason;
 *   - a token is single-use, expiring, unguessable, and dies on redemption;
 *   - a tenant's database name is derived and never supplied, so no caller can
 *     point two shops at one file or walk out of the tenant directory.
 */

import { describe, expect, it } from 'vitest';
import {
  ENROLLMENT_NOTICE,
  ENROLLMENT_TOKEN_TTL_MS,
  UnsafeTenantNameError,
  applicationRejection,
  assertTransition,
  backupsOverdue,
  canTransition,
  databaseNameFor,
  enrollmentExpiryFrom,
  enrollmentRefusal,
  isServable,
  isTerminalApplication,
  newApplicationReference,
  newEnrollmentToken,
  normalizeEnrollmentToken,
  reviewRefusal,
  statusAfterReview,
  summariseResiduals,
  tenantFileName,
  tenantsBehind,
} from '@telga/api';
import type { ApplicationInput, ApplicationStatus, TenantRecord } from '@telga/api';

const VALID: ApplicationInput = {
  legalName: 'Hebron Supermarket PLC',
  tradingName: 'Hebron',
  ownerName: 'Abebe Bekele',
  phone: '+251 911 000 000',
  email: 'shop@example.invalid',
  address: 'Bole Road 42',
  locality: 'Addis Ababa',
};

describe('the application lifecycle', () => {
  it('walks the happy path one step at a time', () => {
    const path: ApplicationStatus[] = [
      'DRAFT',
      'SUBMITTED',
      'UNDER_REVIEW',
      'APPROVED',
      'PROVISIONING',
      'DEVICE_PENDING',
      'READY_FOR_TRAINING',
      'ACTIVE_TRAINING',
      'LIVE_ELIGIBLE',
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i], path[i + 1])).toBe(
        true,
      );
    }
  });

  it('refuses a jump straight from submitted to trading', () => {
    // The illegal moves are the point. A shop cannot skip review.
    expect(canTransition('SUBMITTED', 'ACTIVE_TRAINING')).toBe(false);
    expect(canTransition('SUBMITTED', 'APPROVED')).toBe(false);
    expect(canTransition('DRAFT', 'LIVE_ELIGIBLE')).toBe(false);
    expect(() => assertTransition('SUBMITTED', 'ACTIVE_TRAINING')).toThrow(
      /not a legal move/,
    );
  });

  it('lets a review return an application for correction', () => {
    expect(canTransition('UNDER_REVIEW', 'DRAFT')).toBe(true);
  });

  it('makes CLOSED terminal — records are retained, never revived by accident', () => {
    expect(isTerminalApplication('CLOSED')).toBe(true);
    for (const to of [
      'DRAFT',
      'SUBMITTED',
      'APPROVED',
      'ACTIVE_TRAINING',
    ] as ApplicationStatus[]) {
      expect(canTransition('CLOSED', to), to).toBe(false);
    }
  });

  it('does not let LIVE_ELIGIBLE become anything but suspended', () => {
    // Eligibility is not permission: `money.live` still needs its ten gates and
    // two approvers, and no lifecycle state may enable a regulated feature.
    expect(canTransition('LIVE_ELIGIBLE', 'SUSPENDED')).toBe(true);
    expect(canTransition('LIVE_ELIGIBLE', 'ACTIVE_TRAINING')).toBe(false);
  });

  it('allows a suspended shop back, and closed out', () => {
    expect(canTransition('SUSPENDED', 'ACTIVE_TRAINING')).toBe(true);
    expect(canTransition('SUSPENDED', 'CLOSED')).toBe(true);
  });
});

describe('what a submission must contain', () => {
  it('accepts a complete one', () => {
    expect(applicationRejection(VALID)).toBeUndefined();
  });

  it('names the missing field rather than refusing vaguely', () => {
    expect(applicationRejection({ ...VALID, legalName: '  ' })).toBe('LEGAL_NAME_REQUIRED');
    expect(applicationRejection({ ...VALID, ownerName: '' })).toBe('OWNER_NAME_REQUIRED');
    expect(applicationRejection({ ...VALID, phone: '' })).toBe('PHONE_REQUIRED');
    expect(applicationRejection({ ...VALID, address: '' })).toBe('ADDRESS_REQUIRED');
    expect(applicationRejection({ ...VALID, locality: '' })).toBe('LOCALITY_REQUIRED');
  });

  it('checks the shape of a phone number without claiming it is real', () => {
    // Telga verifies none of this. It is what an applicant typed, and
    // collecting it proves nothing about who they are — CLAUDE.md §30.
    expect(applicationRejection({ ...VALID, phone: 'not-a-number' })).toBe('PHONE_INVALID');
    expect(applicationRejection({ ...VALID, phone: '0911000000' })).toBeUndefined();
  });

  it('treats an absent email as fine and a malformed one as not', () => {
    expect(applicationRejection({ ...VALID, email: undefined })).toBeUndefined();
    expect(applicationRejection({ ...VALID, email: '' })).toBeUndefined();
    expect(applicationRejection({ ...VALID, email: 'not-an-email' })).toBe('EMAIL_INVALID');
  });
});

describe('the reference an applicant gets back', () => {
  it('is not sequential', () => {
    // Sequential would leak the shop count and let anyone walk the list.
    const refs = Array.from({ length: 200 }, () => newApplicationReference());
    expect(new Set(refs).size).toBeGreaterThan(150);
    for (const ref of refs) expect(ref).toMatch(/^TG-\d{6}$/);
  });
});

describe('reviewing', () => {
  const decision = { outcome: 'REJECT' as const, reason: 'No trading licence', reviewedBy: 'adm_1' };

  it('requires a reason to reject', () => {
    // A review that records no reason is not a review.
    expect(reviewRefusal('UNDER_REVIEW', { ...decision, reason: '   ' })).toBe('REASON_REQUIRED');
    expect(reviewRefusal('UNDER_REVIEW', decision)).toBeUndefined();
  });

  it('requires a reason to return for correction', () => {
    expect(
      reviewRefusal('UNDER_REVIEW', {
        outcome: 'RETURN_FOR_CORRECTION',
        reason: '',
        reviewedBy: 'adm_1',
      }),
    ).toBe('REASON_REQUIRED');
  });

  it('does not require one to approve — the approval is the reason', () => {
    expect(
      reviewRefusal('UNDER_REVIEW', { outcome: 'APPROVE', reason: '', reviewedBy: 'adm_1' }),
    ).toBeUndefined();
  });

  it('refuses to decide on an application nobody picked up', () => {
    expect(reviewRefusal('SUBMITTED', decision)).toBe('NOT_UNDER_REVIEW');
    expect(reviewRefusal('APPROVED', decision)).toBe('NOT_UNDER_REVIEW');
  });

  it('lands each outcome in the right state', () => {
    expect(statusAfterReview({ outcome: 'APPROVE', reason: '', reviewedBy: 'a' })).toBe('APPROVED');
    expect(statusAfterReview({ outcome: 'REJECT', reason: 'x', reviewedBy: 'a' })).toBe('CLOSED');
    expect(
      statusAfterReview({ outcome: 'RETURN_FOR_CORRECTION', reason: 'x', reviewedBy: 'a' }),
    ).toBe('DRAFT');
  });
});

describe('enrollment tokens', () => {
  it('avoids the characters people mishear down a phone', () => {
    // I/O/0/1 are the pairs that get mistyped when a token is read aloud.
    for (let i = 0; i < 50; i += 1) {
      const token = normalizeEnrollmentToken(newEnrollmentToken());
      expect(token).toMatch(/^[A-HJ-NP-Z2-9]{20}$/);
    }
  });

  it('is not predictable from earlier tokens', () => {
    const tokens = new Set(Array.from({ length: 300 }, () => newEnrollmentToken()));
    expect(tokens.size).toBe(300);
  });

  it('is grouped for reading, and the grouping is cosmetic', () => {
    const token = newEnrollmentToken();
    expect(token).toContain('-');
    // A shop that types it without the dashes, or in lower case, still matches.
    expect(normalizeEnrollmentToken(token.toLowerCase().replace(/-/g, ''))).toBe(
      normalizeEnrollmentToken(token),
    );
    expect(normalizeEnrollmentToken(' a b-c ')).toBe('ABC');
  });

  it('expires an hour after it is issued', () => {
    const now = '2026-08-30T10:00:00.000Z';
    expect(Date.parse(enrollmentExpiryFrom(now)) - Date.parse(now)).toBe(ENROLLMENT_TOKEN_TTL_MS);
  });

  it('refuses an unknown, revoked, spent or expired token', () => {
    const now = '2026-08-30T10:00:00.000Z';
    const live = { expiresAt: '2026-08-30T10:30:00.000Z', usedAt: null, revokedAt: null };

    expect(enrollmentRefusal(undefined, now)).toBe('TOKEN_UNKNOWN');
    expect(enrollmentRefusal(live, now)).toBeUndefined();
    expect(enrollmentRefusal({ ...live, revokedAt: now }, now)).toBe('TOKEN_REVOKED');
    expect(enrollmentRefusal({ ...live, usedAt: now }, now)).toBe('TOKEN_ALREADY_USED');
    expect(enrollmentRefusal({ ...live, expiresAt: '2026-08-30T09:00:00.000Z' }, now)).toBe(
      'TOKEN_EXPIRED',
    );
  });

  it('reports a spent token as spent even after it has also expired', () => {
    // A replayed token should say so plainly rather than leave an operator
    // wondering whether they were merely late.
    const now = '2026-08-30T12:00:00.000Z';
    const spentAndStale = {
      expiresAt: '2026-08-30T10:00:00.000Z',
      usedAt: '2026-08-30T09:30:00.000Z',
      revokedAt: null,
    };
    expect(enrollmentRefusal(spentAndStale, now)).toBe('TOKEN_ALREADY_USED');
  });

  it('warns the admin that it cannot be shown again', () => {
    expect(ENROLLMENT_NOTICE).toContain('Shown once');
    expect(ENROLLMENT_NOTICE.toLowerCase()).toContain('hash');
  });
});

describe('the tenant registry', () => {
  it('derives a database name and refuses an unsafe merchant id', () => {
    // A caller that could choose the filename could choose `../../etc/passwd`
    // or point two merchants at one file.
    expect(databaseNameFor('merchant_alpha')).toBe('merchant_alpha.sqlite');
    for (const bad of ['../escape', 'a/b', 'a\\b', 'a b', '', 'a.b']) {
      expect(() => databaseNameFor(bad), bad).toThrow(UnsafeTenantNameError);
    }
  });

  it('re-checks the name at open time, not just at write time', () => {
    // The row was written by this service, but a table can be edited.
    expect(tenantFileName({ databaseName: 'merchant_a.sqlite' })).toBe('merchant_a.sqlite');
    expect(() => tenantFileName({ databaseName: '../../etc/passwd' })).toThrow(
      UnsafeTenantNameError,
    );
  });

  it('serves only an active tenant', () => {
    expect(isServable('ACTIVE')).toBe(true);
    for (const status of ['PROVISIONING', 'SUSPENDED', 'CLOSED', 'MIGRATING', 'FAILED'] as const) {
      expect(isServable(status), status).toBe(false);
    }
  });

  it('finds the tenants a deploy left behind', () => {
    // Under one database "migrated" is a single fact. Under N, a run can fail
    // on shop 400 of 1,000, and that has to be detectable.
    const tenants: TenantRecord[] = [
      { merchantId: 'a', databaseName: 'a.sqlite', schemaVersion: '014', status: 'ACTIVE', lastBackupAt: null, lastRestoreAt: null },
      { merchantId: 'b', databaseName: 'b.sqlite', schemaVersion: '013', status: 'ACTIVE', lastBackupAt: null, lastRestoreAt: null },
    ];
    expect(tenantsBehind(tenants, '014').map((t) => t.merchantId)).toEqual(['b']);
  });

  it('treats a shop that was never backed up as the most overdue', () => {
    // A missing backup handled as "not yet due" is how it stays missing.
    const now = '2026-08-30T12:00:00.000Z';
    const tenants: TenantRecord[] = [
      { merchantId: 'never', databaseName: 'n.sqlite', schemaVersion: '014', status: 'ACTIVE', lastBackupAt: null, lastRestoreAt: null },
      { merchantId: 'old', databaseName: 'o.sqlite', schemaVersion: '014', status: 'ACTIVE', lastBackupAt: '2026-08-01T12:00:00.000Z', lastRestoreAt: null },
      { merchantId: 'fresh', databaseName: 'f.sqlite', schemaVersion: '014', status: 'ACTIVE', lastBackupAt: '2026-08-30T11:00:00.000Z', lastRestoreAt: null },
      { merchantId: 'closed', databaseName: 'c.sqlite', schemaVersion: '014', status: 'CLOSED', lastBackupAt: null, lastRestoreAt: null },
    ];
    const overdue = backupsOverdue(tenants, now, 24 * 60 * 60 * 1000).map((t) => t.merchantId);
    expect(overdue[0]).toBe('never');
    expect(overdue).toContain('old');
    expect(overdue).not.toContain('fresh');
    // A closed shop is not chased for backups.
    expect(overdue).not.toContain('closed');
  });
});

describe('the platform ledger residual', () => {
  it('is sound only when every tenant was readable and every one balanced', () => {
    expect(
      summariseResiduals([
        { merchantId: 'a', residualMinor: 0 },
        { merchantId: 'b', residualMinor: 0 },
      ]).sound,
    ).toBe(true);
  });

  it('is not sound when a tenant could not be opened, even if the total is zero', () => {
    // This is the trap the per-shop model introduces: a zero that is really
    // "we could not look" reads identically to a zero that is proof.
    const summary = summariseResiduals([
      { merchantId: 'a', residualMinor: 0 },
      { merchantId: 'b', residualMinor: null },
    ]);
    expect(summary.residualMinor).toBe(0);
    expect(summary.sound).toBe(false);
    expect(summary.tenantsUnreadable).toEqual(['b']);
    expect(summary.tenantsChecked).toBe(1);
  });

  it('is not sound when a tenant does not balance', () => {
    const summary = summariseResiduals([
      { merchantId: 'a', residualMinor: 0 },
      { merchantId: 'b', residualMinor: 250 },
    ]);
    expect(summary.residualMinor).toBe(250);
    expect(summary.sound).toBe(false);
  });
});
