/**
 * @telga/api — application services.
 *
 * TRAINING MODE — NO REAL VALUE. The orchestration refuses a non-TRAINING mode
 * at the door, and the persistence layer beneath it refuses to store a
 * live-money row at all.
 */

export * from './application/results';
export * from './application/context';
export { createSale } from './application/createSale';
export { resolvePending } from './application/resolvePending';
export { requireReversal, completeReversal, SUPERVISOR_ROLES } from './application/reversal';
export type { ReversalApproval } from './application/reversal';
export { rehydrate, persistRehydrated } from './application/rehydrate';
export * from './application/recovery/config';
export * from './application/recovery/results';
export * from './application/recovery/recoverInFlight';
export * from './application/recovery/metrics';

// --- authentication: training mode only -------------------------------------
export * from './auth/index';

// --- authentication: training mode only -------------------------------------
export * from './auth/index';

// --- HTTP surface: training mode only ---------------------------------------
export * from './http/contract';
export * from './http/deps';
export * from './http/readModel';
export * from './http/guard';
export * from './http/handlers';
export * from './http/authHandlers';
export * from './http/router';
