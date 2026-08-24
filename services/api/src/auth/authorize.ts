/**
 * Authorization decisions, as typed values.
 *
 * Two separate questions, deliberately separate functions:
 *
 *   `authorize`    — may this **role** do this thing at all?
 *   `sameMerchant` — is this **resource** inside the caller's own merchant?
 *
 * Conflating them is how cross-tenant bugs happen: a role check that passes
 * says nothing about whose data is being read, and a scope check that passes
 * says nothing about whether the action is permitted.
 *
 * ## Resource existence is not disclosed
 *
 * `scopeFailure` is the same value whether the transaction belongs to another
 * merchant or does not exist at all. A handler that turned one into a 403 and
 * the other into a 404 would let a caller enumerate other merchants' ids by
 * reading status codes.
 */

import { can, isMerchantRole, FORBIDDEN_TO_MERCHANT } from '@telga/domain';
import type { MerchantId, Permission } from '@telga/domain';
import type { AuthContext, AuthFailure } from './context';
import { failure } from './context';

export interface Allowed {
  readonly ok: true;
}

export type Decision = Allowed | AuthFailure;

const ALLOWED: Allowed = Object.freeze({ ok: true });

/**
 * May this caller perform `permission`?
 *
 * Two checks, not one. The grant table decides, and then the merchant-forbidden
 * list is consulted independently — so a mistaken grant to a merchant role
 * still cannot authorise a reversal or a fund release.
 */
export function authorize(context: AuthContext, permission: Permission): Decision {
  if (isMerchantRole(context.role) && FORBIDDEN_TO_MERCHANT.includes(permission)) {
    return failure('PERMISSION_DENIED');
  }
  if (!can(context.role, permission)) return failure('PERMISSION_DENIED');
  return ALLOWED;
}

export const isAllowed = (decision: Decision): decision is Allowed => decision.ok;

/**
 * Is `resourceMerchantId` the caller's own merchant?
 *
 * `undefined` — a resource that does not exist — is refused with the same code
 * as a resource belonging to somebody else. See the header.
 */
export function sameMerchant(
  context: AuthContext,
  resourceMerchantId: MerchantId | string | undefined,
): Decision {
  if (resourceMerchantId === undefined) return failure('MERCHANT_SCOPE_MISMATCH');
  if (resourceMerchantId !== context.merchantId) return failure('MERCHANT_SCOPE_MISMATCH');
  return ALLOWED;
}

/**
 * Check a client-supplied merchant id for **consistency only**.
 *
 * A merchant id in a URL or a form is a hint that helps catch a stale bookmark
 * or a mis-shared link. It never authorises anything: the session is the
 * authority, and this returns a refusal when the two disagree rather than
 * quietly preferring either one.
 */
export function consistentMerchantHint(
  context: AuthContext,
  supplied: string | undefined,
): Decision {
  if (supplied === undefined || supplied.length === 0) return ALLOWED;
  if (supplied !== context.merchantId) return failure('MERCHANT_SCOPE_MISMATCH');
  return ALLOWED;
}

/** Every permission the current caller holds. For rendering, never for deciding. */
export function grantedTo(context: AuthContext, permissions: readonly Permission[]): readonly Permission[] {
  return permissions.filter((permission) => isAllowed(authorize(context, permission)));
}
