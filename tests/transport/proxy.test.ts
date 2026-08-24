/**
 * Proxy trust, scheme resolution, and host / origin validation.
 *
 * The test that matters most is `does not believe a spoofed forwarding header`.
 * If that ever passes wrongly, a plain HTTP request can talk the server into
 * calling itself secure — and the wrong answer arrives looking like the right
 * one.
 */

import { describe, expect, it } from 'vitest';
import {
  LOCAL_HTTP_DEFAULTS,
  checkHost,
  checkOrigin,
  cookieSecureFor,
  fromTrustedProxy,
  normalizeAddress,
  resolveScheme,
  STATE_CHANGING,
} from '@telga/merchant-pos';
import type { ConnectionFacts, TransportConfig } from '@telga/merchant-pos';

const PROXY = '10.0.0.7';

const proxied: TransportConfig = {
  trainingTransport: 'HTTPS',
  bindHost: '127.0.0.1',
  bindPort: 4321,
  trustProxy: [PROXY],
  tlsTermination: 'TRUSTED_PROXY',
  allowedHosts: ['telga-training.localhost'],
  allowedOrigins: [],
  sessionCookieSecure: true,
  hstsEnabled: false,
  hstsMaxAgeSeconds: 0,
  gracefulShutdownTimeoutMs: 10_000,
};

const standalone: TransportConfig = {
  ...proxied,
  tlsTermination: 'IN_PROCESS',
  trustProxy: false,
  tlsCertificatePath: '/tmp/c.pem',
  tlsPrivateKeyPath: '/tmp/k.pem',
};

const facts = (overrides: Partial<ConnectionFacts> = {}): ConnectionFacts => ({
  remoteAddress: PROXY,
  encryptedSocket: false,
  headers: { host: 'telga-training.localhost' },
  ...overrides,
});

describe('address normalisation', () => {
  it('treats an IPv6-mapped IPv4 address as the IPv4 one', () => {
    // Node reports `::ffff:127.0.0.1` on a dual-stack listener; a configured
    // `127.0.0.1` must still match it, or the trust list silently never fires.
    expect(normalizeAddress('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeAddress('  10.0.0.7 ')).toBe('10.0.0.7');
    expect(normalizeAddress(undefined)).toBe('');
  });
});

describe('who is trusted', () => {
  it('trusts a configured proxy address', () => {
    expect(fromTrustedProxy(proxied, PROXY)).toBe(true);
    expect(fromTrustedProxy(proxied, `::ffff:${PROXY}`)).toBe(true);
  });

  it('trusts nobody else', () => {
    expect(fromTrustedProxy(proxied, '10.0.0.8')).toBe(false);
    expect(fromTrustedProxy(proxied, undefined)).toBe(false);
    expect(fromTrustedProxy(proxied, '')).toBe(false);
  });

  it('trusts nobody at all when the list is false', () => {
    expect(fromTrustedProxy(standalone, PROXY)).toBe(false);
    expect(fromTrustedProxy(LOCAL_HTTP_DEFAULTS, '127.0.0.1')).toBe(false);
  });
});

describe('resolving the scheme', () => {
  it('believes its own TLS socket above everything', () => {
    const scheme = resolveScheme(standalone, facts({ encryptedSocket: true }));
    expect(scheme.scheme).toBe('https');
    expect(scheme.source).toBe('TLS_SOCKET');
  });

  it('ignores a forwarding header on a connection it terminated itself', () => {
    const scheme = resolveScheme(
      standalone,
      facts({ encryptedSocket: true, headers: { host: 'telga-training.localhost', 'x-forwarded-proto': 'http' } }),
    );
    // Nothing can contradict our own socket.
    expect(scheme.scheme).toBe('https');
    expect(scheme.forwardingHeaderIgnored).toBe(true);
  });

  it('believes a forwarding header from the configured proxy', () => {
    const scheme = resolveScheme(
      proxied,
      facts({ headers: { host: 'telga-training.localhost', 'x-forwarded-proto': 'https' } }),
    );
    expect(scheme.scheme).toBe('https');
    expect(scheme.source).toBe('TRUSTED_PROXY_HEADER');
  });

  it('takes the left-most value from a proxy chain', () => {
    const scheme = resolveScheme(
      proxied,
      facts({ headers: { host: 'telga-training.localhost', 'x-forwarded-proto': 'https, http' } }),
    );
    expect(scheme.scheme).toBe('https');
  });

  it('does not believe a spoofed forwarding header from an untrusted client', () => {
    // The one that matters. A client claiming HTTPS over a plain connection
    // must be treated as plain HTTP, or a Secure cookie gets set that the
    // browser will never send back — and the deployment reports itself secure.
    const scheme = resolveScheme(
      proxied,
      facts({
        remoteAddress: '203.0.113.9',
        headers: { host: 'telga-training.localhost', 'x-forwarded-proto': 'https' },
      }),
    );
    expect(scheme.scheme).toBe('http');
    expect(scheme.source).toBe('DEFAULT_PLAINTEXT');
    expect(scheme.forwardingHeaderIgnored).toBe(true);
  });

  it('does not believe a forwarding header when no proxy is trusted at all', () => {
    const scheme = resolveScheme(
      LOCAL_HTTP_DEFAULTS,
      facts({
        remoteAddress: '127.0.0.1',
        headers: { host: 'localhost', 'x-forwarded-proto': 'https' },
      }),
    );
    expect(scheme.scheme).toBe('http');
    expect(scheme.forwardingHeaderIgnored).toBe(true);
  });

  it('honours a trusted proxy that reports plain HTTP', () => {
    const scheme = resolveScheme(
      proxied,
      facts({ headers: { host: 'telga-training.localhost', 'x-forwarded-proto': 'http' } }),
    );
    expect(scheme.scheme).toBe('http');
    expect(scheme.source).toBe('TRUSTED_PROXY_HEADER');
  });
});

describe('the cookie decision', () => {
  it('marks Secure only when the client actually used HTTPS', () => {
    const viaProxy = resolveScheme(
      proxied,
      facts({ headers: { host: 'telga-training.localhost', 'x-forwarded-proto': 'https' } }),
    );
    expect(cookieSecureFor(proxied, viaProxy)).toBe(true);

    const spoofed = resolveScheme(
      proxied,
      facts({
        remoteAddress: '203.0.113.9',
        headers: { host: 'telga-training.localhost', 'x-forwarded-proto': 'https' },
      }),
    );
    // Spoofed: the cookie must NOT be Secure, or sign-in silently breaks.
    expect(cookieSecureFor(proxied, spoofed)).toBe(false);
  });

  it('never marks Secure on a plain HTTP deployment', () => {
    const scheme = resolveScheme(LOCAL_HTTP_DEFAULTS, facts({ remoteAddress: '127.0.0.1' }));
    expect(cookieSecureFor(LOCAL_HTTP_DEFAULTS, scheme)).toBe(false);
  });
});

describe('host validation', () => {
  it('accepts a configured host, with or without a port', () => {
    expect(checkHost(proxied, facts({ headers: { host: 'telga-training.localhost' } }))).toBeUndefined();
    expect(
      checkHost(proxied, facts({ headers: { host: 'telga-training.localhost:8443' } })),
    ).toBeUndefined();
  });

  it('refuses a host it was not told about', () => {
    // The Host header is client-controlled; a server that reflects it into a
    // link points an operator at somebody else's machine.
    expect(checkHost(proxied, facts({ headers: { host: 'evil.example' } }))).toBe(
      'HOST_NOT_ALLOWED',
    );
  });

  it('refuses a missing host', () => {
    expect(checkHost(proxied, facts({ headers: {} }))).toBe('HOST_MISSING');
  });

  it('honours a forwarded host only from the trusted proxy', () => {
    const allowed = checkHost(
      proxied,
      facts({ headers: { host: 'internal:4321', 'x-forwarded-host': 'telga-training.localhost' } }),
    );
    expect(allowed).toBeUndefined();

    const spoofed = checkHost(
      proxied,
      facts({
        remoteAddress: '203.0.113.9',
        headers: { host: 'evil.example', 'x-forwarded-host': 'telga-training.localhost' },
      }),
    );
    expect(spoofed).toBe('HOST_NOT_ALLOWED');
  });

  it('handles an IPv6 literal with a port', () => {
    const config: TransportConfig = { ...proxied, allowedHosts: ['[::1]'] };
    expect(checkHost(config, facts({ headers: { host: '[::1]:4321' } }))).toBeUndefined();
  });
});

describe('origin validation', () => {
  const scheme = resolveScheme(
    proxied,
    facts({ headers: { host: 'telga-training.localhost', 'x-forwarded-proto': 'https' } }),
  );

  it('accepts a same-origin request', () => {
    expect(
      checkOrigin(
        proxied,
        facts({ headers: { host: 'telga-training.localhost', origin: 'https://telga-training.localhost' } }),
        scheme,
      ),
    ).toBeUndefined();
  });

  it('accepts an absent Origin, because old form posts omit it', () => {
    // CSRF tokens are the primary control; this is a second one, and refusing a
    // missing header would break plain form posts for no security gain.
    expect(checkOrigin(proxied, facts({ headers: { host: 'telga-training.localhost' } }), scheme)).toBeUndefined();
    expect(
      checkOrigin(
        proxied,
        facts({ headers: { host: 'telga-training.localhost', origin: 'null' } }),
        scheme,
      ),
    ).toBeUndefined();
  });

  it('refuses a cross-origin request', () => {
    expect(
      checkOrigin(
        proxied,
        facts({ headers: { host: 'telga-training.localhost', origin: 'https://evil.example' } }),
        scheme,
      ),
    ).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('refuses an origin on the wrong scheme', () => {
    expect(
      checkOrigin(
        proxied,
        facts({ headers: { host: 'telga-training.localhost', origin: 'http://telga-training.localhost' } }),
        scheme,
      ),
    ).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('refuses an unparseable origin', () => {
    expect(
      checkOrigin(
        proxied,
        facts({ headers: { host: 'telga-training.localhost', origin: 'not a url' } }),
        scheme,
      ),
    ).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('accepts an explicitly allowed extra origin', () => {
    const config: TransportConfig = { ...proxied, allowedOrigins: ['https://ops.telga.internal'] };
    expect(
      checkOrigin(
        config,
        facts({ headers: { host: 'telga-training.localhost', origin: 'https://ops.telga.internal' } }),
        scheme,
      ),
    ).toBeUndefined();
  });

  it('checks the methods that change state', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(STATE_CHANGING.has(method), method).toBe(true);
    }
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(STATE_CHANGING.has(method), method).toBe(false);
    }
  });
});
