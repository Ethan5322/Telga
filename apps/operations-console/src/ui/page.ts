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

import { cssVariables } from '@telga/design-system';

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
  // §19.1. Without this a transfer above the threshold is stranded: the row
  // exists, no ledger entry does, and nothing could ever decide it.
  { id: 'transfers', href: '/transfers', label: 'Transfers' },
  { id: 'provider-health', href: '/provider-health', label: 'Provider health' },
  { id: 'tenants', href: '/tenants', label: 'Tenants' },
  { id: 'admins', href: '/admins', label: 'Administrators' },
  { id: 'audit', href: '/audit', label: 'Audit' },
]);

/**
 * An enum, as a person would read it.
 *
 * `PLATFORM_OWNER` became `Platform owner`. Rendering the constant verbatim is
 * the clearest possible signal that nobody looked at the screen, and it was on
 * every page of the console until 2026-09-12.
 */
export function readableRole(value: string): string {
  const words = value.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A timestamp, as a person would read it.
 *
 * The footer showed `2026-09-12T14:22:00.000Z`. The `Z` matters to a machine;
 * an operations desk reads a date and a time. Kept deliberately plain and
 * unlocalised, because the console is English-only and a guessed locale is
 * worse than none.
 */
export function readableTime(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return new Date(at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function page(
  chrome: ConsoleChrome,
  title: string,
  // Same shape `h` accepts, so a screen can write `condition && element`
  // inline instead of building an array first.
  ...content: ReadonlyArray<Node | false | null | undefined>
): El {
  // Password proved, second factor not. Single-factor mode is not this state:
  // there, nothing is waiting on a second factor at all.
  const identityHidden =
    chrome.singleFactorAuth !== true && chrome.mfaSatisfied === false;

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
    /**
     * Nothing of the console is shown until the second factor is cleared.
     *
     * Founder instruction, 2026-09-12: *"be sure that until Resend OTP is
     * verified the admin panel is opaque — nothing seen."*
     *
     * The **routes** already refuse a password-only session entirely — proved
     * by `admin-authentication.test.ts`, *"can do nothing at all, not even
     * read"*. This is the other half: the **page** was still drawing the
     * administrator's name, their department and role, and a navigation link to
     * every section of the console. No data, but a map of the platform and an
     * identity, on a screen anybody standing nearby can read, before the person
     * at the keyboard has proved they are that administrator.
     *
     * Sign out survives, because it is an action rather than information, and
     * somebody who has opened this by mistake needs a way to leave.
     */
    identityHidden &&
      h(
        'header',
        { class: 'console__header' },
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
    !identityHidden &&
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
            // Title case, not the enum. `PLATFORM_OWNER` is a code
            // constant, and rendering it verbatim tells an operator that
            // nobody looked at this screen.
            [chrome.department, chrome.adminRole]
              .filter((part): part is string => part !== undefined)
              .map(readableRole)
              .join(' · '),
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
    !identityHidden &&
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
      // A human reads this, so it is not an ISO timestamp. The testid and the
      // value's meaning are unchanged.
      h('span', { 'data-testid': 'console-time' }, `Telga time: ${readableTime(chrome.serverTime)}`),
    ),
  );
}

/**
 * The console's stylesheet, built on the shared tokens.
 *
 * `cssVariables()` is emitted first so every rule below can name a token
 * instead of a hex literal. The console keeps its slate ground rather than the
 * brand teal — §18.0, somebody who cannot tell at a glance which application
 * they are in is somebody who will eventually act in the wrong one — but it
 * now takes that slate from the same file the POS takes its teal from.
 */
const STYLES = `
${cssVariables('leather')}
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--telga-ground);
  color: var(--telga-ink);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 15px; line-height: 1.5;
  /* Under the notch, above the gesture bar. A console is read on a phone far
     more often than its desktop layout suggests. */
  padding-top: env(safe-area-inset-top, 0px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
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

/* ==========================================================================
   The binding: leather over board
   ==========================================================================

   The same world as the merchant app, taken from its binding rather than its
   pages. CLAUDE.md 18.0 requires that a Telga employee suspending a merchant
   and a shop assistant selling airtime can never mistake one application for
   the other, so this is the dark side of that world, drawn from the same
   tokens. Relatives, not twins.

   Dark is chosen from the scene, not by category: an operations desk works
   indoors through long sessions, often beside a bright counter screen. The
   merchant app is light for the opposite reason.

   WHY A SCROLLING TAB STRIP AND NOT A BOTTOM BAR. A bottom bar holds four or
   five destinations. This console has fourteen and they are not rankable: the
   desk that needs Deposits today needs Reversals tomorrow. A horizontally
   scrolling strip shows the current one and keeps the rest one swipe away.

   WHY THE TABLES SCROLL RATHER THAN RESTACK. Restacking rows into cards needs
   a header label on every cell, which means changing the markup of every table
   here and every test that reads one. A table that scrolls sideways keeps the
   column relationships a reconciliation screen depends on, which stacked cards
   lose. */

body {
  font-family: var(--telga-type-body);
  font-size: var(--telga-type-base);
}

.console__banner {
  position: sticky;
  top: 0;
  z-index: 30;
  background: var(--telga-leather-ground-deep);
  border-bottom: var(--telga-size-rule-major) solid var(--telga-leather-rubric);
  color: var(--telga-leather-ink);
}

/* Tooled, not tinted: the impression a blind tool leaves in leather. */
.console__header {
  background: var(--telga-leather-ground-raised);
  border-bottom: var(--telga-size-rule-hair) solid var(--telga-leather-rule);
}

.console__title {
  font-family: var(--telga-type-display);
  border-bottom: var(--telga-size-rule-major) solid var(--telga-leather-rubric);
  padding-bottom: var(--telga-space-sm);
}

.console__nav {
  display: flex;
  flex-wrap: nowrap;
  overflow-x: auto;
  scroll-snap-type: x proximity;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
  background: var(--telga-leather-ground-deep);
  border-bottom: var(--telga-size-rule-hair) solid var(--telga-leather-rule);
}
.console__nav::-webkit-scrollbar { display: none; }

.console__nav-link {
  flex: 0 0 auto;
  scroll-snap-align: start;
  min-height: var(--telga-size-touch-min);
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
  color: var(--telga-leather-ink-thin);
  border-bottom: var(--telga-size-rule-heavy) solid transparent;
}

/* Marked by weight and a rule as well as ink; never colour alone. */
.console__nav-link[aria-current="page"] {
  font-weight: 700;
  color: var(--telga-leather-ink);
  border-bottom-color: var(--telga-leather-rubric);
}

.console__table {
  display: block;
  overflow-x: auto;
  white-space: nowrap;
  -webkit-overflow-scrolling: touch;
}

.console__table th {
  font-family: var(--telga-type-body);
  border-bottom: var(--telga-size-rule-major) solid var(--telga-leather-rubric);
  color: var(--telga-leather-ink);
}

.console__table td {
  border-bottom: var(--telga-size-rule-hair) solid var(--telga-leather-rule);
}

/* Money in fixed decimal positions, so a column lines up digit for digit and
   a figure never changes width as it changes. */
.console__table td,
[data-amount] {
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
}

/* Phases carry a pattern as well as an ink, for the same reason they do on the
   merchant side: a reconciliation printout is monochrome. */
[data-phase] {
  border-bottom-width: var(--telga-size-rule-major);
  border-bottom-color: currentColor;
  padding-bottom: 2px;
}
[data-phase="settled"]  { border-bottom-style: solid;  color: var(--telga-leather-rubric); }
[data-phase="working"]  { border-bottom-style: dotted; color: var(--telga-leather-indigo); }
[data-phase="pending"]  { border-bottom-style: dashed; color: var(--telga-leather-indigo); }
[data-phase="review"]   { border-bottom-style: double; color: var(--telga-leather-ochre); }
[data-phase="failed"]   { border-bottom-style: solid;  color: var(--telga-leather-ink); text-decoration: line-through; }
[data-phase="reversed"] { border-bottom-style: double; color: var(--telga-leather-rubric); text-decoration: line-through; }

/* A row a colleague has already decided carries a persistent strike. */
tr[data-worked="true"] { color: var(--telga-leather-ink-thin); }
tr[data-worked="true"] td:first-child { text-decoration: line-through; }

.console__button,
button[type="submit"] {
  min-height: var(--telga-size-touch-min);
  background: var(--telga-leather-rubric);
  color: var(--telga-leather-ground-deep);
  border: 0;
  border-bottom: var(--telga-size-rule-major) solid var(--telga-leather-ground-deep);
  border-radius: var(--telga-size-radius-sm);
  font-family: var(--telga-type-body);
  font-weight: 600;
  transition: transform var(--telga-motion-instant) var(--telga-motion-standard);
}
.console__button:active,
button[type="submit"]:active { transform: translateY(1px); }

input, select, textarea {
  /* Anything under 16px makes iOS zoom the whole page on focus, which leaves
     the operator scrolled sideways on a form they were halfway through. */
  font-size: 16px;
  min-height: var(--telga-size-touch-min);
  background: var(--telga-leather-ground-deep);
  color: var(--telga-leather-ink);
  border: var(--telga-size-rule-hair) solid var(--telga-leather-rule);
  border-radius: var(--telga-size-radius-sm);
}

/* The parts not drawn here still carry the world. */
::selection { background: var(--telga-leather-ochre); color: var(--telga-leather-ground-deep); }
:root { accent-color: var(--telga-leather-rubric); caret-color: var(--telga-leather-rubric); }
:focus-visible {
  outline: var(--telga-size-rule-heavy) solid var(--telga-leather-rubric);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}

/* --- containment --------------------------------------------------------
   Found by rendering at 390px: the sign-in and dashboard screens overflowed
   and cut their own sentences mid-word. min-width: 0 is the load-bearing
   line — a flex child defaults to min-width: auto and refuses to shrink
   below its content, which widens the whole row past the screen. */
html, body { overflow-x: hidden; max-width: 100%; }
*, *::before, *::after { min-width: 0; }

.console, .console__banner, .console__alert, .console__header, .console__main,
.console__footer { max-width: 100%; }

.console__main, .console__alert, .console__banner, p, td, th, dd, dt, li {
  overflow-wrap: anywhere;
}

/* A form row wraps rather than pushing its control off the screen. */
.console__main label {
  display: flex;
  flex-direction: column;
  gap: var(--telga-space-xs);
  max-width: 100%;
}
.console__main form { max-width: 100%; }

/* The nav strip must show that it scrolls. A fade at the trailing edge is the
   only honest affordance when the fourteenth destination is off-screen. */
.console__nav {
  mask-image: linear-gradient(to right, #000 0, #000 calc(100% - 24px), transparent 100%);
}

@media (max-width: 640px) {
  .console__main { padding: 1rem 0.75rem 3rem; }
  .console__header { flex-wrap: wrap; gap: 0.5rem; }
  .console__banner { font-size: 0.78rem; padding: 0.5rem 0.75rem; }
  /* Actions become full-width rows rather than a cramped inline cluster. */
  .console__actions { display: flex; flex-direction: column; gap: 0.5rem; }
  .console__actions form { width: 100%; }
  .console__actions button { width: 100%; }
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
