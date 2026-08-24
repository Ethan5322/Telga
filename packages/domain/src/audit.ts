/**
 * Audit events.
 *
 * Every mutation emits one: actor, role, device, merchant, action, before and
 * after state, timestamp. The log is append-only — tampering with it is a
 * security test case in `09 Engineering/Testing Strategy.md`.
 *
 * Audit records carry identity and are retained long; metrics do not and are
 * not. See `09 Engineering/Observability.md`.
 */

import { LedgerImmutableError } from './errors';
import type {
  AuditEventId,
  DeviceId,
  MerchantId,
  MerchantUserId,
  Timestamp,
  TransactionId,
} from './ids';
import type { TransactionState } from './states';

export const AUDIT_ACTIONS = [
  'TRANSACTION_CREATED',
  'TRANSACTION_TRANSITIONED',
  'BALANCE_RESERVED',
  'BALANCE_RELEASED',
  'BALANCE_UNDER_REVIEW',
  'LEDGER_POSTED',
  'RECEIPT_REPRINTED',
  'IDEMPOTENT_REPLAY',
  'PROVIDER_SUBMITTED',
  'ADJUSTMENT_POSTED',
  // Recovery sweep. Every step of an unattended recovery is auditable, because
  // nobody was watching when it happened.
  'RECOVERY_SCAN_STARTED',
  'RECOVERY_CLAIMED',
  'RECOVERY_DUPLICATE_WORKER_PREVENTED',
  'RECOVERY_STATUS_LOOKUP',
  'RECOVERY_OUTCOME_RECEIVED',
  'RECOVERY_RECOVERED_SUCCESSFUL',
  'RECOVERY_RECOVERED_FAILED',
  'RECOVERY_MOVED_TO_PENDING',
  'RECOVERY_ESCALATED_UNDER_REVIEW',
  'RECOVERY_ATTEMPT_FAILED',
  'MANUAL_REVIEW_CREATED',
  // Authentication and device binding. Every refusal is audited as well as
  // every success: a run of rejected attempts is the signal that matters.
  'AUTH_LOGIN_SUCCEEDED',
  'AUTH_LOGIN_FAILED',
  'AUTH_LOGGED_OUT',
  'AUTH_SESSION_EXPIRED',
  'AUTH_SESSION_REVOKED',
  'AUTH_LOCKED_OUT',
  'AUTH_RATE_LIMITED',
  'AUTH_ACCESS_DENIED',
  'AUTH_CSRF_REJECTED',
  'DEVICE_ENROLLED',
  'DEVICE_REVOKED',
  'DEVICE_REJECTED',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// `ActorRole` is defined beside the permission table it keys, in `auth.ts`, so a
// new role cannot be added without the table having to answer for it. It is not
// re-exported here: two `export *` modules exporting the same name would be
// ambiguous, and the index would quietly drop it.
import type { ActorRole } from './auth';

export interface AuditActor {
  readonly userId: MerchantUserId | 'system';
  readonly role: ActorRole;
  readonly deviceId?: DeviceId;
}

export interface AuditEvent {
  readonly id: AuditEventId;
  readonly at: Timestamp;
  readonly action: AuditAction;
  readonly actor: AuditActor;
  readonly merchantId: MerchantId;
  readonly transactionId?: TransactionId;
  readonly before?: TransactionState;
  readonly after?: TransactionState;
  readonly detail?: string;
}

export function createAuditEvent(input: {
  id: AuditEventId;
  at: Timestamp;
  action: AuditAction;
  actor: AuditActor;
  merchantId: MerchantId;
  transactionId?: TransactionId;
  before?: TransactionState;
  after?: TransactionState;
  detail?: string;
}): AuditEvent {
  return Object.freeze({ ...input });
}

/** Append-only audit log. Same shape of guarantee as the ledger. */
export class AuditLog {
  private readonly events: AuditEvent[] = [];

  append(event: AuditEvent): AuditEvent {
    if (this.events.some((existing) => existing.id === event.id)) {
      throw new LedgerImmutableError(`Audit event ${event.id} already exists and cannot be rewritten`);
    }
    this.events.push(event);
    return event;
  }

  all(): readonly AuditEvent[] {
    return Object.freeze([...this.events]);
  }

  forMerchant(merchant: MerchantId): readonly AuditEvent[] {
    return Object.freeze(this.events.filter((event) => event.merchantId === merchant));
  }

  forTransaction(txId: TransactionId): readonly AuditEvent[] {
    return Object.freeze(this.events.filter((event) => event.transactionId === txId));
  }

  get size(): number {
    return this.events.length;
  }
}
