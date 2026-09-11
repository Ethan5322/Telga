/**
 * The vault must not claim a route is missing when the route exists.
 *
 * ## Why this test exists
 *
 * The founder read the vault on 2026-09-10 and found `⚠️ Written, **not
 * exported**` beside `provisioning.ts`, which had been exported and wired for
 * days, alongside a list of "four gaps" of which three were closed. Their words:
 * *"i cant scan check manualy, use full scan and find out fix issues."*
 *
 * They were right that it cannot be done by hand. A vault of 124 notes accretes
 * claims about the code faster than anybody re-reads them, and a status table
 * that is read as current and is not is worse than no status table at all. One
 * of the stale entries asserted that the POS *"trusts a `merchantId` in the
 * URL"* and was **not a security boundary** — an invitation to "fix" a boundary
 * that already existed.
 *
 * ## What this checks, and what it deliberately does not
 *
 * It checks the **one claim that is mechanically decidable**: a note saying a
 * route does not exist, while that route is served. Prose about design intent,
 * deferred decisions and things genuinely unbuilt is left alone — a vault that
 * could only contain machine-checkable statements would be a much less useful
 * vault.
 *
 * `tenantRouting.ts` having no callers is the shape this must **not** flag: it
 * is true, deliberate under D120, and wiring it would silently reinstate D103.
 *
 * This is the same reconciliation idea already used for feature flags, message
 * strings and the migration table ledger. It follows the standing recommendation
 * in `05 Operations/Runbooks`:
 *
 * > *"A specification change that describes a state machine should land with the
 * > table in the same commit."*
 *
 * Applied here to routes rather than states.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const VAULT = join(ROOT, 'docs', 'obsidian');

/** Every published note, recursively. */
function notes(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...notes(full));
    else if (entry.endsWith('.md')) found.push(full);
  }
  return found;
}

/** Route literals actually served, read from the two servers. */
function servedRoutes(): ReadonlySet<string> {
  const sources = [
    join(ROOT, 'apps', 'merchant-pos', 'src', 'server.ts'),
    join(ROOT, 'apps', 'operations-console', 'src', 'server.ts'),
  ];
  const routes = new Set<string>();
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/path === '(\/[a-z0-9/_-]*)'/gi)) routes.add(m[1]);
    // Parameterised routes, e.g. /^\/merchants\/([^/]+)\/suspend$/
    for (const m of text.matchAll(/\/\^\\\/([a-z-]+)\\\//gi)) routes.add(`/${m[1]}`);
  }
  return routes;
}

describe('the vault does not claim a served route is missing', () => {
  const served = servedRoutes();

  it('found the routes to check against', () => {
    // A regex that silently matched nothing would make this whole suite pass
    // by accident — the failure mode this file exists to prevent, one level up.
    expect(served.size).toBeGreaterThan(30);
    expect(served.has('/login')).toBe(true);
    expect(served.has('/deposit')).toBe(true);
  });

  /**
   * Notes that are **records of the past**, not descriptions of the present.
   *
   * A decision log entry must say what was true on the day it was taken — D112
   * recording that Telga Pay was switched off on 2026-09-06 is correct, and
   * must stay correct even though the flag is on again now. The same goes for
   * an incident write-up: its whole value is describing the system as it was
   * when it broke. Holding these to "current state" would force history to be
   * rewritten, which is precisely what an append-only record must never do.
   */
  const HISTORICAL = [
    '07 Governance/Decision Log.md',
    '05 Operations/Runbooks.md',
    '09 Engineering/Test Stability Runbook.md',
    // The register records **instances that were found** — "`card.simulated`
    // gated `/pay/card` and left nine paths open" is the evidence for R32 and
    // has to keep saying what was actually discovered.
    '07 Governance/Risk Register.md',
  ];

  it('has no note saying a route that exists does not', () => {
    const offenders: string[] = [];

    for (const file of notes(VAULT)) {
      const text = readFileSync(file, 'utf8');
      const name = file.slice(VAULT.length + 1).replace(/\\/g, '/');
      if (HISTORICAL.includes(name) || name.startsWith('99 Templates/')) continue;

      text.split('\n').forEach((line, index) => {
        // Only lines that both name a route and deny it. A line saying "no
        // route redeems an activation code" carries no path and is not
        // mechanically decidable, so it is not this test's business.
        const denies =
          /\bno route\b|\bnot built\b|\bnot wired\b|\bdoes not exist\b|\bnot implemented\b|\bnot reachable\b|\bunreachable\b/i.test(
            line,
          );
        if (!denies) return;

        // Lines already marked as corrections describe the *former* state on
        // purpose, and struck-through text is explicitly historical.
        if (/corrected|was stale|obsolete|closed\b|~~/i.test(line)) return;

        // Past-tense narrative about a fault that was found and fixed. "It
        // gated `/deposit`, a path no route served" is a true sentence about
        // yesterday, and rewriting it would delete the reason the fix exists.
        if (/\bhad\b|\bused to\b|\bpreviously\b|\bwas\b|\bwere\b|\bno longer\b/i.test(line)) return;

        for (const m of line.matchAll(/`(\/[a-z0-9/_-]+)`/gi)) {
          const route = m[1];
          if (served.has(route)) {
            offenders.push(`${name}:${String(index + 1)} claims ${route} is missing`);
          }
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
