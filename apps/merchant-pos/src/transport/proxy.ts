/**
 * Trusted-proxy handling, and host / origin validation.
 *
 * ## The rule
 *
 * **A forwarding header is believed only when the connection it arrived on came
 * from a configured trusted address.** Anything else is treated as plain HTTP,
 * whatever it claims.
 *
 * That matters more than it looks. If `X-Forwarded-Proto: https` were believed
 * from any client, a plain HTTP request could talk the server into marking a
 * cookie `Secure` — and a `Secure` cookie is never sent back over HTTP, so the
 * operator signs in and is immediately signed out. The same spoof also makes an
 * insecure deployment *report itself* as secure, which is worse: the wrong
 * answer arrives looking like the right one.
 *
 * There is deliberately **no "trust all proxies" setting**. It is the single
 * configuration that turns this file from a control into a decoration.
 *
 * ## Why host validation exists
 *
 * The `Host` header is client-controlled. A server that reflects it into a
 * redirect, a link or a cookie domain will happily point an operator at
 * somebody else's machine. Telga answers only for hosts it was told about.
 */

import type { TransportConfig } from './config';

export const FORWARDED_PROTO_HEADER = 'x-forwarded-proto';
export const FORWARDED_HOST_HEADER = 'x-forwarded-host';
export const FORWARDED_HEADER = 'forwarded';

export interface ConnectionFacts {
  /** The peer address of the TCP connection, as the server sees it. */
  readonly remoteAddress: string | undefined;
  /** True when this process terminated TLS for this connection. */
  readonly encryptedSocket: boolean;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface RequestScheme {
  readonly scheme: 'http' | 'https';
  /** Why the scheme was decided that way. Useful in a refusal, and in a log. */
  readonly source:
    | 'TLS_SOCKET'
    | 'TRUSTED_PROXY_HEADER'
    | 'DEFAULT_PLAINTEXT'
    /**
     * Two trusted headers disagreed about the client's protocol, so neither
     * was believed. See {@link resolveScheme}.
     */
    | 'CONFLICTING_PROXY_HEADERS';
  /** True when a forwarding header was present but not believed. */
  readonly forwardingHeaderIgnored: boolean;
}

/**
 * The `proto` of the first element of an RFC 7239 `Forwarded` header.
 *
 * ## Why this is parsed at all
 *
 * `TLS and Proxy Configuration` recorded, under *"What is not covered"*, that
 * `Forwarded` was **detected but not parsed**. Detection alone made the header
 * safe but useless: a standards-compliant proxy that sends only `Forwarded:
 * proto=https` — and no `X-Forwarded-Proto` — had its claim thrown away, and
 * Telga marked the connection plaintext. That fails in the safe direction, but
 * it fails: the operator's cookie loses `Secure` on a connection that genuinely
 * had TLS in front of it.
 *
 * ## What it deliberately does not do
 *
 * It reads `proto` only, and only from the **first** element. RFC 7239 allows a
 * chain, appended left to right, so the left-most entry is the hop nearest the
 * client — the only one describing the connection Telga cares about. `for=`,
 * `by=` and `host=` are not read: nothing in Telga makes a decision from them,
 * and parsing a field with no consumer is how one acquires one by accident.
 *
 * The trust rule is unchanged and enforced by the caller: this function is
 * consulted **only** on a connection from a configured trusted address.
 */
export function forwardedProto(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const first = value.split(',')[0];
  if (first === undefined) return undefined;
  for (const pair of first.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim().toLowerCase() !== 'proto') continue;
    // RFC 7239 permits a quoted-string value: `proto="https"`.
    const raw = pair.slice(eq + 1).trim();
    const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    const proto = unquoted.trim().toLowerCase();
    // Only the two protocols Telga speaks. Anything else is not a scheme this
    // server can serve, and guessing is how `proto=hTTps\r\n` becomes a bug.
    return proto === 'https' || proto === 'http' ? proto : undefined;
  }
  return undefined;
}

/** Strip an IPv6-mapped IPv4 prefix so `::ffff:127.0.0.1` compares as `127.0.0.1`. */
export function normalizeAddress(address: string | undefined): string {
  if (!address) return '';
  const trimmed = address.trim().toLowerCase();
  if (trimmed.startsWith('::ffff:')) return trimmed.slice(7);
  // A scoped IPv6 literal (`fe80::1%eth0`) carries a zone that means nothing to
  // a comparison against a configured address.
  const zone = trimmed.indexOf('%');
  return zone === -1 ? trimmed : trimmed.slice(0, zone);
}

/**
 * A parsed IP address: the raw bytes, and which family they came from.
 *
 * Bytes rather than a string because a range test is arithmetic on the address,
 * and `'10.0.0.9' < '10.0.0.10'` is false when compared as text.
 */
export interface ParsedAddress {
  readonly bytes: readonly number[];
  readonly version: 4 | 6;
}

/** Parse dotted-quad IPv4. Rejects anything that is not exactly four bytes. */
function parseIpv4(text: string): ParsedAddress | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  const bytes: number[] = [];
  for (const part of parts) {
    // `Number('')` is 0 and `Number('1e2')` is 100; neither is a dotted quad.
    if (part.length === 0 || part.length > 3 || !/^\d+$/.test(part)) return undefined;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return undefined;
    bytes.push(value);
  }
  return { bytes, version: 4 };
}

/**
 * Parse IPv6, including `::` compression and a trailing IPv4 form
 * (`::ffff:10.0.0.1`). Returns sixteen bytes.
 */
function parseIpv6(text: string): ParsedAddress | undefined {
  if (text.length === 0) return undefined;
  // At most one `::`, and it is the only place a group may be empty.
  const halves = text.split('::');
  if (halves.length > 2) return undefined;

  const readGroups = (segment: string): number[] | undefined => {
    if (segment.length === 0) return [];
    const out: number[] = [];
    const groups = segment.split(':');
    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i] ?? '';
      // A dotted quad is only legal as the final element.
      if (group.includes('.')) {
        if (i !== groups.length - 1) return undefined;
        const v4 = parseIpv4(group);
        if (!v4) return undefined;
        out.push(...v4.bytes);
        continue;
      }
      if (group.length === 0 || group.length > 4 || !/^[0-9a-f]+$/.test(group)) return undefined;
      const value = Number.parseInt(group, 16);
      out.push((value >> 8) & 0xff, value & 0xff);
    }
    return out;
  };

  const head = readGroups(halves[0] ?? '');
  if (!head) return undefined;
  if (halves.length === 1) {
    return head.length === 16 ? { bytes: head, version: 6 } : undefined;
  }
  const tail = readGroups(halves[1] ?? '');
  if (!tail) return undefined;
  const missing = 16 - head.length - tail.length;
  // `::` must stand for at least one elided group, or the text was ambiguous.
  if (missing < 1) return undefined;
  return { bytes: [...head, ...new Array<number>(missing).fill(0), ...tail], version: 6 };
}

/** Parse an address of either family. */
export function parseAddress(text: string | undefined): ParsedAddress | undefined {
  const normalized = normalizeAddress(text);
  if (normalized.length === 0) return undefined;
  return normalized.includes(':') ? parseIpv6(normalized) : parseIpv4(normalized);
}

/** A trusted-proxy entry, once parsed: one address, or a range of them. */
export interface TrustedRange {
  readonly address: ParsedAddress;
  /** Bits of the address that must match. A plain address is a full-width prefix. */
  readonly prefixLength: number;
}

/**
 * Parse one `--trust-proxy` entry: `10.0.0.7`, or `100.64.0.0/10`.
 *
 * Returns `undefined` for anything malformed **and for a zero-length prefix**.
 * `0.0.0.0/0` and `::/0` match every address, which is the "trust all proxies"
 * setting this file exists to not have — see the header. It is refused here so
 * that it cannot be spelled as a range, having been refused as a flag.
 */
export function parseTrustedEntry(entry: string): TrustedRange | undefined {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return undefined;

  const slash = trimmed.lastIndexOf('/');
  if (slash === -1) {
    const address = parseAddress(trimmed);
    return address ? { address, prefixLength: address.bytes.length * 8 } : undefined;
  }

  const address = parseAddress(trimmed.slice(0, slash));
  const suffix = trimmed.slice(slash + 1);
  if (!address || suffix.length === 0 || !/^\d+$/.test(suffix)) return undefined;
  const prefixLength = Number(suffix);
  const width = address.bytes.length * 8;
  // `< 1` refuses the trust-everything range; `> width` is simply nonsense.
  if (!Number.isInteger(prefixLength) || prefixLength < 1 || prefixLength > width) return undefined;
  return { address, prefixLength };
}

/** Whether `candidate` falls inside `range`. Families never match each other. */
export function addressInRange(candidate: ParsedAddress, range: TrustedRange): boolean {
  if (candidate.version !== range.address.version) return false;
  let remaining = range.prefixLength;
  for (let i = 0; i < candidate.bytes.length && remaining > 0; i += 1) {
    const bits = Math.min(8, remaining);
    // Compare only the leading `bits` of this byte; the rest is host space.
    const mask = (0xff << (8 - bits)) & 0xff;
    if (((candidate.bytes[i] ?? 0) & mask) !== ((range.address.bytes[i] ?? 0) & mask)) return false;
    remaining -= bits;
  }
  return true;
}

/**
 * Whether this connection came from a configured trusted proxy.
 *
 * An entry may be an exact address or a CIDR range. A range is what a platform
 * terminator needs: the hop's address is drawn from an internal pool and is not
 * stable across restarts, so an exact address cannot be configured for one.
 * A range is still an **explicit** statement about which addresses are trusted
 * — `parseTrustedEntry` refuses a zero-length prefix, so no range spells
 * "everything".
 */
export function fromTrustedProxy(config: TransportConfig, remoteAddress: string | undefined): boolean {
  if (config.trustProxy === false) return false;
  const candidate = parseAddress(remoteAddress);
  if (!candidate) {
    // Not parseable as an address (a unix socket, or a stub in a test). Fall
    // back to the exact text comparison this function has always done.
    const normalized = normalizeAddress(remoteAddress);
    if (normalized.length === 0) return false;
    return config.trustProxy.some((trusted) => normalizeAddress(trusted) === normalized);
  }
  return config.trustProxy.some((trusted) => {
    const range = parseTrustedEntry(trusted);
    return range ? addressInRange(candidate, range) : false;
  });
}

/**
 * Addresses already reported by {@link observeUntrustedForwarding}, so a
 * misconfigured deployment names each hop once instead of on every request.
 */
const reportedPeers = new Set<string>();

/** Test seam: forget what has been reported. */
export function resetObservedPeers(): void {
  reportedPeers.clear();
}

/**
 * Report the peer address of a connection whose forwarding header was **not**
 * believed, once per address.
 *
 * ## Why this exists
 *
 * Behind a platform terminator the operator cannot know, in advance, which
 * address the proxy will speak from: it is drawn from the platform's internal
 * pool and the platform may not publish the range. Without this, the symptom of
 * a missing `--trust-proxy` entry is a sign-in that appears to succeed and
 * immediately fails, with nothing on stderr to say why.
 *
 * So Telga says what it saw. It deliberately does **not** act on it: nothing
 * here adds the address to the trusted list, and no range is trusted by
 * default. The operator reads the address, verifies it belongs to their
 * terminator, and configures it. That keeps the decision explicit, which is the
 * whole point of having no "trust all proxies" setting.
 *
 * The address is the proxy's, not the customer's, and is already visible to
 * anyone who can read the deployment's own network configuration.
 */
export function observeUntrustedForwarding(
  scheme: RequestScheme,
  facts: ConnectionFacts,
  write: (line: string) => void,
): void {
  if (!scheme.forwardingHeaderIgnored) return;
  const peer = normalizeAddress(facts.remoteAddress);
  if (peer.length === 0 || reportedPeers.has(peer)) return;
  reportedPeers.add(peer);
  write(
    `PROXY_PEER_OBSERVED peer=${peer} — a forwarding header arrived from this address ` +
      'and was NOT believed, because the address is not in --trust-proxy. Cookies on this ' +
      'connection are not marked Secure. If this address belongs to your TLS terminator, ' +
      'add it (or its range, e.g. 10.0.0.0/8) to --trust-proxy. Telga does not trust it ' +
      'automatically, and ships no built-in range for any hosting platform.',
  );
}

/**
 * Decide the scheme the **client** used.
 *
 * Order: our own TLS socket first (nothing can contradict that), then a
 * forwarding header if and only if the hop is trusted, then plaintext.
 */
export function resolveScheme(config: TransportConfig, facts: ConnectionFacts): RequestScheme {
  const forwarded = facts.headers[FORWARDED_PROTO_HEADER];
  const hasForwardingHeader =
    typeof forwarded === 'string' ||
    typeof facts.headers[FORWARDED_HEADER] === 'string' ||
    typeof facts.headers[FORWARDED_HOST_HEADER] === 'string';

  if (facts.encryptedSocket) {
    return {
      scheme: 'https',
      source: 'TLS_SOCKET',
      // A forwarding header on a connection we terminated ourselves is noise at
      // best. It is never consulted.
      forwardingHeaderIgnored: hasForwardingHeader,
    };
  }

  if (hasForwardingHeader && fromTrustedProxy(config, facts.remoteAddress)) {
    // Take the first value: a proxy chain appends, and the left-most entry is
    // the one nearest the client.
    const legacy = (forwarded ?? '').split(',')[0]?.trim().toLowerCase();
    const fromXfp = legacy === 'https' || legacy === 'http' ? legacy : undefined;
    const fromRfc7239 = forwardedProto(facts.headers[FORWARDED_HEADER]);

    // Both headers present and disagreeing is not a case to resolve by picking
    // a winner. It means the hop in front is misconfigured or something between
    // them injected one, and either way Telga does not know what the client
    // used. Falling back to plaintext is the answer that cannot be exploited:
    // the worst outcome is a cookie that is not marked `Secure` on a connection
    // that deserved it, rather than one marked `Secure` on a connection that
    // did not.
    if (fromXfp !== undefined && fromRfc7239 !== undefined && fromXfp !== fromRfc7239) {
      return {
        scheme: 'http',
        source: 'CONFLICTING_PROXY_HEADERS',
        forwardingHeaderIgnored: true,
      };
    }

    // `X-Forwarded-Proto` first only because it is what every deployment in
    // front of Telga sends today; `Forwarded` is the standard and is believed
    // just as fully when it is the one that arrived.
    const claimed = fromXfp ?? fromRfc7239;
    if (claimed === 'https') {
      return { scheme: 'https', source: 'TRUSTED_PROXY_HEADER', forwardingHeaderIgnored: false };
    }
    return {
      scheme: 'http',
      source: 'TRUSTED_PROXY_HEADER',
      // A header arrived, was trusted, and named neither protocol — or named
      // something unparseable. It did not contribute to the answer, and a log
      // line saying so is how a broken proxy gets noticed.
      forwardingHeaderIgnored: claimed === undefined,
    };
  }

  return {
    scheme: 'http',
    source: 'DEFAULT_PLAINTEXT',
    forwardingHeaderIgnored: hasForwardingHeader,
  };
}

/**
 * Whether a cookie set on this request may be marked `Secure`.
 *
 * Derived from the **client's** scheme, not from how this process is listening.
 * Behind a terminator the process speaks HTTP while the client used HTTPS, and
 * the cookie must follow the client.
 */
export const cookieSecureFor = (config: TransportConfig, scheme: RequestScheme): boolean =>
  config.sessionCookieSecure && scheme.scheme === 'https';

// --- host and origin --------------------------------------------------------

export type HostRejection = 'HOST_MISSING' | 'HOST_NOT_ALLOWED' | 'ORIGIN_NOT_ALLOWED';

const hostWithoutPort = (value: string): string => {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    // IPv6 literal: `[::1]:4321`
    const close = trimmed.indexOf(']');
    return close === -1 ? trimmed : trimmed.slice(0, close + 1);
  }
  const colon = trimmed.lastIndexOf(':');
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
};

/**
 * Check the `Host` header against the allow-list.
 *
 * A forwarded host is honoured only from a trusted proxy, for the same reason
 * the protocol is.
 */
export function checkHost(config: TransportConfig, facts: ConnectionFacts): HostRejection | undefined {
  const trusted = fromTrustedProxy(config, facts.remoteAddress);
  const forwardedHost = trusted ? facts.headers[FORWARDED_HOST_HEADER] : undefined;
  const raw = forwardedHost ?? facts.headers['host'];
  if (typeof raw !== 'string' || raw.trim().length === 0) return 'HOST_MISSING';

  const host = hostWithoutPort(raw.split(',')[0] ?? '');
  const allowed = config.allowedHosts.map((h) => hostWithoutPort(h));
  return allowed.includes(host) ? undefined : 'HOST_NOT_ALLOWED';
}

/**
 * Check `Origin` on a state-changing request.
 *
 * Same-origin is always accepted, computed from the allow-list and the client's
 * scheme rather than from the request's own claims. A missing `Origin` is
 * **not** a refusal: plain form posts from older browsers omit it, and CSRF
 * tokens are the primary control — this is a second one.
 */
export function checkOrigin(
  config: TransportConfig,
  facts: ConnectionFacts,
  scheme: RequestScheme,
): HostRejection | undefined {
  const origin = facts.headers['origin'];
  if (typeof origin !== 'string' || origin.length === 0 || origin === 'null') return undefined;

  const permitted = new Set<string>(config.allowedOrigins.map((o) => o.trim().toLowerCase()));
  for (const host of config.allowedHosts) {
    permitted.add(`${scheme.scheme}://${host.trim().toLowerCase()}`);
    permitted.add(`${scheme.scheme}://${host.trim().toLowerCase()}:${String(config.bindPort)}`);
  }

  let normalized: string;
  try {
    const url = new URL(origin);
    normalized = `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return 'ORIGIN_NOT_ALLOWED';
  }

  if (permitted.has(normalized)) return undefined;
  // Also accept the host-only form, for a default-port origin.
  const withoutPort = normalized.replace(/:\d+$/, '');
  return permitted.has(withoutPort) ? undefined : 'ORIGIN_NOT_ALLOWED';
}

/** Methods that change state and therefore get the origin check. */
export const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
