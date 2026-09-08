/**
 * The Android shell's connect screen.
 *
 * This is the security boundary of the whole Android app: the only thing
 * between a string somebody types at a counter and the address every later
 * request — the merchant's PIN, their session cookie, every transaction — is
 * sent to. Getting it wrong does not produce a visible bug; it produces an app
 * that quietly talks to the wrong server.
 *
 * The file under test is loaded from disk and evaluated, rather than imported
 * as a module, because `www/connect.js` is a plain script the page includes
 * with a `<script>` tag and the APK ships byte-for-byte. Reading it here means
 * the thing verified is the thing that ships — an equivalent TypeScript copy
 * could drift from it without either failing.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

interface ConnectApi {
  hostAllowed: (hostname: string, allowedHosts: readonly string[]) => boolean;
  parseServer: (
    raw: unknown,
    allowedHosts: readonly string[],
  ) => { origin?: string; error?: string };
}

function loadConnect(): ConnectApi {
  const source = readFileSync(
    join(__dirname, '..', '..', 'apps', 'mobile', 'www', 'connect.js'),
    'utf8',
  );
  // A real VM context rather than the Function constructor: the script is a
  // browser IIFE that attaches itself to the global it is given, so it needs a
  // global object, and a context gives it one that is genuinely separate from
  // this test's. `URL` is passed in because `parseServer` depends on it and a
  // fresh context has no web globals.
  const sandbox: { URL: typeof URL; TelgaConnect?: ConnectApi } = { URL };
  createContext(sandbox);
  runInContext(source, sandbox, { filename: 'connect.js' });
  if (sandbox.TelgaConnect === undefined) {
    throw new Error('connect.js did not attach TelgaConnect to the global');
  }
  return sandbox.TelgaConnect;
}

const connect = loadConnect();

/**
 * A **synthetic** list, not the shipped one.
 *
 * It carries wildcards and two separate domains because that is what exercises
 * the matcher: subdomain acceptance, and the lookalike refusals that a naive
 * `endsWith` or `indexOf` would get wrong. The real `shell.config.json` names a
 * single exact host, which cannot test any of that.
 *
 * The shipped list is pinned separately, at the bottom of this file, so the two
 * concerns stay apart: **this** block proves the matcher is correct, **that**
 * one proves the configuration we actually ship is the one we meant.
 */
const SAMPLE_HOSTS = ['telga.et', '*.telga.et', 'mulesoo.et', '*.mulesoo.et'];
const parse = (raw: unknown): { origin?: string; error?: string } =>
  connect.parseServer(raw, SAMPLE_HOSTS);

describe('an address on the allow-list is accepted', () => {
  it('accepts the bare domain and a subdomain', () => {
    expect(parse('https://telga.et').origin).toBe('https://telga.et');
    expect(parse('https://pos.telga.et').origin).toBe('https://pos.telga.et');
    expect(parse('https://mulesoo.et').origin).toBe('https://mulesoo.et');
  });

  it('adds https:// when somebody types a bare host', () => {
    // Nobody at a counter types a scheme. Adding https — never http — keeps
    // the common case working without weakening the rule.
    expect(parse('telga.et').origin).toBe('https://telga.et');
    expect(parse('  pos.telga.et  ').origin).toBe('https://pos.telga.et');
  });

  it('drops any path, so a pasted deep link cannot be saved as the server', () => {
    // The app always opens at /launcher. A saved path would strand the
    // merchant somewhere odd on every future launch.
    expect(parse('https://telga.et/vouchers/data?x=1#y').origin).toBe('https://telga.et');
  });

  it('keeps a non-default port, which a pilot deployment may use', () => {
    expect(parse('https://telga.et:8443').origin).toBe('https://telga.et:8443');
  });
});

describe('an address off the allow-list is refused', () => {
  it('refuses a lookalike that merely ends with an allowed name', () => {
    // `host.endsWith('telga.et')` would accept this. It is a different domain,
    // registerable by anybody.
    expect(parse('https://nottelga.et').origin).toBeUndefined();
    expect(parse('https://evil-telga.et').origin).toBeUndefined();
  });

  it('refuses a lookalike that merely contains an allowed name', () => {
    // `indexOf(...) !== -1` would accept this. The real host is evil.com.
    expect(parse('https://telga.et.evil.com').origin).toBeUndefined();
    expect(parse('https://telga.et.attacker.example/launcher').origin).toBeUndefined();
  });

  it('refuses an unrelated host, naming what is allowed', () => {
    const result = parse('https://evil.example');
    expect(result.origin).toBeUndefined();
    // A merchant has to be able to read the reason down the phone to support.
    expect(result.error).toContain('telga.et');
  });

  it('does not let a wildcard match the bare domain by accident', () => {
    // `*.telga.et` alone must not match `telga.et`. Here the bare domain is
    // listed separately, so this checks the wildcard in isolation.
    expect(connect.hostAllowed('telga.et', ['*.telga.et'])).toBe(false);
    expect(connect.hostAllowed('pos.telga.et', ['*.telga.et'])).toBe(true);
  });

  it('refuses everything when the allow-list is empty', () => {
    // A build with no configured hosts must connect to nothing, rather than
    // falling open.
    expect(connect.parseServer('https://telga.et', []).origin).toBeUndefined();
  });
});

describe('the transport rules', () => {
  it('refuses http, even for an allowed host', () => {
    // A PIN and a session cookie travel over this. A shop's wi-fi is not a
    // trusted network.
    const result = parse('http://telga.et');
    expect(result.origin).toBeUndefined();
    expect(result.error).toContain('https');
  });

  it('refuses credentials embedded in the URL', () => {
    // `https://telga.et@evil.example` reads as Telga to a hurried person and
    // resolves to evil.example. The userinfo trick is why this check exists.
    expect(parse('https://telga.et@evil.example').origin).toBeUndefined();
    expect(parse('https://user:pass@telga.et').origin).toBeUndefined();
  });

  it('refuses other schemes outright', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<script>x</script>',
      'file:///etc/passwd',
      'ftp://telga.et',
    ]) {
      expect(parse(bad).origin, bad).toBeUndefined();
    }
  });
});

describe('nonsense input', () => {
  it('asks for an address rather than failing obscurely', () => {
    for (const empty of ['', '   ', null, undefined]) {
      const result = parse(empty);
      expect(result.origin).toBeUndefined();
      expect(result.error).toBeTruthy();
    }
  });

  it('never returns both an origin and an error', () => {
    // A caller that checked only one field would otherwise act on a refusal.
    for (const input of ['https://telga.et', 'https://evil.example', '', 'http://telga.et']) {
      const result = parse(input);
      expect(result.origin === undefined || result.error === undefined).toBe(true);
    }
  });
});

describe('the page and the config agree', () => {
  it('the shipped page loads connect.js and does not redefine the rules', () => {
    // The page delegating to this module is what makes these tests meaningful.
    // If it grew its own copy of the validation, this suite would be checking
    // something the APK no longer runs.
    const page = readFileSync(
      join(__dirname, '..', '..', 'apps', 'mobile', 'www', 'index.html'),
      'utf8',
    );
    expect(page).toContain('<script src="connect.js"></script>');
    expect(page).toContain('window.TelgaConnect.parseServer');
    expect(page).not.toContain('function hostAllowed');
  });

  it('the shipped allow-list behaves, and names only hosts we control', () => {
    // Capacitor reads the same file for allowNavigation. If the screen and the
    // WebView disagree about what is reachable, Telga opens in the system
    // browser instead of the app — and the merchant types a PIN into a tab
    // with no Telga chrome around it.
    const config = JSON.parse(
      readFileSync(
        join(__dirname, '..', '..', 'apps', 'mobile', 'shell.config.json'),
        'utf8',
      ),
    ) as { allowedHosts: string[]; defaultServer: string | null };

    const shipped = (raw: string): { origin?: string } =>
      connect.parseServer(raw, config.allowedHosts);

    // The training deployment is reachable...
    expect(shipped('https://telga-backend-production.up.railway.app').origin).toBe(
      'https://telga-backend-production.up.railway.app',
    );
    // ...and a lookalike of it is not.
    expect(shipped('https://evil-telga-backend-production.up.railway.app').origin).toBeUndefined();
    expect(shipped('https://telga-backend-production.up.railway.app.evil.com').origin).toBeUndefined();

    // **No unregistered domain may sit in this list.** `telga.et` and
    // `mulesoo.et` were never bought; a name nobody owns is a name somebody
    // else can buy, and this list is what decides where a PIN may be typed.
    // `telga.pro` was bought but is not attached to anything, so it is absent
    // too — it goes in when it is attached, as its own decision. A102, D113.
    for (const host of config.allowedHosts) {
      expect(host, `${host} must not be an unregistered domain`).not.toMatch(
        /telga\.et$|mulesoo\.et$/,
      );
    }
    expect(shipped('https://telga.et').origin).toBeUndefined();
    expect(shipped('https://mulesoo.et').origin).toBeUndefined();

    // A default server spares the operator typing an address at a counter. It
    // must be https: the shell refuses cleartext and the manifest sets
    // usesCleartextTraffic="false".
    expect(config.defaultServer).not.toBeNull();
    expect(config.defaultServer).toMatch(/^https:\/\//);
    expect(shipped(config.defaultServer as string).origin).toBe(config.defaultServer);
  });
});
