/**
 * The balance, printed once.
 *
 * `DESIGN.md`: *"The balance leads. The available figure is the largest thing on
 * the merchant home screen, **its unit rubricated and set small beside it**."*
 *
 * Two screens implemented that by rendering the preformatted amount and then
 * appending `balance.available.currency` in a `.balance__unit` span. But the
 * domain's `format()` already ends every figure with its currency, so both
 * printed it twice:
 *
 *     Balance
 *     100.00 ETB ETB
 *
 * On the Telga Vending dashboard that is the single number a shopkeeper opens
 * this app to read, and on `/home` it is the lead figure of the balance card.
 * Nothing caught it because every assertion nearby checks `toContain('ETB')`,
 * which a doubled unit satisfies twice over.
 *
 * These tests hold the property the screens actually need: **one figure, one
 * unit**, whatever the formatter does next.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_BEHAVIOURS } from '@telga/provider-mock-airtime';
import { authenticate } from '@telga/api';
import { dashboardScreen, renderToHtml, renderScreen, splitAmount } from '@telga/merchant-pos';
import type { Chrome, PosServerOptions } from '@telga/merchant-pos';
import { makeUiHarness, signInAs } from '../auth/helpers';
import type { UiHarness } from '../auth/helpers';

let harness: UiHarness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

function optionsFor(h: UiHarness): PosServerOptions {
  return {
    api: h.api,
    environment: 'test',
    catalog: [
      { productId: 'AIRTIME', label: 'Airtime 25 (simulated)', amountMinor: 2500, available: true },
    ],
    voucherCatalog: [],
    voucherNetworks: [],
    simulatedBehaviours: [...MOCK_BEHAVIOURS],
  };
}

async function screenAt(h: UiHarness, path: string): Promise<string> {
  const session = await signInAs(h.api);
  const auth = authenticate(h.api, session.sessionToken, 'corr_lead_figure');
  if (!auth.ok) throw new Error(`Fixture session refused: ${auth.code}`);
  const screen = await renderScreen(optionsFor(h), {
    path,
    query: new URLSearchParams(),
    context: auth.context,
    cookieHeader: session.cookieHeader,
    csrfToken: session.csrfToken,
  });
  return screen?.html ?? '';
}

describe('splitting a formatted amount', () => {
  it('takes the currency off the end and hands it back separately', () => {
    expect(splitAmount('100.00 ETB')).toEqual({ figure: '100.00', unit: 'ETB' });
    expect(splitAmount('1,250.00 ETB')).toEqual({ figure: '1,250.00', unit: 'ETB' });
    expect(splitAmount('-25.50 ETB')).toEqual({ figure: '-25.50', unit: 'ETB' });
  });

  it('leaves a figure with no unit alone rather than guessing one', () => {
    // Not every caller's string comes from `format()`. One that carries no
    // currency has nothing to rubricate, and inventing a unit for a bare number
    // would be worse than printing it plain.
    expect(splitAmount('100.00')).toEqual({ figure: '100.00', unit: '' });
    expect(splitAmount('')).toEqual({ figure: '', unit: '' });
  });

  it('does not mistake the last word of a sentence for a currency', () => {
    // The split is on the last space, so the guard is the shape of what follows
    // it: two to four letters, which is what an ISO code is and what an English
    // word usually is not.
    expect(splitAmount('not yet available').unit).toBe('');
    expect(splitAmount('100.00 birr').unit).toBe('birr');
  });
});

describe('the lead figure prints its unit exactly once', () => {
  /** Every run of `ETB` in the balance element, doubled unit included. */
  const unitsIn = (html: string, testId: string): number => {
    const at = html.indexOf(`data-testid="${testId}"`);
    if (at === -1) return -1;
    const element = html.slice(at, html.indexOf('</p>', at) + 4);
    return (element.match(/ETB/g) ?? []).length;
  };

  it('on the Telga Vending dashboard', async () => {
    harness = makeUiHarness('lead-figure-dashboard');
    const html = await screenAt(harness, '/dashboard');

    expect(html).toContain('data-testid="dashboard-balance"');
    expect(unitsIn(html, 'dashboard-balance-pill'), 'the balance printed "100.00 ETB ETB"').toBe(1);
    // And the one that survives is the rubricated one, not the formatter's.
    expect(html).toMatch(/class="balance__unit">ETB</);
  });

  it('on the balance card', async () => {
    harness = makeUiHarness('lead-figure-balance');
    const html = await screenAt(harness, '/home');

    expect(html).toContain('data-testid="balance-available"');
    expect(unitsIn(html, 'balance-available'), 'the lead figure printed its unit twice').toBe(1);
  });
});

describe('hiding the balance changes what it says, not how the screen is built', () => {
  /**
   * A shop that does not want its float readable by a queue turns `hideBalance`
   * on, and the figure goes behind a `<details>` one tap away.
   *
   * **Nothing tested that setting at all.** It rendered a single inline run —
   * `Balance ••••••` — inside `.dashboard__hidden`, a class with no rule
   * anywhere in the stylesheet. So a shop with the setting on saw a body-size
   * line where every other shop saw a small uppercase caption above a 2rem
   * figure: one setting, two different screens, and the more private one was
   * the one that looked unfinished.
   *
   * Rendered as a pure function rather than through the server, because the
   * setting reaches the screen through a settings write and the property under
   * test belongs to the screen.
   */
  const CHROME: Chrome = {
    locale: 'en',
    environment: 'test',
    merchantId: 'merchant_alpha',
    mode: 'TRAINING',
    serverTime: '2026-09-16T00:00:00.000Z',
  };

  const BALANCE = {
    status: 'READY',
    data: {
      available: { amountMinor: 10_000, currency: 'ETB', formatted: '100.00 ETB' },
      reserved: { amountMinor: 0, currency: 'ETB', formatted: '0.00 ETB' },
      underReview: { amountMinor: 0, currency: 'ETB', formatted: '0.00 ETB' },
    },
  } as Parameters<typeof dashboardScreen>[0]['balance'];

  const render = (hideBalance: boolean): string =>
    renderToHtml(dashboardScreen({ chrome: CHROME, balance: BALANCE, hideBalance }));

  it('uses the same caption and figure whether hidden or shown', () => {
    for (const hidden of [true, false]) {
      const html = render(hidden);
      expect(html, `hidden=${hidden} lost the caption`).toContain('dashboard__balance-caption');
      expect(html, `hidden=${hidden} lost the figure`).toContain('dashboard__balance-figure');
    }
  });

  it('names no class the stylesheet has no rule for', () => {
    // `.dashboard__hidden` was rendered on every hidden-balance screen and
    // styled nowhere. A class with no rule is a layout decision nobody made.
    expect(render(true)).not.toContain('dashboard__hidden');
  });

  it('keeps the figure behind the reveal, and prints its unit once there too', () => {
    const html = render(true);
    expect(html).toContain('data-testid="balance-hidden"');
    expect(html).toContain('••••••');
    const revealed = html.slice(html.indexOf('data-testid="balance-revealed"'));
    expect((revealed.slice(0, 120).match(/ETB/g) ?? []).length).toBe(1);
    // And the figure is not in the markup twice — hidden means one copy, behind
    // the summary, not a second one the page also draws.
    expect((html.match(/100\.00/g) ?? []).length).toBe(1);
  });
});
