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
/**
 * The enrolled device **identifier**, remembered between sessions.
 *
 * Not a secret and never treated as one: it authenticates nothing on its own,
 * and a sign-in still requires the device key and the operator PIN. It exists
 * so an idle timeout returns the operator to a form that already knows which
 * device this is, instead of making them retype it every minute.
 *
 * **The device key is never stored in a cookie, in storage, or anywhere on
 * the client.** It is shown once at provisioning and hashed on the server.
 *
 * Deliberately outlives both an idle expiry and an explicit logout — clearing
 * it would be a device un-enrolment by the back door, and un-enrolment is a
 * separate, explicit administrative action (`revokeDevice`).
 */
export const DEVICE_COOKIE = 'telga_device';

/**
 * The enrolled device **key**, remembered between sessions.
 *
 * ## This is a deliberate, founder-requested relaxation
 *
 * The comment above still describes the safer position, and it was the
 * position until the founder specified the training sign-in model directly:
 * an idle timeout must cost the operator their **PIN only**, and a device
 * restart must cost them their operator id and PIN — never the device key.
 * Meeting that means the key has to be remembered somewhere, and a
 * `httpOnly` cookie is the least-bad somewhere: script on the page cannot
 * read it, it never reaches `localStorage`, and it is sent back only to the
 * login handler that prefills the field.
 *
 * ## What it costs
 *
 * Possession of the browser profile becomes possession of the device key.
 * The key stops being a second factor beside the session and becomes part of
 * what the device *is*. That is a real reduction and is recorded as such in
 * `ASSUMPTIONS.md` and the Decision Log rather than buried here.
 *
 * ## What still holds
 *
 * The PIN is never stored, anywhere, in any form. Sign-out from Settings
 * clears this cookie along with everything else, which is the escape hatch
 * for a device changing hands. Device revocation remains a separate
 * server-side action that no cookie can undo.
 */
export const DEVICE_KEY_COOKIE = 'telga_device_key';

/**
 * The operator id, remembered for the life of the **browser session only**.
 *
 * Written without a `Max-Age`, which is what makes the founder's two cases
 * differ without any extra logic: an idle timeout leaves the browser open, so
 * this survives and the operator re-enters a PIN alone; closing or restarting
 * the app drops it, so the next sign-in asks which operator as well.
 *
 * An operator id is not a secret — it is a name on a shift rota — and it
 * authenticates nothing on its own.
 */
export const OPERATOR_COOKIE = 'telga_operator';

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
