/**
 * Settings, and the profit they govern.
 *
 * Two things are being pinned here. First, that a setting is a merchant's and
 * only a merchant's — owner-only to change, never readable across shops.
 * Second, and more important, that changing the training profit rate is
 * **forward-looking**: it changes what the next sale credits and can never
 * restate what an earlier sale already earned, because each ledger entry
 * carries the rate that was in force when it was written.
 */

import { describe, expect, it } from 'vitest';
import {
  DEVICE_B,
  MERCHANT_B,
  OPERATOR_B,
  MERCHANT_A,
  OWNER_USER,
  TEST_PIN,
  callWith,
  makeUiHarness,
  seedSale,
  signInAs,
} from '../auth/helpers';
import type { SettingsDto } from '@telga/api';
import { trainingProfitMinor, DEFAULT_TRAINING_PROFIT_BPS } from '@telga/domain';

const asOwner = (api: Parameters<typeof signInAs>[0]) =>
  signInAs(api, { userId: OWNER_USER, role: 'MERCHANT_OWNER', pin: TEST_PIN });

describe('reading settings', () => {
  it('answers with documented defaults for a merchant that has never saved any', async () => {
    const h = makeUiHarness('settings-defaults');
    const session = await signInAs(h.api);
    const { response, envelope } = await callWith<SettingsDto>(h.api, 'GET', '/api/training/settings', {
      cookie: session.cookieHeader,
    });

    expect(response.status).toBe(200);
    if (!envelope.ok) throw new Error('expected settings');
    expect(envelope.data.slipSize).toBe('80');
    expect(envelope.data.slipAdvert).toBe('');
    expect(envelope.data.profitBps).toBe(DEFAULT_TRAINING_PROFIT_BPS);
    h.cleanup();
  });

  it('lets an operator read them, because a slip has to print', async () => {
    const h = makeUiHarness('settings-operator-read');
    const session = await signInAs(h.api);
    const { response } = await callWith(h.api, 'GET', '/api/training/settings', {
      cookie: session.cookieHeader,
    });
    expect(response.status).toBe(200);
    h.cleanup();
  });
});

describe('writing settings', () => {
  it('refuses an operator, and changes nothing when it does', async () => {
    const h = makeUiHarness('settings-operator-write');
    const session = await signInAs(h.api);

    const { response } = await callWith(h.api, 'POST', '/api/training/settings', {
      cookie: session.cookieHeader,
      body: { csrfToken: session.csrfToken, slipSize: '58', profitPercent: '90' },
    });
    expect(response.status).toBe(403);

    const after = await callWith<SettingsDto>(h.api, 'GET', '/api/training/settings', {
      cookie: session.cookieHeader,
    });
    if (!after.envelope.ok) throw new Error('expected settings');
    expect(after.envelope.data.slipSize).toBe('80');
    expect(after.envelope.data.profitBps).toBe(DEFAULT_TRAINING_PROFIT_BPS);
    h.cleanup();
  });

  it('accepts an owner and stores what was sent', async () => {
    const h = makeUiHarness('settings-owner-write');
    const session = await asOwner(h.api);

    const { response, envelope } = await callWith<SettingsDto>(h.api, 'POST', '/api/training/settings', {
      cookie: session.cookieHeader,
      body: {
        csrfToken: session.csrfToken,
        slipSize: '58',
        slipAdvert: 'Bring this slip back for a free coffee',
        profitPercent: '6.5',
      },
    });

    expect(response.status).toBe(200);
    if (!envelope.ok) throw new Error('expected settings');
    expect(envelope.data.slipSize).toBe('58');
    expect(envelope.data.slipAdvert).toBe('Bring this slip back for a free coffee');
    expect(envelope.data.profitBps).toBe(650);
    expect(envelope.data.profitPercent).toBe(6.5);
    h.cleanup();
  });

  it('leaves a field alone when the form does not carry it', async () => {
    const h = makeUiHarness('settings-partial');
    const session = await asOwner(h.api);

    await callWith(h.api, 'POST', '/api/training/settings', {
      cookie: session.cookieHeader,
      body: { csrfToken: session.csrfToken, slipSize: '58', profitPercent: '7' },
    });
    // A second form that only knows about the advertisement.
    const { envelope } = await callWith<SettingsDto>(h.api, 'POST', '/api/training/settings', {
      cookie: session.cookieHeader,
      body: { csrfToken: session.csrfToken, slipAdvert: 'Open until 9pm' },
    });

    if (!envelope.ok) throw new Error('expected settings');
    expect(envelope.data.slipAdvert).toBe('Open until 9pm');
    expect(envelope.data.slipSize, 'the slip size must survive a form that never showed it').toBe('58');
    expect(envelope.data.profitBps).toBe(700);
    h.cleanup();
  });

  it('refuses a slip size, an advertisement and a percentage it does not recognise', async () => {
    const h = makeUiHarness('settings-invalid');
    const session = await asOwner(h.api);
    const post = (body: Record<string, unknown>) =>
      callWith(h.api, 'POST', '/api/training/settings', {
        cookie: session.cookieHeader,
        body: { csrfToken: session.csrfToken, ...body },
      });

    expect((await post({ slipSize: '110' })).response.status).toBe(400);
    expect((await post({ profitPercent: '101' })).response.status).toBe(400);
    expect((await post({ profitPercent: '-1' })).response.status).toBe(400);
    expect((await post({ profitPercent: 'four' })).response.status).toBe(400);
    expect((await post({ slipAdvert: 'x'.repeat(200) })).response.status).toBe(400);
    h.cleanup();
  });

  it('keeps one shop out of another shop settings', async () => {
    const h = makeUiHarness('settings-isolation', { seedSecondMerchant: true });
    const owner = await asOwner(h.api);
    await callWith(h.api, 'POST', '/api/training/settings', {
      cookie: owner.cookieHeader,
      body: { csrfToken: owner.csrfToken, slipAdvert: 'Alpha shop' },
    });

    const other = await signInAs(h.api, {
      userId: OPERATOR_B,
      merchantId: MERCHANT_B,
      deviceId: DEVICE_B,
      role: 'MERCHANT_OWNER',
    });
    const { envelope } = await callWith<SettingsDto>(h.api, 'GET', '/api/training/settings', {
      cookie: other.cookieHeader,
    });
    if (!envelope.ok) throw new Error('expected settings');
    expect(envelope.data.slipAdvert, 'beta must not see alpha advertising line').toBe('');
    h.cleanup();
  });
});

describe('the profit calculation itself', () => {
  it('is a rounded percentage of face value, in minor units', () => {
    expect(trainingProfitMinor(10_000, 400)).toBe(400);
    expect(trainingProfitMinor(2500, 400)).toBe(100);
    expect(trainingProfitMinor(1000, 400)).toBe(40);
    // 33 birr at 4% is 1.32 birr — a whole number of cents, not a fraction.
    expect(trainingProfitMinor(3300, 400)).toBe(132);
    // Half a cent rounds rather than truncating toward zero.
    expect(trainingProfitMinor(125, 400)).toBe(5);
  });

  it('is zero at a zero rate, and never negative', () => {
    expect(trainingProfitMinor(10_000, 0)).toBe(0);
    expect(trainingProfitMinor(-500, 400)).toBe(0);
  });

  it('refuses a rate outside 0–100%', () => {
    expect(() => trainingProfitMinor(10_000, 10_001)).toThrow();
    expect(() => trainingProfitMinor(10_000, -1)).toThrow();
  });
});

describe('changing the rate', () => {
  /**
   * The invariant this whole file exists for. A shop that raises its training
   * margin on Tuesday has not retroactively earned more on Monday, and the
   * ledger must not be able to say otherwise — which is why the day's profit
   * is summed from entries rather than recomputed from the current setting.
   */
  it('changes the next sale and cannot restate an earlier one', async () => {
    const h = makeUiHarness('profit-rate-change');
    const owner = await asOwner(h.api);
    const today = h.deps.now().slice(0, 10);

    await seedSale(h);
    const afterFirst = h.deps.driver.profitForDay(MERCHANT_A, today);
    expect(afterFirst).toBeGreaterThan(0);

    await callWith(h.api, 'POST', '/api/training/settings', {
      cookie: owner.cookieHeader,
      body: { csrfToken: owner.csrfToken, profitPercent: '10' },
    });

    // The first sale's credit is untouched by the new rate.
    expect(h.deps.driver.profitForDay(MERCHANT_A, today)).toBe(afterFirst);

    await seedSale(h, { clientRequestId: 'req_second_sale' });
    const afterSecond = h.deps.driver.profitForDay(MERCHANT_A, today);
    const secondCredit = afterSecond - afterFirst;

    // The second sale earned at the new rate, not the old one.
    expect(secondCredit).toBeGreaterThan(afterFirst);
    expect(h.deps.driver.ledgerResidualMinor()).toBe(0);
    h.cleanup();
  });

  it('records the rate on the entry, so an old credit can be explained', async () => {
    const h = makeUiHarness('profit-rule-version');
    await seedSale(h);
    const entries = h.deps.driver.readEntriesByMerchant(MERCHANT_A);
    const profit = entries.filter((entry) => entry.account_type === 'TELGA_REVENUE');
    expect(profit.length).toBe(1);
    expect(profit[0]?.rule_version).toMatch(/^training-profit-\d+bps$/);
    h.cleanup();
  });
});
