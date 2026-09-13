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

import { cssVariables } from '@telga/design-system';
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
  // --- inactivity sign-out -------------------------------------------------
  //
  // The server is the authority: it expires the session on its own clock and
  // refuses the next request regardless of what this script does. This only
  // makes the expiry *visible* — without it, an unattended screen keeps
  // showing a balance long after the session behind it is dead.
  //
  // Only real interaction counts. A background poll deliberately does not,
  // and neither does a reload, because the point is to detect an operator
  // who has walked away.
  // Two windows, not one.
  //
  //   data-lock-after-s    - the shop's lock-the-screen-after-N-seconds.
  //                          Locks: the session lives, a PIN reopens it.
  //   data-idle-timeout-s  - the server's session expiry. Signs out.
  //
  // These were the same number until 2026-08-30, so a shop that set 45 seconds
  // got the session's 60 and its setting did nothing. Whichever window is
  // shorter fires first, which is what an operator expects.
  //
  // The server enforces both independently: screenIsLocked re-checks the lock
  // window on every request, so a page that never fires these timers, or that
  // is edited to a longer one, changes nothing that matters.
  // Seconds in the markup, milliseconds in the timers.
  //
  // Emitted in seconds so the attribute can never be mistaken for a PIN.
  // The idle-timeout test refuses any standalone six-digit run in the page,
  // deliberately broadly, because a PIN is six digits and a leak would look
  // like an ordinary number. A quarter-hour window in milliseconds is a
  // six-digit number, and tripped that guard.
  //
  // Two traps in this comment, both hit while writing it:
  //   - No backticks. This lives inside the client-script template literal,
  //     where one would end the literal and break the parse.
  //   - No six-digit numbers, not even as an example. This comment SHIPS TO
  //     THE BROWSER inside the script, so writing the offending value here
  //     re-created the exact leak the guard was catching.
  //
  // The guard was right to fire and is the wrong thing to relax: it cannot know
  // which six-digit number is innocent, and a version that could would be a
  // version that misses a real PIN. So the page stops emitting six-digit
  // numbers instead. Seconds are also the unit the shop's own setting is in.
  var idleMs = parseInt(document.body.getAttribute('data-idle-timeout-s') || '0', 10) * 1000;
  var lockMs = parseInt(document.body.getAttribute('data-lock-after-s') || '0', 10) * 1000;
  if (idleMs > 0 || lockMs > 0) {
    var idleTimer, lockTimer;
    var signOut = function () {
      window.location.assign('/login?error=SESSION_IDLE_EXPIRED&returnTo=%2Flauncher');
    };
    var lockScreen = function () {
      // A plain navigation: the server decides whether the lock is due and
      // renders the lock screen. Nothing here decides it.
      window.location.assign('/lock');
    };
    var reset = function () {
      if (idleTimer) clearTimeout(idleTimer);
      if (lockTimer) clearTimeout(lockTimer);
      if (idleMs > 0) idleTimer = setTimeout(signOut, idleMs);
      if (lockMs > 0) lockTimer = setTimeout(lockScreen, lockMs);
    };
    ['pointerdown', 'keydown', 'click', 'submit', 'touchstart'].forEach(function (evt) {
      document.addEventListener(evt, reset, { passive: true, capture: true });
    });
    reset();
  }

  // --- one-shot submit buttons ---------------------------------------------
  //
  // A button marked data-once is disabled the moment its form submits, so a
  // double click cannot fire two requests. Enhancement only: with scripting
  // off the form still works, and the server is unaffected either way —
  // a reprint appends an audit line and never touches the ledger.
  Array.prototype.forEach.call(document.querySelectorAll('form'), function (form) {
    form.addEventListener('submit', function (event) {
      // A button marked data-confirm asks before its form submits. An
      // enhancement, never a gate: with scripting off the form still
      // submits, and what it does — cancel an unissued order — is the safe
      // outcome either way.
      var confirmer = form.querySelector('[data-confirm]');
      if (confirmer && !window.confirm(confirmer.getAttribute('data-confirm'))) {
        event.preventDefault();
        return;
      }
      Array.prototype.forEach.call(form.querySelectorAll('[data-once]'), function (btn) {
        btn.setAttribute('disabled', 'disabled');
        btn.setAttribute('aria-disabled', 'true');
      });
    });
  });

  // --- printing ------------------------------------------------------------
  //
  // A button marked data-print hands the slip to the device's own print stack.
  //
  // **What this is, stated plainly:** window.print(). On an Android phone or
  // a smart-POS running the Telga shell, that opens the system print dialogue,
  // which reaches whatever the device already knows how to print to — a
  // Bluetooth or wi-fi roll printer paired at the OS level, Google Cloud Print
  // successors, or a PDF. It is **not** an ESC/POS driver, and Telga speaks no
  // printer protocol of its own.
  //
  // **Why that is the right first implementation** and not a shortcut: the
  // alternative is a vendor SDK per POS model, and the model is not chosen yet
  // (ASSUMPTIONS A101). This route works on every device that can print at all,
  // needs no permission, and cannot silently print the wrong thing — a human
  // sees the dialogue. When the hardware is decided, a native path can sit
  // behind the same button.
  //
  // **The print stylesheet is what makes the output a receipt** rather than a
  // screenshot of a web page: the print stylesheet hides everything except the slip element,
  // sizes it to the 58 mm or 80 mm roll the shop chose, and forces the mark to
  // solid black because a thermal head is one bit per dot.
  //
  // Enhancement only. With scripting off the button is still there and still
  // does nothing harmful; the operator uses the browser's own print command,
  // and the same stylesheet applies. Printing is never a transaction: it moves
  // no money, writes no row, and a failed print is not a failed sale.
  Array.prototype.forEach.call(document.querySelectorAll('[data-print]'), function (btn) {
    btn.addEventListener('click', function () {
      try {
        window.print();
      } catch (e) {
        // A device with no print stack at all. Nothing to recover: the slip is
        // on screen, which is what the operator reads the code from anyway.
      }
    });
  });

  // --- the success cue -----------------------------------------------------
  //
  // A short tone when a sale completes, so an operator facing a customer
  // knows it landed without looking down. Synthesised rather than fetched:
  // an audio file would be another request under the page's CSP, and this is
  // two notes.
  //
  // Off unless the shop turned it on — the page says which via a data
  // attribute, so the decision stays on the server with every other setting.
  var cue = document.querySelector('[data-sound-cue]');
  if (cue && cue.getAttribute('data-sound-cue') === 'on') {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        var ctx = new Ctx();
        [[880, 0], [1320, 0.12]].forEach(function (note) {
          var osc = ctx.createOscillator();
          var gain = ctx.createGain();
          osc.frequency.value = note[0];
          osc.type = 'sine';
          gain.gain.setValueAtTime(0.0001, ctx.currentTime + note[1]);
          gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + note[1] + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + note[1] + 0.11);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(ctx.currentTime + note[1]);
          osc.stop(ctx.currentTime + note[1] + 0.12);
        });
      }
    } catch (e) {
      // A browser that refuses audio before a gesture is not an error worth
      // showing anybody — the sale still happened.
    }
  }

  // --- quantity stepper ----------------------------------------------------
  //
  // Enhancement only. The number input works on its own with scripting off,
  // and the server re-validates the value against its own bounds either way;
  // these buttons only save an operator from typing on a counter screen.
  Array.prototype.forEach.call(document.querySelectorAll('[data-step]'), function (button) {
    button.addEventListener('click', function () {
      var field = document.getElementById(button.getAttribute('data-step-target'));
      if (!field) return;
      var min = parseInt(field.getAttribute('min') || '1', 10);
      var max = parseInt(field.getAttribute('max') || '20', 10);
      var next = (parseInt(field.value, 10) || min) + parseInt(button.getAttribute('data-step'), 10);
      field.value = String(Math.min(max, Math.max(min, next)));
    });
  });

  // --- pending-transaction poll -------------------------------------------
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
      // Marks this as background: it validates the session but must never
      // renew the idle window, or a screen left open would never time out.
      headers: { accept: 'application/json', 'x-telga-background': '1' }
    }).then(function (r) { return r.json(); }).then(function (body) {
      if (body && body.ok && body.data && body.data.state !== state) { window.location.reload(); return; }
      setTimeout(check, interval);
    }).catch(function () { setTimeout(check, interval); });
  }
  setTimeout(check, interval);
})();
`;

const STYLES = `
/* ==========================================================================
   Telga design system
   ==========================================================================

   Modelled on the reference terminal the founder supplied: the brand colour
   fills the screen, white rounded cards float on it, and every action is a
   black pill. Telga's brand colour is the deep teal of the mark, not the
   reference's green — the *structure* is what was asked for, not the palette.

   Why a full-bleed brand background rather than a neutral page: on a counter
   machine seen at arm's length and at an angle, a coloured field with white
   cards separates content far faster than borders on a grey page. It also
   makes the training build unmistakable at a glance.

   Every value is a token. A screen that hard-codes a colour is a screen that
   drifts, and this file has already been through three rounds of that. */
:root {
  color-scheme: light;
  --gap: 0.75rem;

  /* Every value below resolves to a token emitted above. The old names are
     kept as the binding layer so the component rules further down this file
     inherit the world without each one being rewritten by hand. */

  /* Ground. The page IS the skin: there is no second material floating on it. */
  --brand: var(--telga-vellum-ground);
  --brand-deep: var(--telga-vellum-ink);
  --brand-bright: var(--telga-vellum-rubric);
  --brand-ink: var(--telga-vellum-ink);

  --card: var(--telga-vellum-ground-pale);
  --card-sunken: var(--telga-vellum-ground-deep);
  --ink: var(--telga-vellum-ink);
  --ink-soft: var(--telga-vellum-ink-thin);
  --line: var(--telga-vellum-rule);

  /* Rubrication carries the primary action. */
  --pill: var(--telga-vellum-rubric);
  --pill-ink: var(--telga-vellum-ground-pale);

  /* A folio is cut, not rounded. The radius only stops a rule looking chipped
     where two of them meet. */
  --r-sm: var(--telga-size-radius-sm);
  --r-md: var(--telga-size-radius-md);
  --r-lg: var(--telga-size-radius-lg);
  --r-pill: var(--telga-size-radius-lg);

  /* A manuscript has ruling and impression, not drop shadows. What remains is
     the edge a fixed bar needs over scrolling content. */
  --shadow: none;
  --shadow-lifted: var(--telga-shadow-app-bar);
}

body {
  font-family: system-ui, "Noto Sans Ethiopic", sans-serif;
  margin: 0;
  line-height: 1.5;
  font-size: 1.05rem;
  color: var(--ink);
  /* The brand fills the screen; cards sit on top of it. */
  background: var(--brand);
}

/* The shell and the page are defined once, in the scribal shell block at the
   foot of this file. They were a full-bleed brand field carrying white cards
   until 2026-09-12, when the founder released the reference terminal that
   arrangement was modelled on; the world that replaced it has no cards,
   because the page is the skin and ruling is what separates content. */

/* Every action is a pill. Black by default, brand for the primary one. */
.voucher__button,
button[type="submit"] {
  border-radius: var(--r-pill);
  border: none;
  background: var(--pill);
  color: var(--pill-ink);
  font-weight: 700;
  padding: 0.9rem 1.6rem;
  justify-content: center;
}
.voucher__button--primary { background: var(--brand); }
.voucher__button--cancel { background: transparent; color: var(--ink); border: 2px solid var(--line); }
.voucher__button:hover, button[type="submit"]:hover { filter: brightness(1.12); }
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
[aria-current="page"] { font-weight: 700; text-decoration-thickness: 3px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }

/* Telga launcher: two large module tiles, not two applications — see
   ui/launcher.ts. */
.launcher__tiles { display: flex; gap: var(--gap); flex-wrap: wrap; }
.launcher__tile {
  flex: 1 1 12rem; min-height: 8rem; flex-direction: column; justify-content: center;
  gap: 0.35rem; border: 3px solid currentColor; border-radius: 0.75rem; text-align: center;
}
.launcher__tile-icon { font-size: 2.5rem; }
.launcher__tile-label { font-size: 1.15rem; font-weight: 700; }
.launcher__tile-subtitle { font-size: 0.85rem; opacity: 0.8; }

/* --- the launcher's single Telga button -----------------------------------
   Screen one of two: Telga as one thing you open. It is the only control on
   the page, so it earns the space — and it carries the real mark rather than a
   drawn substitute, which read as a diagram of the logo rather than the logo.

   The elegance is in restraint: one soft ring, one gentle lift on press, and a
   dark ground the transparent artwork sits on cleanly. No drop shadows under
   the mark, which would fight the render's own lighting. */
.launcher__single { display: flex; justify-content: center; padding: 2.5rem 1rem 3rem; }
.launcher__telga {
  display: flex; flex-direction: column; align-items: center; gap: 0.9rem;
  padding: 2.5rem 3rem 2rem; border-radius: 1.75rem; text-decoration: none;
  color: #f4f7f7;
  /* A soft radial pool behind the mark, so the artwork sits in light rather
     than on a flat panel. */
  background:
    radial-gradient(120% 90% at 50% 18%, rgba(143,196,189,0.16) 0%, rgba(143,196,189,0) 62%),
    linear-gradient(180deg, #16383b 0%, #102a2d 100%);
  border: 1px solid rgba(143,196,189,0.28);
  box-shadow: 0 1px 0 rgba(255,255,255,0.06) inset, 0 12px 28px -14px rgba(0,0,0,0.75);
  min-width: 17rem; max-width: 22rem;
  transition: transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease;
}
.launcher__telga:hover {
  border-color: rgba(143,196,189,0.5);
  box-shadow: 0 1px 0 rgba(255,255,255,0.09) inset, 0 18px 36px -14px rgba(0,0,0,0.8);
  transform: translateY(-3px);
}
.launcher__telga:focus-visible { outline: 3px solid #8FC4BD; outline-offset: 4px; }
.launcher__telga:active { transform: translateY(-1px) scale(0.99); }
.launcher__telga-icon { line-height: 0; }
.launcher__telga-icon img { max-width: 100%; height: auto; }
.launcher__telga-label {
  font-size: 1.7rem; font-weight: 800; letter-spacing: 0.28em;
  /* The tracking pushes the word right; this pulls the block back to centre. */
  padding-left: 0.28em;
}
/* Says what pressing it does. A mark on its own is a picture. */
.launcher__telga-cue {
  font-size: 0.78rem; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase;
  color: #8FC4BD;
  padding: 0.45rem 1.1rem; border-radius: 999px;
  border: 1px solid rgba(143,196,189,0.35);
}
.launcher__back-row { margin-top: 1.5rem; }

/* The flat mark. Its colours are tokens so the glyph follows the theme rather
   than carrying three hardcoded fills. */
.telga-glyph {
  --glyph-teal: #17858a;
  --glyph-teal-deep: #116a70;
  --glyph-bone: #eee7d8;
  display: block;
}

/* Telga dashboard: a service grid of white icon-badge cards, four per row,
   matching the reference layout an operator already recognises from
   comparable vending terminals — see ui/dashboard.ts's DASHBOARD_SERVICES.
   Colour lives on the icon badge, not the card, so the card stays legible
   text-on-white the way the reference does. */
.dashboard__merchant { font-size: 0.85rem; opacity: 0.75; margin: 0 0 var(--gap); }
.dashboard__grid {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem;
}
@media (max-width: 26rem) { .dashboard__grid { grid-template-columns: repeat(3, 1fr); } }
.dashboard__tile {
  flex-direction: column; align-items: center; justify-content: flex-start; gap: 0.3rem;
  background: #fff; color: #14151a; border: 1px solid #d8dce3; border-radius: 0.7rem;
  box-shadow: 0 1px 3px rgba(0,0,0,0.12); text-align: center; position: relative;
  padding: 0.5rem 0.25rem; min-height: 5.25rem;
}
.dashboard__tile-icon {
  font-size: 1.35rem; width: 2.25rem; height: 2.25rem; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; background: #eef1f6;
}
.dashboard__tile-label { font-size: 0.7rem; font-weight: 600; line-height: 1.1; }
.dashboard__tile-badge { font-size: 0.6rem; opacity: 0.7; line-height: 1; }
.dashboard__tile[data-status="COMING_SOON"] { opacity: 0.72; }
.dashboard__tile--blue .dashboard__tile-icon { background: #dbeafe; }
.dashboard__tile--red .dashboard__tile-icon { background: #fde2e2; }
.dashboard__tile--purple .dashboard__tile-icon { background: #ece3fb; }
.dashboard__tile--yellow .dashboard__tile-icon { background: #fdf1c8; }
.dashboard__tile--green .dashboard__tile-icon { background: #d9f2e3; }
.dashboard__tile--cyan .dashboard__tile-icon { background: #cdeef5; }
.dashboard__tile--navy .dashboard__tile-icon { background: #d5dcf0; }
.dashboard__tile--orange .dashboard__tile-icon { background: #fde3cd; }
.dashboard__tile--sky .dashboard__tile-icon { background: #d8eefb; }
.dashboard__tile--charcoal .dashboard__tile-icon { background: #dfe2e6; }
.dashboard__launcher-link { text-align: center; font-size: 0.85rem; }

/* The Balance / Profit pill row, side by side, pill-shaped, matching the
   reference. Profit's *value* is always the honest "not yet available"
   text — see ui/dashboard.ts's file header. */
.dashboard__pills { display: flex; gap: var(--gap); flex-wrap: wrap; margin-block: var(--gap); }
.dashboard__pill {
  flex: 1 1 10rem; display: inline-block; border: 1px solid currentColor; border-radius: 999px;
  padding: 0.6rem 1.1rem; font-weight: 600; text-align: center;
}
.dashboard__pill--profit { opacity: 0.85; }

/* Bottom nav: icon above label per item, the active item picked out —
   matching the reference's Prepaid/Payments/Account row. */
.dashboard__bottom-nav {
  display: flex; gap: var(--gap); border-top: 1px solid currentColor; padding-top: var(--gap); margin-top: var(--gap);
}
.dashboard__bottom-nav-item {
  flex: 1 1 0; flex-direction: column; gap: 0.15rem; text-align: center; opacity: 0.65;
}
.dashboard__bottom-nav-item[aria-current="page"] { opacity: 1; font-weight: 700; }
.dashboard__bottom-nav-icon { font-size: 1.4rem; }
.dashboard__bottom-nav-label { font-size: 0.75rem; }

/* Voucher screens: white rounded cards in a tapable grid, matching the
   reference vending terminal. Colour lives on the icon badge and on the two
   decisive buttons (green PRINT, red CANCEL) so the rest stays legible
   text-on-white — see ui/screens.ts. */
.voucher__grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--gap); margin-block: var(--gap); }
@media (max-width: 24rem) { .voucher__grid { grid-template-columns: repeat(2, 1fr); } }
.voucher__grid-card {
  flex-direction: column; align-items: center; gap: 0.4rem; padding: 0.9rem 0.5rem;
  background: #fff; color: #14151a; border: 1px solid #d8dce3; border-radius: 0.85rem;
  box-shadow: 0 1px 3px rgba(0,0,0,0.12); text-align: center;
}
.voucher__grid-icon {
  font-size: 1.5rem; width: 2.6rem; height: 2.6rem; border-radius: 50%; background: #eef1f6;
  display: flex; align-items: center; justify-content: center;
}
.voucher__grid-label { font-size: 0.82rem; font-weight: 600; line-height: 1.2; }

/* Denomination cards. The radio itself is visually hidden but still focusable
   and still the thing the browser validates, so keyboard and screen-reader
   users get the real control and :checked drives the highlight with no JS. */
/* Denominations sit in one horizontal row that wraps only when it must, so
   the common amounts are a single glance and a single tap. */
.voucher__amounts { border: none; padding: 0; margin: 0; }
.voucher__amounts-legend { font-weight: 600; padding: 0; margin-bottom: 0.4rem; }
.voucher__amounts-row { display: flex; gap: var(--gap); flex-wrap: wrap; }
.voucher__amounts-row .voucher__amount-card { flex: 1 1 5rem; min-width: 5rem; }
.voucher__custom { display: flex; align-items: center; gap: var(--gap); flex-wrap: wrap; margin-top: var(--gap); }
.voucher__amount-card--custom { flex: 0 0 auto; min-width: 9rem; }
.voucher__custom-field { display: flex; align-items: center; gap: 0.5rem; }
.voucher__custom-field input { font-size: 1.1rem; font-weight: 700; width: 7rem; padding: 0.5rem; border: 2px solid #d8dce3; border-radius: 0.5rem; }
.voucher__custom-hint { flex-basis: 100%; margin: 0; font-size: 0.8rem; opacity: 0.75; }
.voucher__amount-card {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.2rem;
  min-height: 4.5rem; padding: 0.75rem 0.5rem; cursor: pointer;
  background: #fff; color: #14151a; border: 2px solid #d8dce3; border-radius: 0.85rem;
  box-shadow: 0 1px 3px rgba(0,0,0,0.12); text-align: center;
}
.voucher__amount-radio { position: absolute; opacity: 0; width: 1px; height: 1px; }
.voucher__amount-card:has(.voucher__amount-radio:checked) { border-color: #0b6b34; background: #d9f2e3; font-weight: 700; }
.voucher__amount-card:has(.voucher__amount-radio:focus-visible) { outline: 3px solid currentColor; outline-offset: 2px; }
.voucher__amount-card:has(.voucher__amount-radio:disabled) { opacity: 0.5; cursor: not-allowed; }
.voucher__amount-value { font-size: 1.1rem; font-weight: 700; }
.voucher__amount-note { font-size: 0.7rem; opacity: 0.75; }

.voucher__summary-card {
  background: #fff; color: #14151a; border: 1px solid #d8dce3; border-radius: 0.85rem;
  box-shadow: 0 1px 3px rgba(0,0,0,0.12); overflow: hidden; margin-block: var(--gap);
}
.voucher__summary-card th, .voucher__summary-card td { border-bottom: 1px solid #eef1f6; }

.voucher__actions { display: flex; gap: var(--gap); flex-wrap: wrap; align-items: center; }
.voucher__actions--stacked { display: block; }
.voucher__button { border: 2px solid currentColor; border-radius: 0.6rem; font-weight: 700; justify-content: center; }
.voucher__button--primary { background: #17416b; color: #fff; border-color: #17416b; }
.voucher__button--print { background: #0b6b34; color: #fff; border-color: #0b6b34; width: 100%; font-size: 1.2rem; padding: 1rem; }
.voucher__button--cancel { background: #8a1c1c; color: #fff; border-color: #8a1c1c; }

.voucher__pin-heading { font-size: 1.15rem; font-weight: 700; text-align: center; }
.voucher__card {
  background: #fff; color: #14151a; border: 1px solid #d8dce3; border-radius: 0.85rem;
  box-shadow: 0 1px 3px rgba(0,0,0,0.12); padding: var(--gap); text-align: center; margin-block: var(--gap);
}
.voucher__card--ok { border-left: 6px solid #0b6b34; }
.voucher__card--failed { border-left: 6px solid #8a1c1c; }
/* Uncertain. Amber, and deliberately neither the green nor the red: an
   operator glancing at the edge colour must not read it as either outcome. */
.voucher__card--pending { border-left: 6px solid #9a6700; background: #fffdf5; }
/* Still loading. Grey — no outcome has been reported yet. */
.voucher__card--loading { border-left: 6px solid #6b7280; }
.voucher__card-icon { font-size: 2.5rem; margin: 0; }
.voucher__card-headline { font-size: 1.05rem; font-weight: 700; margin: 0.35rem 0 0; }
.voucher__notice { text-align: center; opacity: 0.85; font-size: 0.9rem; }

/* Transaction history: a real table, newest first. */
.history__table { background: #fff; color: #14151a; border-radius: 0.6rem; overflow: hidden; font-size: 0.85rem; }
.history__table th { background: #eef1f6; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.03em; }
.history__table td, .history__table th { padding: 0.5rem 0.6rem; }
.history__time { opacity: 0.7; }

/* The slip: narrow, monospaced and rule-separated, so it reads the same on a
   thermal roll as in a browser print dialog. The print media query drops
   everything except the slip itself. */
/* A slip on screen is a preview of a slip on paper, so it is drawn as paper:
   white, monospace, square-cornered, with a perforated edge top and bottom.
   The rounded card and drop shadow it used to have read as a web panel, which
   is exactly the mismatch the preview is supposed to remove. */
.slip {
  max-width: 22rem; margin: var(--gap) auto; padding: 1rem 1.25rem; background: #fff; color: #14151a;
  border: none; border-radius: 0;
  font-family: ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace; font-size: 0.85rem;
  position: relative;
}
/* The torn edges. Drawn with a repeating gradient rather than an image so they
   cost nothing and scale with the roll width. Hidden when printing — real
   paper brings its own edge. */
.slip::before, .slip::after {
  content: ""; position: absolute; left: 0; right: 0; height: 6px;
  background: repeating-linear-gradient(135deg, #fff 0 5px, transparent 5px 10px);
}
.slip::before { top: -5px; }
.slip::after { bottom: -5px; transform: scaleY(-1); }
@media print { .slip::before, .slip::after { display: none; } }
/* The mark. Transparent by construction — there is no background rectangle in
   the SVG — so it sits on the slip, on a dark theme and on paper alike.
   On screen the mono silhouette is tinted with the brand verdigris; the print
   block below takes it back to solid black, because a thermal roll has no
   grey to render a tint with. */
/* The bulk-print stepper: two large targets either side of the number, sized
   for a thumb on a counter screen rather than a mouse. */
.voucher__stepper { display: inline-flex; align-items: stretch; gap: 0.4rem; }
.voucher__stepper-button {
  min-width: 3rem; min-height: 3rem; font-size: 1.5rem; font-weight: 700;
  border: 1px solid var(--line); border-radius: var(--r-md); background: var(--card-sunken); color: inherit;
  cursor: pointer;
}
.voucher__stepper-input { width: 5rem; text-align: center; font-size: 1.25rem; }

/* Black on screen as well as on paper. The slip preview used to tint the mark
   verdigris while the printer produced black — so the screen was never quite
   what came out of the roll. Matching them is the whole point of a preview. */
/* The cover screen: the mark, the name, one action. Centred and generous,
   because it is the one screen with nothing to do on it. */
/* The shop's own identity, under the Telga mark. Smaller than the brand line
   because Telga is the platform and the shop is the counter — but the shop's
   name is what a customer recognises, so it is the larger of the two. */
.slip__business-name { text-align: center; font-weight: 700; margin: 0.15rem 0 0; }
.slip__business-line { text-align: center; margin: 0; font-size: 0.75rem; opacity: 0.85; }

/* The three-bar menu. A <details> element, so open/close is the browser's job
   and the menu still works with scripting off. */

/* The "+" beside the balance. A real target, not a decoration: 2.75rem square
   is comfortably tappable on a counter screen with a thumb. */
.dashboard__pill--balance { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
.dashboard__add { display: inline-flex; align-items: center; justify-content: center;
  min-width: 2.75rem; min-height: 2.75rem; border-radius: var(--r-pill); flex: none;
  border: none; background: var(--brand); color: #fff;
  font-size: 1.6rem; font-weight: 700; line-height: 1; text-decoration: none; }
.dashboard__add:hover { background: var(--brand-bright); }
.dashboard__add:focus-visible { outline: 3px solid #8FC4BD; outline-offset: 2px; }

/* Top-up: three full-width choices, stacked. */
.topup__mark { text-align: center; line-height: 0; margin-bottom: 0.5rem; }
.topup__heading { text-align: center; font-size: 1.2rem; font-weight: 700; margin: 0 0 1rem; }
.topup__options { display: flex; flex-direction: column; gap: 0.75rem; }
.topup__option { display: flex; align-items: center; gap: 0.85rem; min-height: 4rem;
  padding: 1rem 1.2rem; border-radius: var(--r-md); border: 1px solid var(--line);
  background: var(--card); color: var(--ink); text-decoration: none; font-size: 1.05rem;
  box-shadow: var(--shadow); }
.topup__option:hover { background: var(--card-sunken); }
.topup__option:focus-visible { outline: 3px solid #8FC4BD; outline-offset: 2px; }
.topup__icon { font-size: 1.5rem; }

/* Learning steps and policy text: comfortable measure, generous spacing. */
.learning { padding-left: 1.2rem; display: flex; flex-direction: column; gap: 1.25rem; }
.learning__title { font-size: 1.05rem; margin: 0 0 0.25rem; }
.learning__body { margin: 0; max-width: 42rem; line-height: 1.55; }
.learning__try { display: inline-block; margin-top: 0.4rem; }
.policy { max-width: 42rem; line-height: 1.6; display: flex; flex-direction: column; gap: 0.9rem; }
.settings__section { font-size: 1.05rem; margin: 1.75rem 0 0.5rem; padding-top: 0.9rem;
  border-top: 1px solid var(--line); color: var(--ink-soft); text-transform: uppercase;
  letter-spacing: 0.06em; font-size: 0.85rem; }
.menu { position: relative; }
.menu__button { list-style: none; cursor: pointer; display: inline-flex;
  align-items: center; justify-content: center; min-width: 3rem; min-height: 3rem;
  border-radius: var(--r-md); border: none; background: var(--card); color: var(--ink);
  box-shadow: var(--shadow); }
.menu__button::-webkit-details-marker { display: none; }
.menu__button:hover { background: #22304a; }
.menu__button:focus-visible { outline: 3px solid #8FC4BD; outline-offset: 2px; }
.menu__bars { display: inline-flex; flex-direction: column; gap: 4px; }
.menu__bars i { display: block; width: 22px; height: 3px; border-radius: 2px; background: currentColor; }
.menu__panel { position: absolute; right: 0; top: calc(100% + 0.4rem); z-index: 20;
  min-width: 17rem; padding: 0.6rem; border-radius: var(--r-lg);
  border: none; background: var(--card); color: var(--ink);
  box-shadow: var(--shadow-lifted); }
.menu__identity { display: flex; align-items: center; gap: 0.5rem;
  padding: 0.4rem 0.6rem 0.7rem; border-bottom: 1px solid var(--line); }
.menu__operator { font-weight: 700; word-break: break-all; }
.menu__item { display: flex; align-items: center; gap: 0.6rem; width: 100%;
  min-height: 3rem; padding: 0.6rem 0.6rem; border-radius: 0.4rem;
  color: inherit; text-decoration: none; background: none; border: none;
  font: inherit; text-align: left; cursor: pointer; }
.menu__item:hover, .menu__item:focus-visible { background: var(--card-sunken); }
.menu__item:focus-visible { outline: 2px solid #8FC4BD; outline-offset: -2px; }
.menu__item[aria-current="page"] { background: var(--card-sunken); font-weight: 700; }
.menu__item-icon { font-size: 1.15rem; width: 1.5rem; text-align: center; }
.menu__item--logout { color: #A8332A; font-weight: 600; }
.menu__logout { margin: 0.5rem 0 0; padding-top: 0.5rem; border-top: 1px solid var(--line); }
/* Lock: a black pill at the foot of the sheet, as the reference terminal has
   it. Deliberately the heaviest thing in the menu — it is what an operator
   reaches for when stepping away, and it must not be mistaken for sign-out. */
/* The reference as bars. Pure black on white so a thermal head reproduces it
   exactly, and a human-readable line beneath in case a scanner is not to hand. */
/* Taking a card. The amount is the largest thing on the screen — it is what
   the customer is agreeing to, and what an operator reads back aloud. */
.card__amount { display: flex; justify-content: space-between; align-items: baseline;
  padding: 1rem 1.2rem; border-radius: var(--r-md); background: var(--card-sunken);
  margin-bottom: var(--gap); }
.card__amount-label { color: var(--ink-soft); }
.card__amount-value { font-size: 1.7rem; font-weight: 800; }
.card__prompt { text-align: center; font-size: 1.15rem; font-weight: 700; margin: 0 0 0.75rem; }

/* Three gestures, one card shape. The motion is what differs, so the card is
   the constant and the marks around it carry the meaning. */
.card__gestures { display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap;
  margin-bottom: 1.25rem; }
.card__gesture { display: flex; flex-direction: column; align-items: center; gap: 0.45rem;
  flex: 1 1 7rem; max-width: 10rem; padding: 1rem 0.5rem; cursor: pointer;
  border: 2px solid var(--line); border-radius: var(--r-md); background: var(--card); }
.card__gesture:has(.card__gesture-radio:checked) { border-color: var(--brand); background: #E8F4F3; }
.card__gesture-radio { position: absolute; opacity: 0; width: 0; height: 0; }
.card__gesture-art { position: relative; display: block; width: 62px; height: 42px; }
.card__gesture-card { position: absolute; inset: 0; border-radius: 6px;
  background: linear-gradient(160deg, var(--brand-bright), var(--brand-deep)); }
.card__gesture-card::before { content: ""; position: absolute; left: 6px; top: 10px;
  width: 12px; height: 9px; border-radius: 2px; background: rgba(255,255,255,0.85); }
/* Tap: waves leaving the card. */
.card__gesture-card--tap::after { content: ""; position: absolute; right: -14px; top: 8px;
  width: 12px; height: 26px;
  border-right: 3px solid var(--brand); border-radius: 0 40% 40% 0 / 0 50% 50% 0; }
/* Insert: an arrow going down into a slot. */
.card__gesture-card--insert::after { content: ""; position: absolute; left: 50%; bottom: -12px;
  transform: translateX(-50%); border-left: 7px solid transparent;
  border-right: 7px solid transparent; border-top: 10px solid var(--brand); }
/* Swipe: an arrow across. */
.card__gesture-card--swipe::after { content: ""; position: absolute; right: -13px; top: 50%;
  transform: translateY(-50%); border-top: 7px solid transparent;
  border-bottom: 7px solid transparent; border-left: 10px solid var(--brand); }
.card__gesture-label { font-weight: 700; font-size: 0.95rem; }

/* The training-card chooser. Fenced off and labelled, because a real reader
   supplies the card itself and this whole block disappears with it. */
.card__simulator { border: 1px dashed var(--line); border-radius: var(--r-md);
  padding: 0.85rem; margin-bottom: 1rem; }
.card__simulator-title { margin: 0 0 0.6rem; font-size: 0.82rem; color: var(--ink-soft);
  text-transform: uppercase; letter-spacing: 0.05em; }
.card__sim-list { display: grid; gap: 0.4rem; }
.card__sim { display: grid; grid-template-columns: auto auto 1fr; gap: 0.6rem;
  align-items: center; padding: 0.6rem 0.7rem; border-radius: var(--r-sm);
  cursor: pointer; background: var(--card-sunken); }
.card__sim:has(.card__sim-radio:checked) { outline: 2px solid var(--brand); }
.card__sim-radio { margin: 0; }
.card__sim-pan { font-family: ui-monospace, monospace; font-weight: 700; }
.card__sim-scheme { font-size: 0.75rem; color: var(--ink-soft); }
.card__sim-label { font-size: 0.85rem; text-align: right; }

/* The outcome. One line, large, in the tone of what happened. */
.card__result { text-align: center; padding: 1.5rem 1rem; border-radius: var(--r-lg);
  margin-bottom: var(--gap); }
.card__result--approved { background: #E6F5EC; border: 2px solid #7FBF9A; }
.card__result--declined { background: #FBE9E7; border: 2px solid #E2A29B; }
.card__result--no_response { background: #FFF4DA; border: 2px solid #E8C878; }
.card__result--not_read { background: var(--card-sunken); border: 2px solid var(--line); }
.card__result-mark { line-height: 0; margin-bottom: 0.5rem; }
.card__result-headline { font-size: 1.3rem; font-weight: 800; margin: 0; }
.card__result-warning { margin: 0.75rem auto 0; max-width: 32rem; font-weight: 700; }
.card__result-hint { margin: 0.5rem 0 0; color: var(--ink-soft); }

/* Outage and offline. Loud, and honest about what is still possible. */
.service-state { text-align: center; padding: 1.5rem 1rem; border-radius: var(--r-lg);
  background: var(--card-sunken); margin-bottom: var(--gap); }
.service-state__icon { font-size: 2.5rem; margin: 0 0 0.25rem; line-height: 1; }
.service-state__headline { font-size: 1.2rem; font-weight: 700; margin: 0 0 0.5rem; }
.service-state__reassure { margin: 0 auto; max-width: 30rem; font-weight: 600; }
.service-state__detail { margin: 0.75rem 0 0; font-size: 0.85rem; color: var(--ink-soft); }
.service-state--outage { border: 2px solid #E8C878; background: #FFF4DA; color: #6B4A00; }
.service-state--offline { border: 2px solid #C9D2D1; }

.slip__barcode { text-align: center; margin: 0.6rem 0 0.2rem; }
.slip__barcode-bars { display: flex; justify-content: center; align-items: flex-end;
  gap: 2px; height: 44px; }
.slip__barcode-bars i { display: block; height: 100%; background: #000; }
.slip__barcode-text { display: block; font-size: 0.7rem; letter-spacing: 0.16em;
  margin-top: 0.25rem; }

/* Running low. Amber, above the pills, so it is met before the tiles. */
.dashboard__alert { margin: 0 0 var(--gap); padding: 0.8rem 1rem;
  border-radius: var(--r-md); background: #FFF4DA; color: #6B4A00;
  border: 1px solid #E8C878; font-weight: 600; }

/* A hidden balance. A details element, so it reveals with no script at all. */
.dashboard__reveal { display: inline; }
.dashboard__reveal summary { display: inline; cursor: pointer; letter-spacing: 0.15em; }
.dashboard__reveal summary::-webkit-details-marker { display: none; }

.menu__lock { margin: 0.75rem 0 0.25rem; }
.menu__lock-button {
  display: flex; align-items: center; justify-content: center; gap: 0.5rem;
  width: 100%; min-height: 3.25rem; border: none; border-radius: var(--r-pill);
  background: var(--pill); color: var(--pill-ink); font: inherit; font-weight: 700;
  cursor: pointer;
}
.menu__lock-button:hover { filter: brightness(1.25); }
@media print { .pos__topbar { display: none; } }

/* The sign-in form says which app it is for, so a wrong choice on the
   launcher is obvious before a PIN is typed rather than after. */
/* The screen lock: full-bleed brand, white message, one black pill — the
   reference terminal's lock, in Telga's colour. No card here on purpose; a
   locked machine should not look like a page you can read around. */
.lock { display: flex; flex-direction: column; align-items: center; gap: 0.5rem;
  text-align: center; padding: 2.5rem 1rem 3rem; color: #fff; }
.lock__mark { line-height: 0; margin-bottom: 1rem; }
.lock__title { font-size: 1.6rem; font-weight: 800; margin: 0; line-height: 1.25; }
.lock__operator { margin: 0.35rem 0 1.75rem; opacity: 0.85; font-weight: 600; }
.lock .field { width: min(22rem, 100%); text-align: left; }
.lock .field label { color: #fff; }
.lock input {
  width: 100%; border-radius: var(--r-md); border: none; padding: 0.9rem 1rem;
  font-size: 1.15rem;
}
.lock button[type="submit"] {
  width: min(22rem, 100%); margin-top: 0.5rem; font-size: 1.1rem;
  background: var(--pill); color: var(--pill-ink);
}
.lock__signout { margin-top: 1.75rem; }
.lock__signout button { background: transparent; color: #fff; border: 2px solid rgba(255,255,255,0.5); }
/* The lock owns the whole screen — no white card behind it. */
.lock-screen main { background: transparent; box-shadow: none; padding: 0; }

.login__app { display: flex; align-items: center; justify-content: center; gap: 0.6rem;
  margin: 0 0 1.25rem; padding-bottom: 0.9rem; border-bottom: 1px solid #2a3a52; }
.login__app-name { font-size: 1.15rem; font-weight: 700; }
.login__back { margin: 1.25rem 0 0; text-align: center; }


/* The mark. A transparent PNG, so it sits on paper and on
   a dark theme without a box around it. */
.slip__logo { text-align: center; margin: 0 0 0.35rem; line-height: 0; }

/* Print treatment. A thermal head is one bit per dot, so a mid-tone gold
   render dithers to mush; raising contrast and dropping saturation gives the
   driver something it can halftone. The artwork itself is unchanged — this is
   how it is *reproduced*, not a different mark. */
.telga-logo--mono { filter: grayscale(1) contrast(1.65) brightness(0.92); }

/* Fall, catch, stand.
   The artwork is the middle of that sequence — the moment of the push — so a
   still copy reads as "still falling". The image starts tipped further over
   than the render, swings back through the render's own angle, and settles
   upright. It *rests* upright: the last keyframe is the resting frame and
   the animation fill mode keeps it there. */
@keyframes telga-logo-stand {
  0%   { transform: rotate(-16deg) translateY(-6%); }
  45%  { transform: rotate(-16deg) translateY(0); }
  70%  { transform: rotate(-7deg); }
  88%  { transform: rotate(2deg); }
  100% { transform: rotate(0deg); }
}
.telga-logo--animate {
  transform-origin: 30% 88%;
  animation: telga-logo-stand 2.4s cubic-bezier(0.22, 0.61, 0.36, 1) 0.15s both;
}
@media (prefers-reduced-motion: reduce) {
  .telga-logo--animate { animation: none; transform: none; }
}
.slip__brand { text-align: center; font-size: 1.3rem; font-weight: 700; letter-spacing: 0.12em; margin: 0; }
.slip__subtitle { text-align: center; margin: 0.1rem 0 0.5rem; opacity: 0.75; }
.slip__reprint { text-align: center; font-weight: 700; color: #8a5a00; margin: 0.25rem 0; }
.slip__rule { border: none; border-top: 1px dashed #14151a; margin: 0.6rem 0; }
.slip__line { display: flex; justify-content: space-between; gap: 1rem; padding: 0.15rem 0; }
.slip__label { opacity: 0.7; }
.slip__value { font-weight: 600; text-align: right; word-break: break-all; }
.slip__banner { text-align: center; font-weight: 700; margin: 0.5rem 0 0.2rem; }
.slip__support { text-align: center; opacity: 0.7; margin: 0; font-size: 0.75rem; }
.slip__code-notice {
  text-align: center; font-weight: 700; margin: 0.35rem 0 0; font-size: 0.78rem;
  border: 1px dashed #14151a; padding: 0.25rem;
}
.slip__advert {
  text-align: center; margin: 0.35rem 0 0.5rem; font-size: 0.78rem;
  font-style: italic; opacity: 0.85; overflow-wrap: anywhere;
}
.slip__notice { text-align: center; font-size: 0.85rem; opacity: 0.85; }
.slip__actions { justify-content: center; }

/* Roll width. 58 mm and 80 mm are the two thermal sizes a shop actually buys,
   so the preview is sized to each rather than to one nominal width — an
   advertising line that overflows on a 58 mm roll should overflow here too,
   where the owner can see it before printing a hundred of them. */
.slip--58 { max-width: 17rem; font-size: 0.78rem; padding: 0.85rem 0.9rem; }
.slip--80 { max-width: 22rem; }
@media print {
  .slip--58 { width: 58mm; max-width: 58mm; }
  .slip--80 { width: 80mm; max-width: 80mm; }
}

@media print {
  body * { visibility: hidden; }
  .slip, .slip * { visibility: visible; }
  /* Solid black on paper. A thermal head is one bit per dot, so a tinted
     logo prints as a smear; the silhouette is what survives the roll. */
  /* Paper: never animate, and push contrast for the thermal head. */
  .telga-logo { filter: grayscale(1) contrast(1.75) brightness(0.9); }
  .telga-logo--animate { animation: none; transform: none; }
  .slip { position: absolute; inset: 0 auto auto 0; box-shadow: none; border: none; margin: 0; }
}

/* Telga Pay: a teal accent, matching the reference card-simulator's own
   colour, used only for this module's buttons and summary — see
   ui/telgaPay.ts. */
:root { --pay-accent: #0f9b8e; }
.pay__banner { border: 2px solid var(--pay-accent); border-radius: 0.6rem; padding: var(--gap); font-weight: 600; }
.pay__summary { text-align: center; margin-block: var(--gap); }
.pay__summary-label { margin: 0; opacity: 0.75; font-size: 0.9rem; }
.pay__summary-amount { margin: 0.1rem 0; font-size: 2rem; font-weight: 700; color: var(--pay-accent); }
.pay__summary-count { margin: 0; opacity: 0.75; font-size: 0.9rem; }
.pay__tiles { display: flex; gap: var(--gap); justify-content: center; }
.pay__tile { flex-direction: column; gap: 0.4rem; }
.pay__tile-icon {
  width: 3.5rem; height: 3.5rem; border-radius: 50%; background: var(--pay-accent); color: #fff;
  display: flex; align-items: center; justify-content: center; font-size: 1.5rem;
}
.pay__tile-label { font-size: 0.85rem; font-weight: 600; }
.pay__amount-display {
  display: flex; align-items: baseline; justify-content: center; gap: 0.5rem; padding: 1.5rem 0;
}
.pay__amount-currency { font-size: 1.2rem; font-weight: 600; opacity: 0.75; }
.pay__amount-display input {
  font-size: 2.5rem; font-weight: 700; border: none; border-bottom: 2px solid var(--pay-accent);
  width: 8rem; text-align: center; background: transparent; color: inherit;
}
.pay__actions { display: flex; gap: var(--gap); justify-content: center; }
.pay__pill-button { background: var(--pay-accent); color: #fff; border-color: var(--pay-accent); border-radius: 999px; font-weight: 700; }
.pay__card-amount { text-align: center; font-size: 2.2rem; font-weight: 700; margin-bottom: 0; }
.pay__card-icon { text-align: center; font-size: 2.5rem; margin-block: 0.25rem; }
.pay__card-prompt { text-align: center; font-weight: 600; }
.pay__card-methods { display: flex; gap: var(--gap); justify-content: center; flex-wrap: wrap; }
.pay__card-methods a { border-color: var(--pay-accent); color: var(--pay-accent); border-radius: 0.5rem; }
.pay__card-badges { display: flex; gap: 0.5rem; justify-content: center; }
.pay__card-badge {
  border: 1px solid currentColor; border-radius: 0.3rem; padding: 0.2rem 0.6rem; font-size: 0.8rem;
  font-weight: 700; letter-spacing: 0.03em;
}

/* The "practise a different result" links are visually separated from the
   tap/insert/swipe methods, so an operator cannot mistake a
   training-outcome shortcut for a real card action. */
.pay__practice { border-top: 1px dashed currentColor; padding-top: var(--gap); margin-top: var(--gap); text-align: center; }

/* ==========================================================================
   The scribal shell
   ==========================================================================

   The page is the skin. Content is separated by ruling, the way a folio is,
   and nothing floats on a ground: a card would be a second material this world
   does not contain. Rules reach the page edge, because a rule that stops short
   means something here.

   WHY THE TAB BAR IS TEXT AND NOT ICONS. Amharic labels are longer than their
   English equivalents and Ethiopic glyphs need the height; an icon above an
   Amharic word either clips the word or halves the tap target. Readable
   Amharic outranks anything decorative.

   WHY THE TAB BAR IS NOT ON EVERY SCREEN. It is drawn by nav(), which the
   dashboard, transactions and queue call and the vending flow does not. Tabs
   are for the places you return to; a checkout flow hides them so the only
   ways out are finish and back.
   ========================================================================== */

body {
  margin: 0;
  min-height: 100dvh;
  background: var(--telga-vellum-ground);
  color: var(--telga-vellum-ink);
  font-family: var(--telga-type-body);
  font-size: var(--telga-type-base);
}

.pos {
  max-width: 44rem;
  margin: 0 auto;
  padding: 0 0 calc(var(--telga-size-tab-bar) + max(env(safe-area-inset-bottom, 0px), 6px)) 0;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--telga-vellum-ground);
}

/* --- the app bar ---------------------------------------------------------
   Sticky rather than fixed: it scrolls with a keyboard open, which fixed
   positioning gets wrong on Android when the viewport shrinks. */
.pos__topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--gap);
  min-height: var(--telga-size-app-bar);
  padding: env(safe-area-inset-top, 0px) var(--gap) 0 var(--gap);
  background: var(--telga-vellum-ground);
  border-bottom: var(--telga-size-rule-major) solid var(--telga-vellum-ink);
}

/* --- the harag band ------------------------------------------------------
   The interlace a scribe rules across the head of a section, drawn from the
   three structural inks. It is the one ornament in this world and it is
   structural: it says a new section begins. */
main::before {
  content: "";
  display: block;
  height: 10px;
  /* Full bleed. A harag runs the width of the folio; one inset by the page
     padding reads as a decorative strip rather than a ruled opening, which is
     what it looked like in the first render. */
  margin: 0 calc(var(--telga-space-lg) * -1) var(--telga-space-lg);
  background:
    repeating-linear-gradient(135deg, var(--telga-vellum-rubric) 0 6px, transparent 6px 12px),
    repeating-linear-gradient(45deg, var(--telga-vellum-indigo) 0 6px, transparent 6px 12px),
    var(--telga-vellum-ochre);
  border-block: var(--telga-size-rule-hair) solid var(--telga-vellum-ink);
}

/* The page, not a card. */
main {
  flex: 1 1 auto;
  background: transparent;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  padding: 0 var(--telga-space-lg);
}

.screen__title {
  font-family: var(--telga-type-display);
  font-size: var(--telga-type-xl);
  font-weight: 600;
  margin: 0 0 var(--telga-space-md) 0;
  padding-bottom: var(--telga-space-sm);
  border-bottom: var(--telga-size-rule-major) solid var(--telga-vellum-ink);
}

/* --- money ---------------------------------------------------------------
   Fixed decimal positions, so a figure never changes width as it changes and a
   column of them lines up digit for digit. The unit is rubricated and set
   small beside it: red ink marks what kind of thing a number is, which is what
   rubrication is for. */
.amount,
[data-amount] {
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
  letter-spacing: 0.01em;
}

.amount--lead {
  font-family: var(--telga-type-display);
  font-size: var(--telga-type-amount);
  line-height: 1.1;
}

.amount__unit {
  color: var(--telga-vellum-rubric);
  font-size: var(--telga-type-sm);
  font-family: var(--telga-type-body);
  margin-inline-start: 0.35ch;
}

/* --- phases --------------------------------------------------------------
   A phase is a name, a rule pattern and an ink. Three carriers, because the
   pattern survives a monochrome thermal print, a photocopied statement, and a
   reader who cannot separate red from green. */
[data-phase] {
  border-bottom-width: var(--telga-size-rule-major);
  border-bottom-color: currentColor;
  padding-bottom: 2px;
}
[data-phase="settled"]  { border-bottom-style: solid;  color: var(--telga-vellum-rubric); }
[data-phase="working"]  { border-bottom-style: dotted; color: var(--telga-vellum-indigo); }
[data-phase="pending"]  { border-bottom-style: dashed; color: var(--telga-vellum-indigo); }
[data-phase="review"]   { border-bottom-style: double; color: var(--telga-vellum-ochre); }
[data-phase="failed"]   { border-bottom-style: solid;  color: var(--telga-vellum-ink); text-decoration: line-through; }
[data-phase="reversed"] { border-bottom-style: double; color: var(--telga-vellum-rubric); text-decoration: line-through; }

/* --- ledger rows ---------------------------------------------------------
   A settled row's rule runs the full width; a pending one stops short of the
   margin, which is the whole signal: the line is not finished being written. */
.ledger__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--telga-space-md);
  min-height: var(--telga-size-control);
  padding: var(--telga-space-sm) 0;
  border-bottom: var(--telga-size-rule-hair) solid var(--telga-vellum-rule);
}

.ledger__row[data-phase="pending"] {
  border-bottom: 0;
  position: relative;
}
.ledger__row[data-phase="pending"]::after {
  content: "";
  position: absolute;
  left: 0;
  bottom: 0;
  width: 62%;
  border-bottom: var(--telga-size-rule-hair) dashed var(--telga-vellum-indigo);
}

/* A row an operator has worked carries a scribal strike that persists. */
.ledger__row[data-worked="true"] { color: var(--telga-vellum-ink-thin); }
.ledger__row[data-worked="true"] .ledger__label { text-decoration: line-through; }

/* --- the primary action --------------------------------------------------
   One per screen. A rubricated block, not a pill: this world rules and fills,
   it does not round. */
.pos main button[type="submit"],
.button--primary {
  min-height: var(--telga-size-primary);
  background: var(--telga-vellum-rubric);
  color: var(--telga-vellum-ground-pale);
  border: 0;
  border-bottom: var(--telga-size-rule-heavy) solid var(--telga-vellum-ink);
  border-radius: var(--telga-size-radius-sm);
  font-family: var(--telga-type-body);
  font-size: var(--telga-type-lg);
  font-weight: 600;
  transition: transform var(--telga-motion-instant) var(--telga-motion-standard);
}

/* Press feedback: the block seats itself against its rule. */
.pos main button[type="submit"]:active,
.button--primary:active { transform: translateY(1px); }

/* --- the bottom tab bar --------------------------------------------------
   Fixed to the bottom edge, above the gesture area. A bar that ignores the
   safe-area inset sits underneath the Android gesture bar, where its buttons
   either cannot be hit or fire the system gesture instead of the link. */
.pos__nav {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10;
  display: flex;
  gap: 0;
  flex-wrap: nowrap;
  margin: 0;
  padding: 0 0 max(env(safe-area-inset-bottom, 0px), 6px) 0;
  background: var(--telga-vellum-ground-pale);
  border-top: var(--telga-size-rule-major) solid var(--telga-vellum-ink);
  box-shadow: var(--telga-shadow-tab-bar);
}

.pos__nav a {
  flex: 1 1 0;
  min-height: var(--telga-size-touch-min);
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 0.4rem 0.25rem;
  font-size: var(--telga-type-sm);
  line-height: 1.2;
  text-decoration: none;
  color: var(--telga-vellum-ink);
}

/* The active tab is inverted, not tinted: rank is inversion in this world, and
   inversion survives a monochrome screen where a tint does not. */
.pos__nav a[aria-current="page"] {
  background: var(--telga-vellum-ink);
  color: var(--telga-vellum-ground-pale);
  font-weight: 700;
  text-decoration: none;
}

/* --- touch targets ------------------------------------------------------ */
button,
.button,
.menu__link,
select,
textarea,
/* Every text-entry input, named by exclusion rather than by listing types.
   Listing them put a password type-selector into the stylesheet, and so onto
   every page, which tripped the guard asserting the registration screen never
   asks for one. The guard was right: that string does not belong on that page.
   This comment names no selector for the same reason — a guard that cannot
   tell a rule from a warning about the rule fires on its own documentation,
   which has happened four times in this repository. */
input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]) {
  min-height: var(--telga-size-touch-min);
  font-size: 16px;
}

/* --- browser surfaces ----------------------------------------------------
   The parts not drawn here still carry the world: selection, caret and focus
   ring ship with browser defaults that belong to no design system. */
::selection { background: var(--telga-vellum-ochre); color: var(--telga-vellum-ink); }
:root { accent-color: var(--telga-vellum-rubric); caret-color: var(--telga-vellum-rubric); }
:focus-visible {
  outline: var(--telga-size-rule-heavy) solid var(--telga-vellum-rubric);
  outline-offset: 2px;
}

/* --- motion --------------------------------------------------------------
   The signature movement: a settling entry steps its rule to the margin in one
   whole-line movement with a single overshoot. Nothing glides continuously; a
   scribe lifts the hand and sets it down. */
@keyframes telga-rule-step {
  from { transform: scaleX(0); }
  to   { transform: scaleX(1); }
}

.ledger__row[data-phase="settled"] {
  animation: telga-rule-step var(--telga-motion-short) var(--telga-motion-overshoot);
  transform-origin: left center;
}

/* Android's Remove animations setting arrives here. */
@media (prefers-reduced-motion: reduce) {
  .ledger__row[data-phase="settled"] { animation: none; }
  * { transition: none !important; animation: none !important; }
}

/* --- the menu button -----------------------------------------------------
   The first render left it an unstyled pale box floating in an otherwise
   empty app bar. It is the only control up there, so it carries the ink. */
.pos__topbar button,
.pos__topbar .menu__button {
  min-height: var(--telga-size-touch-min);
  min-width: var(--telga-size-touch-min);
  background: transparent;
  color: var(--telga-vellum-ink);
  border: var(--telga-size-rule-major) solid var(--telga-vellum-ink);
  border-radius: var(--telga-size-radius-sm);
  font-size: var(--telga-type-lg);
}

/* --- containment --------------------------------------------------------
   Found by rendering at 390px: every screen overflowed to the right and cut
   its own text mid-word. A counter phone is the narrowest thing this ships
   to, so nothing may exceed it. min-width: 0 is the load-bearing line — a
   flex child defaults to min-width: auto, which refuses to shrink below its
   content and pushes the whole row wider than the screen. */
/* box-sizing was absent from this stylesheet entirely until 2026-09-12, so
   padding and borders were ADDED to every width: a full-width element with
   var(--gap) padding and a 3px border overflowed its container by 30px and cut
   its own text mid-word at the right edge. It is the single cause of the
   clipping seen on every screen at 390px, and it had nothing to do with the
   redesign; the console always had the rule, which is why it clipped less. */
*, *::before, *::after { box-sizing: border-box; min-width: 0; }

html, body { overflow-x: hidden; max-width: 100%; }

/* NOT .pos: it carries the 44rem reading measure, and listing it here set
   every screen to the full width of a counter display — a 1024px line of body
   text, which is roughly twice a readable measure. Containment is for the
   children that would otherwise push past the shell. */
.pos__topbar, main, .pos__identity, .pos__footer { max-width: 100%; }

/* The app bar is the skin, not a pale strip. Stated with the shell's own
   specificity because it renders above the fold on every screen. */
.pos > .pos__topbar { background: var(--telga-vellum-ground); }

/* Long unbroken strings (a device id, a reference, an email) break rather
   than widening the page. */
main, .pos__identity, .pos__footer, .banner, .banner__detail, .banner__warning,
p, td, th, dd, dt, li {
  overflow-wrap: anywhere;
}

/* A table is the one thing allowed to be wider than the screen, and then only
   inside its own scroller — the column relationships in a balance or a
   statement are what a shopkeeper reads across, and stacking them loses it. */
main table { display: block; overflow-x: auto; max-width: 100%; }

/* --- links ---------------------------------------------------------------
   Rendering showed browser-default blue on the home screen, which belongs to
   no design system. A link is ink with a rubricated underline. */
main a {
  color: var(--telga-vellum-ink);
  text-decoration: underline;
  text-decoration-color: var(--telga-vellum-rubric);
  text-decoration-thickness: 2px;
  text-underline-offset: 3px;
  min-height: var(--telga-size-touch-min);
  display: inline-flex;
  align-items: center;
}

/* --- the balance as the lead figure -------------------------------------
   The available balance is the one number a shopkeeper opens this app to
   read, so it is the largest thing on the screen and its unit is rubricated.
   The other two rows stay ordinary: reserved and under-review are context,
   not the headline. */
.balance__lead {
  display: flex;
  align-items: baseline;
  gap: 0.35ch;
  margin: 0 0 var(--telga-space-xs) 0;
  font-family: var(--telga-type-display);
  font-size: var(--telga-type-amount);
  line-height: 1.05;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
}

.balance__unit {
  font-family: var(--telga-type-body);
  font-size: var(--telga-type-sm);
  font-weight: 600;
  color: var(--telga-vellum-rubric);
  letter-spacing: 0.04em;
}

.balance__caption {
  margin: 0 0 var(--telga-space-md) 0;
  padding-bottom: var(--telga-space-sm);
  font-size: var(--telga-type-sm);
  color: var(--telga-vellum-ink-thin);
  border-bottom: var(--telga-size-rule-major) solid var(--telga-vellum-ink);
}

/* --- print --------------------------------------------------------------
   None of the shell belongs on a receipt, and a fixed bar would print on every
   page of one. The harag band is screen ornament and costs thermal ink. */
@media print {
  .pos__nav,
  .pos__identity,
  .pos__footer { display: none; }
  main::before { display: none; }
  .pos { padding-bottom: 0; min-height: 0; }
  body { min-height: 0; background: #FFFFFF; }
}
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
  // Authenticated screens carry the inactivity timeout; the sign-in page does
  // not, so it gets no watcher.
  const idleTimeoutMs = chrome.idleTimeoutMs ?? 0;
  const lockAfterMs = chrome.lockAfterMs ?? 0;
  return [
    '<!doctype html>',
    `<html lang="${escapeText(chrome.locale)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // Makes Telga installable: with a manifest and these icons, a browser
    // offers "Install" / "Add to home screen", and the result is a square
    // Telga icon that opens straight into the launcher with no browser bar.
    '<link rel="manifest" href="/manifest.webmanifest">',
    '<link rel="icon" type="image/png" sizes="32x32" href="/assets/icon-32.png">',
    '<link rel="icon" type="image/png" sizes="192x192" href="/assets/icon-192.png">',
    '<link rel="apple-touch-icon" sizes="180x180" href="/assets/icon-180.png">',
    // The colour the OS paints around the app once installed.
    '<meta name="theme-color" content="#122E30">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-title" content="Telga">',
    `<meta http-equiv="content-security-policy" content="${escapeText(csp)}">`,
    '<meta name="robots" content="noindex, nofollow">',
    `<title>Telga POS — ${escapeText(chrome.mode)} — no real value</title>`,
    // The tokens are emitted here rather than inside STYLES: that literal is
    // required to stay static, because interpolation into CSS splices code
    // into a stylesheet and has ended this literal early four times.
    `<style nonce="${n}">${cssVariables('vellum')}\n${STYLES}</style>`,
    '</head>',
    idleTimeoutMs > 0 || lockAfterMs > 0
      ? `<body${idleTimeoutMs > 0 ? ` data-idle-timeout-s="${escapeText(String(Math.round(idleTimeoutMs / 1000)))}"` : ''}` +
        `${lockAfterMs > 0 ? ` data-lock-after-s="${escapeText(String(Math.round(lockAfterMs / 1000)))}"` : ''}>`
      : '<body>',
    bodyHtml,
    `<script nonce="${n}">${CLIENT_SCRIPT}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

export { CLIENT_SCRIPT };
