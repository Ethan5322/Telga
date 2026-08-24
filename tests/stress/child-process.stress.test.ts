/**
 * The A54 reproduction harness.
 *
 * Repeats the two multi-process racing scenarios from
 * `tests/build/child-process.test.ts` many times over, each on a fresh database
 * with unique worker ids and its own temporary directory, capturing **everything**
 * a diagnosis could need — and preserving it on disk the moment anything fails.
 *
 * ## Why this exists rather than running the real file in a loop
 *
 * The real file boots Vitest each time; a hundred repetitions of that is mostly
 * process startup. More importantly, the real file's `afterEach` **deletes the
 * database**, which is where the answer lives: the recovery service already
 * writes a `RECOVERY_ATTEMPT_FAILED` audit event carrying a safe code, and every
 * failing run so far has thrown that evidence away before anyone could read it.
 *
 * `scripts/stress-child-process.mjs` runs this file, and then the real file
 * several times, so both claims are covered: the scenario is exercised at
 * volume here, and the actual test file is exercised as itself there.
 *
 * ## What is captured on failure
 *
 * Seed, iteration, command line, database path, migration versions, worker
 * configuration, transaction rows, claim rows, pending rows, audit rows, ledger
 * rows and residual, both workers' full reports, both children's complete stdout
 * and stderr, exit codes and signals, PIDs, and timings — written under
 * `stress-logs/child-process/`.
 *
 * Recipient data is masked at rest by the persistence layer, and the dump
 * carries no PIN, token, key or provider credential.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timestamp, transactionId } from '@telga/domain';
import { createSale } from '@telga/api';
import { makeRecoveryHarness, MERCHANT_A, saleRequest } from '../recovery/helpers';
import type { RecoveryHarness } from '../recovery/helpers';
import { failAt, withDriver } from '../orchestration/helpers';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'services', 'worker', 'dist', 'cli.js');
const ARTIFACTS = join(ROOT, 'stress-logs', 'child-process');

const ITERATIONS = Number(process.env['TELGA_CHILD_STRESS_ITERATIONS'] ?? '100');

let harnesses: RecoveryHarness[] = [];
let preserve = false;

afterEach(() => {
  // A failing iteration keeps its database: the audit trail inside it is the
  // evidence. Successful iterations are cleaned.
  if (!preserve) for (const h of harnesses) h.cleanup();
  harnesses = [];
  preserve = false;
});

interface ChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly pid: number | undefined;
  readonly durationMs: number;
  readonly argv: readonly string[];
  readonly json?: Record<string, unknown>;
}

function runWorker(db: string, args: readonly string[]): Promise<ChildResult> {
  const argv = [CLI, '--db', db, '--json', ...args];
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd: ROOT,
      env: { ...process.env, TELGA_MODE: 'TRAINING' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const line = stdout.trim().split('\n').filter(Boolean).pop();
      let json: Record<string, unknown> | undefined;
      if (line?.startsWith('{')) {
        try {
          json = JSON.parse(line) as Record<string, unknown>;
        } catch {
          json = undefined;
        }
      }
      resolve({
        code,
        signal,
        stdout,
        stderr,
        pid: child.pid,
        durationMs: Date.now() - startedAt,
        argv,
        json,
      });
    });
  });
}

/** Seed a transaction stuck at PROCESSING, aged so a child finds it eligible. */
async function stuckProcessing(h: RecoveryHarness, clientRequestId: string): Promise<string> {
  const before = new Set(h.driver.findTransactionsByMerchant(MERCHANT_A).map((r) => r.id));
  const deps = withDriver(h.deps, failAt(h.driver, 'saveTransaction', 5));
  await expect(createSale(deps, saleRequest({ clientRequestId }))).rejects.toThrow();

  const row = h.driver.findTransactionsByMerchant(MERCHANT_A).find((r) => !before.has(r.id));
  expect(row?.state).toBe('PROCESSING');
  const txId = row?.id ?? '';
  h.driver.unsafeConnection
    .prepare('UPDATE transactions SET updated_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 600_000).toISOString(), txId);
  return txId;
}

/** Everything in the database that could explain a failed recovery. */
function dumpDatabase(h: RecoveryHarness): Record<string, unknown> {
  const all = (sql: string): unknown[] => h.driver.unsafeConnection.prepare(sql).all();
  return {
    migrations: all('SELECT version, name, applied_at FROM schema_migrations ORDER BY version'),
    transactions: all('SELECT * FROM transactions'),
    claims: all('SELECT * FROM recovery_claims'),
    pending: all('SELECT * FROM pending_resolutions'),
    // The audit trail is where `RECOVERY_ATTEMPT_FAILED` records its safe code.
    audit: all('SELECT * FROM audit_events ORDER BY created_at, id'),
    ledgerEntries: all('SELECT * FROM ledger_entries ORDER BY created_at, id'),
    ledgerResidualMinor: h.driver.ledgerResidualMinor(),
    reservations: all('SELECT * FROM balance_reservations'),
  };
}

/** Write the complete failing artifact and return where it went. */
function preserveArtifact(
  scenario: string,
  iteration: number,
  seed: string,
  h: RecoveryHarness,
  children: readonly ChildResult[],
  extra: Record<string, unknown>,
): string {
  preserve = true;
  mkdirSync(ARTIFACTS, { recursive: true });
  const file = join(ARTIFACTS, `${scenario}-iter${String(iteration)}-${seed}.json`);

  const artifact = {
    scenario,
    iteration,
    seed,
    at: new Date().toISOString(),
    parentPid: process.pid,
    databaseFile: h.file,
    // Environment, minus anything that could carry a secret.
    environment: Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => k.startsWith('TELGA_') && !/PIN|SECRET|TOKEN|KEY|PASS/i.test(k),
      ),
    ),
    platform: { platform: process.platform, node: process.version, cpus: os.cpus().length },
    children: children.map((c) => ({
      argv: c.argv,
      pid: c.pid,
      code: c.code,
      signal: c.signal,
      durationMs: c.durationMs,
      report: c.json,
      stdout: c.stdout,
      stderr: c.stderr,
    })),
    database: dumpDatabase(h),
    ...extra,
  };

  writeFileSync(file, JSON.stringify(artifact, null, 2), 'utf8');
  return file;
}


describe('A54 — multi-process recovery under repetition', () => {
  it('has compiled output to run', () => {
    // The stress script builds first. A stress run against stale output would
    // prove nothing, and building here is exactly what A51 says not to do.
    expect(
      existsSync(CLI),
      'Run `npm run build:clean` before the child-process stress; this never builds.',
    ).toBe(true);
  });

  it(
    `two workers race one transaction, ${String(ITERATIONS)} times`,
    async () => {
      for (let i = 1; i <= ITERATIONS; i += 1) {
        const seed = `${String(Date.now())}-${String(i)}`;
        const h = makeRecoveryHarness(`cpstress-race-${seed}`);
        harnesses = [h];
        const txId = await stuckProcessing(h, `req_race_${seed}`);

        const [a, b] = await Promise.all([
          runWorker(h.file, ['--once', '--worker-id', `w_a_${seed}`, '--status', 'SUCCESS']),
          runWorker(h.file, ['--once', '--worker-id', `w_b_${seed}`, '--status', 'SUCCESS']),
        ]);

        const recovered =
          Number(a.json?.['recoveredSuccessful'] ?? 0) +
          Number(b.json?.['recoveredSuccessful'] ?? 0);
        const state = h.driver.findTransaction(transactionId(txId), MERCHANT_A)?.state;
        const residual = h.driver.ledgerResidualMinor();

        const settlements = h.driver
          .readEntriesByTransaction(transactionId(txId))
          .filter((e) => e.account_type === 'PROVIDER_SETTLEMENT');

        const wrong =
          a.code !== 0 ||
          b.code !== 0 ||
          recovered !== 1 ||
          state !== 'SUCCESSFUL' ||
          residual !== 0 ||
          settlements.length !== 1;

        if (wrong) {
          const where = preserveArtifact('race', i, seed, h, [a, b], {
            transactionId: txId,
            observed: { recovered, state, residual, settlements: settlements.length },
            expected: {
              recovered: 1,
              state: 'SUCCESSFUL',
              residual: 0,
              settlements: 1,
            },
          });
          throw new Error(
            `A54 REPRODUCED on iteration ${String(i)} (seed ${seed}).\n` +
              `  recovered=${String(recovered)} state=${String(state)} ` +
              `residual=${String(residual)} settlements=${String(settlements.length)}\n` +
              `  full artifact: ${where}`,
          );
        }

        for (const one of harnesses) one.cleanup();
        harnesses = [];
      }
      expect(true).toBe(true);
    },
    30 * 60_000,
  );

  it(
    `two workers resolve two transactions, ${String(ITERATIONS)} times`,
    async () => {
      for (let i = 1; i <= ITERATIONS; i += 1) {
        const seed = `${String(Date.now())}-${String(i)}`;
        const h = makeRecoveryHarness(`cpstress-two-${seed}`, { fundBirr: 1000 });
        harnesses = [h];
        const first = await stuckProcessing(h, `req_a_${seed}`);
        const second = await stuckProcessing(h, `req_b_${seed}`);

        const [a, b] = await Promise.all([
          runWorker(h.file, ['--once', '--worker-id', `w_a_${seed}`, '--status', 'SUCCESS']),
          runWorker(h.file, ['--once', '--worker-id', `w_b_${seed}`, '--status', 'SUCCESS']),
        ]);

        const recovered =
          Number(a.json?.['recoveredSuccessful'] ?? 0) +
          Number(b.json?.['recoveredSuccessful'] ?? 0);
        const failures =
          Number(a.json?.['recoveryFailures'] ?? 0) + Number(b.json?.['recoveryFailures'] ?? 0);
        const residual = h.driver.ledgerResidualMinor();
        const states = [first, second].map(
          (id) => h.driver.findTransaction(transactionId(id), MERCHANT_A)?.state,
        );

        const wrong = a.code !== 0 || b.code !== 0 || recovered < 1 || residual !== 0;

        if (wrong) {
          const where = preserveArtifact('two-transactions', i, seed, h, [a, b], {
            transactionIds: [first, second],
            observed: { recovered, failures, residual, states },
            expected: { recoveredAtLeast: 1, residual: 0 },
          });
          throw new Error(
            `A54 REPRODUCED on iteration ${String(i)} (seed ${seed}).\n` +
              `  recovered=${String(recovered)} recoveryFailures=${String(failures)} ` +
              `residual=${String(residual)} states=${states.join(',')}\n` +
              `  full artifact: ${where}`,
          );
        }

        for (const one of harnesses) one.cleanup();
        harnesses = [];
      }
      expect(true).toBe(true);
    },
    30 * 60_000,
  );
});
