/**
 * Deciding where the Android shell is allowed to connect.
 *
 * This is the security boundary of the whole app: it is the only thing standing
 * between a typed string and the address every subsequent request — including
 * the merchant's PIN and session cookie — is sent to.
 *
 * It lives in its own file rather than inline in `index.html` because logic
 * that decides that cannot be left untested, and script inline in a page cannot
 * be imported by a test. `tests/mobile/connect.test.ts` loads this file
 * directly, so what is verified is the same source the APK ships.
 *
 * Plain ES5-era script with no module syntax and no build step, matching the
 * rest of Telga: the page loads it with a `<script>` tag and the test reads it
 * off disk. Everything here is a pure function of its arguments.
 */

/* eslint-env browser */
(function (root) {
  'use strict';

  /**
   * Does this hostname match one of the patterns the WebView will open?
   *
   * The list comes from `shell.config.json`, the same file Capacitor is given
   * for `allowNavigation`. If this were more permissive than that list, the
   * screen would accept an address Capacitor then hands to the **system
   * browser** — putting PIN entry in a plain tab with no Telga chrome, which is
   * indistinguishable from a phishing page.
   *
   * Matching is on whole labels. `host.endsWith('telga.et')` would accept
   * `nottelga.et`, and `host.indexOf('telga.et') !== -1` would accept
   * `telga.et.evil.com` — both are real attacks and both are refused here.
   * `*.telga.et` matches a subdomain and deliberately does not match
   * `telga.et` itself; list the bare domain separately when it is wanted.
   */
  function hostAllowed(hostname, allowedHosts) {
    if (typeof hostname !== 'string' || hostname === '') return false;
    var host = hostname.toLowerCase();
    var list = allowedHosts || [];
    for (var i = 0; i < list.length; i += 1) {
      var pattern = String(list[i]).toLowerCase();
      if (pattern === host) return true;
      if (pattern.indexOf('*.') === 0) {
        var suffix = pattern.slice(1); // "*.telga.et" -> ".telga.et"
        if (host.length > suffix.length && host.slice(-suffix.length) === suffix) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Turn what a person typed into an origin, or explain why not.
   *
   * Returns `{ origin }` or `{ error }` — never both, and never a bare string,
   * so a caller cannot mistake a refusal for an address.
   *
   * The rules, and why each one is here:
   *
   * - **HTTPS only.** A merchant PIN and a session cookie travel over this
   *   connection and a shop's wi-fi is not a trusted network.
   * - **No credentials in the URL.** `https://real.telga.et@evil.example` reads
   *   as Telga to a hurried person at a counter and resolves to `evil.example`.
   * - **Host must be on the allow-list**, for the reason in `hostAllowed`.
   * - **The path is dropped.** The app always opens at `/launcher`; a pasted
   *   deep link would otherwise be saved and strand the merchant somewhere odd
   *   on every future launch.
   */
  function parseServer(raw, allowedHosts) {
    var text = String(raw == null ? '' : raw).trim();
    if (text === '') return { error: 'Enter the address. · አድራሻ ያስገቡ።' };

    // A person typing an address rarely types the scheme. Adding https (never
    // http) means the common case works without weakening the rule below.
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'https://' + text;

    var url;
    try {
      url = new URL(text);
    } catch (e) {
      return { error: 'That is not a valid address. · ትክክለኛ አድራሻ አይደለም።' };
    }

    if (url.protocol !== 'https:') {
      return { error: 'Only https:// addresses are allowed. · https:// ብቻ ይፈቀዳል።' };
    }
    if (url.username !== '' || url.password !== '') {
      return { error: 'That address is not allowed. · ይህ አድራሻ አይፈቀድም።' };
    }
    if (url.hostname === '') {
      return { error: 'That is not a valid address. · ትክክለኛ አድራሻ አይደለም።' };
    }
    if (!hostAllowed(url.hostname, allowedHosts)) {
      // Naming the allowed hosts turns "it does not work" into something a
      // merchant can read down the phone to support.
      return {
        error:
          'This app connects only to: ' +
          (allowedHosts || []).join(', ') +
          '. · ይህ መተግበሪያ ወደ እነዚህ ብቻ ይገናኛል።',
      };
    }
    return { origin: url.origin };
  }

  root.TelgaConnect = { hostAllowed: hostAllowed, parseServer: parseServer };
})(typeof globalThis !== 'undefined' ? globalThis : this);
