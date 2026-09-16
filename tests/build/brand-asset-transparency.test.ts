/**
 * The Telga mark has a transparent background, and keeps it.
 *
 * Reported on 2026-08-30 as "the background is not transparent". Measured: it
 * is — 508,160 of 688,040 pixels sit at alpha 0 and all four corners are fully
 * clear. What reads as a background is the launcher button's own radial ground,
 * which was asked for and kept.
 *
 * So this test is not a fix; it is a guard. The mark is a raster file produced
 * by `scripts/brand/build-logo.py`, and the single most likely way to break it
 * is a re-export that flattens alpha onto white — which would look correct on a
 * white page and wrong everywhere Telga actually puts it: the dark launcher
 * ground, a thermal slip, and a maskable app icon.
 *
 * It reads the PNG's bytes directly rather than decoding the image, so it needs
 * no image library and cannot be defeated by one.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ASSETS = resolve(process.cwd(), 'apps/merchant-pos/assets');

/** The PNG `IHDR` colour type, which says whether an alpha channel exists. */
function colourType(file: string): number {
  const bytes = readFileSync(resolve(ASSETS, file));
  // 8-byte signature, then a 4-byte length and the 'IHDR' tag; the colour type
  // is the 10th byte of the chunk's data.
  expect(bytes.subarray(1, 4).toString('ascii'), `${file} is not a PNG`).toBe('PNG');
  expect(bytes.subarray(12, 16).toString('ascii'), `${file} has no IHDR`).toBe('IHDR');
  return bytes[25];
}

// PNG colour types: 4 = greyscale+alpha, 6 = truecolour+alpha.
const WITH_ALPHA = new Set([4, 6]);

describe('the mark', () => {
  it('is stored with an alpha channel', () => {
    // A re-export to colour type 2 (truecolour, no alpha) is the exact mistake
    // this catches: it looks identical on a white background and loses the
    // cut-out everywhere else.
    expect(WITH_ALPHA.has(colourType('telga-logo.png'))).toBe(true);
  });

  it('keeps alpha on the launcher’s app tiles', () => {
    for (const file of ['app-vending.png', 'app-pay.png']) {
      expect(WITH_ALPHA.has(colourType(file)), `${file} lost its alpha`).toBe(true);
    }
  });

  it('keeps alpha on the maskable icons, where it matters most', () => {
    // A launcher may crop a maskable icon to a circle. Without alpha the
    // corners survive as opaque squares and the crop shows them.
    for (const file of ['icon-maskable-512.png', 'icon-maskable-192.png']) {
      expect(WITH_ALPHA.has(colourType(file)), `${file} lost its alpha`).toBe(true);
    }
  });
});

describe('the surfaces that draw the mark supply their own ground', () => {
  /**
   * These two tests watched `.launcher__telga` — the single-button launcher
   * screen — until D168 removed it on 2026-09-15 and its CSS was deleted on
   * 2026-09-16.
   *
   * The property is unchanged and still matters: **the ground belongs to the
   * surface, not to the artwork.** If a ground ever moved into the PNG, the
   * same file could no longer sit on a slip, on a dark screen, and inside a
   * maskable icon — which is the whole reason it carries alpha.
   *
   * Re-homed to the lock screen, which is where the mark is drawn on a dark
   * ground today.
   */
  const css = (): string =>
    readFileSync(resolve(process.cwd(), 'apps/merchant-pos/src/ui/document.ts'), 'utf-8');

  it('draws the lock screen ground rather than relying on the image having one', () => {
    const sheet = css();
    const start = sheet.indexOf('.lock {');
    expect(start, 'the lock screen must still style its own ground').toBeGreaterThan(-1);
    const rule = sheet.slice(start, sheet.indexOf('}', start));
    // A dark ground the mark sits on, owned by the screen.
    expect(rule).toMatch(/background/);
  });

  it('puts no background behind the image itself', () => {
    // The wrapper holds the mark and nothing else: a background here would put
    // a visible box around a transparent PNG, which is what "not transparent"
    // would actually look like.
    const sheet = css();
    const start = sheet.indexOf('.lock__mark {');
    expect(start, '.lock__mark must exist to hold the mark').toBeGreaterThan(-1);
    const rule = sheet.slice(start, sheet.indexOf('}', start));
    expect(rule).not.toContain('background');
  });

  it('keeps no stylesheet for the launcher button that was removed', () => {
    // The other half of the same lesson. Dead CSS ships to a shop's phone on
    // every page load, and a reader who finds a rule for a deleted screen
    // reasonably concludes the screen is still there.
    //
    // **Comments are stripped first**, because `document.ts` carries a note
    // recording that these rules were removed — and a guard that reads prose
    // matches its own documentation. That has now happened three times in one
    // day on three different guards, so it is worth saying plainly: a guard
    // must read the code, never the writing about the code.
    const withoutComments = css().replace(/\/\*[\s\S]*?\*\//g, '');
    expect(withoutComments).not.toContain('.launcher__telga');
  });
});
