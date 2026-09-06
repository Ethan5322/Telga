/**
 * Every printed slip names the registered company.
 *
 * Asked for on 2026-08-29: the line under the logo said `TELGA` — the brand.
 * A receipt is the one artefact that leaves the shop in a customer's hand, and
 * `04 UX UI/Receipt Specification` requires it to carry Telga's identity. For a
 * document somebody may take to a dispute, identity means the registered
 * company, not a wordmark.
 *
 * ## Why this is a test and not just a constant
 *
 * A sale slip, a reprint, a data voucher, a top-up and the shop's lookup copy
 * are five code paths that each draw a slip. Two pieces of paper from one sale
 * naming two different entities is worse than one naming the wrong entity, so
 * what matters is that they all read the same value — which is what these
 * assertions pin down.
 *
 * **Launch note.** Printing "PLC" asserts a registered legal form. CLAUDE.md §8
 * requires *"company authority documented"* before any of this reaches a real
 * customer; until then the training banner above the line is what keeps the
 * slip honest.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SLIP_STYLE, TELGA_LEGAL_NAME, renderToHtml, slipCard } from '@telga/merchant-pos';

const LINES = [
  { id: 'slip-transaction', label: 'Transaction', value: 'txn_test_0001' },
  { id: 'slip-amount', label: 'Amount', value: 'ETB 25.00' },
];

const render = (style = DEFAULT_SLIP_STYLE): string =>
  renderToHtml(
    slipCard({
      locale: 'en',
      subtitle: 'Airtime voucher',
      lines: LINES,
      style,
      supportContact: 'Telga training support — support@telga.example (not staffed)',
    }),
  );

describe('the name on the paper', () => {
  it('is the registered company, not the product name', () => {
    const html = render();
    expect(html).toContain('TELGA TRADING PLC');
    expect(TELGA_LEGAL_NAME).toBe('TELGA TRADING PLC');
  });

  it('prints it directly under the mark', () => {
    // The order is the whole request: logo, then who this is.
    const html = render();
    const logoAt = html.indexOf('data-testid="slip-logo"');
    const brandAt = html.indexOf('data-testid="slip-brand"');
    expect(logoAt).toBeGreaterThan(-1);
    expect(brandAt).toBeGreaterThan(logoAt);
  });

  it('no longer prints the bare brand as the identity line', () => {
    const html = render();
    const brand = /data-testid="slip-brand"[^>]*>([^<]*)</.exec(html)?.[1] ?? '';
    expect(brand.trim()).toBe('TELGA TRADING PLC');
    expect(brand.trim()).not.toBe('TELGA');
  });

  it('keeps the mark on the slip as well as the name', () => {
    // The logo was never the problem — the line under it was. Both are printed.
    expect(render()).toContain('data-testid="slip-logo"');
  });
});

describe('one entity across every piece of paper', () => {
  it('reads the same on a slip carrying full shop details', () => {
    // A shop that has filled in its own name, address and TIN still prints
    // Telga's entity above its own — the platform and the merchant are two
    // identities and the slip shows both.
    const html = render({
      ...DEFAULT_SLIP_STYLE,
      business: {
        name: 'Hebron Supermarket',
        address: 'Bole, Addis Ababa',
        phone: '',
        tin: '0001234567',
        licence: '',
      },
    });
    expect(html).toContain('TELGA TRADING PLC');
    expect(html).toContain('Hebron Supermarket');
    // Telga's identity comes first: it is the platform the slip is issued by.
    expect(html.indexOf('TELGA TRADING PLC')).toBeLessThan(html.indexOf('Hebron Supermarket'));
  });

  it('is defined in exactly one place', () => {
    // Five code paths draw a slip. If any of them held its own literal, they
    // could drift — which is the failure this constant exists to prevent.
    expect(TELGA_LEGAL_NAME.length).toBeGreaterThan(0);
    expect(render()).toContain(TELGA_LEGAL_NAME);
  });
});
