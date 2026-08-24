/**
 * Money — integer minor units only.
 *
 * Ledger invariant 9: money uses integer minor units, never binary floating
 * point. There is deliberately no constructor, accessor, or arithmetic helper
 * on this module that accepts or returns a fractional number. `fromBirr` takes
 * whole birr and whole santim as two integers precisely so that `0.1 + 0.2`
 * can never enter the ledger.
 */

import { CurrencyMismatchError, InvalidMoneyError, NegativeAmountError } from './errors';

/** Ethiopian birr. 1 birr = 100 santim. */
export type Currency = 'ETB';

export const ETB: Currency = 'ETB';

/** Minor units per major unit, per currency. */
export const MINOR_UNITS_PER_MAJOR: Readonly<Record<Currency, number>> = Object.freeze({
  ETB: 100,
});

export interface Money {
  readonly currency: Currency;
  /** Whole santim. Always a safe integer. May be negative for a signed sum. */
  readonly minor: number;
}

/** Construct Money from whole minor units (santim). */
export function money(minor: number, currency: Currency = ETB): Money {
  if (!Number.isSafeInteger(minor)) {
    throw new InvalidMoneyError(
      `Money must be a safe integer number of minor units; received ${String(minor)}`,
    );
  }
  return Object.freeze({ currency, minor });
}

/**
 * Construct Money from whole birr plus whole santim.
 *
 * Both arguments must be integers. There is no float path into Money by design.
 */
export function fromBirr(birr: number, santim = 0, currency: Currency = ETB): Money {
  if (!Number.isSafeInteger(birr) || !Number.isSafeInteger(santim)) {
    throw new InvalidMoneyError(
      `fromBirr requires whole numbers; received birr=${String(birr)} santim=${String(santim)}`,
    );
  }
  if (santim < 0 || santim >= MINOR_UNITS_PER_MAJOR[currency]) {
    throw new InvalidMoneyError(
      `santim must be between 0 and ${MINOR_UNITS_PER_MAJOR[currency] - 1}; received ${String(santim)}`,
    );
  }
  const sign = birr < 0 ? -1 : 1;
  return money(birr * MINOR_UNITS_PER_MAJOR[currency] + sign * santim, currency);
}

export const zero = (currency: Currency = ETB): Money => money(0, currency);

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor + b.minor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor - b.minor, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.minor, a.currency);
}

/** Multiply by a whole number of times. Deliberately not by a rate — see commission.ts. */
export function times(a: Money, factor: number): Money {
  if (!Number.isSafeInteger(factor)) {
    throw new InvalidMoneyError(`Money may only be multiplied by an integer; received ${String(factor)}`);
  }
  return money(a.minor * factor, a.currency);
}

export function sum(amounts: readonly Money[], currency: Currency = ETB): Money {
  return amounts.reduce<Money>((acc, next) => add(acc, next), zero(currency));
}

export const isZero = (a: Money): boolean => a.minor === 0;
export const isNegative = (a: Money): boolean => a.minor < 0;
export const isPositive = (a: Money): boolean => a.minor > 0;

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.minor < b.minor) return -1;
  if (a.minor > b.minor) return 1;
  return 0;
}

export const equals = (a: Money, b: Money): boolean => a.currency === b.currency && a.minor === b.minor;
export const greaterThan = (a: Money, b: Money): boolean => compare(a, b) === 1;
export const lessThan = (a: Money, b: Money): boolean => compare(a, b) === -1;
export const gte = (a: Money, b: Money): boolean => compare(a, b) >= 0;

/** Throw unless the amount is strictly positive — sales and reservations require it. */
export function assertPositive(a: Money, what: string): void {
  if (!isPositive(a)) {
    throw new NegativeAmountError(`${what} must be a positive amount; received ${format(a)}`);
  }
}

/** Display form. Latin digits with tabular figures, per `04 UX UI/Design System.md`. */
export function format(a: Money): string {
  const per = MINOR_UNITS_PER_MAJOR[a.currency];
  const negative = a.minor < 0;
  const abs = Math.abs(a.minor);
  const major = Math.floor(abs / per);
  const minor = abs % per;
  const grouped = major.toLocaleString('en-US');
  return `${negative ? '-' : ''}${grouped}.${String(minor).padStart(2, '0')} ${a.currency}`;
}
