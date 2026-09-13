/**
 * Telga design tokens — `CLAUDE.md` §22, §27.
 *
 * ## Why this package exists
 *
 * §27 has listed `packages/design-system` in the repository tree since the
 * founder's brief was transcribed. It was never built, and the cost showed up
 * as drift: on 2026-09-12 the three surfaces between them hand-wrote **81
 * distinct hex colours** — 52 in the POS stylesheet, 17 in the console's, 12 in
 * the mobile shell's — with no shared source. The POS spelled one of them
 * `#122E30` and the mobile shell spelled the same colour `#122e30`, which is
 * what drift looks like before anybody notices it.
 *
 * Everything visual is named here and nowhere else. A test fails if a surface
 * names a token this file does not declare.
 *
 * ## The palette is capped, and that is the point
 *
 * **Five inks for the merchant app, five for the console, and no intermediate
 * tones invented.** A scribe mixing a sixth colour mid-manuscript is the same
 * failure as a stylesheet reaching 52 hexes: each individually reasonable,
 * collectively incoherent. Where a lighter or darker value is genuinely needed
 * it is a *named ground*, not a blend, so it can be counted.
 *
 * ## What the tokens are answerable to
 *
 * §22 is not decoration, and each rule below is why a token has the value it
 * has:
 *
 * - **"status conveyed by text + icon + colour, never colour alone"** — so a
 *   phase carries a **rule pattern** as well as an ink and a name. Three
 *   carriers, and the pattern survives a monochrome screen, a photocopy, and a
 *   colour-blind reader.
 * - **"large touch targets"** — 48px floor, per Android's own guidance, on a
 *   counter operated fast and one-handed.
 * - **"readable Amharic typography"** — Ethiopic glyphs carry more strokes per
 *   character than Latin, so the scale is set for Ethiopic and Latin inherits
 *   it. The faces are Ethiopic-first system faces: no webfont, because the CSP
 *   forbids one and a counter's connectivity cannot be relied on.
 * - **"high-contrast"** — a POS screen is read in daylight, sometimes with sun
 *   on it.
 */

/** A colour, as a hex string. The only place these literals may be written. */
export type Token = string;

/**
 * The merchant app: goatskin, carbon, vermilion.
 *
 * Ethiopian scribal practice at its **saturated** end. A `mäṣḥaf` is not cream
 * paper — it is thick goatskin that runs warm ochre-to-tan, written in carbon
 * black, with structure carried in vivid minium red. The cream-and-serif
 * reading of a manuscript is the softest possible rendition of this world and
 * the one every model reaches for first; it is deliberately not taken.
 *
 * **There are no cards.** The page is the skin, and content is separated by
 * ruling, the way a folio is. A card floating on a ground would be a second
 * material this world does not contain.
 */
export const VELLUM = Object.freeze({
  /** The skin itself. The ground of every merchant screen. */
  ground: '#E2CBA3',
  /** Where a folio is scraped thinner — a secondary band, never a card. */
  groundPale: '#EDDCBC',
  /** The flesh side, for a sunken or inactive region. */
  groundDeep: '#D3B98C',
  /** Carbon ink. Text, and every major rule. */
  ink: '#1A1410',
  /**
   * Secondary text, tinted from the ground rather than greyed.
   * Grey on a warm ground reads as dirt; this is the same ink thinned.
   */
  inkThin: '#6B5636',
  /** Minium. Rubrication: units, section marks, the primary action's rule. */
  rubric: '#C0341F',
  /** Harag blue. The second structural ink, for quiet emphasis. */
  indigo: '#23375E',
  /** Harag yellow. The third, used sparingly and never for text. */
  ochre: '#C98A14',
  /** A minor rule: the faint ruling a scribe lays down before writing. */
  rule: '#A8916A',
});

/**
 * The console: blind-tooled leather over board.
 *
 * The same world's binding rather than its pages. §18.0 requires that a Telga
 * employee suspending a merchant and a shop assistant selling airtime can never
 * mistake one application for the other, so the console takes the dark side of
 * this world — and takes it from the same file, which is what stops the two
 * from drifting into unrelated products.
 *
 * Dark is chosen from the scene, not by category: an operations desk works
 * indoors for long sessions, often beside a bright POS screen. The merchant app
 * is light for the opposite reason — daylight on a counter.
 */
export const LEATHER = Object.freeze({
  /** Tooled goatskin over wooden board. The console's ground. */
  ground: '#2A1D14',
  /** A raised panel — the ridge a blind tool leaves. */
  /* Not #382718: six consecutive digits, which the PIN-leak guard refuses in
     any rendered page and cannot distinguish from a real PIN. */
  groundRaised: '#3A2718',
  /** The impression a tool sinks. */
  groundDeep: '#1E140D',
  /** Text on leather: the pale flesh side, not white. */
  ink: '#EFDFC4',
  /** Secondary text, tinted from the leather rather than greyed. */
  inkThin: '#B49A72',
  /** Vermilion, opened up so it holds contrast on a dark ground. */
  rubric: '#E0604A',
  indigo: '#7A93C8',
  ochre: '#D9A83C',
  /** A tooled line. */
  rule: '#5A4231',
});

/**
 * Transaction and funding phases.
 *
 * **Each phase is a name, a rule pattern and an ink — three carriers.** §22
 * forbids colour as the only signal, and a pattern is the carrier that survives
 * the cases colour does not: a monochrome thermal print, a photocopied
 * statement, and a reader who cannot separate red from green.
 *
 * The pattern is the manuscript's own device. A scribe marks a passage by how
 * the rule is drawn, not by tinting the parchment.
 */
export const PHASE = Object.freeze({
  /** Settled. The rule reaches the margin, unbroken. */
  settled: { pattern: 'solid', ink: 'rubric' },
  /** Working. The rule is being laid down. */
  working: { pattern: 'dotted', ink: 'indigo' },
  /**
   * Pending — arrested short of the margin.
   *
   * Not a warning: §15 is explicit that a timeout is not a failure, so pending
   * must not borrow a fault's vocabulary. It is an unfinished line.
   */
  pending: { pattern: 'dashed', ink: 'indigo' },
  /** Under review. Two rules, because a second pair of eyes is on it. */
  review: { pattern: 'double', ink: 'ochre' },
  /** Failed. Struck through, the way a scribe voids an entry. */
  failed: { pattern: 'struck', ink: 'ink' },
  /**
   * Reversed. Struck and re-entered — never erased.
   *
   * §13 invariant 8: corrections are authorised adjustment entries, never
   * silent edits. The visual grammar says the same thing.
   */
  reversed: { pattern: 'struck-double', ink: 'rubric' },
});

/**
 * Spacing, on a 4px grid.
 *
 * Named by size rather than by use, so a screen cannot claim a gap means
 * something it does not.
 */
export const SPACE = Object.freeze({
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
  xxl: '32px',
});

/**
 * Type.
 *
 * **Ethiopic first, and no webfont.** The faces are the ones Android already
 * ships — `Noto Serif Ethiopic` for headings, which is the scribal voice, and
 * `Noto Sans Ethiopic` for body and controls. A webfont would need a CSP
 * exception and a network the counter may not have, and a sign-in screen that
 * cannot draw its own labels is worse than one set in a system face.
 *
 * **The base is 17px, set for Amharic.** Ethiopic glyphs carry more strokes per
 * character than Latin at the same size, and 14–15px — comfortable for Latin —
 * loses distinctions between several Ethiopic characters on a small screen.
 * Latin inherits the larger size rather than the reverse, because §22 requires
 * readable Amharic and nothing requires compact English.
 */
export const TYPE = Object.freeze({
  /** Headings and the balance. The scribal voice. */
  display:
    "'Noto Serif Ethiopic', 'Abyssinica SIL', 'Noto Serif', Georgia, serif",
  /** Body, labels, controls. */
  body: "'Noto Sans Ethiopic', 'Abyssinica SIL', system-ui, -apple-system, sans-serif",
  /** Only for a reference or a device id — never as a costume for "technical". */
  mono: "ui-monospace, 'Cascadia Mono', 'Roboto Mono', Menlo, monospace",
  xs: '13px',
  sm: '15px',
  base: '17px',
  lg: '20px',
  xl: '24px',
  xxl: '30px',
  /** The shop's balance. Tabular, so a figure never changes width. */
  amount: '34px',
});

/**
 * Touch targets and the shapes that carry them.
 *
 * **48px is the floor**, which is Android's own minimum rather than the web's
 * 44px: this ships as an Android app and is held to the platform's guidance.
 * A shopkeeper operates it at speed, one-handed, often while holding the
 * customer's phone in the other, and a mis-tap on a vending screen costs a real
 * transaction rather than a moment.
 *
 * **Corners are nearly square.** A folio is cut, not rounded; the radius exists
 * only to stop a rule looking chipped where two meet.
 */
export const SIZE = Object.freeze({
  /** Never smaller. Android's minimum, on the shortest side. */
  touchMin: '48px',
  /** The ordinary control: a menu row, a secondary action, a list item. */
  control: '48px',
  /** One primary action per screen, per §22. Sell, Confirm, Pay. */
  primary: '56px',
  /** The fixed bars a native layout hangs on. */
  appBar: '56px',
  tabBar: '60px',
  /** Rules. The structural element of this world, so they are tokens. */
  ruleHair: '1px',
  ruleMajor: '2px',
  ruleHeavy: '3px',
  radiusSm: '2px',
  radiusMd: '3px',
  radiusLg: '4px',
});

/**
 * Depth.
 *
 * **Almost none.** A manuscript has no drop shadows; it has ruling and
 * impression. The two entries here exist because a fixed bar over scrolling
 * content needs an edge the eye can find, and each carries a real offset and
 * blur rather than a zero-offset halo.
 */
export const SHADOW = Object.freeze({
  appBar: '0 2px 4px rgba(26, 20, 16, 0.18)',
  tabBar: '0 -2px 4px rgba(26, 20, 16, 0.18)',
  sheet: '0 -8px 24px rgba(26, 20, 16, 0.28)',
});

/**
 * The z-order, written down once.
 *
 * The training banner outranks everything, because §8 requires it to be visible
 * and a banner a sheet can cover is a banner that is sometimes absent.
 */
export const LAYER = Object.freeze({
  content: '0',
  appBar: '10',
  tabBar: '10',
  sheet: '20',
  banner: '30',
});

/**
 * Motion.
 *
 * Android's own durations and easing, because this is an Android app. The
 * signature movement is the **stepped rule**: a settling entry moves its rule
 * to the margin in one whole-line step with a single overshoot, and a pending
 * one halts short of it. Nothing glides continuously — a scribe's hand lifts
 * and sets down.
 *
 * Every value here is inert under `prefers-reduced-motion`, which Android's
 * "Remove animations" setting sets.
 */
export const MOTION = Object.freeze({
  /** A press acknowledging itself. */
  instant: '80ms',
  /** The standard Material short duration, for a state change in place. */
  short: '200ms',
  /** A page or sheet arriving. */
  medium: '320ms',
  /** Material's standard easing, and the overshoot the stepped rule uses. */
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  overshoot: 'cubic-bezier(0.2, 0, 0.1, 1.25)',
  /** Leaving is faster than arriving, and does not overshoot. */
  exit: 'cubic-bezier(0.3, 0, 1, 1)',
});

/**
 * Safe-area insets, for a phone with a notch or a gesture bar.
 *
 * A fixed bottom bar that ignores these sits *under* the Android gesture area
 * on most modern hardware, so its buttons are either unreachable or fire the
 * system gesture instead. The `max()` keeps a sensible minimum on hardware that
 * reports no inset at all.
 */
export const SAFE = Object.freeze({
  top: 'env(safe-area-inset-top, 0px)',
  bottom: 'env(safe-area-inset-bottom, 0px)',
  padBottom: 'max(env(safe-area-inset-bottom, 0px), 8px)',
});

const kebab = (name: string): string => name.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase();

/**
 * Emit the tokens as CSS custom properties.
 *
 * Both surfaces call this at the top of their own stylesheet, so there is one
 * definition and two consumers — the same shape `shell.config.json` uses for
 * the mobile allow-list, and for the same reason: two hand-maintained copies of
 * one truth drift, and the drift is invisible until it matters.
 *
 * `scope` decides which of the two grounds is emitted as the generic
 * `--telga-ground` / `--telga-ink` set, so a component written once reads
 * correctly in both applications without naming either.
 */
export function cssVariables(scope: 'vellum' | 'leather' = 'vellum'): string {
  const lines: string[] = [];
  const add = (prefix: string, group: Readonly<Record<string, string>>): void => {
    for (const [name, value] of Object.entries(group)) {
      lines.push(`  --telga-${prefix}-${kebab(name)}: ${value};`);
    }
  };
  add('vellum', VELLUM);
  add('leather', LEATHER);
  add('space', SPACE);
  add('type', TYPE);
  add('size', SIZE);
  add('shadow', SHADOW);
  add('layer', LAYER);
  add('motion', MOTION);

  // The active ground, so a shared component names neither application.
  const active = scope === 'leather' ? LEATHER : VELLUM;
  for (const [name, value] of Object.entries(active)) {
    lines.push(`  --telga-${kebab(name)}: ${value};`);
  }

  return `:root {\n${lines.join('\n')}\n}`;
}

/**
 * The CSS for one phase's rule.
 *
 * Returned as a declaration block rather than a class name so each surface can
 * attach it to its own selector. `struck` and `struck-double` are borders on a
 * pseudo-element in the consuming stylesheet; here they resolve to the
 * underlying rule style.
 */
export function phaseRule(pattern: string): string {
  switch (pattern) {
    case 'dotted':
      return 'dotted';
    case 'dashed':
      return 'dashed';
    case 'double':
      return 'double';
    default:
      return 'solid';
  }
}
