/**
 * The `LedgerDriver` contract.
 *
 * Everything above this line talks to the interface; only `sqlite/` knows what
 * a SQLite handle is.
 *
 * ## What swapping to Postgres would actually cost
 *
 * This comment used to claim it meant writing a second implementation of this
 * file "and changing nothing else". That was wrong, and the correction matters
 * because the sentence was being used to size the work.
 *
 * Every method below is **synchronous**, and the unit of work is
 * `transaction<T>(work: () => T): T` — a synchronous callback. Every Node
 * Postgres client is asynchronous, so a Postgres driver forces this interface
 * async, and with it ~80 files that touch driver methods and 21 `transaction()`
 * call sites. The claim lease (A37/R16) would also need re-proving against a
 * different engine's locking.
 *
 * The interface still does its job — callers say *what* they store, never
 * *how*, so the change is mechanical rather than a redesign. It is simply a
 * project, not a file. See `09 Engineering/Vercel Deployment Limits.md` and
 * Decision Log D108.
 *
 * Note what is absent: there is **no** `updateLedgerEntry` and **no**
 * `deleteLedgerEntry`. The interface offers no way to mutate ledger history,
 * and the database refuses it too — see `migrations/002`.
 */

import type {
  AuditEvent,
  BalanceReservation,
  BalanceView,
  DraftEntry,
  LedgerAccountKind,
  MerchantId,
  MerchantUserId,
  OperatingMode,
  PostingId,
  Timestamp,
  Transaction,
  TransactionId,
} from '@telga/domain';
import type {
  AccountType,
  AuditEventRow,
  DeviceRow,
  IdempotencyRow,
  LedgerAccountRow,
  LedgerEntryRow,
  MerchantRow,
  MigrationRow,
  PendingResolutionRow,
  ReservationRow,
  SupportCaseRow,
  TransactionRow,
} from '../schema/types';

export interface DriverOptions {
  /** File path, or `:memory:`. A test suite should use its own file. */
  readonly file: string;
  /** Milliseconds a blocked writer waits before giving up. */
  readonly busyTimeoutMs?: number;
  /** `FULL` is the default: this is a ledger, not a cache. */
  readonly synchronous?: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA';
  readonly readonly?: boolean;
}

export interface PragmaReport {
  readonly journalMode: string;
  readonly foreignKeys: number;
  readonly busyTimeout: number;
  readonly synchronous: number;
}

export interface DriverHealth {
  readonly healthy: boolean;
  readonly pragmas: PragmaReport;
  readonly migrationsApplied: number;
  readonly integrityCheck: string;
  readonly message?: string;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly total: number;
}

export interface PostingInput {
  readonly postingId: PostingId;
  readonly entries: readonly DraftEntry[];
  readonly correlationId: string;
  readonly at: Timestamp;
  readonly mode: OperatingMode;
  /** Safe, non-identifying context only. Never credentials or full numbers. */
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface MerchantInput {
  readonly id: MerchantId;
  readonly status: MerchantRow['status'];
  readonly mode: OperatingMode;
  readonly at: Timestamp;
}

export interface DeviceInput {
  readonly id: string;
  readonly merchantId: MerchantId;
  readonly status: DeviceRow['status'];
  readonly deviceType: DeviceRow['device_type'];
  readonly at: Timestamp;
}

export interface TransactionInput {
  readonly transaction: Transaction;
  /** The full recipient never reaches storage; only a mask and a hash do. */
  readonly recipientMasked: string;
  readonly recipientHash: string;
  readonly payloadFingerprint: string;
  readonly productType: string;
}

export interface IdempotencyInput {
  readonly key: string;
  readonly merchantId: MerchantId;
  readonly requestIdentity: string;
  readonly payloadFingerprint: string;
  readonly transactionId: TransactionId;
  readonly at: Timestamp;
}

export interface AuditInput {
  readonly event: AuditEvent;
  readonly correlationId: string;
  readonly entityType: string;
  readonly entityId?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * The persistence contract.
 *
 * Every read that can be scoped to a merchant takes a `MerchantId` and filters
 * in SQL — merchant isolation is enforced at the query, not by the caller
 * remembering to filter.
 */
export interface LedgerDriver {
  // --- lifecycle -----------------------------------------------------------
  /** Apply any migrations not yet applied. Safe to call repeatedly. */
  migrate(): MigrationResult;
  appliedMigrations(): readonly MigrationRow[];
  health(): DriverHealth;
  pragmas(): PragmaReport;
  close(): void;
  readonly isOpen: boolean;

  // --- unit of work --------------------------------------------------------
  /**
   * Run `work` inside a database transaction. Any throw rolls the whole thing
   * back, which is what makes a failed reservation leave no partial state.
   */
  transaction<T>(work: () => T): T;

  // --- ledger (append-only) ------------------------------------------------
  appendEntries(posting: PostingInput): readonly LedgerEntryRow[];
  readEntries(limit?: number): readonly LedgerEntryRow[];
  readEntriesByMerchant(merchantId: MerchantId): readonly LedgerEntryRow[];
  readEntriesByAccount(accountId: string): readonly LedgerEntryRow[];
  readEntriesByTransaction(transactionId: TransactionId, merchantId?: MerchantId): readonly LedgerEntryRow[];

  // --- accounts ------------------------------------------------------------
  ensureAccount(input: {
    id: string;
    merchantId?: MerchantId;
    accountType: AccountType;
    at: Timestamp;
  }): LedgerAccountRow;
  findAccount(merchantId: MerchantId, accountType: LedgerAccountKind): LedgerAccountRow | undefined;

  // --- derived balances ----------------------------------------------------
  /** The four merchant-facing views. `BANK_CLEARING` is never included. */
  balanceFor(merchantId: MerchantId): BalanceView;
  /** Training profit attributed to this merchant on one `YYYY-MM-DD`. */
  profitForDay(merchantId: MerchantId, dayPrefix: string): number;
  /** True when this posting id was already written — a retry, not a new posting. */
  postingExists(postingId: string): boolean;
  /** Profit earned and not yet moved to the selling balance. */
  profitAvailableMinor(merchantId: MerchantId): number;
  /** Replace one user's PIN. Returns false when no such user in this merchant. */
  updateMerchantUserPin(input: {
    readonly id: MerchantUserId;
    readonly merchantId: MerchantId;
    readonly pinHash: string;
    readonly pinSalt: string;
    readonly pinParams: string;
    readonly at: Timestamp;
  }): boolean;
  /** Whole-ledger residual. Zero when double entry holds. */
  ledgerResidualMinor(): number;

  // --- merchants and devices ----------------------------------------------
  saveMerchant(input: MerchantInput): MerchantRow;
  findMerchant(id: MerchantId): MerchantRow | undefined;
  saveDevice(input: DeviceInput): DeviceRow;
  findDevice(id: string, merchantId?: MerchantId): DeviceRow | undefined;

  // --- transactions --------------------------------------------------------
  saveTransaction(input: TransactionInput): TransactionRow;
  findTransaction(id: TransactionId, merchantId?: MerchantId): TransactionRow | undefined;
  findTransactionsByMerchant(merchantId: MerchantId): readonly TransactionRow[];

  // --- idempotency ---------------------------------------------------------
  saveIdempotencyRecord(input: IdempotencyInput): IdempotencyRow;
  findIdempotencyRecord(merchantId: MerchantId, key: string): IdempotencyRow | undefined;

  // --- reservations --------------------------------------------------------
  saveReservation(reservation: BalanceReservation, correlationId: string): ReservationRow;
  findReservation(transactionId: TransactionId, merchantId?: MerchantId): ReservationRow | undefined;
  findReservationsByMerchant(merchantId: MerchantId): readonly ReservationRow[];

  // --- audit ---------------------------------------------------------------
  saveAuditEvent(input: AuditInput): AuditEventRow;
  readAuditEvents(merchantId?: MerchantId): readonly AuditEventRow[];

  // --- pending resolution and support -------------------------------------
  /**
   * Schedule a status lookup for a transaction that went PENDING.
   *
   * This is what makes a timeout resolvable rather than merely survivable: the
   * row carries the deadline after which the transaction must be escalated.
   */
  upsertPendingResolution(input: {
    transactionId: TransactionId;
    merchantId: MerchantId;
    idempotencyKey: string;
    providerReference?: string;
    correlationId: string;
    firstPendingAt: Timestamp;
    deadlineAt: Timestamp;
  }): PendingResolutionRow;
  findPendingResolution(transactionId: TransactionId): PendingResolutionRow | undefined;
  awaitingResolutions(merchantId?: MerchantId): readonly PendingResolutionRow[];
  recordResolutionAttempt(transactionId: TransactionId, at: Timestamp): void;
  /** Guarded on `AWAITING`; returns false when already closed. */
  closePendingResolution(
    transactionId: TransactionId,
    to: 'RESOLVED' | 'ESCALATED',
    at: Timestamp,
  ): boolean;

  createSupportCase(input: {
    id: string;
    merchantId: MerchantId;
    transactionId?: TransactionId;
    reason: SupportCaseRow['reason'];
    reference: string;
    correlationId: string;
    at: Timestamp;
  }): SupportCaseRow;
  findSupportCaseByTransaction(
    transactionId: TransactionId,
    merchantId?: MerchantId,
  ): SupportCaseRow | undefined;
  findSupportCasesByMerchant(merchantId: MerchantId): readonly SupportCaseRow[];
}
