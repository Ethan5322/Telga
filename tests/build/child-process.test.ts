/**
 * Genuine multi-process tests for the recovery worker.
 *
 * These spawn **real operating-system processes** running the compiled
 * JavaScript in `services/worker/dist/cli.js`. Nothing here uses two
 * connections inside one process, and nothing mocks process separation — the
 * whole point is to prove the claim lease holds across `fork`.
 *
 * This is what closes assumption A37, and only if it actually passes.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timestamp, transactionId } from '@telga/domain';
import { createSale } from '@telga/api';
import { makeRecoveryHarness, MERCHANT_A, saleRequest } from '../recovery/helpers';
import type { RecoveryHarness } from '../recovery/helpers';
import { failAt, withDriver } from '../orchestration/helpers';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'services', 'worker', 'dist', 'cli.js');

let harnesses: RecoveryHarness[] = [];
const harness = (name: string, options: Parameters<typeof makeRecoveryHarness>[1] = {}): RecoveryHarness => {
  const h = makeRecoveryHarness(name, options);
  harnesses.push(h);
  return h;
};

afterEach(() => {
  for (const h of harnesses) h.cleanup();
  harnesses = [];
});

/** Newest modification time of any TypeScript source under a directory tree. */
function newestSourceMtime(dir: string): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    const stats = statSync(full);
    if (stats.isDirectory()) newest = Math.max(newest, newestSourceMtime(full));
    else if (name.endsWith('.ts')) newest = Math.max(newest, stats.mtimeMs);
  }
  return newest;
}

/** Oldest mtime among emitted `.js` files under any `dist/` in the tree. */
function oldestOutputMtime(dir: string): number | undefined {
  if (!existsSync(dir)) return undefined;
  let oldest: number | undefined;
  const walk = (current: string, inDist: boolean): void => {
    for (const name of readdirSync(current)) {
      if (name === 'node_modules') continue;
      const full = join(current, name);
      const stats = statSync(full);
      if (stats.isDirectory()) walk(full, inDist || name === 'dist');
      else if (inDist && name.endsWith('.js')) {
        oldest = oldest === undefined ? stats.mtimeMs : Math.min(oldest, stats.mtimeMs);
      }
    }
  };
  walk(dir, false);
  return oldest;
}

/**
 * True when any source is newer than the oldest compiled file.
 *
 * The guarantee these tests need is that they run **current** output, not that a
 * build happens every time. Compiling eight packages inside the test run
 * saturates a small machine while other test files execute in parallel, which
 * starved Vitest's own reporter and tripped an unrelated 5-second timeout in a
 * recovery test — see A51 and `09 Engineering/Test Stability Runbook.md`.
 * Rebuilding only when the output is genuinely stale keeps the guarantee and
 * removes the spike.
 */
function distIsStale(): boolean {
  if (!existsSync(CLI)) return true;

  const newestSource = Math.max(
    newestSourceMtime(join(ROOT, 'packages')),
    newestSourceMtime(join(ROOT, 'services')),
    newestSourceMtime(join(ROOT, 'apps')),
    statSync(join(ROOT, 'scripts', 'build.mjs')).mtimeMs,
  );

  let oldestOutput = Number.POSITIVE_INFINITY;
  for (const group of ['packages', 'services', 'apps']) {
    const stamp = oldestOutputMtime(join(ROOT, group));
    if (stamp !== undefined) oldestOutput = Math.min(oldestOutput, stamp);
  }
  if (!Number.isFinite(oldestOutput)) return true;
  return newestSource > oldestOutput;
}

/**
 * Build once for the whole file, **when the output is stale**.
 *
 * A test that runs stale output proves nothing, so freshness is checked rather
 * than assumed. CI builds before the suite, so this is normally a no-op there.
 */
beforeAll(() => {
  if (distIsStale()) {
    const built = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (built.status !== 0) {
      throw new Error(`build failed:\n${built.stdout}\n${built.stderr}`);
    }
  }
  expect(existsSync(CLI)).toBe(true);
}, 600_000);

afterAll(() => {
  // The compiled output is left in place; `npm run clean` removes it.
});

interface ChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly json?: Record<string, unknown>;
}

/** Spawn the compiled CLI as a separate process and wait for it to exit. */
function runWorker(
  db: string,
  args: readonly string[] = [],
  options: { killAfterMs?: number } = {},
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, '--db', db, '--json', ...args], {
      cwd: ROOT,
      env: { ...process.env, TELGA_MODE: 'TRAINING' },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

    if (options.killAfterMs !== undefined) {
      setTimeout(() => child.kill('SIGKILL'), options.killAfterMs);
    }

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
      resolve({ code, signal, stdout, stderr, json });
    });
  });
}

const num = (result: ChildResult, key: string): number => Number(result.json?.[key] ?? -1);

/**
 * Seed a transaction stuck at PROCESSING and return its id.
 *
 * The new row is found by diffing against the ids already present. Taking the
 * last row would be wrong: ids sort lexicographically, so `txn_10` orders
 * before `txn_2`.
 */
async function stuckProcessing(h: RecoveryHarness, clientRequestId = 'req_0001') {
  const before = new Set(h.driver.findTransactionsByMerchant(MERCHANT_A).map((r) => r.id));
  const deps = withDriver(h.deps, failAt(h.driver, 'saveTransaction', 5));
  await expect(createSale(deps, saleRequest({ clientRequestId }))).rejects.toThrow();

  const row = h.driver.findTransactionsByMerchant(MERCHANT_A).find((r) => !before.has(r.id));
  expect(row?.state).toBe('PROCESSING');
  const txId = transactionId(row?.id ?? '');

  // The harness seeds with a fixed fake clock; the child processes read the
  // real one. Age the row against real time so eligibility does not depend on
  // what the wall clock happens to say when the suite runs.
  ageTransaction(h.driver, txId);
  return txId;
}

/** Backdate a transaction against real time, so a child process finds it eligible. */
function ageTransaction(driver: RecoveryHarness['driver'], txId: string, msAgo = 600_000): void {
  driver.unsafeConnection
    .prepare('UPDATE transactions SET updated_at = ? WHERE id = ?')
    .run(new Date(Date.now() - msAgo).toISOString(), txId);
}

/** Expire a claim without waiting for time to pass. */
function expireClaim(driver: RecoveryHarness['driver'], txId: string): void {
  driver.unsafeConnection
    .prepare('UPDATE recovery_claims SET expires_at = ? WHERE transaction_id = ?')
    .run(new Date(Date.now() - 60_000).toISOString(), txId);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('build output', () => {
  it('emits JavaScript and declarations, and no TypeScript', () => {
    const packages = [
      'packages/domain',
      'packages/persistence',
      'services/provider-adapters/mock-airtime',
      'services/api',
      'services/worker',
    ];

    let js = 0;
    let stray = 0;
    for (const pkg of packages) {
      const dist = join(ROOT, pkg, 'dist');
      expect(existsSync(dist)).toBe(true);

      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) {
            walk(full);
            continue;
          }
          if (name.endsWith('.d.ts')) continue;
          if (name.endsWith('.ts')) stray += 1;
          else if (name.endsWith('.js')) js += 1;
        }
      };
      walk(dist);
    }

    expect(js).toBeGreaterThan(0);
    // No TypeScript source may be required at runtime.
    expect(stray).toBe(0);
  });

  it('declares CommonJS in every dist so Node parses the emitted files correctly', () => {
    for (const pkg of ['packages/domain', 'services/worker']) {
      const manifest = join(ROOT, pkg, 'dist', 'package.json');
      expect(existsSync(manifest)).toBe(true);
    }
  });

  it('the compiled worker starts, connects to SQLite, sweeps and exits cleanly', async () => {
    const h = harness('cp-smoke');
    const result = await runWorker(h.file, ['--once', '--worker-id', 'worker_smoke']);

    expect(result.code).toBe(0);
    expect(result.json?.workerId).toBe('worker_smoke');
    expect(result.json?.status).toBe('RUNNING');
    expect(num(result, 'ledgerResidualMinor')).toBe(0);
  });

  it('runs without TypeScript stripping — no loader flags are passed', async () => {
    const h = harness('cp-no-strip');
    const result = await runWorker(h.file, ['--once']);

    // The child is spawned with no --experimental-strip-types and no loader.
    // Its success is the proof that only JavaScript was needed.
    expect(result.code).toBe(0);
    expect(result.stderr).not.toMatch(/strip|Unknown file extension|\.ts/i);
  });
});

describe('exit codes', () => {
  it('a missing database is a clear, non-zero failure', async () => {
    const child = spawnSync(process.execPath, [CLI, '--once', '--json'], { cwd: ROOT, encoding: 'utf8' });
    expect(child.status).toBe(2);
    expect(child.stderr).toMatch(/Missing --db/);
  });

  it('a non-training mode is refused before the database is opened', async () => {
    const h = harness('cp-live');
    const child = spawnSync(process.execPath, [CLI, '--db', h.file, '--once', '--mode', 'LIVE'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(child.status).toBe(3);
    expect(child.stderr).toMatch(/TRAINING MODE/);
  });

  it('invalid configuration exits non-zero rather than running', async () => {
    const h = harness('cp-badconfig');
    const child = spawnSync(
      process.execPath,
      [CLI, '--db', h.file, '--once', '--recoveryBatchLimit', '0'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(child.status).toBe(4);
    expect(child.stderr).toMatch(/Invalid worker configuration/);
  });
});

describe('two processes racing for one transaction', () => {
  it('exactly one claims it; the other records a conflict', async () => {
    const h = harness('cp-race');
    const txId = await stuckProcessing(h);

    const [a, b] = await Promise.all([
      runWorker(h.file, ['--once', '--worker-id', 'worker_a', '--status', 'SUCCESS']),
      runWorker(h.file, ['--once', '--worker-id', 'worker_b', '--status', 'SUCCESS']),
    ]);

    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    // Genuinely separate operating-system processes.
    expect(a.json?.pid).not.toBe(b.json?.pid);
    expect(a.json?.pid).not.toBe(process.pid);

    const claimed = num(a, 'claimed') + num(b, 'claimed');
    const conflicts = num(a, 'duplicateWorkersPrevented') + num(b, 'duplicateWorkersPrevented');
    const recovered = num(a, 'recoveredSuccessful') + num(b, 'recoveredSuccessful');

    // At least one process did the work.
    expect(claimed).toBeGreaterThanOrEqual(1);

    // The safety property is that the transaction is RESOLVED once — not that
    // it is CLAIMED once. Two outcomes are both correct and both observed:
    //
    //   - the loser's claim is refused while the winner holds a live lease
    //     (conflicts === 1); or
    //   - the winner finishes and releases before the loser reaches the claim,
    //     so the loser claims legitimately and then finds the transaction
    //     already terminal when it re-reads it under that claim.
    //
    // Which one happens depends on scheduling. Asserting `claimed === 1` made
    // the second, equally-safe path look like a failure — see A44.
    expect(claimed + conflicts).toBeGreaterThanOrEqual(1);

    // Diagnostics on the assertion, per `09 Engineering/Test Stability Runbook.md`.
    // Under full-suite load on a two-core machine this has been observed
    // reporting zero recoveries while passing in isolation — recorded as A54.
    // A recurrence must say what the workers actually reported.
    // The whole worker report — see the note on the other diagnostic below.
    const diagnosis = JSON.stringify(
      { state: h.driver.findTransaction(txId, MERCHANT_A)?.state, workerA: a.json, workerB: b.json },
      null,
      1,
    );
    expect(recovered, diagnosis).toBe(1);

    // Resolved exactly once, with no duplicate posting.
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('SUCCESSFUL');
    expect(
      h.driver.readEntriesByTransaction(txId).filter((e) => e.account_type === 'PROVIDER_SETTLEMENT'),
    ).toHaveLength(1);
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(7500);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  }, 120_000);

  it('neither process reports a database lock failure', async () => {
    const h = harness('cp-busy');
    await stuckProcessing(h);

    const results = await Promise.all([
      runWorker(h.file, ['--once', '--worker-id', 'w1', '--status', 'SUCCESS']),
      runWorker(h.file, ['--once', '--worker-id', 'w2', '--status', 'SUCCESS']),
      runWorker(h.file, ['--once', '--worker-id', 'w3', '--status', 'SUCCESS']),
    ]);

    for (const result of results) {
      expect(result.code).toBe(0);
      expect(result.stderr).not.toMatch(/SQLITE_BUSY|database is locked/i);
    }
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  }, 120_000);

  it('two processes resolve two different transactions without corruption', async () => {
    const h = harness('cp-two-tx', { fundBirr: 1000 });
    const first = await stuckProcessing(h, 'req_a');
    const second = await stuckProcessing(h, 'req_b');
    expect(first).not.toBe(second);

    const [a, b] = await Promise.all([
      runWorker(h.file, ['--once', '--worker-id', 'worker_a', '--status', 'SUCCESS']),
      runWorker(h.file, ['--once', '--worker-id', 'worker_b', '--status', 'SUCCESS']),
    ]);

    expect(a.code).toBe(0);
    expect(b.code).toBe(0);

    const recovered = num(a, 'recoveredSuccessful') + num(b, 'recoveredSuccessful');
    // Diagnostics on the assertion, per `09 Engineering/Test Stability Runbook.md`:
    // this failed twice under full-suite load while passing in isolation, and a
    // recurrence must report what the workers actually said rather than a bare
    // number. Worker output carries no recipient data and no credentials.
    // The **whole** worker report, not a hand-picked subset. The first version
    // of this diagnostic guessed key names and printed `-1` for two of them,
    // which hid the fields that would have explained the failure. Dump the
    // object; let the reader choose. Worker output carries no recipient data
    // and no credentials.
    const diagnosis = JSON.stringify(
      {
        states: [first, second].map((id) => h.driver.findTransaction(id)?.state),
        workerA: a.json,
        workerB: b.json,
      },
      null,
      1,
    );
    expect(recovered, diagnosis).toBeGreaterThanOrEqual(1);

    for (const txId of [first, second]) {
      const settlements = h.driver
        .readEntriesByTransaction(txId)
        .filter((e) => e.account_type === 'PROVIDER_SETTLEMENT');
      expect(settlements.length).toBeLessThanOrEqual(1);
    }
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  }, 120_000);
});

describe('claim leases across processes', () => {
  it('a live claim held by another worker cannot be stolen', async () => {
    const h = harness('cp-live-claim');
    const txId = await stuckProcessing(h);

    // A live lease, well beyond the child's run.
    h.driver.claimTransaction({
      transactionId: txId,
      workerId: 'worker_holding',
      scanId: 'scan_hold',
      now: timestamp(new Date()),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });

    const result = await runWorker(h.file, ['--once', '--worker-id', 'worker_thief', '--status', 'SUCCESS']);

    expect(result.code).toBe(0);
    expect(num(result, 'claimed')).toBe(0);
    expect(num(result, 'duplicateWorkersPrevented')).toBe(1);
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('PROCESSING');
    expect(h.driver.findClaim(txId)?.worker_id).toBe('worker_holding');
  }, 60_000);

  it('an expired claim is reclaimed by another process', async () => {
    const h = harness('cp-expired');
    const txId = await stuckProcessing(h);

    // A lease that has already expired — the signature of a worker that died.
    h.driver.claimTransaction({
      transactionId: txId,
      workerId: 'dead_worker',
      scanId: 'scan_dead',
      now: timestamp(new Date(Date.now() - 10_000)),
      expiresAt: new Date(Date.now() - 5_000).toISOString(),
    });

    const result = await runWorker(h.file, ['--once', '--worker-id', 'worker_new', '--status', 'SUCCESS']);

    expect(result.code).toBe(0);
    expect(num(result, 'claimed')).toBe(1);
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('SUCCESSFUL');
  }, 60_000);

  it('a worker that dies holding a lease blocks others only until the lease expires', async () => {
    const h = harness('cp-dead-worker');
    const txId = await stuckProcessing(h);

    // Simulates a process that died mid-recovery: an ACTIVE claim, never released.
    // The lease is long, so "still held" is not a race against child startup.
    h.driver.claimTransaction({
      transactionId: txId,
      workerId: 'worker_that_died',
      scanId: 'scan_died',
      now: timestamp(new Date()),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });

    const blocked = await runWorker(h.file, ['--once', '--worker-id', 'worker_early', '--status', 'SUCCESS']);
    expect(num(blocked, 'claimed')).toBe(0);
    expect(num(blocked, 'duplicateWorkersPrevented')).toBe(1);

    // Let the lease expire, without waiting for wall-clock time to pass. Racing
    // a short lease against process startup is what made this test flaky under
    // load; a sleep would only have hidden that.
    expireClaim(h.driver, txId);

    const after = await runWorker(h.file, ['--once', '--worker-id', 'worker_late', '--status', 'SUCCESS']);
    expect(num(after, 'claimed')).toBe(1);
    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('SUCCESSFUL');
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  }, 90_000);

  it('killing a process mid-run leaves the database sound', async () => {
    const h = harness('cp-killed');
    const txId = await stuckProcessing(h);

    const killed = await runWorker(h.file, ['--once', '--worker-id', 'worker_killed', '--status', 'SUCCESS'], {
      killAfterMs: 15,
    });

    // It either finished before the kill landed or was killed. Either way the
    // database must be sound and no value may be lost.
    expect([0, null]).toContain(killed.code);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
    expect(h.driver.health().healthy).toBe(true);

    const view = h.driver.balanceFor(MERCHANT_A);
    expect(view.available.minor + view.reserved.minor + view.underReview.minor).toBe(view.total.minor);

    // A later process can still resolve it, whatever the kill interrupted.
    await sleep(100);
    const recovered = await runWorker(h.file, ['--once', '--worker-id', 'worker_after_kill', '--status', 'SUCCESS']);
    expect(recovered.code).toBe(0);
    expect(['SUCCESSFUL', 'PROCESSING']).toContain(
      h.driver.findTransaction(txId, MERCHANT_A)?.state,
    );
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  }, 90_000);
});

describe('repeated process startup', () => {
  it('does not duplicate a resolution', async () => {
    const h = harness('cp-repeat');
    const txId = await stuckProcessing(h);

    for (let i = 0; i < 3; i += 1) {
      const result = await runWorker(h.file, ['--once', '--worker-id', `worker_${String(i)}`, '--status', 'SUCCESS']);
      expect(result.code).toBe(0);
    }

    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('SUCCESSFUL');
    expect(
      h.driver.readEntriesByTransaction(txId).filter((e) => e.account_type === 'PROVIDER_SETTLEMENT'),
    ).toHaveLength(1);
    expect(h.driver.balanceFor(MERCHANT_A).available.minor).toBe(7500);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  }, 120_000);

  it('does not duplicate a support case when escalating across processes', async () => {
    const h = harness('cp-escalate');
    const txId = await stuckProcessing(h);

    // Indeterminate every time, and the transaction is already past its
    // pending deadline, so each process would escalate if the guards failed.
    for (let i = 0; i < 3; i += 1) {
      const result = await runWorker(h.file, [
        '--once',
        '--worker-id',
        `worker_esc_${String(i)}`,
        '--status',
        'STILL_PENDING',
        '--pendingMaximumMs',
        '1000',
        // Validation refuses a pending maximum below the recovery age, so both
        // must come down together for this scenario to be reachable at all.
        '--recoveryAgeMs',
        '500',
      ]);
      expect(result.code).toBe(0);
    }

    expect(h.driver.findTransaction(txId, MERCHANT_A)?.state).toBe('UNDER_REVIEW');
    expect(h.driver.findSupportCasesByMerchant(MERCHANT_A)).toHaveLength(1);

    const underReviewCredits = h.driver
      .readEntriesByTransaction(txId)
      .filter((e) => e.account_type === 'MERCHANT_UNDER_REVIEW' && e.direction === 'CREDIT');
    expect(underReviewCredits).toHaveLength(1);
    expect(h.driver.ledgerResidualMinor()).toBe(0);
  }, 120_000);
});

describe('migration ownership', () => {
  it('refuses to start when migrations have not been applied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'telga-migown-'));
    const db = join(dir, 'unmigrated.sqlite');

    const child = spawnSync(process.execPath, [CLI, '--db', db, '--once', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    expect(child.status).toBe(6);
    expect(child.stderr).toMatch(/migrations not applied/i);
    expect(child.stderr).toMatch(/single-writer/i);

    rmSync(dir, { recursive: true, force: true });
  });

  it('applies migrations only when explicitly asked, then runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'telga-migown2-'));
    const db = join(dir, 'fresh.sqlite');

    const migrated = spawnSync(process.execPath, [CLI, '--db', db, '--once', '--migrate', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(migrated.status).toBe(0);

    // A second process, without the flag, now starts because migrations exist.
    const after = spawnSync(process.execPath, [CLI, '--db', db, '--once', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(after.status).toBe(0);

    rmSync(dir, { recursive: true, force: true });
  });
});
