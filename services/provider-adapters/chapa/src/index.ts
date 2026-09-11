/**
 * Chapa — an Ethiopian payment company, used as one way a shop pays money in.
 *
 * `CLAUDE.md` §20.2. Not a wallet, not payment acceptance on a customer's
 * behalf: a **deposit method**, beside carrying a slip to a bank counter. The
 * shop pays Chapa, Chapa tells Telga, Telga credits that shop's selling balance.
 *
 * **Switched off.** The flag `deposit.chapa` is false, and this package reaches
 * nothing without a secret key in the environment. Everything here runs against
 * Chapa's sandbox with a `CHASECK_TEST-` key; a live key is a founder decision
 * that needs a contract (§21), not a configuration change.
 */

export * from './signature';
export * from './client';
export * from './decide';
