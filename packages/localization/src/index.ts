/**
 * @telga/localization — English and draft Amharic strings.
 *
 * Two things this package refuses to do:
 *
 *  1. **Silently substitute English for Amharic.** `translate` returns the
 *     string *and* whether it fell back, so a screen can mark an untranslated
 *     label rather than pretending it is translated.
 *  2. **Invent Amharic.** Fourteen keys have no Amharic yet. They stay missing
 *     until a native reviewer supplies them — see `04 UX UI/Amharic Strings.md`.
 */

export * from './strings';

import { DEFAULT_LOCALE, EN, LOCALES, MESSAGE_KEYS, TABLES } from './strings';
import type { Locale, MessageKey } from './strings';

export interface Translation {
  readonly key: MessageKey;
  readonly locale: Locale;
  readonly text: string;
  /** True when `locale` had no entry and English was used instead. */
  readonly fellBackToEnglish: boolean;
}

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

export function isMessageKey(value: string): value is MessageKey {
  return (MESSAGE_KEYS as readonly string[]).includes(value);
}

/** Resolve a key, reporting a fallback rather than hiding it. */
export function translate(locale: Locale, key: MessageKey): Translation {
  const text = TABLES[locale][key];
  if (text !== undefined) {
    return { key, locale, text, fellBackToEnglish: false };
  }
  return { key, locale, text: EN[key], fellBackToEnglish: true };
}

/** Just the string. For places where the fallback flag is not needed. */
export function t(locale: Locale, key: MessageKey): string {
  return translate(locale, key).text;
}

/**
 * Resolve an arbitrary string that is *claimed* to be a message key.
 *
 * The application services return `messageKey` as a plain string. An unknown
 * key is a bug, and this surfaces it as one instead of rendering `undefined`.
 */
export function translateUnknown(locale: Locale, key: string): Translation | undefined {
  return isMessageKey(key) ? translate(locale, key) : undefined;
}

/** Keys with no entry in `locale`. Empty for English by construction. */
export function missingTranslations(locale: Locale): readonly MessageKey[] {
  const table = TABLES[locale];
  return MESSAGE_KEYS.filter((key) => table[key] === undefined);
}

export function translationCoverage(locale: Locale): { translated: number; total: number } {
  const missing = missingTranslations(locale).length;
  return { translated: MESSAGE_KEYS.length - missing, total: MESSAGE_KEYS.length };
}

/**
 * The warning that must accompany any Amharic surface until review is complete.
 * Rendered by the POS, not merely written in a note.
 */
export const AMHARIC_REVIEW_WARNING = 'REQUIRES NATIVE AMHARIC REVIEW BEFORE PRODUCTION';

export { DEFAULT_LOCALE };
