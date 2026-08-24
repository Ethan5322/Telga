/**
 * The POS entry point.
 *
 * Argument parsing and the two refusals that matter — a non-training mode, and
 * an unmigrated database — plus a real child process that proves the compiled
 * output actually starts and actually refuses.
 *
 * The child-process cases run against `dist/`, so they fail if the build is
 * stale or if the emitted module format is wrong. That is the same reasoning
 * that closed A37 for the worker: a claim about a process is only worth making
 * if a process was run.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteDriver } from '@telga/persistence';
import { timestamp } from '@telga/domain';
import { CliArgumentError, TRAINING_CATALOG, parseArgs } from '@telga/merchant-pos';

const CLI = join(process.cwd(), 'apps', 'merchant-pos', 'dist', 'cli.js');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `telga-pos-cli-${name}-`));
  dirs.push(dir);
  return dir;
}

interface RunResult {
  readonly status: number;
  readonly stderr: string;
  readonly stdout: string;
}

/**
 * Spawn the compiled CLI **asynchronously**.
 *
 * Deliberately not `execFileSync`. A synchronous spawn blocks the whole Vitest
 * worker thread for as long as the child takes, and a blocked worker cannot
 * service the reporter's `onTaskUpdate` round trip — which surfaced as a
 * `[vitest-worker]: Timeout calling "onTaskUpdate"` unhandled error that failed
 * the run while every test passed. Awaiting the child keeps the thread
 * responsive. See A51 and [[Test Stability Runbook]].
 */
function run(args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', () => resolve({ status: -1, stdout, stderr }));
    child.on('close', (code) => resolve({ status: code ?? -1, stdout, stderr }));
  });
}

describe('argument parsing', () => {
  it('requires a database', () => {
    expect(() => parseArgs(['--merchant', 'm'])).toThrow(CliArgumentError);
  });

  it('requires a merchant', () => {
    expect(() => parseArgs(['--db', 'x.sqlite'])).toThrow(CliArgumentError);
  });

  it('rejects a port that is not a port', () => {
    expect(() => parseArgs(['--db', 'x', '--merchant', 'm', '--port', '99999'])).toThrow(
      /valid TCP port/,
    );
  });

  it('rejects a locale nobody has strings for', () => {
    expect(() => parseArgs(['--db', 'x', '--merchant', 'm', '--locale', 'fr'])).toThrow(/en, am/);
  });

  it('rejects a simulated behaviour the mock does not have', () => {
    expect(() => parseArgs(['--db', 'x', '--merchant', 'm', '--behaviour', 'MAYBE'])).toThrow(
      /must be one of/,
    );
  });

  it('defaults to training mode and English', () => {
    const args = parseArgs(['--db', 'x', '--merchant', 'm']);
    expect(args.mode).toBe('TRAINING');
    expect(args.locale).toBe('en');
    expect(args.behaviour).toBe('SUCCESS');
  });
});

describe('the training catalog', () => {
  it('labels every denomination as simulated, so a screenshot is not a price list', () => {
    for (const entry of TRAINING_CATALOG) {
      expect(entry.label, entry.productId).toContain('(simulated)');
      expect(Number.isSafeInteger(entry.amountMinor)).toBe(true);
      expect(entry.amountMinor).toBeGreaterThan(0);
    }
  });
});

describe('the compiled entry point', () => {
  it('is present in the build output', () => {
    expect(existsSync(CLI), `${CLI} is missing — run npm run build`).toBe(true);
  });

  it('exits 2 on a missing argument', async () => {
    const result = await run(['--db', join(tempDir('args'), 'telga.sqlite')]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--merchant/);
  });

  it('exits 3 and starts nothing when the mode is not TRAINING', async () => {
    const dir = tempDir('live');
    const file = join(dir, 'telga.sqlite');
    const driver = createSqliteDriver({ file }, timestamp(new Date().toISOString()));
    driver.close();

    const result = await run(['--db', file, '--merchant', 'merchant_alpha', '--mode', 'LIVE']);
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/training mode only/i);
    expect(result.stdout).not.toMatch(/http:\/\//);
  });

  it('exits 6 rather than serving screens against an unmigrated database', async () => {
    const dir = tempDir('unmigrated');
    const file = join(dir, 'telga.sqlite');
    // An empty database file: opened, never migrated.
    const result = await run(['--db', file, '--merchant', 'merchant_alpha']);
    expect(result.status).toBe(6);
    expect(result.stderr).toMatch(/migration/i);
    expect(result.stderr).toMatch(/001/);
  });
});
