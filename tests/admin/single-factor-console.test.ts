/**
 * Single-factor console mode — [[Decision Log]] D143.
 *
 * The founder's instruction, 2026-09-09: an administrator who has just typed a
 * password should not be asked for a six-digit code again on every button.
 *
 * ## What these tests are defending
 *
 * A security relaxation is only safe while it is **exactly** as wide as it was
 * meant to be. Three claims have to keep holding, and each is easy to break with
 * a plausible-looking change:
 *
 *   1. **Strict is the default.** A deployment that says nothing gets a second
 *      factor and step-up. Getting this backwards would silently relax every
 *      console that has not opted in.
 *   2. **It relaxes identity, never authority.** An administrator still cannot
 *      do what their role does not grant. Merging the two is how an audit finds
 *      that "training mode" handed somebody the ability to move money.
 *   3. **It is visible.** A banner on every page. A deliberate relaxation that
 *      is invisible becomes an accidental one the moment the configuration is
 *      copied somewhere it does not belong.
 */

import { describe, expect, it } from 'vitest';
import {
  AdminAccessDeniedError,
  STRICT_ADMIN_AUTH,
  effectivePermissions,
  requireAdmin,
} from '@telga/domain';
import type { AdminAuthContext, AdminPermission, AdminUser } from '@telga/domain';

const NOW = '2026-09-09T12:00:00.000Z' as never;

const owner: AdminUser = {
  id: 'adm_1',
  email: 'owner@telga.example',
  displayName: 'Owner',
  department: 'PLATFORM',
  role: 'PLATFORM_OWNER',
  status: 'ACTIVE',
  mfaEnrolled: true,
  grants: [],
} as never;

/** Signed in with a password and nothing else, and never stepped up. */
const passwordOnly: AdminAuthContext = {
  user: owner,
  mfaSatisfied: false,
  steppedUpAt: null,
};

const SINGLE_FACTOR = { requireMfa: false, requireStepUp: false } as const;

/** A permission that demands step-up — approving a shop is the founder's case. */
const STEP_UP_ONE: AdminPermission = 'ADMIN_APPROVE_MERCHANT';
/** One that does not. */
const PLAIN_ONE: AdminPermission = 'ADMIN_VIEW_MERCHANT';

const refusal = (fn: () => void): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof AdminAccessDeniedError ? error.reason : 'UNEXPECTED';
  }
};

describe('strict is what a caller gets by default', () => {
  it('refuses a password-only session when no policy is passed at all', () => {
    // The signature gained a fourth parameter. Every existing caller passes
    // three, and must be unaffected.
    expect(refusal(() => requireAdmin(passwordOnly, PLAIN_ONE, NOW))).toBe('MFA_REQUIRED');
  });

  it('refuses it under the explicit strict policy too', () => {
    expect(refusal(() => requireAdmin(passwordOnly, PLAIN_ONE, NOW, STRICT_ADMIN_AUTH))).toBe(
      'MFA_REQUIRED',
    );
  });

  it('still demands step-up for a high-risk action after MFA is cleared', () => {
    const mfaDone: AdminAuthContext = { ...passwordOnly, mfaSatisfied: true };
    expect(refusal(() => requireAdmin(mfaDone, STEP_UP_ONE, NOW))).toBe('STEP_UP_REQUIRED');
  });

  it('cannot be relaxed by a half-filled policy object', () => {
    // `!== false`, not `=== true`. An object that mentions one field must not
    // silently switch off the other check.
    expect(refusal(() => requireAdmin(passwordOnly, PLAIN_ONE, NOW, { requireStepUp: false }))).toBe(
      'MFA_REQUIRED',
    );
  });
});

describe('single-factor lets one password reach every button', () => {
  it('allows an ordinary action with no second factor', () => {
    expect(refusal(() => requireAdmin(passwordOnly, PLAIN_ONE, NOW, SINGLE_FACTOR))).toBeUndefined();
  });

  it('allows a step-up action without re-authentication', () => {
    // This is the founder's actual complaint: approving a shop asked for a code
    // every time, and approving a shop is the whole point of the console.
    expect(
      refusal(() => requireAdmin(passwordOnly, STEP_UP_ONE, NOW, SINGLE_FACTOR)),
    ).toBeUndefined();
  });

  it('allows every step-up permission the owner holds, not just the tested one', () => {
    for (const permission of effectivePermissions(owner)) {
      expect(
        refusal(() => requireAdmin(passwordOnly, permission, NOW, SINGLE_FACTOR)),
        `${permission} must not be refused under single-factor`,
      ).toBeUndefined();
    }
  });
});

describe('single-factor relaxes identity, never authority', () => {
  it('still refuses a permission the role does not grant', () => {
    const limited: AdminUser = {
      ...owner,
      id: 'adm_2',
      role: 'SUPPORT_AGENT',
      grants: [],
    } as never;
    const context: AdminAuthContext = { user: limited, mfaSatisfied: false, steppedUpAt: null };

    // Whatever a support agent may do, approving a merchant is not it. If this
    // ever passes, the flag has stopped being about identity.
    const granted = effectivePermissions(limited);
    expect(granted).not.toContain(STEP_UP_ONE);
    expect(refusal(() => requireAdmin(context, STEP_UP_ONE, NOW, SINGLE_FACTOR))).toBe(
      'NOT_GRANTED',
    );
  });

  it('still refuses a suspended administrator', () => {
    // The account check runs before either identity check and is not a policy
    // decision. A relaxation that let a suspended admin in would be a way back
    // in for somebody who had just been removed.
    const suspended: AdminUser = { ...owner, status: 'SUSPENDED' } as never;
    const context: AdminAuthContext = { user: suspended, mfaSatisfied: false, steppedUpAt: null };
    expect(refusal(() => requireAdmin(context, PLAIN_ONE, NOW, SINGLE_FACTOR))).toBe('INACTIVE');
  });
});
