/**
 * Security headers.
 *
 * ## The CSP, and why it stopped saying `unsafe-inline`
 *
 * The first version of this app shipped `script-src 'unsafe-inline'` and
 * `style-src 'unsafe-inline'`, because the page carries one inline script and
 * one inline stylesheet and that was the quick way to make them run. It is also
 * a policy that permits **any** injected inline script, which is most of what a
 * CSP exists to stop.
 *
 * The page now carries a **per-response nonce**. The script and the style each
 * declare it; the policy allows that nonce and nothing else inline. An injected
 * `<script>` has no nonce and does not run, and it cannot read one, because a
 * fresh 128-bit value is generated for every response.
 *
 * `'strict-dynamic'` is deliberately absent: nothing here loads a script that
 * loads another script, and adding it would widen the policy for no gain.
 */

import { randomBytes } from 'node:crypto';
import type { TransportConfig } from './config';
import type { RequestScheme } from './proxy';

/**
 * A fresh nonce per response. Never reused, never derived from anything.
 *
 * ## Why hex and not base64
 *
 * Same 128 bits either way, and both are valid in a CSP `nonce-` source. Hex is
 * chosen for one reason: **base64 spells words.**
 *
 * `tests/ui/server.test.ts` refuses any page containing
 * `/salt|secret|credential|api[_-]?key/i` — a deliberately broad guard against a
 * secret reaching a rendered page. A random base64 nonce contains `salt`, in
 * some mixture of cases, about **once in every 52,600 values**: `3fxsaLtMae…`,
 * `lwSc06vBSaltm5…`. With sixteen pages rendered per run that is roughly one run
 * in three thousand, which is exactly the shape of a failure nobody can
 * reproduce — it failed once in a full suite and passed twelve times in
 * isolation.
 *
 * The guard is right and stays untouched: it cannot know which letter-run is
 * innocent, and a version that could is a version that misses a real leak. So
 * the nonce stops being able to spell the words instead. Hex is `0-9a-f`, which
 * contains no `s`, `l`, `t`, `r`, `u`, `i`, `p`, `k` or `y` — none of the
 * guarded words can be written in it at all.
 *
 * This is the second time a broad secret-guard has fired on an innocent value
 * and the answer was to change the value rather than the guard; see the idle
 * window, published in seconds because milliseconds made a six-digit number.
 */
export const newNonce = (): string => randomBytes(16).toString('hex');

export interface HeaderOptions {
  readonly config: TransportConfig;
  readonly scheme: RequestScheme;
  /** Present for an HTML response; absent for JSON, which runs no script. */
  readonly nonce?: string;
  /** True for anything that carries or depends on a session. */
  readonly sessionSensitive: boolean;
}

/**
 * The policy for an HTML page.
 *
 * `default-src 'none'` and then only what the page actually uses. The POS loads
 * no remote script, no remote style, no font, no image and no frame, so almost
 * everything stays off.
 */
export function contentSecurityPolicy(nonce: string | undefined): string {
  const scriptSrc = nonce === undefined ? "'none'" : `'nonce-${nonce}'`;
  const styleSrc = nonce === undefined ? "'none'" : `'nonce-${nonce}'`;
  return [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    "img-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    // Frame protection. `frame-ancestors` supersedes X-Frame-Options in every
    // browser this would run on, and unlike that header it is not ignored in a
    // `<meta>` tag context.
    "frame-ancestors 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "worker-src 'none'",
  ].join('; ');
}

/**
 * Features the POS never uses, switched off explicitly.
 *
 * A counter screen that sells airtime has no business asking for a camera or a
 * location, and an injected script on the page should not be able to either.
 */
export const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'camera=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'payment=()',
  'usb=()',
  'interest-cohort=()',
].join(', ');

/**
 * Build the header set for one response.
 *
 * `Cache-Control: no-store` on anything session-sensitive: a POS is a shared
 * machine, and a back button that re-renders the previous operator's balance
 * from cache is a real leak on a shop counter.
 */
export function securityHeaders(options: HeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'content-security-policy': contentSecurityPolicy(options.nonce),
    'x-content-type-options': 'nosniff',
    /**
     * `same-origin`, not `no-referrer`. See the console's copy of this header
     * for the full story; the short version is that `no-referrer` makes a
     * browser send `Origin: null` on a form POST, which turns an origin check
     * into a lockout.
     *
     * The POS never showed the symptom because `checkOrigin` lets `null`
     * through unconditionally — a blanket allowance that also lets a **sandboxed
     * iframe** post to it. Removing the cause here is what makes tightening that
     * allowance safe to do later, on real hardware, rather than blind.
     *
     * The privacy property is unchanged: no referrer leaves this origin.
     */
    'referrer-policy': 'same-origin',
    'permissions-policy': PERMISSIONS_POLICY,
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  };

  if (options.sessionSensitive) {
    headers['cache-control'] = 'no-store, no-cache, must-revalidate, private';
    headers['pragma'] = 'no-cache';
    headers['expires'] = '0';
  }

  // HSTS only when it was asked for **and** the client actually used HTTPS.
  // Sending it over HTTP is ignored by browsers, and sending it from a
  // deployment that still needs an HTTP fallback would lock operators out of
  // their own training machine for the length of the max-age.
  if (options.config.hstsEnabled && options.scheme.scheme === 'https') {
    headers['strict-transport-security'] = `max-age=${String(options.config.hstsMaxAgeSeconds)}`;
  }

  return headers;
}

/** The headers required on every authenticated POS response. Used by the tests. */
export const REQUIRED_HEADERS: readonly string[] = Object.freeze([
  'content-security-policy',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'cache-control',
]);
