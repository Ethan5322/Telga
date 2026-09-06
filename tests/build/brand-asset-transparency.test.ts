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

describe('the launcher button', () => {
  it('draws its own ground rather than relying on the image having one', () => {
    // The ground is the button's, not the mark's. If it ever moved into the
    // artwork, the same file could no longer sit on a slip or an icon.
    const css = readFileSync(
      resolve(process.cwd(), 'apps/merchant-pos/src/ui/document.ts'),
      'utf-8',
    );
    const rule = css.slice(css.indexOf('.launcher__telga {'), css.indexOf('.launcher__telga:hover'));
    expect(rule).toContain('radial-gradient');
    expect(rule).toContain('border: 1px solid');
  });

  it('puts no background behind the image itself', () => {
    // The wrapper holds the mark and nothing else: a background here would put
    // a visible box around a transparent PNG, which is what "not transparent"
    // would actually look like.
    const css = readFileSync(
      resolve(process.cwd(), 'apps/merchant-pos/src/ui/document.ts'),
      'utf-8',
    );
    const start = css.indexOf('.launcher__telga-icon {');
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(start, css.indexOf('}', start));
    expect(rule).not.toContain('background');
  });
});
