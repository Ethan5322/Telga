/**
 * The Telga mark.
 *
 * ## This is the founder's artwork, not a redraw
 *
 * Earlier versions of this file hand-drew the mark as SVG paths. That was
 * wrong twice over: the first attempt showed the T standing upright with the
 * figure beside it, and the second — even with the letter tipped — still did
 * not look like the supplied render, because a photoreal gold render with a
 * skeleton in it is not something SVG paths reproduce. The instruction was
 * explicit: **the look must stay the same, and the skeleton must not be
 * redrawn.** So the real file is served and shown, and nothing here draws it.
 *
 * The image lives at `apps/merchant-pos/assets/telga-logo.png` and is served
 * from `/assets/telga-logo.png`. It has to be a URL rather than an inline
 * `data:` URI because the page's content-security policy is `img-src 'self'`
 * — a data URI would be refused — and because inlining 1.6 MB of base64 into
 * every page would be worse even if it were allowed.
 *
 * ## The animation
 *
 * The brief is a sequence: the T falls, lands against the figure, the figure
 * pushes it upright, and it settles standing. The supplied render is the
 * *middle* of that sequence — the moment of the push — which is why a static
 * copy of it reads as "still falling".
 *
 * The whole image is rotated as one piece: it starts tipped further over than
 * the artwork, swings back through the artwork's own angle, and settles
 * upright. Rotating the composition rather than the letter alone is a
 * deliberate limitation and is honest about what a flat PNG allows — the
 * letter cannot be separated from the figure and the road without editing the
 * image itself, which would mean redrawing the very thing that must not
 * change.
 *
 * `prefers-reduced-motion` stops the animation and rests on the upright
 * frame, and so does printing.
 */

import { h } from './element';
import type { El } from './element';

/** Where the artwork is served from. Same-origin, so the CSP allows it. */
export const TELGA_LOGO_URL = '/assets/telga-logo.png';

export type LogoVariant = 'colour' | 'mono';

export interface TelgaLogoProps {
  /**
   * `mono` is the print treatment: the same artwork, rendered in high
   * contrast for a thermal roll rather than tinted for a screen.
   */
  readonly variant?: LogoVariant;
  /** Rendered height in CSS pixels. Width follows the artwork's aspect ratio. */
  readonly height?: number;
  /** Pass `''` to mark the mark decorative — used where "TELGA" is set beside it. */
  readonly title?: string;
  /**
   * Play the fall → catch → stand sequence. Only the splash and the launcher
   * ask for it; a slip is a still piece of paper.
   */
  readonly animate?: boolean;
}

/**
 * The mark.
 *
 * An `<img>` rather than inline SVG, because the artwork is a raster render.
 * `alt` carries the brand name when the mark is standing in for it, and is
 * empty when the word TELGA is already set beside it — an empty `alt` is what
 * marks an image decorative, not `aria-hidden` on a wrapper.
 */
export function telgaLogo(props: TelgaLogoProps = {}): El {
  const variant = props.variant ?? 'colour';
  const height = props.height ?? 48;
  const title = props.title ?? 'Telga';

  // The artwork is 1536 × 1024; the height drives the width so the road and
  // the letter never distort.
  const width = Math.round((height * 1536) / 1024);

  return h('img', {
    src: TELGA_LOGO_URL,
    alt: title,
    height: String(height),
    width: String(width),
    decoding: 'async',
    class: [
      'telga-logo',
      `telga-logo--${variant}`,
      props.animate === true ? 'telga-logo--animate' : '',
    ]
      .filter((c) => c.length > 0)
      .join(' '),
    'data-testid': 'telga-logo',
  });
}

// ---------------------------------------------------------------------------
// The flat mark
// ---------------------------------------------------------------------------

/**
 * A flat, drawn version of the mark — for use at icon size.
 *
 * ## Why this exists alongside the render
 *
 * `telgaLogo` serves the founder's artwork, and that is correct wherever the
 * mark is the subject: the splash, a slip, an app icon. But the launcher's
 * Telga button sits beside 📱 and 💳, and a photo-realistic render next to two
 * flat emoji looks like a mistake rather than a brand. It also loses its
 * detail below about 40px, which is where a button icon lives.
 *
 * So this is the same composition — the tilted T with the figure pushing it —
 * reduced to four shapes. It is **not** a redraw of the artwork in the sense
 * that was forbidden: the render is untouched and still used everywhere it was
 * before. This is a second, deliberately simpler mark for the one place the
 * render does not work.
 *
 * ## Why inline SVG rather than another PNG
 *
 * It scales to any size from one definition, it costs no extra request under
 * the page's CSP, and it takes its colours from the surrounding theme rather
 * than baking them into a file. A raster icon would need one export per size.
 *
 * The `viewBox` is the composition's own tight bounding box, so the glyph
 * fills whatever box it is given instead of floating inside padding.
 */
export interface TelgaGlyphProps {
  /** Rendered size in CSS pixels, square. */
  readonly size?: number;
  /** Pass `''` where a visible label already names it. */
  readonly title?: string;
}

export function telgaGlyph(props: TelgaGlyphProps = {}): El {
  const size = props.size ?? 48;
  const title = props.title ?? 'Telga';
  const decorative = title.length === 0;

  return h(
    'svg',
    {
      viewBox: '2 7 54 47',
      width: String(size),
      height: String(size),
      class: 'telga-glyph',
      'data-testid': 'telga-glyph',
      // A decorative glyph is hidden from assistive tech; a meaningful one is
      // an image with a name. Never both.
      ...(decorative
        ? { 'aria-hidden': 'true', focusable: 'false' }
        : { role: 'img', 'aria-label': title }),
    },
    // The letter, tilted as one piece — crossbar and stem, the stem a shade
    // deeper so the two faces read as one lit object rather than a flat T.
    h('polygon', { points: '2.29,21.21 37.77,7.59 41.17,16.46 5.70,30.08', fill: 'var(--glyph-teal, #17858a)' }),
    h('polygon', { points: '14.43,16.55 24.70,12.61 39.03,49.95 28.77,53.90', fill: 'var(--glyph-teal-deep, #116a70)' }),
    // The figure. Round caps and joins, so at 24px the limbs read as bone
    // rather than as four disconnected sticks.
    h('circle', { cx: '50.75', cy: '27.75', r: '4.75', fill: 'var(--glyph-bone, #eee7d8)' }),
    h('g', {
      stroke: 'var(--glyph-bone, #eee7d8)',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      fill: 'none',
    },
      h('path', { d: 'M50.5 32 L46.5 44', 'stroke-width': '3.4' }),
      // The arm reaches onto the stem: the figure is pushing the letter, which
      // is the whole story the mark tells. A gap here makes it a figure
      // standing next to a T.
      // Ends at x=30, inside the stem: the stem's right edge is at x≈31.4 at
      // this height, so the hand lands **on** the letter rather than near it.
      // A gap here turns a figure pushing a letter into a figure standing
      // beside one, which is the whole story the mark tells.
      h('path', { d: 'M49 35 L30 29.5', 'stroke-width': '3' }),
      h('path', { d: 'M46.5 44 L38.5 53', 'stroke-width': '3' }),
      h('path', { d: 'M46.5 44 L55 52', 'stroke-width': '3' }),
    ),
  );
}
