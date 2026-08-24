/**
 * Transport configuration validation.
 *
 * Every test here is a refusal. That is the point: the value of this layer is
 * not that a correct configuration starts, it is that an unsafe one **does not**
 * — before a socket is opened, with a stable reason code the CLI turns into
 * exit 4.
 */

import { describe, expect, it } from 'vitest';
import {
  LOCAL_HTTP_DEFAULTS,
  TransportConfigError,
  externalScheme,
  isLoopbackHost,
  terminatesTlsItself,
  validateTransport,
} from '@telga/merchant-pos';
import type { TransportConfig } from '@telga/merchant-pos';

const httpsBase: TransportConfig = {
  trainingTransport: 'HTTPS',
  bindHost: '0.0.0.0',
  bindPort: 8443,
  trustProxy: false,
  tlsTermination: 'IN_PROCESS',
  tlsCertificatePath: '/tmp/cert.pem',
  tlsPrivateKeyPath: '/tmp/key.pem',
  allowedHosts: ['telga-training.localhost'],
  allowedOrigins: [],
  sessionCookieSecure: true,
  hstsEnabled: false,
  hstsMaxAgeSeconds: 0,
  gracefulShutdownTimeoutMs: 10_000,
};

function reasonOf(config: TransportConfig): string {
  try {
    validateTransport(config);
  } catch (error) {
    if (error instanceof TransportConfigError) return error.reasonCode;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('the safe default', () => {
  it('is loopback plain HTTP, trusting nothing', () => {
    expect(LOCAL_HTTP_DEFAULTS.trainingTransport).toBe('HTTP_LOCAL');
    expect(isLoopbackHost(LOCAL_HTTP_DEFAULTS.bindHost)).toBe(true);
    expect(LOCAL_HTTP_DEFAULTS.trustProxy).toBe(false);
    expect(LOCAL_HTTP_DEFAULTS.sessionCookieSecure).toBe(false);
    expect(LOCAL_HTTP_DEFAULTS.hstsEnabled).toBe(false);
    expect(() => validateTransport(LOCAL_HTTP_DEFAULTS)).not.toThrow();
  });

  it('recognises every loopback spelling', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', 'LOCALHOST', ' 127.0.0.1 ']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ['0.0.0.0', '192.168.1.10', 'telga.example']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe('plain HTTP', () => {
  it('refuses to bind anywhere but loopback', () => {
    // The entire safety argument for plain HTTP is that nobody else can reach
    // it. A LAN binding removes the argument, so this is a refusal, not a warning.
    expect(reasonOf({ ...LOCAL_HTTP_DEFAULTS, bindHost: '0.0.0.0' })).toBe('HTTP_MUST_BE_LOOPBACK');
    expect(reasonOf({ ...LOCAL_HTTP_DEFAULTS, bindHost: '192.168.1.10' })).toBe(
      'HTTP_MUST_BE_LOOPBACK',
    );
  });

  it('refuses Secure cookies, which a browser would never send back', () => {
    expect(reasonOf({ ...LOCAL_HTTP_DEFAULTS, sessionCookieSecure: true })).toBe(
      'SECURE_COOKIE_ON_HTTP',
    );
  });

  it('refuses HSTS', () => {
    expect(reasonOf({ ...LOCAL_HTTP_DEFAULTS, hstsEnabled: true, hstsMaxAgeSeconds: 100 })).toBe(
      'HSTS_ON_HTTP',
    );
  });

  it('refuses to trust a proxy it does not have', () => {
    expect(reasonOf({ ...LOCAL_HTTP_DEFAULTS, trustProxy: ['127.0.0.1'] })).toBe(
      'PROXY_TRUST_ON_LOCAL_HTTP',
    );
  });
});

describe('HTTPS terminated in this process', () => {
  it('accepts a complete configuration', () => {
    expect(() => validateTransport(httpsBase)).not.toThrow();
    expect(terminatesTlsItself(httpsBase)).toBe(true);
    expect(externalScheme(httpsBase)).toBe('https');
  });

  it('requires a certificate', () => {
    expect(reasonOf({ ...httpsBase, tlsCertificatePath: undefined })).toBe(
      'TLS_CERTIFICATE_REQUIRED',
    );
    expect(reasonOf({ ...httpsBase, tlsCertificatePath: '   ' })).toBe('TLS_CERTIFICATE_REQUIRED');
  });

  it('requires a private key', () => {
    expect(reasonOf({ ...httpsBase, tlsPrivateKeyPath: undefined })).toBe(
      'TLS_PRIVATE_KEY_REQUIRED',
    );
  });

  it('requires Secure cookies', () => {
    expect(reasonOf({ ...httpsBase, sessionCookieSecure: false })).toBe(
      'SECURE_COOKIE_REQUIRED_ON_HTTPS',
    );
  });

  it('refuses to trust forwarding headers when there is no proxy', () => {
    // TLS ends here, so nothing upstream could have set a forwarding header
    // honestly. Believing one would only ever help an attacker.
    expect(reasonOf({ ...httpsBase, trustProxy: ['10.0.0.1'] })).toBe('PROXY_TRUST_WITHOUT_PROXY');
  });

  it('requires a positive HSTS max-age when HSTS is on', () => {
    expect(reasonOf({ ...httpsBase, hstsEnabled: true, hstsMaxAgeSeconds: 0 })).toBe(
      'HSTS_MAX_AGE_INVALID',
    );
    expect(() =>
      validateTransport({ ...httpsBase, hstsEnabled: true, hstsMaxAgeSeconds: 15_552_000 }),
    ).not.toThrow();
  });

  it('requires an allowed-host list', () => {
    expect(reasonOf({ ...httpsBase, allowedHosts: [] })).toBe('ALLOWED_HOSTS_REQUIRED');
  });
});

describe('HTTPS terminated by a proxy', () => {
  const proxied: TransportConfig = {
    ...httpsBase,
    tlsTermination: 'TRUSTED_PROXY',
    tlsCertificatePath: undefined,
    tlsPrivateKeyPath: undefined,
    bindHost: '127.0.0.1',
    trustProxy: ['127.0.0.1'],
  };

  it('accepts an explicit trusted-proxy list', () => {
    expect(() => validateTransport(proxied)).not.toThrow();
    expect(terminatesTlsItself(proxied)).toBe(false);
    // The client used HTTPS even though this process listens on HTTP.
    expect(externalScheme(proxied)).toBe('https');
  });

  it('refuses to run without one', () => {
    // Without a list, a forwarded-protocol header from *any* client would be
    // believed — which is the whole vulnerability.
    expect(reasonOf({ ...proxied, trustProxy: false })).toBe('PROXY_TRUST_REQUIRED');
    expect(reasonOf({ ...proxied, trustProxy: [] })).toBe('PROXY_TRUST_REQUIRED');
  });

  it('refuses to also hold TLS material', () => {
    expect(reasonOf({ ...proxied, tlsCertificatePath: '/tmp/cert.pem' })).toBe(
      'TLS_MATERIAL_WITH_PROXY',
    );
    expect(reasonOf({ ...proxied, tlsPrivateKeyPath: '/tmp/key.pem' })).toBe(
      'TLS_MATERIAL_WITH_PROXY',
    );
  });
});

describe('basic bounds', () => {
  it('refuses an impossible port', () => {
    for (const port of [-1, 70_000, 1.5]) {
      expect(reasonOf({ ...LOCAL_HTTP_DEFAULTS, bindPort: port }), String(port)).toBe(
        'BIND_PORT_INVALID',
      );
    }
  });

  it('accepts port 0, which asks the operating system to choose', () => {
    // What an ephemeral test listener needs. The startup banner prints the port
    // actually bound rather than this one.
    expect(() => validateTransport({ ...LOCAL_HTTP_DEFAULTS, bindPort: 0 })).not.toThrow();
  });

  it('refuses a negative shutdown timeout', () => {
    expect(reasonOf({ ...LOCAL_HTTP_DEFAULTS, gracefulShutdownTimeoutMs: -1 })).toBe(
      'SHUTDOWN_TIMEOUT_INVALID',
    );
  });
});

describe('what a refusal says', () => {
  it('carries a stable code and never a secret', () => {
    try {
      validateTransport({ ...httpsBase, tlsPrivateKeyPath: undefined });
    } catch (error) {
      const e = error as TransportConfigError;
      expect(e).toBeInstanceOf(TransportConfigError);
      expect(e.code).toBe('POS_INVALID_TRANSPORT_CONFIG');
      expect(e.reasonCode).toBe('TLS_PRIVATE_KEY_REQUIRED');
      expect(e.message).not.toContain('BEGIN');
      expect(e.message).not.toContain('PRIVATE KEY');
    }
  });
});
