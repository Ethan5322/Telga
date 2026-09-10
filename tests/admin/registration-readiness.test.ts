/**
 * Is this shop's paperwork complete enough to approve?
 *
 * ## Why this exists
 *
 * The review screen rendered **no documents at all**. A reviewer was asked to
 * approve a shop without seeing whether it had supplied a licence, a TIN or an
 * ID — let alone whether any of them were in date. The rows and the encrypted
 * scans existed the whole time; nothing showed them.
 *
 * ## What these tests defend
 *
 *   1. **Four different problems read as four different problems.** "Documents
 *      incomplete" tells a reviewer nothing about what to say on the phone.
 *      Missing, expired, expiring and unscanned are four conversations.
 *   2. **The worst thing about a document wins.** A reviewer needs the blocking
 *      fact, not the first one the loop happened to reach.
 *   3. **The verdict never blocks a route.** A reviewer may approve a NOT_READY
 *      application, and sometimes should. What must not happen is approving one
 *      unknowingly.
 */

import { describe, expect, it } from 'vitest';
import { EXPIRY_WARNING_MS, assessRegistration, labelFor } from '@telga/api';
import type { SuppliedDocument } from '@telga/api';

const NOW = '2026-09-10T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const inDays = (n: number): string => new Date(Date.parse(NOW) + n * DAY).toISOString();

const doc = (over: Partial<SuppliedDocument> & { kind: string }): SuppliedDocument => ({
  id: `doc_${over.kind}`,
  reference: `REF-${over.kind}`,
  expiresAt: null,
  documentUri: 'vault://something',
  ...over,
});

/** The three a sole trader must produce, all in order. */
const complete = (): SuppliedDocument[] => [
  doc({ kind: 'TRADE_LICENCE', expiresAt: inDays(365) }),
  doc({ kind: 'TIN_CERTIFICATE' }),
  doc({ kind: 'OWNER_PHOTO_ID' }),
];

describe('a complete application', () => {
  it('is READY with nothing to say', () => {
    const readiness = assessRegistration(complete(), NOW);
    expect(readiness.verdict).toBe('READY');
    expect(readiness.reasons).toEqual([]);
  });

  it('lists every required document even when all are present', () => {
    // The panel is a checklist. A reviewer confirming three things needs to see
    // three rows, not an empty table meaning "no problems".
    const readiness = assessRegistration(complete(), NOW);
    expect(readiness.documents).toHaveLength(3);
    expect(readiness.documents.every((d) => d.required)).toBe(true);
  });
});

describe('what stops an approval', () => {
  it('blocks on a required document that was never supplied', () => {
    const readiness = assessRegistration(
      complete().filter((d) => d.kind !== 'TIN_CERTIFICATE'),
      NOW,
    );
    expect(readiness.verdict).toBe('NOT_READY');
    expect(readiness.reasons.join(' ')).toContain('TIN certificate has not been supplied');
  });

  it('blocks on an expired licence, and says so differently from a missing one', () => {
    // The shop is not currently licensed to trade. That is a different phone
    // call from "you never sent it", and the words have to differ.
    const readiness = assessRegistration(
      [doc({ kind: 'TRADE_LICENCE', expiresAt: inDays(-1) }), ...complete().slice(1)],
      NOW,
    );
    expect(readiness.verdict).toBe('NOT_READY');
    expect(readiness.reasons.join(' ')).toContain('expired on');
    expect(readiness.reasons.join(' ')).not.toContain('has not been supplied');
  });
});

describe('what is worth mentioning but does not block', () => {
  it('warns about a licence expiring inside the window', () => {
    const readiness = assessRegistration(
      [doc({ kind: 'TRADE_LICENCE', expiresAt: inDays(10) }), ...complete().slice(1)],
      NOW,
    );
    expect(readiness.verdict).toBe('READY_WITH_WARNINGS');
    expect(readiness.reasons.join(' ')).toContain('expires in 10 days');
  });

  it('does not warn about one comfortably outside it', () => {
    const outside = Math.floor(EXPIRY_WARNING_MS / DAY) + 5;
    const readiness = assessRegistration(
      [doc({ kind: 'TRADE_LICENCE', expiresAt: inDays(outside) }), ...complete().slice(1)],
      NOW,
    );
    expect(readiness.verdict).toBe('READY');
  });

  it('warns about a reference with no scan, and does not block on it', () => {
    // A registration recorded by reference alone is exactly what the app's own
    // form produces. Blocking those would refuse every self-service
    // application, which is the opposite of what D138 built.
    const readiness = assessRegistration(
      [doc({ kind: 'TIN_CERTIFICATE', documentUri: null }), ...complete().filter((d) => d.kind !== 'TIN_CERTIFICATE')],
      NOW,
    );
    expect(readiness.verdict).toBe('READY_WITH_WARNINGS');
    expect(readiness.reasons.join(' ')).toContain('no scan attached');
  });
});

describe('the worst thing about a document wins', () => {
  it('reports an expired document as expired, not as unscanned', () => {
    // Both are true of this row. A reviewer needs the blocking fact.
    const readiness = assessRegistration(
      [
        doc({ kind: 'TRADE_LICENCE', expiresAt: inDays(-5), documentUri: null }),
        ...complete().slice(1),
      ],
      NOW,
    );
    const licence = readiness.documents.find((d) => d.kind === 'TRADE_LICENCE');
    expect(licence?.state).toBe('EXPIRED');
    expect(readiness.verdict).toBe('NOT_READY');
  });

  it('puts the blocking documents first, so a reviewer reads them first', () => {
    const readiness = assessRegistration(
      [doc({ kind: 'TIN_CERTIFICATE' }), doc({ kind: 'OWNER_PHOTO_ID' })],
      NOW,
    );
    // The trade licence is missing entirely and must lead.
    expect(readiness.documents[0]?.kind).toBe('TRADE_LICENCE');
    expect(readiness.documents[0]?.state).toBe('MISSING');
  });
});

describe('optional documents', () => {
  it('are listed when supplied and never block', () => {
    const readiness = assessRegistration(
      [...complete(), doc({ kind: 'BANK_ACCOUNT_PROOF' })],
      NOW,
    );
    expect(readiness.verdict).toBe('READY');
    const bank = readiness.documents.find((d) => d.kind === 'BANK_ACCOUNT_PROOF');
    expect(bank?.required).toBe(false);
  });

  it('are not invented when absent', () => {
    // Only the required set plus whatever was actually supplied. Listing every
    // possible document as "missing" would bury the three that matter.
    const readiness = assessRegistration(complete(), NOW);
    expect(readiness.documents.map((d) => d.kind)).not.toContain('BANK_ACCOUNT_PROOF');
  });
});

describe('the labels a reviewer reads', () => {
  it('are words, not schema tokens', () => {
    expect(labelFor('OWNER_PHOTO_ID')).toBe('Owner photo ID');
    expect(labelFor('TRADE_LICENCE')).toBe('Trade licence');
  });

  it('fall back to the token rather than to nothing', () => {
    // An unmapped kind must still render something a person can act on.
    expect(labelFor('SOME_FUTURE_DOCUMENT')).toBe('SOME_FUTURE_DOCUMENT');
  });
});
