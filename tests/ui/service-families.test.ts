/**
 * Colour that can be read — the service families.
 *
 * Founder, 2026-09-16: *"each button by different colour… make published items
 * easier to spot and keep our existing brand colors and add colours."*
 *
 * ## Why this is not the pastels again
 *
 * Ten pastels were given one-per-tile on 2026-08 and removed on 2026-09-13,
 * with the reason recorded in the stylesheet: *"They encoded nothing: no tile's
 * meaning could be read from its colour, so the rainbow was decoration carrying
 * a tenth of a palette each."*
 *
 * That judgment stands. What changed is that a hue now names a **family** and
 * its strength names **availability**, so both axes can be read. Fourteen of
 * sixteen services are `COMING_SOON`; finding the two that work is the job the
 * founder actually described, and it is the strength axis that does it.
 *
 * These tests hold the two properties that keep it honest: **every ink has a
 * family to name**, and **colour is never the only carrier**.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VELLUM } from '@telga/design-system';

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf-8');

/** Source with comments removed — a guard reads the code, not the prose. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const DASHBOARD = withoutComments(read('apps/merchant-pos/src/ui/dashboard.ts'));
const STYLES = (): string => {
  const source = read('apps/merchant-pos/src/ui/document.ts');
  const at = source.indexOf('const STYLES');
  const open = source.indexOf('= `', at) + 3;
  return withoutComments(source.slice(open, source.indexOf('`;', open)));
};

// --- WCAG, computed rather than asserted from memory ------------------------

const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

function luminance(hex: string): number {
  const v = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The three inks added on 2026-09-16, and the three already in service. */
const FAMILY_INKS = {
  sell: VELLUM.rubric,
  utility: VELLUM.verdigris,
  official: VELLUM.indigo,
  media: VELLUM.plum,
  money: VELLUM.ochreInk,
  transport: VELLUM.sienna,
} as const;

describe('the new inks are legible where they are actually used', () => {
  /**
   * A family ink fills the icon chip of a working service and carries the
   * label's ground colour on top of it. So the pairing that has to pass is the
   * **pale ground on the ink**, not the ink on the page.
   */
  it('carries the pale ground on every family fill at 4.5:1 or better', () => {
    const failures: string[] = [];
    for (const [family, ink] of Object.entries(FAMILY_INKS)) {
      const ratio = contrast(VELLUM.groundPale, ink);
      if (ratio < 4.5) failures.push(`${family} (${ink}): ${ratio.toFixed(2)}:1`);
    }
    expect(
      failures,
      'a glyph on a filled chip is body-sized text and needs the body floor',
    ).toEqual([]);
  });

  it('stays visible as a ring on the sunken ground at 3:1 or better', () => {
    // A Coming Soon chip holds the family ink as a hairline ring on
    // `groundDeep`. That is a non-text control boundary: 3:1.
    const failures: string[] = [];
    for (const [family, ink] of Object.entries(FAMILY_INKS)) {
      const ratio = contrast(VELLUM.groundDeep, ink);
      if (ratio < 3) failures.push(`${family} (${ink}): ${ratio.toFixed(2)}:1`);
    }
    expect(failures).toEqual([]);
  });

  /**
   * **A limit of the design, stated rather than hidden.**
   *
   * The first version of this test required every pair of family inks to differ
   * in lightness, so the families would survive a monochrome screen. Seven of
   * the fifteen pairs failed — `sell` and `utility` differ by 1.04:1.
   *
   * That is not a defect to fix; it is arithmetic. Every family ink has to
   * clear 4.5:1 against the pale ground, which caps its luminance at about
   * 0.12. Six colours inside a band that narrow **cannot** be told apart by
   * lightness, and widening it would mean an ink a glyph could not sit on.
   *
   * The resolution is that families do not need to survive monochrome. **The
   * label does that** — a tile says "Electricity", and a shopkeeper reading it
   * loses nothing if the chip's hue is unavailable to them. Hue is a grouping
   * aid, never the carrier.
   *
   * What *must* survive monochrome is **availability**, and it does: a working
   * service is filled where a Coming Soon one holds a ring, and says so in
   * words. That is tested below, and that is where §22's rule actually bites.
   */
  it('gives each family its own ink, even where lightness cannot separate them', () => {
    const inks = Object.values(FAMILY_INKS);
    expect(
      new Set(inks).size,
      'two families sharing one hex would be one family wearing two names',
    ).toBe(inks.length);
  });

  it('keeps every family ink inside the band its contrast floor allows', () => {
    // The band that makes lightness separation impossible, asserted so the
    // limitation is visible rather than folklore: raise one above this and the
    // glyph on the filled chip stops being readable.
    for (const [family, ink] of Object.entries(FAMILY_INKS)) {
      expect(luminance(ink), `${family} would fail on the pale ground`).toBeLessThan(0.125);
    }
  });
});

describe('every ink has a family, and every family has an ink', () => {
  /**
   * The failure that produced this test: `sienna` was added to the palette and
   * then never assigned, because `traffic` had gone to `official` and `fuel` to
   * `utility`. A new colour nothing could ever draw is exactly what the pastels
   * were removed for — reintroduced in one step, while writing the note
   * explaining why it must not be.
   */
  it('draws every family ink the stylesheet declares', () => {
    const css = STYLES();
    for (const family of Object.keys(FAMILY_INKS)) {
      expect(css, `no rule paints the ${family} family`).toContain(`data-family="${family}"`);
      expect(DASHBOARD, `no tile belongs to the ${family} family`).toContain(`family: '${family}'`);
    }
  });

  it('leaves no tile without a family', () => {
    // A tile with no family has no `--family-ink`, falls back to plain ink, and
    // silently reads as a sixth family of one.
    const ids = [...DASHBOARD.matchAll(/\{ id: '([a-z]+)',/g)].map((m) => m[1]);
    const families = [...DASHBOARD.matchAll(/family: '([a-z]+)'/g)].map((m) => m[1]);

    expect(ids.length, 'the tile list should be the sixteen services').toBeGreaterThan(10);
    expect(families.length, 'every tile carries a family').toBe(ids.length);
    for (const family of new Set(families)) {
      expect(Object.keys(FAMILY_INKS), `${family} has no ink`).toContain(family);
    }
  });

  it('keeps no trace of the pastels it replaced', () => {
    // `colour: 'purple'` and friends sat in the data for three days after the
    // CSS that drew them was deleted.
    expect(DASHBOARD).not.toMatch(/colour:\s*'/);
    expect(STYLES()).not.toContain('dashboard__tile--');
  });
});

describe('colour is never the only carrier', () => {
  /**
   * §22: status is text **plus** icon **plus** colour, never colour alone. A
   * shopkeeper who cannot separate green from red must still see which two
   * tiles work.
   */
  /**
   * **The failure this test was written wrong for, and what it now does.**
   *
   * The first version of it read the stylesheet, pulled the block for
   * `[data-status="AVAILABLE"]`, and asserted that block filled the chip with
   * the family ink. It did. It passed for a day.
   *
   * The markup has never said `AVAILABLE`. `ServiceStatus` is
   * `'IMPLEMENTED' | 'COMING_SOON'`, `serviceTileEl` writes it straight into the
   * attribute, and so the two rules that pick out Vouchers and Airtime — the
   * only two services that work — **matched nothing**. They shipped drawn like
   * the fourteen that do not. The entire point of the colour pass was making
   * those two findable, and a green test sat on top of it.
   *
   * This repository has now recorded the same lesson six times: *a guard must
   * read the code, never the prose about the code.* This was a seventh shape of
   * it — the guard read **one half** of the code and never checked that the
   * other half agreed. So the test starts from the statuses the **source emits**
   * and requires a rule for each, which is a question the stylesheet cannot
   * answer on its own.
   */
  it('draws every status the dashboard actually emits', () => {
    const css = STYLES();
    const emitted = [...new Set([...DASHBOARD.matchAll(/status: '([A-Z_]+)'/g)].map((m) => m[1]))];

    expect(emitted.length, 'the source should emit at least two statuses').toBeGreaterThan(1);
    for (const status of emitted) {
      expect(
        css,
        `the dashboard renders data-status="${status}" and no rule matches it`,
      ).toContain(`[data-status="${status}"]`);
    }

    // And nothing in the stylesheet may select a status the source never emits:
    // a rule matching nothing is the defect above, wearing the other hat.
    const selected = [...new Set([...css.matchAll(/\[data-status="([A-Z_]+)"\]/g)].map((m) => m[1]))];
    for (const status of selected) {
      expect(emitted, `the stylesheet paints data-status="${status}", which nothing renders`).toContain(status);
    }
  });

  it('separates a working service from a coming-soon one by fill, not only by hue', () => {
    const css = STYLES();
    const working = /\[data-status="IMPLEMENTED"\] \.dashboard__tile-icon \{([^}]*)\}/.exec(css)?.[1] ?? '';
    const soon = /\[data-status="COMING_SOON"\] \.dashboard__tile-icon \{([^}]*)\}/.exec(css)?.[1] ?? '';

    expect(working, 'a working service is filled with its family ink').toContain('--family-ink');
    expect(soon, 'a coming-soon service holds a ring instead').toContain('inset');
    // The shape difference survives a monochrome screen; the hue does not.
    expect(soon).toContain('ground-deep');
  });

  it('still says Coming Soon in words', () => {
    // The text carrier. Without it, the whole scheme is colour and shape only.
    expect(DASHBOARD).toContain('screen.coming_soon');
  });
});
