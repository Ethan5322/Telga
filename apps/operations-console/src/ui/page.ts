/**
 * The console's shell.
 *
 * ## Why it looks nothing like the POS
 *
 * A Telga employee suspending a merchant and a shop assistant selling airtime
 * must never be one keystroke from thinking they are in the other application.
 * So this shell is deliberately different at a glance: a dark slate ground
 * rather than the POS teal, a permanent header naming the console and the
 * signed-in admin, and no merchant chrome anywhere.
 *
 * It is a separate application, not a section of the POS — see
 * `09 Engineering/Admin Operations Console`.
 *
 * ## Markup, not a framework
 *
 * Same reason the POS renders server-side: one response, no bundler, and every
 * screen readable as a function. The console has fewer users and higher stakes,
 * which is an argument for less machinery rather than more.
 */

export interface Attributes {
  readonly [key: string]: string | number | boolean | undefined;
}

export interface El {
  readonly tag: string;
  readonly attrs: Attributes;
  readonly children: readonly Node[];
}

export type Node = El | string;

export function h(
  tag: string,
  attrs: Attributes = {},
  ...children: ReadonlyArray<Node | false | null | undefined>
): El {
  return {
    tag,
    attrs,
    children: children.filter((c): c is Node => c !== false && c != null),
  };
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);

/** The five characters that turn text into markup. */
export function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function render(node: Node): string {
  if (typeof node === 'string') return escapeText(node);
  const attrs = Object.entries(node.attrs)
    .filter(([, v]) => v !== undefined && v !== false)
    .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${escapeText(String(v))}"`))
    .join('');
  if (VOID_TAGS.has(node.tag)) return `<${node.tag}${attrs}>`;
  return `<${node.tag}${attrs}>${node.children.map(render).join('')}</${node.tag}>`;
}

export interface ConsoleChrome {
  /** The signed-in admin, or absent on the sign-in screen. */
  readonly adminName?: string;
  readonly adminRole?: string;
  readonly department?: string;
  readonly csrfToken?: string;
  readonly serverTime: string;
  /** Which nav entry is current. */
  readonly section?: string;
  /** False until the second factor is cleared. Drives the banner. */
  readonly mfaSatisfied?: boolean;
  /**
   * True when this console is enforcing a password alone — D143.
   *
   * Drives the banner that says so on every page. It is a display flag only;
   * the decision lives in `requireAdmin`'s policy.
   */
  readonly singleFactorAuth?: boolean;
}

interface NavEntry {
  readonly id: string;
  readonly href: string;
  readonly label: string;
}

/**
 * The console's sections.
 *
 * Rendered for every signed-in admin; **what each one does** is authorised
 * server-side per request. Hiding a link an admin cannot use would be a
 * courtesy, not a control — and treating it as a control is the mistake the
 * feature-flag work already had to fix once.
 */
export const NAV: readonly NavEntry[] = Object.freeze([
  { id: 'dashboard', href: '/', label: 'Dashboard' },
  { id: 'applications', href: '/applications', label: 'Applications' },
  { id: 'merchants', href: '/merchants', label: 'Merchants' },
  { id: 'devices', href: '/devices', label: 'Devices' },
  // Deposits had routes — `/deposits`, `/deposits/new`, `POST /deposits` — and
  // no way to reach them but typing the address. A screen with no entry in the
  // navigation is a screen that does not exist as far as an operator is
  // concerned, which is how a working feature gets reported as missing.
  { id: 'deposits', href: '/deposits', label: 'Deposits' },
  // Added 2026-09-09 after an audit found fourteen of thirty admin permissions
  // with no button anywhere. These three are the ones an operations desk cannot
  // work without — see `ui/opsScreens.ts`.
  // Aggregates, not a transaction list — D144. The label says "activity"
  // rather than "transactions" deliberately: a nav entry reading
  // "Transactions" would promise line items this console does not show.
  { id: 'activity', href: '/activity', label: 'Shop activity' },
  { id: 'operators', href: '/operators', label: 'Operators' },
  // §17.2. The desk that answers "paid but no airtime" — and the one place
  // Telga staff may see an individual transaction (D144's exception, R44).
  { id: 'complaints', href: '/complaints', label: 'Support' },
  // §17.1. What makes a LEGITIMATE complaint verdict actionable: without this
  // a reviewer can decide a shop is owed money and has no way to return it.
  { id: 'reversals', href: '/reversals', label: 'Reversals' },
  { id: 'provider-health', href: '/provider-health', label: 'Provider health' },
  { id: 'tenants', href: '/tenants', label: 'Tenants' },
  { id: 'admins', href: '/admins', label: 'Administrators' },
  { id: 'audit', href: '/audit', label: 'Audit' },
]);

export function page(
  chrome: ConsoleChrome,
  title: string,
  // Same shape `h` accepts, so a screen can write `condition && element`
  // inline instead of building an array first.
  ...content: ReadonlyArray<Node | false | null | undefined>
): El {
  return h(
    'div',
    { class: 'console' },
    // The banner is unconditional, exactly as the POS's training banner is.
    // Somebody who cannot tell which application they are in is somebody who
    // will eventually act in the wrong one.
    h(
      'div',
      { class: 'console__banner', role: 'status', 'data-testid': 'console-banner' },
      h('strong', {}, 'TELGA OPERATIONS CONSOLE'),
      h('span', {}, 'Telga staff only. Every action here is recorded.'),
    ),
    /**
     * Single-factor mode, said out loud on every page — D143.
     *
     * An operator must never have to *infer* which identity checks a console is
     * enforcing. The relaxation is a deliberate training setting, and a
     * deliberate setting that is invisible becomes an accidental one the moment
     * somebody deploys the same configuration somewhere it does not belong.
     *
     * Rendered above the MFA notice and suppresses it, because in this mode
     * "second factor not confirmed" is true and misleading: nothing is waiting
     * on it.
     */
    chrome.singleFactorAuth === true &&
      h(
        'div',
        { class: 'console__alert', role: 'alert', 'data-testid': 'console-single-factor' },
        'SINGLE-FACTOR MODE — password only, no second factor, no re-authentication. ' +
          'Training configuration. Must be switched off before real money.',
      ),
    chrome.singleFactorAuth !== true &&
      chrome.mfaSatisfied === false &&
      h(
        'div',
        { class: 'console__alert', role: 'alert', 'data-testid': 'console-mfa-required' },
        'Second factor not confirmed. Nothing can be done until it is.',
      ),
    chrome.adminName !== undefined &&
      h(
        'header',
        { class: 'console__header' },
        h(
          'div',
          { class: 'console__identity', 'data-testid': 'console-identity' },
          h('span', { class: 'console__admin', 'data-testid': 'console-admin' }, chrome.adminName),
          h(
            'span',
            { class: 'console__role', 'data-testid': 'console-role' },
            `${chrome.department ?? ''} · ${chrome.adminRole ?? ''}`,
          ),
        ),
        h(
          'form',
          { method: 'post', action: '/logout', 'data-testid': 'console-logout-form' },
          h('input', { type: 'hidden', name: 'csrfToken', value: chrome.csrfToken ?? '' }),
          h(
            'button',
            { type: 'submit', class: 'console__button', 'data-testid': 'console-logout' },
            'Sign out',
          ),
        ),
      ),
    chrome.adminName !== undefined &&
      h(
        'nav',
        { class: 'console__nav', 'data-testid': 'console-nav' },
        ...NAV.map((entry) =>
          h(
            'a',
            {
              href: entry.href,
              class: 'console__nav-link',
              'data-testid': `nav-${entry.id}`,
              'aria-current': chrome.section === entry.id ? 'page' : undefined,
            },
            entry.label,
          ),
        ),
      ),
    h(
      'main',
      { class: 'console__main', 'data-testid': 'console-screen', 'data-screen': title },
      h('h1', { class: 'console__title' }, title),
      ...content,
    ),
    h(
      'footer',
      { class: 'console__footer' },
      h('span', { 'data-testid': 'console-time' }, `Telga time: ${chrome.serverTime}`),
    ),
  );
}

const STYLES = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0; background: #10151c; color: #e6ecf2;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 15px; line-height: 1.5;
}
.console { min-height: 100vh; display: flex; flex-direction: column; }
/* Slate, not the POS teal. Telling the two apart at a glance is the point. */
.console__banner {
  background: #2b3442; border-bottom: 2px solid #46536a;
  padding: 0.6rem 1rem; display: flex; gap: 1rem; align-items: baseline; flex-wrap: wrap;
  letter-spacing: 0.06em; font-size: 0.85rem;
}
.console__banner strong { letter-spacing: 0.14em; }
.console__alert {
  background: #5a2c14; border-bottom: 1px solid #8a4a22;
  padding: 0.6rem 1rem; font-weight: 600;
}
.console__header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 0.8rem 1rem; border-bottom: 1px solid #232c38;
}
.console__identity { display: flex; flex-direction: column; }
.console__admin { font-weight: 700; }
.console__role { font-size: 0.8rem; opacity: 0.7; letter-spacing: 0.05em; }
.console__nav {
  display: flex; gap: 0.25rem; padding: 0 1rem; border-bottom: 1px solid #232c38;
  overflow-x: auto;
}
.console__nav-link {
  padding: 0.7rem 0.9rem; color: #b9c6d4; text-decoration: none;
  border-bottom: 2px solid transparent; white-space: nowrap;
}
.console__nav-link:hover { color: #fff; }
.console__nav-link[aria-current="page"] { color: #fff; border-bottom-color: #6ea8fe; }
.console__main { flex: 1; padding: 1.25rem 1rem 3rem; max-width: 72rem; width: 100%; }
.console__title { font-size: 1.35rem; margin: 0 0 1rem; }
.console__footer { padding: 0.75rem 1rem; font-size: 0.78rem; opacity: 0.6; }
.console__button {
  background: #2b3442; color: #e6ecf2; border: 1px solid #46536a;
  border-radius: 0.4rem; padding: 0.5rem 0.9rem; font: inherit; cursor: pointer;
}
.console__button:hover { background: #36415280; border-color: #6ea8fe; }
.console__button--danger { background: #5a2027; border-color: #8a3340; }
.console__button:focus-visible { outline: 2px solid #6ea8fe; outline-offset: 2px; }
/* For a cell that holds no action — dimmer than the data around it, but
   still above the 4.5:1 contrast floor on this background. */
.console__muted { color: #97a3b4; }
.console__table { width: 100%; border-collapse: collapse; margin: 0.5rem 0 1rem; }
.console__table th, .console__table td {
  text-align: left; padding: 0.55rem 0.6rem; border-bottom: 1px solid #232c38;
  font-size: 0.9rem;
}
.console__table th { font-size: 0.75rem; letter-spacing: 0.07em; text-transform: uppercase; opacity: 0.7; }
.console__field { display: flex; flex-direction: column; gap: 0.3rem; margin-bottom: 0.9rem; max-width: 26rem; }
.console__field label { font-size: 0.8rem; opacity: 0.8; }
.console__field input, .console__field select, .console__field textarea {
  background: #171d26; color: #e6ecf2; border: 1px solid #2f3a49;
  border-radius: 0.4rem; padding: 0.55rem 0.6rem; font: inherit;
}
.console__field input:focus-visible { outline: 2px solid #6ea8fe; outline-offset: 1px; }
.console__note { font-size: 0.85rem; opacity: 0.75; max-width: 44rem; }
.console__error { color: #ffb4ac; font-weight: 600; }
.console__pill {
  display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px;
  font-size: 0.72rem; letter-spacing: 0.05em; border: 1px solid #46536a;
}
.console__token {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 1.25rem; letter-spacing: 0.1em; background: #171d26;
  border: 1px solid #46536a; border-radius: 0.5rem; padding: 0.8rem 1rem;
  display: inline-block; margin: 0.5rem 0;
}
`;

/**
 * The full document.
 *
 * No inline script at all. The console has no polling, no timers and no
 * progressive enhancement — every screen is a form and a link — so the policy
 * can simply forbid script rather than allow a nonce.
 */
export function document(body: El, title: string): string {
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "img-src 'none'",
    "script-src 'none'",
  ].join('; ');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="content-security-policy" content="${escapeText(csp)}">`,
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${escapeText(title)} · Telga Operations</title>`,
    `<style>${STYLES}</style>`,
    '</head>',
    '<body>',
    render(body),
    '</body>',
    '</html>',
  ].join('\n');
}

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "img-src 'none'",
  "script-src 'none'",
].join('; ');
