/**
 * Row shapes and persistence-level vocabulary.
 *
 * Rows are the *storage* form: flat, string and integer only, no `Money`, no
 * branded ids. Repositories convert between these and domain types, so nothing
 * outside this package ever handles a raw row.
 */

import type {
  ActorRole,
  DeviceEnrollmentState,
  SessionStatus,
  EntryDirection,
  EntryReason,
  LedgerAccountKind,
  OperatingMode,
  TransactionState,
} from '@telga/domain';

export type MerchantStatus = 'ONBOARDING' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
export type DeviceStatus = 'REGISTERED' | 'ACTIVE' | 'STOPPED' | 'LOST';
export type DeviceType = 'ANDROID_PHONE' | 'SMART_POS' | 'WEB_POS';
export type ReservationStatus = 'HELD' | 'UNDER_REVIEW' | 'RELEASED' | 'SETTLED';

/**
 * Account types recognised by the database.
 *
 * The three merchant buckets — `MERCHANT_AVAILABLE`, `MERCHANT_RESERVED`,
 * `MERCHANT_UNDER_REVIEW` — are how the four balance views become *postings*
 * rather than derived figures: moving value from available to reserved is a
 * balanced pair of entries, and is therefore auditable.
 *
 * `BANK_CLEARING` is bookkeeping only and never appears in a merchant balance.
 */
export type AccountType = LedgerAccountKind;

/** Account kinds that make up a merchant-facing balance. */
export const MERCHANT_FACING_ACCOUNTS: readonly AccountType[] = [
  'MERCHANT_AVAILABLE',
  'MERCHANT_RESERVED',
  'MERCHANT_UNDER_REVIEW',
  'MERCHANT_FUNDS',
];

export interface MerchantRow {
  id: string;
  status: MerchantStatus;
  mode: OperatingMode;
  created_at: string;
  updated_at: string;
}

export interface DeviceRow {
  id: string;
  merchant_id: string;
  status: DeviceStatus;
  device_type: DeviceType;
  created_at: string;
  updated_at: string;
}

export interface TransactionRow {
  id: string;
  merchant_id: string;
  device_id: string;
  operator_id: string | null;
  product_type: string;
  provider_id: string | null;
  amount_minor: number;
  currency: string;
  /** Never the full recipient number. */
  recipient_masked: string;
  recipient_hash: string;
  state: TransactionState;
  idempotency_key: string;
  payload_fingerprint: string;
  provider_reference: string | null;
  mode: OperatingMode;
  created_at: string;
  updated_at: string;
}

export interface IdempotencyRow {
  key: string;
  merchant_id: string;
  request_identity: string;
  payload_fingerprint: string;
  transaction_id: string;
  result_state: TransactionState | null;
  created_at: string;
  updated_at: string;
}

export interface LedgerAccountRow {
  id: string;
  merchant_id: string | null;
  account_type: AccountType;
  currency: string;
  created_at: string;
}

export interface LedgerEntryRow {
  id: string;
  posting_id: string;
  transaction_id: string | null;
  account_id: string;
  merchant_id: string | null;
  account_type: AccountType;
  direction: EntryDirection;
  amount_minor: number;
  currency: string;
  entry_type: EntryReason;
  correlation_id: string;
  rule_version: string | null;
  provider_reference: string | null;
  metadata: string | null;
  mode: OperatingMode;
  created_at: string;
}

export interface ReservationRow {
  id: string;
  merchant_id: string;
  transaction_id: string;
  amount_minor: number;
  currency: string;
  status: ReservationStatus;
  correlation_id: string;
  created_at: string;
  updated_at: string;
  released_at: string | null;
}

export interface AuditEventRow {
  id: string;
  actor_type: string;
  actor_id: string;
  event_type: string;
  entity_type: string;
  entity_id: string | null;
  merchant_id: string | null;
  correlation_id: string;
  metadata: string | null;
  created_at: string;
}

export interface MigrationRow {
  version: string;
  name: string;
  checksum: string;
  applied_at: string;
}

export type PendingStatus = 'AWAITING' | 'RESOLVED' | 'ESCALATED';

export interface PendingResolutionRow {
  transaction_id: string;
  merchant_id: string;
  idempotency_key: string;
  provider_reference: string | null;
  correlation_id: string;
  attempts: number;
  status: PendingStatus;
  first_pending_at: string;
  last_attempt_at: string | null;
  deadline_at: string;
  created_at: string;
  updated_at: string;
  /** When the next status lookup is due. */
  next_check_at: string | null;
  /** Safe category only — never a raw provider body. */
  last_outcome_category: string | null;
  current_state: string | null;
  manual_review_status: string;
}

export type RecoveryClaimStatus = 'ACTIVE' | 'RELEASED';

export interface RecoveryClaimRow {
  transaction_id: string;
  worker_id: string;
  scan_id: string;
  attempt_no: number;
  claimed_at: string;
  expires_at: string;
  released_at: string | null;
  status: RecoveryClaimStatus;
  created_at: string;
  updated_at: string;
}

// --- authentication, sessions and device enrolment -------------------------

export type MerchantUserStatus = 'ACTIVE' | 'SUSPENDED';

/** No raw PIN is representable. Only the derived key, its salt and its parameters. */
export interface MerchantUserRow {
  id: string;
  merchant_id: string;
  display_name: string;
  role: ActorRole;
  pin_hash: string;
  pin_salt: string;
  /** e.g. `scrypt$N=16384,r=8,p=1,len=64`. Recorded so a rehash can be detected. */
  pin_params: string;
  status: MerchantUserStatus;
  failed_attempts: number;
  locked_until: string | null;
  last_login_at: string | null;
  mode: OperatingMode;
  created_at: string;
  updated_at: string;
}

export interface DeviceEnrollmentRow {
  device_id: string;
  merchant_id: string;
  enrollment_state: DeviceEnrollmentState;
  display_name: string | null;
  secret_hash: string;
  secret_salt: string;
  enrolled_at: string;
  last_seen_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** `id` is a SHA-256 of the session token; the token is never stored. */
export interface SessionRow {
  id: string;
  user_id: string;
  merchant_id: string;
  device_id: string;
  role: ActorRole;
  csrf_hash: string;
  status: SessionStatus;
  created_at: string;
  last_seen_at: string;
  idle_expires_at: string;
  absolute_expires_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
}

export type AttemptScope = 'LOGIN' | 'SALE';

export interface AuthAttemptRow {
  id: number;
  scope: AttemptScope;
  subject: string;
  outcome: 'SUCCESS' | 'FAILURE';
  created_at: string;
}

export type SupportCaseReason =
  | 'UNDER_REVIEW'
  | 'REVERSAL_REQUIRED'
  | 'MERCHANT_REPORTED'
  | 'PROVIDER_DISPUTE';

export type SupportCaseStatus = 'OPEN' | 'AWAITING_PROVIDER' | 'RESOLVED' | 'CLOSED';

export interface SupportCaseRow {
  id: string;
  merchant_id: string;
  transaction_id: string | null;
  reason: SupportCaseReason;
  status: SupportCaseStatus;
  reference: string;
  correlation_id: string;
  created_at: string;
  updated_at: string;
  /** Supervisor who authorized a refund, reversal or exceptional balance action. */
  approved_by: string | null;
  approved_at: string | null;
}
