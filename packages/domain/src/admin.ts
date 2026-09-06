/**
 * Telga staff identity, roles and permissions.
 *
 * Deliberately separate from `auth.ts`, which models **merchant** users. The
 * two must not merge: a merchant user belongs to exactly one shop and signs in
 * with a PIN on an enrolled device; a Telga admin belongs to no shop, signs in
 * with email and password plus a second factor, and uses a laptop.
 *
 * ## Why a merchant PIN is never an admin credential
 *
 * CLAUDE.md §24 and the owner brief both refuse it. A six-digit PIN typed at a
 * counter, in front of customers, on a shared terminal, is the wrong secret to
 * protect a console that can suspend merchants and approve funding. The schema
 * enforces the separation — `admin_users` has no PIN column — and this module
 * mirrors it.
 *
 * ## Least privilege, expressed as absence
 *
 * A permission is **granted** or it is not there. There are no denials, so
 * there is never a question of which wins. A role carries a default grant set;
 * an individual admin's grants are the role's, narrowed or widened one at a
 * time by the Platform Owner, and the effective set is computed rather than
 * stored twice.
 */

import type { Timestamp } from './ids';

/** The seven administrative roles in `09 Engineering/Admin Operations Console`. */
export type AdminRole =
  /** Highest business authority. The only role that may create other admins. */
  | 'PLATFORM_OWNER'
  /** Merchants, devices, remote stop. */
  | 'OPERATIONS_ADMIN'
  /** Funding and reconciliation. */
  | 'FINANCE_VERIFIER'
  /** Support cases, and read-only merchant data. */
  | 'SUPPORT_AGENT'
  /** Reports and audit logs. Mutates nothing. */
  | 'AUDITOR'
  /** Sessions, device revocation, security controls. */
  | 'SECURITY_ADMIN'
  /** Scoped rights inside one department. */
  | 'DEPARTMENT_ADMIN';

export type AdminDepartment =
  | 'PLATFORM'
  | 'TECHNICAL'
  | 'SALES'
  | 'SUPPORT'
  | 'FINANCE'
  | 'SECURITY';

export type AdminStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';

/** Every decision the console can be asked to make. */
export const ADMIN_PERMISSIONS = [
  // --- merchants ------------------------------------------------------------
  'ADMIN_VIEW_MERCHANT',
  'ADMIN_REVIEW_APPLICATION',
  'ADMIN_APPROVE_MERCHANT',
  'ADMIN_REJECT_MERCHANT',
  'ADMIN_SUSPEND_MERCHANT',
  'ADMIN_CLOSE_MERCHANT',
  // --- devices --------------------------------------------------------------
  'ADMIN_VIEW_DEVICE',
  'ADMIN_REGISTER_DEVICE',
  'ADMIN_ISSUE_ENROLLMENT_TOKEN',
  'ADMIN_REVOKE_DEVICE',
  'ADMIN_REMOTE_STOP_SALES',
  // --- merchant users -------------------------------------------------------
  'ADMIN_VIEW_OPERATOR',
  'ADMIN_CREATE_OPERATOR',
  'ADMIN_RESET_OPERATOR_PIN',
  'ADMIN_SUSPEND_OPERATOR',
  'ADMIN_REVOKE_SESSION',
  // --- money ----------------------------------------------------------------
  'ADMIN_VIEW_TRANSACTION',
  'ADMIN_REPRINT_RECEIPT',
  'ADMIN_VIEW_STATEMENT',
  'ADMIN_EXPORT_DATA',
  'ADMIN_REVIEW_FUNDING',
  'ADMIN_APPROVE_FUNDING',
  'ADMIN_SECOND_APPROVE_FUNDING',
  'ADMIN_RECONCILE',
  // --- support --------------------------------------------------------------
  'ADMIN_VIEW_SUPPORT_CASE',
  'ADMIN_MANAGE_SUPPORT_CASE',
  // --- platform -------------------------------------------------------------
  'ADMIN_VIEW_PROVIDER_HEALTH',
  'ADMIN_VIEW_AUDIT',
  'ADMIN_CHANGE_FEATURE_FLAG',
  'ADMIN_MANAGE_ADMINS',
  'ADMIN_MANAGE_PERMISSIONS',
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

/**
 * Read-only in the strict sense: an auditor may look at anything and change
 * nothing. Named separately so the "auditor cannot mutate" test asserts
 * against a list rather than re-deriving it.
 */
const READ_ONLY: readonly AdminPermission[] = [
  'ADMIN_VIEW_MERCHANT',
  'ADMIN_VIEW_DEVICE',
  'ADMIN_VIEW_OPERATOR',
  'ADMIN_VIEW_TRANSACTION',
  'ADMIN_VIEW_STATEMENT',
  'ADMIN_VIEW_SUPPORT_CASE',
  'ADMIN_VIEW_PROVIDER_HEALTH',
  'ADMIN_VIEW_AUDIT',
];

/**
 * What each role carries by default.
 *
 * `PLATFORM_OWNER` holds everything, and is the **only** role holding
 * `ADMIN_MANAGE_ADMINS` — the owner brief says sub-admins may be created by the
 * main admin and nobody else, and this is where that is true.
 */
export const ADMIN_ROLE_PERMISSIONS: Readonly<Record<AdminRole, readonly AdminPermission[]>> =
  Object.freeze({
    PLATFORM_OWNER: Object.freeze([...ADMIN_PERMISSIONS]),

    OPERATIONS_ADMIN: Object.freeze([
      ...READ_ONLY,
      'ADMIN_REVIEW_APPLICATION',
      'ADMIN_APPROVE_MERCHANT',
      'ADMIN_REJECT_MERCHANT',
      'ADMIN_SUSPEND_MERCHANT',
      'ADMIN_REGISTER_DEVICE',
      'ADMIN_ISSUE_ENROLLMENT_TOKEN',
      'ADMIN_REVOKE_DEVICE',
      'ADMIN_REMOTE_STOP_SALES',
      'ADMIN_CREATE_OPERATOR',
      'ADMIN_RESET_OPERATOR_PIN',
      'ADMIN_SUSPEND_OPERATOR',
      'ADMIN_REPRINT_RECEIPT',
    ] as const),

    // Money, and nothing else. Deliberately holds no merchant or device
    // controls: the person who approves funding should not also be the person
    // who created the merchant it is paid to.
    FINANCE_VERIFIER: Object.freeze([
      ...READ_ONLY,
      'ADMIN_REVIEW_FUNDING',
      'ADMIN_APPROVE_FUNDING',
      'ADMIN_RECONCILE',
      'ADMIN_EXPORT_DATA',
    ] as const),

    SUPPORT_AGENT: Object.freeze([
      ...READ_ONLY,
      'ADMIN_MANAGE_SUPPORT_CASE',
      'ADMIN_REPRINT_RECEIPT',
    ] as const),

    AUDITOR: Object.freeze([...READ_ONLY] as const),

    SECURITY_ADMIN: Object.freeze([
      ...READ_ONLY,
      'ADMIN_REVOKE_DEVICE',
      'ADMIN_REVOKE_SESSION',
      'ADMIN_SUSPEND_OPERATOR',
      'ADMIN_REMOTE_STOP_SALES',
    ] as const),

    // Scoped by department at the call site; the role itself grants only
    // reading, so a department admin with no explicit grants can do nothing.
    DEPARTMENT_ADMIN: Object.freeze([...READ_ONLY] as const),
  });

/**
 * Actions that need re-authentication no matter how recent the session is.
 *
 * Each one either moves money, changes who can reach a shop, or changes what
 * the platform is allowed to do. A session that was proven twenty minutes ago
 * is not proof that the person holding the laptop now is the same person.
 */
export const STEP_UP_REQUIRED: readonly AdminPermission[] = Object.freeze([
  'ADMIN_APPROVE_MERCHANT',
  'ADMIN_SUSPEND_MERCHANT',
  'ADMIN_CLOSE_MERCHANT',
  'ADMIN_REGISTER_DEVICE',
  'ADMIN_ISSUE_ENROLLMENT_TOKEN',
  'ADMIN_REVOKE_DEVICE',
  'ADMIN_REMOTE_STOP_SALES',
  'ADMIN_RESET_OPERATOR_PIN',
  'ADMIN_APPROVE_FUNDING',
  'ADMIN_SECOND_APPROVE_FUNDING',
  'ADMIN_EXPORT_DATA',
  'ADMIN_CHANGE_FEATURE_FLAG',
  'ADMIN_MANAGE_ADMINS',
  'ADMIN_MANAGE_PERMISSIONS',
]);

/** Actions that need a **second, different** admin to approve. */
export const DUAL_CONTROL_REQUIRED: readonly AdminPermission[] = Object.freeze([
  'ADMIN_APPROVE_FUNDING',
  'ADMIN_CHANGE_FEATURE_FLAG',
]);

export interface AdminUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly department: AdminDepartment;
  readonly role: AdminRole;
  readonly status: AdminStatus;
  readonly mfaEnrolled: boolean;
  /** Individual grants layered on the role. */
  readonly grants: readonly AdminPermission[];
  readonly createdBy: string | null;
  readonly approvedBy: string | null;
}

/**
 * What this admin may actually do.
 *
 * The role's defaults plus their individual grants. A suspended, deactivated
 * or still-pending account can do **nothing** regardless of either — status is
 * checked first, so reinstating is a single field and never a permission sweep.
 */
export function effectivePermissions(user: AdminUser): readonly AdminPermission[] {
  if (user.status !== 'ACTIVE') return [];
  const set = new Set<AdminPermission>(ADMIN_ROLE_PERMISSIONS[user.role]);
  for (const grant of user.grants) set.add(grant);
  return [...set];
}

export class AdminAccessDeniedError extends Error {
  readonly code = 'ADMIN_ACCESS_DENIED';
  constructor(
    readonly permission: AdminPermission,
    readonly reason: 'NOT_GRANTED' | 'INACTIVE' | 'MFA_REQUIRED' | 'STEP_UP_REQUIRED',
  ) {
    super(`Refusing ${permission}: ${reason}.`);
    this.name = 'AdminAccessDeniedError';
  }
}

export interface AdminAuthContext {
  readonly user: AdminUser;
  /** Whether this session has cleared its second factor. */
  readonly mfaSatisfied: boolean;
  /** When step-up re-authentication last happened, if ever. */
  readonly steppedUpAt: Timestamp | null;
}

/** How long a step-up lasts before a high-risk action needs another one. */
export const STEP_UP_WINDOW_MS = 5 * 60 * 1000;

/**
 * The single authorization decision.
 *
 * Four gates, in the order that fails cheapest first: is the account usable,
 * has the second factor been cleared, is the permission held, and — for the
 * high-risk ones — was identity proven recently enough.
 *
 * Throws rather than returning false, for the same reason `requireFeature`
 * does: a caller cannot forget to check a thrown error.
 */
export function requireAdmin(
  context: AdminAuthContext,
  permission: AdminPermission,
  now: Timestamp,
): void {
  if (context.user.status !== 'ACTIVE') {
    throw new AdminAccessDeniedError(permission, 'INACTIVE');
  }
  // MFA gates everything except enrolling MFA itself, which is handled by the
  // caller: an admin must be able to sign in once in order to enrol one.
  if (!context.mfaSatisfied) {
    throw new AdminAccessDeniedError(permission, 'MFA_REQUIRED');
  }
  if (!effectivePermissions(context.user).includes(permission)) {
    throw new AdminAccessDeniedError(permission, 'NOT_GRANTED');
  }
  if (STEP_UP_REQUIRED.includes(permission)) {
    const at = context.steppedUpAt === null ? NaN : Date.parse(context.steppedUpAt);
    const elapsed = Date.parse(now) - at;
    if (!Number.isFinite(elapsed) || elapsed > STEP_UP_WINDOW_MS) {
      throw new AdminAccessDeniedError(permission, 'STEP_UP_REQUIRED');
    }
  }
}

/** True when this action needs a second, different admin to approve it. */
export const needsDualControl = (permission: AdminPermission): boolean =>
  DUAL_CONTROL_REQUIRED.includes(permission);

/**
 * Whether `approver` may be the second approver for `actor`.
 *
 * The same person twice is not dual control. Neither is an inactive second
 * approver, nor one who lacks the permission themselves.
 */
export function canSecondApprove(
  actor: AdminUser,
  approver: AdminUser,
  permission: AdminPermission,
): boolean {
  if (approver.id === actor.id) return false;
  if (approver.status !== 'ACTIVE') return false;
  return effectivePermissions(approver).includes(permission);
}
