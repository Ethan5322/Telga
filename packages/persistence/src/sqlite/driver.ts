/**
 * SQLite implementation of `LedgerDriver`.
 *
 * Composes the repositories and owns the connection. Nothing above this file
 * knows SQLite exists; replacing it with a Postgres driver means implementing
 * the same interface and changing no caller.
 */

import type {
  BalanceReservation,
  BalanceView,
  DeviceId,
  MerchantUserId,
  LedgerAccountKind,
  MerchantId,
  Timestamp,
  TransactionId,
  TransactionState,
} from '@telga/domain';
import type {
  AuditInput,
  DeviceInput,
  DriverHealth,
  DriverOptions,
  IdempotencyInput,
  LedgerDriver,
  MerchantInput,
  MigrationResult,
  PostingInput,
  PragmaReport,
  TransactionInput,
} from '../driver/types';
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
  RecoveryClaimRow,
  ReservationRow,
  SupportCaseRow,
  TransactionRow,
  MerchantUserRow,
  DeviceEnrollmentRow,
  SessionRow,
  AttemptScope,
} from '../schema/types';
import { DriverClosedError } from '../driver/errors';
import type { Db } from './connection';
import { closeDatabase, integrityCheck, openDatabase, readPragmas } from './connection';
import { appliedMigrations, runMigrations } from './migrator';
import * as merchants from '../repositories/merchants';
import * as transactions from '../repositories/transactions';
import * as ledger from '../repositories/ledger';
import * as reservations from '../repositories/reservations';
import * as audit from '../repositories/audit';
import * as pending from '../repositories/pending';
import * as recovery from '../repositories/recovery';
import * as identity from '../repositories/identity';

export class SqliteLedgerDriver implements LedgerDriver {
  private db: Db | undefined;
  private readonly options: DriverOptions;

  constructor(options: DriverOptions) {
    this.options = options;
    this.db = openDatabase(options);
  }

  get isOpen(): boolean {
    return this.db !== undefined && this.db.open;
  }

  /** Every method goes through here, so a closed driver fails loudly. */
  private handle(): Db {
    if (!this.db || !this.db.open) throw new DriverClosedError();
    return this.db;
  }

  /** Direct connection access, for tests that must attempt raw SQL. */
  get unsafeConnection(): Db {
    return this.handle();
  }

  // --- lifecycle -----------------------------------------------------------

  migrate(now: Timestamp = new Date().toISOString() as Timestamp): MigrationResult {
    return runMigrations(this.handle(), now);
  }

  appliedMigrations(): readonly MigrationRow[] {
    return appliedMigrations(this.handle());
  }

  pragmas(): PragmaReport {
    return readPragmas(this.handle());
  }

  health(): DriverHealth {
    const db = this.handle();
    const pragmas = readPragmas(db);
    const check = integrityCheck(db);
    const applied = appliedMigrations(db).length;
    const residual = ledger.ledgerResidualMinor(db);

    const healthy = check === 'ok' && pragmas.foreignKeys === 1 && residual === 0;
    return Object.freeze({
      healthy,
      pragmas,
      migrationsApplied: applied,
      integrityCheck: check,
      message: healthy ? undefined : `integrity=${check} residual=${String(residual)}`,
    });
  }

  close(): void {
    if (this.db) {
      closeDatabase(this.db);
      this.db = undefined;
    }
  }

  // --- unit of work --------------------------------------------------------

  /**
   * Run `work` in a write transaction.
   *
   * **`BEGIN IMMEDIATE`, not the default `BEGIN`.** Every unit of work that
   * reaches this method writes — reserve, finalize, release, recover — and a
   * deferred transaction starts as a *reader* and upgrades on the first write.
   * In WAL mode, if another connection has written since the read snapshot
   * began, that upgrade fails with **`SQLITE_BUSY_SNAPSHOT`**, which SQLite
   * returns immediately and which `busy_timeout` **does not** wait out. There is
   * no safe automatic recovery from it either: the transaction's reads may
   * already be stale.
   *
   * Taking the write lock up front converts that un-waitable failure into an
   * ordinary wait that `busy_timeout` handles. It serialises writers a little
   * more, which is the correct trade for a ledger.
   *
   * Found by the A54 stress harness: two worker processes racing one
   * transaction produced `recoveryFailures: 1` with
   * `failureReasonCodes: ["SQLITE_BUSY_SNAPSHOT"]`. See
   * `09 Engineering/Test Stability Runbook.md`.
   */
  transaction<T>(work: () => T): T {
    return this.handle().transaction(work).immediate();
  }

  // --- ledger --------------------------------------------------------------

  appendEntries(posting: PostingInput): readonly LedgerEntryRow[] {
    return ledger.appendEntries(this.handle(), posting);
  }

  readEntries(limit?: number): readonly LedgerEntryRow[] {
    return ledger.readEntries(this.handle(), limit);
  }

  readEntriesByMerchant(merchantId: MerchantId): readonly LedgerEntryRow[] {
    return ledger.readEntriesByMerchant(this.handle(), merchantId);
  }

  readEntriesByAccount(accountId: string): readonly LedgerEntryRow[] {
    return ledger.readEntriesByAccount(this.handle(), accountId);
  }

  readEntriesByTransaction(
    transactionId: TransactionId,
    merchantId?: MerchantId,
  ): readonly LedgerEntryRow[] {
    return ledger.readEntriesByTransaction(this.handle(), transactionId, merchantId);
  }

  // --- accounts ------------------------------------------------------------

  ensureAccount(input: {
    id: string;
    merchantId?: MerchantId;
    accountType: AccountType;
    at: Timestamp;
  }): LedgerAccountRow {
    return ledger.ensureAccount(this.handle(), input);
  }

  findAccount(merchantId: MerchantId, accountType: LedgerAccountKind): LedgerAccountRow | undefined {
    return ledger.findAccount(this.handle(), merchantId, accountType);
  }

  // --- balances ------------------------------------------------------------

  balanceFor(merchantId: MerchantId): BalanceView {
    return ledger.balanceFor(this.handle(), merchantId);
  }

  ledgerResidualMinor(): number {
    return ledger.ledgerResidualMinor(this.handle());
  }

  // --- merchants and devices ----------------------------------------------

  saveMerchant(input: MerchantInput): MerchantRow {
    return merchants.saveMerchant(this.handle(), input);
  }

  findMerchant(id: MerchantId): MerchantRow | undefined {
    return merchants.findMerchant(this.handle(), id);
  }

  saveDevice(input: DeviceInput): DeviceRow {
    return merchants.saveDevice(this.handle(), input);
  }

  findDevice(id: string, merchantId?: MerchantId): DeviceRow | undefined {
    return merchants.findDevice(this.handle(), id, merchantId);
  }

  assertDeviceOwnership(deviceId: string, merchantId: MerchantId): void {
    merchants.assertDeviceOwnership(this.handle(), deviceId, merchantId);
  }

  // --- transactions --------------------------------------------------------

  saveTransaction(input: TransactionInput): TransactionRow {
    return transactions.saveTransaction(this.handle(), input);
  }

  findTransaction(id: TransactionId, merchantId?: MerchantId): TransactionRow | undefined {
    return transactions.findTransaction(this.handle(), id, merchantId);
  }

  findTransactionsByMerchant(merchantId: MerchantId): readonly TransactionRow[] {
    return transactions.findTransactionsByMerchant(this.handle(), merchantId);
  }

  // --- idempotency ---------------------------------------------------------

  saveIdempotencyRecord(input: IdempotencyInput): IdempotencyRow {
    return transactions.saveIdempotencyRecord(this.handle(), input);
  }

  findIdempotencyRecord(merchantId: MerchantId, key: string): IdempotencyRow | undefined {
    return transactions.findIdempotencyRecord(this.handle(), merchantId, key);
  }

  recordIdempotencyResult(merchantId: MerchantId, key: string, state: string, at: Timestamp): void {
    transactions.recordIdempotencyResult(this.handle(), merchantId, key, state, at);
  }

  // --- reservations --------------------------------------------------------

  saveReservation(reservation: BalanceReservation, correlationId: string): ReservationRow {
    return reservations.saveReservation(this.handle(), reservation, correlationId);
  }

  findReservation(transactionId: TransactionId, merchantId?: MerchantId): ReservationRow | undefined {
    return reservations.findReservation(this.handle(), transactionId, merchantId);
  }

  findReservationById(id: string): ReservationRow | undefined {
    return reservations.findReservationById(this.handle(), id);
  }

  findReservationsByMerchant(merchantId: MerchantId): readonly ReservationRow[] {
    return reservations.findReservationsByMerchant(this.handle(), merchantId);
  }

  transitionHeldReservation(id: string, to: ReservationRow['status'], at: Timestamp): boolean {
    return reservations.transitionHeldReservation(this.handle(), id, to, at);
  }

  transitionUnderReviewReservation(id: string, to: ReservationRow['status'], at: Timestamp): boolean {
    return reservations.transitionUnderReviewReservation(this.handle(), id, to, at);
  }

  // --- audit ---------------------------------------------------------------

  saveAuditEvent(input: AuditInput): AuditEventRow {
    return audit.saveAuditEvent(this.handle(), input);
  }

  readAuditEvents(merchantId?: MerchantId): readonly AuditEventRow[] {
    return audit.readAuditEvents(this.handle(), merchantId);
  }

  readAuditEventsByCorrelation(correlationId: string): readonly AuditEventRow[] {
    return audit.readAuditEventsByCorrelation(this.handle(), correlationId);
  }

  // --- pending resolution and support -------------------------------------

  upsertPendingResolution(input: {
    transactionId: TransactionId;
    merchantId: MerchantId;
    idempotencyKey: string;
    providerReference?: string;
    correlationId: string;
    firstPendingAt: Timestamp;
    deadlineAt: Timestamp;
  }): PendingResolutionRow {
    return pending.upsertPendingResolution(this.handle(), input);
  }

  findPendingResolution(transactionId: TransactionId): PendingResolutionRow | undefined {
    return pending.findPendingResolution(this.handle(), transactionId);
  }

  awaitingResolutions(merchantId?: MerchantId): readonly PendingResolutionRow[] {
    return pending.awaitingResolutions(this.handle(), merchantId);
  }

  recordResolutionAttempt(transactionId: TransactionId, at: Timestamp): void {
    pending.recordResolutionAttempt(this.handle(), transactionId, at);
  }

  closePendingResolution(
    transactionId: TransactionId,
    to: 'RESOLVED' | 'ESCALATED',
    at: Timestamp,
  ): boolean {
    return pending.closePendingResolution(this.handle(), transactionId, to, at);
  }

  createSupportCase(input: {
    id: string;
    merchantId: MerchantId;
    transactionId?: TransactionId;
    reason: SupportCaseRow['reason'];
    reference: string;
    correlationId: string;
    at: Timestamp;
  }): SupportCaseRow {
    return pending.createSupportCase(this.handle(), input);
  }

  findSupportCaseByTransaction(
    transactionId: TransactionId,
    merchantId?: MerchantId,
  ): SupportCaseRow | undefined {
    return pending.findSupportCaseByTransaction(this.handle(), transactionId, merchantId);
  }

  findSupportCasesByMerchant(merchantId: MerchantId): readonly SupportCaseRow[] {
    return pending.findSupportCasesByMerchant(this.handle(), merchantId);
  }

  // --- identity, sessions and device enrolment -----------------------------
  //
  // Delegations only. No hashing happens here: this layer stores derived values
  // and never sees a PIN, a session token or a device secret.

  saveMerchantUser(input: identity.MerchantUserInput): MerchantUserRow {
    return identity.saveMerchantUser(this.handle(), input);
  }

  findMerchantUser(id: MerchantUserId, merchantId?: MerchantId): MerchantUserRow | undefined {
    return identity.findMerchantUser(this.handle(), id, merchantId);
  }

  findMerchantUsers(merchantId: MerchantId): readonly MerchantUserRow[] {
    return identity.findMerchantUsers(this.handle(), merchantId);
  }

  recordFailedLogin(
    id: MerchantUserId,
    at: Timestamp,
    maxFailedAttempts: number,
    lockedUntil: Timestamp,
  ): MerchantUserRow | undefined {
    return identity.recordFailedLogin(this.handle(), id, at, maxFailedAttempts, lockedUntil);
  }

  recordSuccessfulLogin(id: MerchantUserId, at: Timestamp): void {
    identity.recordSuccessfulLogin(this.handle(), id, at);
  }

  saveDeviceEnrollment(input: identity.DeviceEnrollmentInput): DeviceEnrollmentRow {
    return identity.saveDeviceEnrollment(this.handle(), input);
  }

  findDeviceEnrollment(deviceId: DeviceId): DeviceEnrollmentRow | undefined {
    return identity.findDeviceEnrollment(this.handle(), deviceId);
  }

  findDeviceEnrollments(merchantId: MerchantId): readonly DeviceEnrollmentRow[] {
    return identity.findDeviceEnrollments(this.handle(), merchantId);
  }

  revokeDevice(
    deviceId: DeviceId,
    reason: string,
    at: Timestamp,
  ): { revoked: boolean; sessionsRevoked: number } {
    return identity.revokeDevice(this.handle(), deviceId, reason, at);
  }

  touchDevice(deviceId: DeviceId, at: Timestamp): void {
    identity.touchDevice(this.handle(), deviceId, at);
  }

  createSession(input: identity.SessionInput): SessionRow {
    return identity.createSession(this.handle(), input);
  }

  findSession(id: string): SessionRow | undefined {
    return identity.findSession(this.handle(), id);
  }

  touchSession(id: string, at: Timestamp, idleExpiresAt: Timestamp): void {
    identity.touchSession(this.handle(), id, at, idleExpiresAt);
  }

  revokeSession(id: string, reason: string, at: Timestamp): boolean {
    return identity.revokeSession(this.handle(), id, reason, at);
  }

  noteSessionRejection(id: string, reason: string, at: Timestamp): boolean {
    return identity.noteSessionRejection(this.handle(), id, reason, at);
  }

  revokeSessionsForDevice(deviceId: DeviceId, reason: string, at: Timestamp): number {
    return identity.revokeSessionsForDevice(this.handle(), deviceId, reason, at);
  }

  revokeSessionsForUser(userId: MerchantUserId, reason: string, at: Timestamp): number {
    return identity.revokeSessionsForUser(this.handle(), userId, reason, at);
  }

  countActiveSessions(): number {
    return identity.countActiveSessions(this.handle());
  }

  recordAttempt(
    scope: AttemptScope,
    subject: string,
    outcome: 'SUCCESS' | 'FAILURE',
    at: Timestamp,
  ): void {
    identity.recordAttempt(this.handle(), scope, subject, outcome, at);
  }

  countAttemptsSince(scope: AttemptScope, subject: string, since: Timestamp): number {
    return identity.countAttemptsSince(this.handle(), scope, subject, since);
  }

  pruneAttempts(before: Timestamp): number {
    return identity.pruneAttempts(this.handle(), before);
  }

  updatePendingMetadata(
    transactionId: TransactionId,
    input: {
      at: Timestamp;
      nextCheckAt?: string;
      lastOutcomeCategory?: string;
      currentState?: string;
      manualReviewStatus?: string;
      deadlineAt?: string;
    },
  ): void {
    pending.updatePendingMetadata(this.handle(), transactionId, input);
  }

  approveSupportCase(id: string, approvedBy: string, at: Timestamp): boolean {
    return pending.approveSupportCase(this.handle(), id, approvedBy, at);
  }

  // --- recovery ------------------------------------------------------------

  /** Atomic claim. Returns `claimed: false` when another worker holds the lease. */
  claimTransaction(input: {
    transactionId: TransactionId;
    workerId: string;
    scanId: string;
    now: Timestamp;
    expiresAt: string;
  }): recovery.ClaimOutcome {
    return recovery.claimTransaction(this.handle(), input);
  }

  releaseClaim(transactionId: TransactionId, workerId: string, at: Timestamp): boolean {
    return recovery.releaseClaim(this.handle(), transactionId, workerId, at);
  }

  findClaim(transactionId: TransactionId): RecoveryClaimRow | undefined {
    return recovery.findClaim(this.handle(), transactionId);
  }

  findInFlightOlderThan(
    states: readonly TransactionState[],
    olderThan: string,
    limit: number,
    merchantId?: MerchantId,
  ): readonly { id: string; merchant_id: string; state: TransactionState; updated_at: string }[] {
    return recovery.findInFlightOlderThan(this.handle(), states, olderThan, limit, merchantId);
  }

  countTransactionsByState(state: TransactionState): number {
    return recovery.countTransactionsByState(this.handle(), state);
  }

  oldestUnresolved(states: readonly TransactionState[]): { id: string; updated_at: string } | undefined {
    return recovery.oldestUnresolved(this.handle(), states);
  }

  countOpenManualReviews(): number {
    return recovery.countOpenManualReviews(this.handle());
  }

  /** Release only claims this worker owns. Others are left to expire. */
  releaseClaimsOwnedBy(workerId: string, at: Timestamp): number {
    return recovery.releaseClaimsOwnedBy(this.handle(), workerId, at);
  }

  countActiveClaims(workerId?: string): number {
    return recovery.countActiveClaims(this.handle(), workerId);
  }
}

/** Open a driver and apply migrations in one step. */
export function createSqliteDriver(options: DriverOptions, now?: Timestamp): SqliteLedgerDriver {
  const driver = new SqliteLedgerDriver(options);
  driver.migrate(now);
  return driver;
}
