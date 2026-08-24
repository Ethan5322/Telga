/**
 * Cross-platform workspace build.
 *
 * Compiles each package to its own `dist/`, in dependency order, and stamps
 * `dist/package.json` with `{"type":"commonjs"}` so Node reads the emitted
 * JavaScript as CommonJS even though the package itself is `"type": "module"`
 * for the TypeScript tooling.
 *
 * No shell built-ins are used — `rm -rf` does not exist on Windows.
 *
 * Usage:
 *   node scripts/build.mjs          build everything
 *   node scripts/build.mjs --clean  remove every dist/ first
 *   node scripts/build.mjs --only   clean only, do not build
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Dependency order. Each package's declarations must exist before its dependents compile. */
export const BUILD_ORDER = [
  'packages/domain',
  'packages/localization',
  'packages/pos-view-model',
  'packages/persistence',
  'services/provider-adapters/mock-airtime',
  'services/api',
  'services/worker',
  'apps/merchant-pos',
];

const args = process.argv.slice(2);
const shouldClean = args.includes('--clean') || args.includes('--only');
const cleanOnly = args.includes('--only');

function clean() {
  for (const pkg of BUILD_ORDER) {
    const dist = join(ROOT, pkg, 'dist');
    if (existsSync(dist)) {
      rmSync(dist, { recursive: true, force: true });
      console.log(`cleaned ${pkg}/dist`);
    }
  }
}

function tscBinary() {
  const bin = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(bin)) {
    console.error('typescript is not installed. Run `npm install` first.');
    process.exit(1);
  }
  return bin;
}

function build() {
  const tsc = tscBinary();

  for (const pkg of BUILD_ORDER) {
    const project = join(ROOT, pkg, 'tsconfig.build.json');
    process.stdout.write(`building ${pkg} ... `);

    const result = spawnSync(process.execPath, [tsc, '-p', project], {
      cwd: ROOT,
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      console.log('FAILED');
      if (result.stdout) console.error(result.stdout);
      if (result.stderr) console.error(result.stderr);
      process.exit(result.status ?? 1);
    }

    // Node reads this to decide how to parse the emitted .js. Without it the
    // package's own "type": "module" would make Node treat CommonJS as ESM.
    const dist = join(ROOT, pkg, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);

    console.log('ok');
  }
}

/** Count emitted files, and refuse to finish if TypeScript leaked into the output. */
function verify() {
  let js = 0;
  let dts = 0;
  const stray = [];

  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (name.endsWith('.d.ts')) dts += 1;
      else if (name.endsWith('.ts')) stray.push(full);
      else if (name.endsWith('.js')) js += 1;
    }
  };

  for (const pkg of BUILD_ORDER) {
    const dist = join(ROOT, pkg, 'dist');
    if (existsSync(dist)) walk(dist);
  }

  if (stray.length > 0) {
    console.error('Build output contains TypeScript source, which must never be needed at runtime:');
    for (const file of stray) console.error(`  ${file}`);
    process.exit(1);
  }

  console.log(`build complete: ${String(js)} .js, ${String(dts)} .d.ts, 0 .ts`);
}

if (shouldClean) clean();
if (!cleanOnly) {
  build();
  verify();
}

export { clean, dirname };
