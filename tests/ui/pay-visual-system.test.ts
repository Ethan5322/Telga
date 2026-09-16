/**
 * Telga Pay belongs to the same visual world as Telga Vending.
 *
 * ## What this pass found
 *
 * Telga Pay was still drawn in the **released reference world**. `PRODUCT.md`
 * records that world as *"evidence and anti-reference rather than a
 * constraint"* since 2026-09-12, and the merchant app was moved off it — but
 * one module kept its own accent, `--pay-accent: #0f9b8e`, and every screen in
 * the module was coloured by it.
 *
 * It was not a taste question. Measured against the vellum ground:
 *
 *     the accent as text            2.18:1   (WCAG body floor is 4.5:1)
 *     white glyph on an accent chip 3.44:1
 *
 * Both carried real content — the figure for today's sales, and the
 * tap / insert / swipe controls the card screen exists for.
 *
 * ## What replaced it, and why it is not a new ink
 *
 * `DESIGN.md` caps the palette at eight inks per surface and already assigns
 * the **money** family its own: `ochre-ink`, the ink the dashboard's Account
 * tile draws. Telga Pay is money. So the module takes the ink that already
 * means what the module is, the cap is untouched, and nothing is invented:
 *
 *     ochre-ink as text             5.11:1
 *     pale ground on an ochre fill  5.98:1
 *
 * These tests hold that Pay cannot drift back: no private accent, no second
 * primary vocabulary, and the same contrast arithmetic run here rather than
 * quoted from this comment.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VELLUM } from '@telga/design-system';

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf-8');

/** Source with comments removed — a guard reads the code, not the prose. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PAY_TS = (): string => withoutComments(read('apps/merchant-pos/src/ui/telgaPay.ts'));

const STYLES = (): string => {
  const source = read('apps/merchant-pos/src/ui/document.ts');
  const at = source.indexOf('const STYLES');
  const open = source.indexOf('= `', at) + 3;
  return withoutComments(source.slice(open, source.indexOf('`;', open)));
};

/** Only the `.pay__*` rules, so a finding names the module it is about. */
const payRules = (): string =>
  STYLES()
    .split('\n')
    .filter((line) => line.includes('.pay__') || line.includes('--pay-ink'))
    .join('\n');

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

describe("Telga Pay's ink is one the design system already declares", () => {
  it('names no private accent of its own', () => {
    expect(
      STYLES(),
      'a module-private colour is how a released palette survives a migration',
    ).not.toContain('--pay-accent');
    expect(payRules()).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it('draws the money family, which is what Telga Pay is', () => {
    expect(payRules()).toContain('--pay-ink: var(--telga-vellum-ochre-ink)');
  });

  it('is legible as text and as a fill, measured both ways', () => {
    // The two pairings that actually ship: the ink on the page, and the pale
    // ground carried on a chip filled with it.
    expect(contrast(VELLUM.ochreInk, VELLUM.ground)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(VELLUM.groundPale, VELLUM.ochreInk)).toBeGreaterThanOrEqual(4.5);
  });

  it('beats what it replaced, so the change is an improvement and not a swap', () => {
    // The released accent, kept here as the number to beat rather than in the
    // stylesheet where it was being drawn.
    const RELEASED_ACCENT = '#0f9b8e';
    expect(contrast(RELEASED_ACCENT, VELLUM.ground)).toBeLessThan(3);
    expect(contrast(VELLUM.ochreInk, VELLUM.ground)).toBeGreaterThan(
      contrast(RELEASED_ACCENT, VELLUM.ground),
    );
  });
});

describe('one primary vocabulary across both modules', () => {
  /**
   * `DESIGN.md`: *"Primary action: a rubricated block seated on a heavy rule,
   * one per screen. **Not a pill** — this world rules and fills, it does not
   * round."*
   *
   * Telga Pay's Pay Now and Add to balance were `.pay__pill-button`: a teal
   * 999px pill. Two primary treatments in one application is two applications
   * as far as a shopkeeper's hand is concerned.
   */
  it('gives Telga Pay no button class of its own', () => {
    expect(STYLES()).not.toContain('pay__pill-button');
    expect(PAY_TS()).not.toContain('pay__pill-button');
  });

  it('uses the shared primary class for the action that submits', () => {
    const source = PAY_TS();
    for (const testId of ['pay-now', 'deposit-confirm']) {
      const at = source.indexOf(`'data-testid': '${testId}'`);
      expect(at, `${testId} is missing`).toBeGreaterThan(-1);
      const element = source.slice(Math.max(0, at - 260), at);
      expect(element, `${testId} does not carry the shared primary class`).toContain('button--primary');
    }
  });

  it('rounds nothing into a pill', () => {
    expect(payRules(), 'a pill in a world that rules and fills').not.toContain('999px');
  });
});

describe('secondary text is a real ink, never an opacity', () => {
  /**
   * `DESIGN.md`: *"Secondary text is tinted from its ground, never greyed."*
   * `tokens.ts` gives `ink-thin` 4.89:1 against the page.
   *
   * Telga Pay faded `ink` to `opacity: 0.75` in three places instead. A browser
   * compounds that against the ground to **3.06:1** — under the body floor, on
   * the label and the count beside the day's takings.
   */
  it('fades nothing in the Telga Pay rules', () => {
    expect(payRules()).not.toMatch(/opacity:\s*0\./);
  });

  it('keeps the thinned ink above the body floor, so the alternative is real', () => {
    expect(contrast(VELLUM.inkThin, VELLUM.ground)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('a card outcome says what happened by more than its hue', () => {
  /**
   * §22: status is text **plus** icon **plus** colour. The four outcomes were
   * four pastel grounds — mint, rose, amber, grey — and the container's colour
   * was the only thing separating a decline from a timeout.
   *
   * §15 is explicit that *a timeout is not a failure*, and `DESIGN.md` enforces
   * it at token level: *"pending never borrows failure's ink"*. A screen that
   * paints them alike teaches an operator to treat them alike.
   */
  const blockOf = (modifier: string): string =>
    new RegExp(`\\.card__result--${modifier}\\s*\\{([^}]*)\\}`).exec(STYLES())?.[1] ?? '';

  const OUTCOMES = ['approved', 'declined', 'no_response', 'not_read'] as const;

  it('gives every outcome its own rule pattern', () => {
    const patterns = OUTCOMES.map((outcome) => {
      const block = blockOf(outcome);
      expect(block, `no rule for ${outcome}`).not.toBe('');
      return /border-block-style:\s*([a-z]+)/.exec(block)?.[1] ?? '';
    });
    expect(patterns.every((p) => p !== ''), `a pattern is missing: ${patterns.join(', ')}`).toBe(true);
    expect(new Set(patterns).size, 'two outcomes share a pattern and so say the same thing').toBe(
      OUTCOMES.length,
    );
  });

  it('never paints a timeout in the ink that means failure', () => {
    const timeout = blockOf('no_response');
    const failure = blockOf('declined');
    expect(timeout).toContain('indigo');
    expect(timeout, 'a timeout is not a failure — §15').not.toBe(failure);
  });

  it('keeps no pastel ground behind any of them', () => {
    for (const outcome of OUTCOMES) {
      expect(blockOf(outcome), `${outcome} still carries a background of its own`).not.toContain(
        'background',
      );
    }
  });
});

describe('a text field is set in the type system the app chose', () => {
  /**
   * `font-family` is not inherited by form controls: a UA picks its own. Every
   * field in this app — sign-in, the recipient's number, the PIN, the Telga Pay
   * keypad and its note — rendered in Arial while the page around it was set in
   * Ethiopic.
   *
   * The whole reason the base scale is 17px is Amharic legibility
   * (`tokens.ts`), and the one place Amharic is *typed* was the one place it
   * never applied.
   */
  const inputFloor = (): string =>
    /\ninput:not\([^{]*\{([^}]*)\}/.exec(STYLES())?.[1] ?? '';

  it('asks for the body stack on every text input', () => {
    const block = inputFloor();
    expect(block, 'the input rule is gone').not.toBe('');
    expect(block, 'a field renders in the UA font unless it is told otherwise').toContain(
      'font-family: var(--telga-type-body)',
    );
  });

  it('states that floor at a specificity a screen can raise', () => {
    /**
     * The rule was `input:not([type="checkbox"]):not([type="radio"]):not(…)`.
     * `:not()` carries its argument's specificity, so that is **0,3,1** — and it
     * beat `.pay__amount-display input` at 0,1,1. Telga Pay's amount keypad,
     * designed at 2.5rem and the largest figure on the screen an operator types
     * a sale into, therefore rendered at 16px from the day it was written.
     *
     * `:where()` contributes nothing, which is the difference between a floor
     * and an override.
     */
    const css = STYLES();
    const selector = /\n(input:not\([^{]*)\{/.exec(css)?.[1] ?? '';
    expect(selector, 'the input floor is gone').not.toBe('');
    expect(selector, 'chained :not() out-specifies every screen that needs to differ').toContain(
      ':where(',
    );
  });

  it('lets the Telga Pay keypad set its own size', () => {
    const block = /\.pay__amount-display input \{([^}]*)\}/.exec(STYLES())?.[1] ?? '';
    expect(block, 'the keypad rule is gone').not.toBe('');
    expect(block).toContain('font-size: 2.5rem');
  });

  it('gives a labelled field a rule at all', () => {
    // `.field` wraps a label and its control on nine screens and had no rule
    // outside `.lock`, so label and input sat on one line with nothing between.
    const css = STYLES();
    expect(css).toMatch(/\n\.field \{/);
    expect(/\n\.field \{([^}]*)\}/.exec(css)?.[1] ?? '').toContain('flex-direction: column');
  });
});
