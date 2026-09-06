/**
 * Telga staff authorization.
 *
 * The owner brief §12 names the refusals that matter, and these are them:
 * an operator cannot reach the console, a support agent cannot approve
 * funding, a read-only auditor cannot mutate, and an admin cannot bypass dual
 * approval.
 *
 * Every test here is about **saying no**. A permission model is only worth
 * anything for the calls it rejects, so the grants are checked mostly to prove
 * the rejections are not vacuous.
 */

import { describe, expect, it } from 'vitest';
import {
  ADMIN_PERMISSIONS,
  ADMIN_ROLE_PERMISSIONS,
  AdminAccessDeniedError,
  DUAL_CONTROL_REQUIRED,
  STEP_UP_REQUIRED,
  STEP_UP_WINDOW_MS,
  canSecondApprove,
  effectivePermissions,
  needsDualControl,
  requireAdmin,
} from '@telga/domain';
import type { AdminPermission, AdminRole, AdminUser, Timestamp } from '@telga/domain';

const NOW = '2026-08-30T12:00:00.000Z' as Timestamp;
const at = (iso: string): Timestamp => iso as Timestamp;

function admin(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: 'adm_1',
    email: 'ops@telga.example',
    displayName: 'Ops One',
    department: 'PLATFORM',
    role: 'OPERATIONS_ADMIN',
    status: 'ACTIVE',
    mfaEnrolled: true,
    grants: [],
    createdBy: 'adm_owner',
    approvedBy: 'adm_owner',
    ...overrides,
  };
}

/** A context that clears every gate but the permission itself. */
const ready = (user: AdminUser) => ({
  user,
  mfaSatisfied: true,
  steppedUpAt: at('2026-08-30T11:59:00.000Z'),
});

describe('who may create administrators', () => {
  it('gives ADMIN_MANAGE_ADMINS to the Platform Owner and to nobody else', () => {
    // The owner brief is explicit: sub-admins may be created by the main Telga
    // admin only. This is the line that makes that true.
    const holders = (Object.keys(ADMIN_ROLE_PERMISSIONS) as AdminRole[]).filter((role) =>
      ADMIN_ROLE_PERMISSIONS[role].includes('ADMIN_MANAGE_ADMINS'),
    );
    expect(holders).toEqual(['PLATFORM_OWNER']);
  });

  it('refuses an operations admin who tries to create one', () => {
    expect(() => requireAdmin(ready(admin()), 'ADMIN_MANAGE_ADMINS', NOW)).toThrow(
      AdminAccessDeniedError,
    );
  });
});

describe('the auditor mutates nothing', () => {
  it('holds only view permissions', () => {
    const granted = ADMIN_ROLE_PERMISSIONS.AUDITOR;
    const mutating = granted.filter((p) => !p.startsWith('ADMIN_VIEW_'));
    expect(mutating, `auditor may mutate: ${mutating.join(', ')}`).toEqual([]);
  });

  it('is refused every mutating permission there is', () => {
    const auditor = ready(admin({ role: 'AUDITOR' }));
    const mutations = ADMIN_PERMISSIONS.filter((p) => !p.startsWith('ADMIN_VIEW_'));
    expect(mutations.length).toBeGreaterThan(10);
    for (const permission of mutations) {
      expect(() => requireAdmin(auditor, permission, NOW), permission).toThrow(
        AdminAccessDeniedError,
      );
    }
  });
});

describe('separation of duties', () => {
  it('does not let a support agent approve funding', () => {
    expect(() =>
      requireAdmin(ready(admin({ role: 'SUPPORT_AGENT' })), 'ADMIN_APPROVE_FUNDING', NOW),
    ).toThrow(AdminAccessDeniedError);
  });

  it('does not let the finance verifier create merchants or devices', () => {
    // The person who approves money into a shop should not be the person who
    // created the shop.
    const finance = ready(admin({ role: 'FINANCE_VERIFIER' }));
    for (const permission of [
      'ADMIN_APPROVE_MERCHANT',
      'ADMIN_REGISTER_DEVICE',
      'ADMIN_ISSUE_ENROLLMENT_TOKEN',
    ] as AdminPermission[]) {
      expect(() => requireAdmin(finance, permission, NOW), permission).toThrow(
        AdminAccessDeniedError,
      );
    }
  });

  it('does not let operations approve funding', () => {
    expect(() => requireAdmin(ready(admin()), 'ADMIN_APPROVE_FUNDING', NOW)).toThrow(
      AdminAccessDeniedError,
    );
  });
});

describe('an account that is not active', () => {
  it('can do nothing, whatever its role says', () => {
    // Suspension is one field. If it were a permission sweep, reinstating
    // would have to restore a set — and a missed grant is a silent loss.
    for (const status of ['PENDING', 'SUSPENDED', 'DEACTIVATED'] as const) {
      const user = admin({ role: 'PLATFORM_OWNER', status });
      expect(effectivePermissions(user), status).toEqual([]);
      expect(() => requireAdmin(ready(user), 'ADMIN_VIEW_MERCHANT', NOW), status).toThrow(
        /INACTIVE/,
      );
    }
  });
});

describe('the second factor', () => {
  it('gates everything, even reading', () => {
    const context = { ...ready(admin()), mfaSatisfied: false };
    expect(() => requireAdmin(context, 'ADMIN_VIEW_MERCHANT', NOW)).toThrow(/MFA_REQUIRED/);
  });

  it('is checked before the permission, so a refusal says which gate failed', () => {
    // An operator told "not granted" when the real problem is a missing second
    // factor goes looking for the wrong thing.
    const context = { ...ready(admin({ role: 'AUDITOR' })), mfaSatisfied: false };
    try {
      requireAdmin(context, 'ADMIN_APPROVE_FUNDING', NOW);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as AdminAccessDeniedError).reason).toBe('MFA_REQUIRED');
    }
  });
});

describe('step-up re-authentication', () => {
  it('is required for every action that moves money or changes access', () => {
    for (const permission of [
      'ADMIN_APPROVE_FUNDING',
      'ADMIN_RESET_OPERATOR_PIN',
      'ADMIN_REVOKE_DEVICE',
      'ADMIN_CHANGE_FEATURE_FLAG',
      'ADMIN_EXPORT_DATA',
      'ADMIN_MANAGE_ADMINS',
    ] as AdminPermission[]) {
      expect(STEP_UP_REQUIRED, permission).toContain(permission);
    }
  });

  it('refuses a privileged action when identity was never re-proven', () => {
    const owner = { ...ready(admin({ role: 'PLATFORM_OWNER' })), steppedUpAt: null };
    expect(() => requireAdmin(owner, 'ADMIN_APPROVE_FUNDING', NOW)).toThrow(/STEP_UP_REQUIRED/);
  });

  it('refuses once the step-up has aged out', () => {
    const stale = Date.parse(NOW) - STEP_UP_WINDOW_MS - 1000;
    const owner = {
      ...ready(admin({ role: 'PLATFORM_OWNER' })),
      steppedUpAt: at(new Date(stale).toISOString()),
    };
    expect(() => requireAdmin(owner, 'ADMIN_APPROVE_FUNDING', NOW)).toThrow(/STEP_UP_REQUIRED/);
  });

  it('allows it inside the window', () => {
    const fresh = Date.parse(NOW) - 60_000;
    const owner = {
      ...ready(admin({ role: 'PLATFORM_OWNER' })),
      steppedUpAt: at(new Date(fresh).toISOString()),
    };
    expect(() => requireAdmin(owner, 'ADMIN_APPROVE_FUNDING', NOW)).not.toThrow();
  });

  it('does not demand a step-up merely to read', () => {
    // If reading needed one, an admin would re-authenticate constantly and
    // learn to type the password without thinking, which is the opposite of
    // what a step-up is for.
    const owner = { ...ready(admin({ role: 'PLATFORM_OWNER' })), steppedUpAt: null };
    expect(() => requireAdmin(owner, 'ADMIN_VIEW_MERCHANT', NOW)).not.toThrow();
  });
});

describe('dual control', () => {
  it('covers funding approval and feature-flag changes', () => {
    expect(needsDualControl('ADMIN_APPROVE_FUNDING')).toBe(true);
    expect(needsDualControl('ADMIN_CHANGE_FEATURE_FLAG')).toBe(true);
    expect(needsDualControl('ADMIN_VIEW_MERCHANT')).toBe(false);
    expect(DUAL_CONTROL_REQUIRED).toHaveLength(2);
  });

  it('refuses the same person as their own second approver', () => {
    // The whole point. One person pressing a button twice is not two people.
    const owner = admin({ id: 'adm_owner', role: 'PLATFORM_OWNER' });
    expect(canSecondApprove(owner, owner, 'ADMIN_APPROVE_FUNDING')).toBe(false);
  });

  it('refuses a second approver who lacks the permission', () => {
    const finance = admin({ id: 'adm_fin', role: 'FINANCE_VERIFIER' });
    const support = admin({ id: 'adm_sup', role: 'SUPPORT_AGENT' });
    expect(canSecondApprove(finance, support, 'ADMIN_APPROVE_FUNDING')).toBe(false);
  });

  it('refuses a suspended second approver', () => {
    const a = admin({ id: 'adm_a', role: 'FINANCE_VERIFIER' });
    const b = admin({ id: 'adm_b', role: 'FINANCE_VERIFIER', status: 'SUSPENDED' });
    expect(canSecondApprove(a, b, 'ADMIN_APPROVE_FUNDING')).toBe(false);
  });

  it('accepts a different, active, permitted approver', () => {
    const a = admin({ id: 'adm_a', role: 'FINANCE_VERIFIER' });
    const b = admin({ id: 'adm_b', role: 'FINANCE_VERIFIER' });
    expect(canSecondApprove(a, b, 'ADMIN_APPROVE_FUNDING')).toBe(true);
  });
});

describe('individual grants', () => {
  it('widen a role without changing the role', () => {
    // A sub-admin's rights are toggled one at a time, so they cannot live in
    // the role alone.
    const scoped = admin({ role: 'DEPARTMENT_ADMIN', grants: ['ADMIN_REGISTER_DEVICE'] });
    expect(effectivePermissions(scoped)).toContain('ADMIN_REGISTER_DEVICE');
    // And the role itself is untouched for everyone else.
    expect(ADMIN_ROLE_PERMISSIONS.DEPARTMENT_ADMIN).not.toContain('ADMIN_REGISTER_DEVICE');
  });

  it('cannot rescue a suspended account', () => {
    const suspended = admin({
      role: 'DEPARTMENT_ADMIN',
      status: 'SUSPENDED',
      grants: [...ADMIN_PERMISSIONS],
    });
    expect(effectivePermissions(suspended)).toEqual([]);
  });

  it('does not duplicate a permission the role already carries', () => {
    const owner = admin({ role: 'PLATFORM_OWNER', grants: ['ADMIN_VIEW_MERCHANT'] });
    const seen = effectivePermissions(owner).filter((p) => p === 'ADMIN_VIEW_MERCHANT');
    expect(seen).toHaveLength(1);
  });
});
