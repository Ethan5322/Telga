/**
 * @telga/domain — the Telga domain layer.
 *
 * Pure types and functions: no I/O, no database, no network, no framework.
 * That is what makes the transition table exhaustively testable and the ledger
 * invariants provable in isolation.
 *
 * TRAINING MODE — NO REAL VALUE. This package refuses to operate on anything
 * marked LIVE; see `mode.ts`.
 */

export * from './errors';
export * from './ids';
export * from './money';
export * from './mode';
export * from './states';
export * from './idempotency';
export * from './ledger';
export * from './balance';
export * from './commission';
export * from './provider';
export * from './receipt';
export * from './auth';
export * from './audit';
export * from './transaction';
