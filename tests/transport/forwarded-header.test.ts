/**
 * RFC 7239 `Forwarded`.
 *
 * `TLS and Proxy Configuration` listed this under *"What is not covered"*: the
 * header was **detected but not parsed**. Detection alone was safe but wrong —
 * a standards-compliant proxy sending only `Forwarded: proto=https` had its
 * claim discarded, and Telga called a TLS-fronted connection plaintext, which
 * strips `Secure` from the operator's cookie.
 *
 * The trust rule is unchanged and is what these tests protect hardest: the
 * header is believed **only** from a configured trusted address. Parsing it
 * must not become a second way to spoof the one thing `X-Forwarded-Proto`
 * already could not.
 */

import { describe, expect, it } from 'vitest';
import { LOCAL_HTTP_DEFAULTS, forwardedProto, resolveScheme } from '@telga/merchant-pos';
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

const facts = (overrides: Partial<ConnectionFacts> = {}): ConnectionFacts => ({
  remoteAddress: PROXY,
  encryptedSocket: false,
  headers: { host: 'telga-training.localhost' },
  ...overrides,
});

const withHeaders = (headers: Record<string, string>, remoteAddress = PROXY): ConnectionFacts =>
  facts({ remoteAddress, headers: { host: 'telga-training.localhost', ...headers } });

describe('parsing the header', () => {
  it('reads proto from a plain element', () => {
    expect(forwardedProto('proto=https')).toBe('https');
    expect(forwardedProto('for=192.0.2.60;proto=http;by=203.0.113.43')).toBe('http');
  });

  it('accepts the quoted form RFC 7239 permits', () => {
    expect(forwardedProto('proto="https"')).toBe('https');
    expect(forwardedProto('for="[2001:db8::1]";proto="https"')).toBe('https');
  });

  it('is case- and space-insensitive, as the grammar requires', () => {
    expect(forwardedProto('PROTO = HTTPS')).toBe('https');
    expect(forwardedProto('  proto=HtTpS  ')).toBe('https');
  });

  it('reads only the first element of a chain', () => {
    // A chain is appended left to right, so the left-most entry is the hop
    // nearest the client — the only one describing the connection Telga sees.
    expect(forwardedProto('proto=https, proto=http')).toBe('https');
    expect(forwardedProto('proto=http, proto=https')).toBe('http');
  });

  it('returns nothing for a protocol Telga does not speak', () => {
    // Guessing is how `proto=ftp` or an injected value becomes a decision.
    expect(forwardedProto('proto=ftp')).toBeUndefined();
    expect(forwardedProto('proto=')).toBeUndefined();
    expect(forwardedProto('proto=https extra')).toBeUndefined();
  });

  it('returns nothing when there is no proto at all', () => {
    expect(forwardedProto('for=192.0.2.60;by=203.0.113.43')).toBeUndefined();
    expect(forwardedProto('')).toBeUndefined();
    expect(forwardedProto(undefined)).toBeUndefined();
    expect(forwardedProto('nonsense')).toBeUndefined();
  });
});

describe('the trust rule still governs it', () => {
  it('believes Forwarded from a trusted proxy', () => {
    // The gap this closes: before, this connection resolved to `http`.
    const scheme = resolveScheme(proxied, withHeaders({ forwarded: 'proto=https' }));
    expect(scheme.scheme).toBe('https');
    expect(scheme.source).toBe('TRUSTED_PROXY_HEADER');
    expect(scheme.forwardingHeaderIgnored).toBe(false);
  });

  it('does not believe it from anybody else', () => {
    // The whole point. An untrusted client claiming `proto=https` must not
    // talk the server into marking a cookie `Secure`.
    const scheme = resolveScheme(proxied, withHeaders({ forwarded: 'proto=https' }, '203.0.113.9'));
    expect(scheme.scheme).toBe('http');
    expect(scheme.source).toBe('DEFAULT_PLAINTEXT');
    expect(scheme.forwardingHeaderIgnored).toBe(true);
  });

  it('does not believe it when no proxy is trusted at all', () => {
    const scheme = resolveScheme(
      LOCAL_HTTP_DEFAULTS,
      facts({ remoteAddress: '127.0.0.1', headers: { forwarded: 'proto=https' } }),
    );
    expect(scheme.scheme).toBe('http');
    expect(scheme.forwardingHeaderIgnored).toBe(true);
  });

  it('never lets it contradict our own TLS socket', () => {
    // Nothing overrides a connection this process terminated itself.
    const scheme = resolveScheme(
      proxied,
      facts({ encryptedSocket: true, headers: { forwarded: 'proto=http' } }),
    );
    expect(scheme.scheme).toBe('https');
    expect(scheme.source).toBe('TLS_SOCKET');
    expect(scheme.forwardingHeaderIgnored).toBe(true);
  });
});

describe('when both headers arrive', () => {
  it('agrees with itself when they agree', () => {
    const scheme = resolveScheme(
      proxied,
      withHeaders({ forwarded: 'proto=https', 'x-forwarded-proto': 'https' }),
    );
    expect(scheme.scheme).toBe('https');
    expect(scheme.source).toBe('TRUSTED_PROXY_HEADER');
  });

  it('believes neither when they disagree', () => {
    // A disagreement means the hop in front is misconfigured or something
    // between them injected one. Telga does not know what the client used, so
    // it falls back to plaintext — the answer that cannot be exploited.
    const scheme = resolveScheme(
      proxied,
      withHeaders({ forwarded: 'proto=https', 'x-forwarded-proto': 'http' }),
    );
    expect(scheme.scheme).toBe('http');
    expect(scheme.source).toBe('CONFLICTING_PROXY_HEADERS');
    expect(scheme.forwardingHeaderIgnored).toBe(true);
  });

  it('falls back to plaintext in the other direction too', () => {
    // Symmetric on purpose: which header claimed `https` must not change the
    // outcome, or the fallback becomes a way to pick a winner.
    const scheme = resolveScheme(
      proxied,
      withHeaders({ forwarded: 'proto=http', 'x-forwarded-proto': 'https' }),
    );
    expect(scheme.scheme).toBe('http');
    expect(scheme.source).toBe('CONFLICTING_PROXY_HEADERS');
  });

  it('uses the one that parses when the other does not', () => {
    // An unparseable `Forwarded` is not a disagreement — it is an absence.
    const scheme = resolveScheme(
      proxied,
      withHeaders({ forwarded: 'for=192.0.2.60', 'x-forwarded-proto': 'https' }),
    );
    expect(scheme.scheme).toBe('https');
    expect(scheme.source).toBe('TRUSTED_PROXY_HEADER');
  });
});

describe('a trusted header that says nothing useful', () => {
  it('is recorded as ignored, so a broken proxy gets noticed', () => {
    const scheme = resolveScheme(proxied, withHeaders({ forwarded: 'for=192.0.2.60' }));
    expect(scheme.scheme).toBe('http');
    expect(scheme.source).toBe('TRUSTED_PROXY_HEADER');
    // It arrived, it was trusted, and it contributed nothing.
    expect(scheme.forwardingHeaderIgnored).toBe(true);
  });

  it('is not recorded as ignored when it did decide the answer', () => {
    const scheme = resolveScheme(proxied, withHeaders({ forwarded: 'proto=http' }));
    expect(scheme.scheme).toBe('http');
    expect(scheme.forwardingHeaderIgnored).toBe(false);
  });
});
