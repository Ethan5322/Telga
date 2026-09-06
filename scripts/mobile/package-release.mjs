/**
 * Produce the APK that is actually handed to a merchant.
 *
 * Gradle's `assembleRelease` already signs with v2 and v3. This adds **v1**
 * (JAR signing) on top and drops the result somewhere easy to find.
 *
 * ## Why v1, when the tooling says it is unnecessary
 *
 * Both AGP and `apksigner` refuse to add a v1 signature once `minSdk` is 24,
 * and by the specification they are right: v2 covers every Android that can
 * run this app. `apksigner` only relents when told `--min-sdk-version 21`.
 *
 * It is added anyway, deliberately, because "correct by the specification" and
 * "installs on the phone in the shop" are not the same claim. Several OEM
 * package managers have historically been fussier than stock Android about
 * sideloaded packages, and the whole cost of v1 is a slightly larger file and
 * a slower verify. Against a merchant who cannot install Telga at all and gets
 * "App not installed" with no reason attached, that is not a close call.
 *
 * This is belt and braces, not a diagnosis: if an install still fails, the
 * answer comes from `npm run mobile:diagnose`, which prints the real code.
 *
 *   npm run mobile:package
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ANDROID = join(ROOT, 'apps', 'mobile', 'android');

const sdk = process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk');
const buildTools = join(sdk, 'build-tools');
if (!existsSync(buildTools)) {
  console.error(`No Android build-tools under ${buildTools}. Set ANDROID_HOME.`);
  process.exit(1);
}
// Newest build-tools wins; apksigner is backward compatible.
const version = readdirSync(buildTools)
  .filter((d) => statSync(join(buildTools, d)).isDirectory())
  .sort()
  .pop();
const apksigner = join(buildTools, version, 'apksigner.bat');

/**
 * `apksigner.bat` is a wrapper that shells out to `java`, so it needs a JDK on
 * PATH or JAVA_HOME set. Android Studio's bundled JDK 25 cannot run this
 * project's Gradle, so the repository uses a separate Temurin 21 that is
 * deliberately not on PATH — which means this script has to find it rather
 * than assume the caller exported it.
 */
function resolveJavaHome() {
  if (process.env.JAVA_HOME !== undefined && existsSync(join(process.env.JAVA_HOME, 'bin', 'java.exe'))) {
    return process.env.JAVA_HOME;
  }
  const programs = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'jdk-21');
  if (existsSync(programs)) {
    for (const entry of readdirSync(programs)) {
      const candidate = join(programs, entry);
      if (existsSync(join(candidate, 'bin', 'java.exe'))) return candidate;
    }
  }
  return undefined;
}

const javaHome = resolveJavaHome();
if (javaHome === undefined) {
  console.error(
    'No JDK found. Set JAVA_HOME to a JDK 21. See ' +
      'docs/obsidian/05 Operations/Android Release and Play Store.md',
  );
  process.exit(1);
}
const env = { ...process.env, JAVA_HOME: javaHome };

const propsPath = join(ANDROID, 'keystore.properties');
if (!existsSync(propsPath)) {
  console.error(
    'No keystore.properties. Copy keystore.properties.example and fill it in.\n' +
      'See docs/obsidian/05 Operations/Android Release and Play Store.md',
  );
  process.exit(1);
}
const props = Object.fromEntries(
  readFileSync(propsPath, 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const built = join(ANDROID, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
if (!existsSync(built)) {
  console.error('No release APK. Run `npm run mobile:release` first.');
  process.exit(1);
}

// Written outside the repository: an APK is a build output, and .gitignore
// already refuses the build tree it came from.
const out = join(process.env.USERPROFILE ?? ROOT, 'telga-app.apk');
copyFileSync(built, out);

/** Quote for cmd.exe: these paths routinely contain spaces. */
const q = (v) => `"${v}"`;

execFileSync(
  q(apksigner),
  [
    'sign',
    '--ks', q(props.storeFile),
    '--ks-key-alias', q(props.keyAlias),
    '--ks-pass', q(`pass:${props.storePassword}`),
    '--key-pass', q(`pass:${props.keyPassword}`),
    '--v1-signing-enabled', 'true',
    '--v2-signing-enabled', 'true',
    '--v3-signing-enabled', 'true',
    // 21, not 24: apksigner omits v1 above 23 on the grounds that nothing
    // needs it. See the note above for why it is wanted regardless.
    '--min-sdk-version', '21',
    q(out),
  ],
  // `shell: true` because Node on Windows will not spawn a .bat directly
  // (EINVAL). Arguments are quoted below for the same reason: cmd.exe
  // splits on spaces, and both the SDK path and the keystore path have
  // them on a normal Windows install.
  { stdio: ['ignore', 'pipe', 'pipe'], shell: true, env },
);

const verify = execFileSync(
  q(apksigner),
  ['verify', '--verbose', '--min-sdk-version', '21', q(out)],
  { encoding: 'utf8', shell: true, env },
);
const schemes = ['v1', 'v2', 'v3']
  .map((v) => {
    const line = verify.split('\n').find((l) => l.includes(`${v} scheme`));
    return `${v}=${line !== undefined && line.trim().endsWith('true') ? 'yes' : 'NO'}`;
  })
  .join(' ');

const bytes = readFileSync(out);
console.log(`\nAPK: ${out}`);
console.log(`Size: ${(bytes.length / 1048576).toFixed(2)} MB`);
console.log(`Signed: ${schemes}`);
console.log(`SHA-256: ${createHash('sha256').update(bytes).digest('hex')}`);
console.log(
  '\nCheck that hash on the phone after copying. Gmail blocks .apk attachments\n' +
    'and some messaging apps re-encode the file; a different hash means the\n' +
    'transfer broke it, and no rebuild will help.',
);
