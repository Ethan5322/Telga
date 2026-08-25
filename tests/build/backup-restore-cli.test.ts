/**
 * The compiled `backup`/`restore` CLI entry point.
 *
 * A real child process, run against `dist/` — proves the compiled output
 * actually runs and actually refuses, the same reasoning that closed A37 for
 * the worker and backs the POS's own `tests/ui/cli.test.ts`.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteDriver } from '@telga/persistence';

const CLI = join(process.cwd(), 'services', 'backup', 'dist', 'cli.js');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `telga-backup-cli-${name}-`));
  dirs.push(dir);
  return dir;
}

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Async spawn — see `tests/ui/cli.test.ts` for why not `execFileSync` (A51). */
function run(args: readonly string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      resolvePromise({ status: code ?? -1, stdout, stderr });
    });
  });
}

describe('the compiled backup/restore entry point', () => {
  it('exits 2 with no subcommand', async () => {
    const result = await run([], {});
    expect(result.status).toBe(2);
  });

  it('exits 2 with a missing --db', async () => {
    const dir = tempDir('missing-db');
    const result = await run(['backup', '--output', join(dir, 'out.sqlite')], {
      TELGA_BACKUP_ALLOWED_ROOTS: dir,
    });
    expect(result.status).toBe(2);
  });

  it('exits 3 and touches nothing when mode is not TRAINING', async () => {
    const dir = tempDir('live-refused');
    const db = join(dir, 'telga.sqlite');
    const driver = createSqliteDriver({ file: db });
    driver.close();

    const output = join(dir, 'backup.sqlite');
    const result = await run(['backup', '--db', db, '--output', output, '--mode', 'LIVE'], {
      TELGA_BACKUP_ALLOWED_ROOTS: dir,
    });

    expect(result.status).toBe(3);
    expect(existsSync(output)).toBe(false);
  });

  it('backs up and restores a real database end to end', async () => {
    const dir = tempDir('roundtrip');
    const db = join(dir, 'telga.sqlite');
    const driver = createSqliteDriver({ file: db });
    driver.close();

    const output = join(dir, 'backup.sqlite');
    const backupResult = await run(['backup', '--db', db, '--output', output], {
      TELGA_BACKUP_ALLOWED_ROOTS: dir,
    });
    expect(backupResult.status).toBe(0);
    expect(existsSync(output)).toBe(true);
    const manifest = JSON.parse(backupResult.stdout) as { checksumSha256: string };
    expect(typeof manifest.checksumSha256).toBe('string');

    const target = join(dir, 'restored.sqlite');
    const restoreResult = await run(['restore', '--backup', output, '--target', target], {
      TELGA_BACKUP_ALLOWED_ROOTS: dir,
    });
    expect(restoreResult.status).toBe(0);
    expect(existsSync(target)).toBe(true);
    const report = JSON.parse(restoreResult.stdout) as { ledgerResidualMinor: number };
    expect(report.ledgerResidualMinor).toBe(0);
  });

  it('refuses a path outside the configured allowed roots', async () => {
    const dir = tempDir('path-refused');
    const outside = tempDir('path-refused-outside');
    const db = join(dir, 'telga.sqlite');
    const driver = createSqliteDriver({ file: db });
    driver.close();

    const result = await run(['backup', '--db', db, '--output', join(outside, 'backup.sqlite')], {
      TELGA_BACKUP_ALLOWED_ROOTS: dir, // deliberately excludes `outside`
    });

    expect(result.status).toBe(4);
    expect(existsSync(join(outside, 'backup.sqlite'))).toBe(false);
  });
});
