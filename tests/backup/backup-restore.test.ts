/**
 * Backup and restore — run against real SQLite files, real synthetic
 * training data, and real filesystem operations. Nothing here is mocked.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AppendOnlyProtectionMissingError,
  BackupNotFoundError,
  BackupTooLargeError,
  ChecksumMismatchError,
  DestinationExistsError,
  LiveModeRefusedError,
  ManifestMissingError,
  PathNotAllowedError,
  RowCountMismatchError,
  SchemaMismatchError,
  SourceNotFoundError,
  TargetExistsError,
  runBackup,
  runRestore,
  sha256OfFile,
} from '@telga/backup';
import type { BackupRestoreConfig } from '@telga/backup';
import { createSale } from '@telga/api';
import { transactionId } from '@telga/domain';
import { SqliteLedgerDriver } from '@telga/persistence';
import { failAt, makeHarness, MERCHANT_A, saleRequest, withDriver } from '../orchestration/helpers';
import type { Harness } from '../orchestration/helpers';
import { makeUiHarness, signInAs } from '../ui/helpers';
import type { UiHarness } from '../ui/helpers';

let harness: Harness | UiHarness | undefined;
let scratchDir: string | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
  if (scratchDir) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = undefined;
  }
});

function configFor(...roots: readonly string[]): BackupRestoreConfig {
  return { allowedRoots: roots, checkpointTimeoutMs: 30_000 };
}

function scratch(name: string): string {
  scratchDir = mkdtempSync(join(tmpdir(), `telga-backup-test-${name}-`));
  return scratchDir;
}

describe('backup', () => {
  it('succeeds from a valid training database', async () => {
    harness = makeHarness('backup-basic');
    const dir = scratch('basic');
    const output = join(dir, 'backup.sqlite');

    const result = await runBackup({
      mode: 'TRAINING',
      sourcePath: harness.file,
      destinationPath: output,
      config: configFor(dir, dirname(harness.file)),
    });

    expect(existsSync(output)).toBe(true);
    expect(existsSync(result.manifestPath)).toBe(true);
    expect(result.manifest.ledgerResidualMinor).toBe(0);
    expect(result.manifest.rowCounts.merchants).toBeGreaterThan(0);
  });

  it('refuses LIVE mode before opening the database', async () => {
    harness = makeHarness('backup-live');
    const dir = scratch('live');

    await expect(
      runBackup({
        mode: 'LIVE',
        sourcePath: harness.file,
        destinationPath: join(dir, 'backup.sqlite'),
        config: configFor(dir),
      }),
    ).rejects.toThrow(LiveModeRefusedError);
    // Nothing was created — the refusal happened before any file touched disk.
    expect(existsSync(join(dir, 'backup.sqlite'))).toBe(false);
  });

  it('refuses a source that does not exist', async () => {
    const dir = scratch('no-source');
    await expect(
      runBackup({
        mode: 'TRAINING',
        sourcePath: join(dir, 'nope.sqlite'),
        destinationPath: join(dir, 'backup.sqlite'),
        config: configFor(dir),
      }),
    ).rejects.toThrow(SourceNotFoundError);
  });

  it('refuses a destination outside the allowed roots', async () => {
    harness = makeHarness('backup-unsafe-dest');
    const dir = scratch('unsafe');
    const outside = mkdtempSync(join(tmpdir(), 'telga-outside-'));
    try {
      await expect(
        runBackup({
          mode: 'TRAINING',
          sourcePath: harness.file,
          destinationPath: join(outside, 'backup.sqlite'),
          // The source's own directory is allowed; `outside` deliberately is
          // not, so this actually exercises the destination check.
          config: configFor(dir, dirname(harness.file)),
        }),
      ).rejects.toThrow(PathNotAllowedError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not overwrite an existing backup without force', async () => {
    harness = makeHarness('backup-no-overwrite');
    const dir = scratch('no-overwrite');
    const output = join(dir, 'backup.sqlite');

    await runBackup({
      mode: 'TRAINING',
      sourcePath: harness.file,
      destinationPath: output,
      config: configFor(dir, dirname(harness.file)),
    });

    await expect(
      runBackup({
        mode: 'TRAINING',
        sourcePath: harness.file,
        destinationPath: output,
        config: configFor(dir, dirname(harness.file)),
      }),
    ).rejects.toThrow(DestinationExistsError);
  });

  it('overwrites deliberately when force is passed', async () => {
    harness = makeHarness('backup-force');
    const dir = scratch('force');
    const output = join(dir, 'backup.sqlite');
    const cfg = configFor(dir, dirname(harness.file));

    await runBackup({ mode: 'TRAINING', sourcePath: harness.file, destinationPath: output, config: cfg });
    await expect(
      runBackup({
        mode: 'TRAINING',
        sourcePath: harness.file,
        destinationPath: output,
        force: true,
        config: cfg,
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a database larger than the configured maximum', async () => {
    harness = makeHarness('backup-too-large');
    const dir = scratch('too-large');

    await expect(
      runBackup({
        mode: 'TRAINING',
        sourcePath: harness.file,
        destinationPath: join(dir, 'backup.sqlite'),
        config: { ...configFor(dir, dirname(harness.file)), maxBackupSizeBytes: 1 },
      }),
    ).rejects.toThrow(BackupTooLargeError);
  });

  it('checkpoints before copying, so the backup is not torn', async () => {
    harness = makeHarness('backup-checkpoint');
    const dir = scratch('checkpoint');
    const output = join(dir, 'backup.sqlite');

    await runBackup({
      mode: 'TRAINING',
      sourcePath: harness.file,
      destinationPath: output,
      config: configFor(dir, dirname(harness.file)),
    });

    // A copy of a checkpointed database opens cleanly and reports a sound
    // integrity check — a torn copy would fail this.
    const copy = new SqliteLedgerDriver({ file: output });
    try {
      const health = copy.health();
      expect(health.integrityCheck).toBe('ok');
    } finally {
      copy.close();
    }
  });

  it('records a checksum that verifies against the file it wrote', async () => {
    harness = makeHarness('backup-checksum');
    const dir = scratch('checksum');
    const output = join(dir, 'backup.sqlite');

    const result = await runBackup({
      mode: 'TRAINING',
      sourcePath: harness.file,
      destinationPath: output,
      config: configFor(dir, dirname(harness.file)),
    });

    expect(await sha256OfFile(output)).toBe(result.manifest.checksumSha256);
  });

  it('does not expose secrets in the manifest', async () => {
    harness = makeHarness('backup-no-secrets');
    const dir = scratch('no-secrets');

    const result = await runBackup({
      mode: 'TRAINING',
      sourcePath: harness.file,
      destinationPath: join(dir, 'backup.sqlite'),
      config: configFor(dir, dirname(harness.file)),
    });

    const raw = JSON.stringify(result.manifest);
    expect(raw).not.toContain(harness.file); // no absolute host path
    expect(raw.toLowerCase()).not.toContain('pin');
    expect(raw.toLowerCase()).not.toContain('secret');
    expect(raw.toLowerCase()).not.toContain('token');
  });

  it('does not delete the source database', async () => {
    harness = makeHarness('backup-preserves-source');
    const dir = scratch('preserves-source');

    await runBackup({
      mode: 'TRAINING',
      sourcePath: harness.file,
      destinationPath: join(dir, 'backup.sqlite'),
      config: configFor(dir, dirname(harness.file)),
    });

    expect(existsSync(harness.file)).toBe(true);
    expect(harness.driver.ledgerResidualMinor()).toBe(0);
  });
});

describe('restore', () => {
  async function backupOf(h: Harness, dir: string): Promise<string> {
    const output = join(dir, 'backup.sqlite');
    await runBackup({
      mode: 'TRAINING',
      sourcePath: h.file,
      destinationPath: output,
      config: configFor(dir, dirname(h.file)),
    });
    return output;
  }

  it('succeeds into a new isolated database', async () => {
    harness = makeHarness('restore-basic');
    const dir = scratch('restore-basic');
    const backup = await backupOf(harness, dir);
    const target = join(dir, 'restored.sqlite');

    const report = await runRestore({
      mode: 'TRAINING',
      backupPath: backup,
      targetPath: target,
      config: configFor(dir),
    });

    expect(existsSync(target)).toBe(true);
    expect(report.ledgerResidualMinor).toBe(0);
    expect(report.integrityCheck).toBe('ok');
    expect(report.appendOnlyVerified).toBe(true);
  });

  it('refuses LIVE mode before opening anything', async () => {
    harness = makeHarness('restore-live');
    const dir = scratch('restore-live');
    const backup = await backupOf(harness, dir);

    await expect(
      runRestore({
        mode: 'LIVE',
        backupPath: backup,
        targetPath: join(dir, 'restored.sqlite'),
        config: configFor(dir),
      }),
    ).rejects.toThrow(LiveModeRefusedError);
    expect(existsSync(join(dir, 'restored.sqlite'))).toBe(false);
  });

  it('refuses a backup with no manifest', async () => {
    harness = makeHarness('restore-no-manifest');
    const dir = scratch('no-manifest');
    const orphan = join(dir, 'orphan.sqlite');
    writeFileSync(orphan, 'not a real database, but a manifest should be checked first');

    await expect(
      runRestore({ mode: 'TRAINING', backupPath: orphan, targetPath: join(dir, 'r.sqlite'), config: configFor(dir) }),
    ).rejects.toThrow(ManifestMissingError);
  });

  it('refuses a checksum mismatch, and creates no target at all', async () => {
    harness = makeHarness('restore-checksum');
    const dir = scratch('checksum-mismatch');
    const backup = await backupOf(harness, dir);
    const target = join(dir, 'restored.sqlite');

    // Corrupt the backup after the manifest was written for it.
    const original = readFileSync(backup);
    const corrupted = Buffer.from(original);
    corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 0xff;
    writeFileSync(backup, corrupted);

    await expect(
      runRestore({ mode: 'TRAINING', backupPath: backup, targetPath: target, config: configFor(dir) }),
    ).rejects.toThrow(ChecksumMismatchError);
    // Checksum is verified before any copy — nothing partial is left behind.
    expect(existsSync(target)).toBe(false);
  });

  it('refuses a corrupt backup generally (not only a byte-flip)', async () => {
    harness = makeHarness('restore-corrupt');
    const dir = scratch('corrupt');
    const backup = await backupOf(harness, dir);
    writeFileSync(backup, Buffer.from('completely different content, wrong length entirely'));

    await expect(
      runRestore({
        mode: 'TRAINING',
        backupPath: backup,
        targetPath: join(dir, 'restored.sqlite'),
        config: configFor(dir),
      }),
    ).rejects.toThrow(ChecksumMismatchError);
  });

  it('refuses a schema behind what the running code expects', async () => {
    const dir = scratch('schema-mismatch');

    // A database opened directly (never `createSqliteDriver`, which would
    // auto-migrate) has only the migration bookkeeping table — every real
    // migration is genuinely missing. Exactly the state SchemaMismatchError
    // exists to catch.
    const bareDb = join(dir, 'bare.sqlite');
    const bare = new SqliteLedgerDriver({ file: bareDb });
    bare.appliedMigrations(); // ensures the bookkeeping table exists, applies nothing
    bare.close();

    const bareBackup = join(dir, 'bare-backup.sqlite');
    await runBackup({ mode: 'TRAINING', sourcePath: bareDb, destinationPath: bareBackup, config: configFor(dir) });

    await expect(
      runRestore({
        mode: 'TRAINING',
        backupPath: bareBackup,
        targetPath: join(dir, 'restored.sqlite'),
        config: configFor(dir),
      }),
    ).rejects.toThrow(SchemaMismatchError);
  });

  it('preserves ledger rows and residual across the round trip', async () => {
    harness = makeHarness('restore-ledger', { fundBirr: 250 });
    const dir = scratch('restore-ledger');
    const backup = await backupOf(harness, dir);
    const target = join(dir, 'restored.sqlite');

    const report = await runRestore({ mode: 'TRAINING', backupPath: backup, targetPath: target, config: configFor(dir) });

    expect(report.rowCounts.ledgerEntries).toBe(harness.driver.readEntries().length);
    expect(report.ledgerResidualMinor).toBe(0);
  });

  it('preserves append-only protections on the restored copy', async () => {
    harness = makeHarness('restore-append-only', { fundBirr: 100 });
    const dir = scratch('append-only');
    const backup = await backupOf(harness, dir);
    const target = join(dir, 'restored.sqlite');

    await runRestore({ mode: 'TRAINING', backupPath: backup, targetPath: target, config: configFor(dir) });

    const restored = new SqliteLedgerDriver({ file: target });
    try {
      expect(() => restored.unsafeConnection.exec('UPDATE ledger_entries SET amount_minor = 1')).toThrow();
    } finally {
      restored.close();
    }
  });

  it('revokes every session on restore', async () => {
    const uiHarness = makeUiHarness('restore-sessions');
    harness = uiHarness;
    await signInAs(uiHarness.api);
    const dir = scratch('restore-sessions');
    const backup = await backupOf(uiHarness, dir);
    const target = join(dir, 'restored.sqlite');

    const activeBefore = uiHarness.driver.countActiveSessions();
    expect(activeBefore).toBeGreaterThan(0);

    const report = await runRestore({ mode: 'TRAINING', backupPath: backup, targetPath: target, config: configFor(dir) });
    expect(report.sessionsRevoked).toBe(activeBefore);

    const restored = new SqliteLedgerDriver({ file: target });
    try {
      expect(restored.countActiveSessions()).toBe(0);
    } finally {
      restored.close();
    }
  });

  it('releases every active recovery claim on restore', async () => {
    harness = makeHarness('restore-claims', { fundBirr: 100, behaviour: 'SUCCESS' });
    const dir = scratch('restore-claims');

    const before = new Set(harness.driver.findTransactionsByMerchant(MERCHANT_A).map((r) => r.id));
    const failingDeps = withDriver(harness.deps, failAt(harness.driver, 'saveTransaction', 5));
    await expect(createSale(failingDeps, saleRequest())).rejects.toThrow();
    const stuck = harness.driver.findTransactionsByMerchant(MERCHANT_A).find((r) => !before.has(r.id));
    if (!stuck) throw new Error('expected a stuck transaction to claim');

    harness.driver.claimTransaction({
      transactionId: transactionId(stuck.id),
      workerId: 'worker_1',
      scanId: 'scan_1',
      now: harness.clock.now(),
      expiresAt: harness.clock.now(),
    });
    expect(harness.driver.countActiveClaims()).toBe(1);

    const backup = await backupOf(harness, dir);
    const target = join(dir, 'restored.sqlite');
    const report = await runRestore({ mode: 'TRAINING', backupPath: backup, targetPath: target, config: configFor(dir) });

    expect(report.claimsReleased).toBe(1);
    const restored = new SqliteLedgerDriver({ file: target });
    try {
      expect(restored.countActiveClaims()).toBe(0);
    } finally {
      restored.close();
    }
  });

  it('does not overwrite an existing target by default', async () => {
    harness = makeHarness('restore-no-overwrite');
    const dir = scratch('restore-no-overwrite');
    const backup = await backupOf(harness, dir);
    const target = join(dir, 'restored.sqlite');
    writeFileSync(target, 'already something here');

    await expect(
      runRestore({ mode: 'TRAINING', backupPath: backup, targetPath: target, config: configFor(dir) }),
    ).rejects.toThrow(TargetExistsError);
  });

  it('leaves no partial target when a post-copy verification fails', async () => {
    const dir = scratch('restore-partial');

    // A real, openable SQLite file that fails verification cleanly (missing
    // migrations) rather than a non-database file, which some native SQLite
    // bindings can leave holding an OS-level file handle on Windows after a
    // failed open — a platform quirk unrelated to what this test checks.
    const bareDb = join(dir, 'bare.sqlite');
    const bare = new SqliteLedgerDriver({ file: bareDb });
    bare.appliedMigrations();
    bare.close();
    const bareBackup = join(dir, 'bare-backup.sqlite');
    await runBackup({ mode: 'TRAINING', sourcePath: bareDb, destinationPath: bareBackup, config: configFor(dir) });

    const target = join(dir, 'restored.sqlite');
    await expect(
      runRestore({ mode: 'TRAINING', backupPath: bareBackup, targetPath: target, config: configFor(dir) }),
    ).rejects.toThrow(SchemaMismatchError);

    expect(existsSync(target)).toBe(false);
  });

  it('does not alter the original backup file', async () => {
    harness = makeHarness('restore-preserves-backup');
    const dir = scratch('preserves-backup');
    const backup = await backupOf(harness, dir);
    const before = await sha256OfFile(backup);

    await runRestore({
      mode: 'TRAINING',
      backupPath: backup,
      targetPath: join(dir, 'restored.sqlite'),
      config: configFor(dir),
    });

    expect(await sha256OfFile(backup)).toBe(before);
  });

  it('is safe and deterministic across two independent restores of the same backup', async () => {
    harness = makeHarness('restore-repeated', { fundBirr: 100 });
    const dir = scratch('repeated');
    const backup = await backupOf(harness, dir);

    const first = await runRestore({
      mode: 'TRAINING',
      backupPath: backup,
      targetPath: join(dir, 'restored-1.sqlite'),
      config: configFor(dir),
    });
    const second = await runRestore({
      mode: 'TRAINING',
      backupPath: backup,
      targetPath: join(dir, 'restored-2.sqlite'),
      config: configFor(dir),
    });

    expect(first.rowCounts).toEqual(second.rowCounts);
    expect(first.ledgerResidualMinor).toBe(second.ledgerResidualMinor);
    expect(first.checksumSha256).toBe(second.checksumSha256);
  });

  it('does not start a worker or call a provider — no such import exists in this package', async () => {
    // A structural guarantee, not a runtime one: `@telga/backup` depends only
    // on `@telga/domain` and `@telga/persistence` (see package.json) — it
    // cannot import a provider adapter or the worker package even by
    // mistake, because neither is a declared dependency.
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'services/backup/package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@telga/domain', '@telga/persistence']);
  });

  it('does not release uncertain funds or create duplicate settlement for a transaction near recovery', async () => {
    harness = makeHarness('restore-near-recovery', { fundBirr: 100, behaviour: 'SUCCESS' });
    const dir = scratch('near-recovery');

    // A transaction left exactly where recovery would find it: written, then
    // the sale call fails before completion, leaving it PROCESSING.
    const before = new Set(harness.driver.findTransactionsByMerchant(MERCHANT_A).map((r) => r.id));
    const failingDeps = withDriver(harness.deps, failAt(harness.driver, 'saveTransaction', 5));
    await expect(createSale(failingDeps, saleRequest())).rejects.toThrow();
    const stuck = harness.driver.findTransactionsByMerchant(MERCHANT_A).find((r) => !before.has(r.id));
    expect(stuck?.state).toBe('PROCESSING');

    const backup = await backupOf(harness, dir);
    const target = join(dir, 'restored.sqlite');
    await runRestore({ mode: 'TRAINING', backupPath: backup, targetPath: target, config: configFor(dir) });

    // The restored copy still has exactly one row for this transaction, in
    // the same state — restore neither resolved it nor duplicated it. A real
    // sweep against the restored copy is what would resolve it, exactly once,
    // through the normal recovery path — restore itself changes nothing here.
    const restored = new SqliteLedgerDriver({ file: target });
    try {
      const rows = restored.findTransactionsByMerchant(MERCHANT_A).filter((r) => r.id === stuck?.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe('PROCESSING');
      expect(restored.ledgerResidualMinor()).toBe(0);
    } finally {
      restored.close();
    }
  });
});
