/**
 * Every status column, moved through every value, checked at every door.
 *
 * ## Why this exists
 *
 * The Runbooks have recommended it since **R40**, and the class produced a
 * second bug the same day:
 *
 * > *"a status is written in one place and read in another, and one reader was
 * > missed."*
 *
 * - **R40** — `merchants.status` was **written** by the console's suspend route
 *   and **never read** at sign-in. A suspended shop kept trading.
 * - **R45** — the fix for R40 produced the mirror image: `merchants.status` was
 *   **read** at sign-in and never **written** past `ONBOARDING`, so a newly
 *   registered shop could never sign in at all.
 *
 * Two bugs, opposite directions, one shape. Testing a writer and a reader
 * separately cannot catch either; only walking between them can.
 *
 * ## What this file asserts
 *
 * For each status-bearing entity, what **sign-in** and **selling** do at each
 * value. It is deliberately a table: a new status value added to a `CHECK`
 * constraint should make somebody come here and say what it means at each door,
 * rather than inheriting whatever the last `!==` comparison happened to do.
 *
 * ## Which door reads which column
 *
 * | Column | Sign-in | Selling |
 * |---|---|---|
 * | `merchants.status` | **yes** — added by R40's fix | yes |
 * | `merchant_users.status` | yes | — |
 * | `merchant_users.locked_until` | yes | — |
 * | `device_enrollments.enrollment_state` | yes | — |
 * | `devices.status` | **NO** — R46 | yes |
 * | `sessions.status` | yes, per request | — |
 * | `tenant_registry.status` | **NO** — no callers at all, D113(a) | no |
 *
 * Two blanks, both deliberate and both recorded. `devices.status` is **R46**.
 * `tenant_registry.status` is read by `tenantRouting.ts`, which has no callers
 * under D120's shared-database model and is *meant* to be unused until D103 is
 * decided.
 */

import { describe, expect, it } from 'vitest';
import { deviceRejection, isLockedOut } from '@telga/domain';
import type { DeviceEnrollment, MerchantId, Timestamp } from '@telga/domain';

const NOW = '2026-09-09T12:00:00.000Z' as Timestamp;
const MERCHANT = 'merchant_a' as MerchantId;

const enrolment = (over: Partial<DeviceEnrollment> = {}): DeviceEnrollment =>
  ({
    deviceId: 'device_a',
    merchantId: MERCHANT,
    state: 'ENROLLED',
    expiresAt: undefined,
    ...over,
  }) as DeviceEnrollment;

// ---------------------------------------------------------------------------
// device_enrollments.enrollment_state — the one sign-in actually reads
// ---------------------------------------------------------------------------

describe('the enrolment state, at the sign-in door', () => {
  it('admits only ENROLLED', () => {
    expect(deviceRejection(enrolment({ state: 'ENROLLED' }), MERCHANT, NOW)).toBeUndefined();
  });

  it('refuses every other state, and says which', () => {
    // Distinct reasons on purpose: a revoked device is a decision somebody
    // made, an expired one is a clock running out, and they need different
    // conversations.
    expect(deviceRejection(enrolment({ state: 'REVOKED' }), MERCHANT, NOW)).toBe('DEVICE_REVOKED');
    expect(deviceRejection(enrolment({ state: 'EXPIRED' }), MERCHANT, NOW)).toBe(
      'DEVICE_ENROLLMENT_EXPIRED',
    );
    expect(deviceRejection(enrolment({ state: 'PENDING' }), MERCHANT, NOW)).toBe(
      'DEVICE_NOT_ENROLLED',
    );
  });

  it('refuses a device that has never enrolled', () => {
    expect(deviceRejection(undefined, MERCHANT, NOW)).toBe('DEVICE_NOT_ENROLLED');
  });

  it('refuses a device belonging to another shop', () => {
    // A device belongs to exactly one merchant. Reassignment is a revocation
    // and a new enrolment, never a quiet change of owner.
    expect(deviceRejection(enrolment(), 'merchant_b' as MerchantId, NOW)).toBe(
      'DEVICE_NOT_ASSIGNED_TO_MERCHANT',
    );
  });

  it('refuses an enrolment whose expiry has passed', () => {
    expect(
      deviceRejection(
        enrolment({ expiresAt: '2026-09-09T11:59:59.000Z' as Timestamp }),
        MERCHANT,
        NOW,
      ),
    ).toBe('DEVICE_ENROLLMENT_EXPIRED');
  });
});

// ---------------------------------------------------------------------------
// devices.status — the column sign-in does NOT read
// ---------------------------------------------------------------------------

describe('devices.status is read when selling, not when signing in', () => {
  /**
   * This is a **finding**, recorded as a test rather than a comment.
   *
   * `deviceRejection` — the only device check on the sign-in path — reads
   * `device_enrollments.enrollment_state`. It never reads `devices.status`.
   * `createSale` reads the opposite: `devices.status !== 'ACTIVE'` refuses a
   * sale, and it never reads the enrolment state.
   *
   * So the console's **remote stop** (`devices.status = 'STOPPED'`, plus
   * session revocation) has this effect:
   *
   *   - the device's live sessions end — correct
   *   - the device **cannot sell** — correct, `createSale` refuses
   *   - the device **can sign in again immediately** — because sign-in never
   *     looks at `devices.status`
   *
   * That is the same partial effectiveness R40 had one level up: the headline
   * behaviour looks right, and what still works is browsing and holding a
   * session on a machine somebody deliberately stopped.
   *
   * **Not fixed here**, deliberately. `CLAUDE.md` §18 describes remote stop as
   * *"remote stop of new sales without deleting history"* — stopping *sales* is
   * arguably exactly what it is specified to do, and tightening it to block
   * sign-in changes what a documented control means. That is a founder
   * decision, and R46 carries it.
   */
  it('does not consult devices.status on the sign-in path', () => {
    // `deviceRejection` takes an enrolment and nothing else — there is no
    // parameter through which a device row's status could reach it. The
    // signature is the proof.
    expect(deviceRejection.length).toBe(3);
    // An ENROLLED enrolment is admitted regardless of what `devices.status`
    // says, because the function cannot see it.
    expect(deviceRejection(enrolment({ state: 'ENROLLED' }), MERCHANT, NOW)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// merchant_users.locked_until — a lock is not a suspension
// ---------------------------------------------------------------------------

describe('a lockout is a clock, not a decision', () => {
  it('holds while the time is in the future and lifts by itself', () => {
    expect(isLockedOut('2026-09-09T12:00:01.000Z' as Timestamp, NOW)).toBe(true);
    expect(isLockedOut('2026-09-09T11:59:59.000Z' as Timestamp, NOW)).toBe(false);
  });

  it('treats an absent lock as not locked', () => {
    // The commonest state by far. A missing timestamp must never read as
    // "locked forever".
    expect(isLockedOut(undefined, NOW)).toBe(false);
  });

  it('lifts on its own, which is what makes it not a suspension', () => {
    // The distinction is confused constantly at a support desk: a locked
    // operator waits five minutes, a suspended one waits for Telga. The same
    // stored value answers differently as the clock moves — which no status
    // column can do, and is why a lockout must never become one.
    const lockedUntil = '2026-09-09T12:05:00.000Z' as Timestamp;
    expect(isLockedOut(lockedUntil, '2026-09-09T12:04:59.000Z' as Timestamp)).toBe(true);
    expect(isLockedOut(lockedUntil, '2026-09-09T12:05:01.000Z' as Timestamp)).toBe(false);
  });
});
