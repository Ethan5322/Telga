/**
 * No invented phone number reaches a merchant or a customer.
 *
 * `ASSUMPTIONS.md` A74 recorded a support contact of `+251 000 000 000
 * (training placeholder)` on the help screen. A string shaped like a phone
 * number is one an operator will dial, the parenthetical is not read, and the
 * same text is printed on a receipt and handed to a customer — so an absence
 * is a better answer than a placeholder. Worse still if a digit string that
 * looks Ethiopian ever reached a real subscriber.
 *
 * This test is the guard against it coming back. It reads source, not a
 * rendered screen, because the failure it prevents is somebody typing a
 * plausible number into a constant — which is exactly how the first one got
 * there.
 *
 * CLAUDE.md §30: *never invent* contacts. Replacing this is a launch gate
 * (§8, "support escalation assigned"), not a text edit.
 */

import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { globSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

/** Every TypeScript source file that ships, tests and build output excluded. */
function shippedSources(): readonly string[] {
  return globSync(['apps/**/src/**/*.ts', 'services/**/src/**/*.ts', 'packages/**/src/**/*.ts'], {
    cwd: ROOT,
  })
    .map((file) => resolve(ROOT, file))
    .filter((file) => !file.split(sep).includes('node_modules'))
    .filter((file) => !file.split(sep).includes('dist'));
}

describe('the support contact is honest', () => {
  it('contains no Ethiopian-looking phone number anywhere in shipped source', () => {
    // `+251` is Ethiopia's dialling code. Any literal starting with it is
    // either a real number nobody authorised or a fake one somebody will dial.
    const offenders: string[] = [];
    for (const file of shippedSources()) {
      const source = readFileSync(file, 'utf-8');
      for (const [index, line] of source.split(/\r?\n/).entries()) {
        // Skip the comments that explain why the number was removed — the ban
        // is on the value, not on the discussion of it.
        if (/^\s*(\*|\/\/)/.test(line)) continue;
        if (/\+\s?251[\s\d-]{4,}/.test(line)) {
          offenders.push(`${relative(ROOT, file)}:${index + 1}`);
        }
      }
    }
    expect(offenders, `phone-number literals found at: ${offenders.join(', ')}`).toEqual([]);
  });

  it('offers no long run of digits dressed as a contact number', () => {
    // Catches `000 000 000` and friends without the country code in front.
    const offenders: string[] = [];
    for (const file of shippedSources()) {
      const source = readFileSync(file, 'utf-8');
      for (const [index, line] of source.split(/\r?\n/).entries()) {
        if (/^\s*(\*|\/\/)/.test(line)) continue;
        if (!/phone|tel:|contact/i.test(line)) continue;
        if (/\d[\d\s-]{7,}\d/.test(line)) {
          offenders.push(`${relative(ROOT, file)}:${index + 1}`);
        }
      }
    }
    expect(offenders, `contact-shaped digit runs at: ${offenders.join(', ')}`).toEqual([]);
  });

  it('uses only the reserved .example domain for the training address', () => {
    // RFC 2606 reserves `.example`; it can never be registered, so the address
    // cannot start resolving to somebody else's mail server. A plausible domain
    // eventually would.
    const content = readFileSync(resolve(ROOT, 'apps/merchant-pos/src/ui/content.ts'), 'utf-8');
    const addresses = content.match(/[\w.-]+@[\w.-]+/g) ?? [];
    expect(addresses.length).toBeGreaterThan(0);
    for (const address of addresses) {
      expect(address, `${address} is not a reserved example address`).toMatch(
        /@[\w.-]*\.(example|invalid|test)$/,
      );
    }
  });

  it('says on the receipt that the desk is not staffed', () => {
    // The receipt leaves the shop. If it names a support contact without
    // saying nobody answers it, the paper makes a promise the build cannot
    // keep — and the customer is the one holding it.
    const reprint = readFileSync(resolve(ROOT, 'services/api/src/application/reprint.ts'), 'utf-8');
    const line = /export const SUPPORT_CONTACT =\s*\n?\s*'([^']+)'/.exec(reprint)?.[1] ?? '';
    expect(line).toContain('@telga.example');
    expect(line.toLowerCase()).toContain('not staffed');
  });

  it('says on the help screen that nobody is on call', () => {
    const content = readFileSync(resolve(ROOT, 'apps/merchant-pos/src/ui/content.ts'), 'utf-8');
    expect(content).toMatch(/notice:\s*'[^']*not staffed[^']*'/);
    // And the phone field is absent rather than filled with something.
    expect(content).toMatch(/phone:\s*undefined/);
  });
});
