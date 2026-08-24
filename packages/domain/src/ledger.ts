/**
 * Append-only ledger.
 *
 * Enforces the invariants in `03 Domain/Ledger Invariants.md`:
 *   1. History is append-only — this class exposes no update and no delete.
 *   2. Every posting balances: signed entries sum to zero.
 *   7. Every entry carries merchant, transaction, provider reference and rule
 *      version, so a historical figure stays re-derivable.
 *   8. A correction is an authorized adjustment entry, never an edit.
 *
 * Account segregation is structural: merchant funds, Telga revenue, provider
 * settlement, hardware deposits and refund reserves are distinct account kinds
 * and value never moves between them except through a balanced posting.
 */

import { LedgerImmutableError, LedgerNotBalancedError } from './errors';
import type {
  LedgerAccountId,
  LedgerEntryId,
  MerchantId,
  PostingId,
  Timestamp,
  TransactionId,
} from './ids';
import { ledgerEntryId } from './ids';
import type { OperatingMode } from './mode';
import { assertSimulated } from './mode';
import type { Money } from './money';
import { money, zero } from './money';

/**
 * The five segregated buckets from `03 Domain/Ledger Invariants.md`, plus
 * `BANK_CLEARING`.
 *
 * BANK_CLEARING is a bookkeeping contra account, not a sixth pot of value: a
 * funding credit to merchant funds needs a balanced counter-entry, and without
 * it a deposit could not be posted without breaking invariant 2. It holds no
 * merchant value and appears in no merchant-facing balance. Recorded as a
 * clarification in `07 Governance/Decision Log.md` (D8).
 */
export const LEDGER_ACCOUNT_KINDS = [
  'MERCHANT_FUNDS',
  'MERCHANT_AVAILABLE',
  'MERCHANT_RESERVED',
  'MERCHANT_UNDER_REVIEW',
  'TELGA_REVENUE',
  'PROVIDER_SETTLEMENT',
  'HARDWARE_DEPOSITS',
  'REFUND_RESERVES',
  'BANK_CLEARING',
] as const;

export type LedgerAccountKind = (typeof LEDGER_ACCOUNT_KINDS)[number];

/**
 * Merchant-owned account kinds.
 *
 * `MERCHANT_FUNDS` is the undivided form used by the in-memory domain model.
 * The persistence layer decomposes it into three buckets — available, reserved
 * and under review — so that every movement between buckets is an auditable
 * posting rather than a derived figure. Both forms sum into the same merchant
 * total, which is what lets the two balance calculations be reconciled
 * ([[Decision Log]] D12).
 */
export const MERCHANT_ACCOUNT_KINDS = [
  'MERCHANT_FUNDS',
  'MERCHANT_AVAILABLE',
  'MERCHANT_RESERVED',
  'MERCHANT_UNDER_REVIEW',
] as const;

export type MerchantAccountKind = (typeof MERCHANT_ACCOUNT_KINDS)[number];

export function isMerchantAccountKind(kind: LedgerAccountKind): kind is MerchantAccountKind {
  return (MERCHANT_ACCOUNT_KINDS as readonly string[]).includes(kind);
}

/**
 * Account kinds that must never appear in a merchant-facing balance.
 * `BANK_CLEARING` is bookkeeping only — it holds no merchant value.
 */
export const NON_MERCHANT_FACING_KINDS = ['BANK_CLEARING'] as const;

export interface LedgerAccount {
  readonly id: LedgerAccountId;
  readonly kind: LedgerAccountKind;
  /** Set for merchant-scoped accounts; absent for platform accounts. */
  readonly merchantId?: MerchantId;
}

export type EntryDirection = 'DEBIT' | 'CREDIT';

/**
 * Why an entry exists. `ADJUSTMENT` is the only way a previous figure is
 * corrected — invariant 8.
 */
export type EntryReason =
  | 'FUNDING_CREDIT'
  | 'SALE_DEBIT'
  | 'COMMISSION_CREDIT'
  | 'FEE_DEBIT'
  | 'REVERSAL'
  | 'ADJUSTMENT';

/** An entry before it is posted. The ledger assigns the id and timestamp. */
export interface DraftEntry {
  readonly accountId: LedgerAccountId;
  readonly accountKind: LedgerAccountKind;
  readonly merchantId?: MerchantId;
  readonly transactionId?: TransactionId;
  readonly direction: EntryDirection;
  readonly amount: Money;
  readonly reason: EntryReason;
  /** Version of the CommissionRule / FeeRule that produced this figure. */
  readonly ruleVersion?: string;
  readonly providerReference?: string;
  readonly memo?: string;
}

export interface LedgerEntry extends DraftEntry {
  readonly id: LedgerEntryId;
  readonly postingId: PostingId;
  readonly postedAt: Timestamp;
  readonly mode: OperatingMode;
}

/** CREDIT is positive, DEBIT is negative. A balanced posting sums to zero. */
export function signedMinor(entry: Pick<DraftEntry, 'direction' | 'amount'>): number {
  return entry.direction === 'CREDIT' ? entry.amount.minor : -entry.amount.minor;
}

export function residualMinor(entries: readonly Pick<DraftEntry, 'direction' | 'amount'>[]): number {
  return entries.reduce((acc, entry) => acc + signedMinor(entry), 0);
}

/** Invariant 2: throw unless the posting balances. */
export function assertBalanced(entries: readonly Pick<DraftEntry, 'direction' | 'amount'>[]): void {
  const residual = residualMinor(entries);
  if (residual !== 0) {
    throw new LedgerNotBalancedError(residual);
  }
}

/**
 * The ledger.
 *
 * Note what is missing: there is no `update`, no `delete`, no `void`, and no
 * setter. Correcting a figure means posting an `ADJUSTMENT`, which leaves the
 * original entry intact and visible.
 */
export class AppendOnlyLedger {
  private readonly posted: LedgerEntry[] = [];

  /**
   * Post a balanced set of entries.
   *
   * Entry ids are derived from the posting id and index, so a replay of the
   * same posting produces the same ids — no randomness enters the ledger.
   */
  post(
    postingId: PostingId,
    entries: readonly DraftEntry[],
    at: Timestamp,
    mode: OperatingMode,
  ): readonly LedgerEntry[] {
    assertSimulated(mode);

    if (entries.length === 0) {
      throw new LedgerNotBalancedError(0);
    }
    assertBalanced(entries);

    if (this.posted.some((entry) => entry.postingId === postingId)) {
      throw new LedgerImmutableError(`Posting ${postingId} has already been written and cannot be re-posted`);
    }

    const written = entries.map((draft, index) =>
      Object.freeze({
        ...draft,
        id: ledgerEntryId(`${postingId}_${String(index)}`),
        postingId,
        postedAt: at,
        mode,
      } as LedgerEntry),
    );

    this.posted.push(...written);
    return Object.freeze(written);
  }

  /** All entries, oldest first. The returned array is a frozen copy. */
  entries(): readonly LedgerEntry[] {
    return Object.freeze([...this.posted]);
  }

  /** Entries belonging to one merchant. Merchant isolation at the read path. */
  forMerchant(merchant: MerchantId): readonly LedgerEntry[] {
    return Object.freeze(this.posted.filter((entry) => entry.merchantId === merchant));
  }

  forTransaction(txId: TransactionId): readonly LedgerEntry[] {
    return Object.freeze(this.posted.filter((entry) => entry.transactionId === txId));
  }

  forAccountKind(kind: LedgerAccountKind, merchant?: MerchantId): readonly LedgerEntry[] {
    return Object.freeze(
      this.posted.filter(
        (entry) => entry.accountKind === kind && (merchant === undefined || entry.merchantId === merchant),
      ),
    );
  }

  /** Net position of one account kind, optionally scoped to a merchant. */
  netOf(kind: LedgerAccountKind, merchant?: MerchantId): Money {
    const total = this.forAccountKind(kind, merchant).reduce((acc, entry) => acc + signedMinor(entry), 0);
    return money(total);
  }

  /** Whole-ledger residual. Invariant 2 holds globally when this is zero. */
  residual(): Money {
    return this.posted.length === 0 ? zero() : money(residualMinor(this.posted));
  }

  get size(): number {
    return this.posted.length;
  }
}
