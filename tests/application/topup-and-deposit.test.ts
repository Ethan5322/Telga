/**
 * Direct top-up, and the Telga Pay training deposit.
 *
 * The two additions that touch money in Priority 3. A top-up is an ordinary
 * sale that happens to carry a phone number; a deposit is the one path in the
 * build that *adds* value to a merchant float. Both are pinned here for what
 * they refuse as much as for what they do.
 */

import { describe, expect, it } from 'vitest';
import {
  MERCHANT_A,
  OWNER_USER,
  TEST_PIN,
  callWith,
  makeUiHarness,
  signInAs,
} from '../auth/helpers';
import { TRAINING_DEPOSIT_LIMITS } from '@telga/api';

interface OrderDto {
  readonly orderId: string;
  readonly productType: string;
  readonly amountMinor: number;
  readonly profitMinor: number;
  readonly recipientMasked: string | null;
}

interface DepositDto {
  readonly depositId: string;
  readonly amountMinor: number;
  readonly method: string;
  readonly availableAfterMinor: number;
}

const asOwner = (api: Parameters<typeof signInAs>[0]) =>
  signInAs(api, { userId: OWNER_USER, role: 'MERCHANT_OWNER', pin: TEST_PIN });

let requestCounter = 0;
const nextRequestId = (): string => `req_test_${String((requestCounter += 1))}`;

describe('creating a top-up order', () => {
  it('accepts a phone number and stores it masked, never in full', async () => {
    const h = makeUiHarness('topup-create');
    const session = await signInAs(h.api);

    const { response, envelope } = await callWith<OrderDto>(h.api, 'POST', '/api/training/orders', {
      cookie: session.cookieHeader,
      body: {
        csrfToken: session.csrfToken,
        network: 'NETWORK_A',
        productType: 'TOPUP',
        productId: 'NETWORK_A_TOPUP_2500',
        recipient: '0912345678',
        clientRequestId: nextRequestId(),
      },
    });

    expect(response.status).toBe(201);
    if (!envelope.ok) throw new Error('expected an order');
    expect(envelope.data.productType).toBe('TOPUP');
    expect(envelope.data.recipientMasked).not.toBeNull();
    expect(envelope.data.recipientMasked).not.toBe('0912345678');

    // The stored row, not just the response: the full number must be nowhere.
    const stored = h.deps.driver.findPendingOrder(envelope.data.orderId);
    expect(stored?.recipient).not.toBe('0912345678');
    expect(JSON.stringify(stored)).not.toContain('0912345678');
    h.cleanup();
  });

  it('refuses a top-up with no phone number at all', async () => {
    const h = makeUiHarness('topup-no-recipient');
    const session = await signInAs(h.api);
    const { response, envelope } = await callWith(h.api, 'POST', '/api/training/orders', {
      cookie: session.cookieHeader,
      body: {
        csrfToken: session.csrfToken,
        network: 'NETWORK_A',
        productType: 'TOPUP',
        productId: 'NETWORK_A_TOPUP_2500',
        clientRequestId: nextRequestId(),
      },
    });
    expect(response.status).toBe(400);
    if (envelope.ok) throw new Error('expected a refusal');
    expect(envelope.error.reasonCode).toBe('RECIPIENT_INVALID');
    h.cleanup();
  });

  it('refuses something that is plainly not a phone number', async () => {
    const h = makeUiHarness('topup-bad-recipient');
    const session = await signInAs(h.api);
    for (const recipient of ['abc', '12', '0912345678901234567', '09-12-34']) {
      const { response } = await callWith(h.api, 'POST', '/api/training/orders', {
        cookie: session.cookieHeader,
        body: {
          csrfToken: session.csrfToken,
          network: 'NETWORK_A',
          productType: 'TOPUP',
          productId: 'NETWORK_A_TOPUP_2500',
          recipient,
          clientRequestId: nextRequestId(),
        },
      });
      expect(response.status, `"${recipient}" should have been refused`).toBe(400);
    }
    h.cleanup();
  });

  it('still allows an airtime voucher with no phone number', async () => {
    const h = makeUiHarness('airtime-no-recipient');
    const session = await signInAs(h.api);
    const { response, envelope } = await callWith<OrderDto>(h.api, 'POST', '/api/training/orders', {
      cookie: session.cookieHeader,
      body: {
        csrfToken: session.csrfToken,
        network: 'NETWORK_A',
        productType: 'AIRTIME',
        productId: 'NETWORK_A_AIRTIME_2500',
        clientRequestId: nextRequestId(),
      },
    });
    expect(response.status).toBe(201);
    if (!envelope.ok) throw new Error('expected an order');
    // Null, not an invented placeholder: the column records the honest absence.
    expect(envelope.data.recipientMasked).toBeNull();
    h.cleanup();
  });

  it('shows the operator the profit before the PIN is ever asked for', async () => {
    const h = makeUiHarness('order-shows-profit');
    const session = await signInAs(h.api);
    const { envelope } = await callWith<OrderDto>(h.api, 'POST', '/api/training/orders', {
      cookie: session.cookieHeader,
      body: {
        csrfToken: session.csrfToken,
        network: 'NETWORK_A',
        productType: 'AIRTIME',
        productId: 'NETWORK_A_AIRTIME_2500',
        clientRequestId: nextRequestId(),
      },
    });
    if (!envelope.ok) throw new Error('expected an order');
    // 25 birr at the 4% training default.
    expect(envelope.data.amountMinor).toBe(2500);
    expect(envelope.data.profitMinor).toBe(100);
    h.cleanup();
  });
});

describe('the Telga Pay training deposit', () => {
  it('credits the float and reports the balance after', async () => {
    const h = makeUiHarness('deposit-credits');
    const session = await asOwner(h.api);
    const before = h.deps.driver.balanceFor(MERCHANT_A).available.minor;

    const { response, envelope } = await callWith<DepositDto>(
      h.api,
      'POST',
      '/api/training/pay/deposits',
      {
        cookie: session.cookieHeader,
        body: {
          csrfToken: session.csrfToken,
          amountMinor: 20_000,
          method: 'TAP',
          clientRequestId: nextRequestId(),
        },
      },
    );

    expect(response.status).toBe(201);
    if (!envelope.ok) throw new Error('expected a deposit receipt');
    expect(envelope.data.amountMinor).toBe(20_000);
    expect(envelope.data.availableAfterMinor).toBe(before + 20_000);
    expect(h.deps.driver.balanceFor(MERCHANT_A).available.minor).toBe(before + 20_000);
    h.cleanup();
  });

  it('leaves the ledger balanced', async () => {
    const h = makeUiHarness('deposit-balanced');
    const session = await asOwner(h.api);
    await callWith(h.api, 'POST', '/api/training/pay/deposits', {
      cookie: session.cookieHeader,
      body: {
        csrfToken: session.csrfToken,
        amountMinor: 15_000,
        method: 'INSERT',
        clientRequestId: nextRequestId(),
      },
    });
    expect(h.deps.driver.ledgerResidualMinor()).toBe(0);
    h.cleanup();
  });

  it('funds a sale — the whole point of a training float', async () => {
    const h = makeUiHarness('deposit-funds-a-sale', { fundBirr: 0 });
    const session = await asOwner(h.api);
    const requestId = nextRequestId();

    // With nothing in the float, an order is refused before it is created.
    const broke = await callWith(h.api, 'POST', '/api/training/orders', {
      cookie: session.cookieHeader,
      body: {
        csrfToken: session.csrfToken,
        network: 'NETWORK_A',
        productType: 'AIRTIME',
        productId: 'NETWORK_A_AIRTIME_2500',
        clientRequestId: requestId,
      },
    });
    // 400 INSUFFICIENT_BALANCE — refused on the amount screen, before any
    // order row exists, so the operator is told while they can still act.
    expect(broke.response.status).toBe(400);
    if (broke.envelope.ok) throw new Error('expected a refusal');
    expect(broke.envelope.error.reasonCode).toMatch(/^INSUFFICIENT_AVAILABLE_BALANCE/);

    await callWith(h.api, 'POST', '/api/training/pay/deposits', {
      cookie: session.cookieHeader,
      body: {
        csrfToken: session.csrfToken,
        amountMinor: 10_000,
        method: 'SWIPE',
        clientRequestId: nextRequestId(),
      },
    });

    const funded = await callWith<OrderDto>(h.api, 'POST', '/api/training/orders', {
      cookie: session.cookieHeader,
      body: {
        csrfToken: session.csrfToken,
        network: 'NETWORK_A',
        productType: 'AIRTIME',
        productId: 'NETWORK_A_AIRTIME_2500',
        clientRequestId: nextRequestId(),
      },
    });
    expect(funded.response.status).toBe(201);
    h.cleanup();
  });

  it('refuses an operator, and credits nothing when it does', async () => {
    const h = makeUiHarness('deposit-operator-refused');
    const session = await signInAs(h.api);
    const before = h.deps.driver.balanceFor(MERCHANT_A).available.minor;

    const { response } = await callWith(h.api, 'POST', '/api/training/pay/deposits', {
      cookie: session.cookieHeader,
      body: {
        csrfToken: session.csrfToken,
        amountMinor: 20_000,
        method: 'TAP',
        clientRequestId: nextRequestId(),
      },
    });

    expect(response.status).toBe(403);
    expect(h.deps.driver.balanceFor(MERCHANT_A).available.minor).toBe(before);
    h.cleanup();
  });

  it('refuses a request with no CSRF token', async () => {
    const h = makeUiHarness('deposit-csrf');
    const session = await asOwner(h.api);
    const before = h.deps.driver.balanceFor(MERCHANT_A).available.minor;

    const { response } = await callWith(h.api, 'POST', '/api/training/pay/deposits', {
      cookie: session.cookieHeader,
      body: { amountMinor: 20_000, method: 'TAP', clientRequestId: nextRequestId() },
    });

    expect(response.status).toBe(403);
    expect(h.deps.driver.balanceFor(MERCHANT_A).available.minor).toBe(before);
    h.cleanup();
  });

  it('refuses an unauthenticated request outright', async () => {
    const h = makeUiHarness('deposit-anonymous');
    const before = h.deps.driver.balanceFor(MERCHANT_A).available.minor;
    const { response } = await callWith(h.api, 'POST', '/api/training/pay/deposits', {
      body: { amountMinor: 20_000, method: 'TAP', clientRequestId: nextRequestId() },
    });
    expect(response.status).toBe(401);
    expect(h.deps.driver.balanceFor(MERCHANT_A).available.minor).toBe(before);
    h.cleanup();
  });

  it('refuses an amount outside the training limits, and a fractional birr', async () => {
    const h = makeUiHarness('deposit-limits');
    const session = await asOwner(h.api);
    const before = h.deps.driver.balanceFor(MERCHANT_A).available.minor;
    const post = (amountMinor: number) =>
      callWith(h.api, 'POST', '/api/training/pay/deposits', {
        cookie: session.cookieHeader,
        body: {
          csrfToken: session.csrfToken,
          amountMinor,
          method: 'TAP',
          clientRequestId: nextRequestId(),
        },
      });

    expect((await post(TRAINING_DEPOSIT_LIMITS.minMinor - 100)).response.status).toBe(400);
    expect((await post(TRAINING_DEPOSIT_LIMITS.maxMinor + 100)).response.status).toBe(400);
    expect((await post(1050)).response.status, 'half a birr is not a deposit').toBe(400);
    expect((await post(Number.NaN)).response.status).toBe(400);
    expect(h.deps.driver.balanceFor(MERCHANT_A).available.minor).toBe(before);
    h.cleanup();
  });

  it('refuses a card gesture it does not recognise', async () => {
    const h = makeUiHarness('deposit-method');
    const session = await asOwner(h.api);
    const { response } = await callWith(h.api, 'POST', '/api/training/pay/deposits', {
      cookie: session.cookieHeader,
      body: {
        csrfToken: session.csrfToken,
        amountMinor: 20_000,
        method: 'CHEQUE',
        clientRequestId: nextRequestId(),
      },
    });
    expect(response.status).toBe(400);
    h.cleanup();
  });

  it('posts once when the same button is pressed twice', async () => {
    const h = makeUiHarness('deposit-double-press');
    const session = await asOwner(h.api);
    const before = h.deps.driver.balanceFor(MERCHANT_A).available.minor;
    const requestId = nextRequestId();
    const body = {
      csrfToken: session.csrfToken,
      amountMinor: 20_000,
      method: 'TAP',
      clientRequestId: requestId,
    };

    const first = await callWith<DepositDto>(h.api, 'POST', '/api/training/pay/deposits', {
      cookie: session.cookieHeader,
      body,
    });
    expect(first.response.status).toBe(201);

    // The second press carries the same client request id, so the posting id
    // is the same and the ledger refuses to write it twice.
    const second = await callWith<DepositDto>(h.api, 'POST', '/api/training/pay/deposits', {
      cookie: session.cookieHeader,
      body,
    });
    // 200, not 201 and not an error: nothing was created the second time, but
    // the operator's deposit is done, so they still reach their slip.
    expect(second.response.status).toBe(200);
    if (!second.envelope.ok) throw new Error('a double press must not be an error');
    expect(second.envelope.data.depositId).toBe(first.envelope.ok ? first.envelope.data.depositId : '');
    expect(
      h.deps.driver.balanceFor(MERCHANT_A).available.minor,
      'a double press must credit the float once',
    ).toBe(before + 20_000);
    h.cleanup();
  });

  it('records an audit event that names no card and no processor', async () => {
    const h = makeUiHarness('deposit-audit');
    const session = await asOwner(h.api);
    await callWith(h.api, 'POST', '/api/training/pay/deposits', {
      cookie: session.cookieHeader,
      body: {
        csrfToken: session.csrfToken,
        amountMinor: 20_000,
        method: 'TAP',
        clientRequestId: nextRequestId(),
      },
    });

    const events = h.deps.driver.readAuditEvents(MERCHANT_A);
    const deposit = events.find((event) => event.event_type === 'TRAINING_DEPOSIT_CREDITED');
    expect(deposit, 'a deposit must be audited').toBeDefined();
    const serialised = JSON.stringify(deposit).toLowerCase();
    for (const forbidden of ['pan', 'card_number', 'processor', 'visa', 'mastercard']) {
      expect(serialised).not.toContain(forbidden);
    }
    h.cleanup();
  });
});
