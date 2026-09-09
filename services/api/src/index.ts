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
export * from './application/voucherOrders';
export * from './application/reprint';
export * from './application/settings';
export * from './application/deposits';
export * from './application/profitTransfer';
export * from './application/shopTransfer';
export * from './application/changePin';
export * from './auth/totp';
export * from './auth/adminSessions';
export * from './auth/emailOtp';
export * from './admin/tenants';
export * from './admin/applications';
export * from './admin/enrollment';
export * from './admin/provisioning';
export * from './admin/applicationIntake';
export * from './admin/redeemEnrollment';
export * from './admin/deviceKeyCheck';
export * from './admin/documentVault';
export * from './admin/multipart';
export * from './admin/issueCredentials';
export * from './admin/recordDeposit';
export * from './application/unlock';
export * from './application/cardPurchase';
export * from './application/cardSettlement';
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
export * from './http/health';
export * from './http/router';
