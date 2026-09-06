/**
 * Today's profit, after profit has been collected.
 *
 * The bug as reported from the counter, 2026-08-29: collecting earned profit
 * drove the figure negative, and collecting again drove it further down.
 *
 * `profit-cannot-go-negative.test.ts` proves the **transfer** is sound — it is
 * bounded and refuses to move more than is available. This file covers the
 * thing that was actually wrong: the **figure on the dashboard**.
 *
 * `profitForDay` summed `TELGA_REVENUE` for the day, and a transfer posts a
 * `DEBIT` to that account dated the day it is made. So a shop that earned on
 * Monday and collected on Tuesday saw Tuesday reported as a day of losses — the
 * dashboard punishing an owner for taking money they had already earned.
 *
 * A transfer is a movement between the shop's own buckets, not an un-earning.
 * A **reversal** is an un-earning, and still counts — which is the distinction
 * the last test here pins down, because "exclude the debits" would have been
 * the easy fix and the wrong one.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MERCHANT_A, OWNER_USER, TEST_PIN, callWith, makeUiHarness, signInAs } from '../auth/helpers';
import type { UiHarness } from '../auth/helpers';

let harness: UiHarness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

/** Sell `quantity` × 25 birr, so the shop earns training profit. */
async function earnProfit(h: UiHarness, quantity: number, requestId: string): Promise<void> {
  const session = await signInAs(h.api);
  const order = await callWith<{ orderId: string }>(h.api, 'POST', '/api/training/orders', {
    cookie: session.cookieHeader,
    body: {
      csrfToken: session.csrfToken,
      network: 'NETWORK_A',
      productType: 'AIRTIME',
      productId: 'NETWORK_A_AIRTIME_2500',
      quantity,
      clientRequestId: requestId,
    },
  });
  if (!order.envelope.ok) throw new Error('fixture could not create the order');
  await callWith(h.api, 'POST', `/api/training/orders/${order.envelope.data.orderId}/authorize`, {
    cookie: session.cookieHeader,
    body: { csrfToken: session.csrfToken, pin: TEST_PIN },
  });
}

const asOwner = (h: UiHarness) => signInAs(h.api, { userId: OWNER_USER, role: 'MERCHANT_OWNER' });

/** The day the harness's clock is on, as the read model computes it. */
const today = (h: UiHarness): string => h.deps.now().slice(0, 10);

const todayProfit = (h: UiHarness): number =>
  h.deps.driver.profitForDay(MERCHANT_A, today(h));

async function move(h: UiHarness, cookie: string, csrfToken: string, birr: number): Promise<boolean> {
  const { envelope } = await callWith(h.api, 'POST', '/api/training/profit/transfers', {
    cookie,
    body: { csrfToken, amountBirr: birr },
  });
  return envelope.ok;
}

describe('collecting profit does not report a loss', () => {
  it('leaves today’s earnings unchanged after a transfer', async () => {
    harness = makeUiHarness('today-profit-transfer', { fundBirr: 900 });
    await earnProfit(harness, 4, 'req_earn'); // 4 birr earned
    const earned = todayProfit(harness);
    expect(earned).toBe(400);

    const owner = await asOwner(harness);
    expect(await move(harness, owner.cookieHeader, owner.csrfToken, 4)).toBe(true);

    // The money moved buckets. It was still earned today.
    expect(todayProfit(harness)).toBe(earned);
    expect(harness.deps.driver.profitAvailableMinor(MERCHANT_A)).toBe(0);
  });

  it('never goes negative, however many times profit is collected', async () => {
    // The reported sequence: collect, then collect again.
    harness = makeUiHarness('today-profit-repeat', { fundBirr: 900 });
    await earnProfit(harness, 4, 'req_earn');
    const owner = await asOwner(harness);

    for (let i = 0; i < 4; i += 1) {
      await move(harness, owner.cookieHeader, owner.csrfToken, 1);
      expect(todayProfit(harness), `after ${i + 1} transfer(s)`).toBe(400);
    }
    expect(todayProfit(harness)).toBeGreaterThanOrEqual(0);
  });

  it('still counts profit earned after a transfer', async () => {
    // The exclusion must not swallow later earnings on the same day.
    harness = makeUiHarness('today-profit-then-earn', { fundBirr: 900 });
    await earnProfit(harness, 4, 'req_earn_1');
    const owner = await asOwner(harness);
    await move(harness, owner.cookieHeader, owner.csrfToken, 4);

    await earnProfit(harness, 4, 'req_earn_2');
    expect(todayProfit(harness)).toBe(800);
  });

  it('keeps the ledger balanced throughout', async () => {
    harness = makeUiHarness('today-profit-ledger', { fundBirr: 900 });
    await earnProfit(harness, 4, 'req_earn');
    const owner = await asOwner(harness);
    await move(harness, owner.cookieHeader, owner.csrfToken, 4);
    // The figure changed how it is *read*, never what was posted.
    expect(harness.deps.driver.ledgerResidualMinor()).toBe(0);
  });
});

describe('what still reduces today’s profit', () => {
  it('excludes only ADJUSTMENT, so a reversal still counts', () => {
    // The distinction that makes this a fix rather than a cover-up. Excluding
    // every debit would have been simpler and would have made a **reversal**
    // invisible — leaving the dashboard reporting profit on a sale that was
    // taken back.
    //
    // Asserted against the query itself rather than by driving a reversal
    // through the approval flow. That is deliberate and it is the honest
    // trade: an end-to-end reversal here would need an OPS_APPROVER session
    // and a second approval, and the thing actually at risk is somebody
    // widening one SQL predicate. A runtime assertion that re-checks an
    // unchanged number would pass whatever the predicate said — which is the
    // kind of test that reads as coverage and proves nothing.
    const source = readFileSync(
      resolve(process.cwd(), 'packages/persistence/src/repositories/ledger.ts'),
      'utf-8',
    );
    const query = source.slice(
      source.indexOf('export function profitForDay'),
      source.indexOf('export function profitAvailableMinor'),
    );
    expect(query).toContain("entry_type <> 'ADJUSTMENT'");
    // A transfer is the only thing that should be filtered out. If any of
    // these appear in the exclusion, real money movement has been hidden.
    for (const reason of ['REVERSAL', 'COMMISSION_CREDIT', 'FEE_DEBIT']) {
      expect(query, `${reason} must still count toward the day`).not.toContain(reason);
    }
    // And it must not have become a blanket "credits only" sum.
    expect(query).not.toMatch(/direction\s*=\s*'CREDIT'/);
  });
});
