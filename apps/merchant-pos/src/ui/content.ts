/**
 * Static content for the menu's information screens.
 *
 * ## These are placeholders, and they say so
 *
 * The support details, the About text and the three policy texts are written
 * for a **training build**. They have had no legal review, and CLAUDE.md §8
 * forbids claiming compliance without one — so each policy opens by saying
 * what it is. A plausible-looking privacy policy that nobody wrote is worse
 * than an obviously unfinished one: the first gets relied on, the second gets
 * replaced.
 *
 * The support contact is likewise a placeholder. No real Telga support desk
 * exists yet, and inventing a phone number somebody might dial in a real
 * dispute would be worse than a clearly marked stand-in.
 */

import { t } from '@telga/localization';
import type { Locale } from '@telga/localization';
import type { LearningStep } from './menuScreens';

/**
 * Where a merchant reaches Telga.
 *
 * **There is no support desk yet, and this says so rather than pretending.**
 *
 * ## Why there is no phone number here
 *
 * There used to be one: `+251 000 000 000 (training placeholder)`. It was
 * removed rather than replaced, because a string shaped like a phone number is
 * one an operator will dial — and a number that looks Ethiopian and rings
 * nowhere is worse than an obvious absence. Worse still if the digits ever
 * reached a real subscriber. Receipts carry a support contact by
 * `04 UX UI/Receipt Specification`, so this text is printed and handed to
 * customers; it has to be true on paper as well as on screen.
 *
 * `telga.example` is deliberate too: `.example` is reserved by RFC 2606 and can
 * never be registered, so the address cannot start resolving to somebody else's
 * mail server the way a plausible-looking domain eventually would.
 *
 * Replacing this is a launch gate — CLAUDE.md §8, *"support escalation
 * assigned"* — not a text edit. See `ASSUMPTIONS.md` A74.
 */
export const TRAINING_SUPPORT = Object.freeze({
  /**
   * No number. Not a blank to be filled in casually: see above.
   * Screens render the notice instead when this is undefined.
   */
  phone: undefined as string | undefined,
  email: 'support@telga.example',
  hours: 'Training build — no support desk is staffed and no line is answered',
  address: 'MuleSoo Digital Services, Addis Ababa, Ethiopia',
  /** Shown wherever a contact would otherwise be. Plain, and unmissable. */
  notice: 'This is a training build. Support is not staffed — nobody is on call.',
});

/**
 * The manual, in the order a new operator meets these screens.
 *
 * Each step links to the screen it describes, so it is something to work
 * through on the machine rather than read and try to remember.
 */
export function learningSteps(_locale: Locale): readonly LearningStep[] {
  // **The manual is English only.** The locale is accepted and ignored, which
  // the underscore records rather than hides: CLAUDE.md §22 requires English
  // and Amharic, and this screen does not meet it yet. Every string below is a
  // literal instead of a `t()` key, so translating it is a real piece of work
  // (about forty sentences) and not a wiring change. Tracked as a limitation
  // rather than silently dropped — an Amharic-speaking operator gets English
  // here and correct Amharic everywhere else.

  return [
    {
      title: '1. Sign in',
      body:
        'Enter your operator id, your PIN, and the device key. After a minute of no activity ' +
        'the machine asks for your PIN again — the device stays signed in, so you never retype ' +
        'the device key. Signing out from Settings clears everything and asks for all four.',
    },
    {
      title: '2. Check your balance',
      body:
        'The dashboard shows what you can sell with and what you have earned today. ' +
        'Press + beside the balance to add to it.',
      href: '/dashboard',
    },
    {
      title: '3. Sell airtime',
      body:
        'Vouchers, then Airtime, then a network, then an amount. You can type a custom amount ' +
        'between 5 and 1000 birr, and set how many vouchers to print at once. The screen shows ' +
        'the amount and your profit before you enter your PIN.',
      href: '/vouchers/airtime',
    },
    {
      title: '4. Send a top-up or a data bundle',
      body:
        'A top-up and a data bundle both go to a phone number, so the machine asks for one. ' +
        'A voucher is handed across the counter instead, so it does not.',
      href: '/vouchers',
    },
    {
      title: '5. Read a slip',
      body:
        'Every slip shows the shop, the amount, the reference, and — for a voucher — the PIN ' +
        'the customer dials. Every code in this build starts TRAIN- and will not load anything.',
    },
    {
      title: '6. Find a sale again, and reprint',
      body:
        'Statements lists every sale. Open one to see its slip and press Reprint. A reprint is ' +
        'marked as a reprint and never creates a second sale or moves any money.',
      href: '/transactions',
    },
    {
      title: '7. Move your profit',
      body:
        'Press the Profit figure on the dashboard to move what you have earned into your ' +
        'selling balance. You cannot move more than you have earned.',
      href: '/profit/transfer',
    },
    {
      title: '8. End your shift',
      body: 'Use End shift from the menu when you finish. It records the time and nothing else.',
      href: '/shift/end',
    },
  ];
}

interface Policy {
  readonly titleKey: Parameters<typeof t>[1];
  readonly paragraphs: readonly string[];
}

/** The opening line every policy carries, so none of them can be mistaken for the real thing. */
const PLACEHOLDER_NOTICE =
  'This is placeholder text for a training build. It has had no legal review, it is not a ' +
  'legal document, and it must be replaced before Telga is used with real money or real ' +
  'customer data.';

export const POLICY_TEXTS: Readonly<Record<'about' | 'terms' | 'privacy' | 'cookies', Policy>> =
  Object.freeze({
    about: {
      titleKey: 'settings.about.telga',
      paragraphs: [
        PLACEHOLDER_NOTICE,
        'Telga is the merchant digital-vending platform of MuleSoo Digital Services, in Ethiopia. ' +
          'It gives a shop one dependable way to sell digital services, see what it earns, find ' +
          'past sales, and get help.',
        'This build is a TRAINING build. Every provider is simulated, every voucher code is ' +
          'deliberately worthless, and no real money moves anywhere in it.',
        'Telga is not a bank, a wallet, a lender, or a payment institution, and does not hold ' +
          'customer money.',
      ],
    },
    terms: {
      titleKey: 'settings.about.terms',
      paragraphs: [
        PLACEHOLDER_NOTICE,
        'No merchant agreement is in force for this build. Nothing shown here creates an ' +
          'obligation on MuleSoo Digital Services or on the shop using it.',
        'The commercial terms a real merchant would agree to — fees, commission, settlement, ' +
          'reversals, disputes and exit — are not yet confirmed and are recorded as open ' +
          'decisions in the project documentation.',
      ],
    },
    privacy: {
      titleKey: 'settings.about.privacy',
      paragraphs: [
        PLACEHOLDER_NOTICE,
        'What this build stores about a customer: a phone number, masked, when one is needed to ' +
          'deliver a top-up or a data bundle. A full number is never written to the database, and ' +
          'a saved customer in the customer list is stored masked as well.',
        'What it stores about an operator: an operator id, a derived key for the PIN, and a record ' +
          'of sign-ins and sales for audit. The PIN itself is never stored in any readable form.',
        'This build has had no data-protection review. Before real customer data is entered, that ' +
          'review is required — including retention, deletion, and who may read what.',
      ],
    },
    cookies: {
      titleKey: 'settings.about.cookies',
      paragraphs: [
        PLACEHOLDER_NOTICE,
        'This build sets cookies only to keep you signed in and to protect forms. There is no ' +
          'advertising, no analytics, and no third-party cookie of any kind.',
        'The session cookie identifies your signed-in session. A CSRF cookie protects forms from ' +
          'being submitted by another site. The device cookies remember which machine this is and ' +
          'its device key, so an idle timeout asks only for your PIN — signing out from Settings ' +
          'clears all of them.',
      ],
    },
  });
