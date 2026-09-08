import type { Migration } from './index';

/**
 * Registration documents, and forcing a first-login PIN change.
 *
 * Two additions the multi-shop brief needs and the schema had nowhere to put.
 *
 * ## 1. `merchant_application_documents`
 *
 * `merchant_applications` (migration 014) carries who is applying and where they
 * trade, and **nothing about what they produced to prove it**. The founder's
 * brief requires a shop to supply registration documents before approval, and
 * `02 Product/Multi-Tenant Architecture Proposal` §5 lists them.
 *
 * ### Why a table rather than columns
 *
 * A document is not a field. Each one has its own **expiry** — an Ethiopian
 * trade licence is renewed annually — its own verification outcome, and its own
 * reference. Columns would make "which shops have a licence lapsing this month"
 * a scan of nullable dates across a wide row, and adding a document type later
 * would be another migration. A row per document makes both ordinary.
 *
 * ### Where the image itself lives, and why not here
 *
 * The founder decided scanned documents **are** kept, to identify an accountable
 * person when a shop commits fraud — [[Decision Log]] **D125**. A know-your-
 * business file with no identity document is not one.
 *
 * The bytes are **not in this table**. They are encrypted on the volume, and
 * `document_uri` names the file; `media_type` is needed to decrypt it, and
 * `byte_size` spares an operations screen from decrypting a passport to say how
 * large it is. Storing images in the row would put them inside every database
 * backup, including any taken off-platform — the opposite of what **R37** asks.
 *
 * All three columns are nullable, because a reference number recorded without a
 * scan is still a valid document row. That is what M1a wrote before uploads
 * existed, and those rows stay valid.
 *
 * ## 2. `merchant_users.must_change_pin`
 *
 * The brief's step 5: an operator changes the admin-issued PIN on first login.
 * There was no way to express "this PIN is temporary", so a provisioning PIN was
 * indistinguishable from one the operator chose — and a PIN that several Telga
 * staff have seen is not a credential belonging to a shop.
 *
 * `DEFAULT 0` so every existing operator is unaffected: the one training
 * operator already signed in keeps working, and only PINs issued after this
 * migration can be marked temporary.
 *
 * ## What this migration does not touch
 *
 * No existing row is read, moved or rewritten. `merchants`, `devices`,
 * `sessions`, the ledger and the audit trail are untouched. The new table is
 * empty and the new column defaults to the behaviour that exists today, so
 * applying this to the running training deployment changes nothing observable
 * until code is written that uses them.
 *
 * ## Rollback
 *
 * Forward-fix only, as everywhere here. The table is additive and unreferenced,
 * so the practical undo is a `DROP TABLE` in a later migration. The column
 * cannot be dropped without rewriting the table, which is why it defaults to the
 * inert value: leaving it in place costs nothing. The migrator wraps this in one
 * transaction, so a failure leaves the database untouched and unrecorded.
 */
export const m015ApplicationDocumentsAndPinChange: Migration = {
  version: '015',
  name: 'application_documents_and_pin_change',
  sql: `
    -- What an applicant produced, and what an operator made of it. One row per
    -- document, because each carries its own expiry and its own verdict.
    CREATE TABLE merchant_application_documents (
      id             TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES merchant_applications(id),
      -- The register in 02 Product/Multi-Tenant Architecture Proposal §5.
      -- Tier A is required to trade in Ethiopia; Tier B is what Telga needs to
      -- pay and be paid; Tier C applies to companies rather than sole traders.
      kind           TEXT NOT NULL CHECK (kind IN (
                       'TRADE_LICENCE',
                       'COMMERCIAL_REGISTRATION',
                       'TIN_CERTIFICATE',
                       'OWNER_PHOTO_ID',
                       'PROOF_OF_ADDRESS',
                       'BANK_ACCOUNT_PROOF',
                       'MEMORANDUM_OF_ASSOCIATION',
                       'SIGNING_AUTHORITY'
                     )),
      -- The licence or certificate number. NOT an image, and not a credential:
      -- see the note above on why no image is stored.
      reference      TEXT NOT NULL,
      status         TEXT NOT NULL CHECK (status IN (
                       'SUPPLIED', 'VERIFIED', 'REJECTED', 'EXPIRED'
                     )),
      -- A licence that lapses must raise a review rather than pass silently.
      -- Nullable: a national ID and a TIN do not expire the way a licence does.
      expires_at     TEXT,
      -- Who checked it. Null while it is merely SUPPLIED.
      verified_by    TEXT REFERENCES admin_users(id),
      verified_at    TEXT,
      -- A rejection without a reason is not a review. Same rule as the
      -- application's own decision_reason.
      reject_reason  TEXT,
      -- The scanned document, when one was uploaded.
      --
      -- A handle, not a path and not the bytes. The file lives encrypted on the
      -- volume -- see admin/documentVault.ts -- and this column names it.
      -- Storing the image in the row would put passports inside every database
      -- backup, including ones taken off-platform.
      --
      -- Null when only a reference number was recorded, which is what M1a did
      -- before uploads existed.
      document_uri   TEXT,
      -- Needed to decrypt: the media type is bound as additional authenticated
      -- data, so a file recorded here as a PDF and encrypted as a JPEG does not
      -- open. That is deliberate — it means a row edited by anything that
      -- reaches the database cannot silently re-file one document as another.
      media_type     TEXT CHECK (media_type IN ('image/jpeg', 'image/png', 'application/pdf')),
      -- The plaintext size, for an operations screen that should not have to
      -- decrypt a passport to say how big it is.
      byte_size      INTEGER CHECK (byte_size IS NULL OR byte_size > 0),
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    ) STRICT;

    CREATE INDEX idx_application_documents_application
      ON merchant_application_documents(application_id);

    -- Finding what is about to lapse is a scheduled question, not a scan.
    CREATE INDEX idx_application_documents_expiry
      ON merchant_application_documents(status, expires_at);

    -- One shop must not register the same licence twice, and two shops must not
    -- both claim one. The second is the case that matters: a duplicate TIN
    -- across applications is the signal that one person is opening shops under
    -- several names.
    CREATE UNIQUE INDEX idx_application_documents_unique
      ON merchant_application_documents(kind, reference);

    -- An admin-issued PIN is temporary. 0 = the operator chose this PIN.
    -- Defaulted so every operator that exists today is unaffected.
    ALTER TABLE merchant_users
      ADD COLUMN must_change_pin INTEGER NOT NULL DEFAULT 0
      CHECK (must_change_pin IN (0, 1));
  `,
};
