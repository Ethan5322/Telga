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
    const key = match[1];
    const en = (match[2]).trim();
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
        'screen.menu',
        'screen.vouchers',
        'screen.product_type',
        'screen.order_details',
        'screen.pin_auth',
        'screen.voucher_result',
        // `screen.launcher` and `screen.launcher_apps` were translated when the
        // launcher was rebuilt (D101), so they are no longer in the gap.
        'screen.dashboard',
        'screen.coming_soon',
        'screen.pay_entry',
        'screen.pay_amount',
        'screen.pay_card',
        'screen.pay_result',
        'support.response.notice',
        // §20.1's bank-deposit strings. The short labels are translated;
        // these are left to fall back to English **on purpose**. They are
        // the safety-critical sentences — where to pay, never to pay an
        // employee's personal account, and that no balance exists yet — and
        // unverified Amharic on those is worse than English a shopkeeper can
        // ask about. A native speaker translates them before pilot.
        'bank_deposit.lede',
        'bank_deposit.amount_label',
        'bank_deposit.limits',
        'bank_deposit.print_slip',
        'bank_deposit.not_yet_money',
        'bank_deposit.slip_title',
        'bank_deposit.slip_status',
        'bank_deposit.account_name',
        'bank_deposit.account_number',
        'bank_deposit.quote_reference',
        'bank_deposit.never_personal_account',
        'bank_deposit.credited_later',
        'bank_deposit.already_open',
        'bank_deposit.view_slip',
        'bank_deposit.cancel',
        'bank_deposit.cancel_confirm',
        'bank_deposit.no_account',
        'bank_deposit.refused.shop_not_active',
        'bank_deposit.refused.amount_invalid',
        'bank_deposit.refused.amount_below_minimum',
        'bank_deposit.refused.amount_above_maximum',
        'bank_deposit.refused.order_already_open',
        'bank_deposit.refused.deposits_disabled',
        'bank_deposit.close_note',
        'bank_deposit.test_account',
        'pay.deposit.entry',
        'transfer.lede',
        'transfer.recipient',
        'transfer.device_hint',
        'transfer.pin',
        'transfer.confirm',
        'transfer.sent',
        'transfer.final',
        'transfer.needs_approval',
        'transfer.not_moved',
        'transfer.training_only',
        'transfer.refused.sender_not_active',
        'transfer.refused.recipient_unknown',
        'transfer.refused.recipient_not_active',
        'transfer.refused.same_shop',
        'transfer.refused.insufficient',
        'transfer.refused.over_limit',
        'transfer.refused.amount_invalid',
        'chapa.title',
        'chapa.lede',
        'chapa.pay_now',
        'chapa.slip_title',
        'chapa.slip_status',
        'chapa.method_value',
        'chapa.credited_later',
        'chapa.keep_reference',
        'chapa.refused.unavailable',
        'chapa.refused.disabled',
      ].sort(),
    );
  });

  it('reports the coverage honestly', () => {
    const coverage = translationCoverage('am');
    expect(coverage.total).toBe(MESSAGE_KEYS.length);
    expect(coverage.translated).toBe(MESSAGE_KEYS.length - 79);
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
