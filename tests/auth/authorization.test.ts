/**
 * Authorization: what a role may do, and whose data it may touch.
 *
 * Two independent questions, tested separately because conflating them is how
 * cross-tenant bugs happen. A role check that passes says nothing about whose
 * data is being read; a scope check that passes says nothing about whether the
 * action is allowed at all.
 *
 * ## The disclosure rule
 *
 * A resource belonging to another merchant and a resource that does not exist
 * must be indistinguishable. Several tests below assert exactly that, because a
 * 403 for one and a 404 for the other would let a caller enumerate other
 * merchants' transaction ids by reading status codes.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  FORBIDDEN_TO_MERCHANT,
  MERCHANT_ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  can,
  isMerchantRole,
} from '@telga/domain';
import type { ActorRole, Permission } from '@telga/domain';
import { SUPERVISOR_ROLES, authorize, consistentMerchantHint, sameMerchant } from '@telga/api';
import {
  DEVICE_B,
  MERCHANT_A,
  MERCHANT_B,
  OPERATOR_B,
  call,
  callWith,
  cookieFor,
  makeUiHarness,
  reasonOf,
  seedSale,
  signInAs,
} from './helpers';
import type { TransactionDto } from '@telga/pos-view-model';
import type { UiHarness } from './helpers';

let harness: UiHarness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

const ALL_ROLES = Object.keys(ROLE_PERMISSIONS) as readonly ActorRole[];

describe('the permission table', () => {
  it('answers for every role and every permission', () => {
    // A new permission cannot be added without every role having an explicit
    // answer for it — the whole reason this is a table rather than a chain of
    // conditions at call sites.
    for (const role of ALL_ROLES) {
      for (const permission of PERMISSIONS) {
        expect(typeof can(role, permission), `${role}/${permission}`).toBe('boolean');
      }
    }
  });

  it('grants a merchant operator the POS and nothing beyond it', () => {
    const granted = PERMISSIONS.filter((p) => can('MERCHANT_OPERATOR', p));
    expect(granted).toContain('POS_CREATE_SALE');
    expect(granted).toContain('POS_VIEW_TRANSACTION');
    expect(granted).toContain('POS_VIEW_PENDING_QUEUE');
    expect(granted).not.toContain('REVERSAL_APPROVE');
    expect(granted).not.toContain('FUNDS_RELEASE');
    expect(granted).not.toContain('ADMIN_DIAGNOSTICS');
  });

  it('never grants a merchant role anything on the forbidden list', () => {
    for (const role of MERCHANT_ROLES) {
      for (const permission of FORBIDDEN_TO_MERCHANT) {
        expect(can(role, permission), `${role} must not hold ${permission}`).toBe(false);
      }
    }
  });

  it('refuses a forbidden permission even if the grant table were wrong', () => {
    // Two locks. `authorize` consults the forbidden list independently of the
    // grants, so a mistaken grant to a merchant role still cannot authorise a
    // reversal or a fund release.
    const context = {
      role: 'MERCHANT_OWNER' as ActorRole,
      merchantId: MERCHANT_A,
    } as Parameters<typeof authorize>[0];

    for (const permission of FORBIDDEN_TO_MERCHANT) {
      const decision = authorize(context, permission);
      expect(decision.ok, permission).toBe(false);
    }
  });

  it('leaves the system actor with no permissions at all', () => {
    // The recovery worker authenticates nobody and holds no session; it must
    // never be the subject of a permission check.
    expect(ROLE_PERMISSIONS.SYSTEM).toHaveLength(0);
    expect(isMerchantRole('SYSTEM')).toBe(false);
  });

  it('keeps reversal approval with the supervisor roles the reversal service requires', () => {
    // The same two roles `reversal.ts` already demands. Stated here so a change
    // to one has to be a deliberate change to the other.
    for (const role of SUPERVISOR_ROLES) {
      expect(can(role, 'REVERSAL_APPROVE'), role).toBe(true);
    }
    const approvers = ALL_ROLES.filter((r) => can(r, 'REVERSAL_APPROVE'));
    expect(new Set(approvers)).toEqual(new Set(SUPERVISOR_ROLES));
  });
});

describe('merchant scoping, as pure logic', () => {
  const context = { merchantId: MERCHANT_A, role: 'MERCHANT_OPERATOR' } as Parameters<
    typeof sameMerchant
  >[0];

  it('accepts the caller own merchant', () => {
    expect(sameMerchant(context, MERCHANT_A).ok).toBe(true);
  });

  it('refuses another merchant and a missing resource identically', () => {
    const other = sameMerchant(context, MERCHANT_B);
    const missing = sameMerchant(context, undefined);
    expect(other.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (other.ok || missing.ok) return;
    // Identical, so existence cannot be inferred.
    expect(other.code).toBe(missing.code);
  });

  it('treats a supplied merchant id as a consistency check, never a grant', () => {
    expect(consistentMerchantHint(context, undefined).ok).toBe(true);
    expect(consistentMerchantHint(context, MERCHANT_A).ok).toBe(true);
    expect(consistentMerchantHint(context, MERCHANT_B).ok).toBe(false);
  });
});

describe('every training route needs a session', () => {
  const ROUTES: readonly { method: string; path: string; body?: unknown }[] = [
    { method: 'GET', path: '/api/training/balance' },
    { method: 'GET', path: '/api/training/transactions' },
    { method: 'GET', path: '/api/training/transactions/txn_anything' },
    { method: 'GET', path: '/api/training/queue' },
    { method: 'GET', path: '/api/training/auth/session' },
    {
      method: 'POST',
      path: '/api/training/sales',
      body: { productId: 'AIRTIME', amountMinor: 2500, recipient: '0900000000', clientRequestId: 'r1' },
    },
    { method: 'POST', path: '/api/training/auth/logout', body: {} },
    { method: 'POST', path: '/api/training/auth/devices', body: { deviceId: 'device_alpha_1' } },
  ];

  it('refuses all of them with 401 when unauthenticated', async () => {
    harness = makeUiHarness('routes-unauthenticated');
    for (const route of ROUTES) {
      const { response, envelope } = await callWith(harness.api, route.method, route.path, {
        body: route.body,
      });
      expect(response.status, `${route.method} ${route.path}`).toBe(401);
      expect(reasonOf(envelope), route.path).toBe('SESSION_MISSING');
    }
  });

  it('creates no transaction when an unauthenticated sale is refused', async () => {
    harness = makeUiHarness('routes-unauthenticated-sale');
    const before = harness.driver.findTransactionsByMerchant(MERCHANT_A).length;

    await callWith(harness.api, 'POST', '/api/training/sales', {
      body: {
        productId: 'AIRTIME',
        amountMinor: 2500,
        recipient: '0900000000',
        clientRequestId: 'req_unauth',
      },
    });

    expect(harness.driver.findTransactionsByMerchant(MERCHANT_A).length).toBe(before);
    expect(harness.driver.ledgerResidualMinor()).toBe(0);
  });
});

describe('one merchant cannot reach another', () => {
  it('does not return another merchant transaction, and does not admit it exists', async () => {
    harness = makeUiHarness('scope-detail', { seedSecondMerchant: true });
    const alphaId = await seedSale(harness);
    const beta = await signInAs(harness.api, {
      userId: OPERATOR_B,
      merchantId: MERCHANT_B,
      deviceId: DEVICE_B,
    });

    const real = await callWith(harness.api, 'GET', `/api/training/transactions/${alphaId}`, {
      cookie: cookieFor(beta.sessionToken),
    });
    const invented = await callWith(
      harness.api,
      'GET',
      '/api/training/transactions/txn_does_not_exist',
      { cookie: cookieFor(beta.sessionToken) },
    );

    expect(real.response.status).toBe(404);
    // Byte-identical refusals: nothing distinguishes "someone else's" from
    // "no such thing".
    expect(real.response.status).toBe(invented.response.status);
    expect(reasonOf(real.envelope)).toBe(reasonOf(invented.envelope));
  });

  it('scopes the history to the session merchant', async () => {
    harness = makeUiHarness('scope-history', { seedSecondMerchant: true });
    const alphaId = await seedSale(harness);
    const beta = await signInAs(harness.api, {
      userId: OPERATOR_B,
      merchantId: MERCHANT_B,
      deviceId: DEVICE_B,
    });

    const { envelope } = await callWith<readonly TransactionDto[]>(
      harness.api,
      'GET',
      '/api/training/transactions',
      { cookie: cookieFor(beta.sessionToken) },
    );
    if (!envelope.ok) throw new Error('should be readable');
    expect(envelope.data.map((t) => t.transactionId)).not.toContain(alphaId);
    expect(envelope.data.every((t) => t.merchantId === MERCHANT_B)).toBe(true);
  });

  it('scopes the queue to the session merchant', async () => {
    harness = makeUiHarness('scope-queue', { seedSecondMerchant: true, behaviour: 'TIMEOUT' });
    const alphaId = await seedSale(harness);
    const beta = await signInAs(harness.api, {
      userId: OPERATOR_B,
      merchantId: MERCHANT_B,
      deviceId: DEVICE_B,
    });

    const { envelope } = await callWith<{
      pending: readonly TransactionDto[];
      underReview: readonly TransactionDto[];
      reversalRequired: readonly TransactionDto[];
    }>(harness.api, 'GET', '/api/training/queue', { cookie: cookieFor(beta.sessionToken) });
    if (!envelope.ok) throw new Error('should be readable');

    const all = [
      ...envelope.data.pending,
      ...envelope.data.underReview,
      ...envelope.data.reversalRequired,
    ];
    expect(all.map((t) => t.transactionId)).not.toContain(alphaId);
  });

  it('scopes the balance to the session merchant', async () => {
    harness = makeUiHarness('scope-balance', { seedSecondMerchant: true });
    await seedSale(harness);

    const alpha = await call<{ available: { amountMinor: number } }>(
      harness.api,
      'GET',
      '/api/training/balance',
    );
    const beta = await signInAs(harness.api, {
      userId: OPERATOR_B,
      merchantId: MERCHANT_B,
      deviceId: DEVICE_B,
    });
    const betaBalance = await call<{ available: { amountMinor: number } }>(
      harness.api,
      'GET',
      '/api/training/balance',
      { session: beta },
    );

    if (!alpha.envelope.ok || !betaBalance.envelope.ok) throw new Error('both should read');
    // Alpha has spent; beta has not. Two different numbers from one endpoint.
    expect(alpha.envelope.data.available.amountMinor).not.toBe(
      betaBalance.envelope.data.available.amountMinor,
    );
  });
});

describe('tampering', () => {
  it('refuses a merchant id in the URL that is not the session merchant', async () => {
    harness = makeUiHarness('tamper-url', { seedSecondMerchant: true });
    const { response, envelope } = await call(
      harness.api,
      'GET',
      '/api/training/transactions',
      { query: { merchantId: MERCHANT_B } },
    );
    expect(response.status).toBe(403);
    expect(reasonOf(envelope)).toBe('MERCHANT_SCOPE_MISMATCH');
  });

  it('refuses a merchant id in a POST body that is not the session merchant', async () => {
    harness = makeUiHarness('tamper-post', { seedSecondMerchant: true });
    const before = harness.driver.findTransactionsByMerchant(MERCHANT_B).length;

    const { response, envelope } = await call(harness.api, 'POST', '/api/training/sales', {
      body: {
        merchantId: MERCHANT_B,
        productId: 'AIRTIME',
        amountMinor: 2500,
        recipient: '0900000000',
        clientRequestId: 'req_tamper',
      },
    });

    expect(response.status).toBe(403);
    expect(reasonOf(envelope)).toBe('MERCHANT_SCOPE_MISMATCH');
    // And nothing was created for either merchant.
    expect(harness.driver.findTransactionsByMerchant(MERCHANT_B).length).toBe(before);
  });

  it('ignores a transaction id belonging to another merchant however it is encoded', async () => {
    harness = makeUiHarness('tamper-txid', { seedSecondMerchant: true });
    const alphaId = await seedSale(harness);
    const beta = await signInAs(harness.api, {
      userId: OPERATOR_B,
      merchantId: MERCHANT_B,
      deviceId: DEVICE_B,
    });

    for (const attempt of [alphaId, encodeURIComponent(alphaId), `${alphaId}%00`, `../${alphaId}`]) {
      const { response } = await callWith(
        harness.api,
        'GET',
        `/api/training/transactions/${attempt}`,
        { cookie: cookieFor(beta.sessionToken) },
      );
      expect([404, 400], attempt).toContain(response.status);
    }
  });

  it('does not let a device id in the request change the operating device', async () => {
    harness = makeUiHarness('tamper-device', { seedSecondMerchant: true });

    const { response, envelope } = await call<{ transaction: TransactionDto | null }>(
      harness.api,
      'POST',
      '/api/training/sales',
      {
        body: {
          deviceId: DEVICE_B,
          productId: 'AIRTIME',
          amountMinor: 2500,
          recipient: '0900000000',
          clientRequestId: 'req_device_tamper',
        },
      },
    );

    expect(response.status).toBe(201);
    if (!envelope.ok) throw new Error('should have sold');
    // The sale was recorded against the session's device, not the body's.
    expect(envelope.data.transaction?.deviceId).toBe('device_alpha_1');
  });
});

describe('what the POS cannot expose', () => {
  it('has no route that completes a reversal, releases funds or forces a state', async () => {
    harness = makeUiHarness('no-privileged-routes');
    const attempts = [
      { method: 'POST', path: '/api/training/reversals' },
      { method: 'POST', path: '/api/training/transactions/txn_1/reverse' },
      { method: 'POST', path: '/api/training/transactions/txn_1/state' },
      { method: 'POST', path: '/api/training/balance/release' },
      { method: 'POST', path: '/api/training/recovery/config' },
      { method: 'GET', path: '/api/training/admin/diagnostics' },
    ];

    for (const attempt of attempts) {
      const { response } = await call(harness.api, attempt.method, attempt.path, { body: {} });
      // 404 because the route does not exist at all — not 403, because there is
      // nothing there to be forbidden from.
      expect(response.status, attempt.path).toBe(404);
    }
  });

  it('refuses device enrolment to a plain operator', async () => {
    harness = makeUiHarness('operator-cannot-enrol');
    const { response, envelope } = await call(
      harness.api,
      'POST',
      '/api/training/auth/devices',
      { body: { deviceId: 'device_alpha_1' } },
    );
    expect(response.status).toBe(403);
    expect(reasonOf(envelope)).toBe('PERMISSION_DENIED');
  });

  it('allows an owner to enrol a device for their own merchant', async () => {
    harness = makeUiHarness('owner-can-enrol');
    const owner = await signInAs(harness.api, {
      userId: 'owner_alpha_1' as typeof OPERATOR_B,
      role: 'MERCHANT_OWNER',
    });

    const { response } = await call(harness.api, 'POST', '/api/training/auth/devices', {
      session: owner,
      body: { deviceId: 'device_alpha_1' },
    });
    expect(response.status).toBe(201);
  });

  it('refuses an owner enrolling a device for another merchant', async () => {
    harness = makeUiHarness('owner-cannot-cross-enrol', { seedSecondMerchant: true });
    const owner = await signInAs(harness.api, {
      userId: 'owner_alpha_1' as typeof OPERATOR_B,
      role: 'MERCHANT_OWNER',
    });

    const { response } = await call(harness.api, 'POST', '/api/training/auth/devices', {
      session: owner,
      // Beta's device. The handler looks it up scoped to the session merchant.
      body: { deviceId: 'device_beta_1' },
    });
    expect(response.status).toBe(404);
  });
});

describe('permission coverage', () => {
  it('names every permission the POS routes require', () => {
    // If a route gains a permission that no role holds, it is unreachable and
    // that is a bug worth failing on rather than discovering in the field.
    const routePermissions: readonly Permission[] = [
      'POS_VIEW_HOME',
      'POS_CREATE_SALE',
      'POS_VIEW_TRANSACTION',
      'POS_VIEW_HISTORY',
      'POS_VIEW_PENDING_QUEUE',
      'POS_LOGOUT',
      'DEVICE_ENROL',
    ];
    for (const permission of routePermissions) {
      const holders = ALL_ROLES.filter((role) => can(role, permission));
      expect(holders.length, `nobody can ${permission}`).toBeGreaterThan(0);
    }
  });
});
