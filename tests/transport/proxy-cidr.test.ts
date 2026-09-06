/**
 * CIDR-capable trusted-proxy matching.
 *
 * ## Why a range at all
 *
 * Behind a platform terminator the proxy's address is drawn from an internal
 * pool and is not stable across restarts, so an exact address cannot be
 * configured for one. A range can be — and a range is still an explicit
 * statement about which addresses are trusted.
 *
 * ## The test that matters most
 *
 * `refuses a zero-length prefix`. `0.0.0.0/0` matches every address on the
 * internet, which is the "trust all proxies" setting the transport layer
 * deliberately does not have. If that ever parses, the range syntax has
 * smuggled back in the one configuration `--trust-proxy` exists to prevent, and
 * a spoofed `X-Forwarded-Proto` from any client would be believed.
 */

import { describe, expect, it } from 'vitest';
import {
  addressInRange,
  fromTrustedProxy,
  normalizeAddress,
  observeUntrustedForwarding,
  parseAddress,
  parseTrustedEntry,
  resetObservedPeers,
  validateTransport,
} from '@telga/merchant-pos';
import type { ConnectionFacts, RequestScheme, TransportConfig } from '@telga/merchant-pos';

const base: TransportConfig = {
  trainingTransport: 'HTTPS',
  bindHost: '127.0.0.1',
  bindPort: 4321,
  trustProxy: ['10.0.0.7'],
  tlsTermination: 'TRUSTED_PROXY',
  allowedHosts: ['telga-training.localhost'],
  allowedOrigins: [],
  sessionCookieSecure: true,
  hstsEnabled: false,
  hstsMaxAgeSeconds: 0,
  gracefulShutdownTimeoutMs: 10_000,
};

const withTrust = (entries: readonly string[]): TransportConfig => ({
  ...base,
  trustProxy: entries,
});

describe('parsing a trusted-proxy entry', () => {
  it('reads a plain IPv4 address as a full-width prefix', () => {
    const parsed = parseTrustedEntry('10.0.0.7');
    expect(parsed?.prefixLength).toBe(32);
    expect(parsed?.address.version).toBe(4);
  });

  it('reads a plain IPv6 address as a full-width prefix', () => {
    const parsed = parseTrustedEntry('fd00::1');
    expect(parsed?.prefixLength).toBe(128);
    expect(parsed?.address.version).toBe(6);
  });

  it('reads a CIDR range', () => {
    expect(parseTrustedEntry('100.64.0.0/10')?.prefixLength).toBe(10);
    expect(parseTrustedEntry('fd00::/8')?.prefixLength).toBe(8);
  });

  it('refuses a zero-length prefix — that is the trust-all setting', () => {
    expect(parseTrustedEntry('0.0.0.0/0')).toBeUndefined();
    expect(parseTrustedEntry('::/0')).toBeUndefined();
  });

  it('refuses a prefix wider than the address family', () => {
    expect(parseTrustedEntry('10.0.0.0/33')).toBeUndefined();
    expect(parseTrustedEntry('fd00::/129')).toBeUndefined();
  });

  it('refuses malformed text rather than guessing', () => {
    for (const entry of ['', '  ', 'not-an-address', '10.0.0', '10.0.0.256', '10.0.0.1/', '10.0.0.1/x', '1e2.0.0.1']) {
      expect(parseTrustedEntry(entry), entry).toBeUndefined();
    }
  });
});

describe('address parsing', () => {
  it('reads IPv6 with :: compression', () => {
    expect(parseAddress('fd00::1')?.bytes).toEqual([0xfd, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('reads an IPv4-mapped IPv6 address as IPv4', () => {
    const parsed = parseAddress('::ffff:10.0.0.7');
    expect(parsed?.version).toBe(4);
    expect(parsed?.bytes).toEqual([10, 0, 0, 7]);
  });

  it('drops an IPv6 zone index, which means nothing to a comparison', () => {
    expect(normalizeAddress('fe80::1%eth0')).toBe('fe80::1');
    expect(parseAddress('fe80::1%eth0')?.version).toBe(6);
  });

  it('refuses an ambiguous :: that elides nothing', () => {
    // Eight groups are already present, so `::` stands for zero groups.
    expect(parseAddress('1:2:3:4:5:6:7::8')).toBeUndefined();
  });
});

describe('range containment', () => {
  const inside = (candidate: string, entry: string): boolean => {
    const address = parseAddress(candidate);
    const range = parseTrustedEntry(entry);
    if (!address || !range) throw new Error(`unparseable: ${candidate} / ${entry}`);
    return addressInRange(address, range);
  };

  it('matches an address inside the range', () => {
    expect(inside('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(inside('100.64.0.1', '100.64.0.0/10')).toBe(true);
  });

  it('rejects an address outside the range', () => {
    expect(inside('11.1.2.3', '10.0.0.0/8')).toBe(false);
    // 100.0.0.1 is outside the carrier-grade NAT block, and publicly routable.
    expect(inside('100.0.0.1', '100.64.0.0/10')).toBe(false);
  });

  it('honours a prefix that splits a byte', () => {
    expect(inside('10.127.0.0', '10.128.0.0/9')).toBe(false);
    expect(inside('10.128.0.1', '10.128.0.0/9')).toBe(true);
  });

  it('never matches across address families', () => {
    const v6 = parseAddress('::1');
    const v4range = parseTrustedEntry('10.0.0.0/8');
    expect(v6 && v4range && addressInRange(v6, v4range)).toBe(false);
  });
});

describe('fromTrustedProxy', () => {
  it('still matches an exact address, as it always did', () => {
    expect(fromTrustedProxy(withTrust(['10.0.0.7']), '10.0.0.7')).toBe(true);
    expect(fromTrustedProxy(withTrust(['10.0.0.7']), '10.0.0.8')).toBe(false);
  });

  it('matches an address inside a configured range', () => {
    expect(fromTrustedProxy(withTrust(['10.0.0.0/8']), '10.4.5.6')).toBe(true);
    expect(fromTrustedProxy(withTrust(['10.0.0.0/8']), '192.168.0.1')).toBe(false);
  });

  it('matches an IPv4-mapped peer against an IPv4 range', () => {
    expect(fromTrustedProxy(withTrust(['10.0.0.0/8']), '::ffff:10.4.5.6')).toBe(true);
  });

  it('trusts nothing when trust is off, whatever the range would say', () => {
    expect(fromTrustedProxy({ ...base, trustProxy: false }, '10.0.0.7')).toBe(false);
  });

  it('trusts nothing on an empty list', () => {
    expect(fromTrustedProxy(withTrust([]), '10.0.0.7')).toBe(false);
  });

  it('ignores an unparseable entry rather than trusting everything', () => {
    expect(fromTrustedProxy(withTrust(['nonsense']), '10.0.0.7')).toBe(false);
  });

  it('has no default trusted range for any hosting platform', () => {
    // The community-reported Railway forwarding range, unverified and
    // deliberately not shipped. Nothing is trusted until configured.
    expect(fromTrustedProxy(withTrust([]), '100.64.0.1')).toBe(false);
    expect(fromTrustedProxy({ ...base, trustProxy: false }, '100.64.0.1')).toBe(false);
  });
});

describe('startup validation', () => {
  it('refuses a trust-all range at startup', () => {
    expect(() => validateTransport(withTrust(['0.0.0.0/0']))).toThrow(/PROXY_TRUST_ENTRY_INVALID|trust every client/);
  });

  it('refuses a malformed entry rather than silently matching nothing', () => {
    expect(() => validateTransport(withTrust(['10.0.0.999']))).toThrow(/PROXY_TRUST_ENTRY_INVALID|not an IP address/);
  });

  it('accepts a well-formed range', () => {
    expect(() => validateTransport(withTrust(['10.0.0.0/8']))).not.toThrow();
  });
});

describe('the untrusted-peer diagnostic', () => {
  const facts = (remoteAddress: string): ConnectionFacts => ({
    remoteAddress,
    encryptedSocket: false,
    headers: { 'x-forwarded-proto': 'https' },
  });
  const ignored: RequestScheme = {
    scheme: 'http',
    source: 'DEFAULT_PLAINTEXT',
    forwardingHeaderIgnored: true,
  };
  const believed: RequestScheme = {
    scheme: 'https',
    source: 'TRUSTED_PROXY_HEADER',
    forwardingHeaderIgnored: false,
  };

  it('names the peer address that was not believed', () => {
    resetObservedPeers();
    const lines: string[] = [];
    observeUntrustedForwarding(ignored, facts('100.64.0.5'), (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('100.64.0.5');
    expect(lines[0]).toContain('PROXY_PEER_OBSERVED');
  });

  it('reports each address once, not on every request', () => {
    resetObservedPeers();
    const lines: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      observeUntrustedForwarding(ignored, facts('100.64.0.5'), (line) => lines.push(line));
    }
    expect(lines).toHaveLength(1);
  });

  it('says nothing when the header was believed', () => {
    resetObservedPeers();
    const lines: string[] = [];
    observeUntrustedForwarding(believed, facts('10.0.0.7'), (line) => lines.push(line));
    expect(lines).toEqual([]);
  });

  it('does not trust the address it just reported', () => {
    resetObservedPeers();
    observeUntrustedForwarding(ignored, facts('100.64.0.5'), () => {});
    // Observing is not configuring: the address is still untrusted afterwards.
    expect(fromTrustedProxy(withTrust([]), '100.64.0.5')).toBe(false);
  });
});
