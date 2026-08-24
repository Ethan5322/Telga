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
import { externalScheme } from './config';

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
  readonly source: 'TLS_SOCKET' | 'TRUSTED_PROXY_HEADER' | 'DEFAULT_PLAINTEXT';
  /** True when a forwarding header was present but not believed. */
  readonly forwardingHeaderIgnored: boolean;
}

/** Strip an IPv6-mapped IPv4 prefix so `::ffff:127.0.0.1` compares as `127.0.0.1`. */
export function normalizeAddress(address: string | undefined): string {
  if (!address) return '';
  const trimmed = address.trim().toLowerCase();
  if (trimmed.startsWith('::ffff:')) return trimmed.slice(7);
  return trimmed;
}

/** Whether this connection came from a configured trusted proxy. */
export function fromTrustedProxy(config: TransportConfig, remoteAddress: string | undefined): boolean {
  if (config.trustProxy === false) return false;
  const normalized = normalizeAddress(remoteAddress);
  if (normalized.length === 0) return false;
  return config.trustProxy.some((trusted) => normalizeAddress(trusted) === normalized);
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
    const claimed = (forwarded ?? '').split(',')[0]?.trim().toLowerCase();
    if (claimed === 'https') {
      return { scheme: 'https', source: 'TRUSTED_PROXY_HEADER', forwardingHeaderIgnored: false };
    }
    return { scheme: 'http', source: 'TRUSTED_PROXY_HEADER', forwardingHeaderIgnored: false };
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
