/**
 * recoverInFlight — the unattended recovery sweep.
 *
 * `createSale` leaves a gap by design: the provider call sits between two units
 * of work, so a crash in that gap leaves a transaction at `RESERVED` (provider
 * never called) or `PROCESSING` (we do not know). This service is what finds
 * those and drives them to a determinate end, or holds them safely and escalates.
 *
 * ## The rule everything here obeys
 *
 * **Only a determinate provider answer may move a merchant's money.** Silence,
 * an unreachable provider, a malformed body and a misconfigured credential all
 * mean the same thing operationally — we do not know — and all of them hold the
 * value exactly where it is.
 *
 * ## Evidence, not assumption
 *
 * `RESERVED` is proof the provider was never called: `createSale` transitions to
 * `PROCESSING` **before** it submits, so a transaction that never reached
 * `PROCESSING` never reached the provider either. That is the one case where
 * releasing funds without a provider answer is safe, and it is the only case
 * where this service does so. A `RESERVED` row that somehow carries a provider
 * reference is treated as uncertain instead.
 *
 * ## Concurrency
 *
 * Every transaction is claimed under a time-bounded lease before anything is
 * read or written. Two workers racing produce one winner and one recorded
 * refusal. The lease expires so a dead worker cannot hold a merchant's money
 * hostage.
 */

import {
  auditEventId,
  createAuditEvent,
  merchantId as makeMerchantId,
  postingId,
  transactionId as makeTransactionId,
  transitionTo,
} from '@telga/domain';
import type {
  AuditAction,
  AuditActor,
  MerchantId,
  TransactionId,
  TransactionState,
} from '@telga/domain';
import { finalizeSuccess, moveToUnderReview, release } from '@telga/persistence';
import type { TransactionRow } from '@telga/persistence';
import type { SaleDeps } from '../context';
import { addMs } from '../context';
import { persistRehydrated, rehydrate } from '../rehydrate';
import type { RecoveryConfig, RecoveryPolicy } from './config';
import { minimumRecoveryAgeMs, policyFor } from './config';
import type { ProviderLookupOutcome, RecoveryKind, RecoveryResult, SweepReport } from './results';
import { classifyLookupFailure, classifyStatus, isOperationalFault } from './results';

/** Scan-level audit rows are not merchant-scoped; this is their marker. */
export const PLATFORM_SCOPE: MerchantId = makeMerchantId('__platform__');

/**
 * States the sweep considers in flight.
 *
 * `PENDING` is included deliberately. `resolvePending` handles a pending
 * transaction when something calls it, but an unattended system has nothing
 * calling it — so without `PENDING` here, a transaction the sweep itself moved
 * to pending would sit holding a merchant's money forever, and the escalation
 * deadline would never be enforced.
 */
export const IN_FLIGHT_STATES: readonly TransactionState[] = ['PROCESSING', 'RESERVED', 'PENDING'];

/** States that still hold merchant value and are therefore worth measuring. */
export const UNRESOLVED_STATES: readonly TransactionState[] = [
  'RESERVED',
  'SUBMITTED',
  'PROCESSING',
  'PENDING',
  'UNDER_REVIEW',
  'REVERSAL_REQUIRED',
];

export interface RecoveryDeps extends SaleDeps {
  /** Identifies this worker in claims and audit events. */
  readonly workerId: string;
  readonly recovery: RecoveryConfig;
}

export interface SweepOptions {
  readonly merchantId?: MerchantId;
  /**
   * Checked between transactions. Returning `false` stops the sweep at a safe
   * boundary — after the current transaction has been resolved and its claim
   * released, never mid-operation.
   */
  readonly shouldContinue?: () => boolean;
}

const msBetween = (from: string, to: string): number =>
  new Date(to).getTime() - new Date(from).getTime();

const RECOVERY_ACTOR: AuditActor = { userId: 'system', role: 'SYSTEM' };

function writeAudit(
  deps: RecoveryDeps,
  input: {
    action: AuditAction;
    merchantId: MerchantId;
    correlationId: string;
    transactionId?: TransactionId;
    before?: TransactionState;
    after?: TransactionState;
    detail?: string;
  },
): void {
  deps.driver.saveAuditEvent({
    event: createAuditEvent({
      id: auditEventId(deps.newId('audit')),
      at: deps.now(),
      action: input.action,
      actor: RECOVERY_ACTOR,
      merchantId: input.merchantId,
      transactionId: input.transactionId,
      before: input.before,
      after: input.after,
      // Safe category or worker id only — never a provider body.
      detail: input.detail,
    }),
    correlationId: input.correlationId,
    entityType: 'transaction',
    entityId: input.transactionId,
  });
}

/**
 * Sweep for in-flight transactions and recover each one.
 *
 * Returns a report rather than throwing: one transaction failing to recover
 * must not stop the rest of the batch. Individual failures are recorded as
 * `RECOVERY_FAILED` results and audited — never swallowed silently.
 */
export async function recoverInFlight(
  deps: RecoveryDeps,
  options: SweepOptions = {},
): Promise<SweepReport> {
  const scanId = deps.newId('scan');
  const startedAt = deps.now();

  writeAudit(deps, {
    action: 'RECOVERY_SCAN_STARTED',
    merchantId: options.merchantId ?? PLATFORM_SCOPE,
    correlationId: scanId,
    detail: `worker=${deps.workerId}`,
  });

  const cutoff = addMs(startedAt, -minimumRecoveryAgeMs(deps.recovery));
  const candidates = deps.driver.findInFlightOlderThan(
    IN_FLIGHT_STATES,
    cutoff,
    deps.recovery.batchLimit,
    options.merchantId,
  );

  const results: RecoveryResult[] = [];
  let duplicateWorkersPrevented = 0;
  let claimed = 0;
  let providerLookupMs = 0;

  let stoppedEarly = false;

  for (const candidate of candidates) {
    // A safe boundary: the previous transaction is fully resolved and its claim
    // released, and this one has not been touched.
    if (options.shouldContinue && !options.shouldContinue()) {
      stoppedEarly = true;
      break;
    }

    const txId = makeTransactionId(candidate.id);
    const merchant = makeMerchantId(candidate.merchant_id);
    const row = deps.driver.findTransaction(txId, merchant);
    if (!row) continue;

    const policy = policyFor(deps.recovery, row.provider_id);
    const age = msBetween(row.updated_at, deps.now());

    // Inclusive at the boundary: a transaction exactly at the threshold is old
    // enough. Documented in `Recovery Configuration.md`.
    if (age < policy.recoveryAgeMs) {
      results.push(skip(row, 'SKIPPED_TOO_RECENT', scanId));
      continue;
    }

    const claim = deps.driver.claimTransaction({
      transactionId: txId,
      workerId: deps.workerId,
      scanId,
      now: deps.now(),
      expiresAt: addMs(deps.now(), policy.claimLeaseMs),
    });

    if (!claim.claimed) {
      duplicateWorkersPrevented += 1;
      writeAudit(deps, {
        action: 'RECOVERY_DUPLICATE_WORKER_PREVENTED',
        merchantId: merchant,
        correlationId: scanId,
        transactionId: txId,
        detail: `held_by=${claim.heldBy ?? 'unknown'}`,
      });
      results.push(skip(row, 'SKIPPED_CLAIMED_BY_OTHER', scanId));
      continue;
    }

    claimed += 1;
    writeAudit(deps, {
      action: 'RECOVERY_CLAIMED',
      merchantId: merchant,
      correlationId: scanId,
      transactionId: txId,
      detail: `worker=${deps.workerId}`,
    });

    try {
      const outcome = await recoverOne(deps, txId, merchant, policy, scanId);
      providerLookupMs += outcome.lookupMs;
      results.push(outcome.result);
    } catch (error) {
      // One transaction failing must not abort the batch, and must not be hidden.
      writeAudit(deps, {
        action: 'RECOVERY_ATTEMPT_FAILED',
        merchantId: merchant,
        correlationId: scanId,
        transactionId: txId,
        detail: safeCode(error),
      });
      const current = deps.driver.findTransaction(txId, merchant) ?? row;
      results.push({
        transactionId: txId,
        merchantId: merchant,
        kind: 'RECOVERY_FAILED',
        stateBefore: row.state,
        state: current.state,
        providerOutcome: 'UNKNOWN',
        attempts: deps.driver.findPendingResolution(txId)?.attempts ?? 0,
        correlationId: scanId,
        operationalAlert: true,
        reasonCode: safeCode(error),
        simulated: true,
      });
    } finally {
      deps.driver.releaseClaim(txId, deps.workerId, deps.now());
    }
  }

  const count = (kind: RecoveryKind): number => results.filter((r) => r.kind === kind).length;

  return Object.freeze({
    scanId,
    startedAt,
    finishedAt: deps.now(),
    found: candidates.length,
    claimed,
    duplicateWorkersPrevented,
    recoveredSuccessful: count('RECOVERED_SUCCESSFUL'),
    recoveredFailed: count('RECOVERED_FAILED'),
    releasedNeverSubmitted: count('RELEASED_NEVER_SUBMITTED'),
    movedToPending: count('MOVED_TO_PENDING'),
    escalatedUnderReview: count('ESCALATED_UNDER_REVIEW'),
    skipped: count('SKIPPED_TOO_RECENT') + count('SKIPPED_TERMINAL') + count('SKIPPED_CLAIMED_BY_OTHER'),
    recoveryFailures: count('RECOVERY_FAILED'),
    operationalAlerts: results.filter((r) => r.operationalAlert).length,
    providerLookupMs,
    stoppedEarly,
    results: Object.freeze(results),
  });
}

function skip(row: TransactionRow, kind: RecoveryKind, correlationId: string): RecoveryResult {
  return {
    transactionId: row.id,
    merchantId: row.merchant_id,
    kind,
    stateBefore: row.state,
    state: row.state,
    providerOutcome: 'NOT_ATTEMPTED',
    attempts: 0,
    correlationId,
    operationalAlert: false,
    simulated: true,
  };
}

async function recoverOne(
  deps: RecoveryDeps,
  txId: TransactionId,
  merchant: MerchantId,
  policy: RecoveryPolicy,
  scanId: string,
): Promise<{ result: RecoveryResult; lookupMs: number }> {
  const row = deps.driver.findTransaction(txId, merchant);
  if (!row) throw new Error('Transaction disappeared under claim');

  const stateBefore = row.state;
  const correlationId = deps.driver.findPendingResolution(txId)?.correlation_id ?? scanId;

  // Another worker or a callback resolved it between the scan and the claim.
  if (row.state !== 'PROCESSING' && row.state !== 'RESERVED' && row.state !== 'PENDING') {
    return { result: skip(row, 'SKIPPED_TERMINAL', correlationId), lookupMs: 0 };
  }

  // --- RESERVED, provably never submitted ----------------------------------
  if (row.state === 'RESERVED' && row.provider_reference === null) {
    deps.driver.transaction(() => {
      const at = deps.now();
      let txn = rehydrate(row);
      // The domain allows no RESERVED -> FAILED edge, so take the legal path.
      txn = transitionTo(txn, 'PROCESSING', { at, reason: 'recovery: reconstructing legal path' });
      txn = transitionTo(txn, 'FAILED', { at, reason: 'recovery: provider was never called' });
      persistRehydrated(deps.driver, txn, row);
      release(deps.driver, {
        merchantId: merchant,
        transactionId: txId,
        amount: txn.amount,
        at,
        correlationId,
        actor: RECOVERY_ACTOR,
        postingId: postingId(deps.newId('post')),
        auditId: deps.newId('audit'),
      });
      deps.driver.recordIdempotencyResult(merchant, row.idempotency_key, 'FAILED', at);
      writeAudit(deps, {
        action: 'RECOVERY_RECOVERED_FAILED',
        merchantId: merchant,
        correlationId,
        transactionId: txId,
        before: stateBefore,
        after: 'FAILED',
        detail: 'never_submitted',
      });
    });

    return {
      lookupMs: 0,
      result: {
        transactionId: txId,
        merchantId: merchant,
        kind: 'RELEASED_NEVER_SUBMITTED',
        stateBefore,
        state: 'FAILED',
        providerOutcome: 'NOT_ATTEMPTED',
        attempts: 0,
        correlationId,
        operationalAlert: false,
        reasonCode: 'PROVIDER_NEVER_CALLED',
        simulated: true,
      },
    };
  }

  // --- RESERVED with a provider reference: uncertain ------------------------
  // Move onto the pending path first so the value is tracked, then look up.
  if (row.state === 'RESERVED') {
    deps.driver.transaction(() => {
      const at = deps.now();
      let txn = rehydrate(row);
      txn = transitionTo(txn, 'PROCESSING', { at, reason: 'recovery: submission uncertain' });
      txn = transitionTo(txn, 'PENDING', { at, reason: 'recovery: submission uncertain' });
      persistRehydrated(deps.driver, txn, row);
      ensurePending(deps, txId, merchant, row, correlationId, policy, at);
      writeAudit(deps, {
        action: 'RECOVERY_MOVED_TO_PENDING',
        merchantId: merchant,
        correlationId,
        transactionId: txId,
        before: stateBefore,
        after: 'PENDING',
        detail: 'submission_uncertain',
      });
    });
  }

  // --- Status lookup --------------------------------------------------------
  writeAudit(deps, {
    action: 'RECOVERY_STATUS_LOOKUP',
    merchantId: merchant,
    correlationId,
    transactionId: txId,
  });

  const lookupStart = deps.now();
  let outcome: ProviderLookupOutcome;
  let providerReference = row.provider_reference ?? undefined;

  try {
    const status = await deps.provider.getStatus({
      transactionId: txId,
      providerReference,
      idempotencyKey: row.idempotency_key,
    });
    outcome = classifyStatus(status);
    providerReference = status.providerReference ?? providerReference;
  } catch (error) {
    outcome = classifyLookupFailure(error);
  }
  const lookupMs = Math.max(0, msBetween(lookupStart, deps.now()));

  writeAudit(deps, {
    action: 'RECOVERY_OUTCOME_RECEIVED',
    merchantId: merchant,
    correlationId,
    transactionId: txId,
    detail: outcome,
  });

  // --- Apply the outcome, atomically ---------------------------------------
  const result = deps.driver.transaction((): RecoveryResult => {
    const at = deps.now();
    const current = deps.driver.findTransaction(txId, merchant);
    if (!current) throw new Error('Transaction disappeared during recovery');

    // Resolved by someone else while we were waiting on the provider.
    if (current.state !== 'PROCESSING' && current.state !== 'PENDING') {
      return skip(current, 'SKIPPED_TERMINAL', correlationId);
    }

    const txn = rehydrate(current);
    const base = {
      merchantId: merchant,
      transactionId: txId,
      amount: txn.amount,
      at,
      correlationId,
      actor: RECOVERY_ACTOR,
    };

    if (outcome === 'CONFIRMED_SUCCESS') {
      const next = transitionTo(txn, 'SUCCESSFUL', {
        at,
        reason: 'recovery: provider confirmed delivery',
        providerReference,
      });
      persistRehydrated(deps.driver, next, current);
      finalizeSuccess(deps.driver, {
        ...base,
        postingId: postingId(deps.newId('post')),
        auditId: deps.newId('audit'),
      });
      deps.driver.closePendingResolution(txId, 'RESOLVED', at);
      deps.driver.recordIdempotencyResult(merchant, current.idempotency_key, 'SUCCESSFUL', at);
      writeAudit(deps, {
        action: 'RECOVERY_RECOVERED_SUCCESSFUL',
        merchantId: merchant,
        correlationId,
        transactionId: txId,
        before: current.state,
        after: 'SUCCESSFUL',
      });
      return outcomeResult(txId, merchant, 'RECOVERED_SUCCESSFUL', stateBefore, 'SUCCESSFUL', outcome, correlationId, providerReference, attemptsOf(deps, txId));
    }

    if (outcome === 'CONFIRMED_FAILURE') {
      const next = transitionTo(txn, 'FAILED', {
        at,
        reason: 'recovery: provider confirmed failure',
        providerReference,
      });
      persistRehydrated(deps.driver, next, current);
      release(deps.driver, {
        ...base,
        postingId: postingId(deps.newId('post')),
        auditId: deps.newId('audit'),
      });
      deps.driver.closePendingResolution(txId, 'RESOLVED', at);
      deps.driver.recordIdempotencyResult(merchant, current.idempotency_key, 'FAILED', at);
      writeAudit(deps, {
        action: 'RECOVERY_RECOVERED_FAILED',
        merchantId: merchant,
        correlationId,
        transactionId: txId,
        before: current.state,
        after: 'FAILED',
      });
      return outcomeResult(txId, merchant, 'RECOVERED_FAILED', stateBefore, 'FAILED', outcome, correlationId, providerReference, attemptsOf(deps, txId));
    }

    // --- Indeterminate: hold the value ---------------------------------------
    let working = txn;
    if (current.state === 'PROCESSING') {
      working = transitionTo(working, 'PENDING', { at, reason: `recovery: ${outcome}` });
      persistRehydrated(deps.driver, working, current);
    }
    ensurePending(deps, txId, merchant, current, correlationId, policy, at);
    deps.driver.recordResolutionAttempt(txId, at);

    const job = deps.driver.findPendingResolution(txId);
    const attempts = job?.attempts ?? 0;
    const pastDeadline = job !== undefined && new Date(at).getTime() >= new Date(job.deadline_at).getTime();
    const outOfAttempts = attempts >= policy.maxStatusAttempts;

    deps.driver.updatePendingMetadata(txId, {
      at,
      nextCheckAt: addMs(at, policy.statusCheckIntervalMs),
      lastOutcomeCategory: outcome,
      currentState: pastDeadline || outOfAttempts ? 'UNDER_REVIEW' : 'PENDING',
    });

    if (pastDeadline || outOfAttempts) {
      const escalated = transitionTo(working, 'UNDER_REVIEW', {
        at,
        reason: outOfAttempts ? 'recovery: status attempts exhausted' : 'recovery: pending maximum exceeded',
      });
      persistRehydrated(deps.driver, escalated, current);
      moveToUnderReview(deps.driver, {
        ...base,
        postingId: postingId(deps.newId('post')),
        auditId: deps.newId('audit'),
      });
      deps.driver.closePendingResolution(txId, 'ESCALATED', at);

      const existing = deps.driver.findSupportCaseByTransaction(txId, merchant);
      const reference = existing?.reference ?? `TG-${txId.toUpperCase()}`;
      if (!existing) {
        deps.driver.createSupportCase({
          id: deps.newId('case'),
          merchantId: merchant,
          transactionId: txId,
          reason: 'UNDER_REVIEW',
          reference,
          correlationId,
          at,
        });
        writeAudit(deps, {
          action: 'MANUAL_REVIEW_CREATED',
          merchantId: merchant,
          correlationId,
          transactionId: txId,
          detail: reference,
        });
      }
      deps.driver.updatePendingMetadata(txId, { at, manualReviewStatus: 'OPEN' });
      writeAudit(deps, {
        action: 'RECOVERY_ESCALATED_UNDER_REVIEW',
        merchantId: merchant,
        correlationId,
        transactionId: txId,
        before: current.state,
        after: 'UNDER_REVIEW',
        detail: outcome,
      });

      return {
        ...outcomeResult(txId, merchant, 'ESCALATED_UNDER_REVIEW', stateBefore, 'UNDER_REVIEW', outcome, correlationId, providerReference, attempts),
        operationalAlert: isOperationalFault(outcome),
        supportReference: reference,
      };
    }

    if (isOperationalFault(outcome)) {
      // A misconfigured platform is not a failed sale. Alert, hold, do not blame
      // the merchant.
      writeAudit(deps, {
        action: 'RECOVERY_ATTEMPT_FAILED',
        merchantId: merchant,
        correlationId,
        transactionId: txId,
        detail: outcome,
      });
      return {
        ...outcomeResult(txId, merchant, 'RECOVERY_FAILED', stateBefore, 'PENDING', outcome, correlationId, providerReference, attempts),
        operationalAlert: true,
        reasonCode: 'PROVIDER_AUTH_OR_CONFIG_FAILURE',
      };
    }

    writeAudit(deps, {
      action: 'RECOVERY_MOVED_TO_PENDING',
      merchantId: merchant,
      correlationId,
      transactionId: txId,
      before: current.state,
      after: 'PENDING',
      detail: outcome,
    });
    return outcomeResult(txId, merchant, 'MOVED_TO_PENDING', stateBefore, 'PENDING', outcome, correlationId, providerReference, attempts);
  });

  return { result, lookupMs };
}

const attemptsOf = (deps: RecoveryDeps, txId: TransactionId): number =>
  deps.driver.findPendingResolution(txId)?.attempts ?? 0;

/**
 * Create the pending row if absent. The primary key makes this idempotent.
 *
 * The pending clock starts from when the transaction **entered the in-flight
 * state**, not from when this sweep noticed it. A transaction that has been
 * stuck for an hour must not be handed a fresh grace period simply because a
 * worker only just reached it — the merchant's money has already been held for
 * that hour.
 */
function ensurePending(
  deps: RecoveryDeps,
  txId: TransactionId,
  merchant: MerchantId,
  row: TransactionRow,
  correlationId: string,
  policy: RecoveryPolicy,
  _at: string,
): void {
  const inFlightSince = row.updated_at;
  deps.driver.upsertPendingResolution({
    transactionId: txId,
    merchantId: merchant,
    idempotencyKey: row.idempotency_key,
    providerReference: row.provider_reference ?? undefined,
    correlationId,
    firstPendingAt: inFlightSince as never,
    deadlineAt: addMs(inFlightSince as never, policy.pendingMaximumMs),
  });
}

function outcomeResult(
  txId: string,
  merchant: string,
  kind: RecoveryKind,
  stateBefore: TransactionState,
  state: TransactionState,
  providerOutcome: ProviderLookupOutcome,
  correlationId: string,
  providerReference: string | undefined,
  attempts: number,
): RecoveryResult {
  return {
    transactionId: txId,
    merchantId: merchant,
    kind,
    stateBefore,
    state,
    providerOutcome,
    providerReference,
    attempts,
    correlationId,
    operationalAlert: false,
    simulated: true,
  };
}

function safeCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.name : 'UNEXPECTED_RECOVERY_ERROR';
}
