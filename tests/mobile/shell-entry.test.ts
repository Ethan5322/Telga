/**
 * What the installed app shows first.
 *
 * Founder, 2026-09-16: *"when i open telga app from my phone installed it shows
 * old first version… it says which telga server? then at bottom it says connect
 * telga server, then automatically shows current pos sign in… it only shows on
 * pos but web its perfect."*
 *
 * ## Why the web was perfect and the app was not
 *
 * This screen is **not served by `telga.pro`**. It is bundled inside the APK —
 * `apps/mobile/www/index.html`, the Capacitor shell — so no deployment could
 * ever change it, and every fix that reached the web left it untouched. That is
 * precisely why the founder saw it only on the installed app.
 *
 * ## Why it appeared when the code already said it should not
 *
 * The logic was right and ran too late. The markup rendered the question, and a
 * script at the foot of the body then decided the answer and redirected — its
 * own comment saying *"a build with one known server does not ask at all."*
 * True, and useless: by the time it ran, the question had been painted. On a
 * POS, slower than a phone, that is not a flicker but a screen.
 *
 * These tests hold the shape that fixes it: the decision happens before the
 * body exists, and the question cannot paint on a build that has an answer.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf-8');

const INDEX = 'apps/mobile/www/index.html';
const CONFIG = 'apps/mobile/www/config.js';

/** Markup with comments removed — a guard reads the code, not the prose. */
const withoutComments = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, '');

describe('a build with one server never asks which one', () => {
  it('decides before the body exists', () => {
    const html = withoutComments(read(INDEX));
    const bodyAt = html.indexOf('<body');
    const redirectAt = html.indexOf('location.replace');

    expect(redirectAt, 'the redirect must exist').toBeGreaterThan(-1);
    expect(
      redirectAt,
      'a redirect after <body> paints the question before answering it',
    ).toBeLessThan(bodyAt);
  });

  it('loads what the decision needs before the decision', () => {
    // `config.js` carries the configured address and `connect.js` the
    // validation. A decision in <head> that cannot see them silently falls
    // through to the form, which is the bug wearing a different hat.
    const html = withoutComments(read(INDEX));
    const bodyAt = html.indexOf('<body');
    for (const script of ['config.js', 'connect.js']) {
      const at = html.indexOf(`<script src="${script}">`);
      expect(at, `${script} must be loaded`).toBeGreaterThan(-1);
      expect(at, `${script} must load before the body`).toBeLessThan(bodyAt);
    }
  });

  it('hides the question in the markup rather than after paint', () => {
    // `hidden` in the attribute, not applied by script: a script that runs a
    // frame late shows the screen the founder reported.
    const html = withoutComments(read(INDEX));
    expect(html).toMatch(/<main[^>]*id="connect-card"[^>]*\shidden/);
  });

  it('carries exactly one redirect and one copy of each script', () => {
    // The old foot-of-body block loaded both scripts a second time and held a
    // second copy of the decision. Two answers to one question is how they
    // drift apart.
    const html = withoutComments(read(INDEX));
    expect((html.match(/location\.replace/g) ?? []).length).toBe(1);
    expect((html.match(/<script src="config\.js">/g) ?? []).length).toBe(1);
    expect((html.match(/<script src="connect\.js">/g) ?? []).length).toBe(1);
  });

  it('has a server configured, so the question has an answer', () => {
    // If this ever became null the form would be correct to appear — so the
    // test states the dependency rather than assuming it.
    const config = read(CONFIG);
    expect(config).toContain('defaultServer');
    expect(config, 'the shell points at the production address').toContain('telga.pro');
  });
});

describe('the form is kept, because a build without an answer still needs it', () => {
  it('still contains the connect form and its validation', () => {
    /**
     * Not deleted. A build with no `defaultServer` and no saved address has to
     * ask somewhere, and `tests/mobile/connect.test.ts` covers the validation
     * behind it.
     *
     * What changed is that a shop with one server is never asked a question
     * with one possible answer.
     */
    const html = read(INDEX);
    expect(html).toContain('id="form"');
    expect(html).toContain('id="server"');
  });

  it('reveals it only when nothing resolves a server', () => {
    const html = withoutComments(read(INDEX));
    // The reveal is the else branch of the decision, not an unconditional show.
    expect(html).toContain('card.hidden = false');
    const revealAt = html.indexOf('card.hidden = false');
    const redirectAt = html.indexOf('location.replace');
    expect(redirectAt, 'the redirect is tried first').toBeLessThan(revealAt);
  });
});
