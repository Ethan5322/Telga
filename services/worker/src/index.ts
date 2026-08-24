/**
 * @telga/worker — background workers.
 *
 * TRAINING MODE — NO REAL VALUE. The worker refuses any mode but `TRAINING`,
 * and every layer beneath it refuses independently.
 *
 * Real system time is read in exactly one place: `systemWorkerClock` in
 * `workerLifecycle.ts`. Everything below the worker takes time as an argument.
 */

export * from './workerConfig';
export * from './backoff';
export * from './failures';
export * from './observability';
export * from './shutdown';
export * from './workerHealth';
export * from './workerLifecycle';
export * from './recoveryWorker';
