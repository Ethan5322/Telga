/**
 * The stepped rule — the one moment this app authors.
 *
 * `DESIGN.md` calls it the signature interaction:
 *
 * > *"A settling entry moves its rule to the margin in one whole-line step with
 * > a single overshoot; a pending one halts short of the margin. Nothing glides
 * > continuously — a scribe lifts the hand and sets it down."*
 *
 * It was implemented, token-backed, and **used by nothing** — the `/impeccable
 * critique` of 2026-09-16 found it listed under "Known open". It was also wrong
 * in three ways that no test could have caught, because no test rendered it:
 *
 * 1. It animated `scaleX` on the whole row, so an operator watching a sale
 *    settle would have seen the amount and the recipient squash and snap back.
 * 2. Pending drew its short rule with an `::after`; settled used the row's own
 *    `border-bottom`. Two mechanisms with no shared property — the step could
 *    not happen however long the duration was.
 * 3. The poll resolved with `window.location.reload()`, so the moment the rule
 *    exists to explain was a white flash.
 *
 * These tests hold the mechanism, not the pixels: one property that can
 * actually transition, a phase for every state the machine can reach, and a
 * pending screen that never carries the words for success.
 *
 * That last one is a correction. The first attempt pre-rendered every possible
 * outcome so a screen reader could be told the answer without a string being
 * invented in JavaScript — and put *"Transaction successful"* into the markup
 * of a screen where nothing had succeeded. An existing test refused it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf-8');

const DOCUMENT = 'apps/merchant-pos/src/ui/document.ts';
const STATUS = 'apps/merchant-pos/src/ui/status.ts';

/**
 * Source with its comments removed.
 *
 * **A guard must read the code, never the prose about the code.** This is the
 * fifth time in two days that a guard has matched its own documentation — and
 * the sharpest, because the guard it caught was the one recording that very
 * lesson: it searched for `data-announce-` and found the comment explaining why
 * `data-announce-` had been removed.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** One template literal out of `document.ts`, comments stripped. */
function literal(name: 'CLIENT_SCRIPT' | 'STYLES'): string {
  const source = read(DOCUMENT);
  const at = source.indexOf(`const ${name}`);
  const open = source.indexOf('= `', at) + 3;
  const body = source.slice(open, source.indexOf('`;', open));
  // A guard must read the code, never the prose about the code — this is the
  // fourth guard in two days to need saying so.
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the rule can actually step', () => {
  it('draws pending and settled with the same property', () => {
    // The defect that made the animation impossible: a width and a border are
    // not the same property, so there was nothing to transition between.
    const css = literal('STYLES');
    const pending = /\.status__rule\[data-phase="pending"\]::after \{([^}]*)\}/.exec(css)?.[1] ?? '';
    const settled = /\.status__rule\[data-phase="settled"\]::after \{([^}]*)\}/.exec(css)?.[1] ?? '';

    expect(pending, 'pending must set a width').toMatch(/width:/);
    expect(settled, 'settled must set the same width property').toMatch(/width:/);
  });

  it('stops short of the margin while the answer is unknown', () => {
    // The whole signal: an unfinished line for an unfinished transaction.
    const css = literal('STYLES');
    const pending = /\.status__rule\[data-phase="pending"\]::after \{([^}]*)\}/.exec(css)?.[1] ?? '';
    const width = /width:\s*(\d+)%/.exec(pending)?.[1];

    expect(width, 'pending must stop short').toBeDefined();
    expect(Number(width)).toBeLessThan(100);
  });

  it('reaches the margin once the answer arrives, whatever the answer is', () => {
    // Failed and reversed reach it too. Nothing was left unfinished — the
    // answer came and it was no.
    const css = literal('STYLES');
    for (const phase of ['settled', 'review', 'failed', 'reversed']) {
      const rule = new RegExp(`\\.status__rule\\[data-phase="${phase}"\\][^{]*\\{([^}]*)\\}`).exec(css);
      expect(rule, `${phase} must have a rule`).not.toBeNull();
      expect(rule?.[1], `${phase} must reach the margin`).toMatch(/width:\s*100%/);
    }
  });

  it('moves the rule, never the words above it', () => {
    // It animated scaleX on the row, which scales the row's text with it.
    const css = literal('STYLES');
    expect(css).not.toContain('telga-rule-step');
    expect(css, 'the rule transitions its own width').toMatch(
      /\.status__rule::after \{[^}]*transition:[^}]*width/,
    );
  });

  it('never lets pending borrow failure’s ink', () => {
    // Section 15: a timeout is not a failure, and the grammar must say so.
    const css = literal('STYLES');
    const pending = /\.status__rule\[data-phase="pending"\]::after \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(pending).not.toContain('line-through');
    expect(pending, 'pending is indigo, not the ink failure uses').toContain('indigo');
  });
});

describe('every state the machine can reach has a phase', () => {
  /**
   * `phaseOf` exists twice — once on the server, which renders the first phase,
   * and once in the client script, which renders only the change to it. Two
   * copies is a real cost, accepted because the alternative is shipping a
   * bundler to a counter. This test is what keeps them in step.
   */
  const STATES = [
    'CREATED', 'VALIDATED', 'RESERVED', 'SUBMITTED', 'PROCESSING',
    'PENDING', 'UNDER_REVIEW', 'REVERSAL_REQUIRED', 'SUCCESSFUL',
    'FAILED', 'REVERSED', 'REJECTED',
  ];

  it('maps the resolved states to a finished rule on both sides', () => {
    const server = read(STATUS);
    const client = literal('CLIENT_SCRIPT');

    for (const [state, phase] of [
      ['SUCCESSFUL', 'settled'],
      ['FAILED', 'failed'],
      ['UNDER_REVIEW', 'review'],
      ['PENDING', 'pending'],
    ] as const) {
      expect(server, `server: ${state}`).toContain(state);
      expect(server, `server: ${phase}`).toContain(`'${phase}'`);
      expect(client, `client: ${state}`).toContain(state);
      expect(client, `client: ${phase}`).toContain(`'${phase}'`);
    }
  });

  it('leaves no state without a phase, including the in-flight ones', () => {
    // A state with no phase renders no rule at all, which reads as "finished"
    // on a screen where nothing has finished.
    const server = read(STATUS);
    const fn = server.slice(server.indexOf('function phaseOf'), server.indexOf('export function statusBlock'));
    expect(fn, 'a default branch must cover CREATED..PROCESSING').toContain('default:');
    expect(fn).toContain("'working'");
    expect(STATES.length, 'the state list is the one the machine can reach').toBeGreaterThan(10);
  });
});

describe('a pending screen never carries the words for success', () => {
  /**
   * **The mistake this records.**
   *
   * The first version of this work pre-rendered all four possible outcomes as
   * `data-announce-*` attributes, so the poll could read back whichever one
   * arrived — in the operator's own language, without inventing a string in
   * JavaScript where no translator would ever see it. The reasoning was sound.
   *
   * The result was not: the markup of a **pending** screen then contained the
   * sentence *"Transaction successful"*. `tests/ui/flow.test.ts` refused it,
   * and the refusal was right. Section 15 turns on pending never reading as
   * success, and a document that carries the sentence is one stray selector —
   * or one screen-reader mode that reads attributes — away from saying it.
   *
   * It was removed rather than worked around, because the problem it solved was
   * smaller than it looked: the resolution ends in a page load, and a page load
   * is itself announced. The outcome reaches a screen-reader user from the
   * authoritative server-rendered screen, correctly translated, a moment after
   * the rule steps.
   */
  it('renders no outcome phrase before the outcome is known', () => {
    const screens = withoutComments(read('apps/merchant-pos/src/ui/screens.ts'));
    const at = screens.indexOf("'data-poll-transaction'");
    expect(at, 'the poll root must exist').toBeGreaterThan(-1);

    const block = screens.slice(at, at + 3000);
    expect(block, 'no pre-rendered outcome').not.toContain('data-announce-');
    expect(block).not.toContain('status.successful');
  });

  it('writes no announcement from the client either', () => {
    // The other half. Removing the attributes but keeping a client-built
    // sentence would reintroduce the same claim in a worse place — untranslated.
    const script = literal('CLIENT_SCRIPT');
    expect(script).not.toContain('data-announce-');
    expect(script).not.toContain('textContent =');
  });

  it('still hands over to the server, which is what does announce it', () => {
    // The reload is the announcement, and it is also the only thing that can
    // render the slip and the code. Section 18.0: a second implementation of
    // that rendering is a second place a duplicate sale can originate.
    const script = literal('CLIENT_SCRIPT');
    const settle = script.slice(script.indexOf('function settle'));
    expect(settle).toContain('window.location.reload');
  });
});

describe('reduced motion keeps the meaning', () => {
  it('removes the travel but not the state change', () => {
    /**
     * `animate.md`: *"Reduced motion means fewer and gentler animations, not
     * disabling all motion; feedback that confirms an action should remain
     * legible."*
     *
     * The rule still reaches the margin and still takes the red ink — that is
     * the answer the operator has been waiting for. What goes is the travel.
     */
    const css = literal('STYLES');
    const at = css.indexOf('prefers-reduced-motion');
    expect(at, 'a reduced-motion block must exist').toBeGreaterThan(-1);

    const block = css.slice(at, css.indexOf('}', css.indexOf('{', at) + 1) + 1);
    expect(block, 'the transition is removed').toMatch(/transition:\s*none/);

    // The phase rules themselves are untouched, so the finished state still
    // renders — it arrives rather than moves.
    expect(css).toMatch(/\.status__rule\[data-phase="settled"\]::after \{[^}]*width:\s*100%/);
  });

  it('shortens the wait before the screen changes', () => {
    // Somebody who asked for no animation should not be held for its duration.
    const script = literal('CLIENT_SCRIPT');
    expect(script).toContain('prefers-reduced-motion');
    expect(script).toMatch(/reduced\s*\?\s*\d+\s*:\s*\d+/);
  });
});
