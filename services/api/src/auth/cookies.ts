/**
 * Cookie handling.
 *
 * Small and hand-written because the whole surface is two cookies, and a
 * dependency for that would be a supply-chain question asked to save twenty
 * lines.
 *
 * ## The attributes, and why each one
 *
 *   `HttpOnly`  the session token is unreadable from JavaScript, so an injected
 *               script cannot exfiltrate it. This is why authentication state
 *               is never trusted from client-side script: the script cannot see
 *               it, by design.
 *   `SameSite=Strict`  the cookie is not sent on a cross-site request at all,
 *               which stops a cross-origin form post from carrying a session.
 *               The CSRF token is a second lock, not a replacement.
 *   `Secure`    set only when the deployment states it serves HTTPS. Claiming
 *               it over plain HTTP would make a browser drop the cookie and
 *               break sign-in, so it is configured rather than assumed.
 *   `Path=/`    one session for the whole POS.
 *
 * There is **no `Max-Age`**. The session is a server-side row with its own two
 * expiries; a browser-side lifetime would be a second, weaker opinion about
 * when a session ends, and the one that a client controls.
 */

export const SESSION_COOKIE = 'telga_session';
/**
 * The CSRF cookie is deliberately **not** `HttpOnly`.
 *
 * It is not a credential: on its own it authorises nothing, because every write
 * also requires the session cookie and the server compares the submitted token
 * against the hash bound to that session. Leaving it readable lets a page
 * re-read it after a redirect without a round trip.
 */
export const CSRF_COOKIE = 'telga_csrf';

/** The form field a browser submits the CSRF token in. */
export const CSRF_FIELD = 'csrfToken';
/** The header an XHR submits it in. */
export const CSRF_HEADER = 'x-telga-csrf';

export interface CookieOptions {
  readonly secure: boolean;
  readonly httpOnly?: boolean;
  readonly sameSite?: 'Strict' | 'Lax';
  readonly maxAgeSeconds?: number;
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/'];
  if (options.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${options.sameSite ?? 'Strict'}`);
  if (options.secure) parts.push('Secure');
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${String(options.maxAgeSeconds)}`);
  return parts.join('; ');
}

/** An expired cookie, which is how a sign-out clears one. */
export function clearCookie(name: string, options: CookieOptions): string {
  const parts = [`${name}=`, 'Path=/', 'Max-Age=0'];
  if (options.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${options.sameSite ?? 'Strict'}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Parse a `Cookie` header.
 *
 * Tolerant of whitespace and of a value containing `=`; silent about anything
 * malformed, because a broken cookie header is a reason to be unauthenticated,
 * not a reason to fail a request with a parse error.
 */
export function parseCookies(header: string | undefined): Readonly<Record<string, string>> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (name.length === 0) continue;
    try {
      out[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // A value that is not valid percent-encoding is ignored rather than
      // throwing: it cannot be the cookie we issued.
    }
  }
  return out;
}
