/**
 * The string tables, checked against the vault.
 *
 * `04 UX UI/English Strings.md` and `04 UX UI/Amharic Strings.md` are the
 * authoritative sources. This file parses them and fails if the package has
 * drifted, so a string cannot be changed in code and left stale in the notes —
 * or the reverse.
 *
 * It also pins the **Amharic gap**. Fourteen keys have no Amharic. That is a
 * fact worth failing a test over when it changes: if someone adds a translation
 * the count moves, and if someone quietly machine-translates the lot the test
 * says so.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AM,
  AMHARIC_REVIEW_WARNING,
  EN,
  LOCALES,
  MESSAGE_KEYS,
  isLocale,
  isMessageKey,
  missingTranslations,
  t,
  translate,
  translateUnknown,
  translationCoverage,
} from '@telga/localization';
import type { MessageKey } from '@telga/localization';
import { MESSAGE_KEYS as RESULT_MESSAGE_KEYS } from '@telga/api';

const VAULT = join(process.cwd(), 'docs', 'obsidian', '04 UX UI');

/** Pull `| \`key\` | english | …` rows out of a vault table. */
function vaultRows(file: string): Map<string, { en: string; am?: string }> {
  const text = readFileSync(join(VAULT, file), 'utf-8');
  const rows = new Map<string, { en: string; am?: string }>();
  for (const line of text.split('\n')) {
    const match = /^\|\s*`([a-z0-9._]+)`\s*\|([^|]*)\|(?:([^|]*)\|)?/.exec(line);
    if (!match) continue;
    const key = match[1] as string;
    const en = (match[2] as string).trim();
    const third = match[3]?.trim();
    // In the Amharic note the third column is Amharic; in the English note it
    // does not exist, and the row ends after the English column.
    rows.set(key, { en, am: third });
  }
  return rows;
}

describe('the English table matches the vault', () => {
  it('has exactly the keys the vault lists', () => {
    const vault = vaultRows('English Strings.md');
    expect([...vault.keys()].sort()).toEqual([...MESSAGE_KEYS].sort());
  });

  it('has the same text for every key', () => {
    const vault = vaultRows('English Strings.md');
    for (const key of MESSAGE_KEYS) {
      expect(EN[key], `English text for ${key} has drifted from the vault`).toBe(
        vault.get(key)?.en,
      );
    }
  });
});

describe('the Amharic table matches the vault', () => {
  it('has the same text for every key the vault translates', () => {
    const vault = vaultRows('Amharic Strings.md');
    for (const [key, row] of vault) {
      expect(isMessageKey(key), `${key} is in the Amharic note but not in the package`).toBe(true);
      expect(AM[key as MessageKey], `Amharic text for ${key} has drifted`).toBe(row.am);
    }
  });

  it('translates nothing the vault has not translated', () => {
    const vault = vaultRows('Amharic Strings.md');
    for (const key of Object.keys(AM)) {
      expect(vault.has(key), `${key} has Amharic in code but not in the vault`).toBe(true);
    }
  });
});

describe('the Amharic gap is explicit', () => {
  it('is exactly the screen titles and the support notice', () => {
    expect([...missingTranslations('am')].sort()).toEqual(
      [
        'screen.login',
        'screen.home',
        'screen.provider_select',
        'screen.amount_select',
        'screen.recipient',
        'screen.confirm',
        'screen.balance',
        'screen.search',
        'screen.details',
        'screen.reports',
        'screen.funding',
        'screen.support',
        'screen.admin_queue',
        'support.response.notice',
      ].sort(),
    );
  });

  it('reports the coverage honestly', () => {
    const coverage = translationCoverage('am');
    expect(coverage.total).toBe(MESSAGE_KEYS.length);
    expect(coverage.translated).toBe(MESSAGE_KEYS.length - 14);
    expect(translationCoverage('en').translated).toBe(MESSAGE_KEYS.length);
  });

  it('says when it fell back to English rather than pretending', () => {
    const fallback = translate('am', 'screen.home');
    expect(fallback.fellBackToEnglish).toBe(true);
    expect(fallback.text).toBe(EN['screen.home']);

    const real = translate('am', 'status.pending.do_not_retry');
    expect(real.fellBackToEnglish).toBe(false);
    expect(real.text).not.toBe(EN['status.pending.do_not_retry']);
  });

  it('carries the review warning verbatim', () => {
    expect(AMHARIC_REVIEW_WARNING).toBe('REQUIRES NATIVE AMHARIC REVIEW BEFORE PRODUCTION');
  });
});

describe('resolution', () => {
  it('resolves every key in every locale without returning undefined', () => {
    for (const locale of LOCALES) {
      for (const key of MESSAGE_KEYS) {
        expect(typeof t(locale, key), `${locale}/${key}`).toBe('string');
        expect(t(locale, key).length, `${locale}/${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('rejects an unknown locale and an unknown key', () => {
    expect(isLocale('fr')).toBe(false);
    expect(isMessageKey('status.probably.fine')).toBe(false);
    expect(translateUnknown('en', 'status.probably.fine')).toBeUndefined();
  });

  it('resolves every message key the application services return', () => {
    for (const [name, key] of Object.entries(RESULT_MESSAGE_KEYS)) {
      expect(isMessageKey(key), `${name} returns "${key}", which no string table has`).toBe(true);
    }
  });
});
