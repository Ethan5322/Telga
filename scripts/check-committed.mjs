/**
 * Refuse obviously unsafe or generated files, and anything that names material
 * kept out of the repository.
 *
 * Deliberately blunt: a secret committed once is committed in the history
 * forever, so a loud failure here is worth a few false positives.
 *
 * ## It checks what *would* be published, not only what is tracked
 *
 * Before the first commit there are no tracked files, so a check that looked
 * only at those reported "0 files, all clean" and proved nothing. It now also
 * reads the **proposed publication set** — everything untracked that is not
 * ignored — which is exactly what `git add -A` would stage.
 *
 * ## The folder boundary applies to every file type
 *
 * `validate-vault.mjs` enforces the boundary for Markdown. Source comments are
 * just as capable of naming a withheld document, and three of them did: a
 * doc-comment in `commission.ts`, one in `reversal.ts`, and one in a test
 * helper. Naming the file is itself a disclosure, so it is checked here across
 * everything that ships.
 *
 * Usage: node scripts/check-committed.mjs
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Paths that must never be tracked by git. */
const FORBIDDEN_PATTERNS = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)[^/]*\.pem$/i,
  /(^|\/)[^/]*\.key$/i,
  /(^|\/)[^/]*\.p12$/i,
  /(^|\/)[^/]*\.pfx$/i,
  /(^|\/)id_rsa/i,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)secrets?\.(json|ya?ml|txt)$/i,
  /(^|\/)dist\//,
  /(^|\/)node_modules\//,
  /(^|\/)stress-logs\//,
  /(^|\/)graphify-out\//,
  /(^|\/)\.obsidian\//,
  /(^|\/)[^/]*\.sqlite\d?$/i,
  /(^|\/)[^/]*\.db$/i,
];

/**
 * Vault folders kept out of the repository, and therefore never nameable by a
 * published file. Must stay in step with `.gitignore` and with
 * `LOCAL_ONLY_DIRS` in `validate-vault.mjs`.
 */
const LOCAL_ONLY_DIRS = ['01 Strategy', '06 Partnerships', '08 Pilot'];

/**
 * A reference that names a *file* inside a local-only folder.
 *
 * The folder name alone is fine — `.gitignore` states it openly, and so does
 * the vault tree. What must not appear is the name of a document being
 * withheld: the title is the disclosure.
 */
const namesWithheldFile = (text) =>
  LOCAL_ONLY_DIRS.flatMap((dir) => {
    const rx = new RegExp(`${dir}/([A-Za-z][^\`'"\n)]{2,60}\\.md)`, 'g');
    return [...text.matchAll(rx)].map((m) => `${dir}/${m[1]}`);
  });

const tracked = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });

if (tracked.status !== 0) {
  // Not a git checkout — nothing to check, and not a reason to fail a build.
  console.log('not a git repository; skipping committed-file check');
  process.exit(0);
}

const trackedFiles = tracked.stdout.split('\n').map((line) => line.trim()).filter(Boolean);

// Everything `git add -A` would stage: untracked and not ignored.
const proposed = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
  cwd: ROOT,
  encoding: 'utf8',
});
const proposedFiles =
  proposed.status === 0
    ? proposed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    : [];

const files = [...new Set([...trackedFiles, ...proposedFiles])];
const offenders = files.filter((file) => FORBIDDEN_PATTERNS.some((pattern) => pattern.test(file)));

if (offenders.length > 0) {
  console.error('These files must never be published:');
  for (const file of offenders) console.error(`  ${file}`);
  process.exit(1);
}

// --- the folder boundary, across every file type ---------------------------
const crossings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(join(ROOT, file), 'utf8');
  } catch {
    continue; // binary or unreadable: the name check above already covered it
  }
  for (const named of namesWithheldFile(text)) {
    crossings.push(`${file} names "${named}"`);
  }
}

if (crossings.length > 0) {
  console.error('These files name a document that is kept out of the repository:');
  for (const crossing of crossings) console.error(`  ${crossing}`);
  console.error('\nThe title of a withheld document is itself a disclosure. Replace it with a');
  console.error('neutral summary; see `09 Engineering/Local Certificate Handling.md` for the form.');
  process.exit(1);
}

console.log(
  `checked ${String(files.length)} files ` +
    `(${String(trackedFiles.length)} tracked, ${String(proposedFiles.length)} proposed): ` +
    'no secrets, generated output, or references to withheld material',
);
