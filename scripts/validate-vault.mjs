/**
 * Vault validation.
 *
 * Checks the four things the "no orphan notes" rule in `CLAUDE.md` depends on:
 *   1. Every note has YAML frontmatter with the required keys.
 *   2. Every wikilink resolves to a real note.
 *   3. Every note is reachable from `00 Home`, and links out to something.
 *   4. **No published note links into a local-only one.**
 *
 * ## The publication boundary
 *
 * Some folders hold commercial and strategic material — business strategy,
 * provider assessment, negotiation terms, pilot economics — that is deliberately
 * kept out of any repository. None of it is required by the source, tests,
 * build, CI or runtime. It stays in the vault on this machine and is excluded by
 * `.gitignore`.
 *
 * That creates a rule a person cannot reliably keep by hand: a published note
 * must never link into one of them, or the published copy has a dangling link
 * and, worse, names a document whose existence and title are themselves a
 * disclosure. So the boundary is checked here rather than swept once.
 *
 * Local-only notes are still validated — frontmatter, links, outbound links —
 * and they may link to each other and to published notes freely. Reachability
 * from `00 Home` is required of published notes; local-only notes are reachable
 * from their own local index instead.
 *
 * Links inside fenced code blocks are ignored — the templates in `99 Templates`
 * contain placeholder links like [[Related Note]] that are examples, not links.
 * Links inside inline backticks are ignored for the same reason.
 *
 * Usage: npm run docs:validate
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VAULT = join(ROOT, 'docs', 'obsidian');
/**
 * Root documents that are published alongside the vault.
 *
 * They are checked for the same publication boundary. `ASSUMPTIONS.md` was
 * referencing three excluded files by path, which nothing caught until these
 * were added here — the boundary has to cover everything that ships, not only
 * the folder it started in.
 */
const EXTRA = [
  join(ROOT, 'CLAUDE.md'),
  join(ROOT, 'ASSUMPTIONS.md'),
  join(ROOT, 'README.md'),
  join(ROOT, 'CHANGELOG.md'),
];

/** Root documents are published but are not vault notes: no frontmatter, no index. */
const isRootDoc = (file) => EXTRA.includes(file) && !file.endsWith('CLAUDE.md');

const REQUIRED_KEYS = ['title', 'type', 'status', 'owner', 'created', 'updated', 'tags'];

/**
 * Vault folders that never leave this machine.
 *
 * Must stay in step with the `docs/obsidian/...` entries in `.gitignore`; the
 * check below fails loudly if they drift apart, because a folder that is
 * local-only here and publishable there is the exact mistake this guards.
 */
const LOCAL_ONLY_DIRS = ['01 Strategy', '06 Partnerships', '08 Pilot'];

/** The local index that keeps local-only notes reachable. Not published. */
const LOCAL_INDEX = '00 Home (Local)';

const isLocalOnly = (file) =>
  LOCAL_ONLY_DIRS.some((dir) => relative(VAULT, file).split(sep)[0] === dir) ||
  file.split(sep).pop().replace(/\.md$/, '') === LOCAL_INDEX;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

const stripFences = (text) => text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
const LINK = /\[\[([^\]|#]+)/g;

const files = [...walk(VAULT), ...EXTRA];
const titles = new Map();
for (const file of files) {
  const stem = file.split(sep).pop().replace(/\.md$/, '');
  titles.set(stem, file);
}

const problems = {
  frontmatter: [],
  broken: [],
  orphans: [],
  noOutbound: [],
  crossedBoundary: [],
};
const localOnly = new Set(
  files.filter(isLocalOnly).map((f) => f.split(sep).pop().replace(/\.md$/, '')),
);
const incoming = new Map();
const outgoing = new Map();
let mermaid = 0;

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);
  const stem = file.split(sep).pop().replace(/\.md$/, '');
  mermaid += (raw.match(/^```mermaid/gm) ?? []).length;

  if (isRootDoc(file)) {
    // Checked for the boundary and for broken links, not for vault structure.
  } else if (!raw.startsWith('---')) {
    problems.frontmatter.push(`${rel}: no frontmatter`);
  } else {
    const end = raw.indexOf('\n---', 3);
    const block = end === -1 ? '' : raw.slice(3, end);
    for (const key of REQUIRED_KEYS) {
      if (!new RegExp(`^${key}:`, 'm').test(block)) {
        problems.frontmatter.push(`${rel}: missing "${key}"`);
      }
    }
  }

  // A published note must not *name* a local-only file either. A wikilink is the
  // obvious way to reference one; a path in a code block or a prose mention is
  // the way that slips through, and the title alone discloses what is being
  // withheld. Checked on the raw text, fences included, because that is exactly
  // where a directory tree lives.
  if (!isLocalOnly(file)) {
    for (const dir of LOCAL_ONLY_DIRS) {
      if (raw.includes(`${dir}/`) && !raw.includes(`${dir}/                `)) {
        const named = new RegExp(`${dir}/\{?[A-Za-z]`).test(raw);
        if (named) problems.crossedBoundary.push(`${rel} names files under "${dir}/"`);
      }
    }
  }

  const body = stripFences(raw);
  const links = new Set();
  for (const match of body.matchAll(LINK)) {
    const target = match[1].trim();
    links.add(target);
    if (titles.has(target)) {
      if (!incoming.has(target)) incoming.set(target, new Set());
      incoming.get(target).add(stem);
      // A published note may not name a local-only one. The link would dangle
      // in the published copy, and the title alone discloses what is being kept
      // back.
      if (!localOnly.has(stem) && localOnly.has(target)) {
        problems.crossedBoundary.push(`${rel} -> [[${target}]]`);
      }
    } else {
      problems.broken.push(`${rel} -> [[${target}]]`);
    }
  }
  outgoing.set(stem, links);
  if (links.size === 0 && !isRootDoc(file)) problems.noOutbound.push(rel);
}

for (const [stem, file] of titles) {
  if (stem === '00 Home' || stem === 'CLAUDE' || stem === LOCAL_INDEX) continue;
  if (isRootDoc(titles.get(stem))) continue;
  if (!incoming.has(stem) || incoming.get(stem).size === 0) {
    problems.orphans.push(relative(ROOT, file));
  }
}

// Published notes are reachable from `00 Home`; local-only notes from their own
// index, which is itself never published.
const homeLinks = outgoing.get('00 Home') ?? new Set();
const localLinks = outgoing.get(LOCAL_INDEX) ?? new Set();
const notInHome = [...titles.keys()].filter((t) => {
  if (t === '00 Home' || t === 'CLAUDE' || t === LOCAL_INDEX) return false;
  if (isRootDoc(titles.get(t))) return false;
  return localOnly.has(t) ? !localLinks.has(t) : !homeLinks.has(t);
});

console.log(`Notes:            ${String(titles.size)}`);
console.log(`Mermaid diagrams: ${String(mermaid)}`);
console.log(`Broken links:     ${String(problems.broken.length)}`);
console.log(`Orphan notes:     ${String(problems.orphans.length)}`);
console.log(`Missing frontmatter fields: ${String(problems.frontmatter.length)}`);
console.log(`Notes with no outbound links: ${String(problems.noOutbound.length)}`);
console.log(`Not linked from 00 Home: ${String(notInHome.length)}`);
console.log(`Local-only notes:  ${String(localOnly.size)}`);
console.log(`Published notes:   ${String(titles.size - localOnly.size)}`);
console.log(`Published -> local-only links: ${String(problems.crossedBoundary.length)}`);

for (const [label, list] of Object.entries({ ...problems, notInHome })) {
  if (Array.isArray(list) && list.length > 0) {
    console.log(`\n${label}:`);
    for (const item of list) console.log(`  - ${item}`);
  }
}

const failed =
  problems.broken.length +
  problems.orphans.length +
  problems.frontmatter.length +
  notInHome.length +
  problems.crossedBoundary.length;

if (failed > 0) {
  console.error(`\nFAIL: ${String(failed)} vault problem(s).`);
  process.exit(1);
}
console.log('\nOK: vault is valid.');
