/**
 * The shared design tokens, and the two rules that keep them shared.
 *
 * ## Why this package exists
 *
 * `CLAUDE.md` §27 has listed `packages/design-system` in the repository tree
 * since the founder's brief was transcribed on 2026-08-19. It was never built.
 * The cost came due on 2026-09-12: the three surfaces between them carried
 * **81 hand-written hex colours** — 52 in the POS stylesheet, 17 in the
 * console's, 12 in the mobile shell's — with no shared source. The POS spelled
 * one `#122E30` and the mobile shell spelled the same colour `#122e30`, which
 * is what drift looks like before anybody notices.
 *
 * ## The backtick rule
 *
 * Both stylesheets are template literals. A backtick inside one ends it
 * mid-parse, and the error surfaces a hundred lines away as a meaningless
 * `',' expected`. This has now happened **four times** in this repository: in
 * the POS client script, in a SQL comment, and twice while writing the CSS
 * below. `05 Operations/Runbooks` records the first two.
 *
 * It keeps recurring because the natural way to write a code comment about
 * `nav()` is to put it in backticks. So it is asserted rather than remembered.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEATHER, PHASE, SIZE, SPACE, TYPE, VELLUM, cssVariables } from '@telga/design-system';

const root = join(import.meta.dirname, '..', '..');
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8');

/** Everything between `const STYLES = \`` and the backtick that closes it. */
function styleBlock(source: string): string {
  const open = source.indexOf('const STYLES = `');
  expect(open, 'a STYLES template literal must exist').toBeGreaterThan(-1);
  const close = source.indexOf('\n`;', open);
  expect(close, 'the STYLES literal must be closed').toBeGreaterThan(open);
  return source.slice(open + 'const STYLES = `'.length, close);
}

const posSource = read('apps', 'merchant-pos', 'src', 'ui', 'document.ts');
const consoleSource = read('apps', 'operations-console', 'src', 'ui', 'page.ts');

describe('no backtick may enter a stylesheet', () => {
  it('holds for the POS', () => {
    // Write nav() or .console__nav, never in backticks. The literal ends there.
    expect(styleBlock(posSource)).not.toContain('`');
  });

  it('holds for the console', () => {
    expect(styleBlock(consoleSource)).not.toContain('`');
  });
});

describe('the tokens are a single source', () => {
  it('emits every group as a custom property', () => {
    const css = cssVariables();
    expect(css).toContain('--telga-vellum-rubric');
    expect(css).toContain('--telga-leather-ground');
    expect(css).toContain('--telga-space-lg');
    expect(css).toContain('--telga-size-touch-min');
    expect(css).toContain('--telga-motion-overshoot');
  });

  it('emits the active ground unqualified, so a component names neither app', () => {
    expect(cssVariables('vellum')).toContain(`--telga-ground: ${VELLUM.ground}`);
    expect(cssVariables('leather')).toContain(`--telga-ground: ${LEATHER.ground}`);
  });

  /**
   * Every token a stylesheet names must be one the package emits.
   *
   * This is the assertion that matters, and the one whose absence let a real
   * defect through minutes before it was written: the console asked for
   * `var(--telga-color-surface900)` while the package emits
   * `--telga-color-surface-900`. CSS resolves an undefined custom property to
   * nothing and carries on, so the console would have rendered with no
   * background at all and no error anywhere — the failure mode a stylesheet is
   * worst at reporting.
   */
  it('never names a token that does not exist', () => {
    const declared = new Set(
      [...cssVariables().matchAll(/(--telga-[a-z0-9-]+):/g)].map((m) => m[1]),
    );
    expect(declared.size).toBeGreaterThan(20);

    for (const [label, source] of [
      ['POS', posSource],
      ['console', consoleSource],
    ] as const) {
      const used = [...styleBlock(source).matchAll(/var\((--telga-[a-z0-9-]+)/g)].map((m) => m[1]);
      for (const name of used) {
        expect(declared.has(name), `${label} uses ${name}, which no token declares`).toBe(true);
      }
    }
  });

  it('reaches the console, which consumes it rather than declaring its own', () => {
    // A design system nothing imports is the fifth module built and never
    // called — the repository has found four already.
    expect(consoleSource).toContain("from '@telga/design-system'");
    expect(styleBlock(consoleSource)).toContain('var(--telga-ground)');
  });
});

describe('what §22 requires of the tokens', () => {
  it('never lets a touch target fall below 44px', () => {
    for (const [name, value] of Object.entries(SIZE)) {
      if (!/touch|control|primary|Bar$/i.test(name)) continue;
      expect(Number.parseInt(value, 10), `${name} is tappable`).toBeGreaterThanOrEqual(44);
    }
  });

  it('sets the base type for Amharic, not for Latin', () => {
    // Ethiopic glyphs carry more strokes per character; 15px loses the
    // distinction between several of them on a POS screen.
    expect(Number.parseInt(TYPE.base, 10)).toBeGreaterThanOrEqual(16);
  });

  it('puts an Ethiopic face first in every stack', () => {
    // The FIRST family, not merely present somewhere: a stack that reaches
    // Amharic only after two Latin faces have declined it is not a fallback.
    for (const [label, stack] of [['body', TYPE.body], ['display', TYPE.display]] as const) {
      const first = stack.split(',')[0];
      expect(first, `${label} leads with ${first}`).toContain('Ethiopic');
    }
  });

  it('loads no webfont', () => {
    // The CSP forbids one, and a counter's connectivity cannot be relied on: a
    // sign-in screen that cannot draw its own labels is worse than one set in a
    // system face.
    for (const stack of [TYPE.body, TYPE.display, TYPE.mono]) {
      expect(stack).not.toMatch(/https?:|url\(/);
    }
  });

  it('gives every phase a pattern as well as an ink', () => {
    // §22: never colour alone. The pattern is the carrier that survives a
    // monochrome thermal print, a photocopy, and a colour-blind reader.
    const phases = Object.entries(PHASE);
    expect(phases.length).toBeGreaterThanOrEqual(5);
    for (const [name, phase] of phases) {
      expect(phase.pattern, `${name} needs a pattern`).toBeTruthy();
      expect(phase.ink, `${name} needs an ink`).toBeTruthy();
    }
    // And no two phases may share a pattern, or the pattern carries nothing.
    const patterns = phases.map(([, p]) => p.pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it('does not dress pending as a fault', () => {
    // §15 is explicit that a timeout is not a failure, so pending must not
    // borrow the vocabulary of one.
    expect(PHASE.pending.ink).not.toBe(PHASE.failed.ink);
  });

  it('tints secondary text from the ground rather than greying it', () => {
    // Grey on a warm ground reads as dirt. Both thinned inks must keep a
    // channel spread, which a neutral grey would not have.
    for (const [label, hex] of [['vellum', VELLUM.inkThin], ['leather', LEATHER.inkThin]] as const) {
      const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
      expect(Math.max(r, g, b) - Math.min(r, g, b), `${label} is greyed`).toBeGreaterThan(20);
    }
  });

  it('keeps spacing on one grid', () => {
    for (const [name, value] of Object.entries(SPACE)) {
      expect(Number.parseInt(value, 10) % 4, `${name} is off the 4px grid`).toBe(0);
    }
  });
});

describe('the native shell', () => {
  const pos = styleBlock(posSource);

  it('gives the POS a bottom tab bar that clears the gesture area', () => {
    // A fixed bar that ignores the inset sits under the Android gesture bar,
    // where its links either cannot be hit or fire the system gesture.
    expect(pos).toContain('.pos__nav');
    expect(pos).toContain('safe-area-inset-bottom');
  });

  it('keeps the page above that bar', () => {
    // Otherwise the last row of every screen sits behind the tabs. The shell
    // reserves the bar's own height plus the gesture inset; how that is
    // spelled (shorthand or longhand) is not the point.
    const at = pos.indexOf('\n.pos {');
    const shell = pos.slice(at, pos.indexOf('\n.pos__topbar', at));
    expect(shell).toContain('--telga-size-tab-bar');
    expect(shell).toContain('safe-area-inset-bottom');
  });

  it('hides the whole shell when printing', () => {
    // A fixed bar would otherwise print on every page of a receipt.
    const print = pos.slice(pos.lastIndexOf('@media print'));
    for (const part of ['.pos__nav', '.pos__identity', '.pos__footer']) {
      expect(print, `${part} must not print`).toContain(part);
    }
  });

  it('lets the console navigation scroll instead of wrapping to six rows', () => {
    const shell = styleBlock(consoleSource);
    expect(shell).toContain('overflow-x: auto');
    expect(shell).toContain('scroll-snap-type');
  });

  it('stops iOS zooming the console on focus', () => {
    // Anything under 16px makes Safari zoom the page, leaving the operator
    // scrolled sideways in the middle of a form.
    expect(styleBlock(consoleSource)).toMatch(/input, select, textarea \{[^}]*font-size: 16px/);
  });
});
