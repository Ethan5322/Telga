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
  PendingOrderRow,
  CustomerRow,
  ShiftRow,
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
import * as pendingOrders from '../repositories/pendingOrders';
import * as settings from '../repositories/settings';
import * as shopbook from '../repositories/shopbook';
import * as applications from '../repositories/applications';
import * as extensions from '../repositories/extensions';
import * as topupOrders from '../repositories/topupOrders';
import type { PendingOrderInput } from '../repositories/pendingOrders';

/**
 * How to open the driver's database.
 *
 * The plain {@link DriverOptions} case opens a connection from a path and owns
 * it. `connection` is the other case: adopt one that is already open.
 */
export interface SqliteDriverOptions extends DriverOptions {
  /**
   * An already-open connection to use instead of opening one.
   *
   * ## When this is the right thing
   *
   * A process that already holds a connection and needs the ledger **inside a
   * transaction it has already begun**. The operations console is the example:
   * it records a deposit in raw SQL and credits the merchant through
   * `fundMerchant` in the same unit of work. On a second connection that credit
   * is a separate writer against a file whose write lock the first connection
   * holds, and it cannot wait for the transaction that is waiting for it —
   * `SQLITE_BUSY: database is locked`, every time, not intermittently. One
   * process cannot queue behind itself.
   *
   * With a shared connection `transaction()` issues a `SAVEPOINT` rather than a
   * `BEGIN`, because that is what `better-sqlite3` does when the connection is
   * already in a transaction, and the nested work still rolls back as a unit.
   *
   * **The adopter keeps ownership.** `close()` leaves an adopted connection
   * open: whoever opened it closes it, and a driver that closed a connection
   * out from under its owner would be a far worse bug than the one this fixes.
   * Pragmas are left alone too — they belong to whoever opened it.
   */
  readonly connection?: Db;
}

export class SqliteLedgerDriver implements LedgerDriver {
  private db: Db | undefined;
  private readonly options: DriverOptions;
  /** False when the connection was adopted, so `close()` leaves it alone. */
  private readonly ownsConnection: boolean;

  constructor(options: SqliteDriverOptions) {
    this.options = options;
    this.ownsConnection = options.connection === undefined;
    this.db = options.connection ?? openDatabase(options);
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
      // An adopted connection is somebody else's to close. Dropping the handle
      // still makes this driver unusable, which is what `close()` promises.
      if (this.ownsConnection) closeDatabase(this.db);
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

  profitForDay(merchantId: MerchantId, dayPrefix: string): number {
    return ledger.profitForDay(this.handle(), merchantId, dayPrefix);
  }

  postingExists(postingId: string): boolean {
    return ledger.postingExists(this.handle(), postingId);
  }

  /** Profit earned and not yet moved to the selling balance. */
  profitAvailableMinor(merchantId: MerchantId): number {
    return ledger.profitAvailableMinor(this.handle(), merchantId);
  }

  // --- saved customers and shifts -------------------------------------------

  saveCustomer(input: shopbook.CustomerInput): CustomerRow {
    return shopbook.saveCustomer(this.handle(), input);
  }

  listCustomers(merchantId: MerchantId): readonly CustomerRow[] {
    return shopbook.listCustomers(this.handle(), merchantId);
  }

  openShift(input: shopbook.ShiftInput): ShiftRow {
    return shopbook.openShift(this.handle(), input);
  }

  findOpenShift(merchantId: MerchantId, operatorId: MerchantUserId): ShiftRow | undefined {
    return shopbook.findOpenShift(this.handle(), merchantId, operatorId);
  }

  closeShift(id: string, at: Timestamp): boolean {
    return shopbook.closeShift(this.handle(), id, at);
  }

  /** Replace one user's PIN. Returns false when no such user in this merchant. */
  updateMerchantUserPin(input: Parameters<typeof identity.updateMerchantUserPin>[1]): boolean {
    return identity.updateMerchantUserPin(this.handle(), input);
  }

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

  countAuditEvents(eventType: string, entityId: string): number {
    return audit.countAuditEvents(this.handle(), eventType, entityId);
  }

  // --- merchant settings -----------------------------------------------------

  readSetting(merchantId: MerchantId, key: settings.SettingKey): string | undefined {
    return settings.readSetting(this.handle(), merchantId, key);
  }

  readSettings(merchantId: MerchantId): readonly settings.SettingRow[] {
    return settings.readSettings(this.handle(), merchantId);
  }

  writeSetting(
    merchantId: MerchantId,
    key: settings.SettingKey,
    value: string,
    at: Timestamp,
  ): void {
    settings.writeSetting(this.handle(), merchantId, key, value, at);
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

  /** How many `PIN_AUTH` failures a subject has recorded since `since`. */
  countFailuresSince(scope: AttemptScope, subject: string, since: Timestamp): number {
    return identity.countFailuresSince(this.handle(), scope, subject, since);
  }

  // --- merchant applications -------------------------------------------------
  //
  // The app's *Register as vendor* route needs to write an application and to
  // count what a caller has tried recently, and it holds a driver rather than a
  // connection. These delegate exactly as every other repository call does —
  // the alternative was handing the POS server a raw `Db`, which would give the
  // one process an unauthenticated stranger can reach the widest possible
  // access to the database.

  recordApplication(input: applications.ApplicationInput): void {
    applications.recordApplication(this.handle(), input);
  }

  countRegistrationAttemptsSince(source: string, since: string): number {
    return applications.countRegistrationAttemptsSince(this.handle(), source, since);
  }

  recordRegistrationAttempt(source: string, outcome: 'RECORDED' | 'REFUSED', at: string): void {
    applications.recordRegistrationAttempt(this.handle(), source, outcome, at);
  }

  pruneRegistrationAttempts(before: string): number {
    return applications.pruneRegistrationAttempts(this.handle(), before);
  }

  /** Give a shop its own deposit reference if it has none — §20.1. */
  ensureDepositReference(
    merchantId: MerchantId,
    newReference: () => string,
    normalize: (raw: string) => string,
  ): string {
    return merchants.ensureDepositReference(this.handle(), merchantId, newReference, normalize);
  }

  findMerchantByDepositReference(reference: string): MerchantRow | undefined {
    return merchants.findMerchantByDepositReference(this.handle(), reference);
  }

  // --- bank deposit slips ---------------------------------------------------
  //
  // §20.1. The **Deposit money** button creates one of these, and the printed
  // slip carries its reference. Delegated for the same reason as the block
  // below: the POS holds a driver, not a database.

  /**
   * Create an order, drawing references until the `UNIQUE` index accepts one.
   *
   * The generator is passed in rather than imported, so persistence keeps no
   * dependency on the domain package and a test can force a collision.
   * Returns the reference actually stored, normalised.
   */
  saveTopupOrder(
    input: topupOrders.NewTopupOrder,
    newReference: () => string,
    normalize: (raw: string) => string,
  ): string {
    return topupOrders.saveTopupOrder(this.handle(), input, newReference, normalize);
  }

  /** What the payment provider last said about an order. Evidence, not authority. */
  recordTopupProviderOutcome(input: Parameters<typeof topupOrders.recordTopupProviderOutcome>[1]): number {
    return topupOrders.recordTopupProviderOutcome(this.handle(), input);
  }

  /**
   * A deposit matched to a shop and waiting for a person — §20.
   *
   * Written directly rather than through `recordDeposit`, because that function
   * decides *whether* to credit and this caller has already decided: a verified
   * Chapa payment is queued for an administrator, never credited on the spot.
   */
  insertFundingSubmission(input: {
    readonly id: string;
    readonly merchantId: string;
    readonly quotedReference: string;
    readonly bankReference: string;
    readonly claimedAmountMinor: number;
    readonly bankAmountMinor: number;
    readonly status: string;
    readonly currency: string;
    readonly recordedBy: string | null;
    readonly evidence: string;
    readonly at: string;
  }): void {
    this.handle()
      .prepare(
        `INSERT INTO funding_submissions
           (id, merchant_id, quoted_reference, bank_reference, claimed_amount_minor,
            bank_amount_minor, status, currency, recorded_by, evidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.merchantId,
        input.quotedReference,
        input.bankReference,
        input.claimedAmountMinor,
        input.bankAmountMinor,
        input.status,
        input.currency,
        input.recordedBy,
        input.evidence,
        input.at,
        input.at,
      );
  }

  /** Whose reference is this? Matched whole, never on amount or date. */
  findTopupOrderByReference(reference: string): topupOrders.TopupOrderRow | undefined {
    return topupOrders.findTopupOrderByReference(this.handle(), reference);
  }

  /** The shop's live slip, if it is holding one. */
  findOpenTopupOrder(merchantId: string, nowIso: string): topupOrders.TopupOrderRow | undefined {
    return topupOrders.findOpenTopupOrder(this.handle(), merchantId, nowIso);
  }

  listTopupOrdersFor(merchantId: string, limit?: number): readonly topupOrders.TopupOrderRow[] {
    return topupOrders.listTopupOrdersFor(this.handle(), merchantId, limit);
  }

  markTopupOrderPaid(input: Parameters<typeof topupOrders.markTopupOrderPaid>[1]): number {
    return topupOrders.markTopupOrderPaid(this.handle(), input);
  }

  /** Claim an order for settlement. The lock in a concurrent settlement. */
  claimTopupOrderForSettlement(reference: string, at: string): number {
    return topupOrders.claimTopupOrderForSettlement(this.handle(), reference, at);
  }

  /** Name the submission that settled it, once it exists. */
  linkTopupOrderSubmission(reference: string, fundingSubmissionId: string, at: string): number {
    return topupOrders.linkTopupOrderSubmission(this.handle(), reference, fundingSubmissionId, at);
  }

  cancelTopupOrder(id: string, at: string): number {
    return topupOrders.cancelTopupOrder(this.handle(), id, at);
  }

  expireTopupOrders(nowIso: string): number {
    return topupOrders.expireTopupOrders(this.handle(), nowIso);
  }

  // --- reversal requests, complaints and shop transfers ----------------------
  //
  // §17.1, §17.2 and §19.1. Delegating rather than handing a raw connection out,
  // for the reason the application intake methods above give: the POS holds a
  // driver, and widening that to a whole database would give the one process an
  // unauthenticated stranger can reach the widest possible access.

  saveReversalRequest(input: extensions.NewReversalRequest): void {
    extensions.saveReversalRequest(this.handle(), input);
  }

  findOpenReversalRequest(transactionId: string): extensions.ReversalRequestRow | undefined {
    return extensions.findOpenReversalRequest(this.handle(), transactionId);
  }

  listReversalQueue(): readonly extensions.ReversalRequestRow[] {
    return extensions.listReversalQueue(this.handle());
  }

  decideReversalRequest(input: Parameters<typeof extensions.decideReversalRequest>[1]): number {
    return extensions.decideReversalRequest(this.handle(), input);
  }

  saveComplaintReview(input: Parameters<typeof extensions.saveComplaintReview>[1]): void {
    extensions.saveComplaintReview(this.handle(), input);
  }

  listOpenComplaints(): readonly extensions.ComplaintReviewRow[] {
    return extensions.listOpenComplaints(this.handle());
  }

  findComplaintReview(id: string): extensions.ComplaintReviewRow | undefined {
    return extensions.findComplaintReview(this.handle(), id);
  }

  recordComplaintVerdict(input: Parameters<typeof extensions.recordComplaintVerdict>[1]): number {
    return extensions.recordComplaintVerdict(this.handle(), input);
  }

  saveShopTransfer(input: Parameters<typeof extensions.saveShopTransfer>[1]): void {
    extensions.saveShopTransfer(this.handle(), input);
  }

  sentTodayMinor(merchantId: string, sinceIso: string): number {
    return extensions.sentTodayMinor(this.handle(), merchantId, sinceIso);
  }

  listTransfersFor(merchantId: string, limit?: number): readonly extensions.ShopTransferRow[] {
    return extensions.listTransfersFor(this.handle(), merchantId, limit);
  }

  listTransferQueue(): readonly extensions.ShopTransferRow[] {
    return extensions.listTransferQueue(this.handle());
  }

  // --- voucher pending orders ------------------------------------------------

  createPendingOrder(input: PendingOrderInput): PendingOrderRow {
    return pendingOrders.createPendingOrder(this.handle(), input);
  }

  findPendingOrder(id: string): PendingOrderRow | undefined {
    return pendingOrders.findPendingOrder(this.handle(), id);
  }

  expirePendingOrderIfDue(id: string, now: Timestamp): void {
    pendingOrders.expireIfDue(this.handle(), id, now);
  }

  cancelPendingOrder(id: string): boolean {
    return pendingOrders.cancelPendingOrder(this.handle(), id);
  }

  authorizePendingOrder(id: string, transactionId: TransactionId): boolean {
    return pendingOrders.authorizePendingOrder(this.handle(), id, transactionId);
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
