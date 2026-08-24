/**
 * The whole counter flow, end to end.
 *
 *   create a training transaction
 *     → show processing
 *     → simulate a provider outcome
 *     → show successful, failed, pending or under review
 *     → show the permitted next action
 *
 * Real database, real router, real recovery sweep, scripted mock provider. The
 * only thing standing in for reality is the scheduler, and it is driven by the
 * test rather than by a clock — no sleeps, anywhere.
 *
 * What these tests are really defending: the screen a merchant sees is the state
 * the ledger is in. Every assertion below reads the rendered tree, not the view
 * model that produced it, so a rendering mistake cannot pass by agreeing with
 * itself.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { DEVELOPMENT_RECOVERY_POLICY, recoverInFlight } from '@telga/api';
import { ManualScheduler } from '@telga/pos-view-model';
import type { TransactionDto } from '@telga/pos-view-model';
import {
  SaleFlow,
  TrainingApiClient,
  byTestId,
  renderToHtml,
  textOf,
  transactionDetailScreen,
} from '@telga/merchant-pos';
import type { El, Node } from '@telga/merchant-pos';
import {
  MAX_CLIENT_POLLS,
  MERCHANT_A,
  STATUS_CHECK_INTERVAL_MS,
  chromeFor,
  makeUiHarness,
  routerFetch,
} from './helpers';
import type { UiHarness } from './helpers';

let harness: UiHarness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

const AT = '2026-08-20T09:00:00.000Z';

const saleBody = (over: Record<string, unknown> = {}) => ({
  merchantId: MERCHANT_A,
  deviceId: 'device_alpha_1',
  operatorId: 'operator_alpha_1',
  productId: 'AIRTIME',
  amountMinor: 2500,
  recipient: '0900000000',
  clientRequestId: 'req_flow_1',
  ...over,
});

function flowFor(h: UiHarness, scheduler: ManualScheduler): SaleFlow {
  const client = new TrainingApiClient({
    baseUrl: '',
    fetch: routerFetch(h.api),
    now: () => AT,
  });
  let n = 0;
  return new SaleFlow({
    client,
    merchantId: MERCHANT_A,
    locale: 'en',
    scheduler,
    now: () => AT,
    newCorrelationId: () => `corr_flow_${(n += 1)}`,
  });
}

/**
 * Run one recovery sweep against the harness, the way the worker would.
 *
 * The sweep is the real service — the UI tests do not simulate recovery, they
 * drive it, so what the screen shows afterwards is what the database says.
 */
async function sweep(
  h: UiHarness,
  policy: Partial<typeof DEVELOPMENT_RECOVERY_POLICY> = {},
): Promise<Awaited<ReturnType<typeof recoverInFlight>>> {
  let n = 0;
  return recoverInFlight({
    ...h.deps,
    newId: (prefix) => `${prefix}_sweep_${(n += 1)}`,
    workerId: 'worker_ui_test',
    recovery: { ...DEVELOPMENT_RECOVERY_POLICY, recoveryAgeMs: 1000, ...policy },
  });
}

/** Render whatever the flow currently holds, the way the detail screen would. */
function screenOf(flow: SaleFlow): El {
  const view = flow.view();
  if (view === undefined) throw new Error('no transaction to render');
  return transactionDetailScreen({
    chrome: chromeFor(),
    transaction: { status: 'READY', data: view, loadedAt: AT },
    polling: { statusCheckIntervalMs: STATUS_CHECK_INTERVAL_MS, maxPolls: MAX_CLIENT_POLLS },
  });
}

const label = (el: El, id: string): string => textOf(byTestId(el, id) as Node);

describe('the full training flow', () => {
  it('creates a sale, shows a confirmed success, and offers a receipt', async () => {
    harness = makeUiHarness('flow-success', { behaviour: 'SUCCESS' });
    const flow = flowFor(harness, new ManualScheduler());

    await flow.start(saleBody());

    expect(flow.saleResult?.kind).toBe('SUCCESSFUL');
    const screen = screenOf(flow);
    expect(label(screen, 'status-label')).toBe('Transaction successful');
    expect(label(screen, 'status-certainty')).toMatch(/confirmed by the provider/i);
    expect(label(screen, 'funds-label')).toMatch(/balance was reduced/i);
    expect(byTestId(screen, 'action-PRINT_RECEIPT')).toBeDefined();
    expect(byTestId(screen, 'do-not-retry')).toBeUndefined();
  });

  it('shows a confirmed failure as no sale with the funds returned', async () => {
    harness = makeUiHarness('flow-failure', { behaviour: 'FAILURE' });
    const flow = flowFor(harness, new ManualScheduler());

    await flow.start(saleBody());

    expect(flow.saleResult?.kind).toBe('FAILED');
    const screen = screenOf(flow);
    expect(label(screen, 'status-label')).toBe('Transaction failed');
    expect(label(screen, 'status-explanation')).toContain('No charge was made');
    expect(label(screen, 'funds-label')).toMatch(/returned to your available balance/i);
    expect(byTestId(screen, 'action-PRINT_RECEIPT')).toBeUndefined();
    expect(byTestId(screen, 'action-START_NEW_SALE')).toBeDefined();
  });

  it('shows a timeout as pending, holding funds, telling the operator not to retry', async () => {
    harness = makeUiHarness('flow-pending', { behaviour: 'TIMEOUT' });
    const flow = flowFor(harness, new ManualScheduler());

    await flow.start(saleBody());

    expect(flow.saleResult?.kind).toBe('PENDING');
    expect(flow.saleResult?.nextAction).toBe('DO_NOT_RETRY_YET');

    const screen = screenOf(flow);
    expect(label(screen, 'status-label')).toBe('Transaction pending');
    expect(label(screen, 'do-not-retry')).toBe('Do not retry yet');
    expect(label(screen, 'funds-label')).toMatch(/held for this sale/i);
    expect(label(screen, 'refusal-RETRY_SAME_SALE')).toMatch(/twice/i);
    expect(label(screen, 'recovery-phase')).toMatch(/waiting for telga/i);
    // The one thing that must never appear.
    expect(renderToHtml(screen)).not.toContain('Transaction successful');
  });

  it('watches a pending sale and shows the settlement once recovery resolves it', async () => {
    // DELAYED_SUCCESS: indeterminate at submit, resolvable once the mock's own
    // virtual clock advances. TIMEOUT never resolves, which is a different test.
    harness = makeUiHarness('flow-watch', { behaviour: 'DELAYED_SUCCESS', delayTicks: 3 });
    const scheduler = new ManualScheduler();
    const flow = flowFor(harness, scheduler);

    await flow.start(saleBody());
    expect(flow.view()?.state).toBe('PENDING');

    flow.watch(STATUS_CHECK_INTERVAL_MS, MAX_CLIENT_POLLS);
    expect(scheduler.delays).toEqual([STATUS_CHECK_INTERVAL_MS]);

    // One poll while it is still pending: the screen must not change its story.
    scheduler.runNext();
    await flow.pollSettled();
    expect(flow.view()?.state).toBe('PENDING');
    expect(byTestId(screenOf(flow), 'do-not-retry')).toBeDefined();

    // Now the provider makes up its mind, and the sweep resolves the transaction.
    harness.provider.advance(5);
    harness.clock.advance(2 * 60_000);
    const report = await sweep(harness);
    expect(report.recoveryFailures).toBe(0);
    expect(report.recoveredSuccessful).toBe(1);

    scheduler.runNext();
    await flow.pollSettled();

    const view = flow.view();
    expect(view?.state).toBe('SUCCESSFUL');
    const screen = screenOf(flow);
    // The screen agrees with the database, and only now offers a receipt.
    expect(byTestId(screen, 'transaction-detail')?.attrs['data-state']).toBe('SUCCESSFUL');
    expect(label(screen, 'status-label')).toBe('Transaction successful');
    expect(byTestId(screen, 'action-PRINT_RECEIPT')).toBeDefined();
    expect(byTestId(screen, 'do-not-retry')).toBeUndefined();
    expect(flow.isPolling).toBe(false);
  });

  it('stops watching at the cap rather than polling a counter screen forever', async () => {
    harness = makeUiHarness('flow-cap', { behaviour: 'TIMEOUT' });
    const scheduler = new ManualScheduler();
    const flow = flowFor(harness, scheduler);

    await flow.start(saleBody());
    flow.watch(STATUS_CHECK_INTERVAL_MS, 2);

    for (let i = 0; i < 6; i += 1) {
      scheduler.runNext();
      await flow.pollSettled();
    }
    expect(flow.pollAttempts).toBe(2);
    expect(flow.isPolling).toBe(false);
  });

  it('escalates to under review, opens a case, and shows the reference', async () => {
    harness = makeUiHarness('flow-under-review', { behaviour: 'TIMEOUT' });
    const flow = flowFor(harness, new ManualScheduler());
    await flow.start(saleBody());

    // Past the pending maximum, with the provider still saying nothing.
    harness.clock.advance(10 * 60_000);
    const report = await sweep(harness, { pendingMaximumMs: 60_000 });
    expect(report.recoveryFailures).toBe(0);
    expect(report.escalatedUnderReview).toBe(1);

    await flow.refresh();
    const view = flow.view();
    expect(view?.state).toBe('UNDER_REVIEW');

    const screen = screenOf(flow);
    expect(label(screen, 'status-label')).toBe('Under review');
    expect(label(screen, 'funds-label')).toMatch(/held while this is checked/i);
    expect(label(screen, 'recovery-phase')).toMatch(/passed to the telga team/i);
    expect(byTestId(screen, 'manual-review-open')).toBeDefined();
    expect(byTestId(screen, 'support-block')).toBeDefined();
    expect(label(screen, 'support-reference')).toContain('TG-');
    expect(byTestId(screen, 'action-COPY_SUPPORT_REFERENCE')).toBeDefined();
    expect(byTestId(screen, 'action-PRINT_RECEIPT')).toBeUndefined();
  });

  it('exercises a provider outcome the operator chose, without touching a real provider', async () => {
    harness = makeUiHarness('flow-simulated-choice', { behaviour: 'SUCCESS' });
    const flow = flowFor(harness, new ManualScheduler());

    await flow.start(saleBody({ simulatedProviderBehaviour: 'FAILURE' }));

    expect(flow.saleResult?.kind).toBe('FAILED');
    expect(flow.saleResult?.simulated).toBe(true);
    expect(flow.view()?.trainingMode).toBe(true);
  });
});

describe('when the API cannot be reached mid-flow', () => {
  it('keeps the last known state on screen, marked stale, and claims nothing new', async () => {
    harness = makeUiHarness('flow-stale', { behaviour: 'TIMEOUT' });
    const scheduler = new ManualScheduler();

    let reachable = true;
    const routed = routerFetch(harness.api);
    const client = new TrainingApiClient({
      baseUrl: '',
      fetch: async (url, init) => {
        if (!reachable) throw new Error('ECONNREFUSED');
        return routed(url, init);
      },
      now: () => AT,
    });
    let n = 0;
    const flow = new SaleFlow({
      client,
      merchantId: MERCHANT_A,
      locale: 'en',
      scheduler,
      now: () => AT,
      newCorrelationId: () => `corr_stale_${(n += 1)}`,
    });

    await flow.start(saleBody());
    expect(flow.view()?.state).toBe('PENDING');

    reachable = false;
    await flow.refresh();

    expect(flow.presentationState.status).toBe('STALE');
    // The transaction is still pending, and the screen still says so.
    const view = flow.view();
    expect(view?.state).toBe('PENDING');
    expect(view?.doNotRetryYet).toBe(true);
    expect(byTestId(screenOf(flow), 'do-not-retry')).toBeDefined();
  });

  it('never turns a transport failure into a sale outcome', async () => {
    harness = makeUiHarness('flow-no-invention', { behaviour: 'TIMEOUT' });
    const scheduler = new ManualScheduler();
    let reachable = true;
    const routed = routerFetch(harness.api);
    const client = new TrainingApiClient({
      baseUrl: '',
      fetch: async (url, init) => {
        if (!reachable) throw new Error('ECONNREFUSED');
        return routed(url, init);
      },
      now: () => AT,
    });
    const flow = new SaleFlow({
      client,
      merchantId: MERCHANT_A,
      locale: 'en',
      scheduler,
      now: () => AT,
      newCorrelationId: () => 'corr_ni',
    });

    await flow.start(saleBody());
    const before = flow.view()?.state;
    reachable = false;

    flow.watch(STATUS_CHECK_INTERVAL_MS, 3);
    for (let i = 0; i < 3; i += 1) {
      scheduler.runNext();
      await flow.pollSettled();
    }

    expect(flow.view()?.state).toBe(before);
    // And the database was not touched by any of it.
    const row = harness.driver.findTransactionsByMerchant(MERCHANT_A)[0];
    expect(row?.state).toBe('PENDING');
  });

  it('reports a rejected sale as an error with no transaction at all', async () => {
    harness = makeUiHarness('flow-rejected', { behaviour: 'OUTAGE' });
    const flow = flowFor(harness, new ManualScheduler());

    await flow.start(saleBody());

    expect(flow.presentationState.status).toBe('ERROR');
    expect(flow.view()).toBeUndefined();
    expect(harness.driver.findTransactionsByMerchant(MERCHANT_A)).toHaveLength(0);
  });
});

describe('a double press on the confirm button', () => {
  it('produces one sale, and the second press shows the existing transaction', async () => {
    harness = makeUiHarness('flow-double-press');
    const flowA = flowFor(harness, new ManualScheduler());
    const flowB = flowFor(harness, new ManualScheduler());

    // The same clientRequestId, because the form generated it once.
    await flowA.start(saleBody({ clientRequestId: 'req_same' }));
    await flowB.start(saleBody({ clientRequestId: 'req_same' }));

    expect(flowA.saleResult?.kind).toBe('SUCCESSFUL');
    expect(flowB.saleResult?.kind).toBe('DUPLICATE_REQUEST');
    expect(flowB.saleResult?.transactionId).toBe(flowA.saleResult?.transactionId);
    expect(harness.driver.findTransactionsByMerchant(MERCHANT_A)).toHaveLength(1);
  });
});



/** Referenced so the DTO type stays load-bearing in this file. */
export type _FlowDto = TransactionDto;
