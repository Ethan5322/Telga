/**
 * Recovery worker command-line entry point.
 *
 * This is the runtime the deployment starts, and the runtime the child-process
 * tests spawn. It is deliberately thin: parse arguments, build the worker, run
 * it, report, exit with a meaningful code.
 *
 * `--once` performs exactly one sweep and exits after releasing its claims.
 * That mode exists so a test can prove process separation without leaving a
 * supervised loop running forever, and so an operator can run a single sweep by
 * hand — see `05 Operations/Worker Operations Runbook.md`.
 *
 * TRAINING MODE — NO REAL VALUE. `--mode` accepts only `TRAINING`; anything
 * else exits non-zero before a database is opened.
 */

import { providerId as makeProviderId, productId, timestamp } from '@telga/domain';
import { simulatedCatalog } from '@telga/api';
import { assertMigrationsApplied, SqliteLedgerDriver } from '@telga/persistence';
import { MockAirtimeProvider } from '@telga/provider-mock-airtime';
import type { MockBehaviour } from '@telga/provider-mock-airtime';
import type { ProviderStatus } from '@telga/domain';
import { createRecoveryWorker } from './recoveryWorker';
import { ShutdownController } from './shutdown';
import { collectingMetrics } from './observability';
import type { WorkerLogEvent } from './observability';
import { DEVELOPMENT_RECOVERY_WORKER_POLICY, validateWorkerPolicy } from './workerConfig';
import type { RecoveryWorkerPolicy } from './workerConfig';

export const EXIT = Object.freeze({
  ok: 0,
  badArguments: 2,
  notTrainingMode: 3,
  configurationInvalid: 4,
  runtimeFailure: 5,
  migrationsNotApplied: 6,
});

export interface CliArgs {
  readonly db: string;
  readonly workerId: string;
  readonly mode: string;
  readonly once: boolean;
  readonly behaviour: MockBehaviour;
  readonly statusOverride?: ProviderStatus['outcome'];
  readonly json: boolean;
  /** Apply migrations. Only ever run from a single writer — see A30. */
  readonly migrate: boolean;
  readonly overrides: Partial<RecoveryWorkerPolicy>;
}

const NUMERIC_FLAGS: readonly (keyof RecoveryWorkerPolicy)[] = [
  'recoveryIntervalMs',
  'recoveryJitterMs',
  'recoveryBatchLimit',
  'recoveryAgeMs',
  'pendingMaximumMs',
  'maxStatusAttempts',
  'claimLeaseMs',
  'statusCheckIntervalMs',
  'failureBackoffInitialMs',
  'failureBackoffMaximumMs',
  'failureBackoffMultiplier',
  'gracefulShutdownTimeoutMs',
];

/** Parse `--flag value` and `--flag=value`, plus the matching environment keys. */
export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = {}): CliArgs {
  const flags = new Map<string, string>();
  const bare = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const body = token.slice(2);
    if (body.includes('=')) {
      const [key, ...rest] = body.split('=');
      flags.set(key ?? '', rest.join('='));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(body, next);
      i += 1;
    } else {
      bare.add(body);
    }
  }

  const overrides: Record<string, number> = {};
  for (const flag of NUMERIC_FLAGS) {
    const raw = flags.get(String(flag)) ?? env[`TELGA_${String(flag).replace(/([A-Z])/g, '_$1').toUpperCase()}`];
    if (raw !== undefined && raw !== '') {
      const value = Number(raw);
      if (Number.isFinite(value)) overrides[String(flag)] = value;
    }
  }

  return {
    db: flags.get('db') ?? env.TELGA_DB ?? '',
    workerId: flags.get('worker-id') ?? env.TELGA_WORKER_ID ?? `worker_${String(process.pid)}`,
    mode: flags.get('mode') ?? env.TELGA_MODE ?? 'TRAINING',
    once: bare.has('once') || flags.get('once') === 'true' || env.TELGA_RUN_ONCE === 'true',
    behaviour: (flags.get('behaviour') ?? env.TELGA_MOCK_BEHAVIOUR ?? 'SUCCESS') as MockBehaviour,
    statusOverride: (flags.get('status') ?? env.TELGA_MOCK_STATUS) as ProviderStatus['outcome'] | undefined,
    json: bare.has('json') || env.TELGA_JSON === 'true',
    migrate: bare.has('migrate') || flags.get('migrate') === 'true' || env.TELGA_MIGRATE === 'true',
    overrides: overrides as Partial<RecoveryWorkerPolicy>,
  };
}

export interface CliResult {
  readonly workerId: string;
  readonly pid: number;
  readonly claimed: number;
  readonly duplicateWorkersPrevented: number;
  readonly recoveredSuccessful: number;
  readonly recoveredFailed: number;
  readonly movedToPending: number;
  readonly escalatedUnderReview: number;
  readonly found: number;
  /**
   * Why a claimed transaction produced no outcome.
   *
   * Without these three, a sweep that claims work and resolves none of it
   * reports a row of zeroes and explains nothing — which is exactly the state a
   * supervised worker most needs to account for. Added after a full-suite
   * failure showed `claimed: 1` beside `recoveredSuccessful: 0` with no field
   * that could say why. See A54.
   */
  readonly skipped: number;
  readonly recoveryFailures: number;
  /**
   * The safe reason codes behind `recoveryFailures`, deduplicated.
   *
   * A count says a sweep failed; a code says why. These are the stable codes the
   * recovery service already produces — never a raw error message, never a
   * provider body. Without them an operator seeing `recoveryFailures: 1` has to
   * go and read a log that may not exist.
   */
  readonly failureReasonCodes: readonly string[];
  /** True when the sweep stopped at a safe boundary before exhausting the batch. */
  readonly stoppedEarly: boolean;
  readonly ledgerResidualMinor: number;
  readonly status: string;
  readonly level: string;
}

/** Run the CLI. Returns an exit code rather than calling `process.exit`. */
export async function run(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = {},
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  writeError: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<number> {
  const args = parseArgs(argv, env);

  if (args.db === '') {
    writeError('Missing --db <path>. The worker will not guess a database location.');
    return EXIT.badArguments;
  }

  // Checked before anything is opened.
  if (args.mode !== 'TRAINING') {
    writeError(`Refusing to run in mode "${args.mode}". TRAINING MODE — NO REAL VALUE is the only supported mode.`);
    return EXIT.notTrainingMode;
  }

  let policy: RecoveryWorkerPolicy;
  try {
    policy = validateWorkerPolicy({
      ...DEVELOPMENT_RECOVERY_WORKER_POLICY,
      ...args.overrides,
      recoveryWorkerEnabled: true,
      runInitialSweepOnStart: true,
    });
  } catch (error) {
    writeError(`Invalid worker configuration: ${error instanceof Error ? error.name : 'unknown'}`);
    return EXIT.configurationInvalid;
  }

  // Opened WITHOUT migrating. Migration ownership is a single-writer startup
  // procedure: a worker that migrated on its own would be the untested
  // concurrent-migration case recorded as A30.
  const driver = new SqliteLedgerDriver({ file: args.db });

  if (args.migrate) {
    driver.migrate(timestamp(new Date()));
  } else {
    try {
      assertMigrationsApplied(driver.unsafeConnection);
    } catch (error) {
      writeError(error instanceof Error ? error.message : 'Refusing to start: migrations not applied');
      driver.close();
      return EXIT.migrationsNotApplied;
    }
  }

  const shutdown = new ShutdownController();
  shutdown.install(process);
  const metrics = collectingMetrics();

  const logs: WorkerLogEvent[] = [];
  const logger = { log: (event: WorkerLogEvent) => logs.push(event) };

  try {
    const worker = createRecoveryWorker({
      workerId: args.workerId,
      policy,
      driver,
      provider: new MockAirtimeProvider({
        providerId: makeProviderId('provider_simulated'),
        behaviour: args.behaviour,
        statusOverride: args.statusOverride,
      }),
      providerId: makeProviderId('provider_simulated'),
      catalog: simulatedCatalog([
        { id: productId('AIRTIME'), label: 'Airtime (simulated)', available: true },
      ]),
      recipientSalt: env.TELGA_RECIPIENT_SALT ?? 'cli-salt-not-a-production-secret',
      mode: 'TRAINING',
      shutdown,
      logger,
      metrics,
    });

    if (!args.once) {
      // A long-running supervised loop. Stops on SIGTERM or SIGINT.
      const health = await worker.start();
      emit(write, args, health, driver, args.workerId, undefined);
      return EXIT.ok;
    }

    const report = await worker.runOnce();
    // Release before exit, so a following process is not blocked by our lease.
    driver.releaseClaimsOwnedBy(args.workerId, timestamp(new Date()));
    emit(write, args, worker.health(), driver, args.workerId, report);
    return EXIT.ok;
  } catch (error) {
    writeError(`Worker failed: ${error instanceof Error ? error.name : 'unknown error'}`);
    return EXIT.runtimeFailure;
  } finally {
    shutdown.dispose();
    try {
      driver.close();
    } catch {
      // already closed
    }
  }
}

function emit(
  write: (line: string) => void,
  args: CliArgs,
  health: { status: string; level: string },
  driver: SqliteLedgerDriver,
  workerId: string,
  report:
    | {
        found: number;
        claimed: number;
        duplicateWorkersPrevented: number;
        recoveredSuccessful: number;
        recoveredFailed: number;
        movedToPending: number;
        escalatedUnderReview: number;
        skipped: number;
        recoveryFailures: number;
        stoppedEarly: boolean;
        results?: readonly { kind: string; reasonCode?: string }[];
      }
    | undefined,
): void {
  const result: CliResult = {
    workerId,
    pid: process.pid,
    claimed: report?.claimed ?? 0,
    duplicateWorkersPrevented: report?.duplicateWorkersPrevented ?? 0,
    recoveredSuccessful: report?.recoveredSuccessful ?? 0,
    recoveredFailed: report?.recoveredFailed ?? 0,
    movedToPending: report?.movedToPending ?? 0,
    escalatedUnderReview: report?.escalatedUnderReview ?? 0,
    found: report?.found ?? 0,
    skipped: report?.skipped ?? 0,
    recoveryFailures: report?.recoveryFailures ?? 0,
    failureReasonCodes: [
      ...new Set(
        (report?.results ?? [])
          .filter((r) => r.kind === 'RECOVERY_FAILED' && r.reasonCode !== undefined)
          .map((r) => r.reasonCode as string),
      ),
    ],
    stoppedEarly: report?.stoppedEarly ?? false,
    ledgerResidualMinor: driver.ledgerResidualMinor(),
    status: health.status,
    level: health.level,
  };

  // A single machine-readable line, so a parent process can assert on it.
  write(args.json ? JSON.stringify(result) : `${workerId} pid=${String(process.pid)} claimed=${String(result.claimed)}`);
}

/** Entry point when executed directly. */
async function main(): Promise<void> {
  const code = await run(process.argv.slice(2), process.env);
  process.exitCode = code;
}

// `require.main === module` is the CommonJS form; the build emits CommonJS.
declare const require: { main?: unknown } | undefined;
declare const module: unknown;

if (typeof require !== 'undefined' && require.main === module) {
  void main();
}
