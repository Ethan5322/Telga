/**
 * Is this shop's paperwork complete enough to approve?
 *
 * `CLAUDE.md` §17.2 and §18.1. The console could already record documents and
 * encrypt their scans, and the review screen **showed none of them** — a
 * reviewer was asked to approve a shop without being able to see its papers,
 * or even whether any had been supplied.
 *
 * This computes the answer once, so the review screen, the applications queue
 * and any later report all say the same thing. Three copies of "is it ready"
 * is how two of them end up disagreeing in front of a merchant.
 *
 * ## Why readiness is not the same as approval
 *
 * A reviewer may approve a shop this module calls `NOT_READY`, and sometimes
 * should — a licence that expires next week is a real shop with a real problem,
 * not a forgery. What this refuses to do is let that happen **unknowingly**.
 * The verdict is information for a person, never a gate on a route.
 *
 * ## Expiry is judged, not merely reported
 *
 * An expired trade licence means the shop is not currently licensed to trade,
 * which is a different fact from a missing one and needs a different
 * conversation. One expiring within the warning window is a third. All three
 * are distinguished, because "documents incomplete" tells a reviewer nothing
 * about what to say on the phone.
 */

import { REQUIRED_DOCUMENTS } from './applicationIntake';
import type { DocumentKind, EntityType } from './applicationIntake';

/** How close to expiry counts as worth flagging. Thirty days. */
export const EXPIRY_WARNING_MS = 30 * 24 * 60 * 60 * 1000;

export type DocumentState =
  | 'MISSING'
  /** Supplied, and either has no expiry or is comfortably inside it. */
  | 'PRESENT'
  /** Supplied and expiring within the warning window. */
  | 'EXPIRING_SOON'
  /** Supplied and already lapsed. */
  | 'EXPIRED'
  /** Supplied by reference only — no scan was ever attached. */
  | 'NO_SCAN';

export interface SuppliedDocument {
  readonly kind: string;
  readonly reference: string;
  readonly expiresAt: string | null;
  /** The vault handle, when a scan exists. */
  readonly documentUri: string | null;
  readonly id: string;
}

export interface DocumentReadiness {
  readonly kind: string;
  readonly required: boolean;
  readonly state: DocumentState;
  readonly reference: string | null;
  readonly expiresAt: string | null;
  /** Whole days until expiry; negative once lapsed. Absent when there is none. */
  readonly daysToExpiry: number | null;
  /** Present only when a scan can actually be opened. */
  readonly documentId: string | null;
}

export type ReadinessVerdict =
  /** Everything required is present, in date, and scanned. */
  | 'READY'
  /** Nothing is blocking, but something deserves a look. */
  | 'READY_WITH_WARNINGS'
  /** Something required is absent or expired. */
  | 'NOT_READY';

export interface RegistrationReadiness {
  readonly verdict: ReadinessVerdict;
  readonly documents: readonly DocumentReadiness[];
  /** Plain sentences, for a screen. Empty when the verdict is `READY`. */
  readonly reasons: readonly string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Human names, because `OWNER_PHOTO_ID` is not what a reviewer calls it. */
export const DOCUMENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  TRADE_LICENCE: 'Trade licence',
  COMMERCIAL_REGISTRATION: 'Commercial registration',
  TIN_CERTIFICATE: 'TIN certificate',
  OWNER_PHOTO_ID: 'Owner photo ID',
  PROOF_OF_ADDRESS: 'Proof of address',
  BANK_ACCOUNT_PROOF: 'Bank account proof',
  MEMORANDUM_OF_ASSOCIATION: 'Memorandum of association',
  SIGNING_AUTHORITY: 'Signing authority',
});

export const labelFor = (kind: string): string => DOCUMENT_LABELS[kind] ?? kind;

/**
 * Assess one application's paperwork.
 *
 * `entityType` is taken but not yet branched on: `requiredDocumentsFor` returns
 * the same three for a sole trader and a company today, deliberately and
 * visibly. Threading it here means the day that changes, this function already
 * has what it needs.
 */
export function assessRegistration(
  supplied: readonly SuppliedDocument[],
  now: string,
  _entityType: EntityType = 'SOLE_TRADER',
): RegistrationReadiness {
  const nowMs = Date.parse(now);
  const byKind = new Map(supplied.map((d) => [d.kind, d]));
  const kinds = new Set<string>([
    ...(REQUIRED_DOCUMENTS as readonly DocumentKind[]),
    ...supplied.map((d) => d.kind),
  ]);

  const documents: DocumentReadiness[] = [...kinds].map((kind) => {
    const required = (REQUIRED_DOCUMENTS as readonly string[]).includes(kind);
    const found = byKind.get(kind);
    if (found === undefined) {
      return {
        kind,
        required,
        state: 'MISSING',
        reference: null,
        expiresAt: null,
        daysToExpiry: null,
        documentId: null,
      };
    }

    const expiresAt = found.expiresAt;
    const daysToExpiry =
      expiresAt === null ? null : Math.floor((Date.parse(expiresAt) - nowMs) / DAY_MS);

    // Order matters: expired beats expiring, and both beat "no scan". A
    // reviewer needs the worst thing about a document, not the first thing.
    let state: DocumentState = 'PRESENT';
    if (expiresAt !== null && Date.parse(expiresAt) <= nowMs) {
      state = 'EXPIRED';
    } else if (expiresAt !== null && Date.parse(expiresAt) - nowMs <= EXPIRY_WARNING_MS) {
      state = 'EXPIRING_SOON';
    } else if (found.documentUri === null) {
      state = 'NO_SCAN';
    }

    return {
      kind,
      required,
      state,
      reference: found.reference,
      expiresAt,
      daysToExpiry,
      documentId: found.documentUri === null ? null : found.id,
    };
  });

  // Sorted so required documents lead, and within those the problems first —
  // a reviewer reads top-down and should meet the blocking thing first.
  const rank: Readonly<Record<DocumentState, number>> = {
    MISSING: 0,
    EXPIRED: 1,
    EXPIRING_SOON: 2,
    NO_SCAN: 3,
    PRESENT: 4,
  };
  documents.sort(
    (a, b) =>
      Number(b.required) - Number(a.required) ||
      rank[a.state] - rank[b.state] ||
      a.kind.localeCompare(b.kind),
  );

  const reasons: string[] = [];
  let blocking = false;
  let warning = false;

  for (const document of documents) {
    const name = labelFor(document.kind);
    if (document.state === 'MISSING' && document.required) {
      reasons.push(`${name} has not been supplied.`);
      blocking = true;
    } else if (document.state === 'EXPIRED') {
      // Distinguished from missing on purpose: the shop is not currently
      // licensed to trade, which is a different phone call.
      reasons.push(`${name} expired on ${String(document.expiresAt).slice(0, 10)}.`);
      if (document.required) blocking = true;
      else warning = true;
    } else if (document.state === 'EXPIRING_SOON') {
      reasons.push(`${name} expires in ${String(document.daysToExpiry)} days.`);
      warning = true;
    } else if (document.state === 'NO_SCAN') {
      // Not blocking. A registration recorded by reference alone is what the
      // app's own form produces, and refusing those would refuse every
      // self-service application.
      reasons.push(`${name} has a reference but no scan attached.`);
      warning = true;
    }
  }

  return {
    verdict: blocking ? 'NOT_READY' : warning ? 'READY_WITH_WARNINGS' : 'READY',
    documents,
    reasons,
  };
}
