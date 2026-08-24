/**
 * Ledger accounts, entries and derived balances.
 *
 * There is no update and no delete in this file, and there is no way to add one
 * that would work: the database triggers from migration 002 abort both.
 *
 * Balances are computed by summing postings per account type. Nothing stores a
 * balance, so nothing can drift.
 */

import { assertBalanced, assertSimulated, money, zero } from '@telga/domain';
import type {
  BalanceView,
  LedgerAccountKind,
  MerchantId,
  Timestamp,
  TransactionId,
} from '@telga/domain';
import type { Db } from '../sqlite/connection';
import type { PostingInput } from '../driver/types';
import type { AccountType, LedgerAccountRow, LedgerEntryRow } from '../schema/types';
import { AccountNotFoundError, MerchantScopeViolationError } from '../driver/errors';
import { serializeMetadata } from '../privacy';

export function ensureAccount(
  db: Db,
  input: { id: string; merchantId?: MerchantId; accountType: AccountType; at: Timestamp },
): LedgerAccountRow {
  db.prepare(
    `INSERT INTO ledger_accounts (id, merchant_id, account_type, currency, created_at)
     VALUES (@id, @merchantId, @accountType, 'ETB', @at)
     ON CONFLICT(id) DO NOTHING`,
  ).run({
    id: input.id,
    merchantId: input.merchantId ?? null,
    accountType: input.accountType,
    at: input.at,
  });

  const row = db.prepare('SELECT * FROM ledger_accounts WHERE id = ?').get(input.id) as
    | LedgerAccountRow
    | undefined;
  if (!row) throw new AccountNotFoundError(`Account ${input.id} was not persisted`);
  return row;
}

export function findAccount(
  db: Db,
  merchantId: MerchantId,
  accountType: LedgerAccountKind,
): LedgerAccountRow | undefined {
  return db
    .prepare('SELECT * FROM ledger_accounts WHERE merchant_id = ? AND account_type = ?')
    .get(merchantId, accountType) as LedgerAccountRow | undefined;
}

/**
 * Append a balanced posting.
 *
 * Refuses an unbalanced posting (domain `assertBalanced`), a live-mode posting
 * (`assertSimulated`), and an entry whose account belongs to a different
 * merchant than the entry claims.
 *
 * Entry ids derive from the posting id and index, so a replay of the same
 * posting produces the same ids and collides on the primary key rather than
 * silently double-posting.
 */
export function appendEntries(db: Db, posting: PostingInput): readonly LedgerEntryRow[] {
  assertSimulated(posting.mode);
  assertBalanced(posting.entries);

  const metadata = serializeMetadata(posting.metadata);

  const insert = db.prepare(
    `INSERT INTO ledger_entries (
       id, posting_id, transaction_id, account_id, merchant_id, account_type, direction,
       amount_minor, currency, entry_type, correlation_id, rule_version, provider_reference,
       metadata, mode, created_at)
     VALUES (
       @id, @postingId, @transactionId, @accountId, @merchantId, @accountType, @direction,
       @amountMinor, @currency, @entryType, @correlationId, @ruleVersion, @providerReference,
       @metadata, @mode, @createdAt)`,
  );

  posting.entries.forEach((entry, index) => {
    const account = db.prepare('SELECT * FROM ledger_accounts WHERE id = ?').get(entry.accountId) as
      | LedgerAccountRow
      | undefined;
    if (!account) {
      throw new AccountNotFoundError(`Unknown ledger account ${entry.accountId}`);
    }
    if (
      account.merchant_id !== null &&
      entry.merchantId !== undefined &&
      account.merchant_id !== entry.merchantId
    ) {
      throw new MerchantScopeViolationError(
        `Entry claims merchant ${entry.merchantId} but account ${entry.accountId} belongs to ${account.merchant_id}`,
      );
    }

    insert.run({
      id: `${posting.postingId}_${String(index)}`,
      postingId: posting.postingId,
      transactionId: entry.transactionId ?? null,
      accountId: entry.accountId,
      merchantId: entry.merchantId ?? account.merchant_id,
      accountType: entry.accountKind,
      direction: entry.direction,
      amountMinor: entry.amount.minor,
      currency: entry.amount.currency,
      entryType: entry.reason,
      correlationId: posting.correlationId,
      ruleVersion: entry.ruleVersion ?? null,
      providerReference: entry.providerReference ?? null,
      metadata,
      mode: posting.mode,
      createdAt: posting.at,
    });
  });

  return db
    .prepare('SELECT * FROM ledger_entries WHERE posting_id = ? ORDER BY id')
    .all(posting.postingId) as LedgerEntryRow[];
}

export function readEntries(db: Db, limit?: number): readonly LedgerEntryRow[] {
  if (limit === undefined) {
    return db.prepare('SELECT * FROM ledger_entries ORDER BY created_at, id').all() as LedgerEntryRow[];
  }
  return db
    .prepare('SELECT * FROM ledger_entries ORDER BY created_at, id LIMIT ?')
    .all(limit) as LedgerEntryRow[];
}

export function readEntriesByMerchant(db: Db, merchantId: MerchantId): readonly LedgerEntryRow[] {
  return db
    .prepare('SELECT * FROM ledger_entries WHERE merchant_id = ? ORDER BY created_at, id')
    .all(merchantId) as LedgerEntryRow[];
}

export function readEntriesByAccount(db: Db, accountId: string): readonly LedgerEntryRow[] {
  return db
    .prepare('SELECT * FROM ledger_entries WHERE account_id = ? ORDER BY created_at, id')
    .all(accountId) as LedgerEntryRow[];
}

export function readEntriesByTransaction(
  db: Db,
  transactionId: TransactionId,
  merchantId?: MerchantId,
): readonly LedgerEntryRow[] {
  if (merchantId === undefined) {
    return db
      .prepare('SELECT * FROM ledger_entries WHERE transaction_id = ? ORDER BY created_at, id')
      .all(transactionId) as LedgerEntryRow[];
  }
  return db
    .prepare(
      'SELECT * FROM ledger_entries WHERE transaction_id = ? AND merchant_id = ? ORDER BY created_at, id',
    )
    .all(transactionId, merchantId) as LedgerEntryRow[];
}

/** Signed net of one account type for one merchant. CREDIT positive, DEBIT negative. */
function netMinor(db: Db, merchantId: MerchantId, accountTypes: readonly AccountType[]): number {
  const placeholders = accountTypes.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount_minor ELSE -amount_minor END), 0) AS net
       FROM ledger_entries
       WHERE merchant_id = ? AND account_type IN (${placeholders})`,
    )
    .get(merchantId, ...accountTypes) as { net: number };
  return row.net;
}

/**
 * The four merchant-facing views, computed from postings alone.
 *
 * `BANK_CLEARING` is not in any of these lists, so it cannot appear in a
 * merchant balance however the query is composed.
 */
export function balanceFor(db: Db, merchantId: MerchantId): BalanceView {
  const available = netMinor(db, merchantId, ['MERCHANT_AVAILABLE', 'MERCHANT_FUNDS']);
  const reserved = netMinor(db, merchantId, ['MERCHANT_RESERVED']);
  const underReview = netMinor(db, merchantId, ['MERCHANT_UNDER_REVIEW']);

  return Object.freeze({
    available: money(available),
    reserved: money(reserved),
    underReview: money(underReview),
    total: money(available + reserved + underReview),
  });
}

/** Whole-ledger residual. Zero when double entry holds across every account. */
export function ledgerResidualMinor(db: Db): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount_minor ELSE -amount_minor END), 0) AS net
       FROM ledger_entries`,
    )
    .get() as { net: number };
  return row.net;
}

export const emptyView = (): BalanceView =>
  Object.freeze({ available: zero(), reserved: zero(), underReview: zero(), total: zero() });
