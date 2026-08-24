/**
 * Verify every `tests/...` path the CI workflow runs vitest against is
 * actually tracked by git and non-empty.
 *
 * A55 hardened against build/test concurrency; this hardens against the
 * companion failure mode: a `.gitignore` pattern silently excluding a real
 * test directory from every commit. Vitest still finds it locally (the
 * filesystem has it), so every local run passes — the gap only shows up on
 * a fresh CI checkout, as "No test files found, exiting with code 1"
 * (A57). This check reads what git actually tracks, so it fails the same
 * way a fresh checkout would, without needing one.
 *
 * Usage: node scripts/check-ci-test-paths.mjs
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOW = join(ROOT, '.github', 'workflows', 'ci.yml');

const workflow = readFileSync(WORKFLOW, 'utf8');

// Matches `npx vitest run tests/foo/` or `.../tests/foo/bar.test.ts`, the
// two shapes used in this workflow. A bare `npm test` / `npm run <script>`
// step is intentionally not matched — those are covered by their own config
// and not by a literal path argument.
const pathPattern = /vitest run (tests\/[^\s'"]+)/g;
const paths = [...workflow.matchAll(pathPattern)].map((m) => m[1]);

if (paths.length === 0) {
  console.error('No `vitest run tests/...` steps found in ci.yml — pattern may be stale.');
  process.exit(1);
}

const problems = [];

for (const path of new Set(paths)) {
  const tracked = spawnSync('git', ['ls-files', path], { cwd: ROOT, encoding: 'utf8' });
  const files = tracked.stdout.split('\n').map((line) => line.trim()).filter(Boolean);

  if (files.length === 0) {
    problems.push(`${path} — 0 tracked files`);
  }
}

if (problems.length > 0) {
  console.error('These CI test paths would find nothing on a fresh checkout:');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    '\nA path here must be tracked by git — check `.gitignore` for a pattern that is ' +
      'broader than intended, and check that the directory was committed.',
  );
  process.exit(1);
}

console.log(`checked ${String(new Set(paths).size)} CI test paths: all tracked and non-empty`);
