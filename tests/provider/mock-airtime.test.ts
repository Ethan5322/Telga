/**
 * Deterministic mock provider — contract tests for all eight behaviours.
 * See `09 Engineering/Testing Strategy.md`.
 */

import { describe, expect, it } from 'vitest';
import { fromBirr, LiveMoneyDisabledError, stateForSubmission, transactionId } from '@telga/domain';
import type { AirtimeRequest, ProviderContext } from '@telga/domain';
import { MOCK_BEHAVIOURS, MockAirtimeProvider } from '@telga/provider-mock-airtime';
import type { MockBehaviour } from '@telga/provider-mock-airtime';
import { DEVICE_A, MERCHANT_A, PRODUCT, PROVIDER } from '../helpers';

const request = (key = 'idem_test'): AirtimeRequest => ({
  transactionId: transactionId('txn_mock_1'),
  merchantId: MERCHANT_A,
  productId: PRODUCT,
  amount: fromBirr(25),
  recipient: '0900000000',
  idempotencyKey: key,
});

const context = (): ProviderContext => ({
  providerId: PROVIDER,
  deviceId: DEVICE_A,
  mode: 'TRAINING',
  timeoutMs: 5000,
});

const provider = (behaviour: MockBehaviour, delayTicks = 1) =>
  new MockAirtimeProvider({ providerId: PROVIDER, behaviour, delayTicks });

describe('immediate success', () => {
  it('confirms delivery', async () => {
    const result = await provider('SUCCESS').submit(request(), context());
    expect(result.outcome).toBe('CONFIRMED_SUCCESS');
    expect(result.providerReference).toMatch(/^MOCKREF-/);
    expect(stateForSubmission(result.outcome)).toBe('SUCCESSFUL');
  });
});

describe('confirmed failure', () => {
  it('reports a definite failure, which releases the reservation', async () => {
    const result = await provider('FAILURE').submit(request(), context());
    expect(result.outcome).toBe('CONFIRMED_FAILURE');
    expect(stateForSubmission(result.outcome)).toBe('FAILED');
  });
});

describe('timeout', () => {
  it('is indeterminate, never a failure', async () => {
    const p = provider('TIMEOUT');
    const result = await p.submit(request(), context());
    expect(result.outcome).toBe('INDETERMINATE');
    expect(stateForSubmission(result.outcome)).toBe('PENDING');
  });

  it('never resolves on its own, however long we wait', async () => {
    const p = provider('TIMEOUT');
    await p.submit(request(), context());
    p.advance(1000);
    const status = await p.getStatus({ transactionId: transactionId('txn_mock_1'), idempotencyKey: 'idem_test' });
    expect(status.outcome).toBe('STILL_PENDING');
  });
});

describe('delayed success', () => {
  it('is pending before the delay and successful after', async () => {
    const p = provider('DELAYED_SUCCESS', 3);
    const submitted = await p.submit(request(), context());
    expect(submitted.outcome).toBe('INDETERMINATE');

    const query = { transactionId: transactionId('txn_mock_1'), idempotencyKey: 'idem_test' };
    expect((await p.getStatus(query)).outcome).toBe('STILL_PENDING');

    p.advance(2);
    expect((await p.getStatus(query)).outcome).toBe('STILL_PENDING');

    p.advance(1);
    expect((await p.getStatus(query)).outcome).toBe('SUCCESS');
  });
});

describe('delayed failure', () => {
  it('is pending before the delay and failed after', async () => {
    const p = provider('DELAYED_FAILURE', 2);
    await p.submit(request(), context());
    const query = { transactionId: transactionId('txn_mock_1'), idempotencyKey: 'idem_test' };

    expect((await p.getStatus(query)).outcome).toBe('STILL_PENDING');
    p.advance(2);
    expect((await p.getStatus(query)).outcome).toBe('FAILURE');
  });
});

describe('malformed response', () => {
  it('never crashes and is never read as a success', async () => {
    const p = provider('MALFORMED_RESPONSE');
    const result = await p.submit(request(), context());
    expect(result.outcome).toBe('INDETERMINATE');
    expect(result.outcome).not.toBe('CONFIRMED_SUCCESS');
    expect(stateForSubmission(result.outcome)).toBe('PENDING');
  });
});

describe('duplicate callback', () => {
  it('delivers the same logical callback twice', async () => {
    const p = provider('DUPLICATE_CALLBACK');
    await p.submit(request(), context());
    const callbacks = p.drainCallbacks();

    expect(callbacks).toHaveLength(2);
    expect(callbacks[0]?.deliveryOf).toBe(callbacks[1]?.deliveryOf);
    expect(callbacks[0]?.deliveryId).not.toBe(callbacks[1]?.deliveryId);
  });

  it('a webhook handler that de-duplicates on deliveryOf applies it once', async () => {
    const p = provider('DUPLICATE_CALLBACK');
    await p.submit(request(), context());
    const applied = new Set(p.drainCallbacks().map((c) => c.deliveryOf));
    expect(applied.size).toBe(1);
  });
});

describe('provider outage', () => {
  it('reports unhealthy', async () => {
    const health = await provider('OUTAGE').healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.providerId).toBe(PROVIDER);
  });

  it('rejects without attempting, so nothing may be charged', async () => {
    const result = await provider('OUTAGE').submit(request(), context());
    expect(result.outcome).toBe('REJECTED');
    expect(result.message).toMatch(/not attempted/i);
  });

  it('a healthy provider reports healthy', async () => {
    const health = await provider('SUCCESS').healthCheck();
    expect(health.healthy).toBe(true);
  });
});

describe('duplicate submission of the same key', () => {
  it('returns DUPLICATE rather than vending twice', async () => {
    const p = provider('SUCCESS');
    const first = await p.submit(request(), context());
    const second = await p.submit(request(), context());

    expect(first.outcome).toBe('CONFIRMED_SUCCESS');
    expect(second.outcome).toBe('DUPLICATE');
    expect(second.providerReference).toBe(first.providerReference);
    expect(stateForSubmission(second.outcome)).toBe('PENDING');
  });
});

describe('determinism', () => {
  it('the same seed and key always select the same behaviour', () => {
    const a = new MockAirtimeProvider({ providerId: PROVIDER, seed: 42 });
    const b = new MockAirtimeProvider({ providerId: PROVIDER, seed: 42 });
    for (const key of ['k1', 'k2', 'k3', 'k4', 'k5']) {
      expect(a.behaviourFor(key)).toBe(b.behaviourFor(key));
    }
  });

  it('a different seed can select a different behaviour', () => {
    const a = new MockAirtimeProvider({ providerId: PROVIDER, seed: 1 });
    const b = new MockAirtimeProvider({ providerId: PROVIDER, seed: 2 });
    const differs = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'].some((k) => a.behaviourFor(k) !== b.behaviourFor(k));
    expect(differs).toBe(true);
  });

  it('the provider reference is a pure function of the key', async () => {
    const a = provider('SUCCESS');
    const b = provider('SUCCESS');
    const one = await a.submit(request('idem_same'), context());
    const two = await b.submit(request('idem_same'), context());
    expect(one.providerReference).toBe(two.providerReference);
  });

  it('covers all eight required behaviours', () => {
    expect([...MOCK_BEHAVIOURS]).toEqual([
      'SUCCESS',
      'FAILURE',
      'TIMEOUT',
      'DELAYED_SUCCESS',
      'DELAYED_FAILURE',
      'MALFORMED_RESPONSE',
      'DUPLICATE_CALLBACK',
      'OUTAGE',
    ]);
  });
});

describe('everything is simulated', () => {
  it('marks every result as simulated', async () => {
    const p = provider('SUCCESS');
    const submitted = await p.submit(request(), context());
    const status = await p.getStatus({ transactionId: transactionId('txn_mock_1'), idempotencyKey: 'idem_test' });
    const health = await p.healthCheck();
    const reversal = await p.reverse({
      transactionId: transactionId('txn_mock_1'),
      providerReference: submitted.providerReference ?? '',
      reason: 'test',
    });

    expect(submitted.simulated).toBe(true);
    expect(status.simulated).toBe(true);
    expect(health.simulated).toBe(true);
    expect(reversal.simulated).toBe(true);
  });

  it('refuses a LIVE context', async () => {
    await expect(
      provider('SUCCESS').submit(request(), { ...context(), mode: 'LIVE' }),
    ).rejects.toThrow(LiveMoneyDisabledError);
  });
});
