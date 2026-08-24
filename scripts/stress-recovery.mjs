/**
 * Recovery stress runner — the A44 reproduction command.
 *
 * Two complementary passes, because the two failures seen so far had different
 * shapes:
 *
 *   1. **Soak.** The escalation scenario many times over, each on a fresh
 *      database, in one process. Catches a defect in the logic itself.
 *   2. **Shuffled repeats.** The whole recovery suite, several times, with
 *      randomised test order. Catches order dependence and leaked state — the
 *      class of problem a single isolated run can never find.
 *
 * Exits non-zero on any failure, and leaves the failing output on disk.
 *
 * Usage:
 *   node scripts/stress-recovery.mjs
 *   node scripts/stress-recovery.mjs --iterations 500 --repeats 10
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOG_DIR = join(ROOT, 'stress-logs');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1] !== undefined) return process.argv[index + 1];
  return fallback;
}

const iterations = arg('iterations', '120');
const repeats = Number(arg('repeats', '5'));

const failures = [];

function record(label, result) {
  const ok = result.status === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    mkdirSync(LOG_DIR, { recursive: true });
    const file = join(LOG_DIR, `${label.replace(/[^a-z0-9]+/gi, '-')}.log`);
    writeFileSync(file, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    console.error(`  output written to ${file}`);
    failures.push(label);
  }
}

console.log(`Recovery stress: ${iterations} soak iterations, ${String(repeats)} shuffled repeats\n`);

// Pass 1 — the soak.
record(
  `soak-${iterations}`,
  spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', 'vitest.stress.config.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, TELGA_STRESS_ITERATIONS: iterations, CI: '1' },
  }),
);

// Pass 2 — shuffled repeats of the real recovery and worker suites.
for (let i = 1; i <= repeats; i += 1) {
  const seed = String(Date.now() + i);
  record(
    `shuffled-repeat-${String(i)}-seed-${seed}`,
    spawnSync(
      process.execPath,
      [
        join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        'tests/recovery/',
        'tests/worker/',
        '--sequence.shuffle',
        '--sequence.seed',
        seed,
        '--testTimeout=180000',
      ],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CI: '1' } },
    ),
  );
}

console.log('');
if (failures.length > 0) {
  console.error(`stress FAILED: ${String(failures.length)} of ${String(repeats + 1)} passes failed`);
  for (const label of failures) console.error(`  - ${label}`);
  process.exit(1);
}
console.log(`stress passed: soak of ${iterations} iterations plus ${String(repeats)} shuffled repeats`);
