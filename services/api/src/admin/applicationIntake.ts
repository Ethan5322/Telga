/**
 * What a shop must produce before it can be considered.
 *
 * `applications.ts` governs how an application *moves*; this module governs
 * whether one may be **recorded at all**. They are separate because the
 * lifecycle is a property of the workflow and the requirements are a property of
 * Ethiopian trading law, and the two change for entirely different reasons.
 *
 * ## Where a submission comes from, and why it is not self-service
 *
 * A Telga operator records it, from documents a shop brought in. There is **no
 * public registration route**, in the Android app, the POS, the console or the
 * API: [[Decision Log]] D113(b) defers self-service registration, and nothing
 * here re-opens it. That is also how merchant onboarding actually works in
 * Ethiopia — a shop arrives with a folder — so the constraint costs nothing.
 *
 * What survives from D104 unchanged is the part that matters: recording a
 * submission creates **no account, no credentials, no device and no database**.
 * It creates a row in `merchant_applications`, and approving one is what creates
 * a shop.
 *
 * ## The document list is a proposal, not a compliance statement
 *
 * CLAUDE.md §8: *"Never claim legal compliance without documented qualified
 * review."* The register below is drawn from publicly described Ethiopian
 * business-registration practice and general know-your-business norms, and it is
 * recorded in `02 Product/Multi-Tenant Architecture Proposal` §5 as something
 * **an Ethiopian lawyer must review before a single shop is onboarded**. It is
 * encoded here so that the requirement is enforced consistently, not because it
 * is known to be sufficient.
 */

import { randomInt } from 'node:crypto';

/** The document register. Kept in step with migration 015's `CHECK`. */
export type DocumentKind =
  // --- Tier A: required to trade in Ethiopia at all -------------------------
  /** The operating authority. Renewed annually, so it carries an expiry. */
  | 'TRADE_LICENCE'
  /** Mandatory before a trade licence is issued. */
  | 'COMMERCIAL_REGISTRATION'
  /** Issued by the revenue authority; mandatory before any commercial activity. */
  | 'TIN_CERTIFICATE'
  /** The natural person accountable: national ID, passport or driving licence. */
  | 'OWNER_PHOTO_ID'
  /** Lease or utility bill. Ties the shop to a place, which disputes depend on. */
  | 'PROOF_OF_ADDRESS'
  // --- Tier B: what Telga needs in order to be paid and to pay --------------
  /** In the business's name. §20 forbids a personal account for merchant funds. */
  | 'BANK_ACCOUNT_PROOF'
  // --- Tier C: companies rather than sole traders ---------------------------
  | 'MEMORANDUM_OF_ASSOCIATION'
  | 'SIGNING_AUTHORITY';

/** Sole trader or company. Decides whether Tier C applies. */
export type EntityType = 'SOLE_TRADER' | 'COMPANY';

/**
 * What every shop must produce.
 *
 * **The founder's three**, from the "Register Telga User" form specified on
 * 2026-09-08: a business licence, a TIN, and the owner's photo ID. Narrowed
 * from the six this module first carried — commercial registration, proof of
 * address and bank-account proof are no longer *required*, because the form the
 * founder specified does not ask for them and a hidden requirement would refuse
 * registrations they expect to succeed.
 *
 * The three that dropped out stay in {@link OPTIONAL_DOCUMENTS} and in migration
 * 015's `CHECK` constraint. An unused enum value costs nothing; widening a
 * `CHECK` later costs a migration.
 */
export const REQUIRED_DOCUMENTS: readonly DocumentKind[] = Object.freeze([
  'TRADE_LICENCE',
  'TIN_CERTIFICATE',
  'OWNER_PHOTO_ID',
]);

/**
 * Accepted, recorded, and never demanded.
 *
 * An operator may attach any of these when a shop happens to bring them — a
 * company's constitution, a bank letter — and they are validated like any other
 * document. None blocks a registration.
 */
export const OPTIONAL_DOCUMENTS: readonly DocumentKind[] = Object.freeze([
  'COMMERCIAL_REGISTRATION',
  'PROOF_OF_ADDRESS',
  'BANK_ACCOUNT_PROOF',
  'MEMORANDUM_OF_ASSOCIATION',
  'SIGNING_AUTHORITY',
]);

/**
 * The required set.
 *
 * Takes an entity type so the signature survives a later decision to demand
 * more of a company — which the founder's form does not, today. It returns the
 * same three either way, deliberately and visibly, rather than pretending to
 * branch.
 */
export const requiredDocumentsFor = (_entity: EntityType): readonly DocumentKind[] =>
  REQUIRED_DOCUMENTS;

export interface SubmittedDocument {
  readonly kind: DocumentKind;
  /** The licence or certificate number. **Never an image** — migration 015. */
  readonly reference: string;
  /** ISO date. Required for a trade licence, which lapses. */
  readonly expiresAt?: string;
}

export interface ApplicationSubmission {
  readonly legalName: string;
  readonly tradingName?: string;
  readonly ownerName: string;
  readonly phone: string;
  readonly email?: string;
  readonly address: string;
  readonly locality: string;
  readonly entityType: EntityType;
  readonly documents: readonly SubmittedDocument[];
}

export type SubmissionRejection =
  | 'LEGAL_NAME_REQUIRED'
  | 'OWNER_NAME_REQUIRED'
  | 'PHONE_REQUIRED'
  | 'PHONE_NOT_PLAUSIBLE'
  | 'EMAIL_NOT_PLAUSIBLE'
  | 'ADDRESS_REQUIRED'
  | 'LOCALITY_REQUIRED'
  | 'DOCUMENT_MISSING'
  | 'DOCUMENT_REFERENCE_REQUIRED'
  | 'DOCUMENT_DUPLICATED'
  | 'LICENCE_EXPIRY_REQUIRED'
  | 'LICENCE_ALREADY_EXPIRED';

const blank = (value: string | undefined): boolean => (value ?? '').trim().length === 0;

/**
 * Is this a phone number somebody could be called back on?
 *
 * Deliberately loose. Ethiopian mobile numbers are `09xxxxxxxx` or `+2519xxxxxxxx`
 * and landlines differ by region, and a validator that encodes today's ranges
 * will reject a real shop the day a new prefix is issued. So this checks the
 * shape a number cannot be useful without — digits, an optional leading `+`,
 * and a plausible length — and leaves the rest to the operator who will phone it.
 *
 * **Rejecting a real merchant is a worse failure than accepting a typo**, which
 * a callback catches within a day.
 */
const plausiblePhone = (value: string): boolean => {
  const digits = value.replace(/[\s\-()]/g, '');
  return /^\+?\d{9,15}$/.test(digits);
};

/** Not RFC 5322. Enough to catch a missing `@` or a trailing comma. */
const plausibleEmail = (value: string): boolean => /^[^\s@,]+@[^\s@,]+\.[^\s@,]{2,}$/.test(value);

/**
 * Why a submission cannot be recorded, or `undefined` when it can.
 *
 * Returns the **first** problem rather than a list: an operator is typing this
 * from a folder in front of them, and a form that reports one fixable thing at a
 * time is easier to work through than one that reports nine.
 */
export function submissionRejection(
  submission: ApplicationSubmission,
  now: string,
): SubmissionRejection | undefined {
  if (blank(submission.legalName)) return 'LEGAL_NAME_REQUIRED';
  if (blank(submission.ownerName)) return 'OWNER_NAME_REQUIRED';
  if (blank(submission.phone)) return 'PHONE_REQUIRED';
  if (!plausiblePhone(submission.phone)) return 'PHONE_NOT_PLAUSIBLE';
  // Email is optional — many shops have none — but a supplied one that cannot
  // receive mail is worse than none at all, because it will be relied upon.
  if (!blank(submission.email) && !plausibleEmail((submission.email ?? '').trim())) {
    return 'EMAIL_NOT_PLAUSIBLE';
  }
  if (blank(submission.address)) return 'ADDRESS_REQUIRED';
  if (blank(submission.locality)) return 'LOCALITY_REQUIRED';

  const seen = new Set<DocumentKind>();
  for (const document of submission.documents) {
    if (blank(document.reference)) return 'DOCUMENT_REFERENCE_REQUIRED';
    // Two trade licences on one application means one of them belongs to
    // somebody else, or the operator pasted twice. Either needs a person.
    if (seen.has(document.kind)) return 'DOCUMENT_DUPLICATED';
    seen.add(document.kind);

    if (document.kind === 'TRADE_LICENCE') {
      if (blank(document.expiresAt)) return 'LICENCE_EXPIRY_REQUIRED';
      // An expired licence is not a paperwork problem to be fixed after
      // approval: the shop is not currently licensed to trade.
      if ((document.expiresAt as string) <= now) return 'LICENCE_ALREADY_EXPIRED';
    }
  }

  for (const required of requiredDocumentsFor(submission.entityType)) {
    if (!seen.has(required)) return 'DOCUMENT_MISSING';
  }
  return undefined;
}

/** Which required documents are absent. For a form that shows the operator. */
export function missingDocuments(
  submission: ApplicationSubmission,
): readonly DocumentKind[] {
  const supplied = new Set(submission.documents.map((d) => d.kind));
  return requiredDocumentsFor(submission.entityType).filter((kind) => !supplied.has(kind));
}

/**
 * The reference the shop is given.
 *
 * Unguessable rather than sequential, for the reason `applications.ts` gives:
 * a sequential number lets anybody enumerate every application and learn how
 * many shops Telga has and when each applied. `randomInt`, not `Math.random`.
 */
export function newSubmissionReference(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i += 1) out += alphabet[randomInt(alphabet.length)];
  return `TLG-${out.slice(0, 4)}-${out.slice(4)}`;
}
