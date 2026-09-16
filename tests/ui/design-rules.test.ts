/**
 * The rules `DESIGN.md` states, as tests.
 *
 * An `/impeccable critique` of 2026-09-16 scored the merchant app 23/40 and
 * closed on the observation that mattered most:
 *
 * > The prose in this codebase is better than the CSS it sits above. Nearly
 * > every questionable line has a long, careful, correct comment above it
 * > explaining the right answer.
 *
 * Four of the five priority issues existed because a documented rule had no
 * enforcement. A paragraph cannot fail a build. Each test here is one sentence
 * already written in `DESIGN.md` or `tokens.ts`, moved somewhere it can refuse.
 *
 * These are **class** guards, not instance fixes: each closes a category of
 * defect rather than the one example that was found.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf-8');

const DOCUMENT_TS = 'apps/merchant-pos/src/ui/document.ts';
const TOKENS_TS = 'packages/design-system/src/tokens.ts';

/** The stylesheet body, without the TypeScript around it. */
function stylesheet(): string {
  const source = read(DOCUMENT_TS);
  const start = source.indexOf('const STYLES');
  const open = source.indexOf('= `', start) + 3;
  return source.slice(open, source.indexOf('`;', open));
}

/** A CSS block's rules, with comments stripped so a guard cannot match its own documentation. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('one primary action per screen', () => {
  /**
   * `DESIGN.md`: *"Primary action: a rubricated block seated on a heavy rule,
   * **one per screen**."*
   *
   * It was written as `.pos main button[type="submit"]` — specificity 0,2,2,
   * which beat `--cancel` and `--print` at 0,1,0. Every submit inside `main`
   * painted itself the primary, so the PIN screen showed three identical
   * vermilion blocks: Confirm, Cancel order, and Main. On the screen where
   * money moves, read one-handed with a customer waiting.
   */
  it('does not let an element selector claim the primary treatment', () => {
    const css = withoutComments(stylesheet());
    expect(
      css,
      'the primary must be opt-in: an element selector cannot know which of three submits is primary',
    ).not.toContain('main button[type="submit"]');
  });

  it('keeps the primary reachable by an explicit class', () => {
    // The other half. Without this, deleting the rule outright would also pass.
    const css = withoutComments(stylesheet());
    expect(css).toContain('.voucher__button--primary');
    expect(css).toContain('.button--primary');
  });

  it('gives cancel and print enough specificity to hold their own', () => {
    // These are the two modifiers the old selector overrode. `--cancel` is the
    // control that abandons a sale a customer may have paid for; `--print` is
    // the pair section 18.5 says must not look alike.
    const css = withoutComments(stylesheet());
    expect(css).toContain('.voucher__button--cancel');
    expect(css).toContain('.voucher__button--print');
  });
});

describe('no colour literal outside the token system', () => {
  /**
   * `document.ts`'s own header: *"Every value is a token. A screen that
   * hard-codes a colour is a screen that drifts, and this file has already been
   * through three rounds of that."*
   *
   * The critique reported 13. Measuring the stylesheet directly gives **15** —
   * the critique's figure came from a hand-listed inventory and missed two.
   * The number here is measured by the same expression the test uses, so it
   * cannot drift from what it is guarding.
   *
   * `#122E30` is no longer among them: it was the `theme-color` Android painted
   * the status bar with, from the palette the founder released, and it now
   * reads `VELLUM.ground`.
   *
   * **This test records the count rather than demanding zero.** A hard zero
   * would have to be bought in one commit, and some literals are legitimate:
   * the slip is white paper with black ink because a thermal head is one bit
   * per dot. A ratchet that can only fall is the honest shape for a debt being
   * paid down — and it fails the moment somebody adds one more.
   *
   * The remaining debt, in rough order of how much it is worth paying:
   * `.card__result--approved/--declined/--no_response` are a green/red/amber
   * vocabulary that says status by hue alone, twenty lines above the
   * `[data-phase]` system built to replace it; `--pay-accent` (#0f9b8e) is a
   * sixth ink from the released palette; and the slip's paper white and ink
   * want a `--telga-paper` / `--telga-paper-ink` pair so the cap can be tested
   * honestly rather than exempted by hand.
   */
  const CEILING = 15;

  it('adds no new hard-coded hex colour', () => {
    const css = withoutComments(stylesheet());
    const hexes = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
    const distinct = [...new Set(hexes)].sort();

    expect(
      distinct.length,
      `hard-coded colours: ${distinct.join(', ')}\n` +
        'Every value should be a token. If you removed one, lower CEILING to match.',
    ).toBeLessThanOrEqual(CEILING);
  });

  it('holds the ratchet tight, so a removal is recorded rather than banked', () => {
    // If this fails because the count dropped, that is the good failure: lower
    // CEILING in the same commit that removed the literal.
    const css = withoutComments(stylesheet());
    const distinct = new Set([...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase()));
    expect(
      distinct.size,
      'the count fell — lower CEILING to lock the improvement in',
    ).toBeGreaterThanOrEqual(CEILING - 1);
  });
});

describe('no type below the Ethiopic floor', () => {
  /**
   * `tokens.ts`: *"The base is 17px, set for Amharic… 14–15px — comfortable for
   * Latin — loses distinctions between several Ethiopic characters on a small
   * screen."*
   *
   * The dashboard set its tile labels at `0.65rem` and its badges at `0.6rem`.
   * `rem` resolves against the 16px root rather than body's 17px, so those are
   * **10.4px and 9.6px** — below `--telga-type-xs` (13px), the smallest token
   * that exists. `የመንግሥት ክፍያዎች` is sixteen Ethiopic glyphs, and it was being
   * set at 10.4px in a 115px tile read at arm's length in daylight.
   */
  const FLOOR_PX = 13;
  const ROOT_PX = 16;

  /**
   * **Thermal print is exempt, and the exemption is the honest part.**
   *
   * The first version of this test failed on fifteen declarations. Seven were
   * real. The other eight were `.slip__*` and `.card__sim-*` rules — type set
   * for a 58mm receipt roll, where 12px is correct and 13px wastes paper the
   * shop buys itself.
   *
   * The rule in `tokens.ts` is about a **screen** read at arm's length in
   * daylight: *"14–15px — comfortable for Latin — loses distinctions between
   * several Ethiopic characters on a small screen."* A receipt is held at
   * reading distance and printed at one bit per dot. Applying a screen floor to
   * paper would be enforcing the letter of a rule against its reason.
   */
  const PRINT_ONLY = /^\.(slip|card__sim|card__gesture)/;

  it('declares no screen font-size below --telga-type-xs', () => {
    const css = withoutComments(stylesheet());
    const offenders: string[] = [];

    for (const match of css.matchAll(/font-size:\s*([0-9.]+)(rem|px|em)/g)) {
      const value = Number(match[1]);
      const unit = match[2];
      // `em` is relative to a parent this test cannot resolve; skip rather than
      // guess, and say so instead of quietly passing everything.
      if (unit === 'em') continue;
      const px = unit === 'rem' ? value * ROOT_PX : value;
      if (px >= FLOOR_PX) continue;

      // Which rule is this inside?
      const braceAt = css.lastIndexOf('{', match.index ?? 0);
      const prevClose = css.lastIndexOf('}', braceAt);
      const selector = css.slice(prevClose + 1, braceAt).trim().split(/[\s,]+/)[0] ?? '';
      if (PRINT_ONLY.test(selector)) continue;

      offenders.push(`${selector}: ${match[0]} = ${px.toFixed(1)}px`);
    }

    expect(
      offenders,
      'Ethiopic loses character distinctions below 13px on a screen. Use var(--telga-type-xs).',
    ).toEqual([]);
  });

  it('still exempts print rules rather than silently passing everything', () => {
    // If the exemption ever matched every selector, the test above would pass
    // while enforcing nothing. This asserts the exemption is narrow.
    expect(PRINT_ONLY.test('.dashboard__tile-label')).toBe(false);
    expect(PRINT_ONLY.test('.voucher__amount-note')).toBe(false);
    expect(PRINT_ONLY.test('.slip__support')).toBe(true);
  });

  it('measures rem against the root, not the body', () => {
    // The trap that produced the two offenders: body is 17px, but `rem` has
    // never resolved against body. A reader doing the arithmetic in their head
    // against 17 gets 11.05 and 10.2 — still too small, but not the real
    // numbers. The root declaration is what this test depends on.
    expect(stylesheet()).toContain(`font-size: ${String(ROOT_PX)}px`);
  });
});

describe('no two navigation entries share a destination', () => {
  /**
   * The bottom navigation rendered **two tabs with the same href and the same
   * label** — `/settings`, "Settings", twice out of five. Measured live at
   * 62×96px each, both labels wrapping to two lines.
   *
   * A tab bar where two of five destinations are the same is a tab bar a
   * shopkeeper stops reading.
   */
  it('gives the dashboard bottom bar five distinct destinations', () => {
    const source = read('apps/merchant-pos/src/ui/dashboard.ts');
    const start = source.indexOf('function bottomNav');
    expect(start, 'bottomNav must exist for this guard to mean anything').toBeGreaterThan(-1);

    const block = source.slice(start, source.indexOf('\n}', start));
    const hrefs = [...block.matchAll(/navItem\(\s*'([^']+)'/g)].map((m) => m[1]);

    expect(hrefs.length, 'the bar should still have entries').toBeGreaterThan(2);
    expect(
      new Set(hrefs).size,
      `duplicate destination in the bottom bar: ${hrefs.join(', ')}`,
    ).toBe(hrefs.length);
  });
});

describe('no backtick reaches a template literal', () => {
  /**
   * **The tenth occurrence earned this test.**
   *
   * `document.ts` holds the whole stylesheet and the whole client script as
   * template literals. A backtick inside either one ends the string, and the
   * failure surfaces hundreds of lines later as `',' expected` — a parser
   * error pointing at valid code, with nothing naming the real cause.
   *
   * It keeps happening for one reason: the natural way to write a comment
   * about CSS or JS is to put the identifier in backticks. Every author does
   * it, including every previous author of a comment warning about it.
   *
   * Nine of the ten were caught by a build that failed. This catches the tenth
   * with the file and the reason.
   */
  const LITERALS = ['CLIENT_SCRIPT', 'STYLES'] as const;

  for (const name of LITERALS) {
    it(`keeps ${name} free of backticks`, () => {
      const source = read(DOCUMENT_TS);
      const at = source.indexOf(`const ${name}`);
      expect(at, `${name} must exist for this guard to mean anything`).toBeGreaterThan(-1);

      const open = source.indexOf('= `', at) + 3;
      const body = source.slice(open, source.indexOf('`;', open));

      expect(
        body.includes('`'),
        `A backtick inside ${name} ends the literal. Reword the comment — ` +
          'write the identifier without backticks.',
      ).toBe(false);
    });
  }
});

describe('the design system the detector reads is the one that ships', () => {
  /**
   * `.impeccable/design.json` is loaded by the detector as design-system
   * context. It had drifted: it still recorded `rubric: #C0341F` and
   * `inkThin: #6B5636`, both of which were **darkened for contrast** — the
   * rubric from 3.55:1 to 4.59:1 — and it had no entry for `ochreInk` at all.
   *
   * A grader holding a superseded palette will approve a regression back to it.
   */
  it('records the rubric that tokens.ts actually declares', () => {
    const tokens = read(TOKENS_TS);
    const declared = /rubric:\s*'(#[0-9A-Fa-f]{6})'/.exec(tokens)?.[1];
    expect(declared, 'tokens.ts must declare a vellum rubric').toBeDefined();

    let sidecar: string;
    try {
      sidecar = read('.impeccable/design.json');
    } catch {
      // Absent is fine — nothing is grading against a stale copy.
      return;
    }
    if (!sidecar.toLowerCase().includes('rubric')) return;

    expect(
      sidecar.toUpperCase(),
      'the sidecar names a rubric that tokens.ts no longer declares',
    ).toContain((declared ?? '').toUpperCase());
  });
});
