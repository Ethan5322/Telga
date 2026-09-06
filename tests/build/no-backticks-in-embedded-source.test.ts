/**
 * No backticks inside the embedded stylesheet or client script.
 *
 * Both are TypeScript template literals holding CSS and JavaScript. A
 * backtick anywhere inside one — most easily in a comment, writing
 * `like this` — terminates the literal early. What follows is then parsed as
 * TypeScript, and the error surfaces hundreds of lines away as something
 * unrelated ("Type 'String' has no call signatures").
 *
 * This has broken the build four separate times, each costing a diagnosis
 * from scratch. The rule is trivially checkable, so it is checked here rather
 * than rediscovered.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = 'apps/merchant-pos/src/ui/document.ts';

/** The span of a template literal assigned to `name`, or undefined. */
function literalBody(source: string, name: string): string | undefined {
  const start = source.indexOf(`const ${name} = \``);
  if (start === -1) return undefined;
  const from = source.indexOf('`', start) + 1;
  const to = source.indexOf('`', from);
  return to === -1 ? undefined : source.slice(from, to);
}

describe('the embedded stylesheet and client script', () => {
  const source = readFileSync(SOURCE, 'utf-8');

  it('are both present as template literals', () => {
    expect(literalBody(source, 'STYLES'), 'STYLES literal').toBeDefined();
    expect(literalBody(source, 'CLIENT_SCRIPT'), 'CLIENT_SCRIPT literal').toBeDefined();
  });

  it('contain no backtick, which would end the literal early', () => {
    for (const name of ['STYLES', 'CLIENT_SCRIPT']) {
      const body = literalBody(source, name);
      expect(body, `${name} should be readable`).toBeDefined();
      // If a backtick had slipped in, the body would have been cut short at
      // it — so a body that is suspiciously small is the same bug.
      expect((body ?? '').length, `${name} looks truncated`).toBeGreaterThan(500);
    }
  });

  it('contain no ${ ... } interpolation, which would splice code into CSS', () => {
    for (const name of ['STYLES', 'CLIENT_SCRIPT']) {
      const body = literalBody(source, name) ?? '';
      // These are static assets. An interpolation here would put a runtime
      // value inside a stylesheet or a script, which is how a nonce-protected
      // page grows an injection point.
      expect(body.includes('${'), `${name} must stay static`).toBe(false);
    }
  });
});
