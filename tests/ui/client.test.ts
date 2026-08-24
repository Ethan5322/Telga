/**
 * The typed client, the presentation state machine and the polling loop.
 *
 * Not one of these tests sleeps. The scheduler is a `ManualScheduler` the test
 * advances by hand, so a four-poll loop takes microseconds and cannot flake on
 * a loaded machine — the rule set out in `09 Engineering/Test Stability Runbook.md`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  ManualScheduler,
  PollController,
  dataOf,
  fail,
  failureOf,
  isStale,
  startLoad,
  succeed,
  succeedList,
} from '@telga/pos-view-model';
import type { RemoteData, RemoteFailure, TransactionDto } from '@telga/pos-view-model';
import { TrainingApiClient, toRemoteFailure } from '@telga/merchant-pos';
import type { FetchLike } from '@telga/merchant-pos';
import {
  MAX_CLIENT_POLLS,
  MERCHANT_A,
  MERCHANT_B,
  makeUiHarness,
  malformedFetch,
  routerFetch,
  seedSale,
  unreachableFetch,
} from './helpers';
import type { UiHarness } from './helpers';

let harness: UiHarness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

const AT = '2026-08-20T09:00:00.000Z';
const failure = (reasonCode: string): RemoteFailure => ({
  reasonCode,
  messageKey: 'status.sales_unavailable',
  status: null,
  correlationId: 'corr_x',
  at: AT,
});

function clientFor(h: UiHarness, fetchImpl: FetchLike = routerFetch(h.api)): TrainingApiClient {
  return new TrainingApiClient({ baseUrl: '', fetch: fetchImpl, now: () => AT });
}

describe('the typed client', () => {
  it('reads a transaction through the real router', async () => {
    harness = makeUiHarness('client-read');
    const id = await seedSale(harness);
    const envelope = await clientFor(harness).getTransaction(MERCHANT_A, id, 'corr_a');

    if (!envelope.ok) throw new Error(envelope.error.reasonCode);
    expect(envelope.data.transactionId).toBe(id);
    expect(envelope.meta.mode).toBe('TRAINING');
  });

  it('sends the correlation id on every request', async () => {
    harness = makeUiHarness('client-correlation');
    const fetchImpl = routerFetch(harness.api);
    const client = clientFor(harness, fetchImpl);
    const id = await seedSale(harness);

    await client.getTransaction(MERCHANT_A, id, 'corr-action-1');
    await client.getBalance(MERCHANT_A, 'corr-action-1');
    await client.getQueue(MERCHANT_A, 'corr-action-1');

    expect(fetchImpl.calls).toHaveLength(3);
    for (const call of fetchImpl.calls) {
      expect(call.headers['x-telga-correlation-id']).toBe('corr-action-1');
    }
  });

  it('propagates the correlation id all the way into the response envelope', async () => {
    harness = makeUiHarness('client-correlation-echo');
    const id = await seedSale(harness);
    const envelope = await clientFor(harness).getTransaction(MERCHANT_A, id, 'corr-action-2');
    expect(envelope.meta.correlationId).toBe('corr-action-2');
  });

  it('returns a failure envelope instead of throwing when the API is unreachable', async () => {
    harness = makeUiHarness('client-unreachable');
    const envelope = await clientFor(harness, unreachableFetch()).getBalance(MERCHANT_A, 'corr_b');
    expect(envelope.ok).toBe(false);
    if (envelope.ok) throw new Error('unreachable');
    expect(envelope.error.reasonCode).toBe('API_UNREACHABLE');
  });

  it('returns a failure envelope when the response is not an envelope', async () => {
    harness = makeUiHarness('client-malformed');
    const envelope = await clientFor(harness, malformedFetch()).getBalance(MERCHANT_A, 'corr_c');
    if (envelope.ok) throw new Error('should not be ok');
    expect(envelope.error.reasonCode).toBe('API_RESPONSE_MALFORMED');
  });

  it('surfaces an application rejection as a failure with its own reason code', async () => {
    harness = makeUiHarness('client-rejected');
    const envelope = await clientFor(harness).createSale(
      {
        merchantId: MERCHANT_A,
        deviceId: 'device_alpha_1',
        operatorId: 'operator_alpha_1',
        productId: 'AIRTIME',
        amountMinor: 2500,
        recipient: 'x',
        clientRequestId: 'req_bad',
      },
      'corr_d',
    );
    if (envelope.ok) throw new Error('should not be ok');
    expect(envelope.error.kind).toBe('INVALID_REQUEST');
  });
});

describe('presentation state', () => {
  it('keeps previous data visible while refreshing', () => {
    const ready = succeed({ v: 1 }, AT);
    const loading = startLoad(ready);
    expect(loading.status).toBe('LOADING');
    expect(dataOf(loading)).toEqual({ v: 1 });
  });

  it('degrades to STALE rather than ERROR when there is something to keep', () => {
    const ready = succeed({ v: 1 }, AT);
    const stale = fail(ready, failure('API_UNREACHABLE'));
    expect(stale.status).toBe('STALE');
    expect(isStale(stale)).toBe(true);
    expect(dataOf(stale)).toEqual({ v: 1 });
    expect(failureOf(stale)?.reasonCode).toBe('API_UNREACHABLE');
  });

  it('becomes ERROR only when there is genuinely nothing to show', () => {
    const first = fail({ status: 'IDLE' } as RemoteData<unknown>, failure('API_UNREACHABLE'));
    expect(first.status).toBe('ERROR');
    expect(dataOf(first)).toBeUndefined();
  });

  it('keeps previous data when a refresh fails mid-load', () => {
    const loading = startLoad(succeed({ v: 1 }, AT));
    const stale = fail(loading, failure('API_RESPONSE_NOT_JSON'));
    expect(stale.status).toBe('STALE');
    expect(dataOf(stale)).toEqual({ v: 1 });
  });

  it('distinguishes an empty list from a missing one', () => {
    expect(succeedList([], AT).status).toBe('EMPTY');
    expect(succeedList([1], AT).status).toBe('READY');
  });
});

describe('the polling loop', () => {
  it('does nothing until the scheduler fires', async () => {
    const scheduler = new ManualScheduler();
    let calls = 0;
    const poll = new PollController<number>({
      intervalMs: 30_000,
      maxPolls: 3,
      scheduler,
      fetchOnce: async () => {
        calls += 1;
        return calls;
      },
      onResult: () => {},
    });
    poll.start();
    expect(calls).toBe(0);
    expect(scheduler.pending).toBe(1);
  });

  it('uses the interval the server supplied', () => {
    const scheduler = new ManualScheduler();
    new PollController<number>({
      intervalMs: 12_345,
      maxPolls: 2,
      scheduler,
      fetchOnce: async () => 1,
      onResult: () => {},
    }).start();
    expect(scheduler.delays).toEqual([12_345]);
  });

  it('stops at the cap rather than polling forever', async () => {
    const scheduler = new ManualScheduler();
    let calls = 0;
    const poll = new PollController<number>({
      intervalMs: 1000,
      maxPolls: 3,
      scheduler,
      fetchOnce: async () => {
        calls += 1;
        return calls;
      },
      onResult: () => {},
      shouldContinue: () => true,
    });
    poll.start();
    for (let i = 0; i < 10; i += 1) {
      scheduler.runNext();
      await poll.settled();
    }
    expect(calls).toBe(3);
    expect(poll.isRunning).toBe(false);
    expect(poll.stopReason).toBe('MAX_POLLS_REACHED');
  });

  it('stops as soon as the value resolves', async () => {
    const scheduler = new ManualScheduler();
    const states = ['PENDING', 'PENDING', 'SUCCESSFUL'];
    let index = 0;
    const poll = new PollController<string>({
      intervalMs: 1000,
      maxPolls: 10,
      scheduler,
      fetchOnce: async () => states[index++] ?? 'SUCCESSFUL',
      onResult: () => {},
      shouldContinue: (state) => state === 'PENDING',
    });
    poll.start();
    for (let i = 0; i < 5; i += 1) {
      scheduler.runNext();
      await poll.settled();
    }
    expect(poll.attemptCount).toBe(3);
    expect(poll.stopReason).toBe('RESOLVED');
  });

  it('keeps polling after a failed attempt, because a failed lookup is not a result', async () => {
    const scheduler = new ManualScheduler();
    const outcomes: Array<() => string> = [
      () => {
        throw new Error('network');
      },
      () => 'PENDING',
      () => 'SUCCESSFUL',
    ];
    let index = 0;
    const seen: boolean[] = [];
    const poll = new PollController<string>({
      intervalMs: 1000,
      maxPolls: 10,
      scheduler,
      fetchOnce: async () => (outcomes[index++] ?? (() => 'SUCCESSFUL'))(),
      onResult: (attempt) => seen.push(attempt.ok),
      shouldContinue: (state) => state === 'PENDING',
    });
    poll.start();
    for (let i = 0; i < 5; i += 1) {
      scheduler.runNext();
      await poll.settled();
    }
    expect(seen).toEqual([false, true, true]);
    expect(poll.stopReason).toBe('RESOLVED');
  });

  it('cancels its pending timer when stopped', () => {
    const scheduler = new ManualScheduler();
    const poll = new PollController<number>({
      intervalMs: 1000,
      maxPolls: 5,
      scheduler,
      fetchOnce: async () => 1,
      onResult: () => {},
    });
    poll.start();
    expect(scheduler.pending).toBe(1);
    poll.stop();
    expect(scheduler.pending).toBe(0);
    expect(poll.stopReason).toBe('STOPPED_BY_CALLER');
  });
});

describe('failure translation', () => {
  it('turns a failed envelope into something a screen can render', async () => {
    harness = makeUiHarness('failure-translation');
    const envelope = await clientFor(harness).getTransaction(MERCHANT_A, 'txn_missing', 'corr_e');
    if (envelope.ok) throw new Error('should not be ok');
    const remote = toRemoteFailure(envelope, AT);
    expect(remote.reasonCode).toBe('TRANSACTION_NOT_FOUND');
    expect(remote.status).toBe(404);
    expect(remote.correlationId).toBe('corr_e');
    expect(remote.at).toBe(AT);
  });

  it('carries a message key the localization package can resolve', async () => {
    harness = makeUiHarness('failure-message-key');
    const envelope = await clientFor(harness).getTransaction(MERCHANT_A, 'txn_missing', 'corr_f');
    if (envelope.ok) throw new Error('should not be ok');
    expect(envelope.error.messageKey).toBe('error.permission.denied');
  });
});

describe('what the client cannot do', () => {
  it('names no method that changes a transaction state, posts an entry or approves anything', () => {
    // `private` is erased at runtime, so this asserts the property that matters:
    // no method on the client is named for a mutation the POS must not perform.
    const methods = Object.getOwnPropertyNames(TrainingApiClient.prototype).filter(
      (name) => name !== 'constructor',
    );
    for (const name of methods) {
      expect(name, `client exposes "${name}"`).not.toMatch(
        /reversal|reverse|approve|release|credit|adjust|ledger|setstate|transition|refund/i,
      );
    }
  });

  it('issues a non-GET request for exactly one operation: creating a sale', async () => {
    harness = makeUiHarness('client-verbs');
    const fetchImpl = routerFetch(harness.api);
    const client = clientFor(harness, fetchImpl);
    const id = await seedSale(harness);

    await client.getTransaction(MERCHANT_A, id, 'c');
    await client.listTransactions(MERCHANT_A, 'c');
    await client.getQueue(MERCHANT_A, 'c');
    await client.getBalance(MERCHANT_A, 'c');
    const readCalls = fetchImpl.calls.length;
    expect(fetchImpl.calls.every((call) => call.method === 'GET')).toBe(true);

    await client.createSale(
      {
        merchantId: MERCHANT_A,
        deviceId: 'device_alpha_1',
        operatorId: 'operator_alpha_1',
        productId: 'AIRTIME',
        amountMinor: 2500,
        recipient: '0900000001',
        clientRequestId: 'req_verbs',
      },
      'c',
    );
    const written = fetchImpl.calls.slice(readCalls);
    expect(written).toHaveLength(1);
    expect(written[0]?.method).toBe('POST');
    expect(written[0]?.url).toContain('/api/training/sales');
  });

  it('cannot reach a transaction belonging to another merchant', async () => {
    harness = makeUiHarness('client-isolation', { seedSecondMerchant: true });
    const id = await seedSale(harness);

    // The client sends a merchant id, but it is only ever a consistency check.
    // Sending someone else's is refused as a scope mismatch, and the refusal
    // says nothing about whether that transaction exists.
    const envelope = await clientFor(harness).getTransaction(MERCHANT_B, id, 'corr_g');
    if (envelope.ok) throw new Error('should not be readable');
    expect(envelope.error.reasonCode).toBe('MERCHANT_SCOPE_MISMATCH');
  });
});

/** A DTO-shaped assertion, so the poll test above is anchored to the real type. */
describe('transaction dto shape', () => {
  it('matches what the router returns', async () => {
    harness = makeUiHarness('dto-shape');
    const id = await seedSale(harness);
    const envelope = await clientFor(harness).getTransaction(MERCHANT_A, id, 'corr_h');
    if (!envelope.ok) throw new Error(envelope.error.reasonCode);
    const dto: TransactionDto = envelope.data;
    expect(Object.keys(dto).sort()).toEqual(
      [
        'amount',
        'correlationId',
        'createdAt',
        'deviceId',
        'idempotencyKey',
        'merchantId',
        'mode',
        'productType',
        'providerReference',
        'recipientMasked',
        'recovery',
        'reservation',
        'simulated',
        'state',
        'support',
        'transactionId',
        'updatedAt',
      ].sort(),
    );
    expect(envelope.meta.polling.maxPolls).toBe(MAX_CLIENT_POLLS);
  });
});
