/**
 * Transport configuration for the training deployment.
 *
 * Every setting is explicit and every unsafe combination is refused at startup.
 * There is **no silent default that becomes a production posture**: the only
 * default is the safest one — loopback-bound plain HTTP for local development —
 * and choosing anything else means saying so.
 *
 * ## The three modes
 *
 *   `HTTP_LOCAL`  loopback only, for development. Cookies are not `Secure`,
 *                 because claiming it over HTTP makes a browser drop them and
 *                 sign-in stops working. Binding this to a LAN address is
 *                 **refused**, not warned about.
 *   `HTTPS`       the controlled training deployment. TLS is terminated either
 *                 by this process from explicit certificate paths, or by a
 *                 documented trusted proxy in front of it.
 *   `LIVE`        rejected everywhere, before a database is opened.
 *
 * ## What this file will not do
 *
 * It will not generate a certificate, will not write a key, and will not read a
 * secret out of the repository. TLS material is supplied by path, by whoever is
 * running the deployment. See `09 Engineering/Local Certificate Handling.md`.
 */

/** How the training deployment is reached. */
export type TrainingTransport = 'HTTP_LOCAL' | 'HTTPS';

/** Where TLS is terminated, when the transport is HTTPS. */
export type TlsTermination = 'IN_PROCESS' | 'TRUSTED_PROXY';

export interface TransportConfig {
  readonly trainingTransport: TrainingTransport;
  readonly bindHost: string;
  readonly bindPort: number;
  /**
   * Whether a forwarded-protocol header may be believed, and from where.
   *
   * `false` means no forwarding header is ever trusted. An address list means
   * the header is believed **only** when the connection came from one of those
   * addresses. There is no "trust everything" setting: that is how a spoofed
   * `X-Forwarded-Proto` turns a plain HTTP request into one the server thinks
   * is secure, and marks a cookie `Secure` that then never comes back.
   */
  readonly trustProxy: false | readonly string[];
  readonly tlsTermination: TlsTermination;
  readonly tlsCertificatePath?: string;
  readonly tlsPrivateKeyPath?: string;
  /** Hosts the server will answer for. A `Host` outside this list is refused. */
  readonly allowedHosts: readonly string[];
  /** Origins accepted on a state-changing request. Same-origin by default. */
  readonly allowedOrigins: readonly string[];
  readonly sessionCookieSecure: boolean;
  readonly hstsEnabled: boolean;
  readonly hstsMaxAgeSeconds: number;
  readonly gracefulShutdownTimeoutMs: number;
}

export class TransportConfigError extends Error {
  readonly code = 'POS_INVALID_TRANSPORT_CONFIG';
  constructor(
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'TransportConfigError';
  }
}

/** Addresses that are unambiguously the local machine. */
export const LOOPBACK_HOSTS: readonly string[] = Object.freeze([
  '127.0.0.1',
  '::1',
  'localhost',
  '[::1]',
]);

export const isLoopbackHost = (host: string): boolean =>
  LOOPBACK_HOSTS.includes(host.trim().toLowerCase());

/**
 * The development default: loopback, plain HTTP, nothing trusted.
 *
 * Safe because it is unreachable from anywhere but this machine. It is **not**
 * a training deployment posture — `TRAINING_HTTPS` is.
 */
export const LOCAL_HTTP_DEFAULTS: TransportConfig = Object.freeze({
  trainingTransport: 'HTTP_LOCAL',
  bindHost: '127.0.0.1',
  bindPort: 4321,
  trustProxy: false,
  tlsTermination: 'IN_PROCESS',
  allowedHosts: Object.freeze(['localhost', '127.0.0.1']),
  allowedOrigins: Object.freeze([]),
  sessionCookieSecure: false,
  hstsEnabled: false,
  hstsMaxAgeSeconds: 0,
  gracefulShutdownTimeoutMs: 10_000,
});

/**
 * Validate a transport configuration.
 *
 * Throws `TransportConfigError` with a stable `reasonCode`. The CLI turns that
 * into **exit 4**, matching the worker's convention for an invalid
 * configuration.
 *
 * A private key path may appear in a message; **its contents never do**, and
 * nothing here reads a key in order to complain about it.
 */
export function validateTransport(config: TransportConfig): void {
  // Port 0 is legitimate: it asks the operating system for an ephemeral port,
  // which is what a test listener wants and what a supervised deployment may
  // use. The startup banner prints the port actually bound, not this one.
  if (!Number.isInteger(config.bindPort) || config.bindPort < 0 || config.bindPort > 65_535) {
    throw new TransportConfigError(
      'BIND_PORT_INVALID',
      'The bind port must be 0 (choose one) or a valid TCP port',
    );
  }

  if (config.gracefulShutdownTimeoutMs < 0) {
    throw new TransportConfigError(
      'SHUTDOWN_TIMEOUT_INVALID',
      'The graceful shutdown timeout cannot be negative',
    );
  }

  if (config.trainingTransport === 'HTTP_LOCAL') {
    // The whole safety argument for plain HTTP is that nobody else can reach
    // it. A LAN binding removes that argument entirely, so it is refused
    // rather than warned about.
    if (!isLoopbackHost(config.bindHost)) {
      throw new TransportConfigError(
        'HTTP_MUST_BE_LOOPBACK',
        `Plain HTTP training mode may bind only to loopback; refusing "${config.bindHost}". ` +
          'Use --transport HTTPS to serve anything beyond this machine.',
      );
    }
    if (config.sessionCookieSecure) {
      // A `Secure` cookie is never sent over HTTP, so the operator would sign
      // in and immediately appear signed out. Refusing beats debugging that.
      throw new TransportConfigError(
        'SECURE_COOKIE_ON_HTTP',
        'Secure cookies cannot be used over plain HTTP: the browser would never send them back',
      );
    }
    if (config.hstsEnabled) {
      throw new TransportConfigError(
        'HSTS_ON_HTTP',
        'HSTS cannot be enabled on a plain HTTP deployment',
      );
    }
    if (config.trustProxy !== false) {
      throw new TransportConfigError(
        'PROXY_TRUST_ON_LOCAL_HTTP',
        'A loopback development server sits behind no proxy; refusing to trust forwarding headers',
      );
    }
    return;
  }

  // --- HTTPS ---------------------------------------------------------------
  if (!config.sessionCookieSecure) {
    throw new TransportConfigError(
      'SECURE_COOKIE_REQUIRED_ON_HTTPS',
      'Session cookies must be marked Secure when the deployment serves HTTPS',
    );
  }

  if (config.tlsTermination === 'IN_PROCESS') {
    if (!config.tlsCertificatePath || config.tlsCertificatePath.trim().length === 0) {
      throw new TransportConfigError(
        'TLS_CERTIFICATE_REQUIRED',
        'Standalone HTTPS requires --tls-cert. Telga never generates a certificate for you',
      );
    }
    if (!config.tlsPrivateKeyPath || config.tlsPrivateKeyPath.trim().length === 0) {
      throw new TransportConfigError(
        'TLS_PRIVATE_KEY_REQUIRED',
        'Standalone HTTPS requires --tls-key. Telga never generates a private key for you',
      );
    }
    if (config.trustProxy !== false) {
      throw new TransportConfigError(
        'PROXY_TRUST_WITHOUT_PROXY',
        'TLS is terminated in this process, so there is no proxy whose headers could be trusted',
      );
    }
  } else {
    // TRUSTED_PROXY: this process speaks HTTP to the proxy, and the proxy tells
    // it what the client actually used. That is only safe if the process knows
    // which addresses the proxy speaks from.
    if (config.trustProxy === false || config.trustProxy.length === 0) {
      throw new TransportConfigError(
        'PROXY_TRUST_REQUIRED',
        'TLS terminated by a proxy requires an explicit --trust-proxy address list. ' +
          'Without one a forwarded-protocol header from any client would be believed',
      );
    }
    if (config.tlsCertificatePath || config.tlsPrivateKeyPath) {
      throw new TransportConfigError(
        'TLS_MATERIAL_WITH_PROXY',
        'TLS is terminated by the proxy; this process must not be given a certificate or key',
      );
    }
    if (!isLoopbackHost(config.bindHost) && (config.trustProxy as readonly string[]).length === 0) {
      throw new TransportConfigError(
        'PROXY_BIND_UNSAFE',
        'A proxied deployment bound beyond loopback needs an explicit trusted-proxy list',
      );
    }
  }

  if (config.hstsEnabled && config.hstsMaxAgeSeconds <= 0) {
    throw new TransportConfigError(
      'HSTS_MAX_AGE_INVALID',
      'HSTS requires a positive max-age; a zero max-age tells a browser to forget the policy',
    );
  }

  if (config.allowedHosts.length === 0) {
    throw new TransportConfigError(
      'ALLOWED_HOSTS_REQUIRED',
      'An HTTPS deployment must state which hosts it answers for',
    );
  }
}

/**
 * The externally visible scheme.
 *
 * Not the same as how *this process* is listening: behind a terminator the
 * process speaks HTTP while the client used HTTPS, and the cookie policy has to
 * follow the client's view.
 */
export const externalScheme = (config: TransportConfig): 'http' | 'https' =>
  config.trainingTransport === 'HTTPS' ? 'https' : 'http';

/** True when this process must open a TLS listener itself. */
export const terminatesTlsItself = (config: TransportConfig): boolean =>
  config.trainingTransport === 'HTTPS' && config.tlsTermination === 'IN_PROCESS';
