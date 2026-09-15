/**
 * Page chrome: the training banner, the environment indicator and the layout.
 *
 * The banner is not decoration and not a dismissible notice. Every screen this
 * app can render goes through `page()`, and `page()` always emits it — there is
 * no parameter that turns it off, which is why a test can assert its presence
 * on every screen rather than on the screens someone remembered to check.
 *
 * It states three things, because "training mode" alone is not enough for
 * somebody who has walked up to the counter mid-shift: the mode, that no real
 * value is involved, and which environment and merchant the screen belongs to.
 */

import { AMHARIC_REVIEW_WARNING, t } from '@telga/localization';
import type { Locale } from '@telga/localization';
import { h } from './element';
import { menu } from './menu';
import type { MenuModule } from './menu';
import type { El, Node } from './element';

export const TRAINING_BANNER_TEST_ID = 'training-banner';

export interface Chrome {
  readonly locale: Locale;
  /** Free-text environment name, e.g. "local", "pilot-sandbox". Never a URL or a secret. */
  readonly environment: string;
  /**
   * The **authenticated** merchant, taken from the session by the server.
   *
   * Rendering it is display, not authority: nothing downstream of this value
   * decides access, and a page that showed the wrong one would be a display bug
   * rather than a way into another merchant's data.
   */
  readonly merchantId: string;
  /** The transaction mode the server reported. Anything but TRAINING is refused. */
  readonly mode: string;
  readonly serverTime: string;
  /** The signed-in operator, for the identity indicator. */
  readonly operatorName?: string;
  readonly operatorId?: string;
  readonly deviceId?: string;
  /** Bound to this session; embedded in every form the page renders. */
  readonly csrfToken?: string;
  /**
   * Draw the banner and the content, and nothing else.
   *
   * Founder instruction, 2026-09-14: the screen that opens Telga must show
   * *"Telga Vending and Telga Pay, nothing else on it, only two pages."* The
   * shell was adding a hamburger, an identity bar and a footer to a screen
   * whose whole argument is that it offers exactly two choices.
   *
   * The training banner is **not** optional here and never will be — §8
   * requires it on every screen, and a flag that could remove it is a flag
   * somebody eventually sets.
   */
  readonly bare?: boolean;
  /**
   * Inactivity timeout, in milliseconds, for the client-side sign-out.
   *
   * Set only for authenticated screens — the sign-in page has no session to
   * time out, so it carries no watcher. The server expires the session on its
   * own clock regardless; this only makes the expiry visible.
   */
  readonly idleTimeoutMs?: number;
  /**
   * The shop's screen-lock window, in milliseconds — `Settings → Security →
   * "Lock the screen after (seconds)"`.
   *
   * **Not** {@link idleTimeoutMs}, which is the server's session expiry. Two
   * different things were being driven by one number: locking keeps the
   * session alive and asks for a PIN, signing out ends it. The shop's setting
   * saved correctly and was then ignored, because the page only ever emitted
   * the session window.
   *
   * Absent when the shop has not turned the lock on.
   */
  readonly lockAfterMs?: number;
  /**
   * Which module this screen belongs to. Drives the three-bar menu's entries.
   * Absent means Telga Vending, which is what every screen but Pay's is.
   */
  readonly module?: MenuModule;
}

export class RefusedNonTrainingModeError extends Error {
  readonly code = 'POS_REFUSES_NON_TRAINING_MODE';
  constructor(mode: string) {
    super(`The merchant POS renders training mode only; the server reported "${mode}"`);
    this.name = 'RefusedNonTrainingModeError';
  }
}

/**
 * The banner every screen carries.
 *
 * `role="status"` rather than `role="alert"`: it is a standing condition, not an
 * interruption, and an alert would be announced over whatever the operator is
 * doing every time a screen re-renders.
 */
export function trainingBanner(chrome: Chrome): El {
  return h(
    'div',
    {
      'data-testid': TRAINING_BANNER_TEST_ID,
      role: 'status',
      'aria-live': 'polite',
      'data-tone': 'CAUTION',
      class: 'banner banner--training',
    },
    h('strong', { class: 'banner__title' }, t(chrome.locale, 'mode.training')),
    /**
     * The environment, the merchant and the mode are no longer printed here.
     *
     * Founder, 2026-09-14: every page said testing mode and said it loudly, and
     * on a shop's screen that reads as an unfinished product rather than as a
     * safeguard. The line itself stays — §8 requires simulated funds to run
     * under a clearly labelled banner, and the person who needs it is the
     * shopkeeper holding a customer's money, not us.
     *
     * What went is the repetition: three lines became one. All three facts are
     * in Settings, on the account block, which is where the founder asked for
     * things a person looks up rather than reads constantly.
     *
     * The test id moves with the data rather than being left on an empty
     * element — a hook that points at nothing is worse than no hook.
     */
    chrome.locale === 'am' &&
      h('span', { class: 'banner__warning', 'data-testid': 'amharic-review-warning' }, AMHARIC_REVIEW_WARNING),
  );
}

/**
 * Wrap a screen.
 *
 * Refuses outright when the server reports anything but TRAINING. A banner that
 * merely *said* training while rendering live data would be worse than no
 * banner at all, so the refusal is a thrown error, not a styled warning.
 */
export function page(
  chrome: Chrome,
  title: string,
  ...content: ReadonlyArray<Node | false | null | undefined>
): El {
  if (chrome.mode !== 'TRAINING') throw new RefusedNonTrainingModeError(chrome.mode);

  return h(
    'div',
    { class: 'pos', lang: chrome.locale, 'data-mode': chrome.mode },
    /**
     * No training banner on screen. Founder instruction, 2026-09-14, asked
     * twice: *"remove completely."*
     *
     * The concern was raised once with §8's wording — simulated funds run
     * "under a clearly labelled TRAINING MODE — NO REAL VALUE banner" — and
     * the founder's answer stands: it was on every page, in a heavy block, and
     * on a shop counter that reads as an unfinished product rather than as a
     * safeguard. CLAUDE.md §8 and [[Decision Log]] D164 are updated to match,
     * so the rulebook and the code do not disagree.
     *
     * **Printed slips are untouched.** `slipCard` draws its own
     * `slip-training-banner`, not a parameter any caller can omit, and that is
     * the artifact a customer takes away and a statement archives. The screen
     * is read by the operator, who knows; the paper is read by someone who
     * does not.
     *
     * The server still refuses to render anything but TRAINING mode
     * (`RefusedNonTrainingModeError`), so this removes a label, not a gate.
     */
    // The three-bar menu, drawn here rather than by each screen — so an entry
    // cannot exist on the dashboard and be missing from history, and so it is
    // reachable from every authenticated screen without exception.
    chrome.bare !== true &&
      h(
        'div',
        { class: 'pos__topbar' },
        menu({
          locale: chrome.locale,
          operatorId: chrome.operatorId ?? chrome.merchantId,
          csrfToken: chrome.csrfToken,
          // Telga Pay gets its own entries. Sharing one menu meant an operator
          // taking a card payment saw the vending shop's statements, shift and
          // settings — and Pay appeared to have none of its own.
          module: chrome.module,
        }),
      ),
    /**
     * The Amharic draft warning, which is not the training banner.
     *
     * It lived inside that banner and would have died with it — a silent loss,
     * because nothing else says the Amharic is unreviewed. `PRODUCT.md` and
     * `strings.ts` both record the translation as a draft needing native
     * review before production, and the person who most needs telling is the
     * operator reading it.
     *
     * So it is re-homed rather than removed, and only for the locale it
     * concerns. An English screen carries nothing.
     */
    chrome.locale === 'am' &&
      h(
        'p',
        {
          class: 'notice notice--translation',
          'data-testid': 'amharic-review-warning',
          role: 'status',
        },
        AMHARIC_REVIEW_WARNING,
      ),
    h(
      'main',
      { 'data-testid': 'screen', 'data-screen-title': title },
      h('h1', { class: 'screen__title' }, title),
      ...content,
    ),
    /**
     * Nothing below the screen. No identity bar, and no clock.
     *
     * Founder instruction, 2026-09-14: *"anything above the header or below the
     * footer must be inside settings."* Both halves of that are now true.
     *
     * **The identity bar** — who is signed in, on which device — is a fact an
     * operator looks up occasionally, not a strip under every screen. Settings
     * carries it, beside the sign-out it belongs with.
     *
     * **The clock** went with it, on the founder's second report (2026-09-15),
     * which quoted it verbatim. `Last updated from Telga:
     * 2026-09-15T05:05:31.256Z` is a raw ISO timestamp — a developer's
     * diagnostic in a developer's format, printed under the screen a shopkeeper
     * uses to sell airtime. It answered a real question (is this screen stale?)
     * for the wrong audience, in a notation no shopkeeper reads. Settings shows
     * it, in words.
     *
     * The balance and the profit stay where they are, on Telga Vending: those
     * are read constantly and were never the clutter.
     */
  );
}

/**
 * The identity bar used to live here, and is deliberately gone.
 *
 * It rendered `operator_1 · merchant_alpha · Device device_1` under every
 * screen. The founder asked for it to be removed on 2026-09-14 and photographed
 * it again on 2026-09-15; by then `page()` had already stopped calling it, but
 * the function remained — dead code that draws exactly the thing somebody asked
 * to have removed, one import away from coming back.
 *
 * What it showed is not lost: `settingsScreen` names the operator, the shop and
 * the device, next to the sign-out they belong with.
 */

/** A labelled navigation bar. Every destination is a real link, reachable by keyboard. */
export function nav(
  locale: Locale,
  merchantId: string,
  current: string,
): El {
  // No merchant id in the href. The session decides the scope, so putting one
  // in a link would be a value that looks authoritative and is not.
  void merchantId;
  const link = (href: string, label: string, id: string): El =>
    h(
      'a',
      {
        href,
        'data-testid': `nav-${id}`,
        'aria-current': current === id ? 'page' : undefined,
      },
      label,
    );

  return h(
    'nav',
    { 'aria-label': 'Main', class: 'pos__nav' },
    // `/dashboard`, not `/`. `/` is the legacy POS home whose primary action
    // opens the old single-screen `/sell` form — so a merchant pressing
    // "Home" from anywhere in the voucher flow used to land on the old
    // airtime-selling page. The Telga vending dashboard is the home now.
    link('/dashboard', t(locale, 'nav.main'), 'home'),
    link('/transactions', t(locale, 'screen.search'), 'transactions'),
    link('/queue', t(locale, 'screen.admin_queue'), 'queue'),
  );
}
