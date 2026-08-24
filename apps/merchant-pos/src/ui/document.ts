/**
 * The HTML document wrapper.
 *
 * Inline styles and an inline script, because a POS on a shop counter should
 * render from one response rather than three, and because this app has no
 * bundler by design. Both are small enough to read.
 *
 * ## The nonce
 *
 * The script and the style each carry a **per-response nonce**, and the policy
 * allows that nonce and nothing else inline. This replaced `'unsafe-inline'`,
 * which permitted any injected inline script — most of what a CSP exists to
 * stop. An injected `<script>` has no nonce, so it does not run, and it cannot
 * read one, because a fresh value is generated for every response.
 *
 * The policy is emitted as a header **and** as a `<meta>` tag, so it travels
 * with a saved page. `frame-ancestors` works only from the header, which is why
 * the header is the authority and the tag is the copy.
 */

import { escapeText } from './element';
import type { Chrome } from './chrome';
import { contentSecurityPolicy } from '../transport/headers';

/**
 * Progressive enhancement only.
 *
 * The page is complete without this. All it does is re-request the current
 * transaction while it is still in flight and reload when the state changes, so
 * an operator watching the screen sees the settlement without pressing refresh.
 * `data-poll-interval` comes from the server's own recovery policy.
 */
const CLIENT_SCRIPT = `
(function () {
  var root = document.querySelector('[data-poll-transaction]');
  if (!root) return;
  var id = root.getAttribute('data-poll-transaction');
  var merchant = root.getAttribute('data-poll-merchant');
  var interval = parseInt(root.getAttribute('data-poll-interval') || '30000', 10);
  var remaining = parseInt(root.getAttribute('data-poll-max') || '0', 10);
  var state = root.getAttribute('data-poll-state');
  if (!id || !merchant || remaining <= 0) return;
  function check() {
    if (remaining-- <= 0) return;
    fetch('/api/training/transactions/' + encodeURIComponent(id) + '?merchantId=' + encodeURIComponent(merchant), {
      headers: { accept: 'application/json' }
    }).then(function (r) { return r.json(); }).then(function (body) {
      if (body && body.ok && body.data && body.data.state !== state) { window.location.reload(); return; }
      setTimeout(check, interval);
    }).catch(function () { setTimeout(check, interval); });
  }
  setTimeout(check, interval);
})();
`;

const STYLES = `
:root { color-scheme: light dark; --gap: 0.75rem; }
body { font-family: system-ui, "Noto Sans Ethiopic", sans-serif; margin: 0; line-height: 1.5; font-size: 1.05rem; }
.pos { max-width: 44rem; margin: 0 auto; padding: var(--gap); }
.banner--training { border: 3px solid currentColor; padding: var(--gap); display: flex; flex-direction: column; gap: 0.25rem; font-weight: 600; }
.banner__detail, .banner__warning { font-weight: 400; font-size: 0.9rem; }
main { padding-block: var(--gap); }
h1 { font-size: 1.4rem; }
h2 { font-size: 1.1rem; margin-block: var(--gap) 0.25rem; }
section { border-top: 1px solid currentColor; padding-block: var(--gap); }
.instruction--urgent { font-weight: 700; border: 2px solid currentColor; padding: var(--gap); }
.status__headline { font-size: 1.2rem; font-weight: 600; }
[data-tone="POSITIVE"] { --tone: #0b6b34; }
[data-tone="NEGATIVE"] { --tone: #8a1c1c; }
[data-tone="CAUTION"] { --tone: #8a5a00; }
[data-tone="PROGRESS"] { --tone: #17416b; }
[data-tone] .status__headline, [data-tone].banner--training { color: var(--tone, inherit); }
ul.actions { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: var(--gap); }
a, button { min-height: 3rem; min-width: 3rem; padding: 0.75rem 1rem; display: inline-flex; align-items: center; }
button { font: inherit; border: 2px solid currentColor; background: transparent; cursor: pointer; }
:focus-visible { outline: 3px solid currentColor; outline-offset: 2px; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: start; padding: 0.5rem; border-bottom: 1px solid currentColor; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 0.25rem var(--gap); }
dt { font-weight: 600; }
dd { margin: 0; }
.pos__nav { display: flex; gap: var(--gap); flex-wrap: wrap; }
[aria-current="page"] { font-weight: 700; text-decoration-thickness: 3px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;

/**
 * Wrap rendered screen markup in a complete document.
 *
 * `nonce` is required. There is no overload that omits it, because a page
 * rendered without one would silently lose its script and its stylesheet under
 * the policy, and the failure would look like a CSS bug rather than a missing
 * argument.
 */
export function htmlDocument(bodyHtml: string, chrome: Chrome, nonce: string): string {
  const csp = contentSecurityPolicy(nonce);
  const n = escapeText(nonce);
  return [
    '<!doctype html>',
    `<html lang="${escapeText(chrome.locale)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="content-security-policy" content="${escapeText(csp)}">`,
    '<meta name="robots" content="noindex, nofollow">',
    `<title>Telga POS — ${escapeText(chrome.mode)} — no real value</title>`,
    `<style nonce="${n}">${STYLES}</style>`,
    '</head>',
    '<body>',
    bodyHtml,
    `<script nonce="${n}">${CLIENT_SCRIPT}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

export { CLIENT_SCRIPT };
