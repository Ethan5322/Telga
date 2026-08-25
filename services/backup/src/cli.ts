/**
 * `backup` / `restore` command-line entry point.
 *
 *   node services/backup/dist/cli.js backup  --db <path> --output <path> [--force]
 *   node services/backup/dist/cli.js restore --backup <path> --target <path> [--allow-existing-target]
 *
 * Thin by design: parse arguments, call the typed function that does the
 * real work, print a JSON report, exit with a meaningful code. Neither
 * subcommand starts a worker, calls a provider, or mutates a live database —
 * see `backup.ts` and `restore.ts`.
 *
 * TRAINING MODE — NO REAL VALUE. `--mode` accepts only `TRAINING`; anything
 * else exits non-zero before a database is opened.
 */

import type { BackupRestoreConfig } from './paths';
import { DEFAULT_CHECKPOINT_TIMEOUT_MS } from './paths';
import { runBackup } from './backup';
import { runRestore } from './restore';

export const EXIT = Object.freeze({
  ok: 0,
  badArguments: 2,
  notTrainingMode: 3,
  refused: 4,
  runtimeFailure: 5,
});

function parseFlags(argv: readonly string[]): { flags: Map<string, string>; bare: Set<string> } {
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
  return { flags, bare };
}

/**
 * Every path an operator supplies must resolve inside one of these roots.
 * `TELGA_BACKUP_ALLOWED_ROOTS` is a `path.delimiter`-separated list (`:` on
 * POSIX, `;` on Windows). There is no default — an unset environment
 * variable allows nothing, refusing every path, rather than guessing a root.
 */
function configFrom(env: NodeJS.ProcessEnv): BackupRestoreConfig {
  const rootsRaw = env.TELGA_BACKUP_ALLOWED_ROOTS ?? '';
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const allowedRoots = rootsRaw
    .split(delimiter)
    .map((r) => r.trim())
    .filter((r) => r.length > 0);

  const maxSize = env.TELGA_BACKUP_MAX_SIZE_BYTES;
  const checkpointTimeout = env.TELGA_BACKUP_CHECKPOINT_TIMEOUT_MS;
  const retention = env.TELGA_BACKUP_RETENTION_COUNT;

  return {
    allowedRoots,
    maxBackupSizeBytes: maxSize !== undefined && maxSize !== '' ? Number(maxSize) : undefined,
    checkpointTimeoutMs:
      checkpointTimeout !== undefined && checkpointTimeout !== ''
        ? Number(checkpointTimeout)
        : DEFAULT_CHECKPOINT_TIMEOUT_MS,
    retentionCount: retention !== undefined && retention !== '' ? Number(retention) : undefined,
  };
}

async function runBackupCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  write: (line: string) => void,
  writeError: (line: string) => void,
): Promise<number> {
  const { flags, bare } = parseFlags(argv);
  const mode = flags.get('mode') ?? env.TELGA_MODE ?? 'TRAINING';
  const sourcePath = flags.get('db') ?? env.TELGA_DB ?? '';
  const destinationPath = flags.get('output') ?? env.TELGA_BACKUP_OUTPUT ?? '';
  const force = bare.has('force') || flags.get('force') === 'true';

  if (sourcePath === '' || destinationPath === '') {
    writeError('Usage: backup --db <path> --output <path> [--force]');
    return EXIT.badArguments;
  }

  try {
    const result = await runBackup({
      mode,
      sourcePath,
      destinationPath,
      force,
      config: configFrom(env),
    });
    write(JSON.stringify(result.manifest, null, 2));
    return EXIT.ok;
  } catch (error) {
    return reportFailure(error, writeError);
  }
}

async function runRestoreCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  write: (line: string) => void,
  writeError: (line: string) => void,
): Promise<number> {
  const { flags, bare } = parseFlags(argv);
  const mode = flags.get('mode') ?? env.TELGA_MODE ?? 'TRAINING';
  const backupPath = flags.get('backup') ?? env.TELGA_RESTORE_BACKUP ?? '';
  const targetPath = flags.get('target') ?? env.TELGA_RESTORE_TARGET ?? '';
  const allowExistingTarget = bare.has('allow-existing-target') || flags.get('allow-existing-target') === 'true';

  if (backupPath === '' || targetPath === '') {
    writeError('Usage: restore --backup <path> --target <path> [--allow-existing-target]');
    return EXIT.badArguments;
  }

  try {
    const report = await runRestore({
      mode,
      backupPath,
      targetPath,
      allowExistingTarget,
      config: configFrom(env),
    });
    write(JSON.stringify(report, null, 2));
    return EXIT.ok;
  } catch (error) {
    return reportFailure(error, writeError);
  }
}

const REFUSAL_ERROR_NAMES = new Set([
  'PathNotAllowedError',
  'SourceNotFoundError',
  'DestinationExistsError',
  'BackupTooLargeError',
  'BackupNotFoundError',
  'TargetExistsError',
  'ManifestMissingError',
  'ChecksumMismatchError',
  'SchemaMismatchError',
  'DatabaseIntegrityError',
  'NonZeroResidualError',
  'AppendOnlyProtectionMissingError',
  'RowCountMismatchError',
]);

function reportFailure(error: unknown, writeError: (line: string) => void): number {
  if (error instanceof Error) {
    writeError(error.message);
    if (error.name === 'LiveModeRefusedError') return EXIT.notTrainingMode;
    if (REFUSAL_ERROR_NAMES.has(error.name)) return EXIT.refused;
  } else {
    writeError('Unexpected failure');
  }
  return EXIT.runtimeFailure;
}

/** Run the CLI. Returns an exit code rather than calling `process.exit`. */
export async function run(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = {},
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  writeError: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<number> {
  const [command, ...rest] = argv;

  if (command === 'backup') return runBackupCommand(rest, env, write, writeError);
  if (command === 'restore') return runRestoreCommand(rest, env, write, writeError);

  writeError('Usage: cli.js <backup|restore> [flags]');
  return EXIT.badArguments;
}

/** Entry point when executed directly. */
async function main(): Promise<void> {
  const code = await run(process.argv.slice(2), process.env);
  process.exitCode = code;
}

// `require.main === module` is the CommonJS form; the build emits CommonJS —
// see `Build Pipeline.md`. Matches the same guard used by the worker and POS
// CLIs, so `import` in a test never triggers this branch.
declare const require: { main?: unknown } | undefined;
declare const module: unknown;

if (typeof require !== 'undefined' && require.main === module) {
  void main();
}
