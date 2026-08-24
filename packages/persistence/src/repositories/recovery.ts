/**
 * Recovery claim leases and in-flight counts.
 *
 * The claim is the whole concurrency story. `claimTransaction` is a single
 * atomic statement: it inserts a lease, or takes over one that has been released
 * or has expired, and reports whether **this** worker won. Two workers racing
 * produce one winner and one clean refusal — never two recoveries.
 */

import type { MerchantId, TransactionId, TransactionState } from '@telga/domain';
import type { Db } from '../sqlite/connection';
import type { RecoveryClaimRow } from '../schema/types';

export interface ClaimOutcome {
  readonly claimed: boolean;
  readonly claim: RecoveryClaimRow | undefined;
  /** Set when another worker holds an unexpired lease. */
  readonly heldBy?: string;
}

/**
 * Atomically claim a transaction for recovery.
 *
 * The `WHERE` clause on the conflict branch is what makes this safe: the row is
 * only taken over when the existing lease is `RELEASED` or has expired. A live
 * lease held by another worker leaves `changes === 0`.
 */
export function claimTransaction(
  db: Db,
  input: {
    transactionId: TransactionId;
    workerId: string;
    scanId: string;
    now: string;
    expiresAt: string;
  },
): ClaimOutcome {
  const result = db
    .prepare(
      `INSERT INTO recovery_claims (
         transaction_id, worker_id, scan_id, attempt_no, claimed_at, expires_at,
         released_at, status, created_at, updated_at)
       VALUES (@transactionId, @workerId, @scanId, 1, @now, @expiresAt, NULL, 'ACTIVE', @now, @now)
       ON CONFLICT(transaction_id) DO UPDATE SET
         worker_id  = excluded.worker_id,
         scan_id    = excluded.scan_id,
         attempt_no = recovery_claims.attempt_no + 1,
         claimed_at = excluded.claimed_at,
         expires_at = excluded.expires_at,
         released_at = NULL,
         status     = 'ACTIVE',
         updated_at = excluded.updated_at
       WHERE recovery_claims.status = 'RELEASED' OR recovery_claims.expires_at <= @now`,
    )
    .run(input);

  const claim = findClaim(db, input.transactionId);
  if (result.changes === 1) {
    return { claimed: true, claim };
  }
  return { claimed: false, claim, heldBy: claim?.worker_id };
}

export function releaseClaim(
  db: Db,
  transactionId: TransactionId,
  workerId: string,
  at: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE recovery_claims SET status = 'RELEASED', released_at = ?, updated_at = ?
       WHERE transaction_id = ? AND worker_id = ? AND status = 'ACTIVE'`,
    )
    .run(at, at, transactionId, workerId);
  return result.changes === 1;
}

export function findClaim(db: Db, transactionId: TransactionId): RecoveryClaimRow | undefined {
  return db.prepare('SELECT * FROM recovery_claims WHERE transaction_id = ?').get(transactionId) as
    | RecoveryClaimRow
    | undefined;
}

/**
 * Transactions in an in-flight state older than `olderThan`.
 *
 * Ordered oldest first, so the transaction that has held a merchant's money
 * longest is dealt with first.
 */
export function findInFlightOlderThan(
  db: Db,
  states: readonly TransactionState[],
  olderThan: string,
  limit: number,
  merchantId?: MerchantId,
): readonly { id: string; merchant_id: string; state: TransactionState; updated_at: string }[] {
  const placeholders = states.map(() => '?').join(',');
  const params: unknown[] = [...states, olderThan];
  let sql = `SELECT id, merchant_id, state, updated_at FROM transactions
             WHERE state IN (${placeholders}) AND updated_at <= ?`;
  if (merchantId !== undefined) {
    sql += ' AND merchant_id = ?';
    params.push(merchantId);
  }
  sql += ' ORDER BY updated_at, id LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params) as {
    id: string;
    merchant_id: string;
    state: TransactionState;
    updated_at: string;
  }[];
}

export function countTransactionsByState(db: Db, state: TransactionState): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE state = ?').get(state) as {
    n: number;
  };
  return row.n;
}

/** The oldest transaction still holding merchant value, if any. */
export function oldestUnresolved(
  db: Db,
  states: readonly TransactionState[],
): { id: string; updated_at: string } | undefined {
  const placeholders = states.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT id, updated_at FROM transactions WHERE state IN (${placeholders})
       ORDER BY updated_at LIMIT 1`,
    )
    .get(...states) as { id: string; updated_at: string } | undefined;
}

export function countOpenManualReviews(db: Db): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM support_cases WHERE status = 'OPEN'").get() as {
    n: number;
  };
  return row.n;
}

/**
 * Release every active claim held by one worker.
 *
 * Scoped to `worker_id` on purpose: a shutting-down worker must never touch a
 * claim another worker is actively working. Claims it does not own are left to
 * expire on their own lease.
 */
export function releaseClaimsOwnedBy(db: Db, workerId: string, at: string): number {
  const result = db
    .prepare(
      `UPDATE recovery_claims SET status = 'RELEASED', released_at = ?, updated_at = ?
       WHERE worker_id = ? AND status = 'ACTIVE'`,
    )
    .run(at, at, workerId);
  return result.changes;
}

export function countActiveClaims(db: Db, workerId?: string): number {
  if (workerId === undefined) {
    const row = db.prepare("SELECT COUNT(*) AS n FROM recovery_claims WHERE status = 'ACTIVE'").get() as {
      n: number;
    };
    return row.n;
  }
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM recovery_claims WHERE status = 'ACTIVE' AND worker_id = ?")
    .get(workerId) as { n: number };
  return row.n;
}
