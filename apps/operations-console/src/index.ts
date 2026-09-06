/**
 * The Telga Operations Console.
 *
 * Authorised Telga staff only. A separate application from the merchant POS
 * and from Telga Pay — see `09 Engineering/Admin Operations Console`.
 */

export { createConsoleServer } from './server';
export type { ConsoleOptions, ConsoleDb } from './server';
export * from './ui/page';
export * from './ui/screens';
